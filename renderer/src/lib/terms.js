// 引擎侧用户可见文案仍用旧词：renderer 在状态出口统一映射到推演书词表。
// 只留仍有活输入的映射（清理轮 2026-08-21：装裱族/舆图/合卷/收卷/卷宗
// 的输入源已随对应功能移除，全库零出现）。
const TERM_MAP = [
  ["烧制", "起稿"],
  ["重烧", "重起稿"],
  ["书架", "案头"],
];

export function mapTerms(text) {
  let mapped = String(text ?? "");
  for (const [from, to] of TERM_MAP) {
    mapped = mapped.split(from).join(to);
  }
  return mapped;
}
