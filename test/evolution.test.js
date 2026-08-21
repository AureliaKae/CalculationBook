import assert from "node:assert/strict";
import test from "node:test";

import {
  applyBigFiveShift,
  applyEvolutionPatch,
  bigFiveCrossings,
  createPlayerState,
  defaultMotivationOf,
  eligibleProgression,
  migrateState,
  neutralBigFive,
  normalizeWorld,
  optionIsAvailable,
  realmTraitsOf,
} from "../src/evolution.js";
import { createSuccessorState } from "../src/gameplay-systems.js";
import { applyRoleIdentity } from "../src/role-identity.js";

const world = normalizeWorld({
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

test("character creation validates world choices and creates hidden evolution state", () => {
  const state = createPlayerState(world, {
    name: "旅人",
    roleId: "scout",
    factionId: "guild",
    locationId: "gate",
    motivation: "寻找失踪的家人",
  });
  assert.equal(state.player.roleId, "scout");
  assert.equal(state.locationId, "gate");
  assert.ok(state.entityStates.guide);
  assert.deepEqual(state.relationships, {});
  assert.equal(state.personalGoals[0].kind, "core");
  assert.equal(state.personalGoals[0].publicDirection, "寻找失踪的家人");
  assert.deepEqual(state.survivalPressures, []);
  // 开局现状一律「如常」：烧制人物档案的 status 是全书终局命运(书知识)，
  // 不得透传成第 1 天的现状——身亡/飞升等由时间线事件在故事中投递。
  const fateWorld = normalizeWorld({
    id: "fate",
    title: "书",
    characters: [
      { id: "guide", name: "引路人", locationIds: ["gate"], firstChapter: 2, status: "飞升仙界" },
    ],
    locations: ["gate"],
    roleTemplates: [],
    attributes: [{ id: "focus", name: "专注", initial: 20 }],
    stats: [{ id: "life", name: "生命", role: "vital", min: 0, max: 10, initial: 10 }],
    timeline: [],
    facts: [],
  });
  const fresh = createPlayerState(fateWorld, { name: "旅人", locationId: "gate" });
  assert.equal(fresh.entityStates.guide.status, "active", "终局命运不进开局现状");
});

test("所求可空:空串与缺省都回落默认志向,不再撞字符数校验", () => {
  // 向导把「所求（可空）」trim 成空串传上来——?? 链接不住空串,
  // 旧行为直接抛「动机应为 2-120 个字符」把建角炸掉。
  for (const profile of [
    { name: "旅人", locationId: "gate", motivation: "" },
    { name: "旅人", locationId: "gate", motivation: "   " },
    { name: "旅人", locationId: "gate" },
  ]) {
    const state = createPlayerState(world, profile);
    assert.ok(
      state.personalGoals[0].publicDirection.length >= 2,
      "空所求应有默认志向兜底",
    );
  }
  // 单字所求是合法志向。
  const one = createPlayerState(world, { name: "旅人", locationId: "gate", motivation: "生" });
  assert.equal(one.personalGoals[0].publicDirection, "生");
});

test("能力满档的书:自动身份回落合成「无名之辈」,建角照常可用", () => {
  // 旧书经能力补写后每个身份都带 abilities,autoAssignRole 的平朴筛选会
  // 全数落空——此时按设计合成不进目录的 outsider。此契约必须稳定:
  // 生产接线的目录失配检查据此放行该身份,否则每次续读都被误判悬空。
  const fullWorld = normalizeWorld({
    ...world,
    roleTemplates: world.roleTemplates.map((role) => ({
      ...role,
      abilities: ["能做些杂活"],
    })),
  });
  const state = createPlayerState(fullWorld, { name: "旅人", locationId: "gate" });
  assert.equal(state.player.roleId, "outsider");
  assert.equal(state.player.roleName, "无名之辈");
});

test("姓名长度按码点计:生僻字名字不再被 UTF-16 计数误拒", () => {
  // 10 个 CJK 扩展 B 生僻字 = 20 个 UTF-16 码元、10 个码点——界面按码点
  // 校验放行,引擎旧口径按码元误拒「姓名应为 1-20 个字符」。
  const astral = "\u{20000}\u{20001}\u{20002}\u{20003}\u{20004}\u{20005}\u{20006}\u{20007}\u{20008}\u{20009}";
  const state = createPlayerState(world, { name: astral, locationId: "gate" });
  assert.equal(state.player.name, astral);
});

test("转世作废前世未收束的交锋:新一世不再开局死锁", () => {
  // 带着 activeClash 转世会让「先写意图」(无解法可落)与「搏杀正酣」(拒
  // 意图)互斥——开局即死锁,唯一出路只剩再弃一世。
  const prior = createPlayerState(world, { name: "旅人", locationId: "gate", motivation: "活下去" });
  prior.activeClash = {
    opponentId: "guide",
    opponentName: "引路人",
    opponentCondition: 5,
    stance: 0,
    step: 1,
    maxSteps: 5,
    origin: "player",
    reason: "狭路相逢",
  };
  const created = createPlayerState(world, { name: "后来者", locationId: "gate", motivation: "活下去" });
  const successor = createSuccessorState(prior, created, world);
  assert.equal(successor.activeClash, null, "转世清空未收束的交锋");
});

test("转世全额继承当世演化终了的五维分值", () => {
  // 拍板 2026-08-19:习性难改——上一世养出的性子原样带进新一世;
  // 手选底色已不存在,新一世也不再产生 bigFivePicks。
  const prior = createPlayerState(world, { name: "旅人", locationId: "gate", motivation: "活下去" });
  prior.player.bigFive = {
    openness: 82,
    conscientiousness: 50,
    extraversion: 28,
    agreeableness: 65,
    neuroticism: 44,
  };
  const created = createPlayerState(world, { name: "后来者", locationId: "gate", motivation: "活下去" });
  const successor = createSuccessorState(prior, created, world);
  assert.deepEqual(successor.player.bigFive, {
    openness: 82,
    conscientiousness: 50,
    extraversion: 28,
    agreeableness: 65,
    neuroticism: 44,
  });
  assert.equal(successor.player.bigFivePicks, undefined, "转世不再产生手选底色");
});

test("身份能力落地:abilities 进玩家档案,数值修饰钳制生效", () => {
  const realmWorld = normalizeWorld({
    id: "realm",
    title: "书",
    characters: [],
    locations: ["gate"],
    roleTemplates: [
      {
        id: "nascent",
        name: "练气散修",
        locationIds: ["gate"],
        factionIds: [],
        abilities: ["能以望气术辨别吉凶"],
      },
      {
        id: "elder",
        name: "元婴长老",
        locationIds: ["gate"],
        factionIds: [],
        abilities: ["能以神识扫探方圆数里", "可御器飞行"],
        statMods: { cultivation: 8, life: 99 }, // 越界项应被钳制
        attributeMods: { focus: 20 },
      },
    ],
    attributes: [{ id: "focus", name: "神识", initial: 20 }],
    stats: [
      { id: "life", name: "生命", role: "vital", min: 0, max: 10, initial: 10 },
      { id: "cultivation", name: "修为", role: "progress", min: 0, max: 12, initial: 2 },
    ],
    timeline: [],
    facts: [],
  });
  const base = { name: "沈砚", locationId: "gate", motivation: "活下去" };
  const lowly = createPlayerState(realmWorld, { ...base, roleId: "nascent" });
  assert.deepEqual(lowly.player.abilities, ["能以望气术辨别吉凶"]);
  assert.equal(lowly.stats.cultivation, 2, "无修饰身份保持模板值");

  const elder = createPlayerState(realmWorld, { ...base, roleId: "elder" });
  assert.deepEqual(elder.player.abilities, ["能以神识扫探方圆数里", "可御器飞行"]);
  assert.equal(elder.stats.cultivation, 10, "修为 +8 落在模板值 2 上");
  assert.equal(elder.stats.life, 10, "越界修饰钳在 max 10");
  assert.equal(elder.attributes.focus, 40, "属性修饰生效");
});

test("境界阶梯按阶拆分的特质被识别,阶名后缀即可命中且不误伤普通设定", () => {
  const ladderWorld = normalizeWorld({
    id: "realm-ladder",
    title: "书",
    characters: [],
    locations: ["gate"],
    roleTemplates: [],
    attributes: [{ id: "focus", name: "定力", initial: 20 }],
    stats: [],
    traits: [
      { id: "liqi", name: "炼气期", value: "能吐纳灵气", description: "境界阶梯：修行的第一大步" },
      { id: "zhuji", name: "筑基期", value: "御器飞行", description: "境界阶梯：第二大步" },
      { id: "jiedan", name: "结丹期", value: "御剑化虹", description: "境界阶梯：第三大步" },
      { id: "job", name: "宗门职位", value: "杂役", description: "门内差事，与修行无关" },
    ],
    timeline: [],
    facts: [],
  });
  assert.deepEqual(
    realmTraitsOf(ladderWorld).map((trait) => trait.id),
    ["liqi", "zhuji", "jiedan"],
  );
});

test("境界步合成 traitIds:默认身份惯常境界,显式选择高低不限", () => {
  const realmWorld = normalizeWorld({
    id: "realm-auth",
    title: "书",
    characters: [],
    locations: ["gate"],
    factions: [{ id: "sect", name: "宗门" }],
    traits: [
      { id: "realm-nascent", name: "境界", value: "练气", description: "修行第一步" },
      { id: "realm-foundation", name: "境界", value: "筑基", description: "第二阶" },
      { id: "realm-elder", name: "境界", value: "元婴", description: "一方老祖" },
    ],
    roleTemplates: [
      {
        id: "nascent",
        name: "练气散修",
        locationIds: ["gate"],
        factionIds: [],
        traitIds: ["realm-nascent"],
      },
      {
        id: "elder",
        name: "元婴长老",
        locationIds: ["gate"],
        factionIds: ["sect"],
        traitIds: ["realm-elder"],
        authority: ["inspect", "manage", "乱写的权限"],
      },
    ],
    attributes: [{ id: "focus", name: "神识", initial: 20 }],
    stats: [{ id: "life", name: "生命", role: "vital", min: 0, max: 10, initial: 10 }],
    timeline: [],
    facts: [],
  });
  const base = { name: "沈砚", locationId: "gate", motivation: "活下去" };
  // 未显式选择:身份惯常境界。
  const lowly = createPlayerState(realmWorld, { ...base, roleId: "nascent" });
  assert.deepEqual(lowly.player.traitIds, ["realm-nascent"]);
  // 显式选更低档:许选。
  const chosenLow = createPlayerState(realmWorld, {
    ...base,
    roleId: "elder",
    realmTraitId: "realm-foundation",
  });
  assert.deepEqual(chosenLow.player.traitIds, ["realm-foundation"], "长老自降为筑基可行");
  // 显式选更高档:高低不限(拍板:境界由用户在原著阶梯里自选,模式与起点已移除)。
  const overreach = createPlayerState(realmWorld, {
    ...base,
    roleId: "nascent",
    realmTraitId: "realm-elder",
  });
  assert.deepEqual(overreach.player.traitIds, ["realm-elder"], "练气身份也可自选元婴境界");
  // 非法 id:回落身份惯常档(无惯常档则最低档)。
  const bogus = createPlayerState(realmWorld, {
    ...base,
    roleId: "nascent",
    realmTraitId: "realm-bogus",
  });
  assert.deepEqual(bogus.player.traitIds, ["realm-nascent"], "非法境界 id 回落身份惯常档");
  // 开局无势力成员记录(拍板),职权由后续进阶获得。
  const elder = createPlayerState(realmWorld, { ...base, roleId: "elder" });
  assert.deepEqual(elder.factionMemberships, []);
});

test("特质门槛只认玩家身份蕴含的特质,不再用世界特质表", () => {
  const realmWorld = normalizeWorld({
    id: "realm-gate",
    title: "书",
    characters: [],
    locations: ["gate"],
    traits: [
      { id: "realm-nascent", name: "境界", value: "练气", description: "修行第一步" },
      { id: "realm-elder", name: "境界", value: "元婴", description: "一方老祖" },
    ],
    roleTemplates: [
      { id: "nascent", name: "练气散修", locationIds: ["gate"], factionIds: [], traitIds: ["realm-nascent"] },
      { id: "elder", name: "元婴长老", locationIds: ["gate"], factionIds: [], traitIds: ["realm-elder"] },
    ],
    attributes: [{ id: "focus", name: "神识", initial: 20 }],
    stats: [{ id: "life", name: "生命", role: "vital", min: 0, max: 10, initial: 10 }],
    timeline: [],
    facts: [],
  });
  const base = { name: "沈砚", locationId: "gate", motivation: "活下去" };
  const lowly = createPlayerState(realmWorld, { ...base, roleId: "nascent" });
  const elder = createPlayerState(realmWorld, { ...base, roleId: "elder" });
  const flyBySword = {
    id: "fly",
    text: "御剑远遁",
    axis: "exit",
    approach: "avoid",
    risk: "safe",
    attribute: "focus",
    requirements: { traits: [{ id: "realm-elder" }] },
  };
  // 世界特质表里有 realm-elder,但练气玩家不拥有它 → 门槛必须拦住。
  assert.equal(optionIsAvailable(flyBySword, lowly, realmWorld), false);
  assert.equal(optionIsAvailable(flyBySword, elder, realmWorld), true);
});

test("职权门槛:取得成员记录并带 authority 才放行,否则拦截", () => {
  const realmWorld = normalizeWorld({
    id: "realm-auth-gate",
    title: "书",
    characters: [],
    locations: ["gate"],
    factions: [{ id: "sect", name: "宗门" }],
    roleTemplates: [
      {
        id: "elder",
        name: "外事长老",
        locationIds: ["gate"],
        factionIds: ["sect"],
        authority: ["inspect"],
      },
      { id: "r2", name: "散修", locationIds: ["gate"], factionIds: [] },
    ],
    attributes: [{ id: "focus", name: "神识", initial: 20 }],
    stats: [{ id: "life", name: "生命", role: "vital", min: 0, max: 10, initial: 10 }],
    timeline: [],
    facts: [],
  });
  const elder = createPlayerState(realmWorld, {
    name: "沈砚",
    roleId: "elder",
    locationId: "gate",
    motivation: "活下去",
  });
  // 开局无成员记录:职权行动不可用;取得带 authority 的记录后放行。
  elder.factionMemberships.push({
    id: "membership:sect",
    factionId: "sect",
    authority: ["inspect"],
    duties: [],
    overdueDutyIds: [],
  });
  const outsider = createPlayerState(realmWorld, {
    name: "路人",
    roleId: "r2",
    locationId: "gate",
    motivation: "活下去",
  });
  const readRegistry = {
    id: "read",
    text: "以长老之权调阅名册",
    axis: "investigate",
    approach: "cooperate",
    risk: "safe",
    attribute: "focus",
    requirements: { factionId: "sect", authority: ["inspect"] },
  };
  assert.equal(optionIsAvailable(readRegistry, elder, realmWorld), true, "长老职权放行");
  assert.equal(optionIsAvailable(readRegistry, outsider, realmWorld), false, "无职权身份拦截");
});

test("非法身份修饰引用被忽略,不炸创角", () => {
  const sloppy = normalizeWorld({
    id: "sloppy",
    title: "书",
    characters: [],
    locations: ["gate"],
    roleTemplates: [
      {
        id: "scout",
        name: "斥候",
        locationIds: ["gate"],
        factionIds: [],
        abilities: "不是数组，应被容错",
        statMods: { ghost: 5, life: "not-a-number" },
        attributeMods: [1, 2, 3],
      },
    ],
    attributes: [{ id: "focus", name: "专注", initial: 20 }],
    stats: [{ id: "life", name: "生命", role: "vital", min: 0, max: 10, initial: 10 }],
    timeline: [],
    facts: [],
  });
  const state = createPlayerState(sloppy, {
    name: "旅人",
    roleId: "scout",
    locationId: "gate",
    motivation: "活下去",
  });
  assert.deepEqual(state.player.abilities, [], "形状不对的能力字段回落为空");
  assert.equal(state.stats.life, 10, "非法修饰不生效");
});

test("旧档迁移按身份目录回填能力文本(数值不回补)", () => {
  const realmWorld = normalizeWorld({
    id: "realm-migrate",
    title: "书",
    characters: [],
    locations: ["gate"],
    factions: [{ id: "sect", name: "宗门" }],
    traits: [{ id: "realm-elder", name: "境界", value: "元婴", description: "一方老祖" }],
    roleTemplates: [
      {
        id: "elder",
        name: "元婴长老",
        locationIds: ["gate"],
        factionIds: ["sect"],
        abilities: ["能以神识扫探方圆数里"],
        statMods: { cultivation: 8 },
        traitIds: ["realm-elder"],
        authority: ["inspect"],
      },
    ],
    attributes: [{ id: "focus", name: "神识", initial: 20 }],
    stats: [{ id: "cultivation", name: "修为", role: "progress", min: 0, max: 12, initial: 2 }],
    timeline: [],
    facts: [],
  });
  const legacy = {
    turn: 3,
    locationId: "gate",
    location: "gate",
    stats: { cultivation: 2 },
    attributes: { focus: 20 },
    player: { id: "player", name: "沈砚", roleId: "elder", roleName: "元婴长老", factionId: "sect" },
    factionMemberships: [
      { id: "membership:player:sect", factionId: "sect", authority: [], duties: [] },
    ],
  };
  const migrated = migrateState(legacy, realmWorld);
  assert.deepEqual(migrated.player.abilities, ["能以神识扫探方圆数里"], "回填能力文本");
  assert.deepEqual(migrated.player.traitIds, ["realm-elder"], "回填身份特质");
  assert.deepEqual(migrated.factionMemberships[0].authority, ["inspect"], "回填身份职权");
  assert.equal(migrated.stats.cultivation, 2, "历史数值不追算身份修饰");
});

test("createPlayerState 拒绝绑定原著人物的身份与污染细节", () => {
  const polluted = normalizeWorld({
    id: "polluted",
    title: "书",
    characters: [
      { id: "han", name: "韩立", locationIds: ["gate"], firstChapter: 1 },
      { id: "nangong", name: "南宫婉", locationIds: ["gate"], firstChapter: 1 },
    ],
    locations: ["gate"],
    roleTemplates: [
      { id: "hero", name: "主角", locationIds: ["gate"], factionIds: [] },
      { id: "dao", name: "韩立道侣", locationIds: ["gate"], factionIds: [] },
      { id: "scout", name: "散修", locationIds: ["gate"], factionIds: [] },
    ],
    attributes: [{ id: "focus", name: "专注", initial: 20 }],
    stats: [{ id: "life", name: "生命", role: "vital", min: 0, max: 10, initial: 10 }],
    timeline: [],
    facts: [],
  });
  const base = { name: "旅人", locationId: "gate", motivation: "活下去" };
  assert.throws(
    () => createPlayerState(polluted, { ...base, roleId: "hero" }),
    /不是原著中的任何人/,
  );
  assert.throws(
    () => createPlayerState(polluted, { ...base, roleId: "dao" }),
    /不是原著中的任何人/,
  );
  // 外貌/个人细节点名原著人物仍拒绝。
  assert.throws(
    () => createPlayerState(polluted, { ...base, roleId: "scout", details: "像韩立一样" }),
    /个人细节不得使用原著人物的称呼/,
  );
  // 干净的身份照常通过;称谓已取消,player 不再带 pronoun。
  const ok = createPlayerState(polluted, { ...base, roleId: "scout" });
  assert.equal(ok.player.roleName, "散修");
  assert.equal("pronoun" in ok.player, false, "称谓字段已取消");
});

test("开局锚定:切入章之前的原文事件标记为已发生", () => {
  const anchored = normalizeWorld({
    id: "anchored",
    title: "书",
    characters: [{ id: "guide", name: "引路人", locationIds: ["gate"], firstChapter: 2 }],
    locations: ["gate"],
    roleTemplates: [{ id: "scout", name: "散修", locationIds: ["gate"], factionIds: [] }],
    attributes: [{ id: "focus", name: "专注", initial: 20 }],
    stats: [{ id: "life", name: "生命", role: "vital", min: 0, max: 10, initial: 10 }],
    timeline: [
      { id: "e1", time: 0, chapterAnchor: 1, text: "一" },
      { id: "e2", time: 120, chapterAnchor: 1, text: "二" },
      { id: "e3", time: 240, chapterAnchor: 2, text: "三" },
    ],
    creationScope: { focusChapter: 2, openAll: false, anchorTime: 240 },
    facts: [],
  });
  const state = createPlayerState(anchored, {
    name: "旅人",
    roleId: "scout",
    locationId: "gate",
    motivation: "活下去",
  });
  // 锚定按故事内时间(拍板):切入锚点 anchorTime=240,早于它的 e1/e2 视为原著已发生。
  assert.deepEqual(state.eventStates.e1, { status: "delivered", deliveredTurn: 0, delivery: "backstory" });
  assert.deepEqual(state.eventStates.e2, { status: "delivered", deliveredTurn: 0, delivery: "backstory" });
  assert.deepEqual(state.eventStates.e3, { status: "scheduled" });
  assert.equal(state.worldTime, 240, "世界时钟 = 锚点时间 - 故事起点");
});

test("倒叙书切入结局事件:故事内时间锚定而非章节锚定", () => {
  const flashback = normalizeWorld({
    id: "flashback",
    title: "书",
    characters: [],
    locations: ["gate"],
    roleTemplates: [{ id: "scout", name: "散修", locationIds: ["gate"], factionIds: [] }],
    attributes: [{ id: "focus", name: "专注", initial: 20 }],
    stats: [{ id: "life", name: "生命", role: "vital", min: 0, max: 10, initial: 10 }],
    // ch1 叙述十年后的结局(time 大),插叙回忆 time 小、chapterAnchor 大。
    timeline: [
      { id: "ending", time: 100000, chapterAnchor: 1, text: "结局" },
      { id: "memory", time: 10, chapterAnchor: 5, text: "回忆" },
    ],
    creationScope: { focusChapter: 1, openAll: false, anchorTime: 100000 },
    facts: [],
  });
  const state = createPlayerState(flashback, {
    name: "旅人",
    roleId: "scout",
    locationId: "gate",
    motivation: "活下去",
  });
  assert.equal(state.worldTime, 99990, "世界时钟推进到结局事件之前");
  assert.deepEqual(state.eventStates.memory, { status: "delivered", deliveredTurn: 0, delivery: "backstory" }, "回忆事件已发生");
  assert.deepEqual(state.eventStates.ending, { status: "scheduled" }, "结局事件尚未发生——切入正确");
});

test("any identity can start from any location", () => {
  // 地点已完全放开：scout 也能从 tower 开局，不再抛「身份不能」。
  const state = createPlayerState(world, {
    name: "旅人",
    roleId: "scout",
    locationId: "tower",
    motivation: "寻找线索",
  });
  assert.equal(state.locationId, "tower");
  // 出身势力已从建角移除(拍板):开局无成员记录、无出身势力。
  assert.deepEqual(state.factionMemberships, []);
  assert.equal(state.player.factionId, null);
});
test("creation starts bigFive neutral and ignores legacy picks", () => {
  // 拍板 2026-08-19(中庸起步):建角不再手选底色——五维一律 50,
  // 性子由游玩中选择的漂移长出来;传入 bigFivePicks 的旧调用方一律忽略。
  const plain = createPlayerState(world, {
    name: "旅人",
    roleId: "scout",
    locationId: "gate",
    motivation: "寻找线索",
  });
  assert.deepEqual(plain.player.bigFive, neutralBigFive());
  assert.equal(plain.player.bigFivePicks, undefined, "新档不再写 bigFivePicks");
  assert.deepEqual(plain.bigFiveChanges, []);
  assert.deepEqual(plain.player.personalityEvidence, []);

  const legacyPicks = createPlayerState(world, {
    name: "旅人",
    roleId: "scout",
    locationId: "gate",
    motivation: "寻找线索",
    bigFivePicks: {
      openness: ["o-high"],
      conscientiousness: ["c-high"],
      extraversion: ["e-high"],
      agreeableness: ["a-low"],
      neuroticism: ["n-low"],
    },
  });
  assert.deepEqual(legacyPicks.player.bigFive, neutralBigFive(), "传入的底色选择被忽略");
  assert.equal(legacyPicks.player.bigFivePicks, undefined);
});

test("applyBigFiveShift clamps deltas, filters unknown dimensions and stays in 0-100", () => {
  const base = {
    openness: 95,
    conscientiousness: 5,
    extraversion: 50,
    agreeableness: 50,
    neuroticism: 50,
  };
  const shifted = applyBigFiveShift(base, {
    openness: 10,
    conscientiousness: -10,
    extraversion: 2.6,
    agreeableness: -1,
    neuroticism: 3,
    bogus: 99,
  });
  assert.equal(shifted.openness, 100, "钳到上限");
  assert.equal(shifted.conscientiousness, 0, "钳到下限");
  assert.equal(shifted.extraversion, 53, "非整数四舍五入");
  assert.equal(shifted.agreeableness, 49);
  assert.equal(shifted.neuroticism, 53);
  assert.equal("bogus" in shifted, false, "未知维度忽略");
  // 无漂移声明时返回中性兜底(旧存档玩家缺字段)。
  assert.deepEqual(applyBigFiveShift(undefined, null), neutralBigFive());
});

test("bigFiveCrossings detects 30/70 level crossings", () => {
  assert.deepEqual(bigFiveCrossings({ openness: 55 }, { openness: 75 }), [
    { dimension: "openness", level: "偏高", before: "均衡" },
  ]);
  assert.deepEqual(bigFiveCrossings({ agreeableness: 40 }, { agreeableness: 25 }), [
    { dimension: "agreeableness", level: "偏低", before: "均衡" },
  ]);
  assert.deepEqual(bigFiveCrossings({ extraversion: 71 }, { extraversion: 79 }), [], "同档内不报");
  assert.deepEqual(bigFiveCrossings({ neuroticism: 20 }, { neuroticism: 80 }), [
    { dimension: "neuroticism", level: "偏高", before: "偏低" },
  ]);
});

test("性别写入角色并影响称谓素材,非法值拒绝", () => {
  const male = createPlayerState(world, {
    name: "旅人",
    roleId: "scout",
    locationId: "gate",
    motivation: "活下去",
    gender: "male",
  });
  assert.equal(male.player.gender, "male");
  const female = createPlayerState(world, {
    name: "旅人",
    roleId: "scout",
    locationId: "gate",
    motivation: "活下去",
    gender: "female",
  });
  assert.equal(female.player.gender, "female");
  // 非法值拒绝;缺省(旧调用方)为未定 null。
  assert.throws(
    () => createPlayerState(world, { name: "旅人", roleId: "scout", locationId: "gate", motivation: "活下去", gender: "robot" }),
    /性别请选择男或女/,
  );
  const legacy = createPlayerState(world, { name: "旅人", roleId: "scout", locationId: "gate", motivation: "活下去" });
  assert.equal(legacy.player.gender, null, "旧调用方缺省未定");
  // 迁移:旧档缺省未定,已有合法值保留。
  const migrated = migrateState(legacy, world);
  assert.equal(migrated.player.gender, null);
  legacy.player.gender = "female";
  assert.equal(migrateState(legacy, world).player.gender, "female");
});

test("开局诉求由创角目录起意(分层意图)", () => {
  const state = createPlayerState(world, {
    name: "旅人",
    roleId: "scout",
    locationId: "gate",
  });
  assert.equal(state.personalGoals[0].direction, "living");
  // 入世之志(拍板:弧线导演):玩家不填时,从烧制出的创角目录(所求清单)取第一条
  // 作默认——导演从第一回合起就有方向可导,而不是一句空泛套话。
  const catalogMotivation = (world.creationCatalog?.motivations ?? [])[0]?.name;
  assert.ok(catalogMotivation, "创角目录应有所求清单");
  assert.equal(state.personalGoals[0].publicDirection, catalogMotivation);
  assert.equal("entryIntent" in state, false, "意图字段已移除");
});

test("migrateState keeps existing bigFive, picks and defaults entryIntent", () => {
  const legacy = {
    ...createPlayerState(world, { name: "旅人", roleId: "scout", locationId: "gate", motivation: "求道" }),
  };
  legacy.player.bigFive = { openness: 72, conscientiousness: 50, extraversion: 50, agreeableness: 28, neuroticism: 50 };
  legacy.player.bigFivePicks = { openness: ["o-high"] };
  legacy.player.personalityIds = ["cautious"];
  legacy.player.valueIds = [];
  const migrated = migrateState(legacy, world);
  assert.equal(migrated.player.bigFive.openness, 72, "已有分值保留");
  assert.equal(migrated.player.bigFive.agreeableness, 28);
  assert.deepEqual(migrated.player.bigFivePicks.openness, ["o-high"], "底色选择保留");
  assert.equal("personalityIds" in migrated.player, false, "旧字段剥离");
  assert.deepEqual(migrated.bigFiveChanges, []);
});

test("relationship and entity patches are bounded and persistent", () => {
  const state = createPlayerState(world, {
    name: "旅人",
    roleId: "scout",
    locationId: "gate",
    motivation: "寻找线索",
  });
  const next = applyEvolutionPatch(
    state,
    {
      relationships: [{ targetType: "character", targetId: "guide", trust: 1, leverage: -1 }],
      entities: [{ characterId: "guide", status: "captured" }],
    },
    world,
  );
  assert.equal(next.relationships["character:guide"].trust, 1);
  assert.equal(next.entityStates.guide.status, "captured");
  assert.throws(
    () => applyEvolutionPatch(state, { relationships: [{ targetType: "character", targetId: "guide", trust: 3 }] }, world),
    /relationship/,
  );
});

test("creation grants no faction membership (拍板:势力玩法经身份进阶获得)", () => {
  const state = createPlayerState(world, {
    name: "旅人",
    roleId: "scout",
    locationId: "gate",
    motivation: "寻找失踪的家人",
  });
  assert.deepEqual(state.factionMemberships, []);
  assert.equal(state.player.factionId, null);
  // 没有成员记录:势力要求不可用。
  assert.equal(
    optionIsAvailable({ requirements: { factionId: "guild" } }, state, world),
    false,
  );
  // 取得成员记录后(身份进阶/剧情给):普通要求可用,权限要求仍需 authority。
  state.factionMemberships.push({
    id: "membership:guild",
    factionId: "guild",
    authority: [],
    duties: [],
    overdueDutyIds: [],
  });
  assert.equal(
    optionIsAvailable({ requirements: { factionId: "guild" } }, state, world),
    true,
  );
  assert.equal(
    optionIsAvailable(
      { requirements: { factionId: "guild", authority: ["command"] } },
      state,
      world,
    ),
    false,
  );
});

test("legacy states fall back to the player faction when factionId is set", () => {
  // 旧存档兼容:player.factionId 仍被视为出身势力(没有 authority 记录,权限要求不可用)。
  const state = createPlayerState(world, {
    name: "旅人",
    roleId: "scout",
    locationId: "gate",
    motivation: "寻找失踪的家人",
  });
  state.player.factionId = "guild";
  state.factionMemberships = [];
  assert.equal(
    optionIsAvailable({ requirements: { factionId: "guild" } }, state, world),
    true,
  );
  assert.equal(
    optionIsAvailable({ requirements: { factionId: "other" } }, state, world),
    false,
  );
  assert.equal(
    optionIsAvailable(
      { requirements: { factionId: "guild", authority: ["command"] } },
      state,
      world,
    ),
    false,
  );
});

test("legacy state migration supplies a player and location id", () => {
  const migrated = migrateState(
    { turn: 2, location: "gate", unlockedChapter: 1, stats: {}, attributes: {}, conditions: [], resolvedEventIds: [], resolvedThreads: [], retrievalKeywords: [] },
    world,
  );
  assert.equal(migrated.locationId, "gate");
  assert.equal(migrated.player.roleId, "scout");
  assert.deepEqual(migrated.relationships, {});
  assert.deepEqual(migrated.factionMemberships, []);
  assert.equal(migrated.schedulerState.personal.dormantTurns, 0);
});

test("options cannot target undiscovered or dead characters", () => {
  const state = createPlayerState(world, {
    name: "旅人",
    roleId: "scout",
    locationId: "gate",
    motivation: "寻找线索",
  });
  const option = { target: { type: "character", id: "guide" } };
  // 未遇见且不在场:不可指向。
  state.entityStates.guide.locationId = "far-away";
  assert.equal(optionIsAvailable(option, state, world), false);
  // 未遇见但在场(拍板:在场即见):可指向——原著场景里就在眼前的人不受登记限制。
  state.entityStates.guide.locationId = state.locationId;
  assert.equal(optionIsAvailable(option, state, world), true);
  // 已遇见:可指向。
  state.discoveredCharacterIds.push("guide");
  assert.equal(optionIsAvailable(option, state, world), true);
  // 已死:不可指向。
  state.entityStates.guide.status = "dead";
  assert.equal(optionIsAvailable(option, state, world), false);
});

test("motivations dedupe by normalized name and bigFive tolerates bad shapes", () => {
  const dupeWorld = normalizeWorld({
    ...world,
    creationCatalog: {
      bigFive: {
        openness: { id: "o1", name: "先探个究竟", description: "", pole: "high", weight: 1, goodSide: "好奇", badSide: "走神" },
        conscientiousness: [
          { id: "c1", name: "谋定后动", description: "", pole: "high", weight: 1, goodSide: "可靠", badSide: "固执" },
          { id: "c2", name: "随性而行", description: "", pole: "low", weight: 1, goodSide: "随和", badSide: "松散" },
        ],
      },
      motivations: [
        { id: "m1", name: "求真", description: "查明真相" },
        { id: "m2", name: " 求真 ", description: "换汤不换药的重复词条" },
        { id: "m3", name: "活下去", description: "立足" },
      ],
    },
  });
  assert.deepEqual(
    dupeWorld.creationCatalog.motivations.map((item) => item.name),
    ["求真", "活下去"],
    "同名近义词条只保留首次出现者",
  );
  // 单对象维度包成数组,缺省维度补内置通用目录;旧书无 bigFive 时置空并标记。
  assert.deepEqual(
    dupeWorld.creationCatalog.bigFive.openness.map((item) => item.id),
    ["o1"],
    "单对象维度归一为单元素数组",
  );
  assert.equal(Array.isArray(dupeWorld.creationCatalog.bigFive.extraversion), true, "缺失维度回退内置目录");
  // 缺失维度回退内置目录,旧书不再标记(拍板:旧书不需要重新烧治)。
  const legacy = normalizeWorld({ ...world, creationCatalog: { motivations: [] } });
  assert.equal(Array.isArray(legacy.creationCatalog.bigFive.openness), true, "旧目录回退内置通用目录");
  assert.ok(legacy.creationCatalog.bigFive.openness.length >= 2, "兜底目录每维至少两端");
});

test("creationFields options dedupe and details never repeat appearance", () => {
  const dupeWorld = normalizeWorld({
    ...world,
    creationFields: [
      { key: "appearance", label: "外貌", placeholder: "", options: ["衣着朴素", "风尘仆仆", " 衣着朴素 "] },
      { key: "details", label: "个人细节", placeholder: "", options: ["衣着朴素", "带着信物", "带着信物"] },
    ],
  });
  const appearance = dupeWorld.creationFields.find((field) => field.key === "appearance");
  assert.deepEqual(
    appearance.optionsMale,
    ["衣着朴素", "风尘仆仆"],
    "字段内按规范化文本去重(男)",
  );
  assert.deepEqual(
    appearance.optionsFemale,
    ["衣着朴素", "风尘仆仆"],
    "扁平 options 回退为两套共用(女)",
  );
  assert.deepEqual(
    dupeWorld.creationFields.find((field) => field.key === "details").options,
    ["带着信物"],
    "details 不得重复 appearance 候选,字段内重复同样去重",
  );
});

test("world normalization maps localized and semantic stat roles", () => {  const normalized = normalizeWorld({
    ...world,
    stats: [
      { id: "cultivation", name: "修为", role: "修为" },
      { id: "qi", name: "灵力", role: "资源" },
      { id: "favor", name: "宗门好感", role: "好感" },
      { id: "health", name: "气血", role: "生命" },
    ],
  });
  assert.deepEqual(
    normalized.stats.map((stat) => stat.role),
    ["progress", "resource", "relation", "vital"],
  );
});

test("character firstChapter normalizes from 'ch1'/'prologue' to numeric", () => {
  const normalized = normalizeWorld({
    id: "w",
    title: "书",
    locations: ["gate"],
    attributes: [{ id: "focus", name: "专注", initial: 20 }],
    stats: [{ id: "life", name: "生命", role: "vital", min: 0, max: 10, initial: 10 }],
    timeline: [],
    facts: [],
    characters: [
      { id: "a", name: "主角", locationIds: ["gate"], firstChapter: "ch1" },
      { id: "b", name: "配角", locationIds: ["gate"], firstChapter: "ch5" },
      { id: "c", name: "回忆", locationIds: ["gate"], firstChapter: "prologue" },
      { id: "d", name: "末章", locationIds: ["gate"], firstChapter: 12, lastChapter: "ch20" },
    ],
  });
  assert.equal(normalized.characters.find((c) => c.id === "a").firstChapter, 1);
  assert.equal(normalized.characters.find((c) => c.id === "b").firstChapter, 5);
  assert.equal(normalized.characters.find((c) => c.id === "c").firstChapter, 0);
  assert.equal(normalized.characters.find((c) => c.id === "d").lastChapter, 20);
});

test("timeline null array fields fall back to empty arrays", () => {
  // 模型生成的时间线可能把 prerequisites/invalidatedBy/resolutionTargetIds 写成 null，
  // null 会在后续 .some/.every 调用时抛 "Cannot read properties of null"。
  const normalized = normalizeWorld({
    id: "w",
    title: "书",
    locations: ["gate"],
    attributes: [{ id: "focus", name: "专注", initial: 20 }],
    stats: [{ id: "life", name: "生命", role: "vital", min: 0, max: 10, initial: 10 }],
    facts: [],
    timeline: [
      {
        id: "e1",
        time: 60,
        text: "事件",
        location: "gate",
        chapterAnchor: 1,
        prerequisites: null,
        invalidatedBy: null,
        resolutionTargetIds: null,
      },
    ],
  });
  const event = normalized.timeline[0];
  assert.deepEqual(event.prerequisites, []);
  assert.deepEqual(event.invalidatedBy, []);
  assert.deepEqual(event.resolutionTargetIds, []);
});

test("trait requirements gate on traits owned by the identity", () => {
  const traits = [{ id: "spirit-root", name: "灵根", value: "木火双灵根", description: "" }];
  const traitWorld = normalizeWorld({
    ...world,
    traits,
    roleTemplates: [
      { id: "scout", name: "斥候", locationIds: ["gate"], factionIds: ["guild"], traitIds: ["spirit-root"] },
    ],
  });
  const state = createPlayerState(traitWorld, {
    name: "旅人",
    roleId: "scout",
    locationId: "gate",
    motivation: "求道",
  });
  assert.deepEqual(state.player.traitIds, ["spirit-root"]);
  assert.equal(
    optionIsAvailable(
      { requirements: { traits: [{ id: "spirit-root" }] } },
      state,
      traitWorld,
    ),
    true,
    "身份蕴含的特质放行",
  );
  // 旧语义漏洞:世界特质表里有,但玩家身份不蕴含 → 必须拦截。
  const plainWorld = normalizeWorld({ ...world, traits });
  const plainState = createPlayerState(plainWorld, {
    name: "旅人",
    roleId: "scout",
    locationId: "gate",
    motivation: "求道",
  });
  assert.equal(
    optionIsAvailable(
      { requirements: { traits: [{ id: "spirit-root" }] } },
      plainState,
      plainWorld,
    ),
    false,
    "世界表里有该特质,但身份不蕴含 → 不放行",
  );
  assert.equal("spirit-root" in state.attributes, false);
});

test("性格门控已取消:bigFive 需求不再约束选项,职权门控照常", () => {
  const state = createPlayerState(world, {
    name: "旅人",
    roleId: "scout",
    locationId: "gate",
    motivation: "寻找线索",
  });
  state.factionMemberships.push({
    id: "guild-scout",
    factionId: "guild",
    authority: ["inspect"],
    duties: [],
    overdueDutyIds: [],
  });
  // 拍板「选项即意图」:人格维度不再作为门槛,声明了也一律放行。
  assert.equal(
    optionIsAvailable(
      {
        requirements: {
          bigFive: { openness: { min: 60 } },
          factionId: "guild",
          authority: ["inspect"],
        },
      },
      state,
      world,
    ),
    true,
  );
  assert.equal(
    optionIsAvailable({ requirements: { bigFive: { openness: { min: 90 } } } }, state, world),
    true,
  );
  assert.equal(
    optionIsAvailable({ requirements: { excludedBigFive: { agreeableness: { max: 30 } } } }, state, world),
    true,
  );
  assert.equal(
    optionIsAvailable({ requirements: { bigFive: { openness: {} } } }, state, world),
    true,
  );
  // 职权门控照常:没有 command 职权就不放行。
  assert.equal(
    optionIsAvailable(
      { requirements: { factionId: "guild", authority: ["command"] } },
      state,
      world,
    ),
    false,
  );
});

test("roleProgression 列表字段容忍模型 JSON 的非数组形状", () => {
  // 模型输出形状不稳:modifiers 写成字符串、refusalModifiers/triggerEvents 写成单对象、
  // prerequisites.factionIds 写成字符串、roleProgression 整条写成单对象。
  // 此前 (path.modifiers ?? []).map 会在烧制中途抛 TypeError,烧制整体失败。
  const normalized = normalizeWorld({
    id: "w",
    title: "书",
    locations: ["gate"],
    factions: [],
    characters: [],
    attributes: [{ id: "focus", name: "专注", initial: 20 }],
    stats: [{ id: "life", name: "生命", role: "vital", min: 0, max: 10, initial: 10 }],
    timeline: [],
    facts: [],
    roleTemplates: [
      { id: "scout", name: "斥候", locationIds: ["gate"], factionIds: [] },
      { id: "ranger", name: "巡林人", locationIds: ["gate"], factionIds: [] },
    ],
    roleProgression: {
      id: "p1",
      fromRoleId: "scout",
      toRoleId: "ranger",
      modifiers: "focus+5",
      refusalModifiers: { attributeId: "focus", delta: -2 },
      triggerEvents: { id: "t1", name: "机缘", description: "机缘" },
      prerequisites: { factionIds: "guild" },
    },
  });
  const path = normalized.roleProgression[0];
  assert.equal(path.id, "p1");
  assert.deepEqual(path.modifiers, [], "字符串 modifiers 视为空列表");
  assert.deepEqual(path.refusalModifiers, [{ attributeId: "focus", delta: -2 }], "单对象包成单元素数组");
  assert.deepEqual(path.triggerEvents.map((event) => event.id), ["t1"]);
  assert.deepEqual(path.prerequisites.factionIds, [], "字符串 factionIds 视为空列表");
});

// —— 游玩模式(拍板:爽文/原味已移除,推演靠玩家意图驱动的动态选项)+ 自动身份/境界/势力 ——

test("建角身份与地点解耦,优先无地点绑定的通用来路", () => {
  const autoWorld = normalizeWorld({
    id: "auto",
    title: "书",
    characters: [],
    locations: ["gate", "tower"],
    factions: [{ id: "guild", name: "公会" }],
    attributes: [{ id: "focus", name: "专注", initial: 20 }],
    stats: [{ id: "life", name: "生命", role: "vital", min: 0, max: 10, initial: 10 }],
    timeline: [],
    facts: [],
    roleTemplates: [
      { id: "porter", name: "码头力工", locationIds: ["gate"], factionIds: [] },
      { id: "heir", name: "商会少主", locationIds: ["tower"], factionIds: ["guild"], abilities: ["调阅账册"], statMods: { life: 2 } },
      { id: "scout", name: "斥候", locationIds: ["gate"], factionIds: ["guild"], abilities: ["夜行"], authority: ["inspect"] },
      { id: "wanderer", name: "行脚游方", locationIds: [], factionIds: [] },
    ],
  });
  // 玩家三律(拍板:落点只是首次登场之处,不是身份):scratch 不按所选地点挑身份,
  // 优先与任何地方无绑定的通用平朴来路——即使「码头力工」惯常于落点。
  const scratch = createPlayerState(autoWorld, {
    name: "阿青",
    gender: "male",
    locationId: "gate",
    playMode: "power",
    startingPoint: "scratch",
  });
  assert.equal(scratch.player.roleId, "wanderer", "无地点绑定的通用来路优先于落点惯常身份");
  // 拍板:模式与起点已移除——显式传入 power/scratch 也一律归一纯规则 classic。
  assert.equal(scratch.playMode, "classic");
  assert.equal(scratch.player.factionId, null, "开局不绑定势力");
  assert.deepEqual(scratch.player.abilities, []);

  // 目录全空:合成无名之辈,不写回世界目录。
  const emptyWorld = normalizeWorld({
    id: "empty",
    title: "书",
    characters: [],
    locations: ["gate"],
    factions: [],
    attributes: [{ id: "focus", name: "专注", initial: 20 }],
    stats: [{ id: "life", name: "生命", role: "vital", min: 0, max: 10, initial: 10 }],
    timeline: [],
    facts: [],
    roleTemplates: [],
  });
  const plain = createPlayerState(emptyWorld, { name: "路人", gender: "female", locationId: "gate" });
  assert.equal(plain.player.roleName, "无名之辈");
  assert.deepEqual(plain.player.abilities, []);
  assert.equal(emptyWorld.roleTemplates.length, 1, "归一化的目录兜底项仍在,合成身份不入目录");
});

test("玩家姓名不得属于或包含原著人物(玩家三律:原著不存在)", () => {
  const namedWorld = normalizeWorld({
    id: "named",
    title: "书",
    characters: [{ id: "c1", name: "林雾", role: "守灯人" }],
    locations: ["gate"],
    factions: [],
    attributes: [{ id: "focus", name: "专注", initial: 20 }],
    stats: [{ id: "life", name: "生命", role: "vital", min: 0, max: 10, initial: 10 }],
    timeline: [],
    facts: [],
    roleTemplates: [{ id: "wanderer", name: "行脚游方", locationIds: [], factionIds: [] }],
  });
  assert.throws(
    () => createPlayerState(namedWorld, { name: "林雾", gender: "female", locationId: "gate" }),
    /原著中的任何人/,
    "与原著人物重名直接拒收",
  );
  assert.throws(
    () => createPlayerState(namedWorld, { name: "林雾舟", gender: "female", locationId: "gate" }),
    /原著中的任何人/,
    "包含原著人物姓名的近似名同样拒收",
  );
  assert.throws(
    () => createPlayerState(namedWorld, { name: "主角", gender: "female", locationId: "gate" }),
    /原著中的任何人/,
    "叙述标签不算名字",
  );
  // 不相干的名字照常通过。
  const ok = createPlayerState(namedWorld, { name: "阿禾", gender: "female", locationId: "gate" });
  assert.equal(ok.player.name, "阿禾");
});

test("建角模式与起点已移除:天花板输入一律回落,身份取最朴素通用来路,境界由用户自选", () => {
  const ceilingWorld = normalizeWorld({
    id: "ceiling",
    title: "书",
    characters: [],
    locations: ["gate"],
    factions: [{ id: "sect", name: "天剑宗" }],
    traits: [
      { id: "r-low", name: "练气期", value: "吐纳", description: "境界阶梯:第一阶" },
      { id: "r-high", name: "化神期", value: "神识万里", description: "境界阶梯:最高阶" },
    ],
    attributes: [{ id: "focus", name: "神识", initial: 20 }],
    stats: [{ id: "life", name: "生命", role: "vital", min: 0, max: 10, initial: 10 }],
    timeline: [],
    facts: [],
    roleTemplates: [
      { id: "servant", name: "杂役", locationIds: ["gate"], factionIds: [] },
      {
        id: "elder",
        name: "太上长老",
        locationIds: ["gate"],
        factionIds: ["sect"],
        abilities: ["御剑万里", "神识扫山"],
        authority: ["command", "manage"],
        traitIds: ["r-high"],
        statMods: { life: 5 },
      },
    ],
  });
  // 拍板:爽文/原味模式与天花板/从头起点已全部移除——显式传 power+ceiling 也照纯规则:
  // 身份取「无能力/修正/职权」的最朴素通用来路,不再给最强背景,开局不绑势力。
  const ceiling = createPlayerState(ceilingWorld, {
    name: "剑主",
    gender: "male",
    locationId: "gate",
    playMode: "power",
    startingPoint: "ceiling",
  });
  assert.equal(ceiling.playMode, "classic", "power 输入归一为纯规则");
  assert.equal(ceiling.player.roleId, "servant", "天花板不再给最强通用背景");
  assert.equal(ceiling.player.factionId, null, "开局不绑势力");
  assert.equal(ceiling.factionMemberships.length, 0);
  // 境界只认用户显式自选:最高档照给(高低不限)。
  const selfPicked = createPlayerState(ceilingWorld, {
    name: "剑主",
    gender: "male",
    locationId: "gate",
    realmTraitId: "r-high",
  });
  assert.ok(selfPicked.player.traitIds.includes("r-high"), "境界由用户自选,最高档也可");
  // 未选境界:回落身份惯常档;杂役无惯常档则最低档。
  const defaulted = createPlayerState(ceilingWorld, {
    name: "书客",
    gender: "male",
    locationId: "gate",
  });
  assert.equal(defaulted.player.roleId, "servant");
  assert.ok(defaulted.player.traitIds.includes("r-low"), "未选境界回落最低档");
  assert.equal(defaulted.player.factionId, null);
});

test("旧档迁移补默认模式字段,非法组合回落", () => {
  const legacy = migrateState(
    {
      turn: 1,
      location: "gate",
      locationId: "gate",
      player: { id: "player", name: "旧人", roleId: "scout", roleName: "斥候" },
      stats: { life: 5 },
      attributes: { focus: 20 },
    },
    world,
  );
  assert.equal(legacy.playMode, "classic", "旧档缺省纯规则");
  assert.equal(legacy.startingPoint, "scratch");
  const powered = migrateState(
    { ...legacy, playMode: "power", startingPoint: "ceiling" },
    world,
  );
  assert.equal(powered.playMode, "power");
  assert.equal(powered.startingPoint, "ceiling");
  const bad = migrateState(
    { ...legacy, playMode: "classic", startingPoint: "ceiling" },
    world,
  );
  assert.equal(bad.playMode, "classic");
  assert.equal(bad.startingPoint, "scratch", "非爽文档强制 scratch");
});

test("身份进阶数值门槛:新档按原值;旧爽文档沿用 50% 折算,势力前提不放松", () => {
  const progWorld = normalizeWorld({
    id: "prog",
    title: "书",
    characters: [],
    locations: ["gate"],
    factions: [{ id: "sect", name: "宗门" }],
    attributes: [{ id: "focus", name: "神识", initial: 10 }],
    stats: [{ id: "cult", name: "修为", role: "progress", min: 0, max: 100, initial: 0 }],
    timeline: [],
    facts: [],
    roleTemplates: [{ id: "outer", name: "外门弟子", locationIds: ["gate"], factionIds: ["sect"] }],
    roleProgression: [
      {
        id: "p1",
        fromRoleId: "outer",
        toRoleId: "inner",
        triggerEvents: [{ id: "t1", name: "机缘", description: "机缘" }],
        prerequisites: {
          statMinimums: { cult: 40 },
          attributeMinimums: { focus: 20 },
          factionIds: ["sect"],
        },
        modifiers: [],
        refusalModifiers: [],
      },
    ],
  });
  const base = { name: "弟子", gender: "male", locationId: "gate" };
  // 新档(拍板:模式已移除):一律纯规则,门槛照原值——25/15 不达 40/20。
  const fresh = createPlayerState(progWorld, {
    ...base,
    playMode: "power",
    startingPoint: "scratch",
    factionId: "sect",
  });
  assert.equal(fresh.playMode, "classic", "建角显式传 power 也归一纯规则");
  fresh.stats.cult = 25;
  fresh.attributes.focus = 15;
  assert.equal(eligibleProgression(progWorld, fresh).length, 0, "纯规则:门槛照原值");

  // 旧爽文存档(playMode=power 由 migrateState 保留):沿用 50% 折算——40→20、20→10。
  const legacyPower = createPlayerState(progWorld, { ...base, factionId: "sect" });
  legacyPower.playMode = "power";
  legacyPower.startingPoint = "scratch";
  legacyPower.stats.cult = 25;
  legacyPower.attributes.focus = 15;
  assert.equal(eligibleProgression(progWorld, legacyPower).length, 1, "旧爽文档:40→20、20→10,均达标");

  const noFaction = { ...legacyPower, player: { ...legacyPower.player, factionId: null } };
  assert.equal(eligibleProgression(progWorld, noFaction).length, 0, "势力前提不放松");
});

// —— 玩家成长三补丁的建档与迁移（拍板 2026-08-19：具名行囊/技能习得/境界突破） ——

test("建档起步：行囊/习得/突破履历皆为空数组", () => {
  const state = createPlayerState(world, { name: "旅人", roleId: "scout", locationId: "gate" });
  assert.deepEqual(state.player.inventory, []);
  assert.deepEqual(state.player.learnedAbilities, []);
  assert.deepEqual(state.player.realmHistory, []);
  // 关系簿口径(拍板 2026-08-20:只认有交集):开局关系账本为空——
  // 在场预填只进 discovered(上下文/舆图口径),打过交道才有 relationships 条目。
  assert.deepEqual(state.relationships, {});
});

test("旧档迁移：缺行囊/习得/突破字段补空数组", () => {
  const legacy = createPlayerState(world, { name: "旅人", roleId: "scout", locationId: "gate" });
  delete legacy.player.inventory;
  delete legacy.player.learnedAbilities;
  delete legacy.player.realmHistory;
  const migrated = migrateState(legacy, world);
  assert.deepEqual(migrated.player.inventory, []);
  assert.deepEqual(migrated.player.learnedAbilities, []);
  assert.deepEqual(migrated.player.realmHistory, []);
});

test("换身份不倒退境界：applyRoleIdentity 保留已修到的更高阶", () => {
  const ladderWorld = normalizeWorld({
    id: "ladder",
    title: "书",
    characters: [],
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
    attributes: [],
    stats: [],
    timeline: [],
    facts: [],
  });
  const demote = createPlayerState(ladderWorld, { name: "旅人", roleId: "scout", locationId: "gate" });
  // 玩家已突破到金丹。
  demote.player.traitIds = ["t-jindan"];
  const demoted = applyRoleIdentity(demote, ladderWorld.roleTemplates[0], ladderWorld);
  assert.deepEqual(demoted.player.traitIds, ["t-jindan"], "进到低境界的身份,修为仍在");
  // 身份带更高境界时照常用身份的（玩家没有更高修为可保）。
  const fresh = createPlayerState(ladderWorld, { name: "旅人", roleId: "scout", locationId: "gate" });
  const promoted = applyRoleIdentity(fresh, ladderWorld.roleTemplates[1], ladderWorld);
  assert.deepEqual(promoted.player.traitIds, ["t-zhuji"]);
});

// —— 反向建角（拍板 2026-08-20：一页模板红字直改，意图即人设）——

// 提案校验的测试世界：有境界阶梯、有性别限定身份、有原著人物「引路人」。
const proposalWorld = normalizeWorld({
  id: "proposal",
  title: "书",
  characters: [{ id: "guide", name: "引路人", locationIds: ["gate"], firstChapter: 1 }],
  locations: ["gate", "tower"],
  traits: [
    { id: "t-lianqi", name: "练气期", value: "第一阶" },
    { id: "t-zhuji", name: "筑基期", value: "第二阶" },
  ],
  roleTemplates: [
    { id: "scout", name: "斥候", locationIds: [] },
    { id: "nun", name: "庵中尼姑", gender: "female", locationIds: [] },
    { id: "bound", name: "引路人之徒", locationIds: [] },
  ],
  attributes: [],
  stats: [],
  timeline: [],
  facts: [],
});

test("空所愿的锚:创角目录所求清单第一条", () => {
  const catalogWorld = normalizeWorld({
    ...proposalWorld,
    creationCatalog: { motivations: [{ id: "m1", name: "" }, { id: "m2", name: "寻一门安身手艺" }] },
  });
  assert.equal(defaultMotivationOf(catalogWorld), "寻一门安身手艺");
  // normalizeWorld 会给空目录填默认所求(第一条「先活下去」)——锚永远存在。
  assert.equal(defaultMotivationOf(proposalWorld), "先活下去");
});

test("来历入档:定约写定的白描落在 player.background,守卫拦截撞名与超长", () => {
  const state = createPlayerState(proposalWorld, {
    name: "李拾",
    roleId: "scout",
    locationId: "gate",
    motivation: "挣出基业",
    background: "自北边来的脚夫，一路做工南下。",
  });
  assert.equal(state.player.background, "自北边来的脚夫，一路做工南下。");
  assert.throws(
    () =>
      createPlayerState(proposalWorld, {
        name: "李拾",
        locationId: "gate",
        background: "曾与引路人结伴同行。",
      }),
    /来历不得使用原著人物的称呼或描述/,
  );
  assert.throws(
    () =>
      createPlayerState(proposalWorld, {
        name: "李拾",
        locationId: "gate",
        background: "一".repeat(151),
      }),
    /来历至多 150 个字符/,
  );
});

test("另写来路:目录外的来路按零能力身份合成,牙齿永远来自目录", () => {
  const state = createPlayerState(proposalWorld, {
    name: "李拾",
    locationId: "gate",
    customRoleName: "游方货郎",
  });
  assert.equal(state.player.roleName, "游方货郎");
  assert.equal(state.player.roleHistory[0].roleName, "游方货郎");
  assert.deepEqual(state.player.abilities ?? [], []);
  assert.throws(
    () =>
      createPlayerState(proposalWorld, { name: "李拾", locationId: "gate", customRoleName: "引路人" }),
    /来路绑着原著中的人/,
  );
  assert.throws(
    () =>
      createPlayerState(proposalWorld, {
        name: "李拾",
        locationId: "gate",
        customRoleName: "一二三四五六七八九十啊",
      }),
    /另写的来路至多 10 个字/,
  );
});

