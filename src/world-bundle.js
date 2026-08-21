// 世界分享格式 .cpworld（拍板 2026-08-21：世界文件）：把一本书的烧制产物打包成
// 可跨机器导入的 ZIP 容器——世界档案 + 建角模板必带，原文与粗读摘要按档位可选。
//   轻装档（默认，分享用）：不带原文。世界档案是模型生成的结构化演绎，不含原著
//     正文，体积小；导入后文风注入/「原著此刻」/人物精读自动降级（引擎各注入点
//     对空 sourceChapters 本就优雅回退）。
//   全档（自用备份）：带原文与粗读摘要，跨机器迁移后正典账本照常可用。
//
// 安全模型与「AI 提议、代码钳位」同源：导入文件与 LLM 输出同级不可信——
//   条目白名单严格到文件名（杜绝 zip-slip 与夹带），解压体积逐条目预检且
//   拿不到预估值就拒绝（fail-closed），manifest 逐字段校验，世界档案过与烧制
//   收尾同一条机械修复管线。硬错误直接拒绝导入：导入侧没有模型可救场，
//   降级成最小骨架等于把别人分享的世界偷换成空壳，宁可明着失败。
import JSZip from "jszip";

import { migrateState, normalizeWorld } from "./evolution.js";
import { validateInitialState, validateWorld } from "./engine.js";
import {
  WorldRepairError,
  diagnoseWorld,
  isHardDiagnosisError,
  mechanicallyRepairWorld,
} from "./world-repair.js";

export const WORLD_BUNDLE_FORMAT_VERSION = 1;
export const WORLD_BUNDLE_EXTENSION = "cpworld";

const MANIFEST_NAME = "manifest.json";
const WORLD_NAME = "world.json";
const CHAPTER_INDEX_NAME = "chapter-index.json";
const CHAPTERS_NAME = "chapters.json";
const SUMMARIES_NAME = "canon-summaries.jsonl";
const CHARACTER_CACHE_PREFIX = "character-cache/";
const CACHE_ENTRY_PATTERN = /^character-cache\/[a-f0-9]{40}\.json$/;

// 上限与 novel-import 同档：分享文件不该比原著导入更大。
const MAX_BUNDLE_BYTES = 256 * 1024 * 1024;
const MAX_PROJECTED_BYTES = 512 * 1024 * 1024;
const MAX_CHAPTERS = 5_000;
const MAX_CHAPTER_TEXT = 10_000_000;
const MAX_TITLE_CHARS = 200;
// 人物精读缓存每文件 1-3KB，64KB 单文件与 500 个条目都是远超常态的余量。
const MAX_CACHE_FILES = 500;
const MAX_CACHE_FILE_BYTES = 64 * 1024;
// 粗读摘要按 5 万字/批追加，千万字上限约 200 行；1000 行是数量级余量。
const MAX_SUMMARY_LINES = 1_000;
const MAX_SUMMARY_BYTES = 4 * 1024 * 1024;

const FORMATS = new Set(["txt", "epub"]);

function isCharacterCacheEntry(name) {
  return CACHE_ENTRY_PATTERN.test(name);
}

function isAllowedEntry(name) {
  return (
    name === MANIFEST_NAME ||
    name === WORLD_NAME ||
    name === CHAPTER_INDEX_NAME ||
    name === CHAPTERS_NAME ||
    name === SUMMARIES_NAME ||
    isCharacterCacheEntry(name)
  );
}

function cleanTitle(value) {
  return typeof value === "string" ? value.trim().slice(0, MAX_TITLE_CHARS) : "";
}

// ---------------------------------------------------------------- 组包

// characterCache：[{ name, content }]——name 须为 <sha1hex>.json，content 为
// JSON 文本。调用方（主进程）从 character-cache/<sha1(worldId)>/ 目录收集；
// 导入侧按 world.id 重新归位，命中即免重新精读。
export async function buildWorldBundle(
  {
    meta,
    world,
    initialState,
    chapters = [],
    summariesText = null,
    characterCache = [],
    provenance = {},
  },
  { withSource = false } = {},
) {
  const title = cleanTitle(meta?.title);
  if (!title) throw new Error("导出世界需要书名");
  if (!FORMATS.has(meta?.format)) throw new Error("导出世界需要有效的来源格式（txt/epub）");
  if (!Array.isArray(chapters)) throw new Error("章节列表格式不正确");

  // 导出与导入走同一条收口管线：写出的档案永远是规范形态（属性补 initial、
  // 动机补 requires 等默认值都落定），解析→再导出→再解析是不动点；书库档案
  // 若有硬伤（问题出在烧制/升级上游），导出时明着报错胜过把坏档案传给别人。
  const settled = settleWorld(world, initialState, title);
  const checkedWorld = settled.world;
  const checkedState = settled.initialState;

  const includeSource = withSource && chapters.length > 0;
  const includeSummaries = includeSource && typeof summariesText === "string" && summariesText.length > 0;
  const cacheEntries = characterCache
    .filter((entry) => entry && isCharacterCacheEntry(`${CHARACTER_CACHE_PREFIX}${entry.name}`))
    .slice(0, MAX_CACHE_FILES);

  const manifest = {
    formatVersion: WORLD_BUNDLE_FORMAT_VERSION,
    kind: "world-bundle",
    meta: {
      title,
      format: meta.format,
      chapterCount: chapters.length,
    },
    includes: {
      chapters: includeSource,
      summaries: includeSummaries,
      characterCache: cacheEntries.length,
    },
    provenance: {
      schemaVersion: checkedWorld.schemaVersion,
      bakedAt: new Date().toISOString(),
      shareScope: includeSource ? "with-source" : "world-only",
      ...(typeof provenance.appVersion === "string" && provenance.appVersion
        ? { appVersion: provenance.appVersion }
        : {}),
      ...(typeof provenance.bakedModel === "string" && provenance.bakedModel
        ? { bakedModel: provenance.bakedModel }
        : {}),
      ...(typeof provenance.licenseNote === "string" && provenance.licenseNote.trim()
        ? { licenseNote: provenance.licenseNote.trim().slice(0, 500) }
        : {}),
    },
    worldId: String(checkedWorld.id ?? ""),
  };

  const zip = new JSZip();
  zip.file(MANIFEST_NAME, JSON.stringify(manifest, null, 2));
  zip.file(WORLD_NAME, JSON.stringify({ world: checkedWorld, initialState: checkedState }, null, 2));
  // 章号是 timeline/facts/characters 的锚系：不带原文的档位也要保住目录结构。
  zip.file(
    CHAPTER_INDEX_NAME,
    JSON.stringify(chapters.map(({ index, title }) => ({ index, title: title ?? "" }))),
  );
  if (includeSource) {
    zip.file(CHAPTERS_NAME, JSON.stringify(chapters));
    if (includeSummaries) zip.file(SUMMARIES_NAME, summariesText);
  }
  for (const entry of cacheEntries) {
    zip.file(`${CHARACTER_CACHE_PREFIX}${entry.name}`, String(entry.content ?? ""));
  }
  const bytes = await zip.generateAsync({ type: "uint8array", compression: "DEFLATE" });
  return { bytes, manifest };
}

// ---------------------------------------------------------------- 解析

function parseJsonEntry(text, label) {
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`${label} 不是有效的 JSON，文件可能已损坏`);
  }
}

function checkManifest(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error("manifest.json 格式不正确");
  }
  if (raw.formatVersion !== WORLD_BUNDLE_FORMAT_VERSION) {
    throw new Error(
      `世界文件版本不兼容（formatVersion ${String(raw.formatVersion)}，本程序支持 ${WORLD_BUNDLE_FORMAT_VERSION}），请升级推演书后重试`,
    );
  }
  if (raw.kind !== "world-bundle") throw new Error("这不是推演书世界文件");
  const meta = raw.meta;
  if (!meta || typeof meta !== "object") throw new Error("manifest 缺少书籍信息");
  const title = cleanTitle(meta.title);
  if (!title) throw new Error("manifest 缺少书名");
  if (!FORMATS.has(meta.format)) throw new Error("manifest 的来源格式无效（只支持 txt/epub）");
  if (!Number.isInteger(meta.chapterCount) || meta.chapterCount < 0 || meta.chapterCount > MAX_CHAPTERS) {
    throw new Error("manifest 的章节数不合法");
  }
  const includes = raw.includes;
  if (
    !includes ||
    typeof includes !== "object" ||
    typeof includes.chapters !== "boolean" ||
    typeof includes.summaries !== "boolean" ||
    !Number.isInteger(includes.characterCache) ||
    includes.characterCache < 0 ||
    includes.characterCache > MAX_CACHE_FILES
  ) {
    throw new Error("manifest 的内容声明不合法");
  }
  // 摘要的缓存键含原文哈希：脱离原文的摘要无处归位，组包侧就不该产出。
  if (includes.summaries && !includes.chapters) {
    throw new Error("世界文件声明了摘要却没有原文，内容声明自相矛盾");
  }
  return {
    formatVersion: raw.formatVersion,
    kind: raw.kind,
    meta: { title, format: meta.format, chapterCount: meta.chapterCount },
    includes: { ...includes },
    provenance: raw.provenance && typeof raw.provenance === "object" ? raw.provenance : {},
    worldId: typeof raw.worldId === "string" ? raw.worldId : "",
  };
}

function checkChapters(raw) {
  if (!Array.isArray(raw)) throw new Error("chapters.json 格式不正确");
  if (raw.length > MAX_CHAPTERS) throw new Error("世界文件的章节数超过上限");
  let total = 0;
  let previous = 0;
  const chapters = raw.map((chapter) => {
    if (!chapter || typeof chapter !== "object") throw new Error("章节条目格式不正确");
    if (!Number.isInteger(chapter.index) || chapter.index < 1) {
      throw new Error("章节号必须是正整数");
    }
    // 章号严格递增：人物 firstChapter/lastChapter 过滤与批次划分都按 index 值
    // 对齐，重复或乱序的章号会让锚点错位。
    if (chapter.index <= previous) throw new Error("章节号必须严格递增");
    previous = chapter.index;
    const text = typeof chapter.text === "string" ? chapter.text : "";
    total += text.length;
    if (total > MAX_CHAPTER_TEXT) throw new Error("世界文件的原文总量超过上限");
    return {
      index: chapter.index,
      title: typeof chapter.title === "string" ? chapter.title.slice(0, MAX_TITLE_CHARS) : "",
      text,
    };
  });
  return chapters;
}

function checkSummaries(text) {
  const lines = text.split("\n");
  if (lines.length > MAX_SUMMARY_LINES) throw new Error("世界文件的摘要行数异常");
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let entry;
    try {
      entry = JSON.parse(trimmed);
    } catch {
      throw new Error("世界文件的摘要日志损坏");
    }
    if (!entry || typeof entry !== "object" || !Number.isInteger(entry.index) || typeof entry.summary !== "string") {
      throw new Error("世界文件的摘要条目格式不正确");
    }
  }
  return text;
}

async function readEntry(zip, name) {
  const entry = zip.file(name);
  if (!entry) throw new Error(`世界文件缺少 ${name}`);
  return entry.async("text");
}

// 导入校验管线：与烧制收尾同一条机械修复链（normalize → diagnose → 机械修复 →
// 复诊 → 抛错型把关）。差异在兜底策略：烧制可以降级补最小骨架，导入不行——
// 硬错误（结构缺失、初始状态对不上）明着拒绝，软错误（悬空引用、越界数值）
// 修掉后容忍。
function settleWorld(rawWorld, rawState, title) {
  // 旧 schema 在 normalize 之前先看原始值：normalize 会把版本号强制写成当前值，
  // 之后再判断就永远查不出来（书架 needsRebake 曾栽在同一个顺序上）。
  const rawSchemaVersion = Number(rawWorld?.schemaVersion) || 0;
  if (rawSchemaVersion < 4) {
    throw new Error("世界档案版本太旧，请先在原机器上用新版推演书重新起稿后再导出");
  }
  const normalized = normalizeWorld(rawWorld);
  // 初始状态先按当前世界定义迁移（旧档 location→locationId 之类），再进诊断——
  // 顺序与读档路径一致，否则诊断会拿旧字段对新世界报「初始地点不存在」硬错误。
  const state = migrateState(structuredClone(rawState), normalized);
  let diagnosis = diagnoseWorld(normalized, state);
  let world = normalized;
  if (diagnosis.errors.length) {
    const repaired = mechanicallyRepairWorld(diagnosis.world, { title });
    const settled = diagnoseWorld(repaired, state);
    const hard = settled.errors.filter(isHardDiagnosisError);
    if (hard.length) throw new WorldRepairError(hard);
    world = repaired;
  }
  try {
    const checked = validateWorld(world);
    const finalState = validateInitialState(state, checked);
    return { world: checked, initialState: finalState };
  } catch (error) {
    throw new Error(`世界档案未通过导入校验：${error?.message ?? error}`);
  }
}

export async function parseWorldBundle(bytes) {
  if (!bytes || !Number.isFinite(bytes.length) || bytes.length === 0) {
    throw new Error("世界文件为空");
  }
  if (bytes.length > MAX_BUNDLE_BYTES) throw new Error("世界文件超过体积上限");
  let zip;
  try {
    zip = await JSZip.loadAsync(bytes);
  } catch {
    throw new Error("不是有效的世界文件（无法解包）");
  }

  // 条目白名单 + 解压体积预检：压缩包可以小体积解出大内容，逐条目累加解压后
  // 大小，超限直接拒；拿不到预估值也不再放行（fail-closed，同 EPUB 预检）。
  let projected = 0;
  let cacheCount = 0;
  for (const [name, entry] of Object.entries(zip.files ?? {})) {
    if (entry.dir) continue;
    if (!isAllowedEntry(name)) throw new Error(`世界文件含未知条目，已拒绝导入：${name}`);
    const size = entry?._data?.uncompressedSize;
    if (!Number.isFinite(size)) throw new Error("世界文件存在无法预估解压体积的条目，已拒绝导入");
    projected += size;
    if (isCharacterCacheEntry(name)) cacheCount += 1;
  }
  if (projected > MAX_PROJECTED_BYTES) throw new Error("世界文件解压后体积异常，已拒绝导入");

  const manifest = checkManifest(parseJsonEntry(await readEntry(zip, MANIFEST_NAME), "manifest.json"));
  const hasChapters = zip.file(CHAPTERS_NAME) != null;
  const hasSummaries = zip.file(SUMMARIES_NAME) != null;
  if (manifest.includes.chapters !== hasChapters) {
    throw new Error("世界文件的内容声明与实际内容不一致");
  }
  if (manifest.includes.summaries !== hasSummaries) {
    throw new Error("世界文件的内容声明与实际内容不一致");
  }
  if (manifest.includes.characterCache !== cacheCount) {
    throw new Error("世界文件的人物精读缓存数量与声明不符");
  }

  const stored = parseJsonEntry(await readEntry(zip, WORLD_NAME), "world.json");
  if (!stored || typeof stored !== "object" || !stored.world || !stored.initialState) {
    throw new Error("world.json 缺少世界档案或初始状态");
  }

  // 目录必带：不带原文的档位靠它保住章号锚系，带原文的档位用于一致性核对。
  const rawIndex = parseJsonEntry(
    await readEntry(zip, CHAPTER_INDEX_NAME),
    CHAPTER_INDEX_NAME,
  );
  if (!Array.isArray(rawIndex) || rawIndex.length !== manifest.meta.chapterCount) {
    throw new Error("世界文件的目录与 manifest 声明的章节数不符");
  }

  let chapters = [];
  if (hasChapters) {
    chapters = checkChapters(parseJsonEntry(await readEntry(zip, CHAPTERS_NAME), "chapters.json"));
    if (chapters.length !== manifest.meta.chapterCount) {
      throw new Error("世界文件的章节数与 manifest 声明不符");
    }
  }

  let summariesText = null;
  if (hasSummaries) {
    summariesText = checkSummaries(await readEntry(zip, SUMMARIES_NAME));
    if (summariesText.length > MAX_SUMMARY_BYTES) throw new Error("世界文件的摘要日志超过上限");
  }

  const characterCache = [];
  for (const [name, entry] of Object.entries(zip.files ?? {})) {
    if (entry.dir || !isCharacterCacheEntry(name)) continue;
    const content = await entry.async("text");
    if (content.length > MAX_CACHE_FILE_BYTES) throw new Error("世界文件的人物精读缓存条目异常");
    parseJsonEntry(content, name);
    characterCache.push({ name: name.slice(CHARACTER_CACHE_PREFIX.length), content });
  }

  const settled = settleWorld(stored.world, stored.initialState, manifest.meta.title);
  return {
    manifest,
    ...settled,
    chapters,
    summariesText,
    characterCache,
  };
}
