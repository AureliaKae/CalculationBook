import assert from "node:assert/strict";
import test from "node:test";

import {
  advanceEndingCandidate,
  applyDivergence,
  applyInventoryPatch,
  applyLearnedAbilities,
  applyLayeredPatches,
  applyRealmBreakthrough,
  applySystemPatch,
  buildCharacterJournal,
  createSuccessorState,
  effectiveFacts,
  emptyGameplayState,
  pastLifeFact,
  playerDeathState,
  scheduleGameplaySystems,
  validateGameplayState,
} from "../src/gameplay-systems.js";
import { resolvePowerEscape } from "../src/play-mode.js";
import { applyRoleMods, createPlayerState, normalizeWorld } from "../src/evolution.js";

const world = normalizeWorld({
  id: "world",
  title: "书",
  characters: [{ id: "guide", name: "引路人", locationIds: ["gate"] }],
  locations: ["gate"],
  factions: [{ id: "guild", name: "公会" }],
  roleTemplates: [{ id: "scout", name: "斥候", locationIds: ["gate"], factionIds: ["guild"] }],
  attributes: [{ id: "focus", name: "专注", initial: 20 }],
  stats: [{ id: "life", name: "生命", role: "vital", min: 0, max: 10, initial: 10 }],
  timeline: [
    {
      id: "event-1",
      time: 60,
      text: "引路人将在门前遇袭",
      chapterAnchor: 2,
      locationId: "gate",
      resolution: "never",
      resolutionTargetIds: [],
    },
  ],
  facts: [],
});

function state() {  return createPlayerState(world, {
    name: "旅人",
    roleId: "scout",
    locationId: "gate",
    motivation: "寻找家人",
  });
}

test("evidence is consumed only by a successful system patch and cannot be reused", () => {
  const withEvidence = applySystemPatch(
    state(),
    "personal",
    {
      evidence: [{
        key: "turn:1:rescue",
        sourceType: "turn",
        sourceId: "1:rescue",
        summary: "救下引路人",
      }],
    },
    world,
  );
  assert.equal(withEvidence.causalEvidence["turn:1:rescue"].status, "available");
  const committed = applySystemPatch(
    withEvidence,
    "relationship",
    {
      consumeEvidenceIds: ["turn:1:rescue"],
      bonds: [{
        id: "guide-debt",
        fromId: "guide",
        toId: "player",
        type: "debt",
        status: "active",
        known: true,
        obligations: ["引路人欠你一次援手"],
      }],
    },
    world,
  );
  assert.equal(committed.causalEvidence["turn:1:rescue"].status, "committed");
  assert.throws(
    () => applySystemPatch(committed, "personal", { consumeEvidenceIds: ["turn:1:rescue"] }, world),
    /not available/,
  );
});

test("evidence keys from model output cannot swap the causalEvidence prototype", () => {
  const initial = state();
  for (const key of ["__proto__", "constructor", "prototype"]) {
    assert.throws(
      () =>
        applySystemPatch(
          initial,
          "personal",
          { evidence: [{ key, sourceType: "turn", sourceId: "1:x", summary: "x" }] },
          world,
        ),
      /Invalid evidence key/,
    );
  }
  // 拒绝即可：原型与既有证据都不被改动。
  assert.equal(Object.getPrototypeOf(initial.causalEvidence), Object.prototype);
  assert.deepEqual(Object.keys(initial.causalEvidence), []);
});

test("causalEvidence registration stops at the cap but existing keys keep refreshing", () => {
  let current = state();
  for (let index = 0; index < 200; index += 1) {
    current = applySystemPatch(
      current,
      "personal",
      { evidence: [{ key: `ev-${index}`, sourceType: "turn", sourceId: `${index}`, summary: "s" }] },
      world,
    );
  }
  assert.equal(Object.keys(current.causalEvidence).length, 200);
  assert.throws(
    () =>
      applySystemPatch(
        current,
        "personal",
        { evidence: [{ key: "ev-more", sourceType: "turn", sourceId: "more", summary: "s" }] },
        world,
      ),
    /Evidence limit reached/,
  );
  // 上限只挡新键：同键重建（available 覆盖）不受影响。
  const refreshed = applySystemPatch(
    current,
    "personal",
    { evidence: [{ key: "ev-0", sourceType: "turn", sourceId: "0", summary: "again" }] },
    world,
  );
  assert.equal(Object.keys(refreshed.causalEvidence).length, 200);
  assert.equal(refreshed.causalEvidence["ev-0"].summary, "again");
});

test("permanent survival consequences require cause, warning and response opportunity", () => {
  const initial = state();
  assert.throws(
    () =>
      applySystemPatch(
        initial,
        "survival",
        {
          pressures: [{
            id: "wound",
            name: "伤势",
            stage: "critical",
            permanentConsequence: "失去左臂",
          }],
        },
        world,
      ),
    /warning chain/,
  );
});

test("layered patches drop an invalid layer and keep independent later layers", () => {
  const initial = state();
  const result = applyLayeredPatches(
    initial,
    {
      survival: {
        id: "survival-1",
        readTurn: 99,
        pressures: [{ id: "cold", name: "严寒", stage: "warning" }],
      },
      personal: {
        id: "personal-1",
        goals: [{
          id: "find-family",
          status: "active",
          publicDirection: "寻找家人的下落",
        }],
      },
    },
    world,
  );
  assert.deepEqual(result.committed, ["personal-1"]);
  assert.equal(result.dropped[0].system, "survival");
  assert.equal(result.state.personalGoals.length, 2);
  assert.ok(result.state.personalGoals.some((goal) => goal.id === "find-family"));
  assert.equal(result.state.survivalPressures.length, 0);
});

test("前置条件缺 path 时丢掉这条补丁，而不是炸掉整个回合", () => {
  // 线上崩溃：TypeError: Cannot read properties of undefined (reading 'split')
  const result = applyLayeredPatches(
    state(),
    {
      survival: {
        id: "survival-broken",
        preconditions: [{ equals: 1 }],
        pressures: [{ id: "cold", name: "严寒", stage: "warning" }],
      },
      personal: {
        id: "personal-ok",
        goals: [{ id: "find-family", status: "active", publicDirection: "寻找家人的下落" }],
      },
    },
    world,
  );

  assert.deepEqual(result.committed, ["personal-ok"]);
  assert.equal(result.dropped[0].id, "survival-broken");
  assert.equal(result.state.survivalPressures.length, 0);
});

test("前置条件被模型写成单个对象(非数组)时,按无条件处理而不是炸掉回合", () => {
  // 线上崩溃：TypeError: (patch.preconditions ?? []).every is not a function
  const result = applyLayeredPatches(
    state(),
    {
      survival: {
        id: "survival-shape",
        preconditions: { path: "turn", equals: 3 },
        pressures: [{ id: "cold", name: "严寒", stage: "warning" }],
      },
      personal: {
        id: "personal-ok",
        goals: [{ id: "find-family", status: "active", publicDirection: "寻找家人的下落" }],
      },
    },
    world,
  );

  assert.deepEqual(result.committed, ["personal-ok"]);
  assert.equal(result.dropped[0].id, "survival-shape");
  assert.equal(result.state.survivalPressures.length, 0);
});

test("dependsOn 被模型写成非数组时同样不炸回合", () => {
  const result = applyLayeredPatches(
    state(),
    {
      survival: {
        id: "survival-shape",
        dependsOn: "personal-1",
        pressures: [{ id: "cold", name: "严寒", stage: "warning" }],
      },
      personal: {
        id: "personal-ok",
        goals: [{ id: "find-family", status: "active", publicDirection: "寻找家人的下落" }],
      },
    },
    world,
  );

  assert.deepEqual(result.committed, ["personal-ok"]);
  assert.equal(result.dropped[0].id, "survival-shape");
});

test("scheduler prioritizes immediate survival and tracks only actionable systems", () => {
  const initial = state();
  initial.personalGoals.push({ id: "goal", status: "active", evidenceIds: [] });
  initial.survivalPressures.push({ id: "hunt", name: "追捕", stage: "urgent" });
  const scheduled = scheduleGameplaySystems(initial, 1);
  assert.equal(scheduled.dominant[0], "survival");
  assert.ok(scheduled.dominant.includes("personal"));
  assert.equal(scheduled.schedulerState.relationship.dormantTurns, 0);
});

test("journal exposes only knowable structured facts", () => {
  const initial = { ...state(), ...emptyGameplayState() };
  initial.personalGoals.push({
    id: "goal",
    status: "active",
    publicDirection: "找到城北留下的线索",
    evidenceIds: [],
  });
  initial.bonds.push({
    id: "secret",
    fromId: "guide",
    toId: "player",
    status: "active",
    known: false,
    obligations: ["秘密保护你"],
  });
  validateGameplayState(initial, world);
  const journal = buildCharacterJournal(initial);
  // 拍板:爽文/原味模式已移除,新档卷宗不再写模式条目。
  assert.deepEqual(journal.map((item) => item.text), ["找到城北留下的线索"]);
  // 旧爽文存档才保留定性标注(沿用旧规则,一目了然)。
  const legacyPower = { ...initial, playMode: "power", startingPoint: "scratch" };
  assert.deepEqual(buildCharacterJournal(legacyPower).map((item) => item.text), [
    "爽文模式 · 从头修炼",
    "找到城北留下的线索",
  ]);
});

test("stage ending requires three stable turns of foreshadowing before folding", () => {
  const initial = state();
  initial.personalGoals[0].status = "completed";
  initial.personalGoals[0].endingEligible = true;
  const candidate = advanceEndingCandidate(initial);
  assert.equal(candidate.endingCandidate.ready, false);
  // 连续两个稳定回合后仍不合拢:伏笔回合让叙事有时间写收束征兆。
  let next = candidate;
  for (let index = 0; index < 2; index += 1) {
    next.turn += 1;
    next = advanceEndingCandidate(next);
    assert.equal(next.endingCandidate.ready, false, `第 ${index + 1} 个稳定回合后仍不应合拢`);
  }
  // 第三个稳定回合才合拢。
  next.turn += 1;
  const ready = advanceEndingCandidate(next);
  assert.equal(ready.endingCandidate.ready, true);
  assert.equal(ready.endingCandidate.stableTurns, 3);
});

test("successor keeps public world evidence but not private character systems", () => {
  const initial = state();
  initial.causalEvidence.public = {
    sourceType: "world",
    sourceId: "public",
    system: "personal",
    public: true,
    status: "available",
  };
  initial.causalEvidence.private = {
    sourceType: "bond",
    sourceId: "private",
    system: "relationship",
    public: false,
    status: "available",
  };
  initial.bonds.push({
    id: "bond",
    fromId: "guide",
    toId: "player",
    status: "active",
  });
  const successor = createSuccessorState(
    initial,
    createPlayerState(world, {
      name: "后来者",
      roleId: "scout",
      locationId: "gate",
      motivation: "追查前人的传闻",
    }),
    world,
  );
  assert.deepEqual(Object.keys(successor.causalEvidence), ["public"]);
  assert.deepEqual(successor.bonds, []);
  assert.equal(successor.personalGoals[0].publicDirection, "追查前人的传闻");
  assert.equal(successor.worldTime, initial.worldTime);
});

test("successor keeps world continuity but resets personal knowledge and stagnation", () => {
  const initial = state();
  initial.turn = 10;
  initial.worldTime = 600;
  initial.discoveredCharacterIds = ["guide", "stranger"];
  initial.longTermMemories = [
    { id: "event:1", type: "event", text: "旧记忆", importance: 3, chapterAnchor: 1, status: "active", sourceTurn: 1 },
  ];
  initial.consecutiveStaticTurns = 5;
  const successor = createSuccessorState(
    initial,
    createPlayerState(world, {
      name: "后来者",
      roleId: "scout",
      locationId: "gate",
      motivation: "追查前人的传闻",
    }),
    world,
  );
  // 世界时间与回合继续，但前世认识谁、记得什么、僵局计数都重新开始。
  assert.equal(successor.turn, 10);
  assert.equal(successor.worldTime, 600);
  assert.deepEqual(successor.discoveredCharacterIds, ["guide"]);
  assert.deepEqual(successor.longTermMemories, []);
  assert.equal(successor.consecutiveStaticTurns, 0);
});

test("前世痕迹写成一条第一章就解锁的世界事实", () => {
  const dead = state();
  dead.turn = 12;
  const fact = pastLifeFact(dead, { dead: true, cause: "力竭而亡" }, "abc123");
  assert.equal(fact.id, "past-life-abc123");
  assert.equal(fact.chapterAnchor, 1);
  assert.match(fact.text, /旅人/);
  assert.match(fact.text, /第12回合/);
  assert.match(fact.text, /力竭而亡/);

  // 不是死亡（阶段终局）也留一条，但不写死因。
  const alive = pastLifeFact(state(), { dead: false }, "zzz");
  assert.doesNotMatch(alive.text, /最终/);
});

test("effectiveFacts applies delivered-event fact changes (backstory included)", () => {
  const timelineWorld = normalizeWorld({
    id: "timeline-facts",
    title: "书",
    characters: [],
    locations: ["gate"],
    attributes: [{ id: "focus", name: "专注", initial: 20 }],
    stats: [{ id: "life", name: "生命", role: "vital", min: 0, max: 10, initial: 10 }],
    facts: [
      { id: "f-old", text: "黄枫谷为越国大派", chapterAnchor: 100 },
      { id: "f-stay", text: "天南有灵药", chapterAnchor: 5 },
    ],
    timeline: [
      {
        id: "ev-destroy",
        time: 5000,
        text: "黄枫谷被灭门",
        chapterAnchor: 600,
        locationId: "gate",
        prerequisites: [],
        invalidatedBy: [],
        resolution: "world_time",
        resolutionTargetIds: [],
        factsToInvalidate: ["f-old"],
        factsToAdd: [{ id: "f-new", text: "黄枫谷已成废墟", chapterAnchor: 600 }],
      },
      {
        id: "ev-future",
        time: 99999,
        text: "未来事件",
        chapterAnchor: 900,
        locationId: "gate",
        prerequisites: [],
        invalidatedBy: [],
        resolution: "world_time",
        resolutionTargetIds: [],
        factsToAdd: [{ id: "f-future", text: "未来才发生", chapterAnchor: 900 }],
      },
      {
        id: "ev-invalid",
        time: 3000,
        text: "本不该发生",
        chapterAnchor: 300,
        locationId: "gate",
        prerequisites: [],
        invalidatedBy: [],
        resolution: "world_time",
        resolutionTargetIds: [],
        factsToAdd: [{ id: "f-invalid", text: "不应生效", chapterAnchor: 300 }],
      },
    ],
  });
  const facts = effectiveFacts(timelineWorld, {
    eventStates: {
      "ev-destroy": { status: "delivered" },
      "ev-invalid": { status: "invalidated" },
    },
    completedDivergences: [],
  });
  const ids = facts.map((fact) => fact.id);
  assert.ok(!ids.includes("f-old"), "已交付事件声明的失效事实不再出现");
  assert.ok(ids.includes("f-new"), "已交付事件新增的事实出现");
  assert.ok(ids.includes("f-stay"), "无关事实保留");
  assert.ok(!ids.includes("f-future"), "未发生事件的事实不出现");
  assert.ok(!ids.includes("f-invalid"), "invalidated 事件不算发生,事实不生效");
});

// —— 游玩模式:改命势能 / 绝境转机 ——

test("爽文模式改命势能翻倍:一次成功铺垫即达火候,原味照旧 +1", () => {
  const seededState = { ...state(), playMode: "power" };
  const seeded = applyDivergence(seededState, world, {
    option: { divergence: { targetId: "event-1", targetType: "timeline" } },
    check: { result: "success" },
  });
  assert.equal(seeded.result.momentum, 2, "爽文一次成功铺垫=2(阈值 2,火候已够)");

  const classicState = { ...state(), playMode: "classic" };
  const one = applyDivergence(classicState, world, {
    option: { divergence: { targetId: "event-1", targetType: "timeline" } },
    check: { result: "success" },
  });
  assert.equal(one.result.momentum, 1, "原味照旧 +1");

  // 失败仍归零,两模式一致。
  const failed = applyDivergence(seededState, world, {
    option: { divergence: { targetId: "event-1", targetType: "timeline" } },
    check: { result: "failure" },
  });
  assert.equal(failed.result.momentum, 0);
});

test("爽文绝境转机:致命压力清除、vital 恢复、标记写入;原味照常死亡", () => {
  const base = state();
  base.playMode = "power";
  base.stats.life = 0;
  base.survivalPressures.push({
    id: "fatal",
    name: "灯油耗尽",
    stage: "critical",
    permanentConsequence: "death",
    warningObserved: true,
    responseOpportunityOffered: true,
  });
  const death = playerDeathState(base);
  assert.equal(death.dead, true);
  const escaped = resolvePowerEscape(base, death, world);
  assert.equal(escaped.escaped, true);
  assert.equal(escaped.death.dead, false);
  assert.equal(escaped.death.escaped, true);
  assert.ok(!escaped.state.survivalPressures.some((item) => item.id === "fatal"), "致命压力清除");
  assert.equal(escaped.state.stats.life, 1, "vital 恢复到下限之上");
  assert.equal(escaped.state.powerEscape.turn, base.turn, "一次性转机标记写入");

  // 原味:原样死亡,状态不动。
  const classic = { ...base, playMode: "classic" };
  const kept = resolvePowerEscape(classic, death, world);
  assert.equal(kept.escaped, false);
  assert.equal(kept.death.dead, true);
  assert.ok(kept.state.survivalPressures.some((item) => item.id === "fatal"));
});


test("advanceEndingCandidate 不清掉已就绪的候选(折叠终局保稳)", () => {
  // 已就绪候选(如折叠来源 fate-complete)不该被目标推进系统清掉:
  // 清掉再重建会让已合拢的终局在下一回合凭空消失、引擎再次触发终局。
  const ready = state();
  ready.endingCandidate = {
    type: "stage",
    goalId: "fate-complete",
    createdTurn: 9,
    stableTurns: 2,
    ready: true,
  };
  const next = advanceEndingCandidate(ready);
  assert.equal(next, ready, "没有可推进目标时,已就绪候选原样保留");
  assert.equal(next.endingCandidate.ready, true);
});

test("playerDeathState 尊重持久死亡标记(交锋致死不漏判)", () => {
  // 交锋致死的状态里 survivalPressures 没有致命项——只按压力重算会把死人
  // 判成活人。持久标记是短路口径,优先于一切重算。
  const dead = state();
  dead.playerDead = true;
  dead.playerDeathCause = "死于搏杀";
  assert.deepEqual(playerDeathState(dead), { dead: true, cause: "死于搏杀" });
  // 无标记时走原有压力口径。
  assert.equal(playerDeathState(state()).dead, false);
});

test("createSuccessorState 重置死亡标记:新一世是活人", () => {
  const dead = state();
  dead.playerDead = true;
  dead.playerDeathCause = "旧伤";
  const successor = createSuccessorState(
    dead,
    createPlayerState(world, {
      name: "后来者",
      roleId: "scout",
      locationId: "gate",
      motivation: "新的开始",
    }),
    world,
  );
  assert.equal(successor.playerDead, false, "前世已死的事实不随状态克隆带过来");
  assert.equal(successor.playerDeathCause, null);
  assert.equal(playerDeathState(successor).dead, false);
});

test("applyRoleMods 无界字段与进阶路径同口径 0-100 封顶", () => {
  // 建角侧若不封顶,属性超 100 的角色第一次身份转变就会被进阶侧钳制
  // 静默砍掉——两处钳制必须一致。
  const attributes = applyRoleMods({ focus: 95 }, { focus: 30 }, {});
  assert.equal(attributes.focus, 100, "无界字段上限 100");
  const floored = applyRoleMods({ focus: 5 }, { focus: -30 }, {});
  assert.equal(floored.focus, 0, "下限 0");
});

// —— 玩家成长三补丁（拍板 2026-08-19：具名行囊/技能习得/境界突破） ——

test("applyInventoryPatch：涌现入囊、去重、目录名覆盖与按名移除", () => {
  const base = state();
  const gained = applyInventoryPatch(base, {
    changes: [
      { action: "gain", name: "养父的遗剑", note: "剑鞘刻着燕尾" },
      { action: "gain", name: "养父的遗剑" },
      { action: "gain", itemId: "item-coin", name: "随便什么名字都会被目录覆盖" },
    ],
  });
  assert.equal(gained.player.inventory.length, 2, "同名不重复入囊");
  const sword = gained.player.inventory[0];
  assert.equal(sword.name, "养父的遗剑");
  assert.equal(sword.source, "emergent");
  assert.equal(sword.note, "剑鞘刻着燕尾");
  assert.equal(gained.player.inventory[1].source, "catalog");

  const lost = applyInventoryPatch(gained, {
    changes: [{ action: "lose", name: "养父的遗剑" }],
  });
  assert.equal(lost.player.inventory.length, 1);
  assert.equal(lost.player.inventory[0].name, "随便什么名字都会被目录覆盖");

  // 空补丁/坏形状零拷贝返回原状态。
  assert.equal(applyInventoryPatch(base, null), base);
  assert.equal(applyInventoryPatch(base, { changes: [] }), base);
});

test("applyInventoryPatch：满员只挡新 gain，同补丁的 lose 照常结算", () => {
  let full = state();
  full = applyInventoryPatch(full, {
    changes: Array.from({ length: 24 }, (_, index) => ({ action: "gain", name: `杂物${index}` })),
  });
  assert.equal(full.player.inventory.length, 24);
  const drained = applyInventoryPatch(full, {
    changes: [
      { action: "gain", name: "塞不进来的新东西" },
      { action: "lose", name: "杂物0" },
    ],
  });
  assert.equal(drained.player.inventory.length, 23, "满员挡 gain、lose 照常扣减");
  assert.equal(drained.player.inventory.some((item) => item.name === "杂物0"), false, "lose 不被跳过");
  assert.equal(drained.player.inventory.some((item) => item.name === "塞不进来的新东西"), false, "满员后新 gain 不入囊");
});

test("applyLearnedAbilities：去重累加、上限十二条、与身份能力重合不收", () => {
  let current = state();
  current = applyLearnedAbilities(current, ["能以神识扫探方圆数里"]);
  current = applyLearnedAbilities(current, ["能以神识扫探方圆数里", "能御器短距离飞行"]);
  assert.deepEqual(current.player.learnedAbilities, ["能以神识扫探方圆数里", "能御器短距离飞行"]);

  // 习得与身份能力重合:能力块会出现重复行——一律不收。
  const overlap = { ...current, player: { ...current.player, abilities: ["固有的本事"] } };
  const learnedOverlap = applyLearnedAbilities(overlap, ["固有的本事", "新的本事"]);
  assert.deepEqual(learnedOverlap.player.learnedAbilities, [
    "能以神识扫探方圆数里",
    "能御器短距离飞行",
    "新的本事",
  ], "身份已有的不重复习得");

  let capped = state();
  for (let index = 0; index < 15; index += 1) {
    capped = applyLearnedAbilities(capped, [`技能${index}`]);
  }
  assert.equal(capped.player.learnedAbilities.length, 12, "总量封顶 12");
});

const breakthroughWorld = normalizeWorld({
  id: "realm-world",
  title: "书",
  characters: [{ id: "guide", name: "引路人", locationIds: ["gate"] }],
  locations: ["gate"],
  traits: [
    { id: "t-lianqi", name: "练气期", value: "第一阶" },
    { id: "t-zhuji", name: "筑基期", value: "第二阶" },
    { id: "t-jindan", name: "金丹期", value: "第三阶" },
  ],
  roleTemplates: [
    { id: "scout", name: "斥候", locationIds: ["gate"], traitIds: ["t-lianqi"] },
    { id: "elder", name: "长老", locationIds: ["gate"], traitIds: ["t-zhuji"] },
  ],
  attributes: [{ id: "focus", name: "专注", initial: 20 }],
  stats: [{ id: "life", name: "生命", role: "vital", min: 0, max: 10, initial: 10 }],
  timeline: [],
  facts: [],
});

test("applyRealmBreakthrough：换阶入档、越阶降阶拒绝、履历留痕", () => {
  const base = createPlayerState(breakthroughWorld, {
    name: "旅人",
    roleId: "scout",
    locationId: "gate",
  });
  assert.deepEqual(base.player.traitIds, ["t-lianqi"]);

  const broken = applyRealmBreakthrough(
    base,
    { toTraitId: "t-zhuji", note: "闭关七日，水到渠成" },
    breakthroughWorld,
  );
  assert.deepEqual(broken.player.traitIds, ["t-zhuji"], "旧境界阶被替换");
  assert.deepEqual(
    broken.player.realmHistory.map((entry) => entry.name),
    ["筑基期"],
  );
  assert.equal(broken.player.realmHistory[0].note, "闭关七日，水到渠成");

  // 降回练气、原地突破、未知 id 一律静默拒绝。
  assert.equal(applyRealmBreakthrough(broken, { toTraitId: "t-lianqi" }, breakthroughWorld), broken);
  assert.equal(applyRealmBreakthrough(broken, { toTraitId: "t-zhuji" }, breakthroughWorld), broken);
  assert.equal(applyRealmBreakthrough(broken, { toTraitId: "t-nope" }, breakthroughWorld), broken);
  // 无阶梯之书直接拒绝。
  assert.equal(applyRealmBreakthrough(base, { toTraitId: "t-jindan" }, world), base);
});
