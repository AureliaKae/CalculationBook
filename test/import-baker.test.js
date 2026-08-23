import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import JSZip from "jszip";

import { digestCoarse, novelCachePrefix, NovelBaker, STAGE_VERSION } from "../src/baker.js";
import { parseNovel, splitChapters } from "../src/novel-import.js";

test("TXT importer splits Chinese chapter headings", async () => {
  const text = "前言内容\n第1章 起风\n码头起雾。\n第二章 黑铃\n铃声响起。";
  const novel = await parseNovel({ name: "灰港.txt", buffer: Buffer.from(text) });
  assert.equal(novel.title, "灰港");
  assert.equal(novel.chapters.length, 3);
  assert.equal(splitChapters("无章节短篇")[0].text, "无章节短篇");
});

test("EPUB importer follows OPF spine order", async () => {
  const zip = new JSZip();
  zip.file("META-INF/container.xml", '<rootfile full-path="OEBPS/book.opf"/>');
  zip.file(
    "OEBPS/book.opf",
    '<package><metadata><dc:title>雾书</dc:title></metadata><manifest><item id="c1" href="1.xhtml"/><item id="c2" href="2.xhtml"/></manifest><spine><itemref idref="c2"/><itemref idref="c1"/></spine></package>',
  );
  zip.file("OEBPS/1.xhtml", "<h1>第一章</h1><p>第一段</p>");
  zip.file("OEBPS/2.xhtml", "<h1>第二章</h1><p>第二段</p>");
  const buffer = await zip.generateAsync({ type: "nodebuffer" });
  const novel = await parseNovel({ name: "book.epub", buffer });
  assert.equal(novel.title, "雾书");
  assert.match(novel.chapters[0].text, /第二章/);
});

test("EPUB importer tolerates malformed percent escapes in hrefs", async () => {
  const zip = new JSZip();
  zip.file("META-INF/container.xml", '<rootfile full-path="OEBPS/book.opf"/>');
  zip.file(
    "OEBPS/book.opf",
    '<package><metadata><dc:title>怪书</dc:title></metadata><manifest><item id="c1" href="100%2.xhtml"/></manifest><spine><itemref idref="c1"/></spine></package>',
  );
  // 文件按字面路径存储（href 里的 %2 不是合法转义，decodeURI 会抛 URIError）。
  zip.file("OEBPS/100%2.xhtml", "<h1>第一章</h1><p>内容</p>");
  const buffer = await zip.generateAsync({ type: "nodebuffer" });
  const novel = await parseNovel({ name: "book.epub", buffer });
  assert.equal(novel.chapters.length, 1);
});

test("TXT importer ignores body sentences that look like chapter headings", async () => {
  const text = "第一章结束时他看向窗外，风还在吹。\n后面的正文继续。";
  const novel = await parseNovel({ name: "正文.txt", buffer: Buffer.from(text) });
  assert.equal(novel.chapters.length, 1, "以「第X章」开头的正文句不应被切成章节");
  // 真标题不受影响。
  const withTitle = await parseNovel({
    name: "标题.txt",
    buffer: Buffer.from("第一章 起风\n码头起雾。"),
  });
  assert.equal(withTitle.chapters.length, 1);
  assert.match(withTitle.chapters[0].title, /起风/);
});

test("EPUB importer handles attribute order and ../ relative hrefs", async () => {
  const zip = new JSZip();
  zip.file("META-INF/container.xml", '<rootfile full-path="OEBPS/book.opf"/>');
  // href 在 id 之前（合法但旧正则匹配不到），且 OPF 指向 ../Text/ 下的文件。
  zip.file(
    "OEBPS/book.opf",
    '<package><metadata><dc:title>雾书</dc:title></metadata><manifest><item href="../Text/1.xhtml" id="c1"/><item href="../Text/2.xhtml" id="c2"/></manifest><spine><itemref idref="c1"/><itemref idref="c2"/></spine></package>',
  );
  zip.file("Text/1.xhtml", "<h1>第一章</h1><p>第一段</p>");
  zip.file("Text/2.xhtml", "<h1>第二章</h1><p>第二段</p>");
  const buffer = await zip.generateAsync({ type: "nodebuffer" });
  const novel = await parseNovel({ name: "book.epub", buffer });
  assert.equal(novel.chapters.length, 2);
  assert.match(novel.chapters[1].text, /第二章/);
  assert.deepEqual(novel.warnings, []);
});

test("EPUB importer reports dropped chapters as warnings", async () => {
  const zip = new JSZip();
  zip.file("META-INF/container.xml", '<rootfile full-path="OEBPS/book.opf"/>');
  zip.file(
    "OEBPS/book.opf",
    '<package><metadata><dc:title>缺章</dc:title></metadata><manifest><item id="c1" href="1.xhtml"/><item id="ghost" href="missing.xhtml"/></manifest><spine><itemref idref="c1"/><itemref idref="ghost"/></spine></package>',
  );
  zip.file("OEBPS/1.xhtml", "<h1>第一章</h1><p>第一段</p>");
  const buffer = await zip.generateAsync({ type: "nodebuffer" });
  const novel = await parseNovel({ name: "book.epub", buffer });
  assert.equal(novel.chapters.length, 1);
  assert.ok(Array.isArray(novel.warnings) && novel.warnings.length > 0);
  assert.ok(novel.warnings.some((warning) => warning.includes("2 章") || warning.includes("missing")));
});

test("EPUB importer rejects zip bombs by projected decompressed size", async () => {
  const zip = new JSZip();
  zip.file("META-INF/container.xml", '<rootfile full-path="OEBPS/book.opf"/>');
  zip.file(
    "OEBPS/book.opf",
    '<package><metadata><dc:title>炸弹</dc:title></metadata><manifest><item id="c1" href="big.txt"/></manifest><spine><itemref idref="c1"/></spine></package>',
  );
  zip.file("OEBPS/big.txt", "a".repeat(21_000_000));
  const buffer = await zip.generateAsync({ type: "nodebuffer" });
  await assert.rejects(() => parseNovel({ name: "book.epub", buffer }), /超过上限|压缩炸弹/);
});

test("two-pass baker caches completed world", async () => {
  const cacheDirectory = await mkdtemp(join(tmpdir(), "evolution-bake-"));
  let calls = 0;
  const completeJson = async (messages) => {
    calls += 1;
    const prompt = messages[0].content;
    if (prompt.includes("写作风格")) return { narration: "第三人称限知" };
    if (prompt.includes("世界骨架") || prompt.includes("人物与身份") || prompt.includes("世界补全")) {
      return {
        id: "mist",
        title: "雾书",
        summary: "港口求生",
        characters: [{ id: "p", name: "旅人" }],
        locations: ["码头"],
        attributes: [{ id: "will", name: "意志", initial: 30 }],
        stats: [{ id: "life", name: "生命", role: "vital", min: 0, max: 10, initial: 10, zeroConsequence: "昏迷" }],
        roleTemplates: [
          { id: "r1", name: "甲", description: "身份甲", locationIds: [], factionIds: [] },
          { id: "r2", name: "乙", description: "身份乙", locationIds: [], factionIds: [] },
          { id: "r3", name: "丙", description: "身份丙", locationIds: [], factionIds: [] },
        ],
        timeline: [],
        facts: [],
      };
    }
      return { extracted: true };
  };
  const baker = new NovelBaker({ cacheDirectory, completeJson, batchCharacters: 5 });
  const novel = {
    title: "雾书",
    format: "txt",
    chapters: [
      { index: 1, title: "一", text: "12345" },
      { index: 2, title: "二", text: "67890" },
    ],
  };
  const first = await baker.bake(novel);
  const count = calls;
  const second = await baker.bake(novel);
  assert.deepEqual(second, first);
  assert.equal(calls, count);
  assert.equal(first.initialState.stats.life, 10);
  assert.equal(first.world.style.narration, "第三人称限知");
});

test("baker caches each focus chapter independently", async () => {
  const cacheDirectory = await mkdtemp(join(tmpdir(), "evolution-focus-"));
  let calls = 0;
  const completeJson = async (messages) => {
    calls += 1;
    if (messages[0].content.includes("世界骨架") || messages[0].content.includes("人物与身份") || messages[0].content.includes("世界补全")) {
      return {
        id: `world-${calls}`,
        title: "书",
        summary: "摘要",
        characters: [],
        locations: ["起点"],
        attributes: [{ id: "will", name: "意志", initial: 30 }],
        stats: [{ id: "life", name: "生命", role: "vital", min: 0, max: 10, initial: 10, zeroConsequence: "昏迷" }],
        roleTemplates: [
          { id: "r1", name: "甲", description: "身份甲", locationIds: [], factionIds: [] },
          { id: "r2", name: "乙", description: "身份乙", locationIds: [], factionIds: [] },
          { id: "r3", name: "丙", description: "身份丙", locationIds: [], factionIds: [] },
        ],
        timeline: [],
        facts: [],
      };
    }
    return {};
  };
  const baker = new NovelBaker({ cacheDirectory, completeJson });
  const novel = {
    title: "书",
    format: "txt",
    chapters: [
      { index: 1, title: "一", text: "甲" },
      { index: 2, title: "二", text: "乙" },
    ],
  };
  const first = await baker.bake(novel, { focusChapter: 1 });
  const second = await baker.bake(novel, { focusChapter: 2 });
  assert.notEqual(first.world.id, second.world.id);
});

test("entry re-bake reuses coarse reads and reapplies openAll on cached results", async () => {
  const cacheDirectory = await mkdtemp(join(tmpdir(), "bake-entry-"));
  let styleCalls = 0;
  let coarseCalls = 0;
  let mergeCalls = 0;
  const roles = [
    { id: "r1", name: "甲", description: "身份甲", locationIds: [], factionIds: [] },
    { id: "r2", name: "乙", description: "身份乙", locationIds: [], factionIds: [] },
    { id: "r3", name: "丙", description: "身份丙", locationIds: [], factionIds: [] },
  ];
  const skeleton = {
    id: "entry-world",
    title: "雾书",
    summary: "港口求生",
    characters: [],
    locations: [{ id: "matou", name: "码头", connections: [] }],
    attributes: [{ id: "will", name: "意志", initial: 30 }],
    stats: [{ id: "life", name: "生命", role: "vital", min: 0, max: 10, initial: 10, zeroConsequence: "昏迷" }],
    roleTemplates: [],
    timeline: [],
    facts: [],
  };
  const completeJson = async (messages) => {
    const prompt = messages[0].content;
    if (prompt.includes("写作风格")) {
      styleCalls += 1;
      return { narration: "第三人称限知" };
    }
    if (prompt.includes("提取小说片段中的角色")) {
      coarseCalls += 1;
      return { extracted: true };
    }
    // 人物片优先于骨架片判断(提示词含「在给定世界骨架上」)。
    if (prompt.includes("人物与身份")) {
      mergeCalls += 1;
      return { characters: [], factions: [], roleProgression: [], roleTemplates: roles };
    }
    if (prompt.includes("世界骨架")) {
      mergeCalls += 1;
      return skeleton;
    }
    return { extracted: true };
  };
  const baker = new NovelBaker({ cacheDirectory, completeJson });
  const novel = {
    title: "雾书",
    format: "txt",
    chapters: [
      { index: 1, title: "一", text: "12345" },
      { index: 2, title: "二", text: "67890" },
    ],
  };
  const first = await baker.bake(novel, { focusChapter: 1, openAll: false });
  assert.deepEqual(first.world.creationScope, { focusChapter: 1, openAll: false });
  const styleAfter = styleCalls;
  const coarseAfter = coarseCalls;

  // 换切入章:文风与粗读复用,只重跑精读+五片。
  const second = await baker.bake(novel, { focusChapter: 2, openAll: true });
  assert.equal(styleCalls, styleAfter, "换切入章不重烧文风");
  assert.equal(coarseCalls, coarseAfter, "换切入章不重读全书");
  assert.deepEqual(second.world.creationScope, { focusChapter: 2, openAll: true });

  // 同切入章再次请求命中完整缓存:不跑任何生成,但 openAll 按本次请求重写。
  const mergeAfter = mergeCalls;
  const third = await baker.bake(novel, { focusChapter: 2, openAll: false });
  assert.equal(mergeCalls, mergeAfter, "完整缓存命中不再生成");
  assert.deepEqual(third.world.creationScope, { focusChapter: 2, openAll: false });
});

test("bake runs catalog coherence QC and applies removes", async () => {
  const cacheDirectory = await mkdtemp(join(tmpdir(), "bake-coherence-"));
  const dimItems = (dim, dupId, dupName) => [
    { id: dupId, name: dupName, description: "x", pole: "high", weight: 1, goodSide: "好", badSide: "坏" },
    ...Array.from({ length: 5 }, (_, index) => ({
      id: `${dim}${index}`,
      name: `${dim}选项${index}`,
      description: "x",
      pole: index % 2 ? "low" : "high",
      weight: 1,
      goodSide: "好",
      badSide: "坏",
    })),
  ];
  const completeJson = async (messages) => {
    const prompt = messages[0].content;
    if (prompt.includes("写作风格")) return { narration: "第三人称限知" };
    // 质检分支必须先于「创角目录」(质检提示词里也含「创角目录」字样)。
    if (prompt.includes("质检器")) {
      return { removeIds: ["p-dup"] };
    }
    if (prompt.includes("创角目录")) {
      return {
        creationCatalog: {
          bigFive: {
            openness: dimItems("o", "p-dup", "果敢"),
            conscientiousness: dimItems("c"),
            extraversion: dimItems("e"),
            agreeableness: dimItems("a"),
            neuroticism: dimItems("n"),
          },
          motivations: Array.from({ length: 6 }, (_, index) => ({ id: `m${index}`, name: `动机${index}`, description: "x" })),
        },
      };
    }
    if (prompt.includes("人物与身份")) {
      return {
        characters: [],
        factions: [],
        roleProgression: [],
        roleTemplates: [
          { id: "r1", name: "甲", description: "身份甲", locationIds: [], factionIds: [] },
          { id: "r2", name: "乙", description: "身份乙", locationIds: [], factionIds: [] },
          { id: "r3", name: "丙", description: "身份丙", locationIds: [], factionIds: [] },
        ],
      };
    }
    if (prompt.includes("世界骨架")) {
      return {
        id: "coherence-world",
        title: "雾书",
        summary: "港口求生",
        characters: [],
        locations: [{ id: "matou", name: "码头", connections: [] }],
        attributes: [{ id: "will", name: "意志", initial: 30 }],
        stats: [{ id: "life", name: "生命", role: "vital", min: 0, max: 10, initial: 10, zeroConsequence: "昏迷" }],
        roleTemplates: [],
        timeline: [],
        facts: [],
      };
    }
    return { extracted: true };
  };
  const baker = new NovelBaker({ cacheDirectory, completeJson });
  const novel = {
    title: "雾书",
    format: "txt",
    chapters: [{ index: 1, title: "一", text: "12345" }],
  };
  const result = await baker.bake(novel);
  const openness = result.world.creationCatalog.bigFive.openness;
  assert.ok(!openness.some((item) => item.id === "p-dup"), "质检删除的近义重复词条不再出现");
  assert.ok(openness.length >= 2, "每维至少保留两端选项");
  assert.ok(openness.some((item) => item.pole === "high") && openness.some((item) => item.pole === "low"), "两端都要在");
  for (const dim of ["conscientiousness", "extraversion", "agreeableness", "neuroticism"]) {
    assert.ok(result.world.creationCatalog.bigFive[dim].length >= 2, `${dim} 维度选项保留`);
  }
});

test("baked timeline events keep their fact changes", async () => {
  const cacheDirectory = await mkdtemp(join(tmpdir(), "bake-timeline-facts-"));
  const completeJson = async (messages) => {
    const prompt = messages[0].content;
    if (prompt.includes("写作风格")) return { narration: "第三人称限知" };
    // 时间线片先于骨架判断(提示词含「在给定世界档案上」)。
    if (prompt.includes("时间线")) {
      return {
        timeline: [
          {
            id: "ev-destroy",
            time: 5000,
            text: "黄枫谷被灭门",
            chapterAnchor: 2,
            locationId: "matou",
            prerequisites: [],
            invalidatedBy: [],
            resolution: "world_time",
            resolutionTargetIds: [],
            factsToInvalidate: ["f-old"],
            factsToAdd: [{ id: "f-new", text: "黄枫谷已成废墟", chapterAnchor: 2 }],
          },
        ],
        facts: [
          { id: "f-old", text: "黄枫谷为越国大派", chapterAnchor: 1 },
        ],
      };
    }
    if (prompt.includes("人物与身份")) {
      return {
        characters: [],
        factions: [],
        roleProgression: [],
        roleTemplates: [
          { id: "r1", name: "甲", description: "身份甲", locationIds: [], factionIds: [] },
          { id: "r2", name: "乙", description: "身份乙", locationIds: [], factionIds: [] },
          { id: "r3", name: "丙", description: "身份丙", locationIds: [], factionIds: [] },
        ],
      };
    }
    if (prompt.includes("世界骨架")) {
      return {
        id: "timeline-world",
        title: "雾书",
        summary: "港口求生",
        characters: [],
        locations: [{ id: "matou", name: "码头", connections: [] }],
        attributes: [{ id: "will", name: "意志", initial: 30 }],
        stats: [{ id: "life", name: "生命", role: "vital", min: 0, max: 10, initial: 10, zeroConsequence: "昏迷" }],
        roleTemplates: [],
        timeline: [],
        facts: [],
      };
    }
    return { extracted: true };
  };
  const baker = new NovelBaker({ cacheDirectory, completeJson });
  const novel = {
    title: "雾书",
    format: "txt",
    chapters: [{ index: 1, title: "一", text: "12345" }],
  };
  const result = await baker.bake(novel);
  const event = result.world.timeline.find((item) => item.id === "ev-destroy");
  assert.ok(event, "事件应保留");
  assert.deepEqual(event.factsToInvalidate, ["f-old"]);
  assert.deepEqual(event.factsToAdd, [{ id: "f-new", text: "黄枫谷已成废墟", chapterAnchor: 2 }]);
});

test("baker clamps an out-of-range focus chapter to the book edges", async () => {  const cacheDirectory = await mkdtemp(join(tmpdir(), "evolution-focus-clamp-"));
  let detailPayload;
  const completeJson = async (messages) => {
    const prompt = messages[0].content;
    if (prompt.includes("精读切入点附近章节")) {
      detailPayload = JSON.parse(messages[1].content);
    }
    if (prompt.includes("世界骨架") || prompt.includes("人物与身份") || prompt.includes("世界补全")) {
      return {
        id: "world-clamp",
        title: "书",
        summary: "摘要",
        characters: [],
        locations: ["起点"],
        attributes: [{ id: "will", name: "意志", initial: 30 }],
        stats: [{ id: "life", name: "生命", role: "vital", min: 0, max: 10, initial: 10, zeroConsequence: "昏迷" }],
        roleTemplates: [
          { id: "r1", name: "甲", description: "身份甲", locationIds: [], factionIds: [] },
          { id: "r2", name: "乙", description: "身份乙", locationIds: [], factionIds: [] },
          { id: "r3", name: "丙", description: "身份丙", locationIds: [], factionIds: [] },
        ],
        timeline: [],
        facts: [],
      };
    }
    return {};
  };
  const baker = new NovelBaker({ cacheDirectory, completeJson });
  const novel = {
    title: "书",
    format: "txt",
    chapters: [
      { index: 1, title: "一", text: "甲" },
      { index: 2, title: "二", text: "乙" },
    ],
  };
  await baker.bake(novel, { focusChapter: 99 });
  // 越界章节被收拢到最后一章，精读请求拿到的不是空数组。
  assert.ok(Array.isArray(detailPayload));
  assert.ok(detailPayload.length > 0);
});

test("baker limits coarse concurrency and reuses novel-level work across focus chapters", async () => {
  const cacheDirectory = await mkdtemp(join(tmpdir(), "evolution-concurrency-"));
  let active = 0;
  let peak = 0;
  let styleCalls = 0;
  let coarseCalls = 0;
  const completeJson = async (messages) => {
    const prompt = messages[0].content;
    if (prompt.includes("写作风格")) {
      styleCalls += 1;
      return {};
    }
    if (prompt.includes("小说片段")) {
      coarseCalls += 1;
      active += 1;
      peak = Math.max(peak, active);
      await new Promise((resolve) => setTimeout(resolve, 10));
      active -= 1;
      return { extracted: true };
    }
    if (prompt.includes("世界骨架") || prompt.includes("人物与身份") || prompt.includes("世界补全")) {
      return {
        id: `world-${coarseCalls}`,
        title: "书",
        summary: "摘要",
        characters: [],
        locations: ["起点"],
        attributes: [{ id: "will", name: "意志", initial: 30 }],
        stats: [{ id: "life", name: "生命", role: "vital", min: 0, max: 10, initial: 10, zeroConsequence: "昏迷" }],
        roleTemplates: [
          { id: "r1", name: "甲", description: "身份甲", locationIds: [], factionIds: [] },
          { id: "r2", name: "乙", description: "身份乙", locationIds: [], factionIds: [] },
          { id: "r3", name: "丙", description: "身份丙", locationIds: [], factionIds: [] },
        ],
        timeline: [],
        facts: [],
      };
    }
    return {};
  };
  const baker = new NovelBaker({
    cacheDirectory,
    completeJson,
    batchCharacters: 1,
    concurrency: 2,
  });
  const novel = {
    title: "书",
    format: "txt",
    chapters: Array.from({ length: 5 }, (_, index) => ({
      index: index + 1,
      title: `${index + 1}`,
      text: `${index + 1}`,
    })),
  };

  await baker.bake(novel, { focusChapter: 1 });
  await baker.bake(novel, { focusChapter: 4 });

  assert.equal(peak, 2);
  assert.equal(styleCalls, 1);
  assert.equal(coarseCalls, 5);
});

test("baker resumes only missing coarse batches after a failure", async () => {
  const cacheDirectory = await mkdtemp(join(tmpdir(), "evolution-resume-"));
  const attempts = new Map();
  let fail = true;
  const completeJson = async (messages) => {
    const prompt = messages[0].content;
    if (prompt.includes("写作风格")) return {};
    if (prompt.includes("小说片段")) {
      const chapter = JSON.parse(messages[1].content)[0].chapter;
      attempts.set(chapter, (attempts.get(chapter) ?? 0) + 1);
      if (chapter === 2 && fail) throw new Error("temporary failure");
      return { chapter };
    }
    if (prompt.includes("世界骨架") || prompt.includes("人物与身份") || prompt.includes("世界补全")) {
      return {
        id: "world",
        title: "书",
        summary: "摘要",
        characters: [],
        locations: ["起点"],
        attributes: [{ id: "will", name: "意志", initial: 30 }],
        stats: [{ id: "life", name: "生命", role: "vital", min: 0, max: 10, initial: 10, zeroConsequence: "昏迷" }],
        roleTemplates: [
          { id: "r1", name: "甲", description: "身份甲", locationIds: [], factionIds: [] },
          { id: "r2", name: "乙", description: "身份乙", locationIds: [], factionIds: [] },
          { id: "r3", name: "丙", description: "身份丙", locationIds: [], factionIds: [] },
        ],
        timeline: [],
        facts: [],
      };
    }
    return {};
  };
  const baker = new NovelBaker({
    cacheDirectory,
    completeJson,
    batchCharacters: 1,
    concurrency: 2,
  });
  const novel = {
    title: "书",
    format: "txt",
    chapters: [1, 2, 3].map((index) => ({ index, title: `${index}`, text: `${index}` })),
  };

  await assert.rejects(() => baker.bake(novel), /temporary failure/);
  fail = false;
  await baker.bake(novel);

  assert.equal(attempts.get(1), 1);
  assert.equal(attempts.get(2), 2);
  assert.equal(attempts.get(3), 1);
});

test("baker aborts between checkpoints and resumes from the saved batches", async () => {
  const cacheDirectory = await mkdtemp(join(tmpdir(), "evolution-cancel-"));
  const controller = new AbortController();
  const attempts = new Map();
  const completeJson = async (messages) => {
    const prompt = messages[0].content;
    if (prompt.includes("写作风格")) return {};
    if (prompt.includes("小说片段")) {
      const chapter = JSON.parse(messages[1].content)[0].chapter;
      attempts.set(chapter, (attempts.get(chapter) ?? 0) + 1);
      // 第一批落盘之后取消，后面的批次不应该再被请求。
      if (chapter === 1) controller.abort();
      return { chapter };
    }
    if (prompt.includes("世界骨架") || prompt.includes("人物与身份") || prompt.includes("世界补全")) {
      return {
        id: "world",
        title: "书",
        summary: "摘要",
        characters: [],
        locations: ["起点"],
        attributes: [{ id: "will", name: "意志", initial: 30 }],
        stats: [{ id: "life", name: "生命", role: "vital", min: 0, max: 10, initial: 10, zeroConsequence: "昏迷" }],
        roleTemplates: [
          { id: "r1", name: "甲", description: "身份甲", locationIds: [], factionIds: [] },
          { id: "r2", name: "乙", description: "身份乙", locationIds: [], factionIds: [] },
          { id: "r3", name: "丙", description: "身份丙", locationIds: [], factionIds: [] },
        ],
        timeline: [],
        facts: [],
      };
    }
    return {};
  };
  const baker = new NovelBaker({
    cacheDirectory,
    completeJson,
    batchCharacters: 1,
    concurrency: 1,
  });
  const novel = {
    title: "书",
    format: "txt",
    chapters: [1, 2, 3].map((index) => ({ index, title: `${index}`, text: `${index}` })),
  };

  await assert.rejects(
    () => baker.bake(novel, { signal: controller.signal }),
    (error) => error.name === "BakeCancelledError",
  );
  assert.deepEqual([...attempts.entries()], [[1, 1]]);

  const resumed = await baker.bake(novel);

  assert.equal(attempts.get(1), 1);
  assert.equal(attempts.get(2), 1);
  assert.equal(attempts.get(3), 1);
  assert.equal(resumed.world.id, "world");
});

function repairableWorld(overrides = {}) {
  return {
    id: "repair-world",
    title: "修真录",
    summary: "山门求道",
    characters: [],
    factions: [],
    roleTemplates: [
      { id: "outsider", name: "散修", description: "无门无派的独行修士", locationIds: ["gate"], factionIds: [] },
      { id: "disciple", name: "内门弟子", description: "山门登记在册的弟子", locationIds: ["gate"], factionIds: [] },
      { id: "elder", name: "外事长老", description: "替山门在外行走的长老", locationIds: ["gate"], factionIds: [] },
    ],
    locations: [{ id: "gate", name: "山门", connections: [] }],
    attributes: [{ id: "insight", name: "悟性", initial: 30 }],
    traits: [{ id: "root", name: "灵根", value: "木火双灵根", description: "" }],
    stats: [{ id: "cultivation", name: "修为", role: "progress", min: 0, max: 100, initial: 10 }],
    timeline: [],
    facts: [],
    ...overrides,
  };
}

test("baker repairs all world errors and caches the valid result", async () => {
  const cacheDirectory = await mkdtemp(join(tmpdir(), "evolution-repair-"));
  let calls = 0;
  let repairCalls = 0;
  const completeJson = async (messages) => {
    calls += 1;
    const prompt = messages[0].content;
    if (prompt.includes("写作风格")) return {};
    if (prompt.includes("世界档案修复器")) {
      repairCalls += 1;
      const payload = JSON.parse(messages[1].content);
      assert.ok(payload.errors.length >= 2);
      return repairableWorld();
    }
    if (prompt.includes("世界骨架") || prompt.includes("人物与身份") || prompt.includes("世界补全")) {
      return repairableWorld({
        attributes: [
          { id: "root", name: "灵根", initial: "木火双灵根" },
          { id: "insight", name: "悟性", initial: "未知" },
        ],
        locations: [{ id: "gate", name: "山门", connections: ["missing"] }],
      });
    }
    return {};
  };
  const baker = new NovelBaker({ cacheDirectory, completeJson });
  const novel = {
    title: "修真录",
    format: "txt",
    chapters: [{ index: 1, title: "入门", text: "山门求道。" }],
  };

  const first = await baker.bake(novel);
  const count = calls;
  const second = await baker.bake(novel);

  assert.equal(repairCalls, 1);
  assert.equal(first.world.traits[0].name, "灵根");
  assert.equal(first.initialState.attributes.insight, 30);
  assert.deepEqual(second, first);
  assert.equal(calls, count);
});

test("baker regenerates the broken stage once and falls back to a playable core", async () => {
  const cacheDirectory = await mkdtemp(join(tmpdir(), "evolution-repair-fallback-"));
  let repairCalls = 0;
  let regenCalls = 0;
  const completeJson = async (messages, options = {}) => {
    const prompt = messages[0].content;
    if (prompt.includes("世界档案修复器")) {
      repairCalls += 1;
      return repairableWorld({ locations: [] });
    }
    if (prompt.includes("世界骨架") || prompt.includes("人物与身份") || prompt.includes("世界补全")) {
      if (options.temperature === 0.6) regenCalls += 1;
      // 模型无论怎么问都吐不出地点：数值可机械挽救，但空地点只能靠兜底。
      return repairableWorld({
        attributes: [{ id: "insight", name: "悟性", initial: "未知" }],
        locations: [],
      });
    }
    return {};
  };
  const baker = new NovelBaker({ cacheDirectory, completeJson });
  const novel = {
    title: "坏档案",
    format: "txt",
    chapters: [{ index: 1, title: "一", text: "内容" }],
  };

  const result = await baker.bake(novel);

  assert.equal(repairCalls, 2);
  assert.equal(regenCalls, 1, "硬错误归属的阶段应重生成一次");
  assert.ok(result.world.locations.length >= 1, "兜底后必须至少有可用的地点");
  assert.ok(result.world.degraded?.reasons?.length >= 1, "降级必须留痕");
  assert.ok(result.initialState.locationId, "初始状态落在补齐的地点上");
  assert.equal(result.world.attributes[0].initial, 10, "数值垃圾仍走机械挽救");
});

test("baker uses a regenerated stage slice when the first attempt is invalid", async () => {
  const cacheDirectory = await mkdtemp(join(tmpdir(), "evolution-repair-regen-"));
  let skeletonCalls = 0;
  let regenCalls = 0;
  const completeJson = async (messages, options = {}) => {
    const prompt = messages[0].content;
    // 「人物与身份」提示词里也含有「世界骨架」字样，先判人再判骨架。
    if (prompt.includes("人物与身份")) return repairableWorld();
    if (prompt.includes("世界骨架")) {
      skeletonCalls += 1;
      if (options.temperature === 0.6) {
        regenCalls += 1;
        return repairableWorld();
      }
      return {};
    }
    if (prompt.includes("世界补全")) return {};
    return {};
  };
  const baker = new NovelBaker({ cacheDirectory, completeJson });
  const novel = {
    title: "骨架重抽",
    format: "txt",
    chapters: [{ index: 1, title: "一", text: "内容" }],
  };

  const result = await baker.bake(novel);

  assert.equal(skeletonCalls, 2);
  assert.equal(regenCalls, 1);
  assert.equal(result.world.id, "repair-world");
  assert.equal(result.world.degraded, undefined, "重生成成功就不该降级");
});

test("coarse digest bounds size and keeps focus window and book edges", () => {
  const groups = Array.from({ length: 60 }, (_, index) =>
    Array.from({ length: 10 }, (_, offset) => ({ index: index * 10 + offset + 1 })),
  );
  const summaries = groups.map(() => ({ extracted: "x".repeat(500) }));
  const digest = digestCoarse(groups, summaries, { focusChapter: 300, maxChars: 10_000 });
  assert.ok(JSON.stringify(digest).length <= 10_000, "摘要必须被裁剪进预算");
  assert.equal(digest[0].chapters[0], 1, "开篇批次必须保留");
  assert.equal(digest.at(-1).chapters[1], 600, "末卷批次必须保留");
  assert.ok(
    digest.some((entry) => entry.chapters[0] <= 300 && entry.chapters[1] >= 300),
    "切入章节所在批次必须保留",
  );
  const indexes = digest.map((entry) => entry.chapters[0]);
  assert.equal(new Set(indexes).size, indexes.length, "裁剪结果不得重复");
});

test("baker passes a bounded digest instead of raw summaries to world stages", async () => {
  const cacheDirectory = await mkdtemp(join(tmpdir(), "evolution-digest-"));
  let skeletonPayload;
  const completeJson = async (messages) => {
    const prompt = messages[0].content;
    if (prompt.includes("写作风格")) return {};
    if (prompt.includes("小说片段")) return { extracted: "摘要" };
    if (prompt.includes("世界骨架")) {
      skeletonPayload = JSON.parse(messages[1].content);
      return repairableWorld();
    }
    if (prompt.includes("人物与身份")) return repairableWorld();
    if (prompt.includes("世界补全")) return {};
    return {};
  };
  const baker = new NovelBaker({ cacheDirectory, completeJson, batchCharacters: 10 });
  const novel = {
    title: "长书",
    format: "txt",
    chapters: Array.from({ length: 300 }, (_, index) => ({
      index: index + 1,
      title: String(index + 1),
      // 每章 1 字符 + 批次上限 10 字符 = 10 章一批，共 30 批。
      text: "x",
    })),
  };
  await baker.bake(novel, { focusChapter: 150 });

  assert.ok(Array.isArray(skeletonPayload.coarse), "世界阶段收到的是裁剪摘要数组");
  assert.ok(skeletonPayload.coarse.length > 0 && skeletonPayload.coarse.length < 30);
  const raw = JSON.stringify(skeletonPayload.coarse);
  assert.ok(raw.length <= 42_000, "裁剪摘要必须封顶");
  assert.ok(
    skeletonPayload.coarse.every((entry) => Array.isArray(entry.chapters) && entry.summary !== undefined),
  );
});

test("baker salvages numeric hard errors mechanically", async () => {
  const cacheDirectory = await mkdtemp(join(tmpdir(), "evolution-repair-numeric-"));
  let repairCalls = 0;
  const completeJson = async (messages) => {
    const prompt = messages[0].content;
    if (prompt.includes("世界档案修复器")) {
      repairCalls += 1;
      return repairableWorld({
        attributes: [{ id: "insight", name: "悟性", initial: "未知" }],
        stats: [
          { id: "hp", name: "性命", role: "weird", min: 50, max: 10, initial: "零", zeroConsequence: "" },
        ],
      });
    }
    if (prompt.includes("世界骨架") || prompt.includes("人物与身份") || prompt.includes("世界补全")) {
      return repairableWorld({
        attributes: [{ id: "insight", name: "悟性", initial: "未知" }],
        stats: [
          { id: "hp", name: "性命", role: "weird", min: 50, max: 10, initial: "零", zeroConsequence: "" },
        ],
      });
    }
    return {};
  };
  const baker = new NovelBaker({ cacheDirectory, completeJson });
  const novel = {
    title: "数值垃圾",
    format: "txt",
    chapters: [{ index: 1, title: "一", text: "内容" }],
  };

  const result = await baker.bake(novel);

  assert.equal(result.world.attributes[0].initial, 10);
  assert.equal(result.world.stats[0].role, "progress");
  assert.ok(result.world.stats[0].max > result.world.stats[0].min);
  assert.ok(Number.isFinite(result.world.stats[0].initial));
  assert.ok(String(result.world.stats[0].zeroConsequence).length > 0);
  assert.equal(repairCalls, 2);
});

test("baker tolerates soft residuals by mechanically repairing them", async () => {
  const cacheDirectory = await mkdtemp(join(tmpdir(), "evolution-repair-soft-"));
  let repairCalls = 0;
  const completeJson = async (messages) => {
    const prompt = messages[0].content;
    if (prompt.includes("写作风格")) return {};
    if (prompt.includes("世界档案修复器")) {
      repairCalls += 1;
      return repairableWorld({
        locations: [{ id: "gate", name: "山门", connections: ["missing"] }],
        timeline: [
          {
            id: "ev1",
            time: 60,
            locationId: "missing",
            text: "事件",
            chapterAnchor: 1,
            resolution: "weird",
            resolutionTargetIds: [],
          },
        ],
        facts: [{ id: "f1", text: "事实", chapterAnchor: "第3章" }],
      });
    }
    if (prompt.includes("世界骨架") || prompt.includes("人物与身份") || prompt.includes("世界补全")) {
      return repairableWorld({
        locations: [{ id: "gate", name: "山门", connections: ["missing"] }],
        timeline: [
          {
            id: "ev1",
            time: 60,
            locationId: "missing",
            text: "事件",
            chapterAnchor: 1,
            resolution: "weird",
            resolutionTargetIds: [],
          },
        ],
        facts: [{ id: "f1", text: "事实", chapterAnchor: "第3章" }],
      });
    }
    return {};
  };
  const baker = new NovelBaker({ cacheDirectory, completeJson });
  const novel = {
    title: "软错误",
    format: "txt",
    chapters: [{ index: 1, title: "一", text: "内容" }],
  };

  const result = await baker.bake(novel);

  assert.equal(result.world.locations[0].connections.length, 0);
  assert.equal(result.world.timeline[0].resolution, "never");
  assert.equal(result.world.timeline[0].locationId, undefined);
  assert.equal(result.world.facts[0].chapterAnchor, 3);
  assert.equal(repairCalls, 2);
});

test("baker rejects an empty repair and accepts a later wrapped repair", async () => {
  const cacheDirectory = await mkdtemp(join(tmpdir(), "evolution-repair-quality-"));
  let repairCalls = 0;
  const completeJson = async (messages) => {
    const prompt = messages[0].content;
    if (prompt.includes("世界档案修复器")) {
      repairCalls += 1;
      return repairCalls === 1 ? {} : { world: repairableWorld() };
    }
    if (prompt.includes("世界骨架") || prompt.includes("人物与身份") || prompt.includes("世界补全")) {
      return repairableWorld({
        attributes: [{ id: "insight", name: "悟性", initial: "未知" }],
      });
    }
    return {};
  };
  const baker = new NovelBaker({ cacheDirectory, completeJson });
  const novel = {
    title: "修复择优",
    format: "txt",
    chapters: [{ index: 1, title: "一", text: "内容" }],
  };

  const result = await baker.bake(novel);

  assert.equal(repairCalls, 2);
  assert.equal(result.world.id, "repair-world");
  assert.equal(result.initialState.attributes.insight, 30);
});

test("baker ignores an empty repaired draft from an existing cache", async () => {
  const cacheDirectory = await mkdtemp(join(tmpdir(), "evolution-repair-cache-"));
  const novel = {
    title: "污染缓存",
    format: "txt",
    chapters: [{ index: 1, title: "一", text: "内容" }],
  };
  const novelHash = createHash("sha256")
    .update(JSON.stringify([novel.title, novel.chapters.map((item) => item.text)]))
    .digest("hex");
  const modelHash = createHash("sha1").update("fast").digest("hex");
  // 书级共享键不含模型哈希(粗读/文风/题材/探针)；focus 键含模型哈希。
  const batchHash = createHash("sha1").update("default").digest("hex");
  const sharedKey = `${novelHash}-${batchHash}-w3`;
  await writeFile(
    join(cacheDirectory, `${sharedKey}.json`),
    JSON.stringify({
      version: 2,
      style: {},
      genre: "其他",
      summaries: [{}],
      modelProbe: { level: "unknown", specifics: [] },
    }),
    "utf8",
  );
  await writeFile(
    join(cacheDirectory, `${novelHash}-${modelHash}-${batchHash}-w3-1.json`),
    JSON.stringify({
      version: 2,
      stageVersion: STAGE_VERSION,
      detailed: {},
      mergedDraft: repairableWorld(),
      repairedDraft: {},
    }),
    "utf8",
  );
  let calls = 0;
  const baker = new NovelBaker({
    cacheDirectory,
    completeJson: async () => {
      calls += 1;
      return {};
    },
  });

  const result = await baker.bake(novel);

  assert.equal(calls, 0);
  assert.equal(result.world.id, "repair-world");
});



function cleanStageWorld() {
  return {
    id: "fresh-world",
    title: "雾书",
    summary: "新",
    characters: [
      {
        id: "han",
        name: "韩立",
        role: "散修",
        factionId: null,
        locationIds: [],
        firstChapter: 1,
        lastChapter: 1,
        status: "active",
        summary: "独行修士",
      },
    ],
    locations: [{ id: "matou", name: "码头", connections: [] }],
    attributes: [{ id: "will", name: "意志", initial: 30 }],
    stats: [{ id: "life", name: "生命", role: "vital", min: 0, max: 10, initial: 10, zeroConsequence: "昏迷" }],
    roleTemplates: [
      { id: "r1", name: "散修", description: "无门无派的独行修士", locationIds: [], factionIds: [] },
      { id: "r2", name: "杂役", description: "山门打杂弟子", locationIds: [], factionIds: [] },
      { id: "r3", name: "长老", description: "门中行走的长老", locationIds: [], factionIds: [] },
    ],
    timeline: [],
    facts: [],
  };
}


test("genre is detected first and guides people/catalog stages plus web search", async () => {
  const cacheDirectory = await mkdtemp(join(tmpdir(), "evolution-genre-"));
  const webCalls = [];
  const stageBodies = [];
  const baker = new NovelBaker({
    cacheDirectory,
    webSearch: async (args) => {
      webCalls.push(args);
      return "公开资料ABC";
    },
    completeJson: async (messages) => {
      const prompt = messages[0].content;
      if (prompt.includes("题材分类")) {
        return { genre: "仙侠", confidence: 0.95 };
      }
      if (prompt.includes("写作风格")) {
        return { narration: "第三人称限知" };
      }
      if (prompt.includes("世界骨架") || prompt.includes("人物与身份") || prompt.includes("世界补全")) {
        stageBodies.push({ prompt, body: JSON.parse(messages[1].content) });
        return cleanStageWorld();
      }
      return { extracted: true };
    },
  });
  const novel = {
    title: "雾书",
    format: "txt",
    chapters: [{ index: 1, title: "一", text: "练气筑基。" }],
  };
  await baker.bake(novel);
  assert.equal(webCalls.length, 1);
  assert.deepEqual(webCalls[0], { title: "雾书", genre: "仙侠" }, "联网搜索应带上识别出的题材");
  const people = stageBodies.find((item) => item.prompt.includes("人物与身份"));
  const catalog = stageBodies.find((item) => item.prompt.includes("创角目录"));
  const skeleton = stageBodies.find((item) => item.prompt.includes("世界骨架"));
  assert.equal(people.body.genre, "仙侠");
  assert.match(people.body.genreGuide, /地位/);
  assert.equal(catalog.body.genre, "仙侠");
  assert.match(catalog.body.genreGuide, /修仙日常|外貌/);
  assert.equal(skeleton.body.genre, "仙侠");
  assert.match(skeleton.body.genreGuide, /境界/, "骨架片注入境界引导");
  const items = stageBodies.find((item) => item.prompt.includes("物品清单"));
  assert.equal(items.body.genreGuide, undefined, "物品片不注入题材引导");
});

test("genre detection falls back to keyword heuristics when the model fails", async () => {
  const cacheDirectory = await mkdtemp(join(tmpdir(), "evolution-genre-fallback-"));
  const genreCalls = [];
  const baker = new NovelBaker({
    cacheDirectory,
    completeJson: async (messages) => {
      const prompt = messages[0].content;
      if (prompt.includes("题材分类")) {
        genreCalls.push(prompt);
        return { extracted: true }; // 模型乱答:启发式兜底。
      }
      if (prompt.includes("写作风格")) return { narration: "第三人称限知" };
      if (prompt.includes("世界骨架") || prompt.includes("人物与身份") || prompt.includes("世界补全")) {
        return cleanStageWorld();
      }
      return { extracted: true };
    },
  });
  const novel = {
    title: "雾书",
    format: "txt",
    chapters: [{ index: 1, title: "一", text: "他自幼修炼,练气筑基结丹,终要飞升。" }],
  };
  const result = await baker.bake(novel);
  assert.equal(genreCalls.length, 1, "模型分类仍会尝试一次");
  // 启发式从章节文本命中仙侠关键词。
  const skeleton = result.world;
  assert.ok(skeleton, "烧制应照常完成");
});
test("web search reference feeds four stages and skips threads", async () => {
  const cacheDirectory = await mkdtemp(join(tmpdir(), "evolution-websearch-"));
  const stageBodies = [];
  const baker = new NovelBaker({
    cacheDirectory,
    webSearch: async () => "公开资料ABC",
    completeJson: async (messages) => {
      const prompt = messages[0].content;
      if (prompt.includes("世界骨架") || prompt.includes("人物与身份") || prompt.includes("世界补全")) {
        stageBodies.push({ prompt, body: JSON.parse(messages[1].content) });
        return cleanStageWorld();
      }
      return { extracted: true };
    },
  });
  const novel = {
    title: "雾书",
    format: "txt",
    chapters: [{ index: 1, title: "一", text: "12345" }],
  };
  await baker.bake(novel);
  for (const needle of ["世界骨架", "人物与身份", "物品清单", "创角目录"]) {
    const hits = stageBodies.filter((item) => item.prompt.includes(needle));
    assert.ok(hits.length >= 1, needle + " 片应有调用");
    // webReference 带防注入分隔符包裹原文:断言包含原文与「非指令」标注。
    assert.ok(
      hits.every(
        (item) =>
          typeof item.body.webReference === "string" &&
          item.body.webReference.includes("公开资料ABC") &&
          item.body.webReference.includes("非指令"),
      ),
      needle + " 片应带 webReference",
    );
  }
  const threads = stageBodies.filter((item) => item.prompt.includes("时间线"));
  assert.ok(threads.length >= 1);
  assert.ok(threads.every((item) => item.body.webReference === undefined), "时间线片不应带 webReference");
});

test("empty web search falls back to plain summary generation", async () => {
  const cacheDirectory = await mkdtemp(join(tmpdir(), "evolution-websearch-fallback-"));
  const stageBodies = [];
  const baker = new NovelBaker({
    cacheDirectory,
    webSearch: async () => "",
    completeJson: async (messages) => {
      const prompt = messages[0].content;
      if (prompt.includes("世界骨架") || prompt.includes("人物与身份") || prompt.includes("世界补全")) {
        stageBodies.push(JSON.parse(messages[1].content));
        return cleanStageWorld();
      }
      return { extracted: true };
    },
  });
  const novel = {
    title: "雾书",
    format: "txt",
    chapters: [{ index: 1, title: "一", text: "12345" }],
  };
  await baker.bake(novel);
  assert.ok(stageBodies.length >= 5);
  assert.ok(
    stageBodies.every((body) => body.webReference === undefined),
    "搜不到时全部回退为纯摘要生成,消息形状与旧版一致",
  );
});
test("complete checkpoint with stale stageVersion regenerates merged stages", async () => {
  const cacheDirectory = await mkdtemp(join(tmpdir(), "evolution-stale-complete-"));
  const novel = {
    title: "陈旧缓存",
    format: "txt",
    chapters: [{ index: 1, title: "一", text: "内容" }],
  };
  const novelHash = createHash("sha256")
    .update(JSON.stringify([novel.title, novel.chapters.map((item) => item.text)]))
    .digest("hex");
  const modelHash = createHash("sha1").update("fast").digest("hex");
  const batchHash = createHash("sha1").update("default").digest("hex");
  const cacheKey = `${novelHash}-${modelHash}-${batchHash}-w3`;
  await writeFile(
    join(cacheDirectory, `${cacheKey}.json`),
    JSON.stringify({ version: 2, style: { narration: "旧文风" }, summaries: [{}] }),
    "utf8",
  );
  await writeFile(
    join(cacheDirectory, `${cacheKey}-1.json`),
    JSON.stringify({
      version: 2,
      stageVersion: 1,
      detailed: {},
      complete: true,
      result: {
        world: {
          id: "old-cached-world",
          title: "陈旧缓存",
          summary: "旧",
          locations: [{ id: "old", name: "旧地", connections: [] }],
          attributes: [{ id: "will", name: "意志", initial: 30 }],
          stats: [{ id: "life", name: "生命", role: "vital", min: 0, max: 10, initial: 10, zeroConsequence: "昏迷" }],
          characters: [],
          factions: [],
          roleTemplates: [
            { id: "r1", name: "旧身份", description: "旧", locationIds: [], factionIds: [] },
          ],
          timeline: [],
          facts: [],
        },
      },
    }),
    "utf8",
  );
  let stageCalls = 0;
  const baker = new NovelBaker({
    cacheDirectory,
    completeJson: async (messages) => {
      const prompt = messages[0].content;
      if (prompt.includes("世界骨架") || prompt.includes("人物与身份") || prompt.includes("世界补全")) {
        stageCalls += 1;
        return {
          id: "fresh-world",
          title: "陈旧缓存",
          summary: "新",
          characters: [
            {
              id: "han",
              name: "韩立",
              role: "散修",
              factionId: null,
              locationIds: [],
              firstChapter: 1,
              lastChapter: 1,
              status: "active",
              summary: "独行修士",
            },
          ],
          locations: [{ id: "matou", name: "码头", connections: [] }],
          attributes: [{ id: "will", name: "意志", initial: 30 }],
          stats: [{ id: "life", name: "生命", role: "vital", min: 0, max: 10, initial: 10, zeroConsequence: "昏迷" }],
          roleTemplates: [
            { id: "r1", name: "散修", description: "无门无派的独行修士", locationIds: [], factionIds: [] },
            { id: "r2", name: "杂役", description: "山门打杂弟子", locationIds: [], factionIds: [] },
            { id: "r3", name: "长老", description: "门中行走的长老", locationIds: [], factionIds: [] },
          ],
          timeline: [],
          facts: [],
        };
      }
      return { extracted: true };
    },
  });

  const result = await baker.bake(novel);
  assert.equal(stageCalls, 5, "陈旧 complete 检查点必须重新生成五个合并片");
  assert.equal(result.world.id, "fresh-world", "成品应来自新提示词生成,而非旧缓存 result");
  assert.deepEqual(
    result.world.roleTemplates.map((role) => role.name),
    ["散修", "杂役", "长老"],
  );
});
test("baker regenerates the people stage when identities are character-bound", async () => {
  const cacheDirectory = await mkdtemp(join(tmpdir(), "evolution-identity-regen-"));
  let regenSeen = false;
  let pollutedSeen = false;
  const completeJson = async (messages) => {
    const prompt = messages[0].content;
    if (prompt.includes("写作风格")) return { narration: "第三人称限知" };
    // 重生成调用:系统修正消息排在第二位,带着错误清单。
    if (String(messages[1]?.content ?? "").includes("上一次返回未通过校验")) {
      regenSeen = true;
      return {
        characters: [
          {
            id: "han",
            name: "韩立",
            role: "散修",
            factionId: null,
            locationIds: [],
            firstChapter: 1,
            lastChapter: 1,
            status: "active",
            summary: "独行修士",
          },
        ],
        roleTemplates: [
          { id: "r1", name: "散修", description: "无门无派的独行修士", locationIds: [], factionIds: [] },
          { id: "r2", name: "杂役", description: "山门打杂弟子", locationIds: [], factionIds: [] },
          { id: "r3", name: "长老", description: "门中行走的长老", locationIds: [], factionIds: [] },
        ],
        roleProgression: [],
      };
    }
    if (prompt.includes("世界骨架") || prompt.includes("人物与身份") || prompt.includes("世界补全")) {
      pollutedSeen = true;
      return {
        id: "mist",
        title: "雾书",
        summary: "港口求生",
        characters: [
          {
            id: "han",
            name: "韩立",
            role: "散修",
            factionId: null,
            locationIds: [],
            firstChapter: 1,
            lastChapter: 1,
            status: "active",
            summary: "独行修士",
          },
        ],
        locations: [{ id: "matou", name: "码头", connections: [] }],
        attributes: [{ id: "will", name: "意志", initial: 30 }],
        stats: [
          { id: "life", name: "生命", role: "vital", min: 0, max: 10, initial: 10, zeroConsequence: "昏迷" },
        ],
        // 污染的人物片:绑定原著人物 + 缺描述,必须触发定向重生成。
        roleTemplates: [
          { id: "r1", name: "主角", description: "本书主角", locationIds: [], factionIds: [] },
          { id: "r2", name: "韩立道侣", description: "主角道侣", locationIds: [], factionIds: [] },
          { id: "r3", name: "散修", description: "", locationIds: [], factionIds: [] },
        ],
        timeline: [],
        facts: [],
      };
    }
    return { extracted: true };
  };
  const baker = new NovelBaker({ cacheDirectory, completeJson, batchCharacters: 5 });
  const novel = {
    title: "雾书",
    format: "txt",
    chapters: [
      { index: 1, title: "一", text: "12345" },
      { index: 2, title: "二", text: "67890" },
    ],
  };
  const result = await baker.bake(novel);
  assert.equal(pollutedSeen, true, "首轮人物片确实带着污染产出");
  assert.equal(regenSeen, true, "身份质量错误应触发人物片定向重生成");
  assert.deepEqual(
    result.world.roleTemplates.map((role) => role.name),
    ["散修", "杂役", "长老"],
    "重生成后身份目录只含通用来路",
  );
  assert.ok(
    result.world.roleTemplates.every((role) => String(role.description ?? "").trim() !== ""),
    "每个身份都必须有描述",
  );
});

test("coarse progress reports chapter-level position", async () => {
  const cacheDirectory = await mkdtemp(join(tmpdir(), "bake-chapter-progress-"));
  const completeJson = async (messages) => {
    const prompt = messages[0].content;
    if (prompt.includes("写作风格")) return { narration: "第三人称限知" };
    if (prompt.includes("世界骨架") || prompt.includes("人物与身份") || prompt.includes("世界补全")) {
      return {
        id: "mist",
        title: "雾书",
        summary: "港口求生",
        characters: [],
        locations: [{ id: "matou", name: "码头", connections: [] }],
        attributes: [{ id: "will", name: "意志", initial: 30 }],
        stats: [{ id: "life", name: "生命", role: "vital", min: 0, max: 10, initial: 10, zeroConsequence: "昏迷" }],
        roleTemplates: [
          { id: "r1", name: "甲", description: "身份甲", locationIds: [], factionIds: [] },
          { id: "r2", name: "乙", description: "身份乙", locationIds: [], factionIds: [] },
          { id: "r3", name: "丙", description: "身份丙", locationIds: [], factionIds: [] },
        ],
        timeline: [],
        facts: [],
      };
    }
    return { extracted: true };
  };
  const progressEvents = [];
  const baker = new NovelBaker({ cacheDirectory, completeJson, batchCharacters: 5 });
  const novel = {
    title: "雾书",
    format: "txt",
    chapters: [
      { index: 1, title: "一", text: "12345" },
      { index: 2, title: "二", text: "67890" },
      { index: 3, title: "三", text: "abcde" },
    ],
  };
  await baker.bake(novel, { onProgress: (event) => progressEvents.push(event) });
  const coarse = progressEvents.filter((event) => event.stage === "coarse");
  assert.ok(coarse.length >= 2, "每章一批(批大小 5),应有至少两次粗读进度");
  for (const event of coarse) {
    assert.equal(event.totalChapters, 3);
    assert.ok(Number.isInteger(event.chapter) && event.chapter >= 1 && event.chapter <= 3);
  }
  // 进度只前进:最后一章必须被覆盖到。
  assert.equal(coarse.at(-1).chapter, 3);
});

test("baked identities keep their abilities and stat mods", async () => {
  const cacheDirectory = await mkdtemp(join(tmpdir(), "bake-abilities-"));
  const completeJson = async (messages) => {
    const prompt = messages[0].content;
    if (prompt.includes("写作风格")) return { narration: "第三人称限知" };
    // 注意顺序:人物片提示词含「在给定世界骨架上」,必须先于骨架分支判断。
    if (prompt.includes("人物与身份")) {
      return {
        characters: [],
        factions: [{ id: "sect", name: "宗门", summary: "名门", locationIds: [] }],
        roleProgression: [],
        roleTemplates: [
          {
            id: "elder",
            name: "元婴长老",
            description: "修为深厚的外来长老",
            locationIds: ["matou"],
            factionIds: ["sect"],
            firstChapter: 2,
            abilities: ["能以神识扫探方圆数里", "可御器飞行"],
            statMods: { life: -1 },
            attributeMods: { will: 5 },
            traitIds: ["realm-elder"],
            authority: ["inspect"],
          },
          { id: "r2", name: "甲", description: "身份甲", locationIds: [], factionIds: [] },
          { id: "r3", name: "乙", description: "身份乙", locationIds: [], factionIds: [] },
        ],
      };
    }
    if (prompt.includes("世界骨架")) {
      return {
        id: "mist",
        title: "雾书",
        summary: "港口求生",
        characters: [],
        locations: [{ id: "matou", name: "码头", connections: [] }],
        attributes: [{ id: "will", name: "意志", initial: 30 }],
        stats: [{ id: "life", name: "生命", role: "vital", min: 0, max: 10, initial: 10, zeroConsequence: "昏迷" }],
        traits: [{ id: "realm-elder", name: "境界", value: "元婴", description: "一方老祖" }],
        roleTemplates: [],
        timeline: [],
        facts: [],
      };
    }
    return { extracted: true };
  };
  const baker = new NovelBaker({ cacheDirectory, completeJson, batchCharacters: 5 });
  const novel = {
    title: "雾书",
    format: "txt",
    chapters: [
      { index: 1, title: "一", text: "12345" },
      { index: 2, title: "二", text: "67890" },
    ],
  };
  const result = await baker.bake(novel);
  const elder = result.world.roleTemplates.find((role) => role.id === "elder");
  assert.ok(elder, "身份应保留在成品档案里");
  assert.deepEqual(elder.abilities, ["能以神识扫探方圆数里", "可御器飞行"]);
  assert.deepEqual(elder.statMods, { life: -1 });
  assert.deepEqual(elder.attributeMods, { will: 5 });
  assert.deepEqual(elder.traitIds, ["realm-elder"], "身份蕴含特质保留");
  assert.deepEqual(elder.authority, ["inspect"], "身份职权保留");
});


test("骨架片提议的 rules 真正进入世界档案(每本书的难度调优生效)", async () => {
  // 提示词邀请模型按书提议难度/时间成本,工具 schema 也接受;但合并白名单
  // 曾经漏掉 rules,每本书都回落默认——整套调优是死代码。
  const cacheDirectory = await mkdtemp(join(tmpdir(), "evolution-rules-"));
  const proposed = {
    difficulty: { safe: 25, risky: 60, dire: 80 },
    defaultTimeCost: 90,
    maxTimeCost: 20000,
    offscreenTickMinutes: 1440,
  };
  const baker = new NovelBaker({
    cacheDirectory,
    completeJson: async (messages) => {
      const prompt = messages[0].content;
      if (prompt.includes("世界骨架")) {
        return { ...cleanStageWorld(), rules: proposed };
      }
      if (prompt.includes("人物与身份") || prompt.includes("世界补全")) {
        return cleanStageWorld();
      }
      return { extracted: true };
    },
  });
  const novel = {
    title: "雾书",
    format: "txt",
    chapters: [{ index: 1, title: "一", text: "12345" }],
  };
  const baked = await baker.bake(novel);
  assert.deepEqual(baked.world.rules, {
    difficulty: { safe: 25, risky: 60, dire: 80 },
    defaultTimeCost: 90,
    maxTimeCost: 20000,
    offscreenTickMinutes: 1440,
  }, "合法提议原样生效(经 clampRules 钳位)");
});

test("旧摘要迁移幂等:半截日志按 index 补齐,不丢批次", async () => {
  const cacheDirectory = await mkdtemp(join(tmpdir(), "evolution-migration-"));
  const novel = {
    title: "迁移书",
    format: "txt",
    chapters: [{ index: 1, title: "一", text: "内容" }],
  };
  const novelHash = createHash("sha256")
    .update(JSON.stringify([novel.title, novel.chapters.map((item) => item.text)]))
    .digest("hex");
  const modelHash = createHash("sha1").update("fast").digest("hex");
  const batchHash = createHash("sha1").update("default").digest("hex");
  const cacheKey = `${novelHash}-${modelHash}-${batchHash}-w3`;
  // 主文件内嵌三批摘要,日志只有第 0 批(上次迁移中途崩溃的现场)。
  await writeFile(
    join(cacheDirectory, `${cacheKey}.json`),
    JSON.stringify({
      version: 2,
      summaries: ["批零", "批一", "批二"],
    }),
    "utf8",
  );
  await writeFile(
    join(cacheDirectory, `${cacheKey}.summaries.jsonl`),
    JSON.stringify({ index: 0, summary: "批零" }) + "\n",
    "utf8",
  );
  let burned = 0;
  const baker = new NovelBaker({
    cacheDirectory,
    completeJson: async (messages) => {
      const prompt = messages[0].content;
      if (prompt.includes("粗读")) {
        burned += 1;
      }
      if (prompt.includes("世界骨架") || prompt.includes("人物与身份") || prompt.includes("世界补全")) {
        return cleanStageWorld();
      }
      return { extracted: true };
    },
  });
  await baker.bake(novel);
  // 补齐迁移后,三批摘要都在,不应有批次被当缺口重烧。
  assert.equal(burned, 0, "已迁移与补迁移的批次都不重烧");
  // 旧命名(含模型哈希)的书级缓存被迁到共享位置(不含模型哈希)。
  const sharedJournal = join(cacheDirectory, `${novelHash}-${batchHash}-w3.summaries.jsonl`);
  const journal = await readFile(sharedJournal, "utf8");
  for (const [index, needle] of ["批零", "批一", "批二"].entries()) {
    assert.ok(journal.includes(JSON.stringify({ index, summary: needle })), `第 ${index} 批在日志里`);
  }
  // 主文件已去掉内嵌数组(轻元数据),二次导入不再重复迁移。
  const primary = JSON.parse(
    await readFile(join(cacheDirectory, `${novelHash}-${batchHash}-w3.json`), "utf8"),
  );
  assert.equal(primary.summaries, undefined);
});

test("digestCoarse:条目删到下限仍超预算时按长度截断", () => {
  // 单批摘要本身巨大时,「最多删到 2 条」会带着超预算的摘要冲进世界片请求,
  // 违反「预算内」的承诺。
  const groups = [
    [{ index: 1 }, { index: 5 }],
    [{ index: 6 }, { index: 10 }],
  ];
  const summaries = ["巨".repeat(3000), "大".repeat(3000)];
  const entries = digestCoarse(groups, summaries, { focusChapter: 1, maxChars: 3000 });
  const serialized = JSON.stringify(entries);
  assert.ok(serialized.length <= 3000 + 100, "截断后回到预算内(允许少量结构开销)");
  assert.equal(entries.length, 2, "条目本身不删光");
});


test("换快模型不再重读全书:粗读缓存书级共享,只重建世界片", async () => {
  const cacheDirectory = await mkdtemp(join(tmpdir(), "evolution-decouple-"));
  const novel = {
    title: "长书",
    format: "txt",
    chapters: Array.from({ length: 3 }, (_, index) => ({
      index: index + 1,
      title: `第${index + 1}章`,
      text: "正文".repeat(200),
    })),
  };
  let coarseCalls = 0;
  let stageCalls = 0;
  const makeBaker = (modelName) =>
    new NovelBaker({
      cacheDirectory,
      modelName,
      completeJson: async (messages) => {
        const prompt = messages[0].content;
        if (prompt.includes("提取小说片段")) {
          coarseCalls += 1;
          return { extracted: true };
        }
        if (prompt.includes("小说认知探针")) {
          return { familiarity: "unknown", specifics: [] };
        }
        if (
          prompt.includes("世界骨架") ||
          prompt.includes("人物与身份") ||
          prompt.includes("世界补全")
        ) {
          stageCalls += 1;
          return cleanStageWorld();
        }
        return { extracted: true };
      },
    });
  await makeBaker("model-a").bake(novel);
  assert.ok(coarseCalls > 0, "首次烧制逐批粗读");
  const coarseAfterFirst = coarseCalls;
  const stagesAfterFirst = stageCalls;

  await makeBaker("model-b").bake(novel);
  assert.equal(coarseCalls, coarseAfterFirst, "换模型零粗读请求(缓存书级共享)");
  assert.ok(stageCalls > stagesAfterFirst, "世界片按模型重建");
  // 世界片缓存按模型分家:model-b 的 focus 文件独立存在。
  const novelHash = createHash("sha256")
    .update(JSON.stringify([novel.title, novel.chapters.map((item) => item.text)]))
    .digest("hex");
  const batchHash = createHash("sha1").update("default").digest("hex");
  const files = await readdir(cacheDirectory);
  assert.ok(
    files.some((name) => name.startsWith(`${novelHash}-`) && name.endsWith("-w3-1.json")),
    "focus 文件按模型哈希命名",
  );
  assert.ok(
    files.includes(`${novelHash}-${batchHash}-w3.json`),
    "书级共享主检查点就位",
  );
});

test("threads 片认并行多线,people 片产出 POV 清单(拍板 2026-08-20)", async () => {
  const cacheDirectory = await mkdtemp(join(tmpdir(), "bake-nonlinear-"));
  const prompts = [];
  const skeleton = {
    id: "dual-world",
    title: "双线书",
    summary: "两线并行",
    characters: [],
    locations: [{ id: "matou", name: "码头", connections: [] }],
    attributes: [{ id: "will", name: "意志", initial: 30 }],
    stats: [
      { id: "life", name: "生命", role: "vital", min: 0, max: 10, initial: 10, zeroConsequence: "昏迷" },
    ],
    roleTemplates: [],
    timeline: [],
    facts: [],
  };
  const completeJson = async (messages) => {
    const prompt = messages[0].content;
    prompts.push(prompt);
    if (prompt.includes("写作风格")) return { narration: "第三人称限知" };
    if (prompt.includes("提取小说片段中的角色")) return { extracted: true };
    if (prompt.includes("人物与身份")) {
      return {
        characters: [
          { id: "p1", name: "甲", role: "剑客", locationIds: ["matou"], firstChapter: 1 },
          { id: "p2", name: "乙", role: "谋士", locationIds: ["matou"], firstChapter: 1 },
        ],
        factions: [],
        roleProgression: [],
        roleTemplates: [],
        povCharacters: ["p1", "p2"],
      };
    }
    if (prompt.includes("世界骨架")) return skeleton;
    if (prompt.includes("时间线")) return { timeline: [], facts: [] };
    return { extracted: true };
  };
  const baker = new NovelBaker({ cacheDirectory, completeJson });
  const novel = {
    title: "双线书",
    format: "txt",
    chapters: [{ index: 1, title: "一", text: "甲与乙各在一方。" }],
  };
  const result = await baker.bake(novel, { focusChapter: 1 });

  const threads = prompts.find((prompt) => prompt.includes("双轴语义"));
  assert.ok(threads, "threads 片提示词在场");
  assert.match(threads, /并行多线/);
  assert.match(threads, /同一时刻两条线各有一条事件完全合法/);
  assert.match(threads, /汇聚点用 prerequisites 标注先后/);
  assert.match(threads, /都只列一条并按故事内时间归位/);

  const people = prompts.find((prompt) => prompt.includes("人物与身份"));
  assert.ok(people, "people 片提示词在场");
  assert.match(people, /povCharacters/);

  assert.deepEqual(result.world.povCharacters, ["p1", "p2"], "POV 清单随人物片归一进档");
});

test("定向粗读（补挂原文）：只烧摘要日志，不探针不文风不并片，续烧语义照常", async () => {
  const cacheDirectory = await mkdtemp(join(tmpdir(), "bake-coarse-only-"));
  let coarseCalls = 0;
  let otherCalls = 0;
  const completeJson = async (messages) => {
    const prompt = messages[0].content;
    if (prompt.includes("提取小说片段中的角色")) {
      coarseCalls += 1;
      return { extracted: true };
    }
    otherCalls += 1;
    return { extracted: true };
  };
  const baker = new NovelBaker({ cacheDirectory, completeJson, batchCharacters: 5 });
  const novel = {
    title: "雾书",
    format: "txt",
    chapters: [
      { index: 1, title: "一", text: "12345" },
      { index: 2, title: "二", text: "67890" },
    ],
  };

  const result = await baker.bake(novel, { coarseOnly: true });
  assert.deepEqual(result, { coarseOnly: true, groupsRead: 2, groupsTotal: 2 });
  assert.equal(coarseCalls, 2, "两个批次各读一遍");
  assert.equal(otherCalls, 0, "探针/题材/文风/切入精读/世界片一概不跑");
  const journal = (await readdir(cacheDirectory)).filter((name) => name.endsWith(".summaries.jsonl"));
  assert.equal(journal.length, 1, "摘要日志已落盘");
  // 命脉断言：日志必须落在游玩侧 loadCanonLedger 的取用路径上（主进程按
  // novelCachePrefix(书名+全文) + sha1(批次参数，缺省 default) + w3 找账本），
  // 错一段账本就永远找不到，粗读等于白烧。主进程不传 batchCharacters，
  // 即与账本侧的 "default" 同参。
  const batchStamp = String(baker.batchCharacters ?? "default");
  const expectedJournal =
    `${novelCachePrefix(novel)}-` +
    `${createHash("sha1").update(batchStamp).digest("hex")}-w3.summaries.jsonl`;
  assert.deepEqual(journal, [expectedJournal]);

  // 日志烧齐后重跑定向粗读：一个请求都不再发。
  const again = await baker.bake(novel, { coarseOnly: true });
  assert.equal(again.groupsRead, 2);
  assert.equal(coarseCalls, 2);
});

test("定向粗读之后完整起稿：粗读复用日志，只补文风与五片", async () => {
  const cacheDirectory = await mkdtemp(join(tmpdir(), "bake-coarse-then-full-"));
  let coarseCalls = 0;
  const completeJson = async (messages) => {
    const prompt = messages[0].content;
    if (prompt.includes("提取小说片段中的角色")) {
      coarseCalls += 1;
      return { extracted: true };
    }
    if (prompt.includes("写作风格")) return { narration: "第三人称限知" };
    if (prompt.includes("人物与身份")) {
      return {
        characters: [],
        factions: [],
        roleProgression: [],
        roleTemplates: [
          { id: "r1", name: "甲", description: "身份甲", locationIds: [], factionIds: [] },
          { id: "r2", name: "乙", description: "身份乙", locationIds: [], factionIds: [] },
          { id: "r3", name: "丙", description: "身份丙", locationIds: [], factionIds: [] },
        ],
      };
    }
    if (prompt.includes("世界骨架")) {
      return {
        id: "coarse-then-full",
        title: "雾书",
        summary: "港口求生",
        characters: [],
        locations: ["码头"],
        attributes: [{ id: "will", name: "意志", initial: 30 }],
        stats: [{ id: "life", name: "生命", role: "vital", min: 0, max: 10, initial: 10, zeroConsequence: "昏迷" }],
        roleTemplates: [],
        timeline: [],
        facts: [],
      };
    }
    return { extracted: true };
  };
  const baker = new NovelBaker({ cacheDirectory, completeJson, batchCharacters: 5 });
  const novel = {
    title: "雾书",
    format: "txt",
    chapters: [
      { index: 1, title: "一", text: "12345" },
      { index: 2, title: "二", text: "67890" },
    ],
  };
  await baker.bake(novel, { coarseOnly: true });
  assert.equal(coarseCalls, 2);

  // 补挂后的「重新起稿」路径：粗读命中日志零请求，世界照常烧成。
  const full = await baker.bake(novel);
  assert.equal(coarseCalls, 2, "完整起稿复用定向粗读的日志");
  assert.equal(full.world.id, "coarse-then-full");
});
