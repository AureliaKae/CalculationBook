import { mkdir, open, readFile, rename } from "node:fs/promises";
import { dirname } from "node:path";
import { migrateSettings } from "../src/settings-schema.js";

// 渲染进程永远拿不到明文 Key，改设置时用这个哨兵值表示「这条凭证的 Key 保持不变」。
export const KEEP_KEY = "__KEEP__";

// 系统重装、用户目录损坏或密钥库变更后，safeStorage 可能解不开旧密文。
// 此时宁可当作这条凭证没有 Key，也不能让整个设置页 load 失败打不开。
function decryptOrEmpty(encryptedKey, crypto) {
  try {
    return crypto.decryptString(Buffer.from(encryptedKey, "base64"));
  } catch (error) {
    console.warn("[settings] 无法解密已保存的 API Key，请重新填写：", error.message);
    return "";
  }
}

export class SettingsStore {
  constructor(path, crypto) {
    this.path = path;
    // 可注入的加解密适配器（测试用 fake）；缺省在首次使用时从 electron 延迟加载，
    // 这样本模块在纯 Node 测试环境里也能 import。
    this.crypto = crypto;
    // save 是「读旧档 → 合并 → 写新档」的读改写循环：串行化后并发保存不会
    // 互相丢凭据，也不会共用同一个 tmp 互相踩踏。
    this.saveQueue = Promise.resolve();
  }

  async #crypto() {
    if (!this.crypto) this.crypto = (await import("electron")).safeStorage;
    return this.crypto;
  }

  async #stored() {
    let raw;
    try {
      raw = await readFile(this.path, "utf8");
    } catch {
      return migrateSettings(undefined); // 首次运行还没有配置文件
    }
    try {
      return migrateSettings(JSON.parse(raw));
    } catch (error) {
      // 配置损坏时不再静默清零：把坏文件改名留档（含全部凭证密文），
      // 用户可手工找回，而不是一夜之间所有 API Key 凭空消失。
      const backup = this.path + ".corrupt-" + Date.now();
      // 等留档完成再返回默认值:否则调用方(与测试)可能读不到备份文件。
      await rename(this.path, backup).catch(() => {});
      console.warn("[settings] 配置文件损坏，已留档到 " + backup + "：", error.message);
      return migrateSettings(undefined);
    }
  }

  async load() {
    const crypto = await this.#crypto();
    const stored = await this.#stored();
    let decryptFailed = 0;
    const credentials = stored.credentials.map(({ id, label, baseUrl, encryptedKey }) => {
      if (!encryptedKey) return { id, label, baseUrl, apiKey: "" };
      const apiKey = decryptOrEmpty(encryptedKey, crypto);
      // 有密文却解出空串 = 密钥库变更导致解密失败,计数让设置页明示「请重新填写」。
      if (!apiKey) decryptFailed += 1;
      return { id, label, baseUrl, apiKey };
    });
    return { ...stored, credentials, decryptFailed };
  }

  // 原子替换写入：tmp fsync 后直接 rename 覆盖，断电不再留下半截配置文件。
  // tmp 名带随机后缀：多个写入并发时不会共用同一个 tmp 互相踩踏。
  async #atomicWrite(data) {
    await mkdir(dirname(this.path), { recursive: true });
    const temporary = `${this.path}.tmp-${Math.random().toString(36).slice(2)}`;
    const handle = await open(temporary, "w");
    try {
      await handle.writeFile(JSON.stringify(data, null, 2), "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
    for (let attempt = 0; ; attempt += 1) {
      try {
        await rename(temporary, this.path);
        return;
      } catch (error) {
        if (attempt >= 3) throw error;
        if (error.code !== "EPERM" && error.code !== "EACCES" && error.code !== "EBUSY") {
          throw error;
        }
        await new Promise((resolve) => setTimeout(resolve, 50 * (attempt + 1)));
      }
    }
  }

  async save(settings) {
    // 排队执行读改写：两个 save 并发时（设置页双击保存、多窗口），后一个
    // 以前一个写入后的档为 previous，凭据不会被旧快照覆盖丢失。
    const run = this.saveQueue.then(
      () => this.#saveNow(settings),
      () => this.#saveNow(settings),
    );
    this.saveQueue = run.catch(() => {});
    await run;
  }

  async #saveNow(settings) {
    const crypto = await this.#crypto();
    const previous = await this.#stored();
    // 入参可能是 null/undefined（渲染层异常载荷）——与 settings:save 的
    // 校验同一套宽松判定，别在这里炸出裸 TypeError。
    const incomingSource = Array.isArray(settings?.credentials) ? settings.credentials : [];
    const usedIds = new Set(incomingSource.map((item) => item?.id).filter(Boolean));
    const identified = incomingSource.map((item) => {
      let id = item.id;
      if (!id) {
        let suffix = 1;
        do {
          id = "cred-" + suffix;
          suffix += 1;
        } while (usedIds.has(id));
        usedIds.add(id);
      }
      return { ...item, id };
    });
    const incoming = migrateSettings({ ...settings, version: 2, credentials: identified });
    const incomingKeys = new Map(identified.map((item) => [item.id, item.apiKey ?? ""]));
    const credentials = incoming.credentials.map((credential) => {
      const apiKey = incomingKeys.get(credential.id) ?? "";
      if (apiKey === KEEP_KEY) {
        const kept = previous.credentials.find((item) => item.id === credential.id);
        return { ...credential, encryptedKey: kept?.encryptedKey ?? "" };
      }
      if (apiKey && crypto.isEncryptionAvailable?.() === false) {
        // Linux 无密钥环时 basic_text 只是弱混淆：明确告知主进程日志，
        // 由渲染层设置页同时给出可见提示。
        console.warn("[settings] 系统加密不可用，API Key 仅做基础混淆存储");
      }
      return {
        ...credential,
        encryptedKey: apiKey ? crypto.encryptString(apiKey).toString("base64") : "",
      };
    });
    // 防御（C8）：入参是空凭证表而旧档里明明有凭证——多半是设置未加载完
    // 就保存的兜底值；整表清空会抹掉全部 Key。保留旧凭证，让明人的删改
    // 走「逐条显式改空 Key」的路径。
    if (!credentials.length && previous.credentials.length) {
      console.warn("[settings] 拒绝空凭证表覆盖非空旧档（疑似未加载完就保存）");
      return void (await this.#atomicWrite({ ...incoming, credentials: previous.credentials }));
    }
    await this.#atomicWrite({ ...incoming, credentials });
  }
}
