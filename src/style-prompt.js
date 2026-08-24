// 文风分析提示词（2026-08-24 抽出共享）：起稿（baker，分析原著）与谋篇
// （plotting，分析作家贴入的范文）共用同一份七维口径——两处必须产出同形
// 的 style 卡，谋篇的「选案头书文风」才能与「贴范文分析」互换。
export const STYLE_ANALYSIS_PROMPT =
  "分析这本小说的写作风格，只返回 JSON，字段为 narration(人称与视角)、tense(时态)、sentence(句长与节奏)、punctuation(标点习惯)、imagery(常见意象数组)、diction(方言或专有词汇数组)、chapterForm(章节体例)、avoid(应当避免的写法数组)。";

export function buildStyleAnalysisMessages(sampleText) {
  return [
    { role: "system", content: STYLE_ANALYSIS_PROMPT },
    { role: "user", content: String(sampleText ?? "") },
  ];
}
