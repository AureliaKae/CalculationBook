import assert from "node:assert/strict";
import test from "node:test";

import { normalizeWorld, optionIsAvailable } from "../src/evolution.js";
import {
  applyDivergence,
  divergenceTargetGate,
  divergenceWorldFacts,
  effectiveFacts,
  divergenceThreshold,
  fateTierOf,
  DIVERGENCE_TIERS,
  DIVERGENCE_THRESHOLD,
} from "../src/gameplay-systems.js";
import { actionModifiers, dueTimelineEvents } from "../src/engine.js";

const world = normalizeWorld({
  id: "world",
  title: "书",
  characters: [{ id: "guide", name: "引路人", locationIds: ["gate"], firstChapter: 2 }],
  locations: ["gate", "tower"],
  factions: [{ id: "guild", name: "公会" }],
  roleTemplates: [{ id: "scout", name: "斥候", locationIds: ["gate"], factionIds: ["guild"] }],
  attributes: [{ id: "focus", name: "专注", initial: 20 }],
  stats: [{ id: "life", name: "生命", role: "vital", min: 0, max: 10, initial: 10 }],
  timeline: [{ id: "event-1", time: 60, text: "引路人将在第3章死去", chapterAnchor: 3, locationId: "gate", resolution: "never", resolutionTargetIds: [] }],
  facts: [
    { id: "f1", chapterAnchor: 1, text: "引路人是上一任守门人。" },
    { id: "f2", chapterAnchor: 5, text: "引路人最终叛逃。" },
  ],
});

function baseState(overrides = {}) {
  return {
    turn: 3,
    unlockedChapter: 3,
    locationId: "gate",
    player: { id: "player", lifeIndex: 1, roleId: "scout" },
    attributes: { focus: 20 },
    stats: { life: 10 },
    traits: [],
    relationships: {},
    entityStates: { guide: { status: "active", factionId: null, locationId: "gate" } },
    discoveredCharacterIds: ["guide"],
    factionMemberships: [],
    survivalPressures: [],
    pendingDivergences: [],
    completedDivergences: [],
    resources: {},
    ...overrides,
  };
}

test("seeding accumulates momentum on success and resets on failure", () => {
  const seeded = applyDivergence(baseState(), world, {
    option: { divergence: { targetId: "event-1", targetType: "timeline" } },
    check: { result: "success" },
  });
  assert.equal(seeded.state.pendingDivergences[0].momentum, 1);
  assert.equal(seeded.result.stage, "seeded");

  const failed = applyDivergence(seeded.state, world, {
    option: { divergence: { targetId: "event-1", targetType: "timeline" } },
    check: { result: "failure" },
  });
  assert.equal(failed.state.pendingDivergences[0].momentum, 0);
});

test("firing below threshold is gated by optionIsAvailable", () => {
  const state = baseState();
  const fire = { divergence: { targetId: "event-1", targetType: "timeline", fire: true } };
  assert.equal(optionIsAvailable(fire, state, world), false);

  // 攒够势能后 fire 可用。
  state.pendingDivergences = [
    { id: "d", targetId: "event-1", targetType: "timeline", momentum: DIVERGENCE_THRESHOLD },
  ];
  assert.equal(optionIsAvailable(fire, state, world), true);
});

test("firing a resolved divergence writes an override fact", () => {
  const state = baseState({
    pendingDivergences: [
      { id: "d", targetId: "event-1", targetType: "timeline", momentum: DIVERGENCE_THRESHOLD },
    ],
  });
  const result = applyDivergence(state, world, {
    option: { divergence: { targetId: "event-1", targetType: "timeline", fire: true } },
    check: { result: "critical_success" },
    divergencePatch: { override: { text: "引路人没有死，他留在了门口。" }, evidence: "主角提前示警" },
  });
  assert.equal(result.result.stage, "resolved");
  assert.equal(result.state.completedDivergences.length, 1);
  assert.equal(result.state.completedDivergences[0].overrides[0].text, "引路人没有死，他留在了门口。");
  assert.equal(result.state.pendingDivergences.length, 0);
});

test("firing a failed divergence triggers backlash", () => {
  const state = baseState({
    pendingDivergences: [
      { id: "d", targetId: "event-1", targetType: "timeline", momentum: DIVERGENCE_THRESHOLD },
    ],
  });
  const result = applyDivergence(state, world, {
    option: { divergence: { targetId: "event-1", targetType: "timeline", fire: true } },
    check: { result: "failure" },
  });
  assert.equal(result.result.stage, "backlash");
  assert.ok(result.state.survivalPressures.some((p) => p.id.startsWith("divergence-backlash")));
  assert.equal(result.state.pendingDivergences.length, 0);
});

test("entity divergence requires discovery and survival", () => {
  const state = baseState();
  const option = { divergence: { targetId: "guide", targetType: "entity" } };
  assert.equal(optionIsAvailable(option, state, world), true);
  state.entityStates.guide.status = "dead";
  assert.equal(optionIsAvailable(option, state, world), false);
});

test("timeline/fact divergence no longer gated by chapter anchor", () => {
  // 拍板 2026-08-17：玩家已读完小说，未解锁章节一律不过滤——
  // 章节锚点不再是改命门槛，事件状态与人物前提照旧校验。
  const state = baseState({ unlockedChapter: 1 });
  const futureTimeline = { divergence: { targetId: "event-1", targetType: "timeline" } };
  assert.equal(optionIsAvailable(futureTimeline, state, world), true, "未解锁章节的事件也可改命");
  const futureFact = { divergence: { targetId: "f2", targetType: "fact" } };
  assert.equal(optionIsAvailable(futureFact, state, world), true, "未解锁章节的事实也可改命");
});

test("divergenceWorldFacts flattens completed overrides with source marker", () => {
  const state = baseState({
    completedDivergences: [
      {
        id: "d1",
        targetId: "f2",
        targetType: "fact",
        source: "player_divergence",
        lifeIndex: 1,
        resolvedTurn: 5,
        overrides: [{ id: "o1", overridesId: "f2", targetType: "fact", text: "引路人没有叛逃。", chapterAnchor: 5 }],
      },
    ],
  });
  const facts = divergenceWorldFacts(state);
  assert.equal(facts.length, 1);
  assert.equal(facts[0].source, "player_divergence");
  assert.equal(facts[0].lifeIndex, 1);
});

test("effectiveFacts overlays diverged facts without mutating the original", () => {
  const state = baseState({
    completedDivergences: [
      {
        id: "d1",
        targetId: "f2",
        targetType: "fact",
        source: "player_divergence",
        lifeIndex: 1,
        resolvedTurn: 5,
        overrides: [{ id: "o1", overridesId: "f2", targetType: "fact", text: "引路人没有叛逃。", chapterAnchor: 5 }],
      },
    ],
  });
  const effective = effectiveFacts(world, state);
  const f1 = effective.find((f) => f.id === "f1");
  const f2 = effective.find((f) => f.id === "f2");
  assert.equal(f1.overridden, undefined);
  assert.equal(f2.text, "引路人没有叛逃。");
  assert.equal(f2.overridden, true);
  // 原著 facts 未被原地修改。
  assert.equal(world.facts.find((f) => f.id === "f2").text, "引路人最终叛逃。");
});

test("faction authority and resources add to check modifiers", () => {
  const state = baseState({
    factionMemberships: [{ id: "m", factionId: "guild", authority: ["command"] }],
    resources: { gold: 20 },
  });
  const modifiers = actionModifiers(
    { axis: "social", risk: "safe", requirements: { factionId: "guild", resourceId: "gold" } },
    state,
  );
  assert.equal(modifiers.faction, 8);
  assert.equal(modifiers.resource, 8);
  assert.ok(modifiers.total > 0);
});

// —— 命运锚点分级(2026-08-17):core/side/local 三级势能阈值 ——

function tieredWorld() {
  return normalizeWorld({
    id: "tiered",
    title: "书",
    characters: [{ id: "guide", name: "引路人", locationIds: ["gate"], firstChapter: 1 }],
    locations: ["gate", "tower"],
    factions: [],
    roleTemplates: [{ id: "scout", name: "斥候", locationIds: ["gate"] }],
    attributes: [{ id: "focus", name: "专注", initial: 20 }],
    stats: [{ id: "life", name: "生命", role: "vital", min: 0, max: 10, initial: 10 }],
    timeline: [
      { id: "core-1", time: 100, text: "主线大战", chapterAnchor: 1, locationId: "gate", resolution: "never", resolutionTargetIds: [], tier: "core" },
      { id: "side-1", time: 200, text: "支线变故", chapterAnchor: 2, locationId: "gate", resolution: "never", resolutionTargetIds: [], tier: "side" },
      { id: "local-1", time: 300, text: "地方小事", chapterAnchor: 3, locationId: "gate", resolution: "never", resolutionTargetIds: [], tier: "local" },
      { id: "legacy-1", time: 400, text: "无层级旧事件", chapterAnchor: 4, locationId: "gate", resolution: "never", resolutionTargetIds: [] },
    ],
    facts: [],
  });
}

test("divergenceThreshold resolves per-tier values and falls back to side", () => {
  const world = tieredWorld();
  assert.equal(divergenceThreshold(world, "timeline", "core-1"), DIVERGENCE_TIERS.core);
  assert.equal(divergenceThreshold(world, "timeline", "side-1"), DIVERGENCE_TIERS.side);
  assert.equal(divergenceThreshold(world, "timeline", "local-1"), DIVERGENCE_TIERS.local);
  // 旧书无 tier 一律回落 side(原统一阈值),与 DIVERGENCE_THRESHOLD 一致。
  assert.equal(divergenceThreshold(world, "timeline", "legacy-1"), DIVERGENCE_THRESHOLD);
  assert.equal(divergenceThreshold(world, "timeline", "legacy-1"), DIVERGENCE_TIERS.side);
  // fact/entity 目标默认 side 阈值。
  assert.equal(divergenceThreshold(world, "fact", "f1"), DIVERGENCE_TIERS.side);
  assert.equal(divergenceThreshold(world, "entity", "guide"), DIVERGENCE_TIERS.side);
});

test("fateTierOf:火候按势能比值分三档,临门与反弹都归位", () => {
  // 半成以下:暗流初起。
  assert.equal(fateTierOf(0, 4), 1);
  assert.equal(fateTierOf(1, 4), 1);
  // 半成到临门前:履薄蓄势。
  assert.equal(fateTierOf(2, 4), 2);
  assert.equal(fateTierOf(3, 4), 2);
  // 达到阈值:命运松动(与 divergenceApproach 同拍)。
  assert.equal(fateTierOf(4, 4), 3);
  assert.equal(fateTierOf(9, 4), 3);
  // 天命反弹势能归零:自然跌回第一档。
  assert.equal(fateTierOf(0, 4), 1);
  // 阈值缺省/非法按 1 兜底。
  assert.equal(fateTierOf(1, null), 3);
  assert.equal(fateTierOf(null, 4), 1);
});

test("fire gate respects each target's tier threshold", () => {
  const world = tieredWorld();
  const fireFor = (targetId, momentum) =>
    optionIsAvailable(
      { divergence: { targetId, targetType: "timeline", fire: true } },
      {
        ...baseState({ unlockedChapter: 4 }),
        pendingDivergences: [
          { id: "d", targetId, targetType: "timeline", momentum },
        ],
      },
      world,
    );
  assert.equal(fireFor("core-1", 3), false, "core 阈值 4:势能 3 不可发动");
  assert.equal(fireFor("core-1", 4), true);
  assert.equal(fireFor("side-1", 1), false, "side 阈值 2:势能 1 不可发动");
  assert.equal(fireFor("side-1", 2), true);
  assert.equal(fireFor("local-1", 1), true, "local 阈值 1:一次成功铺垫即可发动");
  assert.equal(fireFor("legacy-1", 1), false, "无 tier 回落 side:势能 1 不可发动");
  assert.equal(fireFor("legacy-1", 2), true);
});

test("already resolved or invalidated fate events are no longer divergent targets", () => {
  const world = tieredWorld();
  const state = baseState({ unlockedChapter: 4 });
  const fire = { divergence: { targetId: "side-1", targetType: "timeline", fire: false } };
  assert.equal(optionIsAvailable(fire, state, world), true);
  for (const status of ["resolved", "invalidated"]) {
    const settled = { ...state, eventStates: { "side-1": { status } } };
    assert.equal(
      optionIsAvailable(fire, settled, world),
      false,
      `${status} 的旧命运不可再改`,
    );
  }
});

test("firing a timeline divergence invalidates the event and stalls downstream", () => {
  const world = tieredWorld();
  // 支线变故声明了事实变化,下游事件以它为前置。
  world.timeline[1] = {
    ...world.timeline[1],
    factsToAdd: [{ id: "side-happened", text: "支线变故已发生", chapterAnchor: 2 }],
  };
  world.timeline.push({
    id: "down-1",
    time: 250,
    text: "下游复仇",
    chapterAnchor: 5,
    locationId: "gate",
    resolution: "world_time",
    resolutionTargetIds: [],
    prerequisites: ["side-1"],
    invalidatedBy: [],
  });
  const state = baseState({
    unlockedChapter: 5,
    worldTime: 500,
    pendingDivergences: [
      { id: "d", targetId: "side-1", targetType: "timeline", momentum: 2 },
    ],
  });
  const result = applyDivergence(state, world, {
    option: { divergence: { targetId: "side-1", targetType: "timeline", fire: true } },
    check: { result: "success" },
    divergencePatch: { override: { text: "支线变故被改写。" }, evidence: "提前示警" },
  });
  assert.equal(result.result.stage, "resolved");
  assert.equal(result.state.eventStates["side-1"].status, "invalidated");
  assert.equal(result.state.eventStates["side-1"].diverged, true);
  // 被改事件自身的事实变化不再生效:effectiveFacts 只结算 delivered/resolved。
  const facts = effectiveFacts(world, result.state);
  assert.equal(facts.some((fact) => fact.id === "side-happened"), false);
  // 下游事件以被改事件为前置:前置永不 resolved,下游自然停摆、永不到期。
  const due = dueTimelineEvents(world, result.state);
  assert.equal(due.some((event) => event.id === "down-1"), false);
  assert.equal(due.some((event) => event.id === "side-1"), false);
});

test("entity divergence does not touch eventStates", () => {
  const world = tieredWorld();
  const state = baseState({
    pendingDivergences: [
      { id: "d", targetId: "guide", targetType: "entity", momentum: 2 },
    ],
  });
  const result = applyDivergence(state, world, {
    option: { divergence: { targetId: "guide", targetType: "entity", fire: true } },
    check: { result: "success" },
    divergencePatch: { override: { text: "引路人没有叛逃。" }, evidence: "坦诚相待" },
  });
  assert.equal(result.result.stage, "resolved");
  assert.equal(result.state.eventStates, undefined, "entity 目标不写 eventStates");
});

// —— 改命硬门槛统一(拍板 2026-08-17):选项与结构补丁走同一道门 ——

test("divergenceTargetGate:目标存在、已定不可改、火候分级三重把关", () => {
  const gateWorld = tieredWorld();
  const state = baseState({ unlockedChapter: 4 });
  // 目标不存在。
  assert.equal(
    divergenceTargetGate(gateWorld, state, { targetId: "nope", targetType: "timeline", fire: false }).reason,
    "missing_target",
  );
  // 已 resolved/invalidated 的旧命运不再是可改目标。
  for (const status of ["resolved", "invalidated"]) {
    const settled = { ...state, eventStates: { "side-1": { status } } };
    assert.equal(
      divergenceTargetGate(gateWorld, settled, { targetId: "side-1", targetType: "timeline", fire: false }).reason,
      "settled_fate",
    );
  }
  // 势能不足不可发动最终改写;攒够即放行。
  assert.equal(
    divergenceTargetGate(gateWorld, state, { targetId: "side-1", targetType: "timeline", fire: true }).reason,
    "not_ready",
  );
  const ready = {
    ...state,
    pendingDivergences: [{ id: "d", targetId: "side-1", targetType: "timeline", momentum: 2 }],
  };
  assert.equal(
    divergenceTargetGate(gateWorld, ready, { targetId: "side-1", targetType: "timeline", fire: true }).ok,
    true,
  );
});

test("选项未声明改命时,结构补丁不能自起炉灶改命运", () => {
  const state = baseState({
    unlockedChapter: 4,
    pendingDivergences: [
      { id: "d", targetId: "side-1", targetType: "timeline", momentum: 2 },
    ],
  });
  const result = applyDivergence(state, tieredWorld(), {
    option: { text: "静静旁观" },
    check: { result: "critical_success" },
    divergencePatch: {
      targetId: "side-1",
      targetType: "timeline",
      fire: true,
      override: { text: "补丁自作主张改写了命运。" },
    },
  });
  assert.equal(result.result, null, "补丁路径不产生改命结果");
  assert.equal(result.state.completedDivergences.length, 0, "没有写回");
  assert.equal(result.state.eventStates?.["side-1"]?.status, undefined, "事件未被置为 invalidated");
});

test("火候不足的发动在结算口降级为铺垫:不写回、不反噬", () => {
  // 正常流程里 optionIsAvailable 会拦下火候不足的选项;这里直接打结算口,
  // 锁死「即使漏拦,applyDivergence 也不写出超出势能的改写」。
  const state = baseState({ unlockedChapter: 4 });
  const result = applyDivergence(state, tieredWorld(), {
    option: { divergence: { targetId: "core-1", targetType: "timeline", fire: true } },
    check: { result: "critical_success" },
  });
  assert.equal(result.result.stage, "seeded", "降级按铺垫结算");
  assert.equal(result.state.eventStates?.["core-1"]?.status, undefined, "未写回 invalidated");
  assert.equal(result.state.completedDivergences.length, 0);
});

test("目标已定的改命在结算口整体忽略", () => {
  const state = baseState({
    unlockedChapter: 4,
    eventStates: { "side-1": { status: "resolved" } },
    pendingDivergences: [
      { id: "d", targetId: "side-1", targetType: "timeline", momentum: 2 },
    ],
  });
  const result = applyDivergence(state, tieredWorld(), {
    option: { divergence: { targetId: "side-1", targetType: "timeline", fire: true } },
    check: { result: "critical_success" },
  });
  assert.equal(result.result, null, "已定命运不产生任何改命结果");
});

test("补丁目标与选项错配时丢弃补丁,override 用事件原文兜底", () => {
  const state = baseState({
    unlockedChapter: 4,
    pendingDivergences: [
      { id: "d", targetId: "side-1", targetType: "timeline", momentum: 2 },
    ],
  });
  const result = applyDivergence(state, tieredWorld(), {
    option: { divergence: { targetId: "side-1", targetType: "timeline", fire: true } },
    check: { result: "success" },
    divergencePatch: {
      targetId: "f1",
      targetType: "fact",
      fire: true,
      override: { text: "张冠李戴的文本。" },
    },
  });
  assert.equal(result.result.stage, "resolved");
  assert.match(result.result.overrides[0].text, /支线变故/, "兜底文本用事件原文而非错配补丁");
  assert.equal(result.result.target, "支线变故", "结果带目标称呼供界面渲染");
});

test("铺垫失败归零带天命难违信号,成功与未判定不带", () => {
  const state = baseState({
    unlockedChapter: 4,
    pendingDivergences: [
      { id: "d", targetId: "side-1", targetType: "timeline", momentum: 1 },
    ],
  });
  const failed = applyDivergence(state, tieredWorld(), {
    option: { divergence: { targetId: "side-1", targetType: "timeline" } },
    check: { result: "failure" },
  });
  assert.equal(failed.result.fateResistance, true, "失败归零时标记天命反弹");
  assert.equal(failed.result.momentum, 0);
  const succeeded = applyDivergence(state, tieredWorld(), {
    option: { divergence: { targetId: "side-1", targetType: "timeline" } },
    check: { result: "success" },
  });
  assert.equal(succeeded.result.fateResistance, undefined, "成功铺垫不算天命反弹");
});
