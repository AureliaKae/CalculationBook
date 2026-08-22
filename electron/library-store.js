import { createHash } from "node:crypto";
import { mkdir, open, readFile, readdir, rename, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { normalizeWorld } from "../src/evolution.js";

// bookId 由 sha1(title|format) 前 16 位十六进制生成：同一本书（同名同格式）
// 在任何机器上都落同一个书位——世界导入的冲突检测据此判定「已经烧过/导过」。
export function bookId(title, format) {
  return createHash("sha1").update(`${title}|${format}`).digest("hex").slice(0, 16);
}

async function directorySize(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const sizes = await Promise.all(
    entries.map(async (entry) => {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) return directorySize(path);
      return (await stat(path)).size;
    }),
  );
  return sizes.reduce((total, size) => total + size, 0);
}

// bookId 是 16 位十六进制白名单：阻断渲染层经 IPC 传入 `../` 之类路径穿越到
// 用户目录之外。
export function assertBookId(id) {
  if (typeof id !== "string" || !/^[a-f0-9]{16}$/.test(id)) {
    throw new Error("无效的书本 ID");
  }
  return id;
}

// 原子替换写入：tmp fsync 后 rename 覆盖，断电不留半截文件。
// tmp 名带随机后缀：多个写入并发时不会共用同一个 tmp 互相踩踏。
async function atomicWrite(path, data) {
  const temporary = `${path}.tmp-${Math.random().toString(36).slice(2)}`;
  const handle = await open(temporary, "w");
  try {
    await handle.writeFile(data, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  for (let attempt = 0; ; attempt += 1) {
    try {
      await rename(temporary, path);
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

export class LibraryStore {
  constructor(directory) {
    this.directory = directory;
    // 目录大小缓存：书架列表每次刷新都要显示占用，不再每本书递归 stat 全库。
    this.sizeCache = new Map();
  }

  path(id, file) {
    assertBookId(id);
    return file ? join(this.directory, id, file) : join(this.directory, id);
  }

  async add({ world, initialState, source, sourceless = false }) {
    const id = bookId(source.title, source.format);
    await mkdir(this.path(id), { recursive: true });
    const meta = {
      id,
      title: source.title,
      format: source.format,
      chapterCount: source.chapters.length,
      addedAt: new Date().toISOString(),
      // 记录世界 id：删除书籍时按它清理对应的 character-cache 目录。
      worldId: world?.id ?? null,
      // 降级兜底的世界档案要能在书架上看出来,玩家才知道该换强模型重烧。
      degraded: world?.degraded
        ? { reasons: world.degraded.reasons ?? [], note: world.degraded.note ?? "" }
        : null,
      // 采样粗读的覆盖度:书架据此亮「采样粗读」徽章,并给「补读」入口;
      // 补读烧满后重新 add,本字段不再出现。
      ...(world?.coarse?.sampled
        ? {
            coarse: {
              sampled: true,
              groupsRead: world.coarse.groupsRead ?? 0,
              groupsTotal: world.coarse.groupsTotal ?? 0,
            },
          }
        : {}),
      // 导入的无原文世界：chapters 为空数组占位（load 对它是硬依赖），重烧被
      // library:rebake 拒绝；书架据此刻徽标并隐藏「重新烧制」。
      ...(sourceless ? { sourceless: true } : {}),
    };
    try {
      await atomicWrite(this.path(id, "chapters.json"), JSON.stringify(source.chapters));
      await atomicWrite(
        this.path(id, "world.json"),
        JSON.stringify({ world, initialState }, null, 2),
      );
      // meta 最后写：书架只会看到写全了的书；中途失败整个目录回滚。
      await atomicWrite(this.path(id, "meta.json"), JSON.stringify(meta, null, 2));
    } catch (error) {
      await rm(this.path(id), { recursive: true, force: true }).catch(() => {});
      throw error;
    }
    this.sizeCache.delete(id);
    return meta;
  }

  async list() {
    await mkdir(this.directory, { recursive: true });
    const entries = await readdir(this.directory, { withFileTypes: true });
    const books = await Promise.all(
      entries
        .filter((entry) => entry.isDirectory())
        .map(async (entry) => {
          try {
            const meta = JSON.parse(await readFile(this.path(entry.name, "meta.json"), "utf8"));
            // 大小只算一次并缓存，add/remove 时失效；每回合刷书架不再递归 stat 全库。
            if (!this.sizeCache.has(meta.id)) {
              this.sizeCache.set(meta.id, await directorySize(this.path(entry.name)));
            }
            return { ...meta, bytes: this.sizeCache.get(meta.id) };
          } catch {
            return null;
          }
        }),
    );
    return books
      .filter(Boolean)
      .sort((left, right) => String(right.addedAt).localeCompare(String(left.addedAt)));
  }

  async load(id) {
    const [meta, world, chapters] = await Promise.all([
      readFile(this.path(id, "meta.json"), "utf8"),
      readFile(this.path(id, "world.json"), "utf8"),
      readFile(this.path(id, "chapters.json"), "utf8"),
    ]);
    const parsed = {
      meta: JSON.parse(meta),
      ...JSON.parse(world),
      chapters: JSON.parse(chapters),
    };
    // schemaVersion 2 起就是新结构（normalizeWorld 现在写 3），只有更早的档案才需要补齐。
    parsed.legacyWorld = !(parsed.world?.schemaVersion >= 2);
    // normalize 会把版本号强制写成当前值，之后再判断「是否需要重烧」就永远查不出
    // 旧档案——原始版本号必须在 normalize 之前留档（needsRebake 据此判定）。
    parsed.rawSchemaVersion = Number(parsed.world?.schemaVersion) || 0;
    parsed.world = normalizeWorld(parsed.world);
    return parsed;
  }

  async remove(id) {
    await rm(this.path(id), { recursive: true, force: true });
    this.sizeCache.delete(id);
  }

  async updateWorld(id, world, initialState) {
    await atomicWrite(
      this.path(id, "world.json"),
      JSON.stringify({ world, initialState }, null, 2),
    );
    this.sizeCache.delete(id);
  }

  async usage() {
    const books = await this.list();
    return {
      books: books.length,
      bytes: books.reduce((total, book) => total + book.bytes, 0),
    };
  }
}
