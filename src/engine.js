import { deepStrictEqual } from "node:assert";
import { Bm25Index } from "./retrieval.js";
import { retrieveMemories, updateStructuredMemories } from "./memory.js";
import {
  BIG_FIVE_DIMENSIONS,
  BIG_FIVE_LABELS,
  applyBigFiveShift,
  applyEvolutionPatch,
  bigFiveCrossings,
  bigFiveLevel,
  eligibleProgression,
  migrateState,
  neutralBigFive,
  normalizeWorld,
  optionIsAvailable,
  realmTraitsOf,
  validateRoleTransition,
} from "./evolution.js";
import {
  advanceEndingCandidate,
  applyInventoryPatch,
  applyLearnedAbilities,
  applyLayeredPatches,
  applyRealmBreakthrough,
  buildCharacterJournal,
  playerDeathState,
  scheduleGameplaySystems,
  validateGameplayState,
  applyDivergence,
  divergenceTargetGate,
  divergenceThreshold,
  effectiveFacts,
} from "./gameplay-systems.js";
import {
  advanceClash,
  beginClash,
  markPendingDeath,
  playerClashCondition,
  stanceLabel,
  validateClashStart,
  CLASH_CONDITIONS,
} from "./clash.js";
import { storyClockView, timelineClock } from "./timeline.js";
import {
  applyEmergentPatch,
  applyCompanionPatch,
  sanitizeEmergentPatch,
} from "./story-emergence.js";
import { clampAdaptation, DEFAULT_RULES } from "./rules.js";
import { sanitizeEventFactChanges } from "./world-repair.js";
import { POWER_ROLL_BIAS, resolvePowerEscape } from "./play-mode.js";
import { playerCreationsView } from "./world-creation.js";
import {
  ARC_DRIFT_INTERVAL,
  BEAT_STALL_LIMIT,
  arcBeatView,
  fallbackRetrospective,
  jumpToResolution,
  sanitizeArc,
  sanitizeDriftVerdict,
} from "./director.js";

const RISK_DIFFICULTY = Object.freeze({
  safe: 30,
  risky: 55,
  dire: 75,
});

const VALID_STAT_ROLES = new Set(["vital", "resource", "progress", "relation"]);

const VALID_RESULTS = new Set([
  "critical_success",
  "success",
  "failure",
  "critical_failure",
]);

const EXIT_AXIS = "exit";
const DEFAULT_TIME_COST = 60;
// 单个行动最多消耗一周（10080 分钟）：只拦模型写错的离谱数量级，不拦合理的长行动。
const MAX_TIME_COST = 10080;
// 伏笔集合硬上限：超出时淘汰最老的（长期伏笔已由结构化记忆层兜底，不会彻底丢失）。
const MAX_OPEN_THREADS = 200;
// 每回合注入上下文的伏笔条数：只带最近开启的，避免后期上下文被陈年伏笔挤兑。
const MAX_CONTEXT_THREADS = 20;
// 正典账本注入预算（拍板 2026-08-20：连贯性修复）：账本事实按条数封顶，
// 伏笔簿（canonHorizon）同样限条——账本条目是检索锚点，不是正文搬运。
const LEDGER_FACTS_LIMIT = 6;
const HORIZON_LIMIT = 6;
// 人物状态笔记的新鲜度窗口：超出窗口的旧笔记不再注入（人物久未出场时，
// 过期笔记冒充「此刻」比没有笔记更误导）；行踪仍由 entityStates 兜底。
const ENTITY_NOTE_FRESH_TURNS = 30;
// 离屏漂移节奏：世界时间每 48 小时，人物在其惯常地点间轮换一格。
const OFFSCREEN_TICK_MINUTES = 2880;

// 确定性字符串哈希（FNV-1a）：同一人物同一时间段永远得到同一位置，
// 不依赖引擎随机种子——undo/重玩/读档后位置依然一致。
function characterTickHash(text) {
  let hash = 2166136261;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

// 离屏人物确定性漂移：不在场上（非本回合行动对象、也不在玩家所在地点）的
// 存活人物，按世界时间在其惯常地点（locationIds）间轮换。世界在幕后「动」，
// 且同一状态永远漂出同一位置——模型只能叙述代码决定的位置，不能凭空编造行踪。
export function offscreenLocationTick(state, world, onScreenIds) {
  let next = state;
  for (const [characterId, entity] of Object.entries(state.entityStates ?? {})) {
    if (!entity || entity.status === "dead" || onScreenIds.has(characterId)) continue;
    const character = world.characters.find((item) => item.id === characterId);
    const haunts = character?.locationIds?.length
      ? character.locationIds
      : [entity.locationId].filter(Boolean);
    if (haunts.length < 2) continue;
    // 每个角色带自己的错峰偏移（hash 作起始时刻），避免全部角色同一时间集体搬家。
    const tickMinutes = world?.rules?.offscreenTickMinutes ?? DEFAULT_RULES.offscreenTickMinutes;
    const stagger = characterTickHash(characterId) % tickMinutes;
    const tickIndex = Math.floor(((state.worldTime ?? 0) + stagger) / tickMinutes);
    if (tickIndex < 1) continue;
    const locationId = haunts[characterTickHash(`${characterId}:${tickIndex}`) % haunts.length];
    if (locationId === entity.locationId) continue;
    if (next === state) next = { ...state, entityStates: { ...(state.entityStates ?? {}) } };
    next.entityStates[characterId] = { ...entity, locationId, lastSeenTurn: state.turn };
  }
  return next;
}
const VALID_APPROACHES = new Set([
  "cooperate",
  "persuade",
  "deceive",
  "threaten",
  "resist",
  "avoid",
]);
const AXIS_APPROACH = Object.freeze({
  social: "persuade",
  force: "resist",
  exit: "avoid",
  investigate: "resist",
});
const TURN_TIMEOUTS = Object.freeze({
  ordinary: 150_000,
  key: 240_000,
  ending: 360_000,
});
function clone(value) {
  return structuredClone(value);
}

// 人物精读结果并回档案。精读 JSON 来自模型输出，可能带 __proto__ 自有属性
//（JSON.parse 会把它造成普通自有属性）：Object.assign 逐键做 [[Set]]，遇到
// __proto__ 会触发继承 setter 把 character 的原型整个换掉。逐键过滤危险键
// 后再赋值，且必须原地改——world.characters 数组各处都持有同一引用。
export function mergeDetailInto(character, detailed, extras) {
  for (const [key, value] of Object.entries(detailed ?? {})) {
    if (key === "__proto__" || key === "constructor" || key === "prototype") continue;
    character[key] = value;
  }
  Object.assign(character, extras);
}

export function createSeededRandom(seed) {
  let state = seed >>> 0;
  const random = () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 0x100000000;
  };
  random.getState = () => state;
  random.setState = (nextState) => {
    state = nextState >>> 0;
  };
  return random;
}

function riskToDifficulty(risk, rules = DEFAULT_RULES) {
  const difficulty = rules?.difficulty?.[risk] ?? DEFAULT_RULES.difficulty[risk];
  if (difficulty === undefined) {
    throw new Error(`Unknown risk level: ${risk}`);
  }
  return difficulty;
}

export function rollCheck({ attributeValue, risk, modifier = 0, random = Math.random, rules = DEFAULT_RULES }) {
  const difficulty = riskToDifficulty(risk, rules);
  const roll = Math.floor(random() * 100) + 1;
  const score = roll + attributeValue + modifier;
  const margin = score - difficulty;

  let result;
  // 大成功/大失败必须与处境同向：roll 95+ 但 margin 为负时只是普通失败，
  // 否则低属性 + 不利修正叠加下也能打出「大成功」，叙事与数值互相打架。
  if (margin >= 30 || (roll >= 95 && margin >= 0)) {
    result = "critical_success";
  } else if (margin >= 0) {
    result = "success";
  } else if (margin <= -30 || (roll <= 5 && margin < 0)) {
    result = "critical_failure";
  } else {
    result = "failure";
  }

  return { roll, difficulty, score, margin, modifier, result };
}

function optionApproach(option) {
  return option.approach ?? AXIS_APPROACH[option.axis] ?? "resist";
}

function relationshipModifier(option, state) {
  if (!option.target?.type || !option.target.id) return 0;
  const relation = state.relationships?.[`${option.target.type}:${option.target.id}`];
  if (!relation) return 0;
  const trust = relation.trust ?? 0;
  const fear = relation.fear ?? 0;
  const hostility = relation.hostility ?? 0;
  const raw = {
    cooperate: trust - hostility,
    persuade: trust - Math.ceil(hostility / 2),
    deceive: Math.floor((trust - hostility) / 2),
    threaten: fear - hostility,
    resist: 0,
    avoid: 0,
  }[optionApproach(option)];
  return Math.max(-10, Math.min(10, raw ?? 0));
}

// 势力权威修正：行动依赖的势力给玩家的权威权限越多，越容易成事（最多 +8）。
// 只在选项显式声明 factionId 且玩家确有该势力成员记录时生效。
const AUTHORITY_MODIFIER = Object.freeze({ command: 8, manage: 6, inspect: 4 });
function factionAuthorityModifier(option, state) {
  const factionId = option.requirements?.factionId;
  if (!factionId) return 0;
  const membership = state.factionMemberships?.find((item) => item.factionId === factionId);
  const authority = membership?.authority ?? [];
  return Math.max(0, ...authority.map((permission) => AUTHORITY_MODIFIER[permission] ?? 0));
}

// 资源修正：从可选资源池取一个最大可用值作正向修正（最多 +8），资源多则势大。
const MAX_RESOURCE_MODIFIER = 8;
function resourceModifier(option, state) {
  const resourceId = option.requirements?.resourceId;
  if (!resourceId) return 0;
  const value = Number(state.resources?.[resourceId]);
  if (!Number.isFinite(value) || value <= 0) return 0;
  return Math.min(MAX_RESOURCE_MODIFIER, Math.floor(value / 2));
}

export function actionModifiers(option, state) {
  const relationship = relationshipModifier(option, state);
  const faction = factionAuthorityModifier(option, state);
  const resource = resourceModifier(option, state);
  return {
    total: Math.max(-20, Math.min(15, relationship + faction + resource)),
    relationship,
    faction,
    resource,
    approach: optionApproach(option),
  };
}

// 终卷判定(拍板:主线收束+随时合卷):所有带事实变化的命运节点都已落下
// (delivered/resolved/invalidated/被改写)时,这一卷可以合上;无命运节点的书不触发自动终卷。
// resolved 必须算「已落下」:world_time 解析方式的命运节点在投递的同一回合就会被
// resolveTimelineEvents 转成 resolved——漏了它,大多数书的终卷永远合不上。
export function foldableEnding(state, world) {
  const fateNodes = (world.timeline ?? []).filter(
    (event) =>
      (Array.isArray(event.factsToAdd) && event.factsToAdd.length > 0) ||
      (Array.isArray(event.factsToInvalidate) && event.factsToInvalidate.length > 0),
  );
  if (!fateNodes.length) return false;
  const changedIds = new Set(
    (state.completedDivergences ?? []).map((item) => item.targetId).filter(Boolean),
  );
  const SETTLED = new Set(["delivered", "resolved", "invalidated"]);
  return fateNodes.every(
    (event) => changedIds.has(event.id) || SETTLED.has(state.eventStates?.[event.id]?.status),
  );
}

export function validateWorld(world) {
  world = normalizeWorld(world);
  if (!world?.id || !world?.title) throw new Error("World requires id and title");
  if (!Array.isArray(world.stats) || world.stats.length === 0) {
    throw new Error("World requires stat definitions");
  }

  const statIds = new Set();
  for (const stat of world.stats) {
    if (!stat.id || statIds.has(stat.id)) throw new Error("Stat ids must be unique");
    if (!VALID_STAT_ROLES.has(stat.role)) {
      throw new Error(`Invalid role for stat ${stat.id}`);
    }
    if (!Number.isFinite(stat.min) || !Number.isFinite(stat.max) || stat.min >= stat.max) {
      throw new Error(`Invalid range for stat ${stat.id}`);
    }
    statIds.add(stat.id);
  }

  if (!Array.isArray(world.attributes) || world.attributes.length === 0) {
    throw new Error("World requires attribute definitions");
  }
  const attributeIds = new Set();
  for (const attribute of world.attributes) {
    if (!attribute.id || attributeIds.has(attribute.id)) {
      throw new Error("Attribute ids must be present and unique");
    }
    attributeIds.add(attribute.id);
  }
  if (
    !Array.isArray(world.timeline) ||
    !Array.isArray(world.facts) ||
    !Array.isArray(world.factions) ||
    !Array.isArray(world.items)
  ) {
    throw new Error("World requires timeline, facts, factions and items arrays");
  }
  return world;
}

export function validateInitialState(state, world) {
  world = normalizeWorld(world);
  state = migrateState(state, world);
  if (!Number.isInteger(state?.turn) || state.turn < 0) {
    throw new Error("Initial state requires a non-negative turn");
  }
  if (!world.locations.some((item) => item.id === state.locationId)) {
    throw new Error(`Unknown initial location: ${state.locationId}`);
  }
  for (const stat of world.stats) {
    const value = state.stats?.[stat.id];
    if (!Number.isFinite(value) || value < stat.min || value > stat.max) {
      throw new Error(`Invalid initial value for stat ${stat.id}`);
    }
  }
  for (const attribute of world.attributes) {
    if (!Number.isFinite(state.attributes?.[attribute.id])) {
      throw new Error(`Invalid initial attribute ${attribute.id}`);
    }
  }
  for (const key of ["conditions", "resolvedEventIds", "resolvedThreads", "retrievalKeywords"]) {
    if (!Array.isArray(state[key])) throw new Error(`Initial state requires ${key}`);
  }
  if (!state.player?.id || !state.relationships || !state.entityStates) {
    throw new Error("Initial state requires player and evolution state");
  }
  validateGameplayState(state, world);
  return state;
}

// 行囊补丁清洗(拍板 2026-08-19:具名行囊):逐项钳位,坏形状静默丢弃。
// 目录物品以目录名为准(itemId 命中时覆盖 name),涌现物品名限 2-16 码点。
function sanitizeInventoryPatch(value, world) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const changes = Array.isArray(value.changes) ? value.changes : [];
  const cleaned = [];
  const seen = new Set();
  for (const raw of changes.slice(0, 4)) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) continue;
    if (raw.action !== "gain" && raw.action !== "lose") continue;
    let name = String(raw.name ?? "").trim();
    let itemId;
    if (typeof raw.itemId === "string" && raw.itemId) {
      const item = world.items.find((entry) => entry.id === raw.itemId);
      if (item) {
        itemId = item.id;
        name = item.name;
      }
    }
    if (!itemId) {
      const nameLength = [...name].length;
      if (nameLength < 2 || nameLength > 16) continue;
    }
    const key = `${raw.action}:${itemId ?? name}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const note = String(raw.note ?? "").trim().slice(0, 40);
    const entry = { action: raw.action, name };
    if (itemId) entry.itemId = itemId;
    if (note) entry.note = note;
    cleaned.push(entry);
  }
  return cleaned.length ? { changes: cleaned } : undefined;
}

// 把模型返回的回合结构一次性清洗成「可安全执行」的形态。
// 结构退化（null/非对象/非数组）与语义退化（未知 stat、未知属性、非法 risk、
// 重复 axis、越界 timeCost、未知引用等）都不再作为硬错误抛出，而是丢弃/回落
// 到安全值。这样 validateResponse 之后的结算阶段不会因为模型随机违约而崩，
// 剩余的 narrative 空这类致命错误才走 repairResponse/rewrite。
function sanitizeTurnPayload(value, world) {
  const source = value && typeof value === "object" && !Array.isArray(value) ? value : {};

  // —— delta：只保留已知 stat 且数值有限的变化 ——
  const statIds = new Set(world.stats.map((stat) => stat.id));
  const delta = {};
  const rawDelta =
    source.delta && typeof source.delta === "object" && !Array.isArray(source.delta)
      ? source.delta
      : {};
  for (const [key, change] of Object.entries(rawDelta)) {
    if (statIds.has(key) && Number.isFinite(change)) delta[key] = change;
  }

  // —— options：只保留结构完整、可结算的选项，按 id 与 axis 双重去重 ——
  const attributeIds = new Set(world.attributes.map((item) => item.id));
  const axes = new Set();
  const optionIds = new Set();
  const options = [];
  for (const raw of Array.isArray(source.options) ? source.options : []) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) continue;
    if (
      !raw.id ||
      !raw.text ||
      !raw.axis ||
      !Object.hasOwn(AXIS_APPROACH, raw.axis) ||
      axes.has(raw.axis) ||
      optionIds.has(raw.id)
    ) {
      continue;
    }
    let risk = raw.risk;
    try {
      riskToDifficulty(risk);
    } catch {
      risk = "safe";
    }
    const attribute = attributeIds.has(raw.attribute) ? raw.attribute : world.attributes[0]?.id;
    if (!attribute) continue;
    // timeCost 缺省按书的规则,越界则钳到合法范围。
    let timeCost = raw.timeCost;
    if (timeCost === undefined) timeCost = world.rules?.defaultTimeCost ?? DEFAULT_RULES.defaultTimeCost;
    if (!Number.isFinite(timeCost) || timeCost < 0) timeCost = 0;
    const maxTimeCost = world.rules?.maxTimeCost ?? DEFAULT_RULES.maxTimeCost;
    if (timeCost > maxTimeCost) timeCost = maxTimeCost;
    const clean = { ...raw, risk, attribute, timeCost };
    // 非法 approach 显式删除，不随 spread 带入（否则 validateResponse 仍会抛）。
    if (raw.approach !== undefined && VALID_APPROACHES.has(raw.approach)) {
      clean.approach = raw.approach;
    } else {
      delete clean.approach;
    }
    // 心性漂移标注:只认五维、钳 ±5 整数;坏形状整体删除(选中即结算,不能带脏数据)。
    if (raw.bigFiveShift && typeof raw.bigFiveShift === "object" && !Array.isArray(raw.bigFiveShift)) {
      const shift = {};
      for (const dim of BIG_FIVE_DIMENSIONS) {
        const delta = Number(raw.bigFiveShift[dim]);
        if (!Number.isFinite(delta)) continue;
        shift[dim] = Math.max(-5, Math.min(5, Math.round(delta)));
      }
      if (Object.keys(shift).length) clean.bigFiveShift = shift;
      else delete clean.bigFiveShift;
    } else {
      delete clean.bigFiveShift;
    }
    options.push(clean);
    axes.add(raw.axis);
    optionIds.add(raw.id);
    if (options.length >= 10) break;
  }

  // —— statePatch：只保留合法字段与合法 locationId；unlockedChapter 已由
  // 原文时间推演接管,模型写的一律丢弃(回合≠章节) ——
  let statePatch = source.statePatch;
  if (statePatch && typeof statePatch === "object" && !Array.isArray(statePatch)) {
    const allowed = new Set(["locationId", "resolvedThreads"]);
    const cleaned = {};
    for (const [key, val] of Object.entries(statePatch)) {
      if (!allowed.has(key)) continue;
      // resolvedThreads 只收字符串(与 openThreads 同口径):模型写进对象/数字
      // 时既匹配不上任何伏笔,还会污染落盘数组。
      if (key === "resolvedThreads") {
        if (!Array.isArray(val)) continue;
        const threads = val.filter((item) => typeof item === "string" && item.trim());
        if (threads.length) cleaned.resolvedThreads = threads;
        continue;
      }
      cleaned[key] = val;
    }
    if (
      cleaned.locationId !== undefined &&
      !world.locations.some((item) => item.id === cleaned.locationId)
    ) {
      delete cleaned.locationId;
    }
    statePatch = cleaned;
  } else {
    statePatch = undefined;
  }

  // —— evolutionPatch：验证失败则整段丢弃 ——
  let evolutionPatch = source.evolutionPatch;
  if (evolutionPatch && typeof evolutionPatch === "object" && !Array.isArray(evolutionPatch)) {
    try {
      applyEvolutionPatch(migrateState({}, world), evolutionPatch, world);
    } catch {
      evolutionPatch = undefined;
    }
  } else {
    evolutionPatch = undefined;
  }

  // —— systemPatches：保持对象（applyLayeredPatches 内部逐层 try/catch 兜底）——
  const systemPatches =
    source.systemPatches && typeof source.systemPatches === "object" && !Array.isArray(source.systemPatches)
      ? source.systemPatches
      : undefined;

  // —— clashStart：对手无效则丢弃（结算时 validateClashStart 还会再拦一道）——
  let clashStart = source.clashStart;
  if (clashStart && typeof clashStart === "object" && !Array.isArray(clashStart)) {
    if (
      typeof clashStart.opponentId !== "string" ||
      !clashStart.opponentId ||
      !world.characters.some((item) => item.id === clashStart.opponentId)
    ) {
      clashStart = undefined;
    }
  } else {
    clashStart = undefined;
  }

  // —— jumpMinutes：只有合法整数才保留（0-43200 分钟,最长 30 天）——
  const jumpMinutes =
    Number.isInteger(source.jumpMinutes) && source.jumpMinutes >= 0 && source.jumpMinutes <= 43200
      ? source.jumpMinutes
      : undefined;

  // —— roleTransition：形状合法才保留（存在性/前提在结算阶段按玩家状态再验）——
  let roleTransition = source.roleTransition;
  if (roleTransition && typeof roleTransition === "object" && !Array.isArray(roleTransition)) {
    if (
      typeof roleTransition.progressionId !== "string" ||
      !roleTransition.progressionId ||
      typeof roleTransition.triggerEventId !== "string" ||
      !roleTransition.triggerEventId
    ) {
      roleTransition = undefined;
    }
  } else {
    roleTransition = undefined;
  }

  // —— inventoryPatch：行囊易手逐项钳位（坏形状静默丢弃，宁缺毋滥）——
  const inventoryPatch = sanitizeInventoryPatch(source.inventoryPatch, world);

  // —— learnedAbilities：只收短字符串，每回合至多 2 条 ——
  const rawLearned = Array.isArray(source.learnedAbilities)
    ? source.learnedAbilities
        .map((item) => (typeof item === "string" ? item.trim() : ""))
        .filter((item) => item && [...item].length <= 40)
        .slice(0, 2)
    : [];
  const learnedAbilities = rawLearned.length ? rawLearned : undefined;

  // —— realmBreakthrough：目标必须是原著阶梯里的境界（更高一阶在结算阶段再验）——
  let realmBreakthrough = source.realmBreakthrough;
  if (realmBreakthrough && typeof realmBreakthrough === "object" && !Array.isArray(realmBreakthrough)) {
    const onLadder = realmTraitsOf(world).some((trait) => trait.id === realmBreakthrough.toTraitId);
    if (!onLadder) {
      realmBreakthrough = undefined;
    } else {
      const note = String(realmBreakthrough.note ?? "").trim().slice(0, 40);
      realmBreakthrough = note
        ? { toTraitId: realmBreakthrough.toTraitId, note }
        : { toTraitId: realmBreakthrough.toTraitId };
    }
  } else {
    realmBreakthrough = undefined;
  }

  // —— divergencePatch：目标类型合法、目标 ID 存在才保留，否则丢弃 ——
  let divergencePatch = source.divergencePatch;
  if (divergencePatch && typeof divergencePatch === "object" && !Array.isArray(divergencePatch)) {
    const validTarget =
      divergencePatch.targetType === "timeline" &&
      world.timeline.some((item) => item.id === divergencePatch.targetId);
    const validFact =
      divergencePatch.targetType === "fact" &&
      world.facts.some((item) => item.id === divergencePatch.targetId);
    const validEntity =
      divergencePatch.targetType === "entity" &&
      world.characters.some((item) => item.id === divergencePatch.targetId);
    if (!validTarget && !validFact && !validEntity) {
      divergencePatch = undefined;
    }
  } else {
    divergencePatch = undefined;
  }

  // —— replacementEvent：替代事件白名单钳位,任一硬条件不满足整体丢弃 ——
  let replacementEvent = source.replacementEvent;
  if (replacementEvent && typeof replacementEvent === "object" && !Array.isArray(replacementEvent)) {
    const eventIds = new Set(world.timeline.map((item) => item.id));
    // 原著事件（canon）单独成集：顶替清单只认原著,不得顶替涌现/其他替代事件。
    const canonEventIds = new Set(
      world.timeline
        .filter((item) => !item.source || (item.source !== "emergent" && item.source !== "derived"))
        .map((item) => item.id),
    );
    const factIds = new Set(world.facts.map((item) => item.id));
    const time = Number(replacementEvent.time);
    const text = String(replacementEvent.text ?? "").trim().slice(0, 300);
    const locationId = world.locations.some((item) => item.id === replacementEvent.locationId)
      ? replacementEvent.locationId
      : undefined;
    const resolution = ["player_action", "world_time", "never"].includes(replacementEvent.resolution)
      ? replacementEvent.resolution
      : "never";
    if (
      !Number.isFinite(time) ||
      time < 0 ||
      !text ||
      locationId === undefined
    ) {
      replacementEvent = undefined;
    } else {
      const asIds = (value) =>
        Array.isArray(value)
          ? value.filter((id) => typeof id === "string" && id.trim())
          : [];
      const factChanges = sanitizeEventFactChanges({
        factsToAdd: replacementEvent.factsToAdd,
        factsToInvalidate: asIds(replacementEvent.factsToInvalidate).filter((id) => factIds.has(id)),
      });
      replacementEvent = {
        time,
        text,
        locationId,
        tier: ["core", "side", "local"].includes(replacementEvent.tier) ? replacementEvent.tier : "side",
        prerequisites: asIds(replacementEvent.prerequisites).filter((id) => eventIds.has(id)),
        invalidatedBy: asIds(replacementEvent.invalidatedBy).filter((id) => eventIds.has(id)),
        // 顶替清单（拍板 2026-08-19）：替代走向落定后，这些原著旧事不再发生
        // ——投递替代事件时一并把它们标作废，见闻/时间线直接换线不留多余。
        replacesIds: asIds(replacementEvent.replacesIds).filter((id) => canonEventIds.has(id)),
        resolution,
        resolutionTargetIds: asIds(replacementEvent.resolutionTargetIds),
        ...factChanges,
      };
    }
  } else {
    replacementEvent = undefined;
  }

  // —— emergentPatch：涌现故事白名单钳位，非法项静默丢弃（宁缺毋滥） ——
  // storyImpacts 的 storyId 依赖玩家状态，存在性在结算阶段再验。
  const emergentPatch = sanitizeEmergentPatch(source.emergentPatch, world);

  const asStringArray = (field) =>
    Array.isArray(source[field]) ? source[field].filter((item) => typeof item === "string") : [];

  return {
    ...source,
    delta,
    options,
    jumpMinutes,
    statePatch,
    evolutionPatch,
    systemPatches,
    clashStart,
    divergencePatch,
    replacementEvent,
    roleTransition,
    inventoryPatch,
    learnedAbilities,
    realmBreakthrough,
    emergentPatch,
    openThreads: asStringArray("openThreads"),
    retrievalKeywords: asStringArray("retrievalKeywords"),
    // 节拍推进声明(弧线导演):只认显式 true,其余一律视为未声明。
    ...(source.beatAdvance === true ? { beatAdvance: true } : {}),
  };
}

export function validateResponse(response, world) {
  world = normalizeWorld(world);
  if (!response || typeof response.narrative !== "string" || !response.narrative.trim()) {
    throw new Error("Response requires narrative");
  }
  // 选项数量不足或缺失都不在协议层强拦：模型偶尔漏写 options，结算阶段的
  // repairOptions / fallbackOptions 会补出合法选项，比让整个回合直接报错更稳。
  // 这里只拦「多到离谱」这一种结构性问题。
  const options = Array.isArray(response.options) ? response.options : [];
  if (options.length > 10) {
    throw new Error("Response requires at most 10 options");
  }
  if (!response.delta || typeof response.delta !== "object" || Array.isArray(response.delta)) {
    throw new Error("Response requires a state delta");
  }

  const optionIds = new Set();
  const axes = new Set();
  const attributeIds = new Set(world.attributes.map((item) => item.id));
  for (const option of options) {
    if (
      !option.id ||
      optionIds.has(option.id) ||
      !option.text ||
      !option.axis ||
      axes.has(option.axis)
    ) {
      throw new Error("Options require unique ids, text, and axes");
    }
    riskToDifficulty(option.risk);
    if (option.approach !== undefined && !VALID_APPROACHES.has(option.approach)) {
      throw new Error(`Unknown option approach: ${option.approach}`);
    }
    // 心性漂移标注:形状与幅度硬校验,坏数据重生成而不是带病结算。
    if (option.bigFiveShift !== undefined) {
      if (
        option.bigFiveShift === null ||
        typeof option.bigFiveShift !== "object" ||
        Array.isArray(option.bigFiveShift)
      ) {
        throw new Error("bigFiveShift must be an object");
      }
      for (const [dim, delta] of Object.entries(option.bigFiveShift)) {
        if (!BIG_FIVE_DIMENSIONS.includes(dim)) {
          throw new Error(`bigFiveShift references an unknown dimension: ${dim}`);
        }
        if (!Number.isFinite(delta) || Math.abs(delta) > 5) {
          throw new Error("bigFiveShift must stay within ±5");
        }
      }
    }
    if (!attributeIds.has(option.attribute)) {
      throw new Error(`Unknown option attribute: ${option.attribute}`);
    }
    if (option.timeCost !== undefined && (!Number.isFinite(option.timeCost) || option.timeCost < 0)) {
      throw new Error("Options require a non-negative timeCost");
    }
    // 单个行动的时间消耗设一个宽松上限：模型偶尔写错数量级，
    // timeCost 爆炸会让世界时间跳过几十个事件，比一个失败回合严重得多。
    const maxTimeCost = normalizeWorld(world).rules?.maxTimeCost ?? DEFAULT_RULES.maxTimeCost;
    if (option.timeCost > maxTimeCost) {
      throw new Error(`timeCost must not exceed ${maxTimeCost} minutes`);
    }
    optionIds.add(option.id);
    axes.add(option.axis);
  }

  const statIds = new Set(world.stats.map((stat) => stat.id));
  for (const [key, value] of Object.entries(response.delta)) {
    if (!statIds.has(key)) throw new Error(`Delta changes unknown stat: ${key}`);
    if (!Number.isFinite(value)) throw new Error(`Delta for ${key} must be numeric`);
  }
  if (response.statePatch !== undefined) {
    if (!response.statePatch || typeof response.statePatch !== "object" || Array.isArray(response.statePatch)) {
      throw new Error("statePatch must be an object");
    }
    const allowed = new Set(["locationId", "resolvedThreads"]);
    for (const key of Object.keys(response.statePatch)) {
      if (!allowed.has(key)) throw new Error(`statePatch changes forbidden field: ${key}`);
    }
    if (
      response.statePatch.locationId !== undefined &&
      !normalizeWorld(world).locations.some((item) => item.id === response.statePatch.locationId)
    ) {
      throw new Error(`Unknown patched location: ${response.statePatch.locationId}`);
    }
  }
  if (response.evolutionPatch !== undefined) {
    applyEvolutionPatch(migrateState({}, world), response.evolutionPatch, world);
  }
  if (
    response.systemPatches !== undefined &&
    (!response.systemPatches ||
      typeof response.systemPatches !== "object" ||
      Array.isArray(response.systemPatches))
  ) {
    throw new Error("systemPatches must be an object");
  }
  // 被动掀桌提议：结构定死，可行性交给结算时的引擎校验。
  if (response.clashStart !== undefined && response.clashStart !== null) {
    if (typeof response.clashStart !== "object" || Array.isArray(response.clashStart)) {
      throw new Error("clashStart must be an object");
    }
    if (typeof response.clashStart.opponentId !== "string" || !response.clashStart.opponentId) {
      throw new Error("clashStart requires a valid opponentId");
    }
    if (response.clashStart.reason !== undefined && typeof response.clashStart.reason !== "string") {
      throw new Error("clashStart reason must be a string");
    }
  }
  // 这两个字段会被 spread 进上下文检索词：模型写成字符串时会被拆成单个字符，
  // 检索就只剩噪声，所以在入口就把类型定死。
  for (const field of ["openThreads", "retrievalKeywords"]) {
    if (response[field] !== undefined && !Array.isArray(response[field])) {
      throw new Error(`${field} must be an array`);
    }
  }
  // 时间跳跃:只有闭关/远行等回合才允许,单位分钟,最长 30 天。
  if (
    response.jumpMinutes !== undefined &&
    (!Number.isInteger(response.jumpMinutes) || response.jumpMinutes < 0 || response.jumpMinutes > 43200)
  ) {
    throw new Error("jumpMinutes must be an integer between 0 and 43200");
  }
  // 身份进阶声明：结构定死；路径存在性与前提满足在结算阶段按玩家状态校验。
  if (response.roleTransition !== undefined && response.roleTransition !== null) {
    if (typeof response.roleTransition !== "object" || Array.isArray(response.roleTransition)) {
      throw new Error("roleTransition must be an object");
    }
    if (
      typeof response.roleTransition.progressionId !== "string" ||
      !response.roleTransition.progressionId ||
      typeof response.roleTransition.triggerEventId !== "string" ||
      !response.roleTransition.triggerEventId
    ) {
      throw new Error("roleTransition requires valid progressionId and triggerEventId");
    }
  }

  return true;
}

// 判断一个选项是否「结构完整、可安全参与结算」：repairOptions 走的是另一条
// 不经 validateResponse 的路径，可能漏写 attribute/risk/axis 等字段，这里拦一道。
function optionIsWellFormed(option, world) {
  if (!option || typeof option !== "object" || Array.isArray(option)) return false;
  if (!option.id || !option.text || !option.axis) return false;
  // axis 白名单:模型偶尔把 approach(如 cooperate/deceive)错写进 axis,
  // 这种选项无法映射立场与结算,直接丢弃。
  if (!Object.hasOwn(AXIS_APPROACH, option.axis)) return false;
  if (!world.attributes.some((item) => item.id === option.attribute)) return false;
  try {
    riskToDifficulty(option.risk);
  } catch {
    return false;
  }
  return true;
}

function fallbackOptions(world, state) {
  const attribute = world.attributes[0].id;
  return [
    {
      id: `fallback-observe-${state.turn}`,
      text: "先停下来观察眼前局势",
      axis: "investigate",
      risk: "safe",
      attribute,
      timeCost: 30,
      stakes: "会消耗少量时间，但能避免贸然行动",
    },
    {
      id: `fallback-exit-${state.turn}`,
      text: "暂时退开，保留下一步选择",
      axis: "exit",
      risk: "safe",
      attribute,
      timeCost: 60,
      stakes: "局势可能在等待中继续变化",
    },
  ];
}

// 意图先行(拍板 R3):重生成的选项集必须结构完整、处境可用、id 与 axis 均唯一
// 且数量落在 2-10——否则整体作废走兜底。不强制 exit(拍板:意图选项必须贴合意图)。
// id 也要去重：渲染层与主进程都按 id find 定位选项，重复 id 时点击后者执行的
// 是前者(sanitizeTurnPayload 早已按 id+axis 双键去重，这里对齐)。
function validOptionSet(candidate, state, world) {
  const seenIds = new Set();
  const seenAxes = new Set();
  const valid = [];
  for (const option of Array.isArray(candidate) ? candidate : []) {
    if (!optionIsWellFormed(option, world)) continue;
    if (!optionIsAvailable(option, state, world)) continue;
    if (seenIds.has(option.id) || seenAxes.has(option.axis)) continue;
    seenIds.add(option.id);
    seenAxes.add(option.axis);
    valid.push(option);
  }
  const usable = valid.length >= 2;
  return { options: usable ? valid.slice(0, 10) : [], usable };
}

export function applyDelta(state, delta, world) {
  const next = clone(state);
  const consequences = [];

  for (const [statId, change] of Object.entries(delta)) {
    const definition = world.stats.find((stat) => stat.id === statId);
    if (!definition) continue; // 未知 stat 已在 sanitize 阶段滤掉，这里再防御一次
    const current = next.stats[statId];
    if (!Number.isFinite(current)) continue;

    // 数值越界时钳到边界而不是抛错：模型把 -10 写成 -11 不该让整个回合崩掉。
    const previous = current;
    const value = Math.min(definition.max, Math.max(definition.min, previous + change));
    next.stats[statId] = value;

    // vital 耗尽时把 zeroConsequence 挂进 conditions；烧制校验不严时模型可能漏写
    // zeroConsequence，这里防御一下，避免 conditions 里混进 undefined。
    // 只在「跨过零点」的那一回合触发：数值已经钉在最低点时模型再写 0/-N，
    // 不该每回合重复挂同一条后果、污染记忆池。
    if (
      definition.role === "vital" &&
      previous > definition.min &&
      value === definition.min &&
      definition.zeroConsequence
    ) {
      next.conditions = [...new Set([...next.conditions, definition.zeroConsequence])];
      consequences.push({
        type: "vital_zero",
        statId,
        consequence: definition.zeroConsequence,
      });
    }
  }

  return { state: next, consequences };
}

export function dueTimelineEvents(worldInput, state) {
  const world = normalizeWorld(worldInput);
  const eventStates = state.eventStates ?? {};
  // 原著的时钟 = 开局锚点时间 + 世界时间(回合≠章节:由原文自身时间推演)。
  const clock = timelineClock(world, state);
  return world.timeline
    .filter((event) => event.time <= clock)
    .filter((event) => (eventStates[event.id]?.status ?? "scheduled") === "scheduled")
    .filter((event) =>
      event.prerequisites.every((id) => eventStates[id]?.status === "resolved"),
    )
    .filter((event) =>
      !event.invalidatedBy.some((id) => eventStates[id]?.status === "resolved"),
    )
    .map((event) => ({
      ...event,
      delivery: event.locationId === state.locationId ? "present" : "rumor",
    }));
}

function deliverTimelineEvents(state, dueEvents) {
  // 没有到期事件时零拷贝返回：每回合省一次全量深拷贝。
  if (!dueEvents.length) return state;
  const next = clone(state);
  next.eventStates ??= {};
  for (const event of dueEvents) {
    next.eventStates[event.id] = {
      status: "delivered",
      deliveredTurn: next.turn,
      delivery: event.delivery,
    };
    // 顶替结算（拍板 2026-08-19）：替代事件真正落地时，它顶替的原著旧事
    // 一并标作废——见闻/时间线直接换成新线，旧事不再并列出现「多余的」。
    for (const replacedId of event.replacesIds ?? []) {
      const current = next.eventStates[replacedId];
      if (current && current.status !== "invalidated") {
        next.eventStates[replacedId] = {
          status: "invalidated",
          invalidatedTurn: next.turn,
          supersededBy: event.id,
          diverged: true,
          ...(current.status === "delivered" || current.status === "resolved"
            ? { formerStatus: current.status }
            : {}),
        };
      }
    }
  }
  return next;
}

function resolveTimelineEvents(world, state, option, committedPatches = []) {
  const next = clone(state);
  const actionTargets = new Set(
    [option.target?.id, option.requirements?.locationId].filter(Boolean),
  );
  const patchTargets = new Set(
    committedPatches.flatMap((item) =>
      typeof item === "string"
        ? [item]
        : [item.id, item.targetId, item.characterId, item.factionId, item.goalId],
    ).filter(Boolean),
  );
  for (const event of world.timeline) {
    const current = next.eventStates?.[event.id];
    if (current?.status !== "delivered") continue;
    const targets = event.resolutionTargetIds ?? [];
    const matches = (set) => !targets.length || targets.some((id) => set.has(id));
    const resolved =
      event.resolution === "world_time" ||
      (event.resolution === "player_action" && matches(actionTargets)) ||
      (event.resolution === "system_patch" && matches(patchTargets));
    if (resolved) {
      next.eventStates[event.id] = {
        ...current,
        status: "resolved",
        resolvedTurn: next.turn,
      };
    }
  }
  for (const event of world.timeline) {
    const current = next.eventStates?.[event.id];
    if (!current || ["resolved", "invalidated"].includes(current.status)) continue;
    if (event.invalidatedBy.some((id) => next.eventStates[id]?.status === "resolved")) {
      next.eventStates[event.id] = {
        ...current,
        status: "invalidated",
        invalidatedTurn: next.turn,
      };
    }
  }
  next.resolvedEventIds = Object.entries(next.eventStates)
    .filter(([, value]) => value.status === "resolved")
    .map(([id]) => id);
  // 已定命运不可改：本回合被世界时间自然 resolved/invalidated 的事件，其改命铺垫
  // 同步作废——留着只会进上下文诱导模型生成注定被硬门槛过滤的死选项。
  if (next.pendingDivergences?.length) {
    const settled = (targetId, targetType) =>
      targetType === "timeline" &&
      ["resolved", "invalidated"].includes(next.eventStates?.[targetId]?.status);
    next.pendingDivergences = next.pendingDivergences.filter(
      (item) => !settled(item.targetId, item.targetType),
    );
  }
  return next;
}

export function styleParagraphs(chapters = [], { min = 200, max = 400 } = {}) {
  const passages = [];
  for (const chapter of chapters) {
    let buffer = "";
    for (const line of String(chapter.text ?? "").split("\n")) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      buffer = buffer ? `${buffer}\n${trimmed}` : trimmed;
      if (buffer.length >= min) {
        passages.push({
          id: `${chapter.index}-${passages.length}`,
          chapterAnchor: chapter.index,
          text: buffer.slice(0, max),
        });
        buffer = "";
      }
    }
    if (buffer.length >= Math.min(min, 80)) {
      passages.push({
        id: `${chapter.index}-${passages.length}`,
        chapterAnchor: chapter.index,
        text: buffer.slice(0, max),
      });
    }
  }
  return passages;
}

// 原著此刻（canonNow，拍板 2026-08-17：推演必须仔细贴着原文；玩家已读完小说，
// 未解锁章节一律不过滤）。
// 取当前故事时刻附近的原文段落，作为叙事/选项/校验的权威依据。
// 锚章 = 最近一件已交付/已解决事件的 chapterAnchor；取 [锚章-1, 锚章+1] 窗口。
// 窗口内检索选段（拍板 2026-08-20：插叙/倒叙对位）：先以最近已投递事件与将至
// 事件的文本为查询词在窗口内 BM25 选段——插叙书的锚章邻章常叙述另一段故事
// 时间，盲取会把「现在时」段落当成此刻权威；检索命中的才是真正叙述该事件的
// 段落。窗口检索不足再窗口盲取兜底，仍不足用检索词全库补召回到上限 4 段。
// 无事件时退到第 1 章窗口；无索引返回 []。
export function canonNowPassages({ world, state, styleIndex, retrievalTerms = [], upcomingEvents = [] }) {
  if (!styleIndex) return [];
  const events = (world.timeline ?? [])
    .filter((event) =>
      ["delivered", "resolved"].includes(state?.eventStates?.[event.id]?.status),
    )
    .sort((left, right) => (Number(left.time) || 0) - (Number(right.time) || 0));
  const anchor = events.at(-1)?.chapterAnchor != null ? Number(events.at(-1).chapterAnchor) : 1;
  const windowStart = Math.max(1, anchor - 1);
  const windowEnd = anchor + 1;
  const inWindow = (passage) =>
    passage.chapterAnchor >= windowStart && passage.chapterAnchor <= windowEnd;
  // 窗口内检索：最近已投递事件（≤3 条）与将至事件的文本是「此刻」最好的查询词。
  const queryTerms = [
    ...events.slice(-3).map((event) => event.text ?? ""),
    ...upcomingEvents.map((event) => event.text ?? ""),
  ].filter(Boolean);
  const selected = queryTerms.length
    ? styleIndex.search(queryTerms.join(" "), { limit: 3, filter: inWindow })
    : [];
  // 兜底一：窗口盲取补足（正序书与旧行为一致）。
  if (selected.length < 3) {
    for (const passage of styleIndex.documents.filter(inWindow)) {
      if (selected.length >= 3) break;
      if (!selected.includes(passage)) selected.push(passage);
    }
  }
  // 兜底二：检索词并入玩家侧线索（地点/人物），全库补召回到上限。
  const backfillTerms = [...retrievalTerms, ...queryTerms].filter(Boolean);
  if (selected.length < 4 && backfillTerms.length) {
    const ranked = styleIndex.search(backfillTerms.join(" "), {
      limit: 4 - selected.length,
      filter: (passage) => !selected.includes(passage),
    });
    selected.push(...ranked);
  }
  return selected.slice(0, 4).map((passage) => ({
    chapter: passage.chapterAnchor,
    text: passage.text,
  }));
}

// 上下文字段白名单：剔除模型不需要也改不了的内部机制与重复数据。
// longTermMemories 已通过 retrievedMemories 提取 top-K，全量携带纯属 token 浪费；
// causalEvidence/schedulerState/eventStates/endingCandidate/characterJournal 是代码私有状态，
// 给模型看只会诱导它"手改"。chapterSummary 已在 context 顶层单独提供。
const CONTEXT_STATE_FIELDS = [
  "turn",
  "worldTime",
  "location",
  "locationId",
  "stats",
  "attributes",
  "conditions",
  "traits",
  "player",
  "relationships",
  "entityStates",
  "discoveredCharacterIds",
  "resolvedThreads",
  "retrievalKeywords",
  "personalGoals",
  "bonds",
  "factionMemberships",
  "survivalPressures",
  "adaptation",
  "bigFiveChanges",
  "playMode",
  "startingPoint",
  "powerEscape",
];

function publicContextState(state) {
  const entries = [];
  for (const field of CONTEXT_STATE_FIELDS) {
    const value = state[field];
    if (value !== undefined) entries.push([field, clone(value)]);
  }
  return Object.fromEntries(entries);
}

// 身份能力档案:选项与叙事从这里长出来——身份、能做什么、境界阶梯、当前数值、大五人格。
// 只做紧凑摘录,abilities 已在创角/回填时落进 player,旧世界退化为身份名+描述+数值。
function buildPlayerCapabilities(world, state) {
  const player = state.player ?? {};
  const role = world.roleTemplates?.find((item) => item.id === player.roleId);
  const realmTraits = realmTraitsOf(world)
    .slice(0, 12)
    .map((trait) => `${trait.name ?? ""}:${trait.value || trait.description}`)
    .filter(Boolean);
  // 大五人格进能力块:每维的分值档位 + 行为词 + 好面/坏面。
  // 底色中庸起步(拍板 2026-08-19:建角不再手选):行为词由演化选——某维跨入
  // 高/低档(≥70/≤30)才从词库取该极前两词,均衡维不带词(白纸不落性子)。
  const bigFive = BIG_FIVE_DIMENSIONS.map((dim) => {
    const value = Number(player.bigFive?.[dim] ?? 50);
    const level = bigFiveLevel(value);
    const options = world.creationCatalog?.bigFive?.[dim] ?? [];
    const side = level === "偏低" ? "low" : level === "偏高" ? "high" : null;
    const traits = side ? options.filter((item) => item.pole === side).slice(0, 2) : [];
    return {
      dimension: BIG_FIVE_LABELS[dim] ?? dim,
      key: dim,
      value: Number.isFinite(value) ? value : 50,
      level,
      selections: traits.map((item) => item.name),
      goodSide: traits.map((item) => item.goodSide).filter(Boolean),
      badSide: traits.map((item) => item.badSide).filter(Boolean),
    };
  });
  const identityAbilities = Array.isArray(player.abilities)
    ? player.abilities
    : Array.isArray(role?.abilities)
      ? role.abilities
      : [];
  // 习得技能(拍板 2026-08-19:习得制)与身份能力合并进上下文:
  // 模型据此知道玩家会什么——身份换了习得的仍在身。
  const learned = Array.isArray(player.learnedAbilities) ? player.learnedAbilities : [];
  const abilities = [...identityAbilities, ...learned];
  const traitIds = Array.isArray(player.traitIds)
    ? player.traitIds
    : (role?.traitIds ?? []).filter((id) => world.traits.some((trait) => trait.id === id));
  const traitList = traitIds
    .map((id) => world.traits.find((trait) => trait.id === id))
    .filter(Boolean)
    .map((trait) => `${trait.name ?? ""}:${trait.value || trait.description}`)
    .filter(Boolean);
  return {
    roleName: player.roleName ?? role?.name ?? "",
    roleDescription: role?.description ?? "",
    abilities,
    traitIds,
    traitList,
    realmTraits,
    stats: state.stats ?? {},
    attributes: state.attributes ?? {},
    bigFive,
    // 来历(拍板 2026-08-20:意图即人设):定约写定的白描进能力档案——叙事、
    // 选项与保真校验都看得见;空串即旧档新来者,各提示词按空串约束走。
    background: player.background ?? "",
    // 行囊(拍板 2026-08-19:具名行囊):叙事与选项的行动素材——有剑才能舞剑。
    inventory: (Array.isArray(player.inventory) ? player.inventory : []).map((item) =>
      item.note ? `${item.name}（${item.note}）` : item.name,
    ),
    // 性别:称谓与涉性别剧情从这里取材;旧档未定为 null。
    gender: player.gender ?? null,
  };
}

export function buildContext({
  world,
  state,
  history,
  dueEvents,
  styleIndex,
  factIndex,
  canonLedger = null,
  targetIds = [],
  dominantSystems = [],
  unresolvedThreads: unresolvedThreadsInput,
  openingNarrated = false,
}) {
  world = normalizeWorld(world);
  state = migrateState(state, world);
  // 惰性过滤：目标已不存在或已定（resolved/invalidated/死亡）的改命铺垫不再进
  // 上下文——留着只会诱导模型持续生成注定被硬门槛过滤掉的死选项。
  const pendingDivergences = (state.pendingDivergences ?? []).filter((item) =>
    divergenceTargetGate(world, state, {
      targetId: item.targetId,
      targetType: item.targetType,
      fire: false,
    }).ok,
  );
  // 天命难违信号（拍板 2026-08-17）：上一回合铺垫改命失败、势能归零时，给本回合
  // 一个「命运本身在抗拒」的基调信号——只带目标称呼，不带数值与机制字样。
  const lastTurn = Array.isArray(history) ? history.at(-1) : null;
  const fateResistance =
    lastTurn?.divergence?.fateResistance
      ? { target: lastTurn.divergence.target ?? "" }
      : null;
  const currentLocation = world.locations.find((location) => location.id === state.locationId);
  const localLocationIds = new Set([state.locationId, ...(currentLocation?.connections ?? [])]);
  // 在场即见(拍板):实体追踪显示就在玩家当前地点的人物,无论是否登记「已遇见」,
  // 都进上下文——原著场景里就在眼前的人,模型有权围绕 ta 生成选项。
  const presentCharacterIds = new Set(
    Object.entries(state.entityStates ?? {})
      .filter(([, entity]) => entity?.locationId === state.locationId)
      .map(([characterId]) => characterId),
  );
  const relevantCharacterIds = new Set([
    ...targetIds,
    ...presentCharacterIds,
    ...state.discoveredCharacterIds.filter((id) => {
      const locationId = state.entityStates[id]?.locationId;
      return !locationId || localLocationIds.has(locationId);
    }),
  ]);
  // 只带白名单字段的浅拷贝：人物精读会在世界对象上原地补写详细档案，
  // 引用共享会让历史 context 跟着「穿越式」变更；同时也能给 prompt 瘦身。
  // 动态状态账（人物状态追踪）：近窗口内的笔记随人物条目注入 currentState，
  // 过期的静默丢弃——entityStates 的行踪权威不受影响。
  const entityNotes = state.entityStateNotes ?? {};
  const freshNote = (characterId) => {
    const note = entityNotes[characterId];
    if (!note?.note) return null;
    return state.turn - Number(note.turn ?? 0) <= ENTITY_NOTE_FRESH_TURNS ? note.note : null;
  };
  const characters = world.characters
    .filter((character) => relevantCharacterIds.has(character.id))
    .map((character) => ({
      id: character.id,
      name: character.name,
      role: character.role,
      factionId: character.factionId,
      locationIds: character.locationIds,
      firstChapter: character.firstChapter,
      lastChapter: character.lastChapter,
      status: character.status,
      summary: character.summary,
      ...(freshNote(character.id) ? { currentState: freshNote(character.id) } : {}),
      // 人设卡四字段(temperament/motives/bottomLines/manner):叙事与结构提示词都把
      // persona 当作人物言行的唯一依据,不带它就等于让模型照着看不见的卡片演。
      ...(character.persona && typeof character.persona === "object"
        ? { persona: clone(character.persona) }
        : {}),
    }));
  const relevantFactionIds = new Set(
    [
      state.player.factionId,
      ...characters.map(
        (character) => state.entityStates[character.id]?.factionId ?? character.factionId,
      ),
    ].filter(Boolean),
  );
  const factions = world.factions
    .filter((faction) => relevantFactionIds.has(faction.id))
    .map((faction) => ({ id: faction.id, name: faction.name, summary: faction.summary }));
  const locations = world.locations
    .filter((location) => localLocationIds.has(location.id))
    .map((location) => ({ id: location.id, name: location.name, connections: location.connections }));
  const effective = effectiveFacts(world, state);
  // 玩家已读完小说（拍板 2026-08-17：未解锁章节一律不过滤），全部有效事实参与检索。
  const canonFacts = effective;
  // 原著到此为止已经发生的事(不含被 invalidated 的):世界现状的权威依据,
  // 按时间倒序取最近 6 条注入上下文。
  const canonPast = (world.timeline ?? [])
    .filter((event) =>
      ["delivered", "resolved"].includes(state.eventStates?.[event.id]?.status),
    )
    .sort((left, right) => (Number(left.time) || 0) - (Number(right.time) || 0))
    .slice(-6)
    .map((event) => ({ id: event.id, text: event.text, time: Number(event.time) || 0 }));
  const recentTurns = history.slice(-2).map((turn) => ({
    number: turn.number,
    narrative: turn.narrative,
    choice: turn.choice?.text,
    openThreads: turn.openThreads ?? [],
  }));
  // 让模型明确知道最近选过什么、判成了什么，避免重复与自相矛盾。
  const recentChoices = history.slice(-5).map((turn) => ({
    number: turn.number,
    choice: turn.choice?.text,
    result: turn.check?.result,
  }));
  // 连续两个回合没有实质变化时，把僵局挑明：本回合必须打破它。
  const staticTurns = state.consecutiveStaticTurns ?? 0;
  const stagnationWarning =
    staticTurns >= 2
      ? `连续 ${staticTurns} 个回合没有实质进展（没有数值变化、地点变动、关系变化或新线索）。本回合必须发生一件有实质后果的事，推动局面变化。`
      : null;
  const resolvedThreads = new Set(state.resolvedThreads);
  // 引擎侧增量维护的伏笔集合（O(1)）；未提供时回退到全量扫 history（测试/独立调用）。
  const unresolvedThreads = [
    ...new Set(unresolvedThreadsInput ?? history.flatMap((turn) => turn.openThreads ?? [])),
  ].filter((thread) => !resolvedThreads.has(thread));

  const retrievalTerms = new Set([
    ...state.retrievalKeywords,
    // 伏笔文本来自模型，偶尔不是字符串；这里只做取词，不值得为它炸掉一个回合。
    ...unresolvedThreads.flatMap((thread) => String(thread ?? "").split(/\s+/)),
    // 一跳图检索：把玩家当前处境的实体名（地点/势力/相关人物/目标方向）也放进
    // 检索词——事实文本通常含这些名字，能显著降低「关键词没命中就瞎编」的概率。
    ...[
      state.location,
      currentLocation?.name,
      ...factions.map((faction) => faction.name),
      ...characters.map((character) => character.name),
      ...(state.personalGoals ?? []).map((goal) => goal.publicDirection),
    ].filter((term) => typeof term === "string" && term.trim()),
  ]);
  // 事件事实变化生效的世界:检索索引按有效事实现建(总量 ≤80+动态,成本可忽略);
  // 静态世界继续用引擎缓存的 factIndex。
  const hasEventFactChanges = (world.timeline ?? []).some(
    (event) => (event.factsToAdd?.length ?? 0) > 0 || (event.factsToInvalidate?.length ?? 0) > 0,
  );
  const searchIndex =
    factIndex && !hasEventFactChanges ? factIndex : new Bm25Index(canonFacts);
  let retrievedFacts = searchIndex.search([...retrievalTerms].join(" "), { limit: 5 });
  // 兜底：一次都没命中时取最近的事实，保证模型总有接地锚点。
  if (!retrievedFacts.length && canonFacts.length) {
    retrievedFacts = canonFacts.slice(-5);
  }
  // 正典账本（拍板 2026-08-20：连贯性修复）：世界事实全库 ≤80+动态条，超长书
  // 远不够用；粗读账本里被 digestCoarse 裁掉的长尾事实在此按需检索补入，
  // 与世界事实去重后并列注入。账本缺席（老书无缓存）时原样回退旧行为。
  const factQuery = [...retrievalTerms].join(" ");
  const seenFactTexts = new Set(
    retrievedFacts.map((fact) => String(fact?.text ?? "").replace(/\s+/g, "")),
  );
  const ledgerFacts = (canonLedger?.searchFacts(factQuery, { limit: LEDGER_FACTS_LIMIT }) ?? []).filter(
    (fact) => {
      const key = String(fact?.text ?? "").replace(/\s+/g, "");
      if (!key || seenFactTexts.has(key)) return false;
      seenFactTexts.add(key);
      return true;
    },
  );
  if (ledgerFacts.length) retrievedFacts = [...retrievedFacts, ...ledgerFacts];
  const retrievedMemories = retrieveMemories(
    state.longTermMemories,
    [...retrievalTerms, state.location, state.chapterSummary].filter(Boolean).join(" "),
    state.unlockedChapter,
    5,
    {
      // 重排信号（记忆分层轮）：在场人物名与未解伏笔提权、新近度参与融合。
      presentNames: characters.map((character) => character.name),
      activeThreads: unresolvedThreads,
      currentTurn: state.turn ?? 0,
    },
  );
  const styleQuery = [
    ...retrievalTerms,
    ...recentTurns.map((turn) => turn.narrative ?? ""),
    state.location,
    state.chapterSummary,
  ]
    .filter(Boolean)
    .join(" ");
  const ranked = styleIndex?.search(styleQuery, { limit: 2 });
  const styleSamples = (ranked?.length ? ranked : (styleIndex?.documents ?? []).slice(0, 2)).map(
    (passage) => passage.text,
  );
  // 原著将至（拍板 2026-08-17：推演必须符合原著走向）：scheduled 且未被
  // invalidatedBy 拦下的原著事件，按故事时间升序取前 8 条——模型据此知道
  // 原著下一步的走向，推演若影响重大必须顺着它走。
  const upcomingEventIds = new Set();
  const canonUpcoming = (world.timeline ?? [])
    .filter((event) => state.eventStates?.[event.id]?.status === "scheduled")
    .filter((event) =>
      !(event.invalidatedBy ?? []).some((id) => state.eventStates?.[id]?.status === "resolved"),
    )
    .sort((left, right) => (Number(left.time) || 0) - (Number(right.time) || 0))
    .filter((event) => {
      if (upcomingEventIds.has(event.id)) return false;
      upcomingEventIds.add(event.id);
      return true;
    })
    .slice(0, 8)
    .map((event) => ({
      id: event.id,
      text: event.text,
      time: Number(event.time) || 0,
      chapterAnchor: Number(event.chapterAnchor ?? 1),
    }));
  // 伏笔簿（canonHorizon，拍板 2026-08-20：连贯性修复）：canonUpcoming 只给
  // 带故事时间的前 8 条，长线伏笔永远轮不到；粗读账本里锚章之后的关键事件
  // 在此按「到期窗口 + 相关性」补召——治「伏笔丢失」。锚章取已交付/已解决
  // 事件的最大章号（倒叙书里最后发生的事件未必出自最靠后的章，取最大章号
  // 才符合「此后的章节」语义），无事件时退到切入章节。
  const anchoredChapters = (world.timeline ?? [])
    .filter((event) =>
      ["delivered", "resolved"].includes(state.eventStates?.[event.id]?.status),
    )
    .map((event) => Number(event.chapterAnchor))
    .filter((chapter) => Number.isFinite(chapter) && chapter >= 1);
  const anchorChapter = anchoredChapters.length
    ? Math.max(...anchoredChapters)
    : Number(state.unlockedChapter) || 1;
  const canonHorizon = canonLedger
    ? canonLedger.horizon({ anchorChapter, query: factQuery, limit: HORIZON_LIMIT })
    : [];
  // 原著此刻（拍板 2026-08-17）：当前故事时刻附近的原文段落，推演必须仔细贴着原文。
  // 叙事、选项与保真校验都以它为权威背景；无段落时为空数组，按既有规则推演。
  const canonNow = canonNowPassages({
    world,
    state,
    styleIndex,
    retrievalTerms: [...retrievalTerms],
    upcomingEvents: canonUpcoming,
  });
  const activeEvents = world.timeline
    .filter((event) => state.eventStates?.[event.id]?.status === "delivered")
    .map((event) => ({
      id: event.id,
      text: event.text,
      locationId: event.locationId,
      resolution: event.resolution,
    }));

  return {
    world: {
      title: world.title,
      characters,
      factions,
      locations,
      traits: world.traits,
      stats: world.stats,
      attributes: world.attributes,
      ...(world.style ? { style: world.style } : {}),
    },
    state: publicContextState(state),
    // 交锋展示字段：数值留在引擎里，模型只看到文字标签。
    activeClash: state.activeClash
      ? {
          opponentId: state.activeClash.opponentId,
          opponentName: state.activeClash.opponentName,
          opponentCondition: CLASH_CONDITIONS[state.activeClash.opponentCondition],
          playerCondition: playerClashCondition(state, world),
          stance: stanceLabel(state.activeClash.stance),
          step: state.activeClash.step,
          maxSteps: state.activeClash.maxSteps,
          origin: state.activeClash.origin,
          reason: state.activeClash.reason,
          pendingDeath: state.activeClash.pendingDeath,
        }
      : null,
    recentTurns: clone(recentTurns),
    recentChoices: clone(recentChoices),
    stagnationWarning,
    activeDivergence: pendingDivergences.length
      ? clone(pendingDivergences.map((item) => ({
          targetId: item.targetId,
          targetType: item.targetType,
          momentum: item.momentum,
          threshold: divergenceThreshold(world, item.targetType, item.targetId),
        })))
      : null,
    chapterSummary: state.chapterSummary,
    // 远期梗概（记忆分层 2026-08-21）：更早岁月的大要——中窗摘要每攒满 15 回
    // 折叠一次进来。开场续写期与折叠前为空串，提示词按空处理。
    storyDigest: String(state.storyDigest ?? ""),
    // 弧线导演(拍板:隐藏+回望):只暴露当前节拍与弧线总纲;卷名、节拍表、
    // 计划终局回合都是私有状态,给模型看只会诱导它把弧线当剧本直写。
    arcBeat: arcBeatView(state.arc),
    // 开场续写信号:本世第一回合时 chapterSummary 是已写好的开场正文(读者已读),
    // 叙事提示词据此要求接续而非复述。只在开场后的第一回合注入。
    priorOpening:
      openingNarrated &&
      typeof state.chapterSummary === "string" &&
      state.chapterSummary.trim()
        ? state.chapterSummary
        : null,
    unresolvedThreads,
    retrievedFacts,
    retrievedMemories,
    styleSamples,
    canonNow: clone(canonNow),
    // 原著将至（拍板 2026-08-17：推演必须符合原著走向）：即将发生的原著事件。
    canonUpcoming: clone(canonUpcoming),
    // 伏笔簿（拍板 2026-08-20）：粗读账本里锚章之后的关键事件摘录——近期将至的
    // 按章节远近在前，其余是与此刻处境相关的长线伏笔；与 canonUpcoming 冲突时
    // 以 canonUpcoming 为准（它是带故事时间的权威时间线）。账本缺席时为空数组。
    canonHorizon: clone(canonHorizon),
    // 故事时钟(拍板:推演的时间贴着原著走):当前故事时刻的可读视图(「第 N 日 · 时段」),
    // 外加距下一件原著大事的分钟数。#play 里 state 已含本回合 timeCost、未含跨日跳跃,
    // 即「本回合行动完成后的当前时刻」——正文的昼夜、日期与时间流逝以它为唯一权威。
    storyClock: storyClockView(world, state),
    dueEvents: clone(dueEvents),
    activeEvents,
    // 涌现故事(拍板 2026-08-17):玩家一路长出的原创故事线——模型据此知道
    // 哪些故事在生长,可在回合结算用 storyImpacts 推进它们;tier 只作文字性的
    // 影响力提示,不泄露阈值与机制数值。
    emergentStories: (state.emergentStories ?? []).map((story) => ({
      id: story.id,
      title: story.title,
      summary: story.summary,
      momentum: story.momentum,
      tier: story.tier,
    })),
    // 同行者(拍板 2026-08-17):随行的涌现人物——叙事里带出他们的言行,
    // 结算里以 companionJoin/companionLeave 声明入队与离队。
    companions: (state.companions ?? []).map((item) => ({
      id: item.characterId,
      name: item.name,
      note: item.note,
      sinceTurn: item.sinceTurn,
    })),
    // 玩家原创实体（拍板 2026-08-21）：玩家用「原创一笔」造的门派/身份/地点/
    // 物品/人物——对模型是真实世界事实：意图点名、选项围绕、叙事演出皆合法
    // （条款见 prompt.js 的 OPTION_RULES）。历世所造一并可见（world 跨转世持久）。
    playerCreations: playerCreationsView(world),
    // 原著已发生的事(世界现状权威依据):叙事与选项必须与之一致。
    canonPast: clone(canonPast),
    dominantSystems: clone(dominantSystems),
    // 身份进阶：只暴露「此刻可走」的路径；不带 toRoleId 与目标身份名（防剧透）。
    roleProgression: eligibleProgression(world, state).map((path) => ({
      id: path.id,
      fromRoleId: path.fromRoleId,
      triggerEvents: path.triggerEvents.map((event) => ({
        id: event.id,
        name: event.name,
        description: event.description,
      })),
    })),
    // 上一次拒绝的转变：一次性注入，让代价由剧情揭晓。
    refusedTransition: state.lastRefusedTransition
      ? clone(state.lastRefusedTransition)
      : null,
    // 阶段临近信号：核心目标已达成但命运尚未合拢，给叙事留伏笔回合。
    // 只带公开方向与稳定性计数，绝不泄露隐藏目标细节;合拢回合本身不带。
    endingApproach:
      state.endingCandidate && !state.endingCandidate.ready
        ? {
            stableTurns: state.endingCandidate.stableTurns,
            publicDirection:
              state.personalGoals?.find(
                (goal) => goal.id === state.endingCandidate?.goalId,
              )?.publicDirection ?? "",
          }
        : null,
    // 命运松动信号(拍板 2026-08-17):势能已达各自分级阈值的铺垫改命,让叙事与
    // 选项自然带出「这一手该出手了」;只传目标与称呼,不传势能数值与机制字样。
    divergenceApproach: pendingDivergences
      .filter(
        (item) => item.momentum >= divergenceThreshold(world, item.targetType, item.targetId),
      )
      .map((item) => ({
        targetId: item.targetId,
        targetType: item.targetType,
        label: divergenceTargetLabel(world, item, state),
      })),
    // 天命难违(见上文 fateResistance 注释):势能归零不是主角无能,是命运反弹。
    fateResistance,
    // 身份能力档案:选项与叙事必须从它长出来(能力式行动、数值相称)。
    playerCapabilities: buildPlayerCapabilities(world, state),
    journal: buildCharacterJournal(state),
  };
}

export class SnapshotStore {
  constructor(initialState) {
    this.snapshots = [clone(initialState)];
  }

  get current() {
    return clone(this.snapshots.at(-1));
  }

  push(state) {
    this.snapshots.push(clone(state));
    // undo 只需要倒数第二份，多留几份是余量；不裁剪会让内存随回合线性膨胀。
    if (this.snapshots.length > 5) {
      this.snapshots.splice(0, this.snapshots.length - 5);
    }
  }

  undo() {
    if (this.snapshots.length === 1) throw new Error("Cannot undo initial state");
    this.snapshots.pop();
    return this.current;
  }
}

export class StoryEngine {
  #styleIndex = undefined;
  #styleIndexBuilt = false;

  constructor({
    world,
    initialState,
    llm,
    seed = 1,
    maxRewrites = 1,
    memory,
    sourceChapters = [],
    detailCharacter,
    canonLedger = null,
    entityTracker = null,
    onPhase,
  }) {
    this.world = validateWorld(world);
    initialState = validateInitialState(initialState, this.world);
    this.store = new SnapshotStore(initialState);
    this.history = [];
    this.llm = llm;
    this.random = createSeededRandom(seed);
    this.maxRewrites = maxRewrites;
    this.rewriteCount = 0;
    this.busy = false;
    this.memory = memory;
    this.backgroundQueue = Promise.resolve();
    // 世系计数：undo/重玩后自增，后台记忆任务据此识别旧世系并作废。
    this.lineage = 0;
    // 未解决伏笔的增量集合：buildContext 不再每回合全量扫 history。
    this.openThreadSet = new Set();
    this.sourceChapters = sourceChapters;
    // 正典账本（连贯性修复）：可空——老书没有粗读缓存时各注入点自动回退。
    // 主进程异步加载完成后可直接赋值（引擎每回合现读该字段）。
    this.canonLedger = canonLedger ?? null;
    // 人物状态追踪器（连贯性修复）：可空——无快模型通道（演示模式）时不记账。
    this.entityTracker = entityTracker ?? null;
    // 文风索引懒建：整本小说切段+双字词索引是 O(全文) 的 CPU 活，
    // 放在构造器里会让「打开一本书」的主进程卡顿。首次需要（第一回合建上下文）时才建。
    this.factIndex = new Bm25Index(this.world.facts);
    this.detailCharacter = detailCharacter;
    // 回合阶段事件:等待面板的阶段化文案靠它驱动,没有就静默跳过。
    this.onPhase = typeof onPhase === "function" ? onPhase : null;
    // 行为自适应:观察者由客户端提供(observePlayer),没有就静默跳过。
    this.observePlayer =
      typeof llm?.observePlayer === "function" ? (payload) => llm.observePlayer(payload) : null;
  }

  styleIndexFor() {
    if (!this.#styleIndexBuilt) {
      const passages = styleParagraphs(this.sourceChapters);
      this.#styleIndex = passages.length ? new Bm25Index(passages) : undefined;
      this.#styleIndexBuilt = true;
    }
    return this.#styleIndex;
  }

  flushBackground() {
    return this.backgroundQueue;
  }

  // 回合阶段事件:回调由客户端提供,失败不能影响回合本身。
  #phase(name) {
    try {
      this.onPhase?.(name);
    } catch {}
  }

  // 开场与终章也要贴着原著写:取全书里与查询最贴的原文段落（拍板 2026-08-17：
  // 玩家已读完小说，未解锁章节一律不过滤）。
  styleSamplesFor({ query = "", limit = 2 } = {}) {
    const styleIndex = this.styleIndexFor();
    if (!styleIndex) return [];
    const ranked = styleIndex.search(query, { limit });
    return (ranked.length ? ranked : styleIndex.documents.slice(0, limit)).map(
      (passage) => passage.text,
    );
  }

  async play(option, options = {}) {
    if (this.busy) throw new Error("A turn is already in progress");
    // 本世已终局（阶段合拢/命运收束）：继续推演会产出与终局矛盾的状态，
    // 「继续这个角色」才是唯一合法出路（它会显式清掉候选）。
    if (this.store.current.endingCandidate?.ready) {
      throw new Error("这一卷已经合上，请先续写新的阶段");
    }
    this.busy = true;
    const randomState = this.random.getState();
    const rewriteCount = this.rewriteCount;
    try {
      return await this.#play(option, options);
    } catch (error) {
      this.random.setState(randomState);
      this.rewriteCount = rewriteCount;
      throw error;
    } finally {
      this.busy = false;
    }
  }

  // 意图先行(拍板 2026-08-17 追加:预设选项全部取消,普通回合选项由玩家意图动态产生)。
  // 玩家声明方向后,围绕意图重生成当前处境的下一步选项。
  // 只用快模型;生成失败或全部校验不过时回落兜底选项,绝不把错误抛穿给界面。
  async generateOptions({ intent = "", signal } = {}) {
    if (this.busy) throw new Error("回合正在进行中，请稍候");
    // 与 play/updateGoal 同一把 busy 闩:选项生成期间不允许插入回合,否则软修复
    // 与预取读到的是「回合后」状态,而选项是按「回合前」上下文生成的。
    this.busy = true;
    try {
      return await this.#generateOptionsNow({ intent, signal });
    } finally {
      this.busy = false;
    }
  }

  async #generateOptionsNow({ intent, signal }) {
    if (this.store.current.endingCandidate?.ready) {
      throw new Error("这一卷已经合上，请先续写新的阶段");
    }
    const context = buildContext({
      world: this.world,
      state: this.store.current,
      history: this.history,
      styleIndex: this.styleIndexFor(),
      canonLedger: this.canonLedger,
      unresolvedThreads: [...this.openThreadSet],
    });
    let fallback = true;
    let options = [];
    if (typeof this.llm?.generateIntentOptions === "function") {
      try {
        const generated = await this.llm.generateIntentOptions({ context, intent, signal });
        const checked = validOptionSet(generated, this.store.current, this.world);
        if (checked.usable) {
          options = checked.options;
          fallback = false;
        } else {
          // 软修复:结构完整但处境不可用的选项,若失败点是「指向未遇见且不在场的人物」,
          // 剥掉 target 再验一次(保持选项文本与意图,只是不再对该人物结算),仍不过才落兜底。
          const stripUnmetTarget = (item) => {
            if (!item || item.target?.type !== "character") return item;
            const targetId = item.target.id;
            const entity = this.store.current.entityStates?.[targetId];
            if (entity?.status === "dead") return item; // 死者不可指向,保留过滤
            if (this.store.current.discoveredCharacterIds?.includes(targetId)) return item;
            if (entity?.locationId === this.store.current.locationId) return item; // 在场可见
            return { ...item, target: undefined };
          };
          const stripped = (Array.isArray(generated) ? generated : []).map(stripUnmetTarget);
          const repaired = validOptionSet(stripped, this.store.current, this.world);
          if (repaired.usable) {
            options = repaired.options;
            fallback = false;
          }
        }
      } catch {
        // 意图生成失败:回落兜底选项,由调用方提示,不消耗回合。
      }
    }
    // 意图选项保真校验(拍板 2026-08-17):普通回合选项是玩家与世界交互的唯一接口,
    // 也是世界观/原著失真的最大入口。生成后用快模型按身份能力/在场人设/世界观/
    // 原著此刻与走向校验一次;有违例带清单重生成一次,重生成仍不过或校验失败则
    // 放行首轮选项——软兜底,绝不把错误抛穿给意图流程。
    if (!fallback && typeof this.llm?.checkIdentityConsistency === "function" && context.playerCapabilities) {
      try {
        const onScreenIds = new Set(
          Object.entries(this.store.current.entityStates ?? {})
            .filter(([, entity]) => entity?.locationId === this.store.current.locationId)
            .map(([characterId]) => characterId),
        );
        const verdict = await this.llm.checkIdentityConsistency({
          narrative: "",
          options,
          capabilities: context.playerCapabilities,
          characters: onScreenCharactersForCheck(this.world, this.store.current, onScreenIds),
          worldview: worldviewForCheck(this.world),
          canonNow: context.canonNow ?? [],
          canonUpcoming: context.canonUpcoming ?? [],
          canonHorizon: context.canonHorizon ?? [],
          storyClock: context.storyClock
            ? {
                label: context.storyClock.label,
                day: context.storyClock.day,
                hour: context.storyClock.hour,
                segment: context.storyClock.segment,
              }
            : null,
          signal,
        });
        const issues = (verdict?.issues ?? []).filter((item) => item.where === "options");
        if (verdict?.ok === false && issues.length) {
          const regenerated = await this.llm.generateIntentOptions({
            context,
            intent,
            correctionNote: issues.map((item) => `- ${item.text}`).join("\n"),
            signal,
          });
          const rechecked = validOptionSet(regenerated, this.store.current, this.world);
          if (rechecked.usable) options = rechecked.options;
        }
      } catch {
        // 校验或重生成失败:首轮选项已在手,静默放行。
      }
    }
    if (fallback) options = fallbackOptions(this.world, this.store.current);
    // 选项围绕意图生成:相关人物的精读预取也随之而来(背景队列,失败静默)。
    this.#prefetchCharacters(options, this.store.current);
    return { options, fallback };
  }

  // 分层意图(拍板:弧线导演):改写长远志向——写入 personalGoals[0] 并作废当前弧线,
  // 下一回合由导演围绕新志向重规划(四触发器之一)。空串=放开志向,回落默认。
  updateGoal({ goal } = {}) {
    if (this.busy) throw new Error("回合正在进行中，请稍候");
    const cleaned = String(goal ?? "")
      .replace(/[\u0000-\u001f\u007f]/g, "")
      .replace(/[「」""]/g, "")
      .trim()
      .slice(0, 60) || "在这座书城活出自己的路";
    const state = this.store.snapshots[this.store.snapshots.length - 1];
    const goals = Array.isArray(state.personalGoals) ? state.personalGoals : [];
    const base = goals[0] ?? {
      id: "core-goal-1",
      kind: "core",
      status: "active",
      direction: "living",
      evidenceIds: [],
      milestones: [],
      blockers: [],
      transformationHistory: [],
      endingEligible: false,
    };
    state.personalGoals = [{ ...base, motive: cleaned, publicDirection: cleaned }, ...goals.slice(1)];
    // 志向改向:当前弧线作废,下回合重规划——旧弧线朝旧志向收束,留着只会拧着走。
    state.arc = null;
    return { goal: cleaned };
  }

  // 分层意图:改写当前谋算——只影响后续回合的叙事与选项取势,不动弧线(节拍自己吸收)。
  updateScheme({ scheme } = {}) {
    if (this.busy) throw new Error("回合正在进行中，请稍候");
    const cleaned = String(scheme ?? "")
      .replace(/[\u0000-\u001f\u007f]/g, "")
      .replace(/[「」""]/g, "")
      .trim()
      .slice(0, 40);
    const state = this.store.snapshots[this.store.snapshots.length - 1];
    state.player = { ...(state.player ?? {}), scheme: cleaned };
    return { scheme: cleaned };
  }

  async #play(option, options = {}) {
    const signal = options.signal;
    const startedAt = performance.now();
    const timings = {};
    const before = this.store.current;
    option = { timeCost: this.world.rules?.defaultTimeCost ?? DEFAULT_RULES.defaultTimeCost, ...option };
    // 被选中的选项也可能来自旧存档或 repairOptions，字段可能缺失/退化。
    // 在入口做一次完整兜底：timeCost 越界钳到范围、risk 非法回落 safe、属性缺失回落首个。
    const maxTimeCost = this.world.rules?.maxTimeCost ?? DEFAULT_RULES.maxTimeCost;
    if (!Number.isFinite(option.timeCost) || option.timeCost < 0 || option.timeCost > maxTimeCost) {
      option.timeCost = this.world.rules?.defaultTimeCost ?? DEFAULT_RULES.defaultTimeCost;
    }
    let selectedRisk = option.risk;
    try {
      riskToDifficulty(selectedRisk);
    } catch {
      selectedRisk = "safe";
    }
    option.risk = selectedRisk;
    const attribute =
      this.world.attributes.find((item) => item.id === option.attribute) ??
      this.world.attributes[0];
    // validateWorld 保证 attributes 非空；这里不再抛错。
    option.attribute = attribute.id;

    if (!optionIsAvailable(option, before, this.world)) {
      throw new Error("这个行动不符合当前处境");
    }

    // 开场已写回 chapterSummary(读者已在界面读过):第一回合必须接着开场写,
    // 不能复述。标志只活一个回合,过后 chapterSummary 会被分层摘要逐步替换。
    const openingNarrated = Boolean(before.openingNarrated);

    let stateAfterTime = {
      ...before,
      turn: before.turn + 1,
      worldTime: before.worldTime + option.timeCost,
      openingNarrated: false,
    };
    // 阅读范围由进入意图一次定死(拍板:不再随时间扩张),此处不动 unlockedChapter。
    const dueEvents = dueTimelineEvents(this.world, stateAfterTime);
    stateAfterTime = deliverTimelineEvents(stateAfterTime, dueEvents);
    const scheduling = scheduleGameplaySystems(stateAfterTime, stateAfterTime.turn);
    stateAfterTime.schedulerState = scheduling.schedulerState;
    const modifiers = actionModifiers(option, before);
    const random = this.random;
    const check = rollCheck({
      attributeValue: before.attributes[attribute.id],
      risk: option.risk,
      // 爽文拍板「隐藏判定偏向玩家」:恒定有利修正,数值永不进提示词与界面。
      modifier:
        modifiers.total +
        Number(before.adaptation?.difficultyBias ?? 0) +
        (before.playMode === "power" ? POWER_ROLL_BIAS : 0),
      random,
      rules: this.world.rules,
    });
    check.modifiers = modifiers;
    if (!VALID_RESULTS.has(check.result)) throw new Error("Invalid check result");

    const targetIds = responseTargetsFromOption(option);
    // 离屏漂移：本回合的行动对象与玩家所在地点的人物留在原地，其余人物按世界
    // 时间在其惯常地点间确定性轮换——世界在幕后「动」，读档/重玩后位置一致。
    const onScreenIds = new Set([
      ...targetIds,
      ...Object.entries(stateAfterTime.entityStates ?? {})
        .filter(([, entity]) => entity?.locationId === stateAfterTime.locationId)
        .map(([characterId]) => characterId),
    ]);
    stateAfterTime = offscreenLocationTick(stateAfterTime, this.world, onScreenIds);
    // 世界事实可能被转世/身份转变/原创实体等路径改写（push 或整组替换），
    // 构造期建的索引会过时。每回合重建保证新事实可检索——事实数有上限，开销可忽略。
    this.factIndex = new Bm25Index(this.world.facts);
    // 弧线导演(拍板:剧情层叠加):回合开始处保证有弧线可演——每 8 回合先做漂移检查
    // (快模型,玩家用行动投票导演得看得见),换线则重规划;没有弧线且不在搏杀中,
    // 就围绕志向与谋算规划一条(强模型,低频:一次服务 5-10 回合)。任何失败都静默
    // 跳过,游戏退回逐回合即兴,绝不拦回合。
    let arc = clone(stateAfterTime.arc ?? null);
    if (!stateAfterTime.activeClash) {
      if (
        arc &&
        stateAfterTime.turn % ARC_DRIFT_INTERVAL === 0 &&
        typeof this.llm?.checkArcDrift === "function"
      ) {
        try {
          this.#phase("directing");
          const verdict = await this.llm.checkArcDrift({
            arc,
            state: stateAfterTime,
            history: this.history,
            signal,
          });
          const action = sanitizeDriftVerdict(verdict?.verdict);
          if (action === "replace") arc = null;
          else if (action === "adjust") arc = jumpToResolution(arc);
        } catch (error) {
          // 兜底只吞模型故障；用户点了「停一下」要立即抛穿，不能吞掉继续推。
          if (signal?.aborted) throw error;
          // 漂移检查失败:保持当前弧线(keep 保底)。
        }
      }
      if (!arc && typeof this.llm?.generateArcPlan === "function") {
        try {
          this.#phase("directing");
          const plan = await this.llm.generateArcPlan({
            world: this.world,
            state: stateAfterTime,
            history: this.history,
            arcHistory: Array.isArray(stateAfterTime.arcHistory)
              ? stateAfterTime.arcHistory
              : [],
            signal,
          });
          arc = sanitizeArc(plan, { turn: stateAfterTime.turn });
        } catch (error) {
          // 同上：取消即抛，失败才静默。
          if (signal?.aborted) throw error;
          // 规划失败:这一回合照旧即兴,下一回合再试。
        }
      }
    }
    stateAfterTime = { ...stateAfterTime, arc };
    let context = buildContext({
      world: this.world,
      state: stateAfterTime,
      history: this.history,
      dueEvents,
      styleIndex: this.styleIndexFor(),
      factIndex: this.factIndex,
      canonLedger: this.canonLedger,
      targetIds,
      dominantSystems: scheduling.dominant,
      unresolvedThreads: [...this.openThreadSet].slice(-MAX_CONTEXT_THREADS),
      openingNarrated,
    });
    // 时间流逝锚点（拍板 2026-08-21：正文必须交代过了多久）：上一手结算后的
    // 时钟（含上一手跳跃、未含本回合 timeCost）。叙事提示词据此要求开头写明
    // 时段推移或跨日天数，保真校验据此抓「跨了天却只字不提」。
    const clockPrev = storyClockView(this.world, before);
    context.storyClockPrev = {
      label: clockPrev.label,
      day: clockPrev.day,
      hour: clockPrev.hour,
      segment: clockPrev.segment,
    };
    timings.contextMs = performance.now() - startedAt;

    // 人物首次精读不再阻塞叙事：改用世界档案里的 summary 先生成这一回合，
    // 精读在后台异步补上，结果从下一回合起生效（缓存由 detailCharacter 负责去重）。
    // 首回合同样走 backgroundQueue：裸 Promise.all 会与队列里的记忆任务并发
    // 读写 world/history，破坏「后台任务串行」的契约。
    if (this.detailCharacter && targetIds.length) {
      const detailStartedAt = performance.now();
      const undetailed = targetIds
        .map((characterId) => this.world.characters.find((item) => item.id === characterId))
        .filter((character) => character && !character.detailed);
      this.backgroundQueue = this.backgroundQueue
        .then(async () => {
          await Promise.all(
            undetailed.map((character) =>
              this.detailCharacter({
                character,
                sourceChapters: this.sourceChapters,
                context,
              })
                .then((detailed) => mergeDetailInto(character, detailed, { id: character.id, detailed: true }))
                .catch(() => {}),
            ),
          );
        })
        .catch(() => {})
        .finally(() => {
          timings.characterDetailMs = performance.now() - detailStartedAt;
        });
    }

    // 交锋预演：advanceClash 是纯函数，先算一次只为知道本回合是否收束——
    // 收束回合要用强模型完整收束，交锋中的小回合即使 risk=dire 也走快模型短叙事。
    const clashPreview = advanceClash({
      state: stateAfterTime,
      option,
      check,
      world: this.world,
    });
    // 只有真高潮才走强模型（首字节 1-2 分钟）：交锋收束、濒死最后一搏，
    // 以及弧线的转折/收束节拍（拍板:节拍升级——关键节拍的叙事与选项都升档）。
    // dire 行动、主线事件、暴击、首次见人仍降级到快模型，换取秒级回合。
    const beatKey = Boolean(context.arcBeat?.isKey);
    const keyTurn =
      Boolean(clashPreview.ended) ||
      Boolean(stateAfterTime.activeClash?.pendingDeath) ||
      beatKey;
    // 关键回合向界面亮明：强模型全笔推演慢得多（首字节以分钟计），等待期
    // 先给玩家交代「这一手值得等」，而不是让「推演中」无差别地拉长。
    if (keyTurn) this.#phase("key-turn");
    const endingTurn = Boolean(before.endingCandidate?.ready);
    const timeoutMs = endingTurn
      ? TURN_TIMEOUTS.ending
      : keyTurn
        ? TURN_TIMEOUTS.key
        : TURN_TIMEOUTS.ordinary;
    const generationStartedAt = performance.now();
    // 回合级总预算：叙事与结构两阶段共用一条 deadline。deadline 一到，
    // 客户端把外部信号与自带超时合并，在途请求立即中断、重试随之停止，
    // 不再出现「两阶段各自满额 + 各自重试」让普通回合远超声明时长。
    const deadlineSignal = AbortSignal.timeout(Math.max(1, timeoutMs));
    const turnSignal = signal ? AbortSignal.any([signal, deadlineSignal]) : deadlineSignal;
    // 双请求协议第一步：叙事。模型只写小说正文，没有格式负担。
    let narrativeResult;
    try {
      narrativeResult = await this.llm.generateStory({
        context,
        choice: option,
        check,
        keyTurn,
        endingTurn,
        timeoutMs,
        signal: turnSignal,
      });
    } catch (error) {
      this.llm.discardNarrative?.();
      throw error;
    }
    if (
      !narrativeResult ||
      typeof narrativeResult !== "object" ||
      typeof narrativeResult.narrative !== "string"
    ) {
      throw new Error("叙事适配器返回了无效结果：generateStory 必须返回 { narrative }");
    }
    if (Number.isFinite(narrativeResult.transportTimings?.ttftMs)) {
      timings.ttftMs = narrativeResult.transportTimings.ttftMs;
    }
    let narrative = narrativeResult.narrative;
    this.#phase("narrative-done");

    // 保真校验共享输入(拍板 2026-08-17):在场原著人物人设卡 + 世界观摘要 + 原著此刻与将至
    // + 当前故事时钟,一次构建、叙事/选项两处校验复用——校验仍是每处一次快模型请求,
    // 不新增请求数。
    const clockForCheck = storyClockView(this.world, stateAfterTime);
    const fidelityInput = {
      characters: onScreenCharactersForCheck(this.world, stateAfterTime, onScreenIds),
      worldview: worldviewForCheck(this.world),
      canonNow: context.canonNow ?? [],
      canonUpcoming: context.canonUpcoming ?? [],
      canonHorizon: context.canonHorizon ?? [],
      storyClock: {
        label: clockForCheck.label,
        day: clockForCheck.day,
        hour: clockForCheck.hour,
        segment: clockForCheck.segment,
      },
      storyClockPrev: context.storyClockPrev ?? null,
    };

    // 身份一致硬校验(叙事):快模型核对叙事是否让玩家做出了身份之外的能力,
    // 以及出场原著人物言行是否符合人设与世界观。违例给一次强模型重写机会
    // (带违例清单);校验本身失败不拦回合。
    if (this.llm.checkIdentityConsistency && context.playerCapabilities) {
      try {
        const verdict = await this.llm.checkIdentityConsistency({
          narrative,
          options: [],
          capabilities: context.playerCapabilities,
          ...fidelityInput,
          signal: turnSignal,
        });
        const issues = (verdict?.issues ?? []).filter((item) => item.where !== "options");
        if (verdict?.ok === false && issues.length) {
          const checkStartedAt = performance.now();
          this.#phase("rewriting");
          const rewritten = await this.llm.generateStory({
            context,
            choice: option,
            check,
            keyTurn,
            endingTurn,
            timeoutMs,
            signal: turnSignal,
            rewriteNote:
              "上次叙事有身份一致违例，请重写本回合叙事：保持判定结果与情节走向不变，只修正违例。违例清单：\n" +
              issues.map((item) => `- ${item.text}`).join("\n"),
          });
          if (rewritten?.narrative && typeof rewritten.narrative === "string") {
            narrative = rewritten.narrative;
          }
          timings.consistencyRewriteMs = performance.now() - checkStartedAt;
        }
      } catch (error) {
        // 取消即抛：校验兜底不为「停一下」续命。
        if (signal?.aborted) throw error;
        // 校验失败(超时/断网)不影响回合:提示词约束与硬门槛仍在。
      }
    }

    // 双请求协议第二步：结构。叙事已定稿，结构失败只重试结构，不重写正文。
    let response;
    let lastError;
    this.#phase("structure");
    for (let attempt = 0; attempt <= this.maxRewrites; attempt += 1) {
      try {
        let payload = await this.llm.generateStructure({
          narrative,
          context,
          choice: option,
          check,
          attempt,
          timeoutMs,
          signal: turnSignal,
          strong: beatKey,
        });
        // 结构+语义一次性清洗：未知 stat/属性、非法 risk、重复 axis、越界 timeCost
        // 等违约都被丢弃/回落，剩下只有 narrative 空这类致命错误才走修复/重写。
        const prepare = (value) => sanitizeTurnPayload(value, this.world);
        payload = prepare(payload);
        try {
          validateResponse({ narrative, ...payload }, this.world);
        } catch (error) {
          if (!this.llm.repairResponse) throw error;
          const repairStartedAt = performance.now();
          this.#phase("repair");
          payload = prepare(
            await this.llm.repairResponse({
              narrative,
              payload,
              error,
              context,
              check,
              signal: turnSignal,
            }),
          );
          validateResponse({ narrative, ...payload }, this.world);
          timings.jsonRepairMs = performance.now() - repairStartedAt;
        }
        response = { narrative, ...payload };
        lastError = undefined;
        break;
      } catch (error) {
        // 用户取消立即抛穿：AbortError 不该被当成结构失败再空转一轮重试。
        if (signal?.aborted) throw error;
        lastError = error;
        if (attempt < this.maxRewrites) {
          this.rewriteCount += 1;
        }
      }
    }
    if (lastError) throw lastError;

    // 身份一致硬校验(选项):违例给一次结构重生成机会(带违例清单)。
    // 仍不过则交给下方硬门槛(optionIsAvailable/修复兜底),校验失败不拦回合。
    // 普通回合 options 为空(双请求协议:选项由意图流另行生成)时整次请求都是
    // 空转——本调用只消费 where=options 的违例,没选项就没可查的,直接跳过
    // (记忆分层轮 2026-08-21:省每普通回合一次快调用,反哺远期折叠的成本)。
    if (this.llm.checkIdentityConsistency && context.playerCapabilities && (response.options ?? []).length) {
      try {
        const verdict = await this.llm.checkIdentityConsistency({
          narrative,
          options: response.options ?? [],
          capabilities: context.playerCapabilities,
          ...fidelityInput,
          signal: turnSignal,
        });
        const issues = (verdict?.issues ?? []).filter((item) => item.where !== "narrative");
        if (verdict?.ok === false && issues.length) {
          const checkStartedAt = performance.now();
          this.#phase("rewriting");
          const corrected = sanitizeTurnPayload(
            await this.llm.generateStructure({
              narrative,
              context,
              choice: option,
              check,
              attempt: 0,
              timeoutMs,
              signal: turnSignal,
              strong: beatKey,
              correctionNote:
                "上次选项有身份一致违例，请重新生成选项（叙事不变），只修正违例。违例清单：\n" +
                issues.map((item) => `- ${item.text}`).join("\n"),
            }),
            this.world,
          );
          try {
            validateResponse({ narrative, ...corrected }, this.world);
            response = { narrative, ...corrected };
          } catch {
            // 修正版不合法:保留原版,交给硬门槛与修复兜底处理。
          }
          timings.consistencyRewriteMs =
            (timings.consistencyRewriteMs ?? 0) + (performance.now() - checkStartedAt);
        }
      } catch (error) {
        // 取消即抛（同叙事侧校验）。
        if (signal?.aborted) throw error;
        // 校验失败不拦回合。
      }
    }

    timings.generationMs = performance.now() - generationStartedAt;

    const applied = applyDelta(stateAfterTime, response.delta, this.world);
    const turnKeywords = response.retrievalKeywords ?? [];
    const recentKeywords = [
      ...this.history.slice(-2).flatMap((turn) => turn.retrievalKeywords ?? []),
      ...turnKeywords,
    ];
    let nextState = {
      ...applied.state,
      retrievalKeywords: [...new Set(recentKeywords)],
    };
    const patch = response.statePatch ?? {};
    if (patch.locationId !== undefined) {
      const location = this.world.locations.find((item) => item.id === patch.locationId);
      nextState.locationId = location.id;
      nextState.location = location.name;
    }
    // 时间跳跃:闭关/远行等回合由模型声明,并入世界时间;章节随推演大跳。
    // 跳跃窗口内到期的原著事件当回合投递:它们发生在跳跃的这段时间里,攒到
    // 下一回合会一口气涌来,时间线顺序与叙事脱节(已经投递的不会重复选)。
    let jumpDueEvents = [];
    if (Number.isInteger(response.jumpMinutes) && response.jumpMinutes > 0) {
      nextState.worldTime += response.jumpMinutes;
      jumpDueEvents = dueTimelineEvents(this.world, nextState);
      nextState = deliverTimelineEvents(nextState, jumpDueEvents);
    }
    if (patch.resolvedThreads !== undefined && Array.isArray(patch.resolvedThreads)) {
      nextState.resolvedThreads = [...new Set([...nextState.resolvedThreads, ...patch.resolvedThreads])];
    }
    // 阅读范围固定(拍板):模型写的 unlockedChapter 一律不采纳。
    nextState = applyEvolutionPatch(nextState, response.evolutionPatch, this.world);
    // 玩家成长三补丁(拍板 2026-08-19:具名行囊/技能习得/境界突破):
    // sanitize 已钳形状,这里语义结算——越阶突破等非法项静默拒绝。
    nextState = applyInventoryPatch(nextState, response.inventoryPatch);
    nextState = applyLearnedAbilities(nextState, response.learnedAbilities);
    nextState = applyRealmBreakthrough(nextState, response.realmBreakthrough, this.world);
    const enhancements = applyLayeredPatches(
      nextState,
      response.systemPatches ?? {},
      this.world,
    );
    nextState = enhancements.state;
    // 被动掀桌：AI 在 clashStart 里提议对方动手，引擎校验物理可行性后生效。
    if (validateClashStart(nextState, response.clashStart, this.world)) {
      const initiator = this.world.characters.find(
        (character) => character.id === response.clashStart.opponentId,
      );
      nextState = beginClash(
        nextState,
        {
          opponentId: response.clashStart.opponentId,
          opponentName: initiator?.name,
          origin: "opponent",
          reason: response.clashStart.reason ?? "",
        },
        this.world,
      );
    }
    nextState = resolveTimelineEvents(
      this.world,
      nextState,
      option,
      enhancements.committed ?? [],
    );
    // 命运偏离：根据所选行动的改命声明与本回合判定，推进势能或收尾写回/反噬。
    const divergenceOutcome = applyDivergence(nextState, this.world, {
      option,
      check,
      divergencePatch: response.divergencePatch,
    });
    nextState = divergenceOutcome.state;
    // 天命难违的定性后果：铺垫失败势能归零时记一条明写的反馈（天命反弹的口吻，
    // 不是主角受罚的口吻）；同时作为下一回合 context.fateResistance 的数据源。
    const fateResistanceConsequence =
      divergenceOutcome.result?.fateResistance && divergenceOutcome.result.target
        ? {
            type: "fate_resistance",
            consequence: `你试图撬动「${divergenceOutcome.result.target}」的命运，天命反弹，此前的铺垫尽数消散`,
          }
        : null;
    // 替代事件(拍板 2026-08-17):被改命运引发的替代走向,已在 sanitizeTurnPayload
    // 白名单钳位;此处兜底时间钳位(不得早于当前世界时钟)后进入世界档案。
    // 提议缺席时静默:下游事件只是不再发生,世界依旧自洽。
    let derivedEvent = null;
    if (response.replacementEvent) {
      const clockNow = timelineClock(this.world, nextState);
      const minTime =
        clockNow + (this.world.rules?.defaultTimeCost ?? DEFAULT_RULES.defaultTimeCost);
      const derived = {
        ...response.replacementEvent,
        id: nextDerivedEventId(this.world, nextState.turn),
        time: Math.max(response.replacementEvent.time, minTime),
        chapterAnchor: nextState.unlockedChapter ?? 1,
        source: "derived",
      };
      this.world.timeline.push(derived);
      derivedEvent = clone(derived);
    }
    // 涌现故事(拍板 2026-08-17):玩家行动在原著没写到的地方长出新故事/新人物/
    // 新事件;动量由代码累计,world 档有几率爆发成世界级事件。净化已在
    // sanitizeTurnPayload 白名单钳位;此处做存在性/时间钳位并写回世界档案。
    // 与替代事件同构:直接 push 进 this.world,由主进程的落盘路径持久化。
    const emergentOutcome = applyEmergentPatch(
      nextState,
      this.world,
      response.emergentPatch,
      { turn: nextState.turn, random: this.random },
    );
    nextState = emergentOutcome.state;
    // 同行者（拍板 2026-08-17）：入队/离队随涌现补丁一起结算——
    // 队伍是玩家的叙事存在，无数值，不上判定。
    const companionOutcome = applyCompanionPatch(
      nextState,
      this.world,
      response.emergentPatch,
      { turn: nextState.turn },
    );
    nextState = companionOutcome.state;
    nextState = advanceEndingCandidate(nextState);
    // 终卷(拍板:主线收束+随时合卷):全部命运节点落下时,这一卷可以合上。
    // 一次性消耗(A4,2026-08-19):命运终卷只在全部节点首次落定时合一次;
    // 续写新阶段后不再每手重新收卷——否则命运既定之书永远只能玩一手。
    if (
      !nextState.endingCandidate?.ready &&
      !nextState.fateEndingConsumed &&
      foldableEnding(nextState, this.world)
    ) {
      nextState.fateEndingConsumed = true;
      nextState.endingCandidate = {
        ...(nextState.endingCandidate ?? {}),
        type: "stage",
        goalId: nextState.endingCandidate?.goalId ?? "fate-complete",
        createdTurn: nextState.endingCandidate?.createdTurn ?? nextState.turn,
        stableTurns: nextState.endingCandidate?.stableTurns ?? 0,
        ready: true,
      };
    }
    // 终卷×交锋互锁(A3,2026-08-19):卷已合上时未收束的交锋一并收场——
    // 否则「这一卷已经合上」(拒落子)与「搏杀正酣」(拒意图)互斥,对局死锁,
    // 唯一出路只剩弃世重开。
    if (nextState.endingCandidate?.ready && nextState.activeClash) {
      nextState.activeClash = null;
    }
    // 主动进入：dire 的搏杀交上手，就展开成多回合对峙。
    // 放在濒死检测之前：进入回合就把 vital 打空时，立即进入濒死窗口而不是原地判死。
    if (
      !nextState.activeClash &&
      option.axis === "force" &&
      option.risk === "dire"
    ) {
      const targetIds = responseTargetsFromOption(option);
      const opponent = this.world.characters.find((character) => character.id === targetIds[0]);
      if (opponent) {
        nextState = beginClash(
          nextState,
          {
            opponentId: opponent.id,
            opponentName: opponent.name,
            origin: "player",
            reason: option.text,
          },
          this.world,
        );
      }
    }
    // 交锋中 vital 归零：进入濒死窗口，把生死交给最后一搏的判定。
    nextState = markPendingDeath(nextState, this.world);
    nextState.characterJournal = buildCharacterJournal(nextState);
    // 交锋推进前记下对手名:结束分支会把 activeClash 清空,本回合新开的交锋
    // 在回合前快照(stateAfterTime)里也没有——死因文案两边都取不到。
    const clashOpponentName =
      nextState.activeClash?.opponentName ?? stateAfterTime.activeClash?.opponentName ?? "对手";
    // 交锋推进：这一步把 stance、双方伤势与结束分支定下来。
    const clashOutcome = advanceClash({
      state: nextState,
      option,
      check,
      world: this.world,
    });
    nextState = clashOutcome.state;
    const deathResult =
      clashOutcome.ended && clashOutcome.endReason === "death"
        ? { dead: true, cause: `死于与${clashOpponentName}的搏杀` }
        : playerDeathState(nextState);
    // 爽文拍板「绝境转机,几乎不死」:死亡结算后改写为死里逃生,原味模式原样保留。
    const escape = resolvePowerEscape(nextState, deathResult, this.world);
    nextState = escape.state;
    const death = escape.death;
    // 死亡落定在状态上留持久标记：交锋致死的场合 survivalPressures 里没有
    // 致命项，只按压力重算的 playerDeathState 会把它漏成「活着」——崩溃残留/
    // 重载的死亡档必须仍然死亡，不能被当成活着的一世接着玩。
    if (death.dead) {
      nextState.playerDead = true;
      nextState.playerDeathCause = String(death.cause ?? "伤重不治");
    }
    // 上一回合的转机标记只活一个回合:本回合叙事已演出转机经过,结算后清掉。
    if (
      !escape.escaped &&
      before.powerEscape &&
      nextState.powerEscape?.turn === before.powerEscape.turn
    ) {
      delete nextState.powerEscape;
    }
    // 弧线节拍推进(拍板:模型声明优先,滞留超限硬推进):推进到最后即收束——
    // 快模型写一句回顾入 arcHistory(隐藏+回望),本回合带回卷终卡,下一回合重规划。
    // 死亡/终局:这一世的弧线随之落幕,不留回顾(终章与墓志铭另有归宿)。
    let arcRetrospective = null;
    if (stateAfterTime.arc) {
      const previousArc = stateAfterTime.arc;
      const advanced =
        response.beatAdvance === true || previousArc.beatTurns + 1 > BEAT_STALL_LIMIT;
      let arc = {
        ...previousArc,
        beatTurns: advanced ? 0 : previousArc.beatTurns + 1,
        currentBeatIndex: advanced
          ? previousArc.currentBeatIndex + 1
          : previousArc.currentBeatIndex,
      };
      if (death.dead || nextState.endingCandidate?.ready) {
        arc = null;
      } else if (arc.currentBeatIndex >= arc.beats.length) {
        let retrospective = fallbackRetrospective(arc);
        if (typeof this.llm?.generateArcRetrospective === "function") {
          try {
            const verdict = await this.llm.generateArcRetrospective({
              arc,
              history: this.history,
              styleSamples: context.styleSamples ?? [],
              signal: turnSignal,
            });
            const text = String(verdict?.retrospective ?? "")
              .replace(/[\u0000-\u001f\u007f]/g, "")
              .trim()
              .slice(0, 40);
            if (text) retrospective = text;
          } catch {
            // 回顾失败:代码拼句兜底,回望卡不能空着。
          }
        }
        nextState.arcHistory = [
          ...(nextState.arcHistory ?? []),
          {
            title: arc.title,
            retrospective,
            startTurn: arc.startTurn,
            endTurn: nextState.turn,
          },
        ].slice(-12);
        arcRetrospective = { title: arc.title, retrospective };
        arc = null;
      }
      nextState.arc = arc;
    } else {
      nextState.arc = null;
    }
    // 行为自适应:每满 10 回合让观察者看一次近期表现,提议受控微调。
    // 失败/超时/断网一律静默,校验不过的字段整体丢弃,永不把游戏调坏。
    if (this.observePlayer && nextState.turn % 10 === 0 && !death.dead) {
      try {
        this.#phase("observing");
        const proposal = await this.observePlayer({
          turn: nextState.turn,
          player: { name: nextState.player.name, roleName: nextState.player.roleName },
          current: nextState.adaptation,
          recentTurns: this.history.slice(-8).map((turn) => ({
            choice: turn.choice?.text ?? "",
            result: turn.check?.result ?? "",
            narrative: String(turn.narrative ?? "").slice(0, 200),
          })),
          signal: turnSignal,
        });
        nextState.adaptation = {
          ...clampAdaptation(proposal, nextState.adaptation),
          updatedTurn: nextState.turn,
        };
      } catch {
        // 观察者失败:保持现状,静默继续。
      }
    }
    // 身份进阶：模型声明了转变且此刻仍合法（路径未用/未拒、起点匹配、前提满足），
    // 挂起转变卡等玩家抉择；终局/死亡回合不挂，避免转变卡与终局屏抢戏。
    const transition = validateRoleTransition(response, nextState, this.world);
    if (transition && !death.dead && !nextState.endingCandidate?.ready) {
      nextState.pendingRoleTransition = {
        ...transition,
        turn: nextState.turn,
        fromRoleId: nextState.player.roleId,
        fromRoleName: nextState.player.roleName,
      };
    }
    // 拒绝转变的代价提示只活一个回合：本回合已经注入 context，用完即清。
    nextState.lastRefusedTransition = null;
    // 大五漂移结算(拍板:性格由故事中的选择长出来):所选行动的 bigFiveShift 落到五维,
    // 逐次选择进证据、逐回合聚合进历史;跨档记录供本回合叙事与 UI 自然带出。
    const bigFiveBefore = nextState.player.bigFive ?? neutralBigFive();
    const bigFiveAfter = applyBigFiveShift(bigFiveBefore, option.bigFiveShift);
    nextState.player.bigFive = bigFiveAfter;
    nextState.player.personalityEvidence = [
      ...(nextState.player.personalityEvidence ?? []),
      {
        turn: nextState.turn,
        optionId: option.id ?? "",
        text: String(option.text ?? "").slice(0, 120),
        shift: { ...(option.bigFiveShift ?? {}) },
      },
    ].slice(-30);
    const crossings = bigFiveCrossings(bigFiveBefore, bigFiveAfter);
    if (option.bigFiveShift && Object.keys(option.bigFiveShift).length) {
      nextState.player.personalityHistory = [
        ...(nextState.player.personalityHistory ?? []),
        {
          turn: nextState.turn,
          shift: { ...option.bigFiveShift },
          crossings: crossings.map((item) => ({ dimension: item.dimension, level: item.level })),
        },
      ].slice(-30);
    }
    nextState.bigFiveChanges = crossings;
    // 停滞检测：本回合没有任何实质变化就累计，有则清零——供僵局警告使用。
    nextState.consecutiveStaticTurns = turnHadSubstance({ response, patch, enhancements })
      ? 0
      : (before.consecutiveStaticTurns ?? 0) + 1;
    // 预设选项已取消（拍板 2026-08-17）：普通回合不再由结构请求产出选项，
    // 下一步选项由玩家意图动态生成（engine.generateOptions / game:intent-options）。
    // 只有交锋回合保留结构请求生成的 2-4 个搏杀选项，并照旧走 repair/fallback 兜底。
    // 判断依据是本回合结算后的状态：若结算后仍处交锋，本回合的选项就是搏杀选项；
    // 普通回合一律空选项，交由意图生成。
    const clashTurn = Boolean(nextState.activeClash);
    let finalOptions = [];
    if (clashTurn) {
      const availableOptions = response.options.filter((item) =>
        optionIsAvailable(item, nextState, this.world),
      );
      finalOptions = availableOptions;
      if (finalOptions.length < 2 || !finalOptions.some((item) => item.axis === EXIT_AXIS)) {
        if (this.llm.repairOptions) {
          try {
            this.#phase("options-check");
            const repaired = await this.llm.repairOptions({
              narrative: response.narrative,
              options: response.options,
              context,
              missing: "需要 2-4 个可行且包含 exit 的独立行动",
              signal,
            });
            // repairOptions 是另一条不走 validateResponse 的路径，选项可能漏写
            // id/text/axis/risk/attribute；这里先按结构完整性过滤，再按可用性过滤。
            finalOptions = repaired.filter(
              (item) =>
                optionIsWellFormed(item, this.world) &&
                optionIsAvailable(item, nextState, this.world),
            );
          } catch {}
        }
        if (finalOptions.length < 2 || !finalOptions.some((item) => item.axis === EXIT_AXIS)) {
          finalOptions = fallbackOptions(this.world, nextState);
        }
      }
    }

    const turn = {
      number: nextState.turn,
      choice: clone(option),
      check,
      dueEvents: [...dueEvents, ...jumpDueEvents],
      narrative: response.narrative,
      options: clone(finalOptions),
      openThreads: clone(response.openThreads ?? []),
      retrievalKeywords: clone(turnKeywords),
      consequences: fateResistanceConsequence
        ? [...applied.consequences, fateResistanceConsequence]
        : applied.consequences,
      relationshipChanges: clone(response.evolutionPatch?.relationships ?? []),
      dominantSystems: scheduling.dominant,
      // 交锋纪要：本回合的交锋进展与收束结果（用于测试、日志与后续 UI）。
      clash: {
        entered: Boolean(stateAfterTime.activeClash),
        ended: clashOutcome.ended,
        endReason: clashOutcome.endReason ?? null,
        opponentName: stateAfterTime.activeClash?.opponentName ?? null,
        pendingDeath: Boolean(nextState.activeClash?.pendingDeath),
      },
      enhancementResults: {
        committed: enhancements.committed,
        dropped: enhancements.dropped,
      },
      divergence: clone(divergenceOutcome.result),
      derivedEvent,
      // 涌现故事(拍板 2026-08-17):本回合新生的故事/人物/事件与爆发结果。
      emergent: emergentOutcome.emergent,
      // 同行者快照：这一回与谁同行（渲染层据此在回目印旁标注）。
      companions: clone(companionOutcome.state.companions ?? []).map((item) => item.name),
      // 队伍有变（入队/离队）时主进程需要把 provenance 上的同伴印记落盘。
      companionsChanged: Boolean(companionOutcome.companions),
      // 卷终回望(拍板:隐藏+回望):弧线收束的回合才有值,渲染层据此插卷终卡。
      arcRetrospective,
      personalityNotes: clone(crossings),
      roleTransition: clone(nextState.pendingRoleTransition),
      journal: clone(nextState.characterJournal),
      endingCandidate: clone(nextState.endingCandidate),
      death,
      // 爽文绝境转机:本回合「本应死去却死里逃生」的标记,供界面展示。
      powerEscape: escape.escaped
        ? { turn: nextState.turn, cause: String(death.cause ?? "") }
        : null,
      context,
      timings,
    };
    nextState.longTermMemories = updateStructuredMemories(nextState, turn);
    timings.totalMs = performance.now() - startedAt;
    const commit = () => {
      // 历史里只保留最新一条回合的完整 context：它是存档随回合膨胀的主因。
      // 更早回合的正文/选项/判定仍全量保留（阅读界面需要全部正文）。
      if (this.history.length) delete this.history.at(-1).context;
      this.history.push(turn);
      this.store.push(nextState);
      // 伏笔集合增量维护：buildContext 只消费这个集合，不再全量扫 history。
      for (const thread of turn.openThreads ?? []) this.openThreadSet.add(thread);
      while (this.openThreadSet.size > MAX_OPEN_THREADS) {
        this.openThreadSet.delete(this.openThreadSet.values().next().value);
      }
      for (const thread of nextState.resolvedThreads ?? []) this.openThreadSet.delete(thread);
      if (this.memory) {
        const historyLength = this.history.length;
        const targetTurn = nextState.turn;
        const lineage = this.lineage;
        this.backgroundQueue = this.backgroundQueue
          .then(async () => {
            // undo/重玩过（世系已变）就放弃：旧世系的叙事不能与新世系状态混算摘要。
            if (this.lineage !== lineage) return;
            const targetState = this.store.snapshots.find(
              (snapshot) => snapshot.turn === targetTurn,
            );
            if (!targetState) return;
            // 摘要窗口按记忆层的记账取:错过的窗口(上次失败)会连着新回合一起补,
            // 不再固定 5 回合一刀切。窗口依赖 targetState 的记账,必须在拿到
            // targetState 之后计算。
            const windowSize = typeof this.memory.windowFor === "function"
              ? this.memory.windowFor(targetState, historyLength)
              : 5;
            const recentHistory = clone(this.history.slice(-windowSize));
            const previousSummary = targetState.chapterSummary;
            const updated = await this.memory.update(clone(targetState), recentHistory, {
              historyLength,
              recentHistory,
            });
            const advanced = updated.memorySummarizedLength ?? null;
            const summaryChanged = updated.chapterSummary !== previousSummary;
            const previousDigest = targetState.storyDigest;
            const digestChanged = updated.storyDigest !== undefined && updated.storyDigest !== previousDigest;
            if (!summaryChanged && advanced == null && !digestChanged) return;
            for (const snapshot of this.store.snapshots) {
              if (
                snapshot.turn >= targetTurn &&
                snapshot.chapterSummary === previousSummary
              ) {
                if (summaryChanged) snapshot.chapterSummary = updated.chapterSummary;
                // 摘要没变(纯压缩)也要推进记账,否则同窗口每回合重摘一遍。
                if (advanced != null) snapshot.memorySummarizedLength = advanced;
              }
              // 远期折叠只增不改快照语义：同世系内把 digest 与折叠记账前播即可。
              if (digestChanged && snapshot.turn >= targetTurn) {
                snapshot.storyDigest = updated.storyDigest;
                if (updated.digestSummarizedLength != null) {
                  snapshot.digestSummarizedLength = updated.digestSummarizedLength;
                }
              }
            }
          })
          .catch(() => {});
      }
      // 人物状态追踪（拍板 2026-08-20：连贯性修复）：每 interval 回合把
      // 「静态人物卡 + 近期演出」压成每人一条此刻笔记，写进动态状态账。
      // 与记忆摘要同一条队列串行、同一种世系守卫；记账以 entityNotesTurn
      // 记账（失败不推进，下回合重试），快照修复沿用记忆层的 turn>=target 写法。
      if (this.entityTracker) {
        const targetTurn = nextState.turn;
        const lineage = this.lineage;
        this.backgroundQueue = this.backgroundQueue
          .then(async () => {
            if (this.lineage !== lineage) return;
            const targetState = this.store.snapshots.find(
              (snapshot) => snapshot.turn === targetTurn,
            );
            if (!targetState) return;
            const interval = this.entityTracker.interval ?? 5;
            if (targetState.turn - Number(targetState.entityNotesTurn ?? 0) < interval) return;
            const { notes } = await this.entityTracker.update({
              world: this.world,
              state: targetState,
              history: this.history,
            });
            if (!notes || !Object.keys(notes).length) return;
            for (const snapshot of this.store.snapshots) {
              if (snapshot.turn < targetTurn) continue;
              snapshot.entityStateNotes = { ...(snapshot.entityStateNotes ?? {}), ...notes };
              snapshot.entityNotesTurn = targetState.turn;
            }
          })
          .catch(() => {});
      }
      this.#prefetchCharacters(finalOptions, nextState);
      return clone(turn);
    };
    return commit();
  }


  #prefetchCharacters(options, state) {
    if (!this.detailCharacter) return;
    const characterIds = [...new Set(options.flatMap(responseTargetsFromOption))];
    const undetailed = characterIds
      .map((characterId) => this.world.characters.find((item) => item.id === characterId))
      .filter((character) => character && !character.detailed);
    if (!undetailed.length) return;
    // 与记忆任务串行进同一队列：预取读取 history/world 的时机确定，
    // 不再与下一回合的 commit 交错；flushBackground 会一并收口。
    // 链尾必须 .catch：这条链接了 promise 链一旦拒绝，后续排进来的记忆
    // 摘要任务全部被跳过（% interval 边界错过就永远错过），静默劣化上下文。
    this.backgroundQueue = this.backgroundQueue
      .then(async () => {
        for (const character of undetailed) {
          if (character.detailed) continue;
          try {
            const context = buildContext({
              world: this.world,
              state: this.store.current,
              history: this.history,
              dueEvents: [],
              styleIndex: this.styleIndexFor(),
              factIndex: this.factIndex,
              canonLedger: this.canonLedger,
              targetIds: [character.id],
              dominantSystems: [],
              unresolvedThreads: [...this.openThreadSet].slice(-MAX_CONTEXT_THREADS),
            });
            const detailed = await this.detailCharacter({
              character,
              sourceChapters: this.sourceChapters,
              context,
            });
            mergeDetailInto(character, detailed, { id: character.id, detailed: true });
          } catch {}
        }
      })
      .catch(() => {});
  }

  // 撤销最近一回合。生产未接线（无 IPC），仅供测试与未来撤销功能使用。
  undo() {
    if (this.busy) throw new Error("Cannot undo while a turn is in progress");
    if (this.store.snapshots.length < 2) throw new Error("Nothing to undo");
    this.lineage += 1;
    // 弹出前先克隆两份快照：undo 后与克隆比对，确认回退目标未被改动。
    // 原来拿同一引用自比，deepStrictEqual 恒真，守卫形同虚设。
    const expected = structuredClone(this.store.snapshots.at(-2));
    const popped = structuredClone(this.store.snapshots.at(-1));
    const restored = this.store.undo();
    try {
      deepStrictEqual(restored, expected);
    } catch (error) {
      // 校验失败说明快照数据已损坏：把刚弹出的状态放回去，
      // 避免 store 已回退而 history 未回退的撕裂状态。
      this.store.snapshots.push(popped);
      throw error;
    }
    this.history.pop();
    // 伏笔集合也要回退：它不随快照走，否则被撤销回合开启的伏笔仍留在集合里，
    // 回退后回合的上下文/检索词里混着「本时间线从未发生过」的线头。
    const resolved = new Set(this.store.current?.resolvedThreads ?? []);
    this.openThreadSet = new Set(this.history.flatMap((turn) => turn.openThreads ?? []));
    for (const thread of resolved) this.openThreadSet.delete(thread);
    return restored;
  }
}

function responseTargetsFromOption(option) {
  return option.target?.type === "character" && option.target.id ? [option.target.id] : [];
}

// 替代事件的稳定 id:同回合内按出现顺序编号,永不与原著事件 id 冲突。
function nextDerivedEventId(world, turn) {
  const prefix = `derived-${turn}-`;
  const count = (world.timeline ?? []).filter((event) =>
    String(event.id ?? "").startsWith(prefix),
  ).length;
  return `${prefix}${count + 1}`;
}

// 命运松动信号的称呼:已解锁目标的原文表述直接可用(与原文之河同口径),
// 未解锁的只给模糊称呼,不泄露原著文本。
export function divergenceTargetLabel(world, divergence, state) {
  const { targetId, targetType } = divergence;
  const unlocked = state?.unlockedChapter ?? 1;
  if (targetType === "timeline") {
    const event = world.timeline.find((item) => item.id === targetId);
    if (!event) return "一段被拨动的旧事";
    return Number(event.chapterAnchor ?? 1) <= unlocked
      ? String(event.text ?? "一段旧事")
      : "一段尚未揭晓的旧事";
  }
  if (targetType === "fact") {
    const fact = world.facts.find((item) => item.id === targetId);
    if (!fact) return "一桩旧事";
    return Number(fact.chapterAnchor ?? 1) <= unlocked
      ? String(fact.text ?? "一桩旧事")
      : "一桩尚未揭晓的旧事";
  }
  if (targetType === "entity") {
    return world.characters.find((item) => item.id === targetId)?.name ?? "某个人";
  }
  return "一段被拨动的命运";
}

// 保真校验用人物卡:本回合在场原著人物的人设卡精简版(上限 5 张),供快模型核对
// 言行是否符合 persona;没有 persona 的人物不送(无从核对,别浪费校验注意力)。
function onScreenCharactersForCheck(world, state, onScreenIds) {
  return world.characters
    .filter((character) => onScreenIds.has(character.id) && character.persona)
    .slice(0, 5)
    .map((character) => ({
      id: character.id,
      name: character.name,
      persona: character.persona,
      status: state.entityStates?.[character.id]?.status ?? "active",
      locationId: state.entityStates?.[character.id]?.locationId ?? null,
    }));
}

// 保真校验用世界观摘要:书的基础设定 + 特质前 20 条 + 玩法规则,快模型核对
// 力量上限/礼法/秩序时不凭空脑补。都是既有字段,零新增请求。
export function worldviewForCheck(world) {
  return {
    title: world.title,
    summary: String(world.summary ?? "").slice(0, 500),
    traits: (world.traits ?? []).slice(0, 20),
    rules: world.rules ?? {},
  };
}

// 本回合是否发生了实质变化：数值变动、地点/章节/伏笔推进、关系变化、
// 系统补丁提交、身份进阶声明或新伏笔开启，任一有就算有实质。
// 玩家成长三补丁(拍板 2026-08-19)同样算实质——得宝/习得/突破的回合
// 不该被僵局检测误记为原地打转。
function turnHadSubstance({ response, patch, enhancements }) {
  if (response.roleTransition) return true;
  if (response.realmBreakthrough) return true;
  if ((response.inventoryPatch?.changes?.length ?? 0) > 0) return true;
  if ((response.learnedAbilities?.length ?? 0) > 0) return true;
  if (Object.keys(response.delta ?? {}).length > 0) return true;
  if (
    patch.locationId !== undefined ||
    (patch.resolvedThreads?.length ?? 0) > 0
  ) {
    return true;
  }
  if (Number.isInteger(response.jumpMinutes) && response.jumpMinutes > 0) return true;
  if (
    (response.evolutionPatch?.relationships?.length ?? 0) > 0 ||
    (response.evolutionPatch?.entities?.length ?? 0) > 0
  ) {
    return true;
  }
  if ((enhancements.committed?.length ?? 0) > 0) return true;
  if ((response.openThreads?.length ?? 0) > 0) return true;
  return false;
}
