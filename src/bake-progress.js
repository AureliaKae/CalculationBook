export const BAKE_STAGE_LABEL = {
  "model-reference": "对照模型认知",
  style: "正在临摹原著笔法",
  coarse: "正在通读全书",
  detail: "正在精读切入章节",
  merge: "正在合并世界档案",
  repair: "正在校正世界档案",
  complete: "世界已经烧制完成",
};

// 烧制输入 token 预估(粗略但诚实):中文约每字 0.7 token,粗读=通读全书一遍;
// 五片/精读/探针/修复折成固定项。只算输入——摘要与世界片输出占比小。
// 主进程与导入页共用,烧前给用户一个决策参考(比如先烧短书验证)。
export function estimateBakeInputTokens(characterCount) {
  const chars = Math.max(0, Number(characterCount) || 0);
  return Math.round(chars * 0.7 + 250_000);
}

// 五个阶段的耗时差距很大，粗读占了绝大部分，所以按经验权重折算成一条百分比。
export function bakePercent(progress) {
  if (!progress) return 0;
  const ratio = progress.total ? progress.current / progress.total : 0;
  switch (progress.stage) {
    case "model-reference":
      // 探针+提取都在文风临摹之前,占比很小;按 current/total 细分到 1-4。
      return Math.min(4, 1 + ratio * 3);
    case "style":
      return 10;
    case "coarse":
      return ratio * 70;
    case "detail":
      return 85;
    case "merge":
      return 86;
    case "repair":
      return 88 + ratio * 8;
    case "complete":
      return 100;
    default:
      return 0;
  }
}

// 断点续传会让 current 回跳，进度条只许前进。
export function monotonicPercent(previous, progress) {
  if (!progress) return 0;
  return Math.max(previous ?? 0, bakePercent(progress));
}

// 按粗读批次完成速率外推剩余秒数。
// samples 是 [{ current, total, at }]（at 为毫秒时间戳）；只取 current 严格递增的样本，
// 断点续烧的回跳与静默爬行期不参与速率计算。样本不足、没有推进或已到末尾时返回 null。
export function estimateCoarseEtaSeconds(samples) {
  if (!Array.isArray(samples)) return null;
  const rising = [];
  for (const sample of samples) {
    const current = Number(sample?.current);
    const total = Number(sample?.total);
    if (!Number.isFinite(current) || !Number.isFinite(total) || total <= 0) continue;
    if (rising.length && current <= rising.at(-1).current) continue;
    rising.push({ current, total, at: Number(sample?.at) });
  }
  if (rising.length < 2) return null;
  const first = rising[0];
  const last = rising.at(-1);
  const elapsed = (last.at - first.at) / 1000;
  const gained = last.current - first.current;
  if (elapsed <= 0 || gained <= 0) return null;
  const remaining = last.total - last.current;
  if (remaining <= 0) return 0;
  const eta = (remaining / gained) * elapsed;
  if (!Number.isFinite(eta)) return null;
  return Math.max(1, Math.round(eta));
}
