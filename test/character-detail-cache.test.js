import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { CharacterDetailCache } from "../src/character-detail-cache.js";

test("character detail cache calls the model once and reuses the result", async () => {
  const directory = await mkdtemp(join(tmpdir(), "evolution-character-"));
  let calls = 0;
  const cache = new CharacterDetailCache({
    directory,
    completeJson: async () => {
      calls += 1;
      return { summary: "守在门外", motives: ["求生"] };
    },
  });
  const payload = {
    character: { id: "guide", firstChapter: 1 },
    sourceChapters: [{ index: 1, text: "引路人守在门外。" }],
    context: { state: {} },
  };
  assert.deepEqual(await cache.getOrCreate(payload), { summary: "守在门外", motives: ["求生"] });
  assert.deepEqual(await cache.getOrCreate(payload), { summary: "守在门外", motives: ["求生"] });
  assert.equal(calls, 1);
  assert.match(await readFile(join(directory, (await import("node:crypto")).createHash("sha1").update("guide").digest("hex") + ".json"), "utf8"), /守在门外/);
});

test("character detail cache shares an in-flight request", async () => {
  const directory = await mkdtemp(join(tmpdir(), "evolution-character-pending-"));
  let calls = 0;
  let release;
  let started;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const requestStarted = new Promise((resolve) => {
    started = resolve;
  });
  const cache = new CharacterDetailCache({
    directory,
    completeJson: async () => {
      calls += 1;
      started();
      await gate;
      return { summary: "已精读" };
    },
  });
  const payload = {
    character: { id: "guide", firstChapter: 1 },
    sourceChapters: [{ index: 1, text: "引路人。" }],
    context: { state: {} },
  };

  const first = cache.getOrCreate(payload);
  const second = cache.getOrCreate(payload);
  await requestStarted;
  assert.equal(calls, 1);
  release();
  assert.deepEqual(await Promise.all([first, second]), [
    { summary: "已精读" },
    { summary: "已精读" },
  ]);
});

test("缓存写入不留 tmp 残留(原子替换而非裸写)", async () => {
  const { readdir } = await import("node:fs/promises");
  const { createHash } = await import("node:crypto");
  const directory = await mkdtemp(join(tmpdir(), "evolution-character-atomic-"));
  const cache = new CharacterDetailCache({
    directory,
    completeJson: async () => ({ summary: "落定" }),
  });
  await cache.getOrCreate({
    character: { id: "guide", firstChapter: 1 },
    sourceChapters: [{ index: 1, text: "正文" }],
    context: { state: {} },
  });
  const files = await readdir(directory);
  assert.deepEqual(
    files.filter((file) => file.includes(".tmp")),
    [],
    "tmp 已被 rename 收走,崩溃不会留下半截 JSON",
  );
  assert.ok(files.includes(createHash("sha1").update("guide").digest("hex") + ".json"));
});
