import assert from "node:assert/strict";
import test from "node:test";

import {
  applyCatalogCoherence,
  diagnoseWorld,
  fallbackWorldCore,
  mechanicallyRepairWorld,
  normalizeWorldDraft,
  sanitizeEventFactChanges,
  sanitizeRoleCapabilities,
  selectBetterWorldDraft,
  unwrapWorldDraft,
} from "../src/world-repair.js";
import { normalizeWorld } from "../src/evolution.js";

function draft(overrides = {}) {
  return {
    id: "cultivation",
    title: "修真录",
    summary: "入世修行",
    characters: [],
    factions: [],
    roleTemplates: [
      { id: "outsider", name: "散修", description: "无门无派的独行修士", locationIds: ["gate"], factionIds: [] },
      { id: "disciple", name: "内门弟子", description: "山门登记在册的弟子", locationIds: ["gate"], factionIds: [] },
      { id: "elder", name: "外事长老", description: "替山门在外行走的长老", locationIds: ["gate"], factionIds: [] },
    ],
    locations: [{ id: "gate", name: "山门", connections: [] }],
    attributes: [
      { id: "spirit-root", name: "灵根", initial: "木火双灵根", description: "亲火木术法" },
      { id: "insight", name: "悟性", initial: "30" },
    ],
    traits: [],
    stats: [
      { id: "cultivation", name: "修为", role: "修为", min: "0", max: "100", initial: "10" },
    ],
    timeline: [],
    facts: [{ id: "fact-1", text: "山门在北", chapterAnchor: 1 }],
    ...overrides,
  };
}

test("world draft normalization moves categorical attributes to traits and parses numbers", () => {  const world = normalizeWorldDraft(draft());
  assert.deepEqual(world.attributes, [{ id: "insight", name: "悟性", initial: 30 }]);
  assert.deepEqual(world.traits, [
    {
      id: "spirit-root",
      name: "灵根",
      value: "木火双灵根",
      description: "亲火木术法",
    },
  ]);
  assert.deepEqual(world.stats[0], {
    id: "cultivation",
    name: "修为",
    role: "progress",
    min: 0,
    max: 100,
    initial: 10,
  });
});

test("world diagnosis reports all independent errors in one pass", () => {
  const { errors } = diagnoseWorld(
    draft({
      locations: [
        { id: "gate", name: "山门", connections: ["missing"] },
        { id: "gate", name: "后山", connections: [] },
      ],
      attributes: [{ id: "power", name: "法术强度", initial: "未知" }],
      stats: [{ id: "life", name: "生命", role: "vital", min: 10, max: 1, initial: 20 }],
      characters: [{ id: "hero", name: "甲", factionId: "missing", locationIds: ["nowhere"] }],
      facts: [{ id: "fact", text: "事实", chapterAnchor: 0 }],
    }),
  );
  const codes = new Set(errors.map((item) => item.code));
  assert.ok(codes.has("duplicate_id"));
  assert.ok(codes.has("unknown_reference"));
  assert.ok(codes.has("invalid_number"));
  assert.ok(codes.has("invalid_range"));
  assert.ok(codes.has("out_of_range"));
  assert.ok(codes.has("invalid_anchor"));
  // vital 状态没给 zeroConsequence 也要报出来（否则耗尽时 conditions 挂不进后果文案）。
  assert.ok(codes.has("missing_value"));
  assert.ok(errors.length >= 7);
});

test("world diagnosis demands zeroConsequence for vital stats", () => {
  const bare = diagnoseWorld({
    id: "w",
    title: "t",
    locations: [{ id: "l", name: "地" }],
    attributes: [{ id: "a", name: "能", initial: 1 }],
    stats: [{ id: "life", name: "生命", role: "vital", min: 0, max: 10, initial: 5 }],
    timeline: [],
    facts: [],
  });
  assert.ok(bare.errors.some((item) => item.path === "stats[0].zeroConsequence"));
  const complete = diagnoseWorld({
    id: "w",
    title: "t",
    locations: [{ id: "l", name: "地" }],
    attributes: [{ id: "a", name: "能", initial: 1 }],
    stats: [
      { id: "life", name: "生命", role: "vital", min: 0, max: 10, initial: 5, zeroConsequence: "昏迷" },
    ],
    timeline: [],
    facts: [],
  });
  assert.ok(!complete.errors.some((item) => item.path.includes("zeroConsequence")));
});

test("world repair unwraps common model response envelopes", () => {
  assert.equal(unwrapWorldDraft({ world: draft() }).id, "cultivation");
  assert.equal(unwrapWorldDraft({ result: { world: draft() } }).id, "cultivation");
});

test("world repair rejects candidates that lose core fields", () => {
  const current = draft({
    attributes: [{ id: "power", name: "法术强度", initial: "未知" }],
    locations: [{ id: "gate", name: "山门", connections: ["missing"] }],
  });
  const selection = selectBetterWorldDraft(current, {});

  assert.equal(selection.accepted, false);
  assert.equal(selection.diagnosis.world.id, "cultivation");
});

test("world repair accepts a wrapped candidate with fewer errors", () => {
  const current = draft({
    attributes: [{ id: "power", name: "法术强度", initial: "未知" }],
  });
  const proposed = draft({
    attributes: [{ id: "insight", name: "悟性", initial: 30 }],
  });
  const selection = selectBetterWorldDraft(current, { world: proposed });

  assert.equal(selection.accepted, true);
  assert.equal(selection.diagnosis.errors.length, 0);
});

test("world repair rejects candidates that delete content to pass", () => {
  const characters = Array.from({ length: 6 }, (_, index) => ({
    id: "char-" + index,
    name: "角色" + index,
  }));
  const current = draft({
    characters,
    attributes: [{ id: "power", name: "法术强度", initial: "未知" }],
  });
  // 错误更少，但把全部人物删光：内容守恒不通过，拒绝。
  const gutted = draft({ characters: [], attributes: [{ id: "insight", name: "悟性", initial: 30 }] });
  const selection = selectBetterWorldDraft(current, { world: gutted });

  assert.equal(selection.accepted, false);
  assert.equal(selection.diagnosis.world.characters.length, 6);
});

test("mechanical repair dedupes duplicate ids deterministically", () => {
  const world = mechanicallyRepairWorld(
    {
      id: "w",
      title: "凡人修仙传",
      locations: [{ id: "gate", name: "山门", connections: [] }],
      attributes: [{ id: "insight", name: "悟性", initial: 30 }],
      stats: [
        { id: "life", name: "生命", role: "vital", min: 0, max: 10, initial: 10, zeroConsequence: "昏迷" },
      ],
      items: [
        { id: "bottle", name: "小瓶", locationIds: ["gate"] },
        { id: "bottle", name: "另一个小瓶", locationIds: ["gate"] },
        { id: "", name: "无名物", locationIds: ["gate"] },
      ],
      timeline: [],
      facts: [],
    },
    { title: "凡人修仙传" },
  );
  const ids = world.items.map((item) => item.id);
  assert.equal(new Set(ids).size, ids.length, "去重后物品 ID 必须唯一");
  assert.equal(ids[0], "bottle", "第一次出现的 ID 原样保留");
  assert.ok(ids[1].startsWith("bottle-"), "重复 ID 加后缀");
  assert.ok(ids[2].length > 0, "空 ID 也要补出可用标识");
  const diagnosis = diagnoseWorld(world);
  assert.ok(!diagnosis.errors.some((item) => item.code === "duplicate_id"));
});

test("mechanical repair fills missing world id and title from book metadata", () => {
  const world = mechanicallyRepairWorld(
    {
      locations: [{ id: "gate", name: "山门", connections: [] }],
      attributes: [{ id: "insight", name: "悟性", initial: 30 }],
      stats: [
        { id: "life", name: "生命", role: "vital", min: 0, max: 10, initial: 10, zeroConsequence: "昏迷" },
      ],
      timeline: [],
      facts: [],
    },
    { title: "凡人修仙传" },
  );
  assert.equal(world.title, "凡人修仙传");
  assert.ok(world.id.length > 0);
});

test("身份目录绑定原著人物时报 character_bound_role,绑定标签不计入覆盖要求", () => {
  const characters = [
    { id: "han", name: "韩立", role: "主角", factionId: null, locationIds: ["gate"], firstChapter: 1 },
    { id: "nangong", name: "南宫婉", role: "韩立道侣", factionId: null, locationIds: ["gate"], firstChapter: 1 },
    { id: "yun", name: "云游散人", role: "游方郎中", factionId: null, locationIds: ["gate"], firstChapter: 1 },
  ];
  const bound = diagnoseWorld(
    draft({
      characters,
      roleTemplates: [
        { id: "r1", name: "主角", description: "本书主角", locationIds: [], factionIds: [] },
        { id: "r2", name: "韩立道侣", description: "主角道侣", locationIds: [], factionIds: [] },
        { id: "r3", name: "散修", description: "独行修士", locationIds: [], factionIds: [] },
      ],
    }),
  );
  assert.equal(
    bound.errors.filter((item) => item.code === "character_bound_role").length,
    2,
    "「主角」与「韩立道侣」都应被标记为绑定原著人物",
  );
  // 覆盖校验剔除绑定标签:只剩「游方郎中」一个泛型角色未覆盖(上限 2),不再报 uncovered_role。
  assert.ok(!bound.errors.some((item) => item.code === "uncovered_role"));

  // 泛型角色未覆盖超过 2 个时仍报。
  const generic = diagnoseWorld(
    draft({
      characters: [
        { id: "a", name: "甲", role: "医师", factionId: null, locationIds: ["gate"], firstChapter: 1 },
        { id: "b", name: "乙", role: "镖师", factionId: null, locationIds: ["gate"], firstChapter: 1 },
        { id: "c", name: "丙", role: "掌柜", factionId: null, locationIds: ["gate"], firstChapter: 1 },
      ],
      roleTemplates: [
        { id: "r1", name: "散修", description: "独行修士", locationIds: [], factionIds: [] },
        { id: "r2", name: "杂役", description: "山门杂役", locationIds: [], factionIds: [] },
        { id: "r3", name: "长老", description: "门中长老", locationIds: [], factionIds: [] },
      ],
    }),
  );
  assert.ok(generic.errors.some((item) => item.code === "uncovered_role"));
});

test("外貌选项点名原著人物、太短或数量不足时被标记", () => {
  const result = diagnoseWorld(
    draft({
      characters: [
        { id: "han", name: "韩立", role: "散修", factionId: null, locationIds: ["gate"], firstChapter: 1 },
      ],
      creationFields: [
        {
          key: "appearance",
          label: "外貌",
          placeholder: "一眼可见的模样",
          options: ["风尘仆仆", "韩立道侣", "你", "带伤而来"],
        },
      ],
    }),
  );
  const codes = new Set(result.errors.map((item) => item.code));
  assert.ok(codes.has("character_bound_option"), "「韩立道侣」点名原著人物");
  assert.ok(codes.has("bad_option_length"), "「你」不足 2 字");
  // 可用选项只剩 道友/前辈 两个,不足 4 个。
  assert.ok(codes.has("too_few_options"));
});

test("个人细节与身份重名会被标记,pronoun 已从合法字段移除", () => {
  const result = diagnoseWorld(
    draft({
      characters: [
        { id: "han", name: "韩立", role: "散修", factionId: null, locationIds: ["gate"], firstChapter: 1 },
      ],
      creationFields: [
        {
          key: "pronoun",
          label: "称谓",
          placeholder: "旁人对你的称呼",
          options: ["道友", "前辈", "少侠", "姑娘"],
        },
        {
          key: "details",
          label: "个人细节",
          placeholder: "补充你的背景或特征",
          options: ["散修", "带着一件信物", "躲避着什么", "初到此地"],
        },
      ],
    }),
  );
  const codes = new Set(result.errors.map((item) => item.code));
  assert.ok(codes.has("details_role_overlap"), "「散修」与身份目录重名");
  // pronoun 已从合法字段移除:归一化时静默剥离,不再进入任何 UI 或校验。
  const normalized = normalizeWorld(
    draft({
      creationFields: [
        { key: "pronoun", label: "称谓", options: ["道友", "前辈"] },
        { key: "appearance", label: "外貌" },
      ],
    }),
  );
  assert.ok(
    !normalized.creationFields.some((field) => field?.key === "pronoun"),
    "pronoun 字段在归一化时被剥离",
  );
  assert.ok(normalized.creationFields.some((field) => field?.key === "appearance"));
});

test("机械修复丢弃绑定原著人物的身份并按 name 去重", () => {
  const characters = [
    { id: "han", name: "韩立", role: "散修", factionId: null, locationIds: [], firstChapter: 1 },
  ];
  const repaired = mechanicallyRepairWorld(
    draft({
      characters,
      roleTemplates: [
        { id: "r1", name: "主角", description: "本书主角", locationIds: [], factionIds: [] },
        { id: "r2", name: "韩立道侣", description: "主角道侣", locationIds: [], factionIds: [] },
        { id: "r3", name: "散修", description: "无门无派", locationIds: [], factionIds: [] },
        { id: "r4", name: "散修", description: "独行修士", locationIds: [], factionIds: [] },
        { id: "r5", name: "长老", description: "门中长老", locationIds: [], factionIds: [] },
      ],
    }),
    { title: "修真录" },
  );
  assert.deepEqual(
    repaired.roleTemplates.map((role) => role.name),
    ["散修", "长老"],
    "绑定身份丢弃、同名身份只留首个",
  );
});

test("身份目录上限放宽到 40:全书覆盖不再被 too_many 拦下", () => {
  const many = Array.from({ length: 30 }, (_, index) => ({
    id: `role-${index}`,
    name: `身份${index}`,
    description: "什么来路、能做什么、有何限制",
    locationIds: [],
    factionIds: [],
    firstChapter: 1 + Math.floor(index / 3),
  }));
  const ok = diagnoseWorld(draft({ roleTemplates: many }));
  assert.ok(!ok.errors.some((item) => item.code === "too_many"), "30 个身份应在允许范围内");

  const tooMany = Array.from({ length: 41 }, (_, index) => ({
    id: `role-${index}`,
    name: `身份${index}`,
    description: "什么来路、能做什么、有何限制",
    locationIds: [],
    factionIds: [],
    firstChapter: 1,
  }));
  const over = diagnoseWorld(draft({ roleTemplates: tooMany }));
  assert.ok(over.errors.some((item) => item.code === "too_many"), "41 个身份应触发防灌水上限");
});

test("创角词条在草稿归一化时去重且不产生诊断错误", () => {
  const world = normalizeWorldDraft(
    draft({
      creationFields: [
        { key: "appearance", label: "外貌", options: ["衣着朴素", "衣着朴素", "风尘仆仆", "干净利落", "带伤而来"] },
        { key: "details", label: "细节", options: ["衣着朴素", "带着信物", "躲避着什么", "初到此地", "口音古怪"] },
      ],
    }),
  );
  const appearance = world.creationFields.find((field) => field.key === "appearance");
  assert.deepEqual(
    appearance.optionsMale,
    ["衣着朴素", "风尘仆仆", "干净利落", "带伤而来"],
    "字段内重复候选被静默去重(男)",
  );
  assert.deepEqual(
    appearance.optionsFemale,
    ["衣着朴素", "风尘仆仆", "干净利落", "带伤而来"],
    "旧书扁平 options 回退为两套共用(女)",
  );
  assert.deepEqual(
    world.creationFields.find((field) => field.key === "details").options,
    ["带着信物", "躲避着什么", "初到此地", "口音古怪"],
    "与外貌重复的候选从细节剔除",
  );
  const diagnosis = diagnoseWorld(world);
  assert.ok(
    !diagnosis.errors.some((item) => item.path?.startsWith("creationFields")),
    "去重本身不该产生诊断错误",
  );
});

test("applyCatalogCoherence removes near-dupes and keeps both poles", () => {
  const world = draft();
  const dim = (dupId) => [
    { id: "o-high-1", name: "先探个究竟", description: "x", pole: "high", weight: 1, goodSide: "好", badSide: "坏" },
    { id: "o-high-2", name: "乐意换条新路", description: "x", pole: "high", weight: 1, goodSide: "好", badSide: "坏" },
    { id: "o-low-1", name: "先求稳妥", description: "x", pole: "low", weight: 1, goodSide: "好", badSide: "坏" },
    ...(dupId ? [{ id: dupId, name: "果敢", description: "x", pole: "high", weight: 1, goodSide: "好", badSide: "坏" }] : []),
  ];
  world.creationCatalog = {
    bigFive: {
      openness: dim("dup"),
      conscientiousness: dim(),
      extraversion: dim(),
      agreeableness: dim(),
      neuroticism: dim(),
    },
    motivations: Array.from({ length: 6 }, (_, index) => ({ id: `m${index}`, name: `动机${index}`, description: "x" })),
  };
  const next = applyCatalogCoherence(world, { removeIds: ["dup", "ghost-id"] });
  const openness = next.creationCatalog.bigFive.openness;
  assert.ok(!openness.some((item) => item.id === "dup"), "近义重复词条被移除");
  assert.ok(!openness.some((item) => item.id === "ghost-id"), "不存在的 id 直接忽略");
  assert.ok(openness.some((item) => item.pole === "high"), "high 端保留");
  assert.ok(openness.some((item) => item.pole === "low"), "low 端保留");

  // 只删 high 端重复但会破坏两端保底时,放弃删除(每维至少两端各 1 项)。
  const fragile = draft();
  fragile.creationCatalog = {
    bigFive: {
      openness: [
        { id: "h1", name: "唯一高", description: "x", pole: "high", weight: 1, goodSide: "好", badSide: "坏" },
        { id: "l1", name: "唯一低", description: "x", pole: "low", weight: 1, goodSide: "好", badSide: "坏" },
      ],
    },
  };
  const kept = applyCatalogCoherence(fragile, { removeIds: ["h1"] });
  assert.deepEqual(
    kept.creationCatalog.bigFive.openness.map((item) => item.id),
    ["h1", "l1"],
    "删过头会放弃删除",
  );
});

test("时间线事件事实变化字段净化:坏形状丢弃、好形状保留", () => {
  const good = sanitizeEventFactChanges({
    id: "e1",
    factsToAdd: [
      { id: "f1", text: "黄枫谷已成废墟", chapterAnchor: 600 },
      { id: "f1", text: "重复id被去重", chapterAnchor: 600 },
      { id: "", text: "缺id被丢弃", chapterAnchor: 1 },
      "不是对象",
    ],
    factsToInvalidate: ["f-old", "f-old", 42],
  });
  assert.deepEqual(good.factsToAdd, [{ id: "f1", text: "黄枫谷已成废墟", chapterAnchor: 600 }]);
  assert.deepEqual(good.factsToInvalidate, ["f-old"]);

  const garbage = sanitizeEventFactChanges({
    factsToAdd: "乱写",
    factsToInvalidate: [42],
  });
  assert.equal("factsToAdd" in garbage, false);
  assert.equal("factsToInvalidate" in garbage, false);
});

test("fallback core fills empty required collections and marks the world degraded", () => {  const world = fallbackWorldCore({}, { title: "凡人修仙传" });
  assert.equal(world.title, "凡人修仙传");
  assert.ok(world.id, "降级世界也要有 id");
  assert.ok(world.locations.length >= 1);
  assert.ok(world.attributes.length >= 1);
  assert.ok(world.stats.length >= 1);
  assert.ok(world.degraded?.reasons?.length >= 1, "降级必须留痕可查");
  const diagnosis = diagnoseWorld(world);
  const core = ["id", "title", "locations", "attributes", "stats"];
  assert.ok(
    !diagnosis.errors.some((item) => core.some((path) => item.path === path || item.path.startsWith(path + "["))),
    "降级补全后核心集合不应再有校验错误",
  );
});

test("身份能力净化:坏形状丢弃、好形状保留,不报错不拦烧制", () => {
  const good = sanitizeRoleCapabilities({
    id: "elder",
    name: "元婴长老",
    description: "修为深厚",
    abilities: ["能以神识扫探方圆数里", " 可御器飞行 ", 42, "超长".repeat(30)],
    statMods: { cultivation: 8, bogus: "x" },
    attributeMods: { focus: 10 },
    traitIds: ["realm-elder", "realm-elder", 42, ""],
    authority: ["inspect", "manage", "称霸"],
  });
  assert.deepEqual(good.abilities, [
    "能以神识扫探方圆数里",
    "可御器飞行",
    "超长".repeat(20), // 超长句截断到 40 字后仍保留
  ]);
  assert.deepEqual(good.statMods, { cultivation: 8 }, "非数值修饰被丢弃");
  assert.deepEqual(good.attributeMods, { focus: 10 });
  assert.deepEqual(good.traitIds, ["realm-elder"], "特质去重且滤掉非字符串");
  assert.deepEqual(good.authority, ["inspect", "manage"], "非法职权被白名单滤掉");

  const garbage = sanitizeRoleCapabilities({
    id: "x",
    name: "坏身份",
    abilities: "不是数组",
    statMods: [1, 2],
    attributeMods: "乱写",
    traitIds: "不是数组",
    authority: "不是数组",
  });
  assert.equal("abilities" in garbage, false);
  assert.equal("statMods" in garbage, false);
  assert.equal("attributeMods" in garbage, false);
  assert.equal("traitIds" in garbage, false);
  assert.equal("authority" in garbage, false);
});

test("能力字段经草稿归一化后仍在身份上,且不触发诊断错误", () => {
  const world = normalizeWorldDraft(
    draft({
      roleTemplates: [
        {
          id: "elder",
          name: "元婴长老",
          description: "修为深厚",
          locationIds: ["gate"],
          factionIds: [],
          firstChapter: "3",
          abilities: ["能以神识扫探方圆数里"],
          statMods: { cultivation: 8 },
        },
      ],
    }),
  );
  const elder = world.roleTemplates.find((role) => role.id === "elder");
  assert.deepEqual(elder.abilities, ["能以神识扫探方圆数里"]);
  assert.deepEqual(elder.statMods, { cultivation: 8 });
  assert.equal(elder.firstChapter, 3);
  const diagnosis = diagnoseWorld(world);
  assert.ok(
    !diagnosis.errors.some((item) => item.path?.includes("abilities") || item.path?.includes("statMods")),
    "能力字段不该产生诊断错误",
  );
});

test("mechanical repair tolerates non-array modifiers on progression paths", () => {
  const repaired = mechanicallyRepairWorld(draft({
    roleProgression: [
      {
        fromRoleId: "outsider",
        toRoleId: "disciple",
        modifiers: "insight+3", // 非数组:不抛,过滤后为空
        refusalModifiers: { attributeId: "insight", delta: -1 },
      },
      {
        fromRoleId: "disciple",
        toRoleId: "elder",
        modifiers: [{ attributeId: "insight", delta: 2 }],
        refusalModifiers: null,
      },
    ],
  }));
  const [first, second] = repaired.roleProgression;
  assert.deepEqual(first.modifiers, []);
  assert.deepEqual(first.refusalModifiers, [{ attributeId: "insight", delta: -1 }]);
  assert.deepEqual(second.modifiers, [{ attributeId: "insight", delta: 2 }]);
  assert.deepEqual(second.refusalModifiers, []);
});

test("timeline fate tiers clamp to core/side/local and default to side", () => {
  const world = normalizeWorldDraft(
    draft({
      timeline: [
        { id: "e1", time: 10, locationId: "gate", text: "核心命运", chapterAnchor: 1, prerequisites: [], invalidatedBy: [], resolution: "never", resolutionTargetIds: [], tier: "core" },
        { id: "e2", time: 20, locationId: "gate", text: "支线命运", chapterAnchor: 2, prerequisites: [], invalidatedBy: [], resolution: "never", resolutionTargetIds: [], tier: "boss" },
        { id: "e3", time: 30, locationId: "gate", text: "旧书事件", chapterAnchor: 3, prerequisites: [], invalidatedBy: [], resolution: "never", resolutionTargetIds: [] },
      ],
    }),
  );
  assert.equal(world.timeline[0].tier, "core");
  assert.equal(world.timeline[1].tier, "side", "非法 tier 回落 side");
  assert.equal(world.timeline[2].tier, "side", "旧书缺失 tier 回落 side,无需重烧");
  const diagnosis = diagnoseWorld(world);
  assert.ok(
    !diagnosis.errors.some((item) => item.path?.includes("tier")),
    "钳位后的 tier 不该产生诊断错误",
  );
});

// —— 因果倒挂检测（拍板 2026-08-20：插叙/多线书的 time 归位质检）——

const event = (id, time, extra = {}) => ({
  id,
  time,
  locationId: "gate",
  text: `事件${id}`,
  chapterAnchor: 1,
  prerequisites: [],
  invalidatedBy: [],
  resolution: "never",
  resolutionTargetIds: [],
  ...extra,
});

test("diagnoseWorld 报因果倒挂:prerequisites 指向故事时间更晚的事件", () => {
  const world = normalizeWorldDraft(
    draft({
      timeline: [
        // 汇聚点 C(time=300) 前置 A(time=100) 合法;前置 B(time=900) 倒挂。
        event("late", 900),
        event("conv", 300, { prerequisites: ["early", "late"] }),
        event("early", 100),
      ],
    }),
  );
  const { errors } = diagnoseWorld(world);
  const inversion = errors.filter((item) => item.code === "causal_inversion");
  assert.equal(inversion.length, 1);
  assert.match(inversion[0].message, /late/);
  assert.ok(
    !inversion.some((item) => item.message.includes("early")),
    "指向更早事件的前置不报错",
  );
});

test("diagnoseWorld 报因果倒挂:invalidatedBy 指向故事时间更晚的事件", () => {
  const world = normalizeWorldDraft(
    draft({
      timeline: [
        event("canon-old", 100, { invalidatedBy: ["later-kill"] }),
        // 改命式顶替(更早的变故作废更晚的原著事件)是合法方向,不报错。
        event("canon-future", 900, { invalidatedBy: ["branch"] }),
        event("branch", 300),
        event("later-kill", 1200),
      ],
    }),
  );
  const { errors } = diagnoseWorld(world);
  const inversion = errors.filter((item) => item.code === "causal_inversion");
  assert.equal(inversion.length, 1);
  assert.match(inversion[0].message, /later-kill/);
  assert.ok(
    !inversion.some((item) => item.message.includes("branch")),
    "更早事件顶替更晚事件(改命方向)合法",
  );
});

test("mechanicallyRepairWorld 剪除因果倒挂边,保住合法边", () => {
  const world = normalizeWorldDraft(
    draft({
      timeline: [
        event("late", 900),
        event("conv", 300, { prerequisites: ["early", "late"] }),
        event("early", 100),
      ],
    }),
  );
  const repaired = mechanicallyRepairWorld(structuredClone(world));
  const conv = repaired.timeline.find((item) => item.id === "conv");
  assert.deepEqual(conv.prerequisites, ["early"], "倒挂前置被剪,合法前置保留");
  const { errors } = diagnoseWorld(repaired);
  assert.ok(!errors.some((item) => item.code === "causal_inversion"), "修复后不再倒挂");
});

test("povCharacters 归一:去重、滤悬空、截断 3", () => {
  const world = normalizeWorldDraft(
    draft({
      characters: [
        { id: "p1", name: "甲", role: "剑客", locationIds: ["gate"], firstChapter: 1 },
        { id: "p2", name: "乙", role: "谋士", locationIds: ["gate"], firstChapter: 1 },
        { id: "p3", name: "丙", role: "僧人", locationIds: ["gate"], firstChapter: 1 },
        { id: "p4", name: "丁", role: "商贾", locationIds: ["gate"], firstChapter: 1 },
      ],
      povCharacters: ["p1", "p2", "p1", "ghost", "p3", "p4"],
    }),
  );
  assert.deepEqual(world.povCharacters, ["p1", "p2", "p3"]);
  const { errors } = diagnoseWorld(world);
  assert.ok(!errors.some((item) => item.path?.includes("povCharacters")), "归一后不报错");
});

