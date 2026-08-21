import assert from "node:assert/strict";
import test from "node:test";

import { MockLlm } from "../fixtures/mock-llm.js";
import { initialState, startingOption, world } from "../fixtures/world.js";
import {
  buildContext,
  StoryEngine,
  validateResponse,
} from "../src/engine.js";
import {
  createPlayerState,
  eligibleProgression,
  migrateState,
  normalizeWorld,
  validateRoleTransition,
} from "../src/evolution.js";
import {
  applyRoleTransition,
  buildCharacterJournal,
  createSuccessorState,
  pastLifeFact,
} from "../src/gameplay-systems.js";
import { createEntity, validateCreation } from "../src/world-creation.js";
import { diagnoseWorld } from "../src/world-repair.js";

// 带身份目录与进阶路径的测试世界：杂役弟子 → 长老（有门槛与修正），长老 → 游方郎中（无门槛）。
function transitionWorld() {
  return {
    ...structuredClone(world),
    // 夹具的 attributes/stats 没有 initial：补上才能走 createPlayerState 的初始值路径。
    attributes: [
      { id: "resolve", name: "定力", initial: 35 },
      { id: "agility", name: "身手", initial: 40 },
    ],
    stats: structuredClone(world.stats).map((stat, index) => ({
      ...stat,
      initial: [10, 12, 0, 0][index] ?? 0,
    })),
    factions: [
      { id: "sect", name: "青云宗", summary: "山门" },
      { id: "city", name: "临渊城", summary: "城中" },
    ],
    traits: [
      { id: "realm-elder", name: "境界", value: "金丹", description: "宗门中坚" },
    ],
    roleTemplates: [
      { id: "disciple", name: "杂役弟子", description: "洒扫庭院的杂役", locationIds: [], factionIds: ["sect"], abilities: ["能洒扫庭院、跑腿传信"] },
      {
        id: "elder",
        name: "长老",
        description: "执掌一堂的长老",
        locationIds: [],
        factionIds: ["sect"],
        abilities: ["能调阅宗门卷宗", "可调度一堂弟子"],
        traitIds: ["realm-elder"],
        authority: ["inspect", "command"],
      },
      { id: "vagrant", name: "游方郎中", description: "走街串巷的郎中", locationIds: [], factionIds: [] },
    ],
    roleProgression: [
      {
        id: "p1",
        fromRoleId: "disciple",
        toRoleId: "elder",
        triggerEvents: [{ id: "t1", name: "大比夺魁", description: "宗门大比夺魁，破格擢升" }],
        prerequisites: {
          statMinimums: { clue: 3 },
          attributeMinimums: { resolve: 30 },
          factionIds: ["sect"],
        },
        modifiers: [
          { attributeId: "resolve", delta: 5 },
          { attributeId: "agility", delta: -2 },
        ],
        refusalModifiers: [{ attributeId: "resolve", delta: -3 }],
      },
      {
        id: "p2",
        fromRoleId: "elder",
        toRoleId: "vagrant",
        triggerEvents: [{ id: "t2", name: "山门倾覆", description: "山门倾覆，流落江湖" }],
        modifiers: [],
      },
    ],
  };
}

function playerState(worldInput) {
  const base = createPlayerState(worldInput, {
    name: "沈砚",
    roleId: "disciple",
    locationId: "旧码头",
    motivation: "活下去",
  });
  // 开局不再自动建势力(拍板):路径前置的 factionIds 前提按「已入宗」场景手工补齐出身与成员记录。
  base.player.factionId = "sect";
  return {
    ...base,
    stats: { ...base.stats, clue: 3 },
    factionMemberships: [
      { id: "membership:sect", factionId: "sect", authority: [], duties: [], overdueDutyIds: [] },
    ],
  };
}

// 指定回合输出 roleTransition 声明的适配器：其余回合走 MockLlm 的常规结构。
function transitionLlm({ atTurn, declaration }) {
  return {
    async generateStory(args) {
      return new MockLlm().generateStory(args);
    },
    async generateStructure(args) {
      const structure = await new MockLlm().generateStructure(args);
      if (args.context.state.turn === atTurn) structure.roleTransition = declaration;
      return structure;
    },
  };
}

test("normalizeWorld 归一化进阶路径并容忍旧书缺失", () => {
  const normalized = normalizeWorld(transitionWorld());
  assert.equal(normalized.roleProgression.length, 2);
  assert.equal(normalized.roleProgression[0].fromRoleId, "disciple");
  assert.deepEqual(normalized.roleProgression[0].prerequisites.factionIds, ["sect"]);
  // 旧书没有 roleProgression：视为空数组，合法。
  assert.deepEqual(normalizeWorld(world).roleProgression, []);
});

test("诊断器硬校验进阶路径：引用、自环、触发事件与修正幅度", () => {
  const ok = diagnoseWorld(transitionWorld());
  assert.ok(!ok.errors.some((item) => item.path.startsWith("roleProgression")), JSON.stringify(ok.errors));

  const bad = structuredClone(transitionWorld());
  bad.roleProgression = [
    { id: "x1", fromRoleId: "disciple", toRoleId: "disciple", triggerEvents: [], modifiers: [] },
    { id: "x2", fromRoleId: "ghost", toRoleId: "elder", triggerEvents: [{ id: "t", name: "n", description: "d" }], modifiers: [] },
    { id: "x3", fromRoleId: "disciple", toRoleId: "elder", triggerEvents: [{ id: "t", name: "n", description: "d" }], modifiers: [{ attributeId: "ghost", delta: 1 }] },
    { id: "x4", fromRoleId: "disciple", toRoleId: "elder", triggerEvents: [{ id: "t", name: "n", description: "d" }], modifiers: [{ attributeId: "resolve", delta: "多" }] },
    { id: "x5", fromRoleId: "disciple", toRoleId: "elder", triggerEvents: [{ id: "t", name: "n", description: "d" }], prerequisites: { statMinimums: { ghost: 1 } }, modifiers: [] },
    { id: "x6", fromRoleId: "disciple", toRoleId: "elder", triggerEvents: [{ id: "t", name: "n", description: "d" }], prerequisites: { factionIds: ["ghost"] }, modifiers: [] },
  ];
  const diagnosis = diagnoseWorld(bad);
  const codes = diagnosis.errors.map((item) => item.code);
  for (const code of ["self_loop", "unknown_reference", "invalid_number", "empty"]) {
    assert.ok(codes.includes(code), "缺少 " + code + "：" + JSON.stringify(diagnosis.errors));
  }
  // 报错只含 id，不泄目标身份名。
  const text = diagnosis.errors.map((item) => item.message).join("");
  assert.ok(!text.includes("长老"), "错误信息泄漏目标身份名");
});

test("eligibleProgression 按消耗标记、起点与前提过滤路径", () => {
  const worldInput = transitionWorld();
  const state = playerState(worldInput);
  assert.deepEqual(eligibleProgression(worldInput, state).map((item) => item.id), ["p1"]);
  // 数值门槛不足：p1 不可走。
  const poor = { ...state, stats: { ...state.stats, clue: 2 } };
  assert.deepEqual(eligibleProgression(worldInput, poor), []);
  // 属性门槛不足。
  const weak = { ...state, attributes: { ...state.attributes, resolve: 10 } };
  assert.deepEqual(eligibleProgression(worldInput, weak), []);
  // 势力前置不符。
  const homeless = { ...state, player: { ...state.player, factionId: null } };
  assert.deepEqual(eligibleProgression(worldInput, homeless), []);
  // 已消耗的路径不再出现。
  const used = { ...state, player: { ...state.player, usedProgressionIds: ["p1"] } };
  assert.deepEqual(eligibleProgression(worldInput, used), []);
});

test("validateRoleTransition 只放行此刻合法的声明", () => {
  const worldInput = transitionWorld();
  const state = playerState(worldInput);
  assert.deepEqual(
    validateRoleTransition({ roleTransition: { progressionId: "p1", triggerEventId: "t1" } }, state, worldInput),
    { progressionId: "p1", triggerEventId: "t1", toRoleId: "elder" },
  );
  // 路径不存在 / 触发事件不属于该路径 / 前提未满足 / 已拒绝：一律 null。
  assert.equal(validateRoleTransition({ roleTransition: { progressionId: "nope", triggerEventId: "t1" } }, state, worldInput), null);
  assert.equal(validateRoleTransition({ roleTransition: { progressionId: "p1", triggerEventId: "t2" } }, state, worldInput), null);
  const poor = { ...state, stats: { ...state.stats, clue: 0 } };
  assert.equal(validateRoleTransition({ roleTransition: { progressionId: "p1", triggerEventId: "t1" } }, poor, worldInput), null);
  const refused = { ...state, player: { ...state.player, refusedProgressionIds: ["p1"] } };
  assert.equal(validateRoleTransition({ roleTransition: { progressionId: "p1", triggerEventId: "t1" } }, refused, worldInput), null);
});

test("validateResponse 校验 roleTransition 的结构", () => {
  const valid = {
    narrative: "潮声逼近。",
    delta: {},
    options: [
      { id: "a", text: "观察", axis: "investigate", risk: "safe", attribute: "resolve" },
      { id: "b", text: "离开", axis: "exit", risk: "safe", attribute: "agility" },
    ],
  };
  assert.equal(
    validateResponse({ ...valid, roleTransition: { progressionId: "p1", triggerEventId: "t1" } }, world),
    true,
  );
  assert.throws(
    () => validateResponse({ ...valid, roleTransition: { progressionId: "" } }, world),
    /roleTransition/,
  );
});

test("接纳转变：换身份、履历、修正、势力与世界事实", () => {
  const worldInput = transitionWorld();
  const normalized = normalizeWorld(worldInput);
  const state = {
    ...playerState(worldInput),
    turn: 7,
    pendingRoleTransition: {
      progressionId: "p1",
      triggerEventId: "t1",
      toRoleId: "elder",
      turn: 7,
      fromRoleId: "disciple",
      fromRoleName: "杂役弟子",
    },
  };
  const next = applyRoleTransition(state, normalized, true);
  assert.equal(next.player.roleId, "elder");
  assert.equal(next.player.roleName, "长老");
  assert.equal(next.player.factionId, "sect");
  assert.deepEqual(next.player.usedProgressionIds, ["p1"]);
  assert.equal(next.pendingRoleTransition, null);
  assert.deepEqual(next.player.roleHistory.at(-1), {
    roleId: "elder",
    roleName: "长老",
    sinceTurn: 7,
    reason: "宗门大比夺魁，破格擢升",
  });
  assert.equal(next.attributes.resolve, state.attributes.resolve + 5);
  assert.equal(next.attributes.agility, state.attributes.agility - 2);
  const fact = normalized.facts.at(-1);
  assert.match(fact.text, /转为「长老」/);
  assert.equal(fact.source, "role_transition");
  // 身份变了,能力立刻跟着变:abilities/traitIds/职权同步到新身份。
  assert.deepEqual(next.player.abilities, ["能调阅宗门卷宗", "可调度一堂弟子"]);
  assert.deepEqual(next.player.traitIds, ["realm-elder"]);
  assert.deepEqual(
    next.factionMemberships.find((item) => item.factionId === "sect").authority,
    ["inspect", "command"],
  );
  // 履历进 journal。
  const journal = next.characterJournal.find((item) => item.section === "身份履历");
  assert.match(journal.text, /第7回合/);
});

test("修正幅度夹取 0..100，唯一绑定势力才自动切换", () => {
  const worldInput = transitionWorld();
  const state = {
    ...playerState(worldInput),
    attributes: { resolve: 98, agility: 1 },
    pendingRoleTransition: {
      progressionId: "p1",
      triggerEventId: "t1",
      toRoleId: "elder",
      fromRoleId: "disciple",
      fromRoleName: "杂役弟子",
    },
  };
  const next = applyRoleTransition(state, normalizeWorld(worldInput), true);
  assert.equal(next.attributes.resolve, 100);
  assert.equal(next.attributes.agility, 0);

  // 长老 → 游方郎中（无势力绑定）：势力保留，不自动切。
  const second = {
    ...state,
    player: { ...state.player, roleId: "elder", roleName: "长老", factionId: "sect" },
    pendingRoleTransition: {
      progressionId: "p2",
      triggerEventId: "t2",
      toRoleId: "vagrant",
      fromRoleId: "elder",
      fromRoleName: "长老",
    },
  };
  const after = applyRoleTransition(second, normalizeWorld(worldInput), true);
  assert.equal(after.player.roleId, "vagrant");
  assert.equal(after.player.factionId, "sect");
});

test("拒绝转变：路径永闭、付拒绝代价、留下一次性叙事钩子", () => {
  const worldInput = transitionWorld();
  const state = {
    ...playerState(worldInput),
    turn: 5,
    pendingRoleTransition: {
      progressionId: "p1",
      triggerEventId: "t1",
      toRoleId: "elder",
      fromRoleId: "disciple",
      fromRoleName: "杂役弟子",
    },
  };
  const next = applyRoleTransition(state, normalizeWorld(worldInput), false);
  assert.equal(next.player.roleId, "disciple");
  assert.deepEqual(next.player.usedProgressionIds, ["p1"]);
  assert.deepEqual(next.player.refusedProgressionIds, ["p1"]);
  assert.equal(next.attributes.resolve, state.attributes.resolve - 3);
  assert.deepEqual(next.lastRefusedTransition, {
    progressionId: "p1",
    turn: 5,
    toRoleName: "长老",
  });
  // 拒绝后路径不可再走。
  assert.deepEqual(eligibleProgression(worldInput, next), []);
});

test("engine 回合：合法声明挂起转变卡，非法声明静默丢弃", async () => {
  const worldInput = transitionWorld();
  const state = playerState(worldInput);
  const engine = new StoryEngine({
    world: worldInput,
    initialState: state,
    seed: 42,
    llm: transitionLlm({ atTurn: 1, declaration: { progressionId: "p1", triggerEventId: "t1" } }),
  });
  const turn = await engine.play(startingOption);
  assert.deepEqual(turn.roleTransition, {
    progressionId: "p1",
    triggerEventId: "t1",
    toRoleId: "elder",
    turn: 1,
    fromRoleId: "disciple",
    fromRoleName: "杂役弟子",
  });
  assert.deepEqual(engine.store.current.pendingRoleTransition, turn.roleTransition);

  // 非法声明：路径不存在 → 丢弃，回合照常，无挂起。
  const engine2 = new StoryEngine({
    world: worldInput,
    initialState: playerState(worldInput),
    seed: 42,
    llm: transitionLlm({ atTurn: 1, declaration: { progressionId: "nope", triggerEventId: "t1" } }),
  });
  const dropped = await engine2.play(startingOption);
  assert.equal(dropped.roleTransition, null);
  assert.equal(engine2.store.current.pendingRoleTransition, null);
});

test("context 只暴露此刻可走的路径，不带目标身份", () => {
  const worldInput = transitionWorld();
  const state = playerState(worldInput);
  const context = buildContext({ world: worldInput, state, history: [], dueEvents: [], dominantSystems: [] });
  assert.equal(context.roleProgression.length, 1);
  assert.equal(context.roleProgression[0].id, "p1");
  assert.equal(context.roleProgression[0].toRoleId, undefined);
  assert.equal(context.refusedTransition, null);
});

test("refusedTransition 一次性注入：下回合上下文可见，回合后清除", async () => {
  const worldInput = transitionWorld();
  const refused = applyRoleTransition(
    {
      ...playerState(worldInput),
      pendingRoleTransition: {
        progressionId: "p1",
        triggerEventId: "t1",
        toRoleId: "elder",
        fromRoleId: "disciple",
        fromRoleName: "杂役弟子",
      },
    },
    normalizeWorld(worldInput),
    false,
  );
  const engine = new StoryEngine({
    world: worldInput,
    initialState: refused,
    seed: 42,
    llm: transitionLlm({}),
  });
  await engine.play(startingOption);
  assert.equal(engine.store.current.lastRefusedTransition, null);
  const withRefusal = buildContext({ world: worldInput, state: refused, history: [], dueEvents: [], dominantSystems: [] });
  assert.deepEqual(withRefusal.refusedTransition, {
    progressionId: "p1",
    turn: 0,
    toRoleName: "长老",
  });
});

test("migrateState 回填旧档身份履历", () => {
  const worldInput = transitionWorld();
  const legacy = migrateState({ ...initialState, player: { name: "旧人", roleId: "disciple", roleName: "杂役弟子" } }, worldInput);
  assert.deepEqual(legacy.player.roleHistory, [
    { roleId: "disciple", roleName: "杂役弟子", sinceTurn: 1, reason: "开局" },
  ]);
  assert.deepEqual(legacy.player.usedProgressionIds, []);
  assert.deepEqual(legacy.player.refusedProgressionIds, []);
  assert.equal(legacy.player.roleDangling, false);
});

test("pastLifeFact 把转变史织进前世传闻", () => {
  const worldInput = transitionWorld();
  const state = playerState(worldInput);
  const rich = {
    ...state,
    turn: 12,
    player: {
      ...state.player,
      roleName: "长老",
      roleHistory: [
        { roleId: "disciple", roleName: "杂役弟子", sinceTurn: 1, reason: "开局" },
        { roleId: "elder", roleName: "长老", sinceTurn: 9, reason: "大比夺魁" },
      ],
    },
  };
  const fact = pastLifeFact(rich, { dead: true, cause: "旧伤复发" }, "x");
  assert.match(fact.text, /曾以杂役弟子出身，活到第12回合，第9回合转为长老，最终旧伤复发。/);
  // 单条履历退化为旧句式。
  const single = pastLifeFact(state, { dead: false }, "y");
  assert.match(single.text, /曾以杂役弟子出身，走过这里/);
});

test("转世重置转变挂起与拒绝记录", () => {
  const worldInput = transitionWorld();
  const state = {
    ...playerState(worldInput),
    pendingRoleTransition: { progressionId: "p1", triggerEventId: "t1", toRoleId: "elder", fromRoleId: "disciple", fromRoleName: "杂役弟子" },
    lastRefusedTransition: { progressionId: "p1", turn: 3, toRoleName: "长老" },
  };
  const successor = createSuccessorState(state, playerState(worldInput), normalizeWorld(worldInput));
  assert.equal(successor.pendingRoleTransition, null);
  assert.equal(successor.lastRefusedTransition, null);
});

test("journal 记身份履历并标出失配身份", () => {
  const worldInput = transitionWorld();
  const state = playerState(worldInput);
  const rich = {
    ...state,
    player: {
      ...state.player,
      roleHistory: [
        { roleId: "disciple", roleName: "杂役弟子", sinceTurn: 1, reason: "开局" },
        { roleId: "elder", roleName: "长老", sinceTurn: 9, reason: "大比夺魁" },
      ],
      roleDangling: true,
    },
  };
  const entries = buildCharacterJournal(rich).filter((item) => item.section === "身份履历");
  assert.equal(entries.length, 2);
  assert.match(entries[0].text, /第9回合.*转为长老/);
  assert.match(entries[1].text, /需要重选身份/);
});

test("原创身份可声明进阶路径，含新身份占位与重复 id 后缀", () => {
  const worldInput = normalizeWorld(transitionWorld());
  // 从既有身份 → 新身份。
  const created = createEntity(
    "role",
    {
      name: "掌剑真人",
      description: "执掌剑堂的真人",
      progression: { fromRoleId: "elder", toRoleId: "__new__", triggerDescription: "剑冢认主" },
    },
    worldInput,
    { lifeIndex: 1, createdTurn: 4 },
  );
  const role = created.roleTemplates.at(-1);
  const path = created.roleProgression.at(-1);
  assert.equal(path.fromRoleId, "elder");
  assert.equal(path.toRoleId, role.id);
  assert.equal(path.triggerEvents[0].description, "剑冢认主");
  assert.equal(path.provenance.source, "player_created");
  // 同一条路径再建一次：id 追加后缀，不撞车。
  const again = createEntity(
    "role",
    {
      name: "掌剑真人第二",
      description: "执掌剑堂的真人",
      progression: { fromRoleId: "elder", toRoleId: "__new__", triggerDescription: "剑冢认主" },
    },
    created,
    { lifeIndex: 1, createdTurn: 5 },
  );
  const ids = again.roleProgression.map((item) => item.id);
  assert.equal(new Set(ids).size, ids.length);
});

test("原创进阶路径的硬校验：起终点与触发契机", () => {
  const worldInput = normalizeWorld(transitionWorld());
  const base = { name: "掌剑真人", description: "执掌剑堂" };
  const bad = validateCreation(
    "role",
    { ...base, progression: { fromRoleId: "ghost", toRoleId: "elder", triggerDescription: "契机" } },
    worldInput,
  );
  assert.ok(!bad.ok);
  assert.match(bad.errors.join(""), /起点与终点/);
  const self = validateCreation(
    "role",
    { ...base, progression: { fromRoleId: "elder", toRoleId: "elder", triggerDescription: "契机" } },
    worldInput,
  );
  assert.ok(!self.ok);
  const empty = validateCreation(
    "role",
    { ...base, progression: { fromRoleId: "elder", toRoleId: "__new__", triggerDescription: "  " } },
    worldInput,
  );
  assert.ok(!empty.ok);
  // 合法：从既有身份 → 新身份。
  const ok = validateCreation(
    "role",
    { ...base, progression: { fromRoleId: "elder", toRoleId: "__new__", triggerDescription: "剑冢认主" } },
    worldInput,
  );
  assert.ok(ok.ok, ok.errors.join("；"));
});
