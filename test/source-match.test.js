import assert from "node:assert/strict";
import test from "node:test";

import { matchSourceToIndex, normalizeChapterTitle } from "../src/source-match.js";

const index = (titles) => titles.map((title, i) => ({ index: i + 1, title }));
const chapters = (titles) => titles.map((title, i) => ({ index: i + 1, title, text: "正文" }));

test("normalizeChapterTitle：去空白、转小写，标点保留", () => {
  assert.equal(normalizeChapterTitle(" 第 一章　封港之夜 "), "第一章封港之夜");
  assert.equal(normalizeChapterTitle(""), "");
  assert.equal(normalizeChapterTitle(null), "");
});

test("同一版本：章数相同、标题全对上 → match", () => {
  const titles = ["第一章 起风", "第二章 黑铃", "第三章 退潮"];
  const result = matchSourceToIndex({ chapters: chapters(titles), chapterIndex: index(titles) });
  assert.equal(result.verdict, "match");
  assert.equal(result.matched, 3);
  assert.equal(result.ratio, 1);
});

test("空白与全角空格差异、版本后缀互含都算对上", () => {
  const result = matchSourceToIndex({
    chapters: chapters(["第一章 起风（精校版）", "第二章 黑 铃", "第三章 退潮"]),
    chapterIndex: index(["第一章 起风", "第二章 黑铃", "第三章 退潮"]),
  });
  assert.equal(result.verdict, "match");
  assert.equal(result.matched, 3, "互含与归一把版本差异吃掉");
});

test("不同版本：章数略差、六成以上对上 → loose", () => {
  const archive = index(Array.from({ length: 100 }, (_, i) => `第${i + 1}章 事${i + 1}`));
  // 拆章差异：多出 1 章，且后 30 章标题改写（重排卷别）。
  const mine = chapters(
    Array.from({ length: 101 }, (_, i) =>
      i < 70 ? `第${i + 1}章 事${i + 1}` : `卷二·${i + 1}`,
    ),
  );
  const result = matchSourceToIndex({ chapters: mine, chapterIndex: archive });
  assert.equal(result.verdict, "loose");
  assert.equal(result.matched, 70);
});

test("不是同一本书：章数差得多或标题对不上 → mismatch", () => {
  const archive = index(Array.from({ length: 100 }, (_, i) => `第${i + 1}章 甲`));
  const stranger = chapters(Array.from({ length: 100 }, (_, i) => `第${i + 1}章 乙${i}`));
  assert.equal(
    matchSourceToIndex({ chapters: stranger, chapterIndex: archive }).verdict,
    "mismatch",
    "章数相同但标题全对不上",
  );
  const stub = chapters(Array.from({ length: 3 }, (_, i) => `第${i + 1}章 甲`));
  assert.equal(
    matchSourceToIndex({ chapters: stub, chapterIndex: archive }).verdict,
    "mismatch",
    "节选残本（章数远少于档案）拒绝",
  );
});

test("单字标题不参与互含：避免「一」包含一切的假阳性", () => {
  const result = matchSourceToIndex({
    chapters: chapters(["一", "无关", "无关"]),
    chapterIndex: index(["一", "二", "三"]),
  });
  assert.equal(result.matched, 1, "只有精确相等的「一」算对上");
});

test("空输入按 mismatch 处理，不抛错", () => {
  assert.equal(matchSourceToIndex({ chapters: [], chapterIndex: index(["一"]) }).verdict, "mismatch");
  assert.equal(matchSourceToIndex({ chapters: chapters(["一"]), chapterIndex: [] }).verdict, "mismatch");
  assert.equal(matchSourceToIndex({}).verdict, "mismatch");
});
