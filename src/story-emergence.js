// 涌现故事系统（拍板 2026-08-17）：
// 玩家的行动在原著没写到的地方长出新的故事线、新的人物与新的事件——
// 故事还会继续长出故事与人物；影响足够大的故事会「爆发」成世界级事件，
// 其事实经由世界时间线进入世界现状，足以影响整个世界的发展。
// 宪法与改命系统一致：AI 提议、代码夹紧——模型在回合结算提出 emergentPatch，
// 本模块做白名单校验与钳位；影响力动量由代码累计，阈值分档，爆发掷隐骰。

import { validateCreation } from "./world-creation.js";
import { isCharacterBoundName, characterNamesOf } from "./identity-guard.js";
import { timelineClock } from "./timeline.js";

// 影响力档位（拍板：local=成了一桩事，side=一方势力/地域卷入，world=足以改写大势）：
// 数值是动量阈值，累计到档即升档；world 档触发「爆发」判定——有几率不中，
// 不中不封口，继续推进可再次掷。
export const STORY_TIERS = Object.freeze({ local: 1, side: 3, world: 6 });
// 动量封顶：world 档之后再推进只体现为叙事素材，不再堆数值。
const STORY_MOMENTUM_CAP = 9;
// 一生涌现实体总数上限（故事+人物+事件合计）：世界档案不能被模型灌水。
export const MAX_EMERGENT_ENTITIES = 16;
// 同行者上限（拍板 2026-08-17：叙事存在，三五人成行，超过失焦）。
export const COMPANION_CAP = 3;
// world 档爆发爆发的隐骰命中概率（拍板：「有几率影响整个世界」——不是必然）。
export const ERUPTION_CHANCE = 0.6;

function clone(value) {
  return structuredClone(value);
}

const clampText = (value, max) =>
  String(value ?? "")
    .replace(/[\u0000-\u001f\u007f]/g, "")
    .trim()
    .slice(0, max);

function tierOf(momentum) {
  if (momentum >= STORY_TIERS.world) return "world";
  if (momentum >= STORY_TIERS.side) return "side";
  return "local";
}

// —— 白名单净化：只认合法形状与合法引用，非法项静默丢弃（宁缺毋滥） ——
// storyImpacts 的 storyId 依赖玩家状态，存在性在结算阶段（applyEmergentPatch）再验。
export function sanitizeEmergentPatch(value, world) {
  const source = value && typeof value === "object" && !Array.isArray(value) ? value : {};
  const locationIds = new Set((world.locations ?? []).map((item) => item.id));
  const factionIds = new Set((world.factions ?? []).map((item) => item.id));
  const boundNames = characterNamesOf(world);

  let newStory = null;
  const rawStory = Array.isArray(source.newStories) ? source.newStories[0] : null;
  if (rawStory && typeof rawStory === "object" && !Array.isArray(rawStory)) {
    const title = clampText(rawStory.title, 24);
    const summary = clampText(rawStory.summary, 160);
    if (title.length >= 2 && summary.length >= 4 && !isCharacterBoundName(title, boundNames)) {
      // kind 只认两值：基业线(venture)或寻常故事线(tale)，缺省 tale。
      newStory = { title, summary, kind: rawStory.kind === "venture" ? "venture" : "tale" };
    }
  }

  let newCharacter = null;
  const rawCharacter = Array.isArray(source.newCharacters) ? source.newCharacters[0] : null;
  if (rawCharacter && typeof rawCharacter === "object" && !Array.isArray(rawCharacter)) {
    const name = clampText(rawCharacter.name, 12);
    const summary = clampText(rawCharacter.summary, 200);
    const role = clampText(rawCharacter.role, 40);
    const locationId = locationIds.has(rawCharacter.locationId)
      ? rawCharacter.locationId
      : undefined;
    const factionId = factionIds.has(rawCharacter.factionId) ? rawCharacter.factionId : undefined;
    if (
      name.length >= 2 &&
      summary.length >= 4 &&
      locationId !== undefined &&
      !isCharacterBoundName(name, boundNames)
    ) {
      newCharacter = {
        name,
        summary,
        ...(role ? { role } : {}),
        locationId,
        ...(factionId !== undefined ? { factionId } : {}),
      };
    }
  }

  let newEvent = null;
  const rawEvent = Array.isArray(source.newEvents) ? source.newEvents[0] : null;
  if (rawEvent && typeof rawEvent === "object" && !Array.isArray(rawEvent)) {
    const time = Number(rawEvent.time);
    const text = clampText(rawEvent.text, 300);
    const locationId = locationIds.has(rawEvent.locationId) ? rawEvent.locationId : undefined;
    const tier = ["core", "side", "local"].includes(rawEvent.tier) ? rawEvent.tier : "local";
    if (Number.isFinite(time) && time >= 0 && text && locationId !== undefined) {
      newEvent = { time, text, locationId, tier };
    }
  }

  const storyImpacts = (Array.isArray(source.storyImpacts) ? source.storyImpacts : [])
    .filter((item) => item && typeof item === "object" && !Array.isArray(item))
    .map((item) => ({
      storyId: String(item.storyId ?? "").trim(),
      weight: Math.max(0, Math.min(2, Math.round(Number(item.weight) || 0))),
    }))
    .filter((item) => item.storyId && item.weight > 0)
    .slice(0, 3);

  // —— 同行者声明：入队必须是涌现人物（原著人物不入队，拍板 2026-08-17）——
  let companionJoin = null;
  if (source.companionJoin && typeof source.companionJoin === "object" && !Array.isArray(source.companionJoin)) {
    const id = String(source.companionJoin.characterId ?? "").trim();
    const character = (world.characters ?? []).find((item) => item.id === id);
    if (character && character.provenance?.source === "emergent") {
      companionJoin = { characterId: id };
    }
  }

  let companionLeave = null;
  if (source.companionLeave && typeof source.companionLeave === "object" && !Array.isArray(source.companionLeave)) {
    const id = String(source.companionLeave.characterId ?? "").trim();
    if (id) {
      companionLeave = { characterId: id, reason: clampText(source.companionLeave.reason, 60) };
    }
  }

  if (
    !newStory &&
    !newCharacter &&
    !newEvent &&
    !storyImpacts.length &&
    !companionJoin &&
    !companionLeave
  ) {
    return undefined;
  }
  return {
    newStory,
    newCharacter,
    newEvent,
    storyImpacts,
    companionJoin,
    companionLeave,
  };
}

// 涌现实体计数：故事、人物、事件都算，保护世界档案规模。
function emergentEntityCount(state) {
  const stories = state.emergentStories ?? [];
  return (
    stories.length +
    stories.reduce(
      (sum, story) =>
        sum + (story.characterIds?.length ?? 0) + (story.eventIds?.length ?? 0),
      0,
    )
  );
}

// 涌现事件的稳定 id：与替代事件的 derived- 前缀、原著事件 id 永不冲突。
function nextEmergentEventId(world, turn) {
  const prefix = `emergent-${turn}-`;
  const count = (world.timeline ?? []).filter((event) =>
    String(event.id ?? "").startsWith(prefix),
  ).length;
  return `${prefix}${count + 1}`;
}

// 爆发事件：故事升格为世界级事件，其 factsToAdd 经由既有投递机制成为世界现状。
function buildEruptionEvent(story, world, state, turn) {
  const chapterAnchor = state.unlockedChapter ?? 1;
  return {
    id: nextEmergentEventId(world, turn),
    // 爆发不锚定单一地点：它以「大势」的尺度落进时间线，对谁都按传闻投递。
    time: timelineClock(world, state) + (world.rules?.defaultTimeCost ?? 60),
    text: `「${story.title}」已成燎原之势：${story.summary}`,
    tier: "core",
    chapterAnchor,
    prerequisites: [],
    invalidatedBy: [],
    resolution: "never",
    resolutionTargetIds: [],
    source: "emergent",
    storyId: story.id,
    factsToAdd: [
      {
        id: `story-fact:${story.id}`,
        text: `${story.title}：${story.summary}——此事已波及大势。`,
        chapterAnchor,
      },
    ],
  };
}

// 涌现故事结算：净化后的补丁在此写回——新故事入 state，新人物入 world.characters
// （provenance.source = "emergent"），新事件入 world.timeline（source: "emergent"），
// 动量累计升档、world 档掷隐骰爆发。world 由调用方持有并持久化，本函数原地追加。
// 返回 { state, emergent }，emergent 为 null 表示本回合无涌现变化。
export function applyEmergentPatch(state, world, patch, { turn, random } = {}) {
  if (!patch) return { state, emergent: null };
  const next = clone(state);
  next.emergentStories = [...(next.emergentStories ?? [])];
  const byId = new Map(next.emergentStories.map((story) => [story.id, story]));
  const atCap = emergentEntityCount(next) >= MAX_EMERGENT_ENTITIES;
  const lifeIndex = next.player?.lifeIndex ?? 1;
  const created = { characters: [], events: [] };
  const eruptions = [];

  // 1) 新故事线。
  let newStory = null;
  if (patch.newStory && !atCap) {
    newStory = {
      id: `story:${turn}`,
      title: patch.newStory.title,
      summary: patch.newStory.summary,
      kind: patch.newStory.kind === "venture" ? "venture" : "tale",
      originTurn: turn,
      worldTime: next.worldTime,
      characterIds: [],
      eventIds: [],
      momentum: 0,
      tier: "local",
      erupted: false,
    };
    let candidate = newStory.id;
    let suffix = 2;
    while (byId.has(candidate)) candidate = `${newStory.id}-${suffix++}`;
    newStory.id = candidate;
    next.emergentStories.push(newStory);
    byId.set(newStory.id, newStory);
  }

  // 2) 新人物：同回合的新故事优先归属；否则归属本回合推进的唯一故事。
  const impactedIds = new Set(
    patch.storyImpacts.map((item) => item.storyId).filter((id) => byId.has(id)),
  );
  const attachStoryId =
    newStory?.id ?? (impactedIds.size === 1 ? [...impactedIds][0] : null);
  if (patch.newCharacter && !atCap) {
    const draft = {
      name: patch.newCharacter.name,
      role: patch.newCharacter.role ?? "来历不明之人",
      summary: patch.newCharacter.summary,
      locationIds: [patch.newCharacter.locationId],
      ...(patch.newCharacter.factionId ? { factionId: patch.newCharacter.factionId } : {}),
    };
    const validation = validateCreation("character", draft, world);
    if (validation.ok) {
      const character = {
        ...draft,
        id: validation.id,
        status: "active",
        provenance: { source: "emergent", lifeIndex, createdTurn: turn },
      };
      world.characters.push(character);
      // 新人物当场进入引擎状态：不建 entityStates、不进已发现名单的话，此人
      // 在引擎眼里不存在——上下文不再出现、选项不可指向、永不游走（幽灵 NPC）。
      // 已发现同时让引擎分配的 id 进入后续上下文，模型才可能继续写 ta 的故事。
      next.entityStates = {
        ...(next.entityStates ?? {}),
        [character.id]: {
          status: "active",
          factionId: character.factionId ?? null,
          locationId: patch.newCharacter.locationId,
        },
      };
      next.discoveredCharacterIds = [
        ...new Set([...(next.discoveredCharacterIds ?? []), character.id]),
      ];
      created.characters.push({ id: character.id, name: character.name });
      if (attachStoryId) byId.get(attachStoryId).characterIds.push(character.id);
    }
  }

  // 3) 新事件：进入世界时间线，与原著事件同一条河、同一套投递与失效规则。
  if (patch.newEvent && !atCap) {
    const clockNow = timelineClock(world, next);
    const minTime = clockNow + (world.rules?.defaultTimeCost ?? 60);
    const event = {
      id: nextEmergentEventId(world, turn),
      time: Math.max(patch.newEvent.time, minTime),
      text: patch.newEvent.text,
      locationId: patch.newEvent.locationId,
      tier: patch.newEvent.tier,
      chapterAnchor: next.unlockedChapter ?? 1,
      prerequisites: [],
      invalidatedBy: [],
      resolution: "never",
      resolutionTargetIds: [],
      source: "emergent",
      ...(attachStoryId ? { storyId: attachStoryId } : {}),
    };
    world.timeline.push(event);
    created.events.push(clone(event));
    if (attachStoryId) byId.get(attachStoryId).eventIds.push(event.id);
  }

  // 4) 动量推进与爆发：代码累计、代码定档；爆发掷隐骰（有几率不中）。
  const impacts = [];
  for (const impact of patch.storyImpacts) {
    const story = byId.get(impact.storyId);
    if (!story) continue;
    story.momentum = Math.min(STORY_MOMENTUM_CAP, story.momentum + impact.weight);
    story.tier = tierOf(story.momentum);
    impacts.push({ storyId: story.id, momentum: story.momentum, tier: story.tier });
    if (story.momentum >= STORY_TIERS.world && !story.erupted) {
      const roll = typeof random === "function" ? random() : 0.5;
      if (roll < ERUPTION_CHANCE) {
        story.erupted = true;
        const event = buildEruptionEvent(story, world, next, turn);
        world.timeline.push(event);
        story.eventIds.push(event.id);
        eruptions.push({ storyId: story.id, title: story.title, eventId: event.id });
      }
    }
  }

  const changed =
    Boolean(newStory) ||
    created.characters.length > 0 ||
    created.events.length > 0 ||
    eruptions.length > 0 ||
    impacts.length > 0;
  if (!changed) return { state, emergent: null };
  return {
    state: next,
    emergent: {
      newStory: newStory ? clone(newStory) : null,
      newCharacters: created.characters,
      newEvents: created.events,
      eruptions,
      impacts,
    },
  };
}

// 同行者结算（拍板 2026-08-17：叙事存在，无数值）：入队只收涌现人物、
// 队伍上限 3 人、不可重复入队；离队留档（回合+名字+缘由，供卷宗回望）。
// 入队时在世界档案的 provenance 上补 companionSince——此人曾与你同行，跨世可考。
// 返回 { state, companions }，companions 为 null 表示本回合无队伍变化。
export function applyCompanionPatch(state, world, patch, { turn } = {}) {
  const join = patch?.companionJoin;
  const leave = patch?.companionLeave;
  if (!join && !leave) return { state, companions: null };

  let roster = [...(state.companions ?? [])];
  const joined = [];
  const left = [];
  let log = [...(state.companionsLog ?? [])];

  if (join) {
    const already = roster.some((item) => item.characterId === join.characterId);
    const character = (world.characters ?? []).find((item) => item.id === join.characterId);
    if (!already && roster.length < COMPANION_CAP && character) {
      roster.push({
        id: `companion:${join.characterId}`,
        characterId: join.characterId,
        name: character.name,
        sinceTurn: turn,
        note: clampText(character.summary, 60),
      });
      joined.push(character.name);
      if (character.provenance && typeof character.provenance === "object") {
        character.provenance.companionSince = turn;
      }
    }
  }

  if (leave) {
    const index = roster.findIndex((item) => item.characterId === leave.characterId);
    if (index >= 0) {
      const [removed] = roster.splice(index, 1);
      left.push({ name: removed.name, reason: leave.reason });
      log.push({ turn, name: removed.name, reason: leave.reason });
      log = log.slice(-20);
    }
  }

  if (!joined.length && !left.length) return { state, companions: null };
  return {
    state: { ...state, companions: roster, companionsLog: log },
    companions: { joined, left },
  };
}

// 涌现故事的界面视图：动量与档位换算成进度，供「世界见闻」页签展示。
export function emergentStoriesView(state) {
  return (state?.emergentStories ?? []).map((story) => ({
    id: story.id,
    title: story.title,
    summary: story.summary,
    kind: story.kind === "venture" ? "venture" : "tale",
    originTurn: story.originTurn,
    momentum: story.momentum,
    tier: story.tier,
    erupted: Boolean(story.erupted),
    nextTierMomentum:
      story.tier === "world" ? null : (STORY_TIERS[story.tier === "side" ? "world" : "side"] ?? null),
  }));
}
