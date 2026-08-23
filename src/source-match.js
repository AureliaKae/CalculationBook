// 补挂原文的守门人：拿用户自己导入的原文章节，对照世界档案自带的章节目录，
// 判断「这是不是同一本书」。纯函数、零依赖，测试在 test/source-match.test.js。
//
// 判定分三档：
//   match    —— 章数相同且标题几乎全对上：同一版本，直接放行。
//   loose    —— 章数接近（±max(3, 2%)）且六成以上标题对上：多半是不同版本/
//               不同切章（校对版、出版社差异），放行但确认框要警示。
//   mismatch —— 其余一律拒绝：宁可不挂，不能把别的书挂进这个世界。

// 标题归一：去全部空白（含全角空格）、转小写。标点保留——「第一章：x」与
// 「第一章 x」算不同写法，交给互含判定兜。
export function normalizeChapterTitle(value) {
  return String(value ?? "")
    .replace(/[\s\u3000]+/g, "")
    .toLowerCase();
}

// 互含匹配：不同版本常在章名上追加后缀（「（校对）」「·精校版」）。双方都
// 归一后仍不相等时，若一方包含另一方则视为同一个章。单字符标题不参与互含
// ——「一」会包含进一切，只会制造假阳性。
function titleEquivalent(left, right) {
  if (!left || !right) return false;
  if (left === right) return true;
  if (left.length < 2 || right.length < 2) return false;
  return left.includes(right) || right.includes(left);
}

export function matchSourceToIndex({ chapters = [], chapterIndex = [] } = {}) {
  const indexTitles = chapterIndex.map((entry) => normalizeChapterTitle(entry?.title));
  const parsedTitles = chapters.map((chapter) => normalizeChapterTitle(chapter?.title));
  const countIndex = indexTitles.length;
  const countParsed = parsedTitles.length;

  let matched = 0;
  for (const title of indexTitles) {
    if (parsedTitles.some((parsed) => titleEquivalent(title, parsed))) matched += 1;
  }
  const ratio = countIndex ? matched / countIndex : 0;
  const countDelta = Math.abs(countParsed - countIndex);

  let verdict = "mismatch";
  if (countIndex > 0 && countParsed > 0) {
    const tolerance = Math.max(3, Math.round(countIndex * 0.02));
    if (countParsed === countIndex && ratio >= 0.95) verdict = "match";
    else if (countDelta <= tolerance && ratio >= 0.6) verdict = "loose";
  }
  return { countIndex, countParsed, matched, ratio, countDelta, verdict };
}
