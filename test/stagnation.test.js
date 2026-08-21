import test from "node:test";
import assert from "node:assert/strict";

import { world as baseWorld, initialState, startingOption } from "../fixtures/world.js";
import { StoryEngine, buildContext } from "../src/engine.js";
import { normalizeWorld, migrateState } from "../src/evolution.js";
import { dualLlm } from "./helpers/llm.js";

const world = normalizeWorld(structuredClone(baseWorld));
const migratedInitial = migrateState(structuredClone(initialState), world);

function mockResponse(extra = {}) {
  return {
    narrative: "一步踏出。",
    delta: {},
    statePatch: {},
    options: [
      { id: "o1", text: "观察", axis: "investigate", approach: "resist", risk: "safe", attribute: "resolve", timeCost: 30 },
      { id: "o2", text: "退开", axis: "exit", approach: "avoid", risk: "safe", attribute: "agility", timeCost: 30 },
      { id: "o3", text: "搭话", axis: "social", approach: "persuade", risk: "safe", attribute: "resolve", timeCost: 30 },
    ],
    openThreads: [],
    retrievalKeywords: [],
    ...extra,
  };
}

// 预设选项已取消(拍板):普通回合选项由玩家意图动态产生;测试里「再走一步」
// 直接用合法的手写选项,不依赖回合返回的 options。
const nextStep = (id = "next") => ({
  id,
  text: "继续观察眼前局势",
  axis: "investigate",
  approach: "resist",
  risk: "safe",
  attribute: "resolve",
  timeCost: 30,
});

test("static turns accumulate when nothing changes", async () => {
  const llm = dualLlm({ structure: () => mockResponse() });
  const engine = new StoryEngine({ world, initialState: migratedInitial, llm, seed: 7 });
  await engine.play(startingOption);
  assert.equal(engine.store.current.consecutiveStaticTurns, 1);
  await engine.play(nextStep());
  assert.equal(engine.store.current.consecutiveStaticTurns, 2);
});

test("any delta resets the counter", async () => {
  const llm = dualLlm({ structure: () => mockResponse({ delta: { clue: 1 } }) });
  const engine = new StoryEngine({ world, initialState: migratedInitial, llm, seed: 7 });
  await engine.play(startingOption);
  assert.equal(engine.store.current.consecutiveStaticTurns, 0);
});

test("a location patch resets the counter", async () => {
  const target = world.locations[1].id;
  const llm = dualLlm({ structure: () => mockResponse({ statePatch: { locationId: target } }) });
  const engine = new StoryEngine({ world, initialState: migratedInitial, llm, seed: 7 });
  await engine.play(startingOption);
  assert.equal(engine.store.current.consecutiveStaticTurns, 0);
});

test("a new open thread resets the counter", async () => {
  const llm = dualLlm({ structure: () => mockResponse({ openThreads: ["新伏笔"] }) });
  const engine = new StoryEngine({ world, initialState: migratedInitial, llm, seed: 7 });
  await engine.play(startingOption);
  assert.equal(engine.store.current.consecutiveStaticTurns, 0);
});

// 玩家成长三补丁(拍板 2026-08-19):得宝/习得/突破都是实质变化,
// 不该被僵局检测记成原地打转。
test("an inventory change resets the counter", async () => {
  const llm = dualLlm({
    structure: () =>
      mockResponse({ inventoryPatch: { changes: [{ action: "gain", name: "拾得的旧剑" }] } }),
  });
  const engine = new StoryEngine({ world, initialState: migratedInitial, llm, seed: 7 });
  await engine.play(startingOption);
  assert.equal(engine.store.current.consecutiveStaticTurns, 0);
});

test("a learned ability resets the counter", async () => {
  const llm = dualLlm({
    structure: () => mockResponse({ learnedAbilities: ["学会了看星辨向"] }),
  });
  const engine = new StoryEngine({ world, initialState: migratedInitial, llm, seed: 7 });
  await engine.play(startingOption);
  assert.equal(engine.store.current.consecutiveStaticTurns, 0);
});

test("a realm breakthrough resets the counter", async () => {
  const traits = [{ id: "t-lianqi", name: "练气期", value: "第一阶" }];
  const realmWorld = normalizeWorld({
    ...structuredClone(baseWorld),
    traits,
    timeline: [],
  });
  const llm = dualLlm({
    structure: () => mockResponse({ realmBreakthrough: { toTraitId: "t-lianqi" } }),
  });
  const engine = new StoryEngine({
    world: realmWorld,
    initialState: migrateState(structuredClone(initialState), realmWorld),
    llm,
    seed: 7,
  });
  await engine.play(startingOption);
  assert.equal(engine.store.current.consecutiveStaticTurns, 0);
});

test("a relationship change resets the counter", async () => {
  const llm = dualLlm({
    structure: () =>
      mockResponse({
        evolutionPatch: {
          relationships: [
            { targetType: "character", targetId: "lin", trust: 1 },
          ],
        },
      }),
  });
  const engine = new StoryEngine({ world, initialState: migratedInitial, llm, seed: 7 });
  await engine.play(startingOption);
  assert.equal(engine.store.current.consecutiveStaticTurns, 0);
});

test("two static turns inject a stagnation warning into the context", async () => {
  const llm = dualLlm({ structure: () => mockResponse() });
  const engine = new StoryEngine({ world, initialState: migratedInitial, llm, seed: 7 });
  await engine.play(startingOption);
  await engine.play(nextStep("next-1"));
  // 下一个回合的上下文应该带僵局警告。
  const turn = await engine.play(nextStep("next-2"));
  assert.ok(turn.context.stagnationWarning);
  assert.match(turn.context.stagnationWarning, /连续 \d+ 个回合没有实质进展/);
  assert.ok(turn.context.recentChoices.length >= 2);
  assert.ok(turn.context.recentChoices.every((item) => item.choice && item.result));
});

test("the first static turn carries no warning", async () => {
  const llm = dualLlm({ structure: () => mockResponse() });
  const engine = new StoryEngine({ world, initialState: migratedInitial, llm, seed: 7 });
  const turn = await engine.play(startingOption);
  assert.equal(turn.context.stagnationWarning, null);
});

test("legacy saves without the counter migrate to zero", () => {
  const legacy = migrateState(structuredClone(initialState), world);
  assert.equal(legacy.consecutiveStaticTurns, 0);
});

test("buildContext exposes recent choices with results", () => {
  const engine = new StoryEngine({
    world,
    initialState: migratedInitial,
    llm: { async generateStructure() { return mockResponse(); } },
    seed: 7,
  });
  engine.history = [
    { number: 1, narrative: "x", choice: { text: "a" }, check: { result: "success" }, openThreads: [] },
    { number: 2, narrative: "y", choice: { text: "b" }, check: { result: "failure" }, openThreads: [] },
  ];
  const context = buildContext({
    world,
    state: { ...migratedInitial, consecutiveStaticTurns: 3 },
    history: engine.history,
    dueEvents: [],
  });
  assert.deepEqual(context.recentChoices, [
    { number: 1, choice: "a", result: "success" },
    { number: 2, choice: "b", result: "failure" },
  ]);
  assert.match(context.stagnationWarning, /连续 3 个回合/);
});
