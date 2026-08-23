import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import JSZip from "jszip";

import { MockLlm } from "../fixtures/mock-llm.js";
import { initialState, startingOption, world } from "../fixtures/world.js";
import { migrateState, normalizeWorld } from "../src/evolution.js";
import { StoryEngine } from "../src/engine.js";
import {
  WORLD_BUNDLE_FORMAT_VERSION,
  buildWorldBundle,
  parseWorldBundle,
} from "../src/world-bundle.js";

// 与书库同构的「一本刚烧好的书」：世界档案经 normalize、初始状态经迁移。
function bakedBook(chapters = []) {
  const normalized = normalizeWorld(structuredClone(world));
  const state = migrateState(structuredClone(initialState), normalized);
  return {
    meta: { title: "灰港余烬", format: "txt" },
    world: normalized,
    initialState: state,
    chapters,
  };
}

const CHAPTERS = [
  { index: 1, title: "第一章 封港之夜", text: "海雾切断了所有退路。黑铃在旧码头上悬着，从不被海风吹响。" },
  { index: 2, title: "第二章 燕尾铜扣", text: "裂缝里摸到半枚刻着燕尾的铜扣，灯塔的灯在远处明明灭灭。" },
];

const SUMMARIES = [
  JSON.stringify({ index: 0, summary: "封港之夜，陌生人在旧码头醒来。" }),
  JSON.stringify({ index: 1, summary: "燕尾铜扣现世，灯塔守夜人失踪的线索浮出。" }),
].join("\n");

function cacheEntry(characterId, summary) {
  return {
    name: `${createHash("sha1").update(String(characterId)).digest("hex")}.json`,
    content: JSON.stringify({ role: "原著人物", summary, motives: [], habits: [], resources: [], constraints: [], secrets: [] }),
  };
}

test("轻装档 round-trip：不带原文，规范形态稳定往返", async () => {
  const book = bakedBook(CHAPTERS);
  const linCache = cacheEntry("lin", "在盐仓做工，见过守夜人最后一面。");
  const { bytes, manifest } = await buildWorldBundle({
    ...book,
    summariesText: SUMMARIES,
    characterCache: [linCache],
    provenance: { appVersion: "0.1.0", bakedModel: "deepseek-chat", licenseNote: " 仅限书友私享 " },
  });

  assert.equal(manifest.includes.chapters, false, "轻装档不声明原文");
  assert.equal(manifest.includes.summaries, false, "摘要键含原文哈希，轻装档一律不带");
  assert.equal(manifest.includes.characterCache, 1);
  assert.equal(manifest.provenance.shareScope, "world-only");
  assert.equal(manifest.provenance.licenseNote, "仅限书友私享", "授权声明去空格保留");
  assert.equal(manifest.meta.chapterCount, 2, "章数是目录信息，与是否带原文无关");

  const parsed = await parseWorldBundle(bytes);
  assert.deepEqual(parsed.manifest.meta, { title: "灰港余烬", format: "txt", chapterCount: 2 });
  assert.deepEqual(parsed.chapters, [], "轻装档导入后没有原文");
  // 章节目录随解析透出：导入侧拿它落盘，补挂原文时做「同一本书」比对。
  assert.deepEqual(
    parsed.chapterIndex,
    CHAPTERS.map(({ index, title }) => ({ index, title })),
  );
  assert.equal(parsed.summariesText, null);
  assert.equal(parsed.characterCache.length, 1);
  assert.equal(parsed.characterCache[0].name, linCache.name);
  assert.deepEqual(parsed.characterCache[0].content, linCache.content);

  // 规范形态不动点：解析结果再导出再解析，世界档案与初始状态逐字节等价。
  // 比较前过一遍 JSON：undefined 键在落盘格式里不存在，不该算差异。
  const rebuilt = await buildWorldBundle({
    meta: parsed.manifest.meta,
    world: parsed.world,
    initialState: parsed.initialState,
    chapters: parsed.chapters,
  });
  const reparsed = await parseWorldBundle(rebuilt.bytes);
  const jsonClone = (value) => JSON.parse(JSON.stringify(value));
  assert.deepEqual(jsonClone(reparsed.world), jsonClone(parsed.world));
  assert.deepEqual(jsonClone(reparsed.initialState), jsonClone(parsed.initialState));
});

test("全档 round-trip：原文与粗读摘要一并往返", async () => {
  const book = bakedBook(CHAPTERS);
  const { bytes, manifest } = await buildWorldBundle(
    { ...book, summariesText: SUMMARIES },
    { withSource: true },
  );

  assert.equal(manifest.includes.chapters, true);
  assert.equal(manifest.includes.summaries, true);
  assert.equal(manifest.provenance.shareScope, "with-source");

  const parsed = await parseWorldBundle(bytes);
  assert.deepEqual(parsed.chapters, CHAPTERS);
  assert.equal(parsed.summariesText, SUMMARIES);
  // 关键档案内容存活：标题、人物、状态定义、时间线一个不少。
  assert.equal(parsed.world.title, book.world.title);
  assert.deepEqual(
    parsed.world.characters.map((character) => character.id),
    book.world.characters.map((character) => character.id),
  );
  assert.deepEqual(
    parsed.world.stats.map((stat) => stat.id),
    book.world.stats.map((stat) => stat.id),
  );
  assert.equal(parsed.world.timeline.length, book.world.timeline.length);
});

test("轻装档导入后可以直接开局：空 sourceChapters 优雅降级，不炸", async () => {
  const book = bakedBook(CHAPTERS);
  const { bytes } = await buildWorldBundle({ ...book });
  const parsed = await parseWorldBundle(bytes);

  const engine = new StoryEngine({
    world: parsed.world,
    initialState: parsed.initialState,
    llm: new MockLlm(),
    seed: 7,
    sourceChapters: parsed.chapters,
  });
  const turns = [];
  let option = startingOption;
  for (let index = 0; index < 3; index += 1) {
    const turn = await engine.play(option);
    turns.push(turn);
    option = turn.options[0];
  }
  assert.equal(turns.length, 3, "三手都落定");
  assert.ok(turns.every((turn) => typeof turn.narrative === "string" && turn.narrative.length > 0));
});

test("白名单拒绝夹带条目与路径穿越", async () => {
  const book = bakedBook();
  const { bytes } = await buildWorldBundle({ ...book });
  for (const evil of ["evil.txt", "../evil.txt", "character-cache/nothex.json", "a/manifest.json"]) {
    const zip = await JSZip.loadAsync(bytes);
    zip.file(evil, "payload");
    const tampered = await zip.generateAsync({ type: "uint8array" });
    await assert.rejects(() => parseWorldBundle(tampered), /未知条目/);
  }
});

test("manifest 逐字段把关：版本、类型、内容声明", async () => {
  const book = bakedBook(CHAPTERS);
  const { bytes } = await buildWorldBundle({ ...book });

  // 改写 manifest 后重新解析：断言解析器拒绝，而不是改写本身失败。
  const parseRewritten = async (mutate) => {
    const zip = await JSZip.loadAsync(bytes);
    const manifest = JSON.parse(await zip.file("manifest.json").async("text"));
    mutate(manifest, zip);
    zip.file("manifest.json", JSON.stringify(manifest));
    return parseWorldBundle(await zip.generateAsync({ type: "uint8array" }));
  };

  await assert.rejects(
    () => parseRewritten((manifest) => (manifest.formatVersion = 99)),
    /版本不兼容/,
  );
  await assert.rejects(() => parseRewritten((manifest) => (manifest.kind = "trojan")), /不是推演书世界文件/);
  await assert.rejects(() => parseRewritten((manifest) => (manifest.meta.format = "pdf")), /来源格式无效/);
  await assert.rejects(
    () => parseRewritten((manifest) => (manifest.includes.chapters = true)),
    /内容声明与实际内容不一致/,
  );
  // 摘要脱离原文：组包侧就不会产出，导入侧同样拒绝。
  await assert.rejects(
    () =>
      parseRewritten((manifest, zip) => {
        manifest.includes.summaries = true;
        zip.file("canon-summaries.jsonl", SUMMARIES);
      }),
    /自相矛盾/,
  );
  await assert.rejects(
    () => parseRewritten((manifest) => (manifest.includes.characterCache = 3)),
    /人物精读缓存数量与声明不符/,
  );
});

test("结构性缺损明着拒绝：坏 zip、缺档、旧 schema、硬错误世界", async () => {
  const book = bakedBook(CHAPTERS);
  const { bytes } = await buildWorldBundle({ ...book });

  await assert.rejects(() => parseWorldBundle(new TextEncoder().encode("not a zip")), /无法解包/);

  const zip = await JSZip.loadAsync(bytes);
  zip.remove("world.json");
  await assert.rejects(async () => parseWorldBundle(await zip.generateAsync({ type: "uint8array" })), /缺少 world\.json/);

  // 旧 schema 档案在 normalize 之前按原始值拦截——normalize 会把版本号改成当前值。
  const parseTamperedWorld = async (mutate) => {
    const loaded = await JSZip.loadAsync(bytes);
    const stored = JSON.parse(await loaded.file("world.json").async("text"));
    mutate(stored.world);
    loaded.file("world.json", JSON.stringify(stored));
    return parseWorldBundle(await loaded.generateAsync({ type: "uint8array" }));
  };
  await assert.rejects(
    () => parseTamperedWorld((world) => (world.schemaVersion = 3)),
    /版本太旧/,
  );
  await assert.rejects(() => parseTamperedWorld((world) => (world.locations = [])), /校验失败/);
});

test("软错误机械修复后放行：悬空势力引用置空、倒挂数值区间钳回", async () => {
  const book = bakedBook(CHAPTERS);
  const { bytes } = await buildWorldBundle({ ...book });
  const loaded = await JSZip.loadAsync(bytes);
  const stored = JSON.parse(await loaded.file("world.json").async("text"));
  stored.world.characters.find((character) => character.id === "lin").factionId = "ghost-faction";
  stored.world.stats.find((stat) => stat.id === "supplies").min = 5;
  stored.world.stats.find((stat) => stat.id === "supplies").max = 3;
  loaded.file("world.json", JSON.stringify(stored));
  const tampered = await loaded.generateAsync({ type: "uint8array" });

  const parsed = await parseWorldBundle(tampered);
  assert.equal(parsed.world.characters.find((character) => character.id === "lin").factionId, null);
  assert.equal(parsed.world.stats.find((stat) => stat.id === "supplies").max, 105, "max<=min 时钳为 min+100");
});

test("章号必须严格递增：重复或乱序的锚系直接拒绝", async () => {
  const book = bakedBook(CHAPTERS);
  const { bytes } = await buildWorldBundle({ ...book }, { withSource: true });
  const loaded = await JSZip.loadAsync(bytes);
  const chapters = JSON.parse(await loaded.file("chapters.json").async("text"));
  chapters[1].index = 1;
  loaded.file("chapters.json", JSON.stringify(chapters));
  await assert.rejects(
    async () => parseWorldBundle(await loaded.generateAsync({ type: "uint8array" })),
    /严格递增/,
  );
});

test("章节目录的章号与标题同样过纪律：坏目录拒绝导入", async () => {
  const book = bakedBook(CHAPTERS);
  const { bytes } = await buildWorldBundle({ ...book });
  const corrupt = async (mutate) => {
    const loaded = await JSZip.loadAsync(bytes);
    const rawIndex = JSON.parse(await loaded.file("chapter-index.json").async("text"));
    mutate(rawIndex);
    loaded.file("chapter-index.json", JSON.stringify(rawIndex));
    return parseWorldBundle(await loaded.generateAsync({ type: "uint8array" }));
  };
  // 目录是补挂原文的比对基准，章号乱序或标题非字符串都会让比对失真。
  await assert.rejects(corrupt((rawIndex) => { rawIndex[1].index = 1; }), /严格递增/);
  await assert.rejects(corrupt((rawIndex) => { rawIndex[0].index = 0; }), /正整数/);
  await assert.rejects(corrupt((rawIndex) => { rawIndex[0].title = 42; }), /标题/);
});

test("格式版本常量随档案走：manifest 与解析器同源", async () => {
  const book = bakedBook();
  const { manifest } = await buildWorldBundle({ ...book });
  assert.equal(manifest.formatVersion, WORLD_BUNDLE_FORMAT_VERSION);
});
