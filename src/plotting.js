// 谋篇引擎（2026-08-24）：作家构思工作台的数据模型与六节生成编排。
// 与游玩（StoryEngine）完全解耦——不碰世界档案、不落 books/，项目由
// electron/plot-store.js 持久化。这里只做三件事：项目数据模型的防御性
// 归一（照 evolution.normalizeWorld 的纪律）、提示词→LLM 的编排、整档
// Markdown 导出。LLM 以鸭子类型注入：真桥是 OpenAiCompatibleClient，
// 测试用同形状的桩。

import { GENRES } from "./genre.js";
import {
  buildPlotPremiseMessages,
  buildPlotWorldviewMessages,
  buildPlotStyleProposalMessages,
  buildPlotIdeaCardsMessages,
  buildStyleAnalysisMessages,
  buildPlotCharactersMessages,
  buildPlotOutlineMessages,
  buildPlotSampleMessages,
  PLOT_FLAVORS,
} from "./plot-prompt.js";
import {
  submitPlotPremiseTool,
  submitPlotWorldviewTool,
  submitPlotCharactersTool,
  submitPlotOutlineTool,
  submitPlotIdeasTool,
  submitStyleTool,
} from "./structured-tools.js";

// 六节的顺序与上游依赖：下游生成以最新上游为上下文；重掷不自动级联
// （作家改了立意后自己决定要不要重掷世界观）。
export const PLOT_SECTIONS = [
  { key: "premise", label: "立意", requires: [] },
  { key: "worldview", label: "世界观", requires: ["premise"] },
  { key: "style", label: "文风", requires: [] },
  { key: "characters", label: "人物", requires: ["premise", "worldview"] },
  { key: "outline", label: "大纲", requires: ["premise", "worldview", "characters"] },
  { key: "sample", label: "样章", requires: ["style", "outline"] },
];
export const PLOT_SECTION_KEYS = PLOT_SECTIONS.map((section) => section.key);

// 贴入范文的分析上限：范文只是取样的语料，超过这个量级不再提高分析质量，
// 只会白白吃输入 token（起稿侧 styleSampleText 同量级）。
const STYLE_SAMPLE_LIMIT = 20_000;

const str = (value, max = 600) =>
  String(value ?? "")
    .replace(/\u0000/g, "")
    .trim()
    .slice(0, max);

function strList(value, { max = 12, itemMax = 300 } = {}) {
  if (!Array.isArray(value)) return [];
  return value.map((item) => str(item, itemMax)).filter(Boolean).slice(0, max);
}

function cleanGenre(value) {
  const genre = str(value, 20);
  return GENRES.includes(genre) && genre !== "其他" ? genre : "";
}

// 创新度档位（1 很成熟 … 5 很创新）：档外值一律收回落到均衡。
export function normalizeFlavor(value) {
  const flavor = Number(value);
  return Number.isInteger(flavor) && flavor >= 1 && flavor <= PLOT_FLAVORS.length
    ? flavor
    : 3;
}

export function newPlotProject({ id, title = "", idea, genre = "", reference = null, flavor = 3 }) {
  const now = new Date().toISOString();
  return {
    version: 1,
    id,
    title: str(title, 40) || "未命名之作",
    createdAt: now,
    updatedAt: now,
    seeds: {
      idea: str(idea, 300),
      genre: cleanGenre(genre),
      reference: normalizeReference(reference),
      flavor: normalizeFlavor(flavor),
    },
    premise: null,
    worldview: null,
    style: null,
    characters: null,
    outline: null,
    sample: null,
  };
}

function normalizeReference(value) {
  if (!value || typeof value !== "object") return null;
  const name = str(value.name, 60);
  const digest = str(value.digest, 8000);
  if (!name) return null;
  return { name, ...(digest ? { digest } : {}) };
}

/* ---------- 各节归一：结构化生成的产出与手工编辑的写回共用同一道闸 ---------- */

function normalizePremise(value) {
  if (!value || typeof value !== "object") return null;
  const premise = {
    logline: str(value.logline, 200),
    theme: str(value.theme, 400),
    hook: str(value.hook, 400),
    titles: strList(value.titles, { max: 6, itemMax: 40 }),
    notes: strList(value.notes, { max: 8 }),
  };
  return premise.logline ? premise : null;
}

function normalizeWorldview(value) {
  if (!value || typeof value !== "object") return null;
  const worldview = {
    summary: str(value.summary, 1200),
    highlights: strList(value.highlights, { max: 10 }),
    conflicts: strList(value.conflicts, { max: 6 }),
  };
  return worldview.summary ? worldview : null;
}

// 文风卡与起稿的 world.style 七维同形；source 记录三通道来源（ai/sample/library）。
function normalizeStyle(value, source = null) {
  if (!value || typeof value !== "object") return null;
  const kind = ["ai", "sample", "library"].includes(source?.kind) ? source.kind : "ai";
  const style = {
    narration: str(value.narration, 200),
    tense: str(value.tense, 120),
    sentence: str(value.sentence, 300),
    punctuation: str(value.punctuation, 300),
    imagery: strList(value.imagery, { max: 10, itemMax: 40 }),
    diction: strList(value.diction, { max: 12, itemMax: 40 }),
    chapterForm: str(value.chapterForm, 200),
    avoid: strList(value.avoid, { max: 8 }),
    source: { kind, label: str(source?.label, 80) || (kind === "sample" ? "由贴入的范文分析" : "") },
  };
  return style.narration || style.sentence ? style : null;
}

function normalizeCharacter(value) {
  if (!value || typeof value !== "object") return null;
  const persona = value.persona && typeof value.persona === "object" ? value.persona : {};
  const character = {
    name: str(value.name, 40),
    role: str(value.role, 80),
    summary: str(value.summary, 400),
    persona: {
      temperament: str(persona.temperament, 200),
      motives: strList(persona.motives, { max: 4 }),
      bottomLines: strList(persona.bottomLines, { max: 3 }),
      manner: str(persona.manner, 200),
    },
    arc: str(value.arc, 200),
  };
  return character.name ? character : null;
}

function normalizeCharacters(value) {
  if (!Array.isArray(value)) return null;
  const characters = value.map(normalizeCharacter).filter(Boolean).slice(0, 6);
  return characters.length ? characters : null;
}

function normalizeOutline(value) {
  if (!value || typeof value !== "object") return null;
  const volumes = (Array.isArray(value.volumes) ? value.volumes : [])
    .map((volume) => {
      if (!volume || typeof volume !== "object") return null;
      const beats = (Array.isArray(volume.beats) ? volume.beats : [])
        .map((beat) =>
          beat && typeof beat === "object"
            ? { title: str(beat.title, 200), note: str(beat.note, 300) }
            : null,
        )
        .filter((beat) => beat?.title)
        .slice(0, 12);
      const entry = {
        title: str(volume.title, 60),
        summary: str(volume.summary, 800),
        beats,
      };
      return entry.title ? entry : null;
    })
    .filter(Boolean)
    .slice(0, 8);
  const outline = { logline: str(value.logline, 300), volumes };
  return outline.logline || volumes.length ? outline : null;
}

function normalizeSample(value) {
  const text = typeof value === "string" ? value : str(value?.text, 20000);
  return text ? { text } : null;
}

const SECTION_NORMALIZERS = {
  premise: normalizePremise,
  worldview: normalizeWorldview,
  style: (value) => normalizeStyle(value, value?.source),
  characters: normalizeCharacters,
  outline: normalizeOutline,
  sample: normalizeSample,
};

// 手工编辑写回的入口：按节归一后再落库，脏数据进不了档案。
export function normalizeSection(section, value) {
  const normalize = SECTION_NORMALIZERS[section];
  if (!normalize) throw new Error(`未知的谋篇节 “${section}”`);
  return normalize(value);
}

// 整档归一：坏档按 null 处理（照 ProgressStore.looksLikeSave 的读路径纪律）。
export function normalizeProject(data) {
  if (!data || typeof data !== "object" || data.version !== 1 || typeof data.id !== "string") {
    return null;
  }
  const project = newPlotProject({
    id: data.id,
    title: data.title,
    idea: data.seeds?.idea ?? "",
    genre: data.seeds?.genre ?? "",
    reference: data.seeds?.reference ?? null,
    flavor: data.seeds?.flavor,
  });
  project.createdAt = str(data.createdAt, 40) || project.createdAt;
  project.updatedAt = str(data.updatedAt, 40) || project.updatedAt;
  for (const key of ["premise", "worldview", "characters", "outline", "sample"]) {
    project[key] = data[key] == null ? null : normalizeSection(key, data[key]);
  }
  project.style =
    data.style == null
      ? null
      : normalizeStyle(data.style, { kind: data.style.source?.kind, label: data.style.source?.label });
  return project;
}

/* ---------- 生成编排 ---------- */

const STRONG_TIMEOUT_MS = 180_000;

async function strongTool(llm, messages, tool) {
  const result = await llm.completeStrongTool(messages, tool, { timeoutMs: STRONG_TIMEOUT_MS });
  return result;
}

export async function generatePremise(llm, project, { note = "" } = {}) {
  return normalizePremise(await strongTool(llm, buildPlotPremiseMessages({ project, note }), submitPlotPremiseTool()));
}

/* ---------- 灵感卡（帮我想通道）：会话态，不进项目档案 ---------- */

export function normalizeIdeaCards(value) {
  if (!value || !Array.isArray(value.cards)) return [];
  const seen = new Set();
  const cards = [];
  for (const card of value.cards) {
    if (!card || typeof card !== "object") continue;
    const idea = str(card.idea, 200);
    if (!idea || seen.has(idea)) continue;
    seen.add(idea);
    const genre = cleanGenre(card.genre) || "其他";
    cards.push({ idea, genre, hook: str(card.hook, 200) });
    if (cards.length >= 6) break;
  }
  return cards;
}

export async function generateIdeaCards(llm, { genres = [], avoid = [], flavor = 3 } = {}) {
  const result = await strongTool(
    llm,
    buildPlotIdeaCardsMessages({ genres, avoid, flavor }),
    submitPlotIdeasTool(),
  );
  return normalizeIdeaCards(result);
}

export async function generateWorldview(llm, project, { note = "" } = {}) {
  return normalizeWorldview(await strongTool(llm, buildPlotWorldviewMessages({ project, note }), submitPlotWorldviewTool()));
}

// 文风三通道之一：AI 按题材与立意提议（强槽）。
export async function proposeStyle(llm, project, { note = "" } = {}) {
  const result = await strongTool(llm, buildPlotStyleProposalMessages({ project, note }), submitStyleTool());
  return normalizeStyle(result, { kind: "ai", label: "AI 按题材与立意提议" });
}

// 文风三通道之二：贴范文分析——与起稿共用同一份文风提示词与 submit_style，
// 走快槽（与起稿侧的 style 步骤同档）。
export async function analyzeStyleSample(llm, sampleText) {
  const clipped = String(sampleText ?? "").trim().slice(0, STYLE_SAMPLE_LIMIT);
  if (clipped.length < 200) throw new Error("范文太短——至少贴 200 字才能分析出文风");
  const result = await llm.completeFastTool(buildStyleAnalysisMessages(clipped), submitStyleTool(), {
    timeoutMs: 120_000,
  });
  return normalizeStyle(result, { kind: "sample", label: `由贴入的范文分析（前 ${clipped.slice(0, 12)}…）` });
}

// 文风三通道之三：直接采用案头某本已起稿小说的文风档案——零 LLM。
export function styleFromLibrary(bookTitle, styleCard) {
  return normalizeStyle(styleCard, {
    kind: "library",
    label: `《${str(bookTitle, 40)}》的文风档案`,
  });
}

export async function generateCharacters(llm, project, { note = "" } = {}) {
  // 人物工具的载荷是 { characters: [...] }，其余节都是平铺字段。
  const result = await strongTool(llm, buildPlotCharactersMessages({ project, note }), submitPlotCharactersTool());
  return normalizeCharacters(result?.characters ?? result);
}

export async function generateOutline(llm, project, { note = "" } = {}) {
  return normalizeOutline(await strongTool(llm, buildPlotOutlineMessages({ project, note }), submitPlotOutlineTool()));
}

// 样章：唯一的纯文本流式节。onNarrative 逐块外送（渲染层渐显），返回整段。
export async function generateSample(llm, project, { note = "", onNarrative, signal } = {}) {
  const messages = buildPlotSampleMessages({ project, note });
  const text = await llm.generatePlotSample({ messages, onNarrative, signal });
  return normalizeSample(text);
}

/* ---------- 导出 ---------- */

export function projectToMarkdown(project) {
  const lines = [];
  const seeds = project?.seeds ?? {};
  lines.push(`# ${project?.title ?? "未命名之作"}`);
  lines.push("");
  if (seeds.idea) {
    lines.push(`> 点子：${seeds.idea}`);
    lines.push("");
  }
  if (seeds.genre) lines.push(`- 题材：${seeds.genre}`);
  if (seeds.reference?.name) lines.push(`- 参考：${seeds.reference.name}`);
  if (seeds.genre || seeds.reference?.name) lines.push("");

  if (project?.premise) {
    const premise = project.premise;
    lines.push("## 立意与主题");
    lines.push("");
    lines.push(`- **立意**：${premise.logline}`);
    lines.push(`- **主题**：${premise.theme}`);
    if (premise.hook) lines.push(`- **开篇钩子**：${premise.hook}`);
    if (premise.titles.length) lines.push(`- **备选书名**：${premise.titles.join(" / ")}`);
    if (premise.notes.length) {
      lines.push("");
      for (const noteItem of premise.notes) lines.push(`- ${noteItem}`);
    }
    lines.push("");
  }

  if (project?.worldview) {
    const worldview = project.worldview;
    lines.push("## 世界观设定");
    lines.push("");
    lines.push(worldview.summary);
    lines.push("");
    if (worldview.highlights.length) {
      lines.push("**设定要点**");
      lines.push("");
      for (const item of worldview.highlights) lines.push(`- ${item}`);
      lines.push("");
    }
    if (worldview.conflicts.length) {
      lines.push("**核心矛盾**");
      lines.push("");
      for (const item of worldview.conflicts) lines.push(`- ${item}`);
      lines.push("");
    }
  }

  if (project?.style) {
    const style = project.style;
    lines.push("## 文风卡");
    lines.push("");
    if (style.source?.label) lines.push(`> 来源：${style.source.label}`);
    lines.push("");
    lines.push(`- 人称与视角：${style.narration}`);
    lines.push(`- 时态：${style.tense}`);
    lines.push(`- 句长与节奏：${style.sentence}`);
    lines.push(`- 标点习惯：${style.punctuation}`);
    if (style.imagery.length) lines.push(`- 常见意象：${style.imagery.join("、")}`);
    if (style.diction.length) lines.push(`- 词汇层：${style.diction.join("、")}`);
    if (style.chapterForm) lines.push(`- 章节体例：${style.chapterForm}`);
    if (style.avoid.length) lines.push(`- 避免写法：${style.avoid.join("；")}`);
    lines.push("");
  }

  if (project?.characters?.length) {
    lines.push("## 人物雏形");
    lines.push("");
    for (const character of project.characters) {
      lines.push(`### ${character.name}（${character.role}）`);
      lines.push("");
      if (character.summary) lines.push(character.summary);
      lines.push("");
      const persona = character.persona ?? {};
      if (persona.temperament) lines.push(`- 性格：${persona.temperament}`);
      if (persona.motives.length) lines.push(`- 动机：${persona.motives.join("；")}`);
      if (persona.bottomLines.length) lines.push(`- 底线：${persona.bottomLines.join("；")}`);
      if (persona.manner) lines.push(`- 说话方式：${persona.manner}`);
      if (character.arc) lines.push(`- 弧线：${character.arc}`);
      lines.push("");
    }
  }

  if (project?.outline) {
    const outline = project.outline;
    lines.push("## 故事大纲");
    lines.push("");
    if (outline.logline) lines.push(`**总纲**：${outline.logline}`);
    lines.push("");
    outline.volumes.forEach((volume, index) => {
      lines.push(`### 第${index + 1}卷 · ${volume.title}`);
      lines.push("");
      if (volume.summary) lines.push(volume.summary);
      lines.push("");
      for (const beat of volume.beats) {
        lines.push(`- ${beat.title}${beat.note ? `——${beat.note}` : ""}`);
      }
      lines.push("");
    });
  }

  if (project?.sample?.text) {
    lines.push("## 开篇样章");
    lines.push("");
    lines.push(project.sample.text);
    lines.push("");
  }

  return lines.join("\n");
}
