import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { KEEP_KEY, SettingsStore } from "../electron/settings-store.js";

function fakeCrypto({ failDecrypt = false } = {}) {
  return {
    isEncryptionAvailable: () => true,
    encryptString: (plain) => Buffer.from("enc:" + plain, "utf8").toString("base64"),
    decryptString: (buffer) => {
      const plain = Buffer.from(buffer, "base64").toString("utf8");
      if (failDecrypt) throw new Error("keychain gone");
      return plain.replace(/^enc:/, "");
    },
  };
}

test("settings round-trip encrypts keys and honours KEEP_KEY", async () => {
  const directory = await mkdtemp(join(tmpdir(), "settings-store-"));
  const store = new SettingsStore(join(directory, "settings.json"), fakeCrypto());
  await store.save({
    credentials: [{ id: "a", label: "甲", baseUrl: "https://api.deepseek.com", apiKey: "sk-1" }],
    fast: { credentialId: "a", model: "m1" },
    strong: { credentialId: "a", model: "m2" },
  });
  // 落盘的是密文，不是明文 Key。
  const raw = await readFile(join(directory, "settings.json"), "utf8");
  assert.ok(!raw.includes("sk-1"));
  const loaded = await store.load();
  assert.equal(loaded.credentials[0].apiKey, "sk-1");
  assert.equal(loaded.fast.model, "m1");

  // KEEP_KEY：不传明文 Key 时保留旧密文。
  await store.save({
    credentials: [{ id: "a", baseUrl: "https://api.deepseek.com", apiKey: KEEP_KEY }],
  });
  assert.equal((await store.load()).credentials[0].apiKey, "sk-1");

  // 解密失败降级为空串而不是抛错。
  const broken = new SettingsStore(join(directory, "settings.json"), fakeCrypto({ failDecrypt: true }));
  const brokenLoaded = await broken.load();
  assert.equal(brokenLoaded.credentials[0].apiKey, "");
  assert.equal(brokenLoaded.decryptFailed, 1, "解密失败要计数,设置页据此提示重填");
});

test("corrupted settings file is preserved and defaults returned", async () => {
  const directory = await mkdtemp(join(tmpdir(), "settings-store-"));
  const path = join(directory, "settings.json");
  await mkdir(directory, { recursive: true });
  await writeFile(path, "{half json", "utf8");
  const store = new SettingsStore(path, fakeCrypto());
  assert.deepEqual((await store.load()).credentials, []);
  const files = await readdir(directory);
  assert.ok(files.some((file) => file.includes("corrupt")), "损坏文件应留档");
  assert.ok(!files.includes("settings.json"), "损坏主文件应被移走");
});

test("unavailable encryption falls back to obfuscation without throwing", async () => {
  const directory = await mkdtemp(join(tmpdir(), "settings-store-"));
  const crypto = {
    isEncryptionAvailable: () => false,
    encryptString: (plain) => Buffer.from("plain:" + plain, "utf8").toString("base64"),
    decryptString: (buffer) => Buffer.from(buffer, "base64").toString("utf8").replace(/^plain:/, ""),
  };
  const store = new SettingsStore(join(directory, "settings.json"), crypto);
  await store.save({
    credentials: [{ id: "a", baseUrl: "https://api.deepseek.com", apiKey: "sk-1" }],
  });
  assert.equal((await store.load()).credentials[0].apiKey, "sk-1");
});

test("并发保存串行执行:无损坏、无混叠、无 tmp 残留", async () => {
  const directory = await mkdtemp(join(tmpdir(), "settings-store-race-"));
  const store = new SettingsStore(join(directory, "settings.json"), fakeCrypto());
  await store.save({
    credentials: [{ id: "a", label: "甲", baseUrl: "https://api.deepseek.com", apiKey: "sk-1" }],
  });
  // 两个保存并发:save 的入参是整份凭证列表(全量替换),串行化保证落盘的是
  // 某一次完整提交——既不是两份交错拼出的半截 JSON,也不是「新列表 + 旧密文」
  // 的混叠组合。
  await Promise.all([
    store.save({
      credentials: [
        { id: "a", baseUrl: "https://api.deepseek.com", apiKey: KEEP_KEY },
        { id: "b", label: "乙", baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1", apiKey: "sk-2" },
      ],
    }),
    store.save({
      credentials: [
        { id: "a", label: "甲", baseUrl: "https://api.deepseek.com", apiKey: "sk-3" },
      ],
    }),
  ]);
  // 主文件是完整合法的 JSON(并发写坏会留下半截)。
  const raw = await readFile(join(directory, "settings.json"), "utf8");
  const stored = JSON.parse(raw);
  assert.ok(Array.isArray(stored.credentials));
  assert.ok(stored.credentials.length >= 1 && stored.credentials.length <= 2);
  const loaded = await store.load();
  const a = loaded.credentials.find((item) => item.id === "a");
  // a 的 Key 是两次写入语义之一:KEEP(沿用 sk-1)或显式 sk-3;空串=密文被踩。
  assert.ok(["sk-1", "sk-3"].includes(a.apiKey), "a 的密文没有在并发中被踩坏");
  const b = loaded.credentials.find((item) => item.id === "b");
  if (b) assert.equal(b.apiKey, "sk-2", "b 在场时密文完整可解");
  // 写完没有 tmp 残留(随机后缀 tmp 全部被 rename 收走)。
  const files = await readdir(directory);
  assert.deepEqual(files.filter((file) => file.includes(".tmp")), []);
});
