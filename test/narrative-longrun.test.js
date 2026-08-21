import assert from "node:assert/strict";
import test from "node:test";

import { runLongSimulation } from "../scripts/simulate-long.js";

/* 长局叙事回归（第二轮打磨拍板 2026-08-21）：MockLlm 固定种子跑多世长局，
   防三类退化——引擎回合抛错（稳定性）、每回合成本随手数增长（p95 预算）、
   转世链/存档往返断链（跨世延续）。基线：3 世 × 40 手 p95 ≈ 7ms，
   预算放宽到 50ms 只拦数量级级回归，不拦噪声。
   真 API 的人工抽读走 `node scripts/simulate-long.js --live`。 */
test("长局模拟回归：多世零错误、回合时长有界、转世链与存档往返完整", async () => {
  const metrics = await runLongSimulation({ lives: 3, turnsPerLife: 40 });

  assert.deepEqual(metrics.errors, []);
  assert.equal(metrics.completedTurns, 3 * 40, "每世都应打满回合预算");
  assert.equal(metrics.emptyNarratives, 0, "叙事不应出现空段");
  assert.equal(metrics.duplicateNarratives, 0, "相邻回合整段重复=合成回归");
  assert.ok(
    metrics.durationMs.p95 < 50,
    `回合 p95 ${metrics.durationMs.p95}ms 超预算——引擎每回合成本出现退化`,
  );
  assert.equal(metrics.pastLifeFacts, 2, "每次转世写回一条前世事实");
  assert.equal(metrics.savesRoundTripped, 3, "每世的档都要能存能复活");
  assert.equal(metrics.finalLifeIndex, 3, "末世 lifeIndex 随转世递增");
});
