import test from "node:test";
import assert from "node:assert/strict";

import { normalizeWorld } from "../src/evolution.js";
import { dueTimelineEvents } from "../src/engine.js";
import { worldHappeningsView, atlasView } from "../src/timeline.js";
import { fateSeedsView } from "../src/gameplay-systems.js";
import {
  applyEmergentPatch,
  applyCompanionPatch,
  emergentStoriesView,
  sanitizeEmergentPatch,
  COMPANION_CAP,
  ERUPTION_CHANCE,
  MAX_EMERGENT_ENTITIES,
  STORY_TIERS,
} from "../src/story-emergence.js";

const world = normalizeWorld({
  id: "world",
  title: "书",
  characters: [{ id: "guide", name: "引路人", locationIds: ["gate"], firstChapter: 2 }],
  locations: ["gate", "tower"],
  factions: [{ id: "guild", name: "公会" }],
  roleTemplates: [{ id: "scout", name: "斥候", locationIds: ["gate"], factionIds: ["guild"] }],
  attributes: [{ id: "focus", name: "专注", initial: 20 }],
  stats: [{ id: "life", name: "生命", role: "vital", min: 0, max: 10, initial: 10 }],
  timeline: [
    { id: "event-1", time: 60, text: "旧事", chapterAnchor: 1, locationId: "gate", resolution: "never" },
    { id: "event-2", time: 40_000, text: "远期大事", chapterAnchor: 9, locationId: "tower", resolution: "never" },
  ],
  facts: [{ id: "f1", chapterAnchor: 1, text: "引路人是上一任守门人。" }],
});

function baseState(overrides = {}) {
  return {
    turn: 3,
    unlockedChapter: 3,
    worldTime: 0,
    locationId: "gate",
    player: { id: "player", lifeIndex: 1, roleId: "scout" },
    eventStates: {},
    emergentStories: [],
    ...overrides,
  };
}

const validPatch = {
  newStories: [{ title: "青蚨钱庄之局", summary: "玩家替钱庄押镖结怨于漕帮，埋下一场仇杀。" }],
  newCharacters: [
    { name: "阿禾", role: "药童", summary: "被玩家从码头赎出的孤儿，此刻无处可去。", locationId: "gate" },
  ],
  newEvents: [{ time: 600, text: "漕帮夜访钱庄", locationId: "gate", tier: "local" }],
  storyImpacts: [],
};

test("sanitizeEmergentPatch 保留合法形状并钳位文本", () => {
  const clean = sanitizeEmergentPatch(
    {
      ...validPatch,
      newEvents: [{ ...validPatch.newEvents[0], text: "漕帮夜访\n钱庄".padEnd(400, "字") }],
    },
    world,
  );
  assert.ok(clean);
  assert.equal(clean.newStory.title, "青蚨钱庄之局");
  assert.equal(clean.newCharacter.name, "阿禾");
  assert.ok(clean.newEvent.text.length <= 300);
});

test("sanitizeEmergentPatch 丢弃非法引用与绑定原著姓名", () => {
  const clean = sanitizeEmergentPatch(
    {
      newStories: [{ title: "引路人之局", summary: "绑原著人物的故事线。" }],
      newCharacters: [
        { name: "引路人", summary: "冒名原著人物。", locationId: "gate" },
        // 只取第一条：第二条即使合法也不看。
      ],
      newEvents: [{ time: 100, text: "地点不存在", locationId: "nowhere" }],
      storyImpacts: [{ storyId: "story:1", weight: 9 }, { storyId: "", weight: 1 }],
    },
    world,
  );
  // 三类创建全部非法 → 全部丢弃；storyImpacts 合法部分保留（权重钳到 2）。
  assert.ok(clean);
  assert.equal(clean.newStory, null);
  assert.equal(clean.newCharacter, null);
  assert.equal(clean.newEvent, null);
  assert.deepEqual(clean.storyImpacts, [{ storyId: "story:1", weight: 2 }]);
});

test("sanitizeEmergentPatch 全部为空时返回 undefined", () => {
  assert.equal(sanitizeEmergentPatch({ newStories: [], newCharacters: [], newEvents: [], storyImpacts: [] }, world), undefined);
  assert.equal(sanitizeEmergentPatch(null, world), undefined);
});

test("sanitizeEmergentPatch 钳位 storyImpacts 权重并过滤空值", () => {
  const clean = sanitizeEmergentPatch(
    { storyImpacts: [{ storyId: "story:1", weight: 9 }, { storyId: "x", weight: 0 }] },
    world,
  );
  assert.deepEqual(clean.storyImpacts, [{ storyId: "story:1", weight: 2 }]);
});

test("applyEmergentPatch 写回新故事、新人物与新事件", () => {
  const state = baseState();
  const nextWorld = structuredClone(world);
  // 与引擎管线一致：先净化（白名单钳位）再结算。
  const sanitized = sanitizeEmergentPatch(validPatch, nextWorld);
  const { state: next, emergent } = applyEmergentPatch(state, nextWorld, sanitized, {
    turn: 4,
    random: () => 0.99,
  });
  assert.ok(emergent);
  // 新故事入 state，人物与事件归属该故事。
  const story = next.emergentStories[0];
  assert.equal(story.title, "青蚨钱庄之局");
  assert.equal(story.momentum, 0);
  assert.equal(story.tier, "local");
  // 新人物入 world.characters，provenance 标记涌现来源。
  const character = nextWorld.characters.find((item) => item.name === "阿禾");
  assert.ok(character);
  assert.equal(character.provenance.source, "emergent");
  assert.equal(character.provenance.createdTurn, 4);
  assert.ok(story.characterIds.includes(character.id));
  // 新事件入 world.timeline，source 为 emergent，时间不早于当前时钟。
  const event = nextWorld.timeline.find((item) => item.source === "emergent");
  assert.ok(event);
  assert.equal(event.tier, "local");
  assert.equal(event.storyId, story.id);
  assert.ok(event.time > 60);
  assert.ok(story.eventIds.includes(event.id));
  // 原地不污染入参。
  assert.equal(state.emergentStories.length, 0);
});

test("动量累计升档：local → side → world", () => {
  let state = baseState({
    emergentStories: [
      { id: "story:1", title: "旧案", summary: "……", originTurn: 1, worldTime: 0, characterIds: [], eventIds: [], momentum: 0, tier: "local", erupted: false },
    ],
  });
  const nextWorld = structuredClone(world);
  // +2 → side（阈值 3 未到？2 < 3 仍是 local）
  let outcome = applyEmergentPatch(state, nextWorld, { newStory: null, newCharacter: null, newEvent: null, storyImpacts: [{ storyId: "story:1", weight: 2 }] }, { turn: 5, random: () => 0.99 });
  assert.equal(outcome.state.emergentStories[0].momentum, 2);
  assert.equal(outcome.state.emergentStories[0].tier, "local");
  // +1 → side（3）
  state = outcome.state;
  outcome = applyEmergentPatch(state, nextWorld, { storyImpacts: [{ storyId: "story:1", weight: 1 }] }, { turn: 6, random: () => 0.99 });
  assert.equal(outcome.state.emergentStories[0].tier, "side");
});

test("world 档爆发：命中掷骰升格为核心事件并写世界事实", () => {
  const state = baseState({
    emergentStories: [
      { id: "story:1", title: "漕帮之乱", summary: "仇杀已成气候。", originTurn: 1, worldTime: 0, characterIds: [], eventIds: [], momentum: 5, tier: "side", erupted: false },
    ],
  });
  const nextWorld = structuredClone(world);
  // momentum 5+1=6 → world 档；random()=0 < 0.6 → 爆发。
  const { state: next, emergent } = applyEmergentPatch(
    state,
    nextWorld,
    { storyImpacts: [{ storyId: "story:1", weight: 1 }] },
    { turn: 8, random: () => 0 },
  );
  const story = next.emergentStories[0];
  assert.equal(story.tier, "world");
  assert.equal(story.erupted, true);
  assert.equal(emergent.eruptions.length, 1);
  const eruption = nextWorld.timeline.find((event) => event.tier === "core" && event.source === "emergent");
  assert.ok(eruption);
  assert.ok(eruption.text.includes("漕帮之乱"));
  assert.ok(eruption.factsToAdd[0].id.startsWith("story-fact:"));
});

test("world 档爆发有几率不中：不中不封口，可再次掷", () => {
  const state = baseState({
    emergentStories: [
      { id: "story:1", title: "旧案", summary: "……", originTurn: 1, worldTime: 0, characterIds: [], eventIds: [], momentum: 5, tier: "side", erupted: false },
    ],
  });
  const nextWorld = structuredClone(world);
  // random()=0.99 ≥ 0.6 → 未爆发，但档位已是 world。
  const miss = applyEmergentPatch(state, nextWorld, { storyImpacts: [{ storyId: "story:1", weight: 1 }] }, { turn: 9, random: () => 0.99 });
  assert.equal(miss.state.emergentStories[0].tier, "world");
  assert.equal(miss.state.emergentStories[0].erupted, false);
  // 动量封顶后仍可再掷：继续推进 + 重复 impact。
  const hit = applyEmergentPatch(miss.state, nextWorld, { storyImpacts: [{ storyId: "story:1", weight: 1 }] }, { turn: 10, random: () => 0 });
  assert.equal(hit.state.emergentStories[0].erupted, true);
  // 已爆发不再重复。
  const again = applyEmergentPatch(hit.state, nextWorld, { storyImpacts: [{ storyId: "story:1", weight: 1 }] }, { turn: 11, random: () => 0 });
  assert.equal(
    again.state.emergentStories[0].eventIds.length,
    hit.state.emergentStories[0].eventIds.length,
  );
});

test("一生涌现实体总数封顶后不再创建", () => {
  const stories = Array.from({ length: MAX_EMERGENT_ENTITIES }, (_, index) => ({
    id: `story:s${index}`,
    title: `故事${index}`,
    summary: "……",
    originTurn: 1,
    worldTime: 0,
    characterIds: [],
    eventIds: [],
    momentum: 0,
    tier: "local",
    erupted: false,
  }));
  const state = baseState({ emergentStories: stories });
  const nextWorld = structuredClone(world);
  const { state: next, emergent } = applyEmergentPatch(state, nextWorld, validPatch, {
    turn: 20,
    random: () => 0,
  });
  assert.equal(emergent, null);
  assert.equal(next.emergentStories.length, MAX_EMERGENT_ENTITIES);
  assert.ok(!nextWorld.characters.some((item) => item.name === "阿禾"));
});

test("emergentStoriesView 输出界面视图（档位与下一步阈值）", () => {
  const state = baseState({
    emergentStories: [
      { id: "story:1", title: "旧案", summary: "……", originTurn: 2, worldTime: 0, characterIds: [], eventIds: [], momentum: 3, tier: "side", erupted: false },
      { id: "story:2", title: "大局", summary: "……", originTurn: 4, worldTime: 0, characterIds: [], eventIds: [], momentum: 9, tier: "world", erupted: true },
    ],
  });
  const view = emergentStoriesView(state);
  assert.deepEqual(view[0], { id: "story:1", title: "旧案", summary: "……", kind: "tale", originTurn: 2, momentum: 3, tier: "side", erupted: false, nextTierMomentum: STORY_TIERS.world });
  assert.equal(view[1].erupted, true);
  assert.equal(view[1].nextTierMomentum, null);
});

test("长跳跃投递增强：多年跨度的事件全部到期并进世界见闻", () => {
  // 玩家在别处经年（世界时间推进 40000 分钟 ≈ 27 日），远期大事到期。
  const state = baseState({ worldTime: 40_060 });
  const due = dueTimelineEvents(world, state);
  assert.deepEqual(
    due.map((event) => event.id),
    ["event-1", "event-2"],
  );
  // 投递后（eventStates 标记 delivered）世界见闻按时间排列，未解锁文本保密。
  const delivered = {
    ...state,
    eventStates: {
      "event-1": { status: "delivered", delivery: "present", deliveredTurn: 3 },
      "event-2": { status: "delivered", delivery: "rumor", deliveredTurn: 3 },
    },
  };
  const happenings = worldHappeningsView(delivered, world);
  assert.deepEqual(
    happenings.map((item) => item.id),
    ["event-1", "event-2"],
  );
  assert.equal(happenings[0].day, 1);
  // event-2 的 chapterAnchor=9 > unlockedChapter=3 → 尚未揭晓。
  assert.equal(happenings[1].text, "尚未揭晓");
  assert.equal(happenings[1].source, "canon");
  assert.equal(happenings[1].delivery, "rumor");
});

test("worldHappeningsView 区分原著/替代/涌现来源并跳过未投递事件", () => {
  const state = baseState({
    eventStates: {
      "event-1": { status: "resolved", delivery: "present" },
      derived: { status: "delivered", delivery: "rumor" },
      erupt: { status: "delivered", delivery: null },
    },
  });
  const nextWorld = structuredClone(world);
  nextWorld.timeline.push(
    { id: "derived", time: 90, text: "替代走向", tier: "side", chapterAnchor: 1, source: "derived" },
    { id: "erupt", time: 120, text: "涌现爆发", tier: "core", chapterAnchor: 2, source: "emergent" },
    { id: "pending", time: 130, text: "未来之事", tier: "side", chapterAnchor: 2, source: "emergent" },
  );
  const happenings = worldHappeningsView(state, nextWorld);
  assert.deepEqual(
    happenings.map((item) => item.id),
    ["event-1", "derived", "erupt"],
  );
  assert.equal(happenings.find((item) => item.id === "derived").source, "derived");
  assert.equal(happenings.find((item) => item.id === "erupt").source, "emergent");
});

test("worldHappeningsView 被改命作废的原著事件不再出现(新线直接代替旧线)", () => {
  // 拍板 2026-08-19:改写发生后 invalidated 的原著大事从见闻/边注剔除——
  // 旧时间线不再与新线并列,不出现多余的旧事。
  const state = baseState({
    eventStates: {
      "event-1": { status: "invalidated", delivery: "present" },
      derived: { status: "delivered", delivery: "rumor" },
    },
  });
  const nextWorld = structuredClone(world);
  nextWorld.timeline.push({
    id: "derived",
    time: 90,
    text: "替代走向",
    tier: "side",
    chapterAnchor: 1,
    source: "derived",
  });
  const happenings = worldHappeningsView(state, nextWorld);
  assert.deepEqual(
    happenings.map((item) => item.id),
    ["derived"],
    "invalidated 原著事件被剔除,只余替代线",
  );
});

// —— 引擎级集成：叙事→结构→净化→结算→存档回环 ——
test("emergentPatch 走完整 play 管线：写回世界档案并随存档回环", async () => {
  const { MockLlm } = await import("../fixtures/mock-llm.js");
  const { StoryEngine } = await import("../src/engine.js");
  const { restoreEngine, serializeEngine } = await import("../src/save-store.js");

  let locationId = "gate";
  let storyId = null;
  class EmergentLlm extends MockLlm {
    async generateStructure(args) {
      const response = await super.generateStructure(args);
      const turn = args.context.state.turn;
      if (turn === 1) {
        response.emergentPatch = {
          newStories: [{ title: "孤山新盗", summary: "玩家在码头放走的孩子，后来成了孤山上的新盗。" }],
          newCharacters: [
            { name: "阿枝", role: "码头孤儿", summary: "被玩家从盐仓放走的孤儿，记下了这份因果。", locationId },
          ],
          newEvents: [
            { time: 0, text: "孤山来人向玩家递话", locationId, tier: "local" },
          ],
          storyImpacts: [],
        };
      } else if (turn === 2 && storyId) {
        response.emergentPatch = {
          storyImpacts: [{ storyId, weight: 2 }],
        };
      }
      return response;
    }
  }

  const gameWorld = normalizeWorld({
    id: "world",
    title: "书",
    characters: [{ id: "guide", name: "引路人", locationIds: ["gate"], firstChapter: 2 }],
    locations: ["gate", "tower"],
    factions: [{ id: "guild", name: "公会" }],
    roleTemplates: [{ id: "scout", name: "斥候", locationIds: ["gate"], factionIds: ["guild"] }],
    attributes: [{ id: "focus", name: "专注", initial: 20 }],
    stats: [
      { id: "life", name: "生命", role: "vital", min: 0, max: 10, initial: 10 },
      { id: "track", name: "线索", role: "progress", min: 0, max: 10, initial: 0 },
    ],
    timeline: [
      { id: "event-1", time: 60, text: "旧事", chapterAnchor: 1, locationId: "gate", resolution: "world_time" },
    ],
    facts: [{ id: "f1", chapterAnchor: 1, text: "引路人是上一任守门人。" }],
  });
  locationId = gameWorld.locations[0].id;

  const engine = new StoryEngine({
    world: structuredClone(gameWorld),
    initialState: {
      turn: 0,
      unlockedChapter: 3,
      worldTime: 0,
      locationId,
      location: gameWorld.locations[0].name,
      player: { id: "player", name: "无衣", roleId: "scout", roleName: "斥候", lifeIndex: 1 },
      attributes: { focus: 20 },
      stats: { life: 10, track: 0 },
      conditions: [],
      resolvedEventIds: [],
      resolvedThreads: [],
      retrievalKeywords: [],
      discoveredCharacterIds: [],
      entityStates: {},
      eventStates: {},
    },
    llm: new EmergentLlm(),
    seed: 11,
  });

  const option = {
    id: "look",
    text: "查看城门",
    axis: "investigate",
    risk: "safe",
    attribute: gameWorld.attributes[0].id,
    timeCost: 60,
  };

  const first = await engine.play(option);
  assert.ok(first.emergent, "第一回合应有涌现结果");
  assert.equal(first.emergent.newStory.title, "孤山新盗");
  storyId = first.emergent.newStory.id;
  const spawned = engine.world.characters.find((item) => item.name === "阿枝");
  assert.ok(spawned, "新人物应写进世界档案");
  assert.equal(spawned.provenance.source, "emergent");
  const event = engine.world.timeline.find((item) => item.source === "emergent");
  assert.ok(event, "新事件应进入世界时间线");
  assert.ok(event.storyId, storyId);
  assert.equal(engine.store.current.emergentStories.length, 1);
  assert.deepEqual(engine.store.current.emergentStories[0].characterIds, [spawned.id]);

  // 第二回合：storyImpacts 推进动量。上下文在回合开始时构建——
  // 故事诞生于第一回合，因此从第二回合的上下文起对模型可见。
  const second = await engine.play(option);
  assert.equal(second.emergent.impacts[0].momentum, 2);
  assert.equal(engine.store.current.emergentStories[0].momentum, 2);
  assert.equal(engine.store.current.emergentStories[0].tier, "local");
  const contextSeen = engine.history.at(-1).context.emergentStories;
  assert.equal(contextSeen[0].id, storyId, "后续回合的上下文应暴露涌现故事供推进");

  // 存档回环：涌现故事随进度保存并可恢复。
  const saved = serializeEngine(engine, {});
  const restored = new StoryEngine({
    world: structuredClone(engine.world),
    initialState: saved.snapshots[0],
    llm: new MockLlm(),
    seed: 11,
  });
  restoreEngine(restored, saved);
  assert.equal(restored.store.current.emergentStories[0].title, "孤山新盗");
  assert.equal(
    restored.world.characters.some((item) => item.name === "阿枝"),
    true,
    "涌现人物随世界档案延续",
  );
});

// —— 同行者（拍板 2026-08-17：仅涌现人物、叙事存在、上限 3）——
const companionWorld = normalizeWorld({
  id: "world",
  title: "书",
  characters: [
    { id: "guide", name: "引路人", locationIds: ["gate"], firstChapter: 2 },
    { id: "sprout", name: "阿枝", summary: "码头孤儿。", locationIds: ["gate"], provenance: { source: "emergent" } },
    { id: "chen", name: "陈九", summary: "落拓刀客。", locationIds: ["gate"], provenance: { source: "emergent" } },
  ],
  locations: ["gate", "tower"],
  roleTemplates: [{ id: "scout", name: "斥候", locationIds: ["gate"] }],
  attributes: [{ id: "focus", name: "专注", initial: 20 }],
  stats: [{ id: "life", name: "生命", role: "vital", min: 0, max: 10, initial: 10 }],
  timeline: [],
  facts: [],
});

test("companionJoin 净化：只收涌现人物，原著人物拒之门外", () => {
  const canon = sanitizeEmergentPatch(
    { companionJoin: { characterId: "guide" } },
    companionWorld,
  );
  // 原著人物不入队：补丁里只剩无效声明时整段丢弃（宁缺毋滥）。
  assert.equal(canon, undefined, "原著人物不得入队");

  const emergent = sanitizeEmergentPatch(
    { companionJoin: { characterId: "sprout" } },
    companionWorld,
  );
  assert.deepEqual(emergent.companionJoin, { characterId: "sprout" });

  const unknown = sanitizeEmergentPatch(
    { companionJoin: { characterId: "nobody" } },
    companionWorld,
  );
  assert.equal(unknown, undefined, "目标不存在时整段补丁为空");
});

test("applyCompanionPatch：入队写档、离队留名、上限三人与去重", () => {
  const state = baseState();
  const joined = applyCompanionPatch(state, companionWorld, { companionJoin: { characterId: "sprout" } }, { turn: 4 });
  assert.deepEqual(joined.companions.joined, ["阿枝"]);
  assert.equal(joined.state.companions[0].characterId, "sprout");
  assert.equal(companionWorld.characters.find((c) => c.id === "sprout").provenance.companionSince, 4);

  // 重复入队被忽略。
  const again = applyCompanionPatch(joined.state, companionWorld, { companionJoin: { characterId: "sprout" } }, { turn: 5 });
  assert.equal(again.companions, null);
  assert.equal(again.state.companions.length, 1);

  // 离队：留档一条。
  const left = applyCompanionPatch(joined.state, companionWorld, { companionLeave: { characterId: "sprout", reason: "留在码头看家" } }, { turn: 6 });
  assert.deepEqual(left.companions.left, [{ name: "阿枝", reason: "留在码头看家" }]);
  assert.equal(left.state.companions.length, 0);
  assert.deepEqual(left.state.companionsLog, [{ turn: 6, name: "阿枝", reason: "留在码头看家" }]);

  // 上限：装满 COMPANION_CAP 人后再入队无效。
  const full = { ...baseState(), companions: [1, 2, 3].map((n) => ({ id: `c${n}`, characterId: `x${n}`, name: `路人${n}`, sinceTurn: 1, note: "" })) };
  const capped = applyCompanionPatch(full, companionWorld, { companionJoin: { characterId: "sprout" } }, { turn: 7 });
  assert.equal(capped.companions, null, `队满 ${COMPANION_CAP} 人不再收人`);
});

// —— 基业线（kind 钳位与视图透传）——
test("基业线：newStories.kind 钳位并在视图透传", () => {
  const clean = sanitizeEmergentPatch(
    { newStories: [{ title: "青蚨钱庄", summary: "玩家在码头开的小钱庄。", kind: "venture" }] },
    world,
  );
  assert.equal(clean.newStory.kind, "venture");
  const bad = sanitizeEmergentPatch(
    { newStories: [{ title: "怪谈", summary: "一件说不得的旧事。", kind: "ominous" }] },
    world,
  );
  assert.equal(bad.newStory.kind, "tale", "未知 kind 一律回落 tale");

  const outcome = applyEmergentPatch(
    baseState(),
    structuredClone(world),
    clean,
    { turn: 3, random: () => 0.99 },
  );
  assert.equal(outcome.state.emergentStories[0].kind, "venture");
  assert.equal(emergentStoriesView(outcome.state)[0].kind, "venture");
});

// —— 舆图（拍板 2026-08-17：地点全知+人物只显已遇+旧事印）——
test("atlasView：通路无向合并、人物只显已遇、旧事印防剧透", () => {
  const atlasWorld = normalizeWorld({
    id: "world",
    title: "书",
    characters: [
      { id: "guide", name: "引路人", locationIds: ["gate"], firstChapter: 2 },
      { id: "stranger", name: "陌生人", locationIds: ["tower"] },
    ],
    locations: [
      { id: "gate", name: "城门", connections: ["bridge"] },
      { id: "bridge", name: "石桥", connections: [] },
      { id: "tower", name: "高塔", connections: [] },
    ],
    roleTemplates: [{ id: "scout", name: "斥候", locationIds: ["gate"] }],
    attributes: [{ id: "focus", name: "专注", initial: 20 }],
    stats: [{ id: "life", name: "生命", role: "vital", min: 0, max: 10, initial: 10 }],
    timeline: [
      { id: "past", time: 30, text: "石桥旧事", chapterAnchor: 1, locationId: "bridge", resolution: "world_time" },
      { id: "future", time: 9_000_000, text: "高塔之变", chapterAnchor: 9, locationId: "tower", resolution: "never" },
    ],
    facts: [],
  });
  const state = {
    locationId: "gate",
    unlockedChapter: 2,
    discoveredCharacterIds: ["guide"],
    entityStates: { guide: { status: "active", locationId: "bridge" } },
    eventStates: { past: { status: "resolved", delivery: "rumor" } },
    worldTime: 100,
  };
  const atlas = atlasView(state, atlasWorld);
  assert.equal(atlas.playerLocationId, "gate");
  // 通路无向：bridge 只在 gate 的 connections 里，gate 侧也要有反向通路。
  const gate = atlas.locations.find((item) => item.id === "gate");
  const bridge = atlas.locations.find((item) => item.id === "bridge");
  assert.ok(gate.connections.includes("bridge"));
  assert.ok(bridge.connections.includes("gate"), "通路按无向图合并");
  // 人物：只显已遇的 guide（在 bridge），陌生人不上图。
  assert.deepEqual(atlas.characters, [{ id: "guide", name: "引路人", locationId: "bridge" }]);
  // 旧事印：已发生的石桥旧事在册；未解锁的高塔之变不露。
  assert.deepEqual(atlas.marks, [{ locationId: "bridge", text: "石桥旧事" }]);
  assert.match(atlas.clockLabel, /第 \d+ 日/);
});

// —— 命运种子（拍板 2026-08-17 反馈闭环：铺垫中的改命要看得见火候）——
test("fateSeedsView：势能与阈值成对，至多两条", () => {
  const seeds = fateSeedsView(
    {
      pendingDivergences: [
        { targetId: "event-1", targetType: "timeline", momentum: 2 },
        { targetId: "f1", targetType: "fact", momentum: 1 },
        { targetId: "missing", targetType: "timeline", momentum: 3 },
      ],
    },
    world,
  );
  assert.equal(seeds.length, 2, "上限两条");
  assert.deepEqual(seeds[0], { target: "旧事", momentum: 2, threshold: 2 });
  assert.equal(seeds[1].threshold, 2, "fact 默认 side 档");
  // 目标不存在的铺垫拿不到阈值,被过滤。
  assert.ok(!seeds.some((item) => item.threshold <= 0));
  assert.deepEqual(fateSeedsView({}, world), []);
});

test("新人物当场进入引擎状态与已发现名单(不是幽灵 NPC)", () => {
  const state = baseState({ entityStates: {}, discoveredCharacterIds: [] });
  const patch = sanitizeEmergentPatch(validPatch, world);
  const { state: next, emergent } = applyEmergentPatch(state, world, patch, { turn: 4 });
  assert.ok(emergent.newCharacters.length === 1);
  const created = emergent.newCharacters[0];
  // entityStates 有条目:人物才会「在场」,离屏漂移才会带着 ta 走。
  const entity = next.entityStates[created.id];
  assert.ok(entity, "新人物有 entityState");
  assert.equal(entity.locationId, "gate");
  assert.equal(entity.status, "active");
  // 已发现名单收录:上下文与选项才会继续出现/指向此人,模型才能拿到 id。
  assert.ok(next.discoveredCharacterIds.includes(created.id), "新人物已发现");
  // 世界档案里也带 status,与其它人物的形状一致。
  const stored = world.characters.find((character) => character.id === created.id);
  assert.equal(stored.status, "active");
  assert.equal(stored.provenance.source, "emergent");
});
