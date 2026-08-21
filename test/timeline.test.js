import test from "node:test";
import assert from "node:assert/strict";

import {
  footstepsView,
  protagonistOf,
  protagonistView,
  povLinesView,
  povsOf,
  riverView,
  storyClockView,
  storyStart,
  timelineAnchor,
  timelineClock,
} from "../src/timeline.js";
import { normalizeWorld } from "../src/evolution.js";
import { world as baseWorld, initialState } from "../fixtures/world.js";
import { migrateState } from "../src/evolution.js";

const world = normalizeWorld(structuredClone(baseWorld));
const state = migrateState(structuredClone(initialState), world);

test("timelineClock 以故事起点(最早事件的故事内时间)为 0 点", () => {
  // 拍板:双轴语义——时钟 = 故事内时间起点 + 世界时间,与章节叙述顺序无关。
  assert.equal(storyStart(world), 120); // event-1 的 time
  assert.equal(timelineAnchor(world)?.id, "event-1", "锚点=故事内时间最早的事件");
  assert.equal(timelineClock(world, { worldTime: 0 }), 120);
  assert.equal(timelineClock(world, { worldTime: 60 }), 180);
});

test("storyStart 与 timelineAnchor 容忍无时间线的世界", () => {
  const bare = normalizeWorld({ ...structuredClone(baseWorld), timeline: [] });
  assert.equal(storyStart(bare), 0);
  assert.equal(timelineAnchor(bare), null);
});

test("倒叙/插叙世界:故事内时间与叙述章节顺序不一致时,锚定按时间走", () => {
  const flashbackWorld = normalizeWorld({
    ...structuredClone(baseWorld),
    // ch1 叙述的是十年后的结局(time 大),插叙回忆 time 小但 chapterAnchor 大。
    timeline: [
      { id: "ending", time: 100000, chapterAnchor: 1, location: "旧码头", text: "大结局" },
      { id: "memory", time: 10, chapterAnchor: 5, location: "灯塔", text: "回忆往事" },
    ],
  });
  assert.equal(storyStart(flashbackWorld), 10, "起点是故事内最早事件,不是第 1 章");
  assert.equal(timelineAnchor(flashbackWorld)?.id, "memory");
  assert.equal(timelineClock(flashbackWorld, { worldTime: 0 }), 10);
});

test("riverView 返回已发生、此刻与即将发生,未解锁文本保密", () => {
  const view = riverView(
    { ...state, unlockedChapter: 3, worldTime: 0 },
    world,
  );
  // clock=120:event-1 已过,event-2/3 在 unlock 内可见,event-4 尚未解锁。
  assert.deepEqual(view.past.map((item) => item.id), ["event-1"]);
  assert.equal(view.now.chapter, 3);
  assert.equal(view.now.next.id, "event-2");
  assert.equal(view.now.next.locked, false);
  assert.deepEqual(view.upcoming.map((item) => item.id), ["event-2", "event-3", "event-4"]);
  assert.equal(view.upcoming[2].locked, true);
  assert.equal(view.upcoming[2].text, "尚未揭晓");
  assert.ok(view.now.position >= 0 && view.now.position <= 1);
});

test("riverView 未来全藏且容忍无时间线的世界", () => {
  const far = riverView({ ...state, unlockedChapter: 10, worldTime: 100000 }, world);
  assert.equal(far.upcoming.length, 0, "越过全部事件后不再有未来事件");
  const empty = riverView(state, { ...world, timeline: [] });
  assert.deepEqual(empty.past, []);
  assert.equal(empty.now.next, null);
});

test("footstepsView maps the last choices newest-first and truncates", () => {
  const history = Array.from({ length: 15 }, (_, index) => ({
    number: index + 1,
    choice: { text: `行动${index + 1}` },
    check: { result: index % 2 === 0 ? "success" : "failure" },
  }));
  const view = footstepsView(history, 10);
  assert.equal(view.length, 10);
  assert.equal(view[0].number, 15);
  assert.equal(view[0].choice, "行动15");
  assert.equal(view[9].number, 6);
  assert.equal(view[0].result, "success"); // index 14 为偶数 → success
});

test("footstepsView tolerates empty history", () => {
  assert.deepEqual(footstepsView([], 10), []);
  assert.deepEqual(footstepsView(undefined), []);
});

test("riverView 标注改命状态:已改写与铺垫中的命运节点", () => {
  const changed = { ...state, completedDivergences: [{ targetId: "event-2", targetType: "timeline", fire: true }], pendingDivergences: [] };
  const viewChanged = riverView(changed, world);
  const event2Changed = [...viewChanged.past, ...viewChanged.upcoming].find((item) => item.id === "event-2");
  assert.equal(event2Changed?.fate, "changed", "已改写的节点标 changed");

  const pending = { ...state, completedDivergences: [], pendingDivergences: [{ targetId: "event-3", targetType: "timeline", fire: false }] };
  const viewPending = riverView(pending, world);
  const event3Pending = [...viewPending.past, ...viewPending.upcoming].find((item) => item.id === "event-3");
  assert.equal(event3Pending?.fate, "pending", "铺垫中的节点标 pending");

  const plain = riverView(state, world);
  const event1 = [...plain.past, ...plain.upcoming].find((item) => item.id === "event-1");
  assert.equal(event1?.fate, null, "无关节点不标");
});

// —— 故事时钟(拍板:推演的时间贴着原著走) ——

test("storyClockView 把世界时钟翻成「第 N 日 · 时段」,日期与昼夜随推演前进", () => {
  // clock = storyStart(120) + worldTime:起点即第 1 日的 0 点。
  const start = storyClockView(world, { worldTime: 0 });
  assert.equal(start.elapsedMinutes, 0);
  assert.equal(start.day, 1);
  assert.equal(start.hour, 0);
  assert.equal(start.segment, "深夜");
  assert.equal(start.label, "第 1 日 · 深夜");

  // 一天整之后:第 2 日的同一时刻,时间只前进。
  const nextDay = storyClockView(world, { worldTime: 1440 });
  assert.equal(nextDay.day, 2);
  assert.equal(nextDay.label, "第 2 日 · 深夜");

  // 17:30 是黄昏;小时取整点。
  const dusk = storyClockView(world, { worldTime: 17 * 60 + 30 });
  assert.equal(dusk.hour, 17);
  assert.equal(dusk.segment, "黄昏");
  assert.equal(dusk.label, "第 1 日 · 黄昏");
});

test("storyClockView 的下一件大事:被改写的命运不再定节奏,没有未来则空", () => {
  // clock=120(故事起点):下一件大事 event-2(time 240),距 120 分钟。
  assert.equal(storyClockView(world, { worldTime: 0 }).nextEventGapMinutes, 120);
  // event-2 已被改命 invalidated:节奏让位给 event-3(time 360)。
  const diverged = storyClockView(world, {
    worldTime: 0,
    eventStates: { "event-2": { status: "invalidated" } },
  });
  assert.equal(diverged.nextEventGapMinutes, 240);
  // 越过全部事件后没有下一件。
  assert.equal(storyClockView(world, { worldTime: 100000 }).nextEventGapMinutes, null);
});

// —— 原著主角现状卡（拍板 2026-08-19：名录换主角，core 事件高频反推） ——

const heroWorld = normalizeWorld({
  id: "hero",
  title: "书",
  characters: [
    { id: "hero", name: "林千行", role: "散修", locationIds: ["青云坊"] },
    { id: "rival", name: "赵无咎", role: "魔修", locationIds: ["黑风寨"] },
  ],
  locations: ["青云坊", "黑风寨"],
  attributes: [],
  stats: [],
  timeline: [
    { id: "e1", time: 100, tier: "core", chapterAnchor: 1, location: "青云坊", text: "林千行在青云坊得授功法" },
    { id: "e2", time: 400, tier: "core", chapterAnchor: 2, location: "黑风寨", text: "林千行与赵无咎初见结怨" },
    { id: "e3", time: 900, tier: "side", chapterAnchor: 3, location: "青云坊", text: "赵无咎夜探青云坊" },
    { id: "e4", time: 1500, tier: "core", chapterAnchor: 4, location: "黑风寨", text: "林千行破境筑基" },
  ],
  facts: [],
});

test("protagonistOf：core 事件高频人物即主角，识别不出返回 null", () => {
  assert.equal(protagonistOf(heroWorld)?.id, "hero");
  // 平手与无 core 提及:识别不出 → null(界面整块隐藏)。
  assert.equal(protagonistOf(world), null);
  assert.equal(protagonistOf(null), null);
});

test("protagonistView：现状+近期——行踪、状态、已投递主角大事带日序", () => {
  const state = {
    entityStates: {
      hero: { status: "active", factionId: null, locationId: "黑风寨" },
    },
    eventStates: {
      e1: { status: "delivered", deliveredTurn: 0, delivery: "backstory" },
      e2: { status: "delivered", deliveredTurn: 0, delivery: "backstory" },
      e4: { status: "scheduled" },
    },
  };
  const view = protagonistView(state, heroWorld);
  assert.equal(view.name, "林千行");
  assert.equal(view.locationName, "黑风寨");
  assert.equal(view.status, null, "active 不标状态");
  assert.deepEqual(
    view.recent.map((event) => event.text),
    ["林千行与赵无咎初见结怨", "林千行在青云坊得授功法"],
    "只列已投递的主角事件,按故事时间倒序",
  );
  assert.equal(view.recent[0].day > 0, true);

  const dead = protagonistView(
    { ...state, entityStates: { ...state.entityStates, hero: { status: "dead", locationId: "黑风寨" } } },
    heroWorld,
  );
  assert.equal(dead.status, "dead", "非 active 状态透出");
});

// —— POV 清单（拍板 2026-08-20：并行多线书的现状卡按线并列）——

test("povsOf：清单按线并列,缺失回落主角反推", () => {
  const dual = normalizeWorld({
    ...structuredClone(baseWorld),
    characters: [
      { id: "hero", name: "林千行", role: "散修", locationIds: ["青云坊"], firstChapter: 1 },
      { id: "rival", name: "赵无咎", role: "魔修", locationIds: ["黑风寨"], firstChapter: 1 },
    ],
    locations: ["青云坊", "黑风寨"],
    timeline: [
      { id: "e1", time: 100, tier: "core", chapterAnchor: 1, text: "林千行得授功法" },
      { id: "e2", time: 150, tier: "core", chapterAnchor: 1, text: "赵无咎夜探魔窟" },
    ],
    povCharacters: ["rival", "hero", "rival", "ghost"],
    facts: [],
  });
  // 去重 + 滤悬空(ghost) + 保持清单顺序。
  assert.deepEqual(
    povsOf(dual).map((c) => c.id),
    ["rival", "hero"],
  );
  // 清单缺失 → 回落 protagonistOf 反推(core 出场最多者)。
  const legacy = normalizeWorld({ ...structuredClone(dual), povCharacters: [] });
  assert.deepEqual(
    povsOf(legacy).map((c) => c.id),
    ["hero"],
  );
});

test("povLinesView：多 POV 每人一行近事一条,单人书与主角卡同构", () => {
  const dual = normalizeWorld({
    ...structuredClone(baseWorld),
    characters: [
      { id: "hero", name: "林千行", role: "散修", locationIds: ["青云坊"], firstChapter: 1 },
      { id: "rival", name: "赵无咎", role: "魔修", locationIds: ["黑风寨"], firstChapter: 1 },
    ],
    locations: ["青云坊", "黑风寨"],
    timeline: [
      { id: "e1", time: 100, tier: "core", chapterAnchor: 1, text: "林千行得授功法" },
      { id: "e2", time: 150, tier: "core", chapterAnchor: 1, text: "赵无咎夜探魔窟" },
      { id: "e3", time: 300, tier: "core", chapterAnchor: 2, text: "赵无咎炼成魔功" },
    ],
    povCharacters: ["hero", "rival"],
    facts: [],
  });
  const povState = {
    entityStates: {
      hero: { status: "active", factionId: null, locationId: "青云坊" },
      rival: { status: "active", factionId: null, locationId: "黑风寨" },
    },
    eventStates: {
      e1: { status: "delivered" },
      e2: { status: "delivered" },
      e3: { status: "delivered" },
    },
  };
  const lines = povLinesView(povState, dual);
  assert.equal(lines.length, 2);
  assert.deepEqual(
    lines.map((line) => line.name),
    ["林千行", "赵无咎"],
  );
  assert.equal(lines[0].locationName, "青云坊");
  // 多 POV 时每人只留最近一条近事。
  assert.deepEqual(
    lines[1].recent.map((event) => event.text),
    ["赵无咎炼成魔功"],
  );
  // 单人书：退化为与 protagonist 同构的一行（去掉 rival 独有事件,反推主角为 hero）。
  const legacy = normalizeWorld({
    ...structuredClone(dual),
    povCharacters: [],
    timeline: dual.timeline.filter((event) => event.id !== "e3"),
  });
  const single = povLinesView(povState, legacy);
  assert.equal(single.length, 1);
  assert.equal(single[0].name, "林千行");
  assert.equal(single[0].recent.length, 1, "单人只投递了一件主角事件");
});

