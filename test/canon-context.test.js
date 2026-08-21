import assert from "node:assert/strict";
import test from "node:test";

import { buildContext, StoryEngine } from "../src/engine.js";
import { buildCanonLedger } from "../src/canon-ledger.js";
import { initialState as initialStateFixture, startingOption, world as worldFixture } from "../fixtures/world.js";
import { basicStructure, dualLlm } from "./helpers/llm.js";

function chapters(...indexes) {
  return indexes.map((index) => ({ index, title: `第${index}章`, text: "正文".repeat(50) }));
}

function ledger() {
  return buildCanonLedger({
    groups: [chapters(1, 2, 3, 4, 5, 6)],
    summaries: [
      {
        facts: [{ text: "灯塔守夜人留下了一本涂改过的盐仓账簿。", chapter: 5 }],
        events: [
          { text: "商队抵达盐仓。", chapter: 4 },
          { text: "守夜人与盐商的旧契曝光。", chapter: 50 },
        ],
      },
    ],
  });
}

function state(extra = {}) {
  return {
    ...structuredClone(initialStateFixture),
    turn: 6,
    retrievalKeywords: ["灯塔", "守夜人", "盐仓账簿"],
    // event-2 已交付（chapterAnchor=2）：horizon 锚章 = 2，账本第 4/50 章事件属于「将至」。
    eventStates: { "event-2": { status: "delivered" } },
    entityStateNotes: { lin: { note: "在灯塔养伤，对玩家起疑。", turn: 5 } },
    ...extra,
  };
}

test("账本注入：retrievedFacts 补入长尾事实，canonHorizon 给出到期窗口与长线伏笔", () => {
  const context = buildContext({
    world: worldFixture,
    state: state(),
    history: [],
    targetIds: ["lin"],
    canonLedger: ledger(),
  });
  const ledgerFact = context.retrievedFacts.find((fact) =>
    String(fact.text ?? "").includes("盐仓账簿"),
  );
  assert.ok(ledgerFact, "账本事实应随检索词补入 retrievedFacts");
  assert.deepEqual(
    context.canonHorizon.map((event) => event.chapter),
    [4, 50],
    "锚章 2 之后的账本事件按到期窗口+相关性进入 canonHorizon",
  );
  const lin = context.world.characters.find((character) => character.id === "lin");
  assert.equal(lin.currentState, "在灯塔养伤，对玩家起疑。");
});

test("无账本时优雅回退：canonHorizon 为空、retrievedFacts 保持旧行为", () => {
  const context = buildContext({
    world: worldFixture,
    state: state(),
    history: [],
    targetIds: ["lin"],
  });
  assert.deepEqual(context.canonHorizon, []);
  assert.ok(
    context.retrievedFacts.every((fact) => !String(fact.text ?? "").includes("盐仓账簿")),
    "没有账本时不得凭空多出事实",
  );
});

test("过期的人物状态笔记不再注入 currentState", () => {
  const context = buildContext({
    world: worldFixture,
    // 第 0 回的笔记到第 40 回早已超出 30 回新鲜度窗口。
    state: state({ turn: 40, entityStateNotes: { lin: { note: "在灯塔养伤。", turn: 0 } } }),
    history: [],
    targetIds: ["lin"],
  });
  const lin = context.world.characters.find((character) => character.id === "lin");
  assert.equal(lin.currentState, undefined);
});

test("引擎回合收尾把追踪器笔记写进动态状态账，随后回合的上下文带上 currentState", async () => {
  const calls = [];
  const tracker = {
    interval: 1,
    async update({ state }) {
      calls.push(state.turn);
      return { notes: { lin: { note: "与玩家在旧码头结盟，伤愈。", turn: state.turn } } };
    },
  };
  const engine = new StoryEngine({
    world: worldFixture,
    initialState: structuredClone(initialStateFixture),
    llm: dualLlm({ structure: basicStructure() }),
    entityTracker: tracker,
  });
  await engine.play({ ...startingOption });
  await engine.flushBackground();
  assert.equal(calls.length, 1, "interval=1 时每回合记账一次");
  assert.equal(engine.store.current.entityStateNotes.lin.note, "与玩家在旧码头结盟，伤愈。");
  assert.equal(engine.store.current.entityNotesTurn, 1);
  // 记账失败不能拖垮回合：追踪器抛错后队列静默吞掉，状态账保持旧值。
  const failing = new StoryEngine({
    world: worldFixture,
    initialState: structuredClone(initialStateFixture),
    llm: dualLlm({ structure: basicStructure() }),
    entityTracker: {
      interval: 1,
      async update() {
        throw new Error("快模型故障");
      },
    },
  });
  await failing.play({ ...startingOption });
  await failing.flushBackground();
  assert.equal(failing.store.current.entityStateNotes, undefined);
});
