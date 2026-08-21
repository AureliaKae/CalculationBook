import assert from "node:assert/strict";
import test from "node:test";

import { cleanChapterText, cleanChapterTitle, parseNovel, splitChapters } from "../src/novel-import.js";

test("盗版水印与广告行被清理,对话与正文不动", async () => {
  const text = [
    "更多精彩小说尽在www.23us.com",
    "第一章 风起",
    "笔趣阁",
    "本章未完，请点击下一页继续阅读",
    "他推开门，说：“最新章节是什么？我不看。”",
    "请记住本站网址：www.biquge.com",
    "风从海上来。",
    "如果您喜欢这部作品，欢迎您来起点投推荐票、月票",
    "第二章 云涌（求收藏）",
    "求推荐求月票",
    "雨落了下来。",
    "网址是www.qq.com，你记一下。",
  ].join("\n");
  const novel = await parseNovel({ name: "风起.txt", buffer: Buffer.from(text, "utf8") });
  assert.equal(novel.cleanedLines, 6, "6 行噪声被清理");
  const first = novel.chapters.find((chapter) => chapter.title === "第一章 风起");
  assert.ok(first.text.includes("他推开门，说：“最新章节是什么？我不看。”"), "对话里的网站词不误删");
  assert.ok(first.text.includes("风从海上来。"), "正文保留");
  assert.ok(!first.text.includes("笔趣阁"), "站名水印行删除");
  assert.ok(!first.text.includes("点击下一页"), "阅读器提示行删除");
  assert.ok(!first.text.includes("23us.com"), "网址行删除");
  assert.ok(!first.text.includes("投推荐票"), "带句读的推广页脚删除");
  const second = novel.chapters.find((chapter) => chapter.title === "第二章 云涌");
  assert.ok(second, "标题括号拉票后缀被剥掉");
  assert.ok(second.text.includes("雨落了下来。"), "正文保留");
  assert.ok(second.text.includes("网址是www.qq.com，你记一下。"), "对话中的网址不误删");
  assert.ok(!second.text.includes("求推荐求月票"), "口号行删除");
});

test("恰为站名的行删除,引号内的站名保留", () => {
  const cleaned = cleanChapterText([
    "笔趣阁",
    "他说「笔趣阁」不错。",
    "　顶点小说　",
  ].join("\n"));
  assert.equal(cleaned.removed, 2);
  assert.ok(cleaned.text.includes("他说「笔趣阁」不错。"));
});

test("章节标题清洗:拉票/加更后缀剥掉,分部标记保留", () => {
  assert.equal(cleanChapterTitle("第12章 出发（求收藏）"), "第12章 出发");
  assert.equal(cleanChapterTitle("第13章 归来【第一更】"), "第13章 归来");
  assert.equal(cleanChapterTitle("第14章 夜行 求推荐"), "第14章 夜行");
  assert.equal(cleanChapterTitle("第15章 相见（上）"), "第15章 相见（上）");
  assert.equal(cleanChapterTitle("第16章 别离（一）"), "第16章 别离（一）");
});

test("整章都是噪声时该章被剔除并重排索引", async () => {
  const text = ["第一章 甲", "笔趣阁", "请记住本站网址：www.biquge.com", "第二章 乙", "正文内容"].join("\n");
  const novel = await parseNovel({ name: "书.txt", buffer: Buffer.from(text, "utf8") });
  assert.equal(novel.chapters.length, 1, "只剩一章正文");
  assert.equal(novel.chapters[0].title, "第二章 乙");
  assert.equal(novel.chapters[0].index, 1, "索引重排");
});

test("无章节短篇不因清洗丢内容", async () => {
  const novel = await parseNovel({ name: "短.txt", buffer: Buffer.from("这是一段普通的正文。\n第二段。") });
  assert.equal(novel.chapters.length, 1);
  assert.ok(novel.chapters[0].text.includes("这是一段普通的正文。"));
  assert.equal(novel.cleanedLines, 0);
});

test("splitChapters 兼容原签名且标题经过清洗", () => {
  const chapters = splitChapters("第一章 出发（求收藏）\n正文。\n第二章 归来（上）\n又一段。");
  assert.equal(chapters[0].title, "第一章 出发");
  assert.equal(chapters[1].title, "第二章 归来（上）");
});

test("以虚词/方位词收尾的真实章节标题不再被误并章", async () => {
  // 「第十章 上」「第十二章 南下」「第十章 城中」都是常见标题写法;
  // 旧启发式按末字助词否决,两章被静默并成一章,章节锚点整体偏移。
  const text = [
    "第九章 夜航",
    "正文甲。",
    "第十章 上",
    "正文乙。",
    "第十章 下",
    "正文丙。",
    "第十一章 南下",
    "正文丁。",
    "第十二章 城中",
    "正文戊。",
    "第十三章 归来",
    "正文己。",
  ].join("\n");
  const novel = await parseNovel({ name: "五章.txt", buffer: Buffer.from(text, "utf8") });
  assert.equal(novel.chapters.length, 6, "六个标题切成六章");
  assert.deepEqual(
    novel.chapters.map((chapter) => chapter.title),
    ["第九章 夜航", "第十章 上", "第十章 下", "第十一章 南下", "第十二章 城中", "第十三章 归来"],
  );
});

test("带句读的正文整行仍不切成章节", async () => {
  const text = [
    "第一章 起",
    "他说：第一章里的秘密，他知道。",
    "第二章 承",
    "正文。",
  ].join("\n");
  const novel = await parseNovel({ name: "两句.txt", buffer: Buffer.from(text, "utf8") });
  assert.equal(novel.chapters.length, 2, "句读行是正文,不切章");
  assert.ok(novel.chapters[0].text.includes("第一章里的秘密"));
});

test("EPUB 实体解码:命名与数字实体的引号还原成字符", async () => {
  const { parseEpub } = await import("../src/novel-import.js");
  // 构造最小 EPUB:container + OPF + 一章 XHTML,对白引号用 &quot; 与 &#x201C;。
  const jszip = (await import("jszip")).default;
  const zip = new jszip();
  zip.file("mimetype", "application/epub+zip");
  zip.file(
    "META-INF/container.xml",
    '<?xml version="1.0"?><container><rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles></container>',
  );
  zip.file(
    "OEBPS/content.opf",
    '<?xml version="1.0"?><package xmlns:dc="http://purl.org/dc/elements/1.1/"><metadata><dc:title>引号书</dc:title></metadata><manifest><item id="c1" href="c1.xhtml" media-type="application/xhtml+xml"/></manifest><spine><itemref idref="c1"/></spine></package>',
  );
  zip.file(
    "OEBPS/c1.xhtml",
    "<html><body><p>&quot;谁在那里&#xFF1F;&quot;他问&#65306;</p></body></html>",
  );
  const parsed = await parseEpub(await zip.generateAsync({ type: "nodebuffer" }), "引号书");
  const body = parsed.chapters[0].text;
  assert.ok(body.includes('"谁在那里'), "命名实体 &quot; 还原为引号");
  assert.ok(body.includes("？"), "十六进制数字实体还原");
  assert.ok(body.includes("："), "十进制数字实体还原");
});
