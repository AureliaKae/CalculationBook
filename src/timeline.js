// 等待期阅读区的数据视图:原文之河 + 本世足迹。
// 原则:未来全藏——只展示已发生的原文事件与「此刻」,未解锁章节的文本保密。
// 双轴语义(拍板:倒叙/插叙摊平成故事内时间线):
// - 故事内时间(time)是世界推演的唯一轴,与原文叙述顺序(章节)无关;
// - 章节(chapterAnchor)只用于防剧透范围与「原著第 N 章提及」的定位标注;
// - 阅读范围由进入意图一次定死,不再随时间扩张。

// 故事起点 = 全时间线最早事件的故事内时间;无事件时为 0。
export function storyStart(world) {
  const times = (world?.timeline ?? []).map((event) => Number(event.time) || 0);
  return times.length ? Math.min(...times) : 0;
}

// 锚点事件 = 故事内时间最早的事件(倒叙书中可能不是第 1 章叙述的)。
export function timelineAnchor(world) {
  const events = [...(world?.timeline ?? [])].sort((left, right) => left.time - right.time);
  return events.length ? events[0] : null;
}

// 原著的时钟 = 故事起点 + 世界时间;切入命运节点时 worldTime 初值 = 节点时间 - 故事起点。
export function timelineClock(world, state) {
  return storyStart(world) + Math.max(0, Number(state?.worldTime ?? 0));
}

const DAY_MINUTES = 1440;
// 昼夜分段(小时区间,前闭后开):题材中立的通用表述,不挑仙侠/都市。
const DAY_SEGMENTS = Object.freeze([
  { from: 0, to: 5, label: "深夜" },
  { from: 5, to: 7, label: "拂晓" },
  { from: 7, to: 11, label: "清晨" },
  { from: 11, to: 13, label: "正午" },
  { from: 13, to: 17, label: "午后" },
  { from: 17, to: 19, label: "黄昏" },
  { from: 19, to: 24, label: "夜里" },
]);

// 故事时钟视图(拍板:推演的时间贴着原著走):把世界时钟翻成模型与校验器可读的
// 「第 N 日 · 某时段」,并给出距下一件原著大事的分钟数——叙事里的昼夜、日期与
// 「过了几日」全部以此为唯一权威,不得自造另一套时间。
export function storyClockView(world, state) {
  const start = storyStart(world);
  const clock = timelineClock(world, state);
  const elapsed = Math.max(0, clock - start);
  const day = Math.floor(elapsed / DAY_MINUTES) + 1;
  const minuteOfDay = elapsed % DAY_MINUTES;
  const hour = Math.floor(minuteOfDay / 60);
  const segment =
    DAY_SEGMENTS.find((item) => hour >= item.from && hour < item.to)?.label ?? "深夜";
  // 下一件未改写的原著大事:被改命 invalidated 的事件不再为时间定节奏。
  const nextEvent = [...(world?.timeline ?? [])]
    .filter(
      (event) =>
        Number(event.time) > clock && state?.eventStates?.[event.id]?.status !== "invalidated",
    )
    .sort((left, right) => left.time - right.time)[0];
  return {
    minutes: clock,
    elapsedMinutes: elapsed,
    day,
    hour,
    segment,
    label: `第 ${day} 日 · ${segment}`,
    nextEventGapMinutes: nextEvent ? Number(nextEvent.time) - clock : null,
  };
}

// 原文之河:past=已发生的原文事件,now=当前原文时刻,upcoming=即将到来的事件。
// 未来全藏:upcoming 最多 3 件,未解锁章节的文本一律「尚未揭晓」。
// 改命标注(拍板:补一处改命展示):事件被改写标 fateChanged,铺垫中标 fatePending。
export function riverView(state, world) {
  const events = [...(world?.timeline ?? [])].sort((left, right) => left.time - right.time);
  const states = state?.eventStates ?? {};
  const clock = timelineClock(world, state);
  const unlocked = Number(state?.unlockedChapter ?? 1);
  const times = events.map((event) => Number(event.time) || 0);
  const spanStart = times.length ? Math.min(...times) : 0;
  const spanEnd = times.length ? Math.max(...times) : 0;
  const position =
    spanEnd > spanStart ? Math.min(1, Math.max(0, (clock - spanStart) / (spanEnd - spanStart))) : 0;
  const visible = (event) => Number(event.chapterAnchor ?? 1) <= unlocked;
  const changedIds = new Set(
    (state?.completedDivergences ?? []).map((item) => item.targetId).filter(Boolean),
  );
  const pendingIds = new Set(
    (state?.pendingDivergences ?? []).map((item) => item.targetId).filter(Boolean),
  );
  const fateMark = (event) =>
    changedIds.has(event.id)
      ? "changed"
      : pendingIds.has(event.id)
        ? "pending"
        : null;
  const mapEvent = (event) => ({
    id: event.id,
    text: visible(event) ? event.text : "尚未揭晓",
    chapterAnchor: Number(event.chapterAnchor ?? 1),
    locked: !visible(event),
    time: Number(event.time) || 0,
    fate: fateMark(event),
  });
  const past = events
    .filter((event) => Number(event.time) <= clock)
    .filter((event) => states[event.id]?.status !== "invalidated")
    .map(mapEvent)
    .slice(-6);
  const upcomingRaw = events.filter((event) => Number(event.time) > clock).slice(0, 3);
  const upcoming = upcomingRaw.map(mapEvent);
  return {
    past,
    now: {
      chapter: unlocked,
      position,
      next: upcomingRaw.length ? mapEvent(upcomingRaw[0]) : null,
    },
    upcoming,
    span: { start: spanStart, end: spanEnd },
  };
}

// 舆图视图(拍板 2026-08-17:地点全知+人物只显已遇+旧事印):
// 地点与通路全显(玩家读过原著,地点不是秘密);人物行踪只给已遇见的
// (行踪诚实:没见过的人你不知道他在哪);已投递的原著事件在其地点留旧事印。
export function atlasView(state, world) {
  const locations = (world?.locations ?? []).map((location) => ({
    id: location.id,
    name: location.name,
    connections: Array.isArray(location.connections) ? location.connections.filter(Boolean) : [],
  }));
  const byId = new Map(locations.map((location) => [location.id, location]));
  // 通路按无向图合并:烧制档案只记了单向 connection,路是双向的。
  for (const location of locations) {
    for (const target of location.connections) {
      if (!byId.has(target)) continue;
      const other = byId.get(target);
      if (!other.connections.includes(location.id)) other.connections.push(location.id);
    }
  }
  const discovered = new Set(state?.discoveredCharacterIds ?? []);
  const characters = (world?.characters ?? [])
    .filter((character) => discovered.has(character.id))
    .map((character) => {
      const live = state?.entityStates?.[character.id];
      const locationId = live?.locationId ?? character.locationIds?.[0] ?? null;
      return { id: character.id, name: character.name, locationId: byId.has(locationId) ? locationId : null };
    })
    .filter((character) => character.locationId);
  const unlocked = Number(state?.unlockedChapter ?? 1);
  const marks = [];
  for (const event of world?.timeline ?? []) {
    const record = state?.eventStates?.[event.id];
    if (!record || record.status === "scheduled" || record.status === "invalidated") continue;
    if (!byId.has(event.locationId)) continue;
    if (Number(event.chapterAnchor ?? 1) > unlocked) continue;
    marks.push({ locationId: event.locationId, text: event.text });
  }
  return {
    locations,
    playerLocationId: state?.locationId ?? null,
    characters,
    marks: marks.slice(-30),
    clockLabel: storyClockView(world, state).label,
  };
}

// 本世足迹:最近的选择与判定,倒序。
export function footstepsView(history, limit = 10) {
  return (history ?? [])
    .slice(-limit)
    .reverse()
    .map((turn) => ({
      number: turn.number,
      choice: turn.choice?.text ?? "",
      result: turn.check?.result ?? "",
    }));
}

// 原著主角识别(拍板 2026-08-19:名录换主角现状卡):烧制不给人物打叙述标签
// (「主角/配角/反派」禁写),用 core 层级时间线事件里出场最多的人物名反推;
// 平手取全书提及更多的,再平手取登场更早的。识别不出返回 null。
// normalizeWorld 有缓存,同一世界对象重复取值走 WeakMap 兜住。
const PROTAGONIST_CACHE = new WeakMap();
export function protagonistOf(world) {
  if (!world) return null;
  if (PROTAGONIST_CACHE.has(world)) return PROTAGONIST_CACHE.get(world);
  const events = world.timeline ?? [];
  const ranked = (() => {
    const counts = [];
    for (const character of world.characters ?? []) {
      let core = 0;
      let all = 0;
      for (const event of events) {
        if (!event.text?.includes(character.name)) continue;
        all += 1;
        if (event.tier === "core") core += 1;
      }
      if (core > 0) {
        counts.push({ id: character.id, core, all, firstChapter: character.firstChapter ?? 1e9 });
      }
    }
    return counts.sort((a, b) => b.core - a.core || b.all - a.all || a.firstChapter - b.firstChapter);
  })();
  const protagonist = ranked.length
    ? (world.characters ?? []).find((character) => character.id === ranked[0].id) ?? null
    : null;
  PROTAGONIST_CACHE.set(world, protagonist);
  return protagonist;
}

// 原著主角现状卡(拍板 2026-08-19:现状+近期,不做全程年表、不透未来):
// 此刻行踪(entityStates 行踪,与舆图同源)、状态(dead/captured 等显式标出)、
// 最近 2-3 件已投递的主角大事(含该角色名的事件,故事时间倒序,带「第 N 日」)。
export function protagonistView(state, world) {
  const protagonist = protagonistOf(world);
  if (!protagonist) return null;
  return povLineOf(state, world, protagonist, 3);
}

// POV 清单(拍板 2026-08-20:并行多线书的现状卡按线并列):烧制 people 片产出
// povCharacters(1-3 人,双 POV/多线书按线各一);清单缺失或全悬空时回落
// protagonistOf 反推单主角——旧书零迁移,行为不变。
export function povsOf(world) {
  const listed = (world?.povCharacters ?? [])
    .map((id) => (world.characters ?? []).find((character) => character.id === id))
    .filter(Boolean);
  return listed.length ? listed : [protagonistOf(world)].filter(Boolean);
}

// 单个 POV 的现状行:名 · 此刻在哪 · 状态 · 最近已投递大事(带「第 N 日」)。
function povLineOf(state, world, character, recentLimit = 1) {
  const entity = (state?.entityStates ?? {})[character.id] ?? {};
  const locationName =
    (world.locations ?? []).find((location) => location.id === entity.locationId)?.name ?? null;
  const start = storyStart(world);
  const states = state?.eventStates ?? {};
  const recent = (world.timeline ?? [])
    .filter(
      (event) =>
        event.text?.includes(character.name) &&
        states[event.id] &&
        states[event.id].status !== "scheduled" &&
        states[event.id].status !== "invalidated",
    )
    .sort((left, right) => right.time - left.time)
    .slice(0, recentLimit)
    .map((event) => ({
      text: String(event.text ?? "").slice(0, 44),
      day: Math.max(1, Math.floor((Number(event.time) - start) / DAY_MINUTES) + 1),
    }));
  return {
    id: character.id,
    name: character.name,
    role: character.role ?? "",
    summary: String(character.summary ?? "").slice(0, 30),
    locationName,
    status: entity.status && entity.status !== "active" ? entity.status : null,
    recent,
  };
}

// 原著主线区块(拍板 2026-08-20:多线并行书每位 POV 一行):1-3 位 POV 并列,
// 每行名 · 此刻在哪 · 状态 · 最近一件大事;单人书与旧 protagonistView 同构。
export function povLinesView(state, world) {
  const povs = povsOf(world);
  return povs.map((character) => povLineOf(state, world, character, povs.length > 1 ? 1 : 3));
}

// 世界见闻(拍板 2026-08-17:平行推演的可读呈现):本世已投递/已解决的事件
// ——原著主线、替代走向与涌现故事——按世界时间升序排列。玩家在别处经年,
// 主角一侧与世界一侧的事都在这里按「第 N 日」的时钟铺开。
// 拍板 2026-08-19:被改命作废(invalidated)的原著事件不再展示——改写发生后
// 新时间线直接代替旧线,不出现多余的旧事;替代事件(derived)与涌现自然接上。
// 防剧透与 riverView 同口径:未解锁章节的原文文本一律「尚未揭晓」。
export function worldHappeningsView(state, world, limit = 40) {
  const states = state?.eventStates ?? {};
  const start = storyStart(world);
  const unlocked = Number(state?.unlockedChapter ?? 1);
  const events = (world?.timeline ?? [])
    .filter(
      (event) =>
        states[event.id] &&
        states[event.id].status !== "scheduled" &&
        states[event.id].status !== "invalidated",
    )
    .sort((left, right) => (Number(left.time) || 0) - (Number(right.time) || 0))
    .map((event) => {
      const record = states[event.id];
      const elapsed = Math.max(0, (Number(event.time) || 0) - start);
      const visible = Number(event.chapterAnchor ?? 1) <= unlocked;
      return {
        id: event.id,
        day: Math.floor(elapsed / DAY_MINUTES) + 1,
        text: visible ? event.text : "尚未揭晓",
        tier: event.tier ?? "side",
        source:
          event.source === "emergent"
            ? "emergent"
            : event.source === "derived"
              ? "derived"
              : "canon",
        delivery: record.delivery ?? null,
        status: record.status,
        diverged: Boolean(record.diverged),
      };
    });
  return events.slice(-limit);
}
