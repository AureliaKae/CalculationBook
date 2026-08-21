import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { UsageStore } from "../electron/usage-store.js";

async function withStore(run) {
  const directory = await mkdtemp(join(tmpdir(), "usage-store-"));
  try {
    await run(new UsageStore(join(directory, "usage.json")), directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

test("record 按书累计并节流落盘,flush 立即写", async () => {
  await withStore(async (store, directory) => {
    store.record("book1", { promptTokens: 100, completionTokens: 50 });
    store.record("book1", { promptTokens: 30, completionTokens: 20 });
    store.record("", { promptTokens: 10, completionTokens: 0 });
    await store.flush();
    const raw = JSON.parse(await readFile(join(directory, "usage.json"), "utf8"));
    assert.equal(raw.books.book1.promptTokens, 130);
    assert.equal(raw.books.book1.completionTokens, 70);
    assert.equal(raw.books.book1.requests, 2);
    assert.equal(raw.books.misc.promptTokens, 10, "无主请求记入杂项桶");
  });
});

test("view 并入书名并给合计;坏档回零不炸", async () => {
  await withStore(async (store) => {
    store.record("book1", { promptTokens: 100, completionTokens: 50 });
    store.record("book2", { promptTokens: 1, completionTokens: 1 });
    await store.flush();
    const view = await store.view(new Map([["book1", "甲书"]]));
    assert.equal(view.books.length, 2);
    assert.equal(view.books.find((b) => b.id === "book1").title, "甲书");
    assert.equal(view.books.find((b) => b.id === "book2").title, "已下架的书", "未知书名兜底");
    assert.equal(view.total.promptTokens, 101);
    assert.equal(view.total.requests, 2);
  });
  await withStore(async (store, directory) => {
    await writeFile(join(directory, "usage.json"), "{half", "utf8");
    const view = await store.view();
    assert.equal(view.books.length, 0, "坏档回零");
  });
});

test("record 对非数字用量静默跳过", async () => {
  await withStore(async (store, directory) => {
    store.record("book1", {});
    store.record("book1", { promptTokens: Number.NaN });
    await store.flush();
    // 全部被跳过：没有任何记账 → 不落盘（flush 无脏数据直接返回）。
    const files = (await readdir(directory)).filter((file) => file.startsWith("usage"));
    assert.deepEqual(files, [], "无有效用量不产生账本文件");
  });
});

test("removeBook 下架清该书账目,misc 与其余书保留,幂等", async () => {
  await withStore(async (store, directory) => {
    store.record("book1", { promptTokens: 100, completionTokens: 50 });
    store.record("book2", { promptTokens: 30, completionTokens: 20 });
    store.record("", { promptTokens: 10, completionTokens: 0 });
    store.removeBook("book1");
    store.removeBook("ghost");
    await store.flush();
    const raw = JSON.parse(await readFile(join(directory, "usage.json"), "utf8"));
    assert.equal(raw.books.book1, undefined, "下架书的账目随书清除");
    assert.equal(raw.books.book2.promptTokens, 30, "其余书不动");
    assert.equal(raw.books.misc.promptTokens, 10, "杂项桶不动");
  });
});
