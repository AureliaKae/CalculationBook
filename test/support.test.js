import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { MockLlm } from "../fixtures/mock-llm.js";
import { initialState, startingOption, world } from "../fixtures/world.js";
import { StoryEngine } from "../src/engine.js";
import {
  LayeredMemory,
  retrieveMemories,
  updateStructuredMemories,
} from "../src/memory.js";
import { Bm25Index } from "../src/retrieval.js";
import { ProgressStore, restoreEngine, resumeEnding, serializeEngine } from "../src/save-store.js";

test("BM25 ranks relevant Chinese facts and supports chapter filters", () => {
  const index = new Bm25Index([
    { id: "a", text: "燕尾铜扣属于灯塔守夜人", chapterAnchor: 2 },
    { id: "b", text: "盐仓里储存着冬季口粮", chapterAnchor: 5 },
  ]);
  assert.equal(index.search("铜扣 灯塔")[0].id, "a");
  assert.equal(
    index.search("口粮", { filter: (item) => item.chapterAnchor <= 3 }).length,
    0,
  );
});

test("续玩点保存并恢复快照、历史与随机数状态", async () => {
  const directory = await mkdtemp(join(tmpdir(), "evolution-save-"));
  const store = new ProgressStore(directory);
  const engine = new StoryEngine({ world, initialState, llm: new MockLlm(), seed: 42 });
  await engine.play(startingOption);
  const saved = serializeEngine(engine, { bookId: "book", storyId: "story" });
  await store.write("book", saved);

  const loaded = await store.read("book");
  const restored = restoreEngine(
    new StoryEngine({ world, initialState, llm: new MockLlm(), seed: 1 }),
    loaded,
  );
  assert.deepEqual(restored.store.current, engine.store.current);
  assert.deepEqual(restored.history, engine.history);
  assert.equal(restored.random.getState(), engine.random.getState());
  assert.deepEqual(await store.turns(), { book: engine.store.current.turn });
});

test("resumeEnding rebuilds the ending view from the last saved turn", () => {
  const stageEngine = new StoryEngine({ world, initialState, llm: new MockLlm(), seed: 42 });
  const stageTurn = {
    number: 7,
    narrative: "阶段收束。",
    check: {},
    dueEvents: [],
    options: [],
    openThreads: [],
    retrievalKeywords: [],
    consequences: [],
    relationshipChanges: [],
    dominantSystems: [],
    enhancementResults: { committed: [], dropped: [] },
    journal: [],
    endingCandidate: { type: "stage", goalId: "core-goal-1", ready: true },
    death: { dead: false },
  };
  stageEngine.history.push(stageTurn);
  // 快照同样带上就绪的候选(A5 口径:真实存档里回合提交时快照与历史一致,
  // 阶段终局以快照为准——只有被 continue-stage 清过的快照才不再复活)。
  stageEngine.store.push({
    ...stageEngine.store.current,
    turn: 7,
    endingCandidate: stageTurn.endingCandidate,
  });
  assert.deepEqual(resumeEnding(stageEngine), { type: "stage", goalId: "core-goal-1" });

  const deathEngine = new StoryEngine({ world, initialState, llm: new MockLlm(), seed: 42 });
  deathEngine.history.push({ ...stageTurn, number: 9, death: { dead: true, cause: "灯油耗尽" } });
  deathEngine.store.push({ ...deathEngine.store.current, turn: 9 });
  assert.deepEqual(resumeEnding(deathEngine), {
    type: "death",
    cause: "灯油耗尽",
    name: deathEngine.store.current.player.name,
    turns: 9,
  });

  const freshEngine = new StoryEngine({ world, initialState, llm: new MockLlm(), seed: 42 });
  assert.equal(resumeEnding(freshEngine), null);
});

test("一本书只有一份续玩点，写入覆盖、清除后读不到", async () => {
  const directory = await mkdtemp(join(tmpdir(), "evolution-v4-"));
  const store = new ProgressStore(directory);
  const base = {
    version: 4,
    updatedAt: "2026-08-11T00:00:00.000Z",
    metadata: { bookId: "book", storyId: "story" },
    world,
    history: [],
    randomState: 1,
  };
  await store.write("book", { ...base, snapshots: [{ ...initialState, turn: 3 }] });
  await store.write("book", { ...base, snapshots: [{ ...initialState, turn: 7 }] });
  assert.deepEqual(await store.turns(), { book: 7 });

  // 旧版本的存档直接作废，但读操作不再顺手删文件：旧档留给显式清理。
  await store.write("legacy", { version: 2, world, snapshots: [initialState] });
  assert.equal(await store.read("legacy"), null);
  assert.equal(await store.read("legacy"), null); // 重复读同样不抛、不删
  assert.deepEqual(await store.turns(), { book: 7 });

  await store.clear("book");
  assert.equal(await store.read("book"), null);
  assert.deepEqual(await store.turns(), {});
});

/* 手动存档槽 API 已随「只留沉浸式续玩点」拍板删除（2026-08-21），
   原「独立于自动续玩点可列读删清」测试同批移除；自动续玩点读写由
   上一测试（turns/read/clear）覆盖。 */

test("坏结构存档读为 null 且文件保留，recover 采纳完好的 .tmp、丢弃损坏的", async () => {
  const { writeFile, readdir, unlink, mkdir } = await import("node:fs/promises");
  const directory = await mkdtemp(join(tmpdir(), "evolution-recover-"));
  const store = new ProgressStore(directory);
  const good = {
    version: 4,
    updatedAt: "2026-08-11T00:00:00.000Z",
    metadata: { bookId: "crash" },
    world,
    history: [],
    randomState: 1,
    snapshots: [{ ...initialState, turn: 5 }],
  };

  // 能解析、version=4、但缺 snapshots：read 返回 null 且不抛、文件保留。
  await writeFile(join(directory, "broken.json"), JSON.stringify({ version: 4, world, randomState: 1 }), "utf8");
  assert.equal(await store.read("broken"), null);
  assert.ok((await readdir(directory)).includes("broken.json"));

  // 崩溃残留：完好的 .tmp 被采纳为主档，损坏的 .tmp 被丢弃。
  await mkdir(directory, { recursive: true });
  await writeFile(join(directory, "crash.json.tmp"), JSON.stringify(good), "utf8");
  await writeFile(join(directory, "garbage.json.tmp"), "{\"half", "utf8");
  await store.recover();
  const files = await readdir(directory);
  assert.ok(files.includes("crash.json"));
  assert.ok(!files.includes("crash.json.tmp"));
  assert.ok(!files.includes("garbage.json.tmp"));
  assert.equal((await store.read("crash")).snapshots[0].turn, 5);

  // 主档存在时 read 不受 tmp 干扰；恢复出的存档进入回合索引。
  await store.write("crash", { ...good, snapshots: [{ ...initialState, turn: 9 }] });
  assert.deepEqual(await store.turns(), { crash: 9 });
  await unlink(join(directory, "crash.json"));
});

test("layered memory updates summaries only at configured intervals", async () => {
  const memory = new LayeredMemory({
    interval: 2,
    summarizer: async ({ previous, recent }) => `${previous}|${recent}`,
  });
  const history = [{ narrative: "一" }, { narrative: "二" }];
  const updated = await memory.update({ chapterSummary: "序" }, history);
  assert.equal(updated.chapterSummary, "序|一\n二");
});

test("layered memory accepts a recent window without copying full history", async () => {
  const memory = new LayeredMemory({
    interval: 5,
    summarizer: async ({ recent }) => recent,
  });
  const recentHistory = [{ narrative: "九" }, { narrative: "十" }];
  const updated = await memory.update(
    { chapterSummary: "旧" },
    recentHistory,
    { historyLength: 10, recentHistory },
  );
  assert.equal(updated.chapterSummary, "九\n十");
});

test("layered memory failures do not abort a completed turn", async () => {
  const memory = new LayeredMemory({
    interval: 1,
    summarizer: async () => {
      throw new Error("summary unavailable");
    },
  });
  const state = { chapterSummary: "原摘要" };
  assert.deepEqual(await memory.update(state, [{ narrative: "新事件" }]), state);
});

test("structured memories retain sources and are not gated by chapter", () => {
  const state = {
    unlockedChapter: 2,
    resolvedThreads: [],
    eventStates: { bell: { status: "delivered" } },
    longTermMemories: [],
  };
  const memories = updateStructuredMemories(state, {
    number: 3,
    dueEvents: [{ id: "bell", text: "黑铃响起", chapterAnchor: 2 }],
    openThreads: ["燕尾铜扣"],
  });
  assert.equal(memories.length, 2);
  assert.equal(memories[0].sourceTurn, 3);
  memories.push({
    id: "future",
    type: "event",
    text: "未来真相",
    importance: 3,
    chapterAnchor: 8,
    status: "active",
    sourceTurn: 8,
  });
  memories.push({
    id: "invalid",
    type: "event",
    text: "燕尾伪线索",
    importance: 3,
    chapterAnchor: 1,
    status: "invalidated",
    sourceTurn: 2,
  });
  // 拍板 2026-08-17：玩家已读完小说，章节不再作为检索门槛；只有失效记忆被排除。
  const retrieved = retrieveMemories(memories, "燕尾 黑铃", 2);
  assert.ok(retrieved.some((item) => item.text === "黑铃响起"));
  assert.ok(retrieved.every((item) => item.id !== "invalid"), "失效记忆仍被排除");
  // 未来章节的记忆（chapterAnchor 8 > unlockedChapter 2）不再被章节门槛拦下，
  // 只要相关性足够就能被检索到。
  const future = memories.find((item) => item.id === "future");
  future.text = "黑铃与燕尾的真相";
  const retrievedAgain = retrieveMemories(memories, "黑铃 燕尾", 2);
  assert.ok(retrievedAgain.some((item) => item.id === "future"), "未来章节记忆可被检索");
});

test("retrieval ranks relevance above importance: a stale important memory does not displace a relevant one", () => {
  const memories = [
    {
      id: "relevant",
      type: "thread",
      text: "燕尾铜扣在灯塔地窖",
      importance: 2,
      chapterAnchor: 1,
      status: "active",
      sourceTurn: 9,
    },
    {
      id: "stale",
      type: "event",
      text: "旧码头的水位上涨",
      importance: 3,
      chapterAnchor: 1,
      status: "active",
      sourceTurn: 1,
    },
  ];
  const retrieved = retrieveMemories(memories, "燕尾铜扣", 2);
  assert.equal(retrieved[0].id, "relevant");
});
