import test from "node:test";
import assert from "node:assert/strict";

import { MockLlm } from "../fixtures/mock-llm.js";
import { dualLlm } from "./helpers/llm.js";
import { world as baseWorld, initialState, startingOption } from "../fixtures/world.js";
import { StoryEngine, rollCheck, buildContext } from "../src/engine.js";
import { normalizeWorld, migrateState } from "../src/evolution.js";
import {
  advanceClash,
  beginClash,
  conditionLabel,
  markPendingDeath,
  playerClashCondition,
  stanceLabel,
  validateClashStart,
} from "../src/clash.js";
import { serializeEngine, restoreEngine } from "../src/save-store.js";
import { buildNarrativeMessages } from "../src/prompt.js";

const world = normalizeWorld(structuredClone(baseWorld));
const migratedInitial = migrateState(structuredClone(initialState), world);
// 测试里玩家认识林雾，才能对 ta 动手。
const knownInitial = { ...migratedInitial, discoveredCharacterIds: ["lin"] };

function clashState(overrides = {}) {
  const base = beginClash(
    structuredClone(knownInitial),
    { opponentId: "lin", opponentName: "林雾", origin: "player", reason: "扑上去搏命" },
    world,
  );
  return { ...base, activeClash: { ...base.activeClash, ...overrides } };
}

// advanceClash 只读 check.result，直接构造，不依赖骰子。
function checkOf(result) {
  return { result, roll: 50, difficulty: 50, score: 50, margin: 0, modifier: 0 };
}

test("conditionLabel maps vital ratios to readable tiers", () => {
  assert.equal(conditionLabel(1), "无伤");
  assert.equal(conditionLabel(0.8), "轻伤");
  assert.equal(conditionLabel(0.5), "重伤");
  assert.equal(conditionLabel(0.1), "强弩之末");
  assert.equal(conditionLabel(0), "命悬一线");
});

test("playerClashCondition takes the worst vital", () => {
  const state = { stats: { breath: 4, supplies: 1 } }; // breath 4/10 = 0.4 → 重伤
  assert.equal(playerClashCondition(state, world), "重伤");
});

test("beginClash rejects unknown opponents", () => {
  assert.throws(
    () => beginClash(migratedInitial, { opponentId: "ghost" }, world),
    /Unknown clash opponent/,
  );
});

test("advanceClash pushes stance and opponent condition on success", () => {
  const state = clashState();
  const outcome = advanceClash({
    state,
    option: { axis: "force", approach: "resist", risk: "risky" },
    check: checkOf("success"),
    world,
  });
  assert.equal(outcome.ended, false);
  assert.equal(outcome.state.activeClash.stance, 1);
  assert.equal(outcome.state.activeClash.opponentCondition, 1);
});

test("advanceClash ends in victory once the opponent is down", () => {
  const state = clashState({ opponentCondition: 2 });
  const outcome = advanceClash({
    state,
    option: { axis: "force", approach: "resist", risk: "risky" },
    check: checkOf("success"),
    world,
  });
  assert.equal(outcome.ended, true);
  assert.equal(outcome.endReason, "victory");
  assert.equal(outcome.state.activeClash, null);
});

test("successful retreat ends the clash with a cost on the table", () => {
  const outcome = advanceClash({
    state: clashState(),
    option: { axis: "exit", approach: "avoid", risk: "risky" },
    check: checkOf("success"),
    world,
  });
  assert.equal(outcome.ended, true);
  assert.equal(outcome.endReason, "retreat");
});

test("failed retreat loses a step of stance", () => {
  const outcome = advanceClash({
    state: clashState({ stance: 1 }),
    option: { axis: "exit", approach: "avoid", risk: "dire" },
    check: checkOf("failure"),
    world,
  });
  assert.equal(outcome.ended, false);
  assert.equal(outcome.state.activeClash.stance, 0);
});

test("pleading through cooperate ends with mercy on success", () => {
  const outcome = advanceClash({
    state: clashState(),
    option: { axis: "social", approach: "cooperate", risk: "risky" },
    check: checkOf("success"),
    world,
  });
  assert.equal(outcome.ended, true);
  assert.equal(outcome.endReason, "mercy");
});

test("clash exhausts after the step limit", () => {
  const state = clashState({ step: 3, maxSteps: 4, stance: 0 });
  const outcome = advanceClash({
    state,
    option: { axis: "force", approach: "resist", risk: "risky" },
    check: checkOf("failure"),
    world,
  });
  assert.equal(outcome.ended, true);
  assert.equal(outcome.endReason, "exhausted");
});

test("pending death window: a failed last stand is death", () => {
  const outcome = advanceClash({
    state: clashState({ pendingDeath: true, step: 1 }),
    option: { axis: "force", approach: "resist", risk: "dire" },
    check: checkOf("failure"),
    world,
  });
  assert.equal(outcome.ended, true);
  assert.equal(outcome.endReason, "death");
});

test("pending death window: a killing counter is victory", () => {
  const outcome = advanceClash({
    state: clashState({ pendingDeath: true, step: 1, opponentCondition: 2 }),
    option: { axis: "force", approach: "resist", risk: "dire" },
    check: checkOf("success"),
    world,
  });
  assert.equal(outcome.ended, true);
  assert.equal(outcome.endReason, "victory");
});

test("pending death window: a successful plea is mercy, a run is escape", () => {
  const plea = advanceClash({
    state: clashState({ pendingDeath: true, step: 1 }),
    option: { axis: "social", approach: "cooperate", risk: "dire" },
    check: checkOf("success"),
    world,
  });
  assert.equal(plea.endReason, "mercy");
  const flee = advanceClash({
    state: clashState({ pendingDeath: true, step: 1 }),
    option: { axis: "exit", approach: "avoid", risk: "dire" },
    check: checkOf("success"),
    world,
  });
  assert.equal(flee.endReason, "escape");
});

test("entering clash already down does not kill on the opening exchange", () => {
  // 进入回合就被打空 vital：濒死窗口打开，但这一击不算最后一搏。
  const outcome = advanceClash({
    state: clashState({ pendingDeath: true, step: 0 }),
    option: { axis: "force", approach: "resist", risk: "dire" },
    check: checkOf("failure"),
    world,
  });
  assert.equal(outcome.ended, false);
  assert.equal(outcome.state.activeClash.pendingDeath, true);
});

test("markPendingDeath only fires inside a clash when a vital hits zero", () => {
  const down = markPendingDeath(clashState(), world);
  assert.equal(down.activeClash.pendingDeath, false);
  const hurt = clashState();
  hurt.stats.breath = 0;
  const flagged = markPendingDeath(hurt, world);
  assert.equal(flagged.activeClash.pendingDeath, true);
  const outside = { ...structuredClone(migratedInitial), stats: { ...migratedInitial.stats, breath: 0 } };
  const untouched = markPendingDeath(outside, world);
  assert.equal(untouched.activeClash, null);
});

test("validateClashStart only accepts live, known opponents", () => {
  // 本地世界：林雾与玩家同地，阎策在别处。
  const localWorld = normalizeWorld(structuredClone(baseWorld));
  const lin = localWorld.characters.find((character) => character.id === "lin");
  const warden = localWorld.characters.find((character) => character.id === "warden");
  lin.locationIds = [migratedInitial.locationId];
  warden.locationIds = ["somewhere-else"];

  const proposal = { opponentId: "lin", reason: "起了杀心" };
  const here = { ...migratedInitial, discoveredCharacterIds: ["lin"] };
  assert.equal(validateClashStart(here, proposal, localWorld), true);
  // 未发现且不在身边：拒绝。
  const unseen = { ...migratedInitial, discoveredCharacterIds: [] };
  assert.equal(validateClashStart(unseen, { opponentId: "warden", reason: "偷袭" }, localWorld), false);
  // 已死：拒绝。
  const dead = { ...here, entityStates: { lin: { status: "dead" } } };
  assert.equal(validateClashStart(dead, proposal, localWorld), false);
  // 已经在交锋中：拒绝。
  const already = clashState();
  assert.equal(validateClashStart(already, proposal, localWorld), false);
  // 坏结构：拒绝。
  assert.equal(validateClashStart(here, { reason: "no id" }, localWorld), false);
  assert.equal(validateClashStart(here, null, localWorld), false);
});

test("stanceLabel renders hidden numbers as words", () => {
  assert.equal(stanceLabel(2), "上风");
  assert.equal(stanceLabel(0), "均势");
  assert.equal(stanceLabel(-1), "下风");
});

// —— 引擎集成 ——

const direFight = {
  id: "fight-lin",
  text: "扑上去和对方搏命",
  axis: "force",
  approach: "resist",
  risk: "dire",
  attribute: "resolve",
  target: { type: "character", id: "lin" },
  timeCost: 5,
};

function mockResponse(extra = {}, delta = {}) {
  return {
    narrative: "一步踏出。",
    delta,
    statePatch: {},
    options: [
      { id: "o1", text: "进攻", axis: "force", approach: "resist", risk: "risky", attribute: "resolve", target: { type: "character", id: "lin" }, timeCost: 5 },
      { id: "o2", text: "退开", axis: "exit", approach: "avoid", risk: "safe", attribute: "agility", timeCost: 5 },
      { id: "o3", text: "观察", axis: "investigate", approach: "resist", risk: "safe", attribute: "resolve", timeCost: 5 },
    ],
    openThreads: [],
    retrievalKeywords: [],
    ...extra,
  };
}

test("a dire force option opens an active clash", async () => {
  const llm = dualLlm({ structure: () => mockResponse() });
  const engine = new StoryEngine({ world, initialState: knownInitial, llm, seed: 7 });
  await engine.play(direFight);
  const clash = engine.store.current.activeClash;
  assert.ok(clash);
  assert.equal(clash.opponentName, "林雾");
  assert.equal(clash.origin, "player");
  assert.equal(clash.pendingDeath, false);
});

test("a safe force option stays a one-shot exchange", async () => {
  const llm = dualLlm({ structure: () => mockResponse() });
  const engine = new StoryEngine({ world, initialState: knownInitial, llm, seed: 7 });
  await engine.play({ ...direFight, risk: "safe" });
  assert.equal(engine.store.current.activeClash, null);
});

test("an AI-proposed clashStart opens a passive clash after validation", async () => {
  const llm = dualLlm({
    structure: () => mockResponse({ clashStart: { opponentId: "lin", reason: "他先动了手" } }),
  });
  const engine = new StoryEngine({ world, initialState: knownInitial, llm, seed: 7 });
  await engine.play(startingOption);
  const clash = engine.store.current.activeClash;
  assert.ok(clash);
  assert.equal(clash.origin, "opponent");
  assert.equal(clash.reason, "他先动了手");
});

test("a clashStart targeting the unknown is rejected", async () => {
  // 阎策不在玩家身边，且玩家没发现 ta：掀桌提议应被引擎拒绝。
  const localWorld = normalizeWorld(structuredClone(baseWorld));
  localWorld.characters.find((character) => character.id === "warden").locationIds = ["somewhere-else"];
  const llm = dualLlm({
    structure: () => mockResponse({ clashStart: { opponentId: "warden", reason: "偷袭" } }),
  });
  const engine = new StoryEngine({ world: localWorld, initialState: knownInitial, llm, seed: 7 });
  await engine.play(startingOption);
  assert.equal(engine.store.current.activeClash, null);
});

test("zeroed vital inside a clash opens the pending-death window instead of killing", async () => {
  let turnNumber = 0;
  const llm = dualLlm({
    structure: () => {
      turnNumber += 1;
      // 交锋第一回合就把余息打空。
      return mockResponse({}, turnNumber === 1 ? { breath: -10 } : {});
    },
  });
  const engine = new StoryEngine({ world, initialState: knownInitial, llm, seed: 7 });
  await engine.play(direFight);
  const clash = engine.store.current.activeClash;
  assert.ok(clash);
  assert.equal(clash.pendingDeath, true);
  assert.equal(engine.history.at(-1).death.dead, false);
});

test("a failed last stand inside the death window is a real death", async () => {
  let turnNumber = 0;
  const llm = dualLlm({
    structure: () => {
      turnNumber += 1;
      return mockResponse({}, turnNumber === 1 ? { breath: -10 } : {});
    },
  });
  const engine = new StoryEngine({ world, initialState: knownInitial, llm, seed: 7 });
  await engine.play(direFight);
  const lastStand = {
    id: "last-stand",
    text: "垂死反扑",
    axis: "force",
    approach: "resist",
    risk: "dire",
    attribute: "resolve",
    target: { type: "character", id: "lin" },
    timeCost: 5,
  };
  const turn = await engine.play(lastStand);
  const failed = turn.check.result === "failure" || turn.check.result === "critical_failure";
  assert.equal(turn.death.dead, failed);
  if (failed) {
    assert.match(turn.death.cause, /林雾/);
    assert.equal(engine.store.current.activeClash, null);
  }
});

// 回归：进入交锋的同一回合 vital 被打空时，宽限回合必须消耗掉 step，
// 否则 step 永远停在 0，交锋不死不胜、永不收束。
test("a first-turn knockout consumes the grace step, the next roll always resolves", () => {
  const knocked = markPendingDeath(
    { ...clashState(), stats: { ...knownInitial.stats, breath: 0 } },
    world,
  );
  assert.equal(knocked.activeClash.pendingDeath, true);
  assert.equal(knocked.activeClash.step, 0);

  const force = { axis: "force", approach: "resist" };
  // 宽限回合：不判生死，但 step 必须前进。
  const grace = advanceClash({ state: knocked, option: force, check: checkOf("failure"), world });
  assert.equal(grace.ended, false);
  assert.equal(grace.state.activeClash.step, 1);

  // 下一回合：失败必死，成功必收束——两条路都要通。
  const death = advanceClash({ state: grace.state, option: force, check: checkOf("failure"), world });
  assert.equal(death.ended, true);
  assert.equal(death.endReason, "death");
  assert.equal(death.state.activeClash, null);

  const survived = advanceClash({ state: grace.state, option: force, check: checkOf("success"), world });
  assert.equal(survived.ended, true);
  assert.notEqual(survived.endReason, "death");
  assert.equal(survived.state.activeClash, null);
});

test("victory ends the clash and clears activeClash", async () => {
  const llm = dualLlm({ structure: () => mockResponse() });
  const engine = new StoryEngine({ world, initialState: knownInitial, llm, seed: 1 });
  // 预置一个快赢的交锋：对手只剩一击。
  engine.store.snapshots[0] = clashState({ opponentCondition: 2 });
  const turn = await engine.play({ ...direFight, risk: "risky" });
  const won = turn.check.result === "success" || turn.check.result === "critical_success";
  assert.equal(engine.store.current.activeClash === null, won);
  if (won) assert.equal(turn.clash.endReason, "victory");
});

test("clash state survives serialize and restore", () => {
  const llm = dualLlm({ structure: () => mockResponse() });
  const engine = new StoryEngine({ world, initialState: knownInitial, llm, seed: 7 });
  engine.store.snapshots[0] = clashState({ stance: 1, opponentCondition: 1, step: 2 });
  const saved = serializeEngine(engine, { bookId: "clash-book", storyId: "s1" });
  const restored = new StoryEngine({ world, initialState: knownInitial, llm, seed: 7 });
  restoreEngine(restored, saved);
  const clash = restored.store.current.activeClash;
  assert.ok(clash);
  assert.equal(clash.opponentName, "林雾");
  assert.equal(clash.stance, 1);
  assert.equal(clash.opponentCondition, 1);
  assert.equal(clash.step, 2);
});

test("legacy saves without activeClash migrate to null", () => {
  const legacy = migrateState(structuredClone(initialState), world);
  assert.equal(legacy.activeClash, null);
});

test("clash rounds get a fast short narrative length", () => {
  const context = {
    state: { activeClash: { pendingDeath: false } },
    activeClash: { pendingDeath: false, stance: "均势" },
  };
  const messages = buildNarrativeMessages({ context, choice: { text: "进攻" }, check: { result: "success" } });
  assert.match(messages[1].content, /交锋回合，300-500 字/);
  const dying = buildNarrativeMessages({
    context: { state: {}, activeClash: { pendingDeath: true } },
    choice: { text: "垂死反扑" },
    check: { result: "failure" },
  });
  assert.match(dying[1].content, /濒死回合/);
});

test("markPendingDeath:濒死窗口可逆,治疗拉回 vital 即解除", () => {
  // 进入濒死:breath 归零。
  let state = clashState({ pendingDeath: false });
  state.stats = { ...state.stats, breath: 0 };
  state = markPendingDeath(state, world);
  assert.equal(state.activeClash.pendingDeath, true, "vital 归零进入濒死窗口");

  // 模型写了治疗 delta(喝药/救援):vital 回到下限之上,标记必须解除——
  // 否则 UI 恒显「命悬一线」,机制上永远一步之遥死亡,与真实伤势脱节。
  state = markPendingDeath(
    { ...state, stats: { ...state.stats, breath: 5 } },
    world,
  );
  assert.equal(state.activeClash.pendingDeath, false, "vital 回升后濒死解除");

  // 再次归零可重新进入窗口。
  state = markPendingDeath({ ...state, stats: { ...state.stats, breath: 0 } }, world);
  assert.equal(state.activeClash.pendingDeath, true);
});

test("advanceClash 的 endReason 文档包含 escape(濒死搏回一命脱身)", () => {
  let state = clashState({ pendingDeath: true, step: 1 });
  state.stats = { ...state.stats, breath: 0 };
  const outcome = advanceClash({
    state,
    option: { axis: "exit", approach: "avoid" },
    check: checkOf("success"),
    world,
  });
  assert.equal(outcome.ended, true);
  assert.equal(outcome.endReason, "escape", "非 force 的成功一搏=搏回一命脱身");
});
