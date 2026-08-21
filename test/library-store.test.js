import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { LibraryStore, bookId } from "../electron/library-store.js";
import { normalizeWorld } from "../src/evolution.js";

const world = normalizeWorld({
  id: "world",
  title: "书",
  locations: ["起点"],
  attributes: [{ id: "will", name: "意志", initial: 30 }],
  stats: [{ id: "life", name: "生命", role: "vital", min: 0, max: 10, initial: 10 }],
  timeline: [],
  facts: [],
});

const source = {
  title: "书",
  format: "txt",
  chapters: [{ index: 1, title: "一", text: "正文" }],
};

test("刚烧好的书不算旧档案，不该触发补齐（补齐会把整本书发给模型，直接 413）", async () => {
  const library = new LibraryStore(await mkdtemp(join(tmpdir(), "evolution-library-")));
  const meta = await library.add({ world, initialState: { turn: 0 }, source });

  assert.equal(world.schemaVersion, 5, "全员人设卡语义版本");
  assert.equal((await library.load(meta.id)).legacyWorld, false);
});

test("schemaVersion 4 之前的档案才算旧", async () => {
  const library = new LibraryStore(await mkdtemp(join(tmpdir(), "evolution-legacy-")));
  const meta = await library.add({ world, initialState: { turn: 0 }, source });
  const path = library.path(meta.id, "world.json");
  const stored = JSON.parse(await readFile(path, "utf8"));
  delete stored.world.schemaVersion;
  await writeFile(path, JSON.stringify(stored), "utf8");

  assert.equal((await library.load(meta.id)).legacyWorld, true);
  // 原始版本号留档供 needsRebake 判定：normalize 后的 world.schemaVersion 恒为 5。
  assert.equal((await library.load(meta.id)).rawSchemaVersion, 0);
});

test("bookId 确定性派生：世界导入的冲突检测靠它对上同一书位", () => {
  assert.equal(bookId("书", "txt"), bookId("书", "txt"));
  assert.notEqual(bookId("书", "txt"), bookId("书", "epub"));
  assert.match(bookId("书", "txt"), /^[a-f0-9]{16}$/);
});

test("无原文世界落库：空章节占位 + sourceless 标记，load 照常可读", async () => {
  const library = new LibraryStore(await mkdtemp(join(tmpdir(), "evolution-sourceless-")));
  const meta = await library.add({
    world,
    initialState: { turn: 0 },
    source: { title: "分享的世界", format: "txt", chapters: [] },
    sourceless: true,
  });
  assert.equal(meta.sourceless, true);
  assert.equal(meta.chapterCount, 0);

  const book = await library.load(meta.id);
  assert.deepEqual(book.chapters, []);
  assert.equal(book.meta.sourceless, true);
  assert.equal(book.rawSchemaVersion, 5, "导入的世界已是规范形态");
});
