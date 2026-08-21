import assert from "node:assert/strict";
import test from "node:test";

import {
  clampAdaptation,
  clampRules,
  DEFAULT_RULES,
  emptyAdaptation,
} from "../src/rules.js";

test("clampRules 缺省返回现状默认值", () => {
  assert.deepEqual(clampRules(undefined), DEFAULT_RULES);
  assert.deepEqual(clampRules({}), DEFAULT_RULES);
});

test("clampRules 越界字段逐一钳回默认", () => {
  const rules = clampRules({
    difficulty: { safe: 10, risky: 90, dire: 91 }, // 越界且非递增 → 整体回落默认
    defaultTimeCost: 1,
    maxTimeCost: 999999,
    offscreenTickMinutes: 1,
  });
  assert.deepEqual(rules, DEFAULT_RULES);
});

test("clampRules 合法提议原样保留并保证 max ≥ default", () => {
  const rules = clampRules({
    difficulty: { safe: 25, risky: 50, dire: 70 },
    defaultTimeCost: 120,
    maxTimeCost: 60, // 低于下限 240 → 回落默认
    offscreenTickMinutes: 1440,
  });
  assert.deepEqual(rules.difficulty, { safe: 25, risky: 50, dire: 70 });
  assert.equal(rules.defaultTimeCost, 120);
  assert.equal(rules.maxTimeCost, DEFAULT_RULES.maxTimeCost, "非法 max 回落默认,且天然 ≥ default");
  assert.equal(rules.offscreenTickMinutes, 1440);
});

test("clampAdaptation 只接受白名单字段,难度偏差累计封顶 ±3", () => {
  assert.deepEqual(emptyAdaptation(), {
    difficultyBias: 0,
    optionFlavor: "neutral",
    pacing: "neutral",
    updatedTurn: 0,
  });
  // 合法枚举与偏差增量。
  const next = clampAdaptation(
    { difficultyBias: 2, optionFlavor: "dangerous", pacing: "faster", garbage: "x" },
    emptyAdaptation(),
  );
  assert.equal(next.difficultyBias, 2);
  assert.equal(next.optionFlavor, "dangerous");
  assert.equal(next.pacing, "faster");
  assert.equal(next.garbage, undefined, "未知字段整体丢弃");
  // 偏差累计封顶。
  const capped = clampAdaptation({ difficultyBias: 5 }, next);
  assert.equal(capped.difficultyBias, 3);
  const floored = clampAdaptation({ difficultyBias: -9 }, next);
  assert.equal(floored.difficultyBias, -3);
  // 非法枚举整体丢弃字段。
  const rejected = clampAdaptation({ optionFlavor: "banana", pacing: "instant" }, next);
  assert.equal(rejected.optionFlavor, "dangerous");
  assert.equal(rejected.pacing, "faster");
  // 空提议保持现状。
  assert.deepEqual(clampAdaptation({}, next), next);
});
