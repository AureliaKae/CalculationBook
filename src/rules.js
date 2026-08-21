// 玩法规则参数层:AI 提议,代码白名单钳位——机制代码不变,参数随书而变。
// 任何越界/非法输入一律钳回默认,游戏永远可玩、存档永远兼容。

export const DEFAULT_RULES = Object.freeze({
  difficulty: Object.freeze({ safe: 30, risky: 55, dire: 75 }),
  defaultTimeCost: 60,
  maxTimeCost: 10080,
  offscreenTickMinutes: 2880,
});

const DIFFICULTY_RANGE = [20, 80];
const DEFAULT_TIME_RANGE = [10, 240];
const MAX_TIME_RANGE = [240, 43200];
const TICK_RANGE = [720, 10080];

function inRange(value, range) {
  return Number.isFinite(value) && value >= range[0] && value <= range[1];
}

export function clampRules(input) {
  const rules =
    input && typeof input === "object" && !Array.isArray(input) ? input : {};
  const difficulty = {
    ...DEFAULT_RULES.difficulty,
    ...(rules.difficulty && typeof rules.difficulty === "object" ? rules.difficulty : {}),
  };
  const { safe, risky, dire } = difficulty;
  const validDifficulty =
    inRange(safe, DIFFICULTY_RANGE) &&
    inRange(risky, DIFFICULTY_RANGE) &&
    inRange(dire, DIFFICULTY_RANGE) &&
    safe < risky &&
    risky < dire;
  const defaultTimeCost = inRange(Number(rules.defaultTimeCost), DEFAULT_TIME_RANGE)
    ? Math.floor(rules.defaultTimeCost)
    : DEFAULT_RULES.defaultTimeCost;
  const maxTimeCost = inRange(Number(rules.maxTimeCost), MAX_TIME_RANGE)
    ? Math.floor(rules.maxTimeCost)
    : DEFAULT_RULES.maxTimeCost;
  const offscreenTickMinutes = inRange(Number(rules.offscreenTickMinutes), TICK_RANGE)
    ? Math.floor(rules.offscreenTickMinutes)
    : DEFAULT_RULES.offscreenTickMinutes;
  return {
    difficulty: validDifficulty
      ? { safe, risky, dire }
      : { ...DEFAULT_RULES.difficulty },
    defaultTimeCost,
    maxTimeCost: Math.max(maxTimeCost, defaultTimeCost),
    offscreenTickMinutes,
  };
}

// 行为自适应层:观察者提议,代码白名单校验。难度偏差累计封顶 ±3;
// 风格/节奏只接受枚举;非法提议整体丢弃字段,永不抛错。
const ADAPTATION_FLAVORS = Object.freeze(["dangerous", "cautious", "neutral"]);
const ADAPTATION_PACINGS = Object.freeze(["faster", "slower", "neutral"]);

export function emptyAdaptation() {
  return { difficultyBias: 0, optionFlavor: "neutral", pacing: "neutral", updatedTurn: 0 };
}

export function clampAdaptation(proposal, current) {
  const base = { ...emptyAdaptation(), ...(current ?? {}) };
  const next = { ...base };
  if (Number.isInteger(proposal?.difficultyBias)) {
    next.difficultyBias = Math.max(-3, Math.min(3, base.difficultyBias + proposal.difficultyBias));
  }
  if (ADAPTATION_FLAVORS.includes(proposal?.optionFlavor)) {
    next.optionFlavor = proposal.optionFlavor;
  }
  if (ADAPTATION_PACINGS.includes(proposal?.pacing)) {
    next.pacing = proposal.pacing;
  }
  return next;
}
