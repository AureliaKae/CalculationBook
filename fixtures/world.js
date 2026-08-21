export const world = {
  id: "ash-harbor",
  title: "灰港余烬",
  characters: [
    { id: "player", name: "沈砚" },
    { id: "lin", name: "林雾" },
    { id: "captain", name: "闻舟" },
    { id: "doctor", name: "顾青" },
    { id: "warden", name: "阎策" },
  ],
  locations: ["旧码头", "灯塔", "盐仓"],
  attributes: [
    { id: "resolve", name: "定力" },
    { id: "agility", name: "身手" },
  ],
  stats: [
    {
      id: "breath",
      name: "余息",
      role: "vital",
      min: 0,
      max: 10,
      zeroConsequence: "重伤昏迷",
    },
    { id: "supplies", name: "口粮", role: "resource", min: 0, max: 20 },
    { id: "clue", name: "潮痕", role: "progress", min: 0, max: 10 },
    { id: "trust", name: "林雾的信任", role: "relation", min: -5, max: 5 },
  ],
  facts: [
    { id: "f1", chapterAnchor: 1, text: "旧码头的黑铃从不被海风吹响。" },
    { id: "f2", chapterAnchor: 1, text: "第2回合会发现半枚刻着燕尾的铜扣。" },
    { id: "f3", chapterAnchor: 4, text: "燕尾铜扣属于失踪的灯塔守夜人。" },
    { id: "f4", chapterAnchor: 9, text: "灯塔地窖藏着灰港断粮的真相。" },
  ],
  timeline: Array.from({ length: 10 }, (_, index) => ({
    id: `event-${index + 1}`,
    turn: (index + 1) * 2,
    location: index % 2 === 0 ? "旧码头" : "灯塔",
    text: `原著主线事件 ${index + 1}`,
    chapterAnchor: index + 1,
    resolution: "world_time",
    resolutionTargetIds: [],
  })),
};

export const initialState = {
  turn: 0,
  location: "旧码头",
  unlockedChapter: 3,
  stats: { breath: 10, supplies: 12, clue: 0, trust: 0 },
  attributes: { resolve: 35, agility: 40 },
  conditions: [],
  resolvedEventIds: [],
  resolvedThreads: [],
  retrievalKeywords: [],
  chapterSummary: "沈砚在封港之夜醒来，海雾切断了所有退路。",
};

export const startingOption = {
  id: "start",
  text: "沿着潮湿的石阶走向黑铃",
  axis: "investigate",
  approach: "resist",
  risk: "safe",
  attribute: "resolve",
};
