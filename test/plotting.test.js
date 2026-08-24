import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  PLOT_SECTIONS,
  newPlotProject,
  normalizeProject,
  normalizeSection,
  normalizeFlavor,
  generatePremise,
  generateWorldview,
  proposeStyle,
  analyzeStyleSample,
  styleFromLibrary,
  generateCharacters,
  generateOutline,
  generateSample,
  generateIdeaCards,
  normalizeIdeaCards,
  projectToMarkdown,
} from "../src/plotting.js";
import {
  buildPlotPremiseMessages,
  buildPlotWorldviewMessages,
  buildPlotStyleProposalMessages,
  buildPlotIdeaCardsMessages,
  buildPlotCharactersMessages,
  buildPlotOutlineMessages,
  buildPlotSampleMessages,
  flavorDirective,
} from "../src/plot-prompt.js";
import { STYLE_ANALYSIS_PROMPT, buildStyleAnalysisMessages } from "../src/style-prompt.js";
import { ANTI_AI_PROSE_RULES } from "../src/prompt.js";
import { PlotStore, assertPlotId } from "../electron/plot-store.js";

/* 同形状的假客户端：按工具名回剧本，记录调用供断言（slot 强弱与消息内容）。 */
const SCRIPTS = {
  submit_plot_premise: {
    logline: "永不天亮的城市里，最后的灯夫守着仅存的一盏灯。",
    theme: "微小的坚守如何在遗忘里保住温度。",
    hook: "今晚要收走的灯油，比昨夜又少了半勺。",
    titles: ["一盏之城"],
    notes: ["把守灯写成可以输的日常"],
  },
  submit_plot_worldview: {
    summary: "雾都临海，天被雾锁了三百年，城里靠灯不靠天亮。",
    highlights: ["灯油产自雾渊，捞一次折一年阳寿"],
    conflicts: ["灯政司要缩灯保油，灯夫要灯满城明"],
  },
  submit_style: {
    narration: "第三人称贴身一人",
    tense: "过去时为骨",
    sentence: "短句为主，三五字一顿",
    punctuation: "逗号密、句号狠",
    imagery: ["雾", "灯芯"],
    diction: ["灯卡", "捞油人"],
    chapterForm: "每章一盏灯",
    avoid: ["现代词", "心理独白长段"],
  },
  submit_plot_characters: {
    characters: [
      {
        name: "陆灯生",
        role: "长街灯夫",
        summary: "接了父亲未竟的灯卡。",
        persona: { temperament: "话少手稳", motives: ["查清换卡前夜的来人"], bottomLines: ["不拿别人的灯油"], manner: "短句，爱用行话打比方" },
        arc: "从守灯是差事到守灯是证词。",
      },
    ],
  },
  submit_plot_outline: {
    logline: "从灯还够点走到灯快见底。",
    volumes: [{ title: "半勺油", summary: "配额首减，有人在数街上的灯。", beats: [{ title: "配额削减落到长街", note: "账面第一次现「缩灯」二字。" }] }],
  },
};
const SAMPLE_TEXT = "雾从海上过来，到长街已经凉透了。\n\n他把壶盖拧紧。";

function fakeLlm() {
  const calls = [];
  return {
    calls,
    async completeStrongTool(messages, tool) {
      calls.push({ slot: "strong", name: tool.function.name, messages });
      return SCRIPTS[tool.function.name] ?? {};
    },
    async completeFastTool(messages, tool) {
      calls.push({ slot: "fast", name: tool.function.name, messages });
      return SCRIPTS[tool.function.name] ?? {};
    },
    async generatePlotSample({ messages, onNarrative }) {
      calls.push({ slot: "stream", name: "plot_sample", messages });
      for (const piece of ["夜落。", "灯起。"]) onNarrative?.(piece);
      return SAMPLE_TEXT;
    },
  };
}

function seedProject(overrides = {}) {
  return newPlotProject({
    id: "plot-0123456789abcdef",
    idea: "一个灯夫在永不天亮的城市里守最后一盏灯",
    genre: "玄幻",
    ...overrides,
  });
}

test("newPlotProject seeds and normalizeProject rejects bad archives", () => {
  const project = seedProject();
  assert.equal(project.title, "未命名之作");
  assert.equal(project.seeds.genre, "玄幻");
  assert.equal(project.premise, null);
  // 题材白名单外的值落空
  assert.equal(seedProject({ genre: "科幻小说" }).seeds.genre, "");

  assert.equal(normalizeProject(null), null);
  assert.equal(normalizeProject({ version: 2, id: "plot-x" }), null);
  assert.equal(normalizeProject("junk"), null);
});

test("section dependency chain is as decided (sample needs style+outline)", () => {
  const byKey = Object.fromEntries(PLOT_SECTIONS.map((section) => [section.key, section.requires]));
  assert.deepEqual(byKey.premise, []);
  assert.deepEqual(byKey.worldview, ["premise"]);
  assert.deepEqual(byKey.style, []);
  assert.deepEqual(byKey.characters, ["premise", "worldview"]);
  assert.deepEqual(byKey.outline, ["premise", "worldview", "characters"]);
  assert.deepEqual(byKey.sample, ["style", "outline"]);
});

test("premise generation goes strong slot with seeds in payload", async () => {
  const llm = fakeLlm();
  const project = seedProject();
  const premise = await generatePremise(llm, project);
  assert.equal(llm.calls.length, 1);
  assert.equal(llm.calls[0].slot, "strong");
  assert.equal(llm.calls[0].name, "submit_plot_premise");
  assert.ok(llm.calls[0].messages[1].content.includes(project.seeds.idea));
  assert.ok(llm.calls[0].messages[1].content.includes("玄幻"));
  assert.equal(premise.logline, SCRIPTS.submit_plot_premise.logline);
  assert.ok(Array.isArray(premise.titles));
});

test("downstream builders inject upstream outputs as context", () => {
  const project = seedProject();
  project.premise = normalizeSection("premise", SCRIPTS.submit_plot_premise);
  project.worldview = normalizeSection("worldview", SCRIPTS.submit_plot_worldview);
  project.style = normalizeSection("style", { ...SCRIPTS.submit_style, source: { kind: "ai", label: "AI" } });
  project.characters = normalizeSection("characters", SCRIPTS.submit_plot_characters.characters);
  project.outline = normalizeSection("outline", SCRIPTS.submit_plot_outline);

  const worldviewUser = buildPlotWorldviewMessages({ project })[1].content;
  assert.ok(worldviewUser.includes(project.premise.logline));

  const charactersUser = buildPlotCharactersMessages({ project })[1].content;
  assert.ok(charactersUser.includes(project.worldview.conflicts[0]));

  const outlineUser = buildPlotOutlineMessages({ project })[1].content;
  assert.ok(outlineUser.includes(project.characters[0].name));

  const sampleMessages = buildPlotSampleMessages({ project });
  assert.ok(sampleMessages[0].content.includes(ANTI_AI_PROSE_RULES.slice(0, 8)));
  assert.ok(sampleMessages[0].content.includes("文风铁律"));
  assert.ok(sampleMessages[1].content.includes(project.style.sentence));
  assert.ok(sampleMessages[1].content.includes(project.outline.volumes[0].title));
  assert.ok(sampleMessages[1].content.includes(project.characters[0].manner ?? project.characters[0].persona.manner));
});

test("style channels: ai=strong, sample=fast with bake prompt, library=zero LLM", async () => {
  const llm = fakeLlm();
  const project = seedProject();

  const proposed = await proposeStyle(llm, project);
  assert.equal(llm.calls.at(-1).slot, "strong");
  assert.equal(llm.calls.at(-1).name, "submit_style");
  assert.equal(proposed.source.kind, "ai");

  const sample = "夜色像浸了油的纸。".repeat(30);
  const analyzed = await analyzeStyleSample(llm, sample);
  assert.equal(llm.calls.at(-1).slot, "fast");
  assert.equal(llm.calls.at(-1).name, "submit_style");
  assert.equal(llm.calls.at(-1).messages[0].content, STYLE_ANALYSIS_PROMPT);
  assert.equal(analyzed.source.kind, "sample");
  // 范文过短直接拒绝，不打模型
  await assert.rejects(() => analyzeStyleSample(llm, "太短"), /范文太短/);

  const fromLibrary = styleFromLibrary("北望行", SCRIPTS.submit_style);
  // 两次真实调用（提议＋范文分析）；过短拒绝与库通道都不打模型
  assert.equal(llm.calls.length, 2);
  assert.equal(fromLibrary.source.kind, "library");
  assert.ok(fromLibrary.source.label.includes("北望行"));
});

test("characters generation unwraps the tool payload array", async () => {  const llm = fakeLlm();
  const project = seedProject();
  project.worldview = normalizeSection("worldview", SCRIPTS.submit_plot_worldview);
  const characters = await generateCharacters(llm, project);
  assert.equal(llm.calls[0].name, "submit_plot_characters");
  assert.equal(characters.length, 1);
  assert.equal(characters[0].name, "陆灯生");
  assert.equal(characters[0].persona.motives[0], "查清换卡前夜的来人");
});

test("idea cards: builder injects scope and avoid, generation clamps and dedupes", async () => {
  const llm = fakeLlm();
  llm.completeStrongTool = async (messages, tool) => {
    llm.calls.push({ slot: "strong", name: tool.function.name, messages });
    return {
      cards: [
        { idea: "骑手给不存在的大楼送货", genre: "都市", hook: "每一单都通往城市背面。" },
        { idea: "骑手给不存在的大楼送货", genre: "都市", hook: "重复点子应被去掉。" },
        { idea: "守夜书吏删掉的名字第二天消失", genre: "玄幻", hook: "改史是手艺也是凶器。" },
        { idea: "殡仪馆学徒只听得见一句遗言", genre: "灵异", hook: "一句够破案也够误事。" },
        { idea: "驿站小吏伺候过路神仙", genre: "仙侠", hook: "编制内伺候编外的。" },
        { idea: "刑警搭档雨天从不出现", genre: "悬疑", hook: "雨里有他不能踩的线。" },
        { idea: "白名单外的题材落「其他」", genre: "轻小说", hook: "" },
      ],
    };
  };

  const cards = await generateIdeaCards(llm, { genres: ["都市", "悬疑"], avoid: ["上批的点子"] });
  assert.equal(llm.calls[0].name, "submit_plot_ideas");
  // 圈定与 avoid 都进了 user 载荷；系统提示要求避开既有主题
  const user = llm.calls[0].messages[1].content;
  assert.ok(user.includes("都市"));
  assert.ok(user.includes("悬疑"));
  assert.ok(user.includes("上批的点子"));
  // 去重裁足六张；白名单外题材落「其他」；hook 缺失兜底为空串
  assert.equal(cards.length, 6);
  assert.equal(new Set(cards.map((card) => card.idea)).size, 6);
  assert.equal(cards.at(-1).genre, "其他");
  assert.equal(typeof cards.at(-1).hook, "string");
});

test("idea cards: builder without scope asks for all genres, junk input normalizes to empty", () => {
  const messages = buildPlotIdeaCardsMessages({});
  assert.ok(messages[1].content.includes("仙侠"));
  const scoped = buildPlotIdeaCardsMessages({ genres: ["仙侠", "不存在的题材", "其他"] });
  const payload = JSON.parse(scoped[1].content.split("\n").pop());
  assert.deepEqual(payload.genres, ["仙侠"]);
  assert.equal(normalizeIdeaCards(null).length, 0);
  assert.equal(normalizeIdeaCards({ cards: "junk" }).length, 0);
  assert.equal(normalizeIdeaCards({ cards: [{ idea: "  ", genre: "都市" }] }).length, 0);
});

test("flavor lever: clamp, persist in project, and inject into every generator", async () => {
  // 档外值一律收回落到均衡
  assert.equal(normalizeFlavor(0), 3);
  assert.equal(normalizeFlavor(9), 3);
  assert.equal(normalizeFlavor("4"), 4);
  assert.equal(normalizeFlavor(undefined), 3);

  const project = newPlotProject({ id: "plot-0123456789abcdef", idea: "灯夫守灯", flavor: 5 });
  assert.equal(project.seeds.flavor, 5);
  assert.equal(normalizeProject(JSON.parse(JSON.stringify(project))).seeds.flavor, 5);

  // 灵感卡带 flavor；六节 builder 全部从 seeds.flavor 注入同一条指令
  const ideaMessages = buildPlotIdeaCardsMessages({ genres: [], avoid: [], flavor: 1 });
  assert.ok(ideaMessages[0].content.includes("很成熟"));
  for (const build of [
    buildPlotPremiseMessages,
    buildPlotWorldviewMessages,
    buildPlotStyleProposalMessages,
    buildPlotCharactersMessages,
    buildPlotOutlineMessages,
    buildPlotSampleMessages,
  ]) {
    const messages = build({ project });
    assert.ok(
      messages[0].content.includes(flavorDirective(5)),
      `${build.name} 未注入创新度指令`,
    );
  }
  // 均衡档也有明确指令，缺失时回落均衡
  assert.ok(flavorDirective(undefined).includes("均衡"));
});

test("sample chapter streams through generatePlotSample and normalizes", async () => {
  const llm = fakeLlm();
  const project = seedProject();
  project.style = normalizeSection("style", { ...SCRIPTS.submit_style, source: { kind: "ai", label: "AI" } });
  project.outline = normalizeSection("outline", SCRIPTS.submit_plot_outline);
  const streamed = [];
  const sample = await generateSample(llm, project, { onNarrative: (text) => streamed.push(text) });
  assert.equal(llm.calls.at(-1).slot, "stream");
  assert.deepEqual(streamed, ["夜落。", "灯起。"]);
  assert.equal(sample.text, SAMPLE_TEXT);
});

test("normalizeSection rejects unknown sections and trims dirty input", () => {
  assert.throws(() => normalizeSection("nope", {}), /未知的谋篇节/);
  const characters = normalizeSection(
    "characters",
    SCRIPTS.submit_plot_characters.characters.concat([{ name: "  ", role: "空名应被丢弃" }]),
  );
  assert.equal(characters.length, 1);
  assert.equal(characters[0].persona.motives.length, 1);
  const empty = normalizeSection("outline", { logline: "", volumes: [] });
  assert.equal(empty, null);
});

test("projectToMarkdown covers every generated section", () => {
  const project = seedProject({ title: "长夜灯夫" });
  project.premise = normalizeSection("premise", SCRIPTS.submit_plot_premise);
  project.worldview = normalizeSection("worldview", SCRIPTS.submit_plot_worldview);
  project.style = normalizeSection("style", { ...SCRIPTS.submit_style, source: { kind: "ai", label: "AI 提议" } });
  project.characters = normalizeSection("characters", SCRIPTS.submit_plot_characters.characters);
  project.outline = normalizeSection("outline", SCRIPTS.submit_plot_outline);
  project.sample = { text: SAMPLE_TEXT };
  const markdown = projectToMarkdown(project);
  for (const fragment of [
    "# 长夜灯夫",
    "## 立意与主题",
    "## 世界观设定",
    "## 文风卡",
    "来源：AI 提议",
    "## 人物雏形",
    "陆灯生",
    "## 故事大纲",
    "半勺油",
    "## 开篇样章",
    "他把壶盖拧紧",
  ]) {
    assert.ok(markdown.includes(fragment), `markdown 缺少：${fragment}`);
  }
});

test("style analysis builder keeps the bake-side message shape", () => {
  const messages = buildStyleAnalysisMessages("范文正文");
  assert.equal(messages.length, 2);
  assert.equal(messages[0].role, "system");
  assert.equal(messages[0].content, STYLE_ANALYSIS_PROMPT);
  assert.equal(messages[1].content, "范文正文");
  // 七维字段口径一字不差（与 baker 抽出前的提示词一致）
  for (const field of ["narration", "tense", "sentence", "punctuation", "imagery", "diction", "chapterForm", "avoid"]) {
    assert.ok(STYLE_ANALYSIS_PROMPT.includes(field), field);
  }
});

/* ---------- PlotStore ---------- */

async function tempStore() {
  const directory = await mkdtemp(join(tmpdir(), "plot-store-"));
  return { store: new PlotStore(directory), directory };
}

test("plot store roundtrips create/list/load/save/rename/remove", async () => {
  const { store, directory } = await tempStore();
  try {
    await assert.rejects(() => store.create({ idea: "" }), /一句话点子/);
    const project = await store.create({ title: "长夜灯夫", idea: "灯夫守灯", genre: "玄幻" });
    assert.match(project.id, /^plot-[a-f0-9]{16}$/);

    project.premise = normalizeSection("premise", SCRIPTS.submit_plot_premise);
    const saved = await store.save(project);
    assert.equal(saved.premise.logline, SCRIPTS.submit_plot_premise.logline);

    const reloaded = await store.load(project.id);
    assert.equal(reloaded.premise.titles[0], "一盏之城");

    const list = await store.list();
    assert.equal(list.length, 1);
    assert.equal(list[0].title, "长夜灯夫");
    assert.equal(list[0].done.premise, true);
    assert.equal(list[0].done.sample, false);

    const renamed = await store.rename(project.id, "一盏之城");
    assert.equal(renamed.title, "一盏之城");
    await assert.rejects(() => store.rename(project.id, "  "), /名字不能为空/);

    await store.remove(project.id);
    assert.equal(await store.load(project.id), null);
    assert.deepEqual(await store.list(), []);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("plot store writes atomically and rejects path traversal ids", async () => {
  const { store, directory } = await tempStore();
  try {
    const project = await store.create({ idea: "灯夫守灯" });
    // 写盘后目录里只有 project.json，没有 tmp 残留
    const files = await readdir(join(directory, project.id));
    assert.deepEqual(files, ["project.json"]);
    const raw = JSON.parse(await readFile(join(directory, project.id, "project.json"), "utf8"));
    assert.equal(raw.version, 1);

    assert.throws(() => assertPlotId("../evil"), /无效的谋篇项目 ID/);
    assert.throws(() => assertPlotId("plot-XYZ"), /无效的谋篇项目 ID/);
    assert.equal(await store.load("../evil"), null);

    // 坏档读作不存在，且不删文件
    const bad = await store.create({ idea: "另一部" });
    const { writeFile } = await import("node:fs/promises");
    await writeFile(join(directory, bad.id, "project.json"), "{not json", "utf8");
    assert.equal(await store.load(bad.id), null);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("plot store save rejects structurally broken projects", async () => {
  const { store, directory } = await tempStore();
  try {
    await assert.rejects(() => store.save({ version: 9 }), /结构不完整/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
