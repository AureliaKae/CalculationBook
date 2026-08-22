import assert from "node:assert/strict";
import { mkdtemp, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { batches, NovelBaker, selectCoarseGroups } from "../src/baker.js";
import { submitBatchExtractTool } from "../src/structured-tools.js";

/* ============ selectCoarseGroups 单元 ============ */

function groupsOf(batchCount, charsPerBatch = 10) {
  const chapters = Array.from({ length: batchCount }, (_, index) => ({
    index: index + 1,
    title: String(index + 1),
    text: "x".repeat(charsPerBatch),
  }));
  return batches(chapters, charsPerBatch);
}

const sumChars = (groups, picked) =>
  [...picked].reduce((total, index) => total + groups[index].reduce((n, c) => n + c.text.length, 0), 0);

test("selectCoarseGroups:预算缺失/非正数/装得下全书都退化为全读", () => {
  const groups = groupsOf(10);
  assert.equal(selectCoarseGroups(groups).size, 10);
  assert.equal(selectCoarseGroups(groups, { budgetChars: 0 }).size, 10);
  assert.equal(selectCoarseGroups(groups, { budgetChars: -5 }).size, 10);
  assert.equal(selectCoarseGroups(groups, { budgetChars: Number.NaN }).size, 10);
  assert.equal(selectCoarseGroups(groups, { budgetChars: 10_000 }).size, 10, "预算覆盖全书=全读");
});

test("selectCoarseGroups:首尾与切入窗口必保,其余等距铺开且不超预算", () => {
  const groups = groupsOf(10); // 每批 10 字,全书 100 字
  const picked = selectCoarseGroups(groups, { budgetChars: 50, focusChapter: 1 });
  assert.ok(picked.has(0), "首批必读");
  assert.ok(picked.has(9), "末批必读");
  assert.ok(picked.has(1), "切入窗口(焦点批的邻批)必读");
  assert.ok(picked.size >= 4 && picked.size < 10, "采样应选中一部分批次");
  assert.ok(sumChars(groups, picked) <= 50, "选中批次总字数不得超预算");
});

test("selectCoarseGroups:切入章在书中时,焦点批及其前后各一批必读", () => {
  const groups = groupsOf(10);
  const picked = selectCoarseGroups(groups, { budgetChars: 80, focusChapter: 5 });
  // 焦点章 5 落在第 4 批(0 起),邻批 3/4/5 都必须在。
  for (const index of [3, 4, 5]) {
    assert.ok(picked.has(index), `焦点批 ${index} 必读`);
  }
});

test("selectCoarseGroups:预算连必读批次都装不下时只保必读", () => {
  const groups = groupsOf(10); // 必读 {0,1,9} 已 30 字
  const picked = selectCoarseGroups(groups, { budgetChars: 5, focusChapter: 1 });
  assert.deepEqual([...picked].sort((a, b) => a - b), [0, 1, 9]);
});

/* ============ 采样起稿 → 补读 全流程 ============ */

function sampledBakeWorld() {
  return {
    id: "sampled-world",
    title: "采样书",
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

test("采样起稿只读选中批次,落采样元数据;补读只烧缺口并重建五片", async () => {
  const cacheDirectory = await mkdtemp(join(tmpdir(), "coarse-sampling-"));
  const coarseChapters = [];
  let stageCalls = 0;
  const completeJson = async (messages) => {
    const prompt = messages[0].content;
    if (prompt.includes("提取小说片段")) {
      coarseChapters.push(JSON.parse(messages[1].content)[0].chapter);
      return { extracted: true };
    }
    if (prompt.includes("世界骨架") || prompt.includes("人物与身份") || prompt.includes("世界补全")) {
      stageCalls += 1;
      return sampledBakeWorld();
    }
    return {};
  };
  const baker = new NovelBaker({ cacheDirectory, completeJson, batchCharacters: 1 });
  const novel = {
    title: "采样书",
    format: "txt",
    // 6 章 × 1 字 = 6 批;预算 3 字 → 必读 {0,1,5}(首/焦点窗/末),容量耗尽。
    chapters: [1, 2, 3, 4, 5, 6].map((index) => ({ index, title: `${index}`, text: `${index}` })),
  };
  const progressEvents = [];
  const first = await baker.bake(novel, {
    focusChapter: 1,
    coarseBudgetChars: 3,
    onProgress: (event) => progressEvents.push(event),
  });

  assert.deepEqual([...coarseChapters].sort(), [1, 2, 6], "只读首/焦点窗/末三批");
  assert.deepEqual(first.world.coarse, { sampled: true, groupsRead: 3, groupsTotal: 6, budgetChars: 3 });
  assert.ok(
    progressEvents.some((event) => event.stage === "coarse" && event.total === 3),
    "粗读进度口径是选中批次数",
  );
  // 采样烧制的 focus 检查点带覆盖度段(文件名 6 段)。
  const sampledFocus = (await readdir(cacheDirectory)).filter(
    (name) => name.includes("-w3-1-") && name.endsWith(".json"),
  );
  assert.equal(sampledFocus.length, 1, "采样 focus 文件带覆盖度哈希");

  // 同预算重进:命中 complete 缓存,零请求原样返回。
  const callsBefore = coarseChapters.length;
  const stagesBefore = stageCalls;
  const cached = await baker.bake(novel, { focusChapter: 1, coarseBudgetChars: 3 });
  assert.equal(coarseChapters.length, callsBefore, "同预算重进不重读");
  assert.equal(stageCalls, stagesBefore, "同预算重进不重建世界");
  assert.equal(cached.world.id, first.world.id);

  // 补读(全本预算):只烧 3/4/5 三批缺口,五片重建,采样标记消失。
  stageCalls = 0;
  const topped = await baker.bake(novel, { focusChapter: 1 });
  assert.deepEqual([...coarseChapters].sort(), [1, 2, 3, 4, 5, 6], "补读只烧缺的三批");
  assert.ok(stageCalls >= 5, "覆盖度键变化后五片重建");
  assert.equal(topped.world.coarse, undefined, "烧满后不再落采样标记");
  // 补读的 focus 检查点回到全本旧命名(5 段),兼容既有缓存习惯。
  const files = await readdir(cacheDirectory);
  assert.ok(
    files.some((name) => /-w3-1\.json$/.test(name)),
    "全本 focus 文件沿用旧命名",
  );
});

/* ============ 粗读工具输出瘦身 ============ */

test("粗读工具 schema 限条数与摘要长度(输出瘦身)", () => {
  const tool = submitBatchExtractTool();
  const properties = tool.function.parameters.properties;
  for (const key of ["characters", "locations", "factions", "events", "facts"]) {
    assert.equal(properties[key].maxItems, 12, `${key} 至多 12 条`);
    assert.match(properties[key].description, /最重要的/, `${key} 描述带取舍指引`);
  }
  assert.match(properties.summary.description, /三百字/);
});
