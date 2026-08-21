import assert from "node:assert/strict";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { ProgressStore, restoreEngine, resumeEnding, serializeEngine } from "../src/save-store.js";
import { normalizeWorld } from "../src/evolution.js";

const world = () =>
  normalizeWorld({
    id: "world",
    title: "书",
    characters: [{ id: "guide", name: "引路人", locationIds: ["gate"], firstChapter: 2 }],
    locations: ["gate", "tower"],
    factions: [{ id: "guild", name: "公会" }],
    roleTemplates: [{ id: "scout", name: "斥候", locationIds: ["gate"], factionIds: ["guild"] }],
    attributes: [{ id: "focus", name: "专注", initial: 20 }],
    stats: [{ id: "life", name: "生命", role: "vital", min: 0, max: 10, initial: 10 }],
    timeline: [],
    facts: [],
  });

function fakeEngine() {
  return {
    world: null,
    store: {
      snapshots: [],
      get current() {
        return this.snapshots[this.snapshots.length - 1];
      },
    },
    history: [],
    random: {
      state: 12345,
      getState() {
        return this.state;
      },
      setState(value) {
        this.state = value;
      },
    },
    rewriteCount: 0,
    openThreadSet: new Set(),
  };
}

function makeSave({ lastTurnDeath = null } = {}) {
  return {
    version: 4,
    updatedAt: "2026-08-18T00:00:00.000Z",
    metadata: { bookId: "aaaaaaaaaaaaaaaa", storyId: "s1", currentOptions: [] },
    world: world(),
    snapshots: [{ turn: 3, locationId: "gate", resolvedThreads: [] }],
    history: [
      { number: 3, narrative: "正文", openThreads: ["铜扣"], death: lastTurnDeath },
    ],
    randomState: 42,
    rewriteCount: 0,
  };
}

test("restoreEngine 按最后一回合的死亡记录补持久死亡标记", async () => {
  const saved = makeSave({ lastTurnDeath: { dead: true, cause: "死于搏杀" } });
  const engine = fakeEngine();
  restoreEngine(engine, saved);
  // 旧档迁移:交锋致死的 survivalPressures 里没有致命项,不补标记就会把死人判活。
  assert.equal(engine.store.current.playerDead, true);
  assert.equal(engine.store.current.playerDeathCause, "死于搏杀");
  assert.equal(resumeEnding(engine).type, "death");
});

test("resumeEnding 阶段终局以快照为准:续写过的阶段不再复活", async () => {
  // continue-stage 只清快照里的 endingCandidate、不动回合史——按回合史恢复
  // 会把已续写的阶段再复活一次,反复点续写还会堆积重复的承接目标。
  const saved = makeSave();
  saved.history.push({
    number: 2,
    narrative: "这一手之后卷已合上。",
    death: { dead: false },
    endingCandidate: { ready: true, goalId: "core-goal-1" },
    options: [],
    openThreads: [],
  });
  const engine = fakeEngine();
  restoreEngine(engine, saved);
  // 快照侧已被 continue-stage 清空 → 不复活。
  assert.equal(resumeEnding(engine), null);
  // 快照侧仍是 ready（尚未续写）→ 正常返回阶段终局。
  const pending = fakeEngine();
  const savedPending = makeSave();
  savedPending.history.push({
    number: 2,
    narrative: "卷合的这一手。",
    death: { dead: false },
    endingCandidate: { ready: true, goalId: "core-goal-1" },
    options: [],
    openThreads: [],
  });
  restoreEngine(pending, savedPending);
  pending.store.snapshots[pending.store.snapshots.length - 1].endingCandidate = {
    ready: true,
    goalId: "core-goal-1",
  };
  assert.equal(resumeEnding(pending)?.type, "stage");
});

test("restoreEngine 对活着的一世不设死亡标记,伏笔集合按历史重建", async () => {
  const saved = makeSave();
  saved.snapshots[0].resolvedThreads = ["已了的线"];
  const engine = fakeEngine();
  restoreEngine(engine, saved);
  assert.equal(engine.store.current.playerDead, undefined);
  assert.ok(engine.openThreadSet.has("铜扣"), "开启的伏笔从历史重建");
  assert.ok(!engine.openThreadSet.has("已了的线"), "已解决的伏笔被剔除");
});

test("serializeEngine → restoreEngine 往返保真(含死亡标记)", async () => {
  const live = fakeEngine();
  live.world = world();
  live.store.snapshots = [
    { turn: 2, locationId: "gate", resolvedThreads: [] },
    { turn: 3, locationId: "gate", resolvedThreads: [], playerDead: true, playerDeathCause: "旧伤" },
  ];
  live.history = [{ number: 3, narrative: "n", openThreads: [], death: { dead: true, cause: "旧伤" } }];
  const saved = serializeEngine(live, { bookId: "aaaaaaaaaaaaaaaa" });
  const engine = fakeEngine();
  restoreEngine(engine, saved);
  assert.equal(engine.store.current.playerDead, true);
  assert.equal(engine.store.current.playerDeathCause, "旧伤");
});

/* 手动存档槽（writeSlot/listSlots/readSlot/deleteSlot/clearSlots 与 recover
   的 slots 子目录扫描）已随「只留沉浸式续玩点」拍板删除，相关测试同批移除
   （2026-08-21）；恢复路径 progress:resume 的行为由余下测试覆盖。 */
