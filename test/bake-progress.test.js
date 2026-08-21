import assert from "node:assert/strict";
import test from "node:test";

import {
  BAKE_STAGE_LABEL,
  bakePercent,
  estimateBakeInputTokens,
  monotonicPercent,
  estimateCoarseEtaSeconds,
} from "../src/bake-progress.js";

test("七个阶段都有文案", () => {
  for (const stage of ["model-reference", "style", "coarse", "detail", "merge", "repair", "complete"]) {
    assert.equal(typeof BAKE_STAGE_LABEL[stage], "string");
  }
});

test("百分比随阶段推进，粗读按批次折算", () => {
  assert.equal(bakePercent(null), 0);
  assert.equal(bakePercent({ stage: "style", current: 1, total: 1 }), 10);
  assert.equal(bakePercent({ stage: "coarse", current: 1, total: 2 }), 35);
  assert.equal(bakePercent({ stage: "coarse", current: 2, total: 2 }), 70);
  assert.equal(bakePercent({ stage: "repair", current: 2, total: 2 }), 96);
  assert.equal(bakePercent({ stage: "complete", current: 1, total: 1 }), 100);
  assert.equal(bakePercent({ stage: "unknown", current: 1, total: 1 }), 0);
});

test("total 为 0 时不产生 NaN", () => {
  assert.equal(bakePercent({ stage: "coarse", current: 0, total: 0 }), 0);
});

test("断点续传让 current 回跳时进度条只许前进", () => {
  const first = monotonicPercent(0, { stage: "coarse", current: 8, total: 10 });
  assert.equal(first, 56);
  assert.equal(monotonicPercent(first, { stage: "coarse", current: 1, total: 10 }), 56);
  assert.equal(monotonicPercent(first, { stage: "detail", current: 1, total: 1 }), 85);
  assert.equal(monotonicPercent(first, null), 0);
});

test("粗读 ETA:样本不足或没有推进时不输出", () => {
  assert.equal(estimateCoarseEtaSeconds(null), null);
  assert.equal(estimateCoarseEtaSeconds([]), null);
  assert.equal(estimateCoarseEtaSeconds([{ current: 1, total: 10, at: 0 }]), null);
  // 只有爬行期(百分比不动)的样本:速率无从谈起。
  assert.equal(
    estimateCoarseEtaSeconds([
      { current: 1, total: 10, at: 0 },
      { current: 1, total: 10, at: 60_000 },
    ]),
    null,
  );
});

test("粗读 ETA:按最近样本的批次速率外推剩余时间", () => {
  // 每分钟完成 1 批,剩 8 批 → 8 分钟。
  const eta = estimateCoarseEtaSeconds([
    { current: 1, total: 10, at: 0 },
    { current: 2, total: 10, at: 60_000 },
  ]);
  assert.equal(eta, 480);
});

test("粗读 ETA:回跳样本被忽略,已到末尾返回 0", () => {
  // 断点续烧的回跳(current 变小)不参与速率。
  const eta = estimateCoarseEtaSeconds([
    { current: 5, total: 10, at: 0 },
    { current: 3, total: 10, at: 30_000 },
    { current: 6, total: 10, at: 60_000 },
  ]);
  // 只取 5 → 6 一段:1 批/60s,剩 4 批 → 240s。
  assert.equal(eta, 240);
  // 已到末尾。
  assert.equal(
    estimateCoarseEtaSeconds([
      { current: 9, total: 10, at: 0 },
      { current: 10, total: 10, at: 60_000 },
    ]),
    0,
  );
});

test("粗读 ETA:非法输入不产生 NaN", () => {
  assert.equal(
    estimateCoarseEtaSeconds([
      { current: NaN, total: 10, at: 0 },
      { current: 2, total: 10, at: 60_000 },
    ]),
    null,
  );
  assert.equal(
    estimateCoarseEtaSeconds([
      { current: 1, total: 0, at: 0 },
      { current: 2, total: 0, at: 60_000 },
    ]),
    null,
  );
});

test("对照模型认知阶段:标签、百分比与单调性", () => {
  assert.equal(BAKE_STAGE_LABEL["model-reference"], "对照模型认知");
  const probe = bakePercent({ stage: "model-reference", current: 1, total: 2 });
  const extracted = bakePercent({ stage: "model-reference", current: 2, total: 2 });
  assert.ok(probe >= 1 && extracted <= 4, "探针/提取折算在 1-4 区间");
  assert.ok(extracted < bakePercent({ stage: "style", current: 1, total: 1 }), "早于文风阶段");
});

test("烧制输入 token 预估:字数×0.7 + 固定开销", () => {
  // 300 万字的长书:粗读全书为主。
  assert.equal(estimateBakeInputTokens(3_000_000), Math.round(3_000_000 * 0.7 + 250_000));
  // 小书也有固定开销(五片/精读/探针)。
  assert.equal(estimateBakeInputTokens(0), 250_000);
  // 非法输入按 0 字处理,不抛错。
  assert.equal(estimateBakeInputTokens(null), 250_000);
  assert.equal(estimateBakeInputTokens("abc"), 250_000);
});
