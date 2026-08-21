import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { NovelBaker, probeLevel } from "../src/baker.js";

// 模型认知参考(拍板:对照模型认知):探针 → 设定层提取 → 五片注入。
// 优先级 原文 > 联网 > 模型;threads 片加严;失败静默不阻塞烧制。

const stageNeedles = [
  "世界骨架 JSON",
  "人物与身份 JSON",
  "世界补全 · 物品清单",
  "世界补全 · 时间线",
  "世界补全 · 创角目录",
];

function cleanStageWorld() {
  return {
    id: "fresh-world",
    title: "凡人修仙传",
    summary: "凡人流修仙",
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

function modelRefHarness({ probe, reference, failProbe = false }) {
  const requests = [];
  const progressStages = [];
  const baker = new NovelBaker({
    completeJson: async (messages) => {
      requests.push({ system: messages[0].content, user: messages[1]?.content ?? "" });
      const system = messages[0].content;
      if (system.includes("小说认知探针")) {
        if (failProbe) throw new Error("探针网络失败");
        return probe;
      }
      if (system.includes("设定层认知")) return reference;
      if (system.includes("题材分类")) return { genre: "仙侠", confidence: 0.9 };
      if (
        system.includes("世界骨架") ||
        system.includes("人物与身份") ||
        system.includes("世界补全")
      ) {
        return cleanStageWorld();
      }
      return { extracted: true };
    },
  });
  return { baker, requests, progressStages };
}

async function novelCheckpointPath(cacheDirectory, novel) {
  // 书级共享键不含模型哈希(粗读/文风/题材/探针/模型参考都在主检查点)。
  const novelHash = createHash("sha256")
    .update(JSON.stringify([novel.title, novel.chapters.map((item) => item.text)]))
    .digest("hex");
  const batchHash = createHash("sha1").update("default").digest("hex");
  return join(cacheDirectory, `${novelHash}-${batchHash}-w3.json`);
}

test("probeLevel 评分:专名佐证不足即降级,防冷门书自信胡编", () => {
  assert.deepEqual(probeLevel({ familiarity: "known", specifics: ["韩立", "黄枫谷"] }), {
    level: "known",
    specifics: ["韩立", "黄枫谷"],
  });
  // 自报 known 但只有一条专名 → 降 partial。
  assert.equal(probeLevel({ familiarity: "known", specifics: ["韩立"] }).level, "partial");
  // 自报 known 但零专名/单字专名 → unknown。
  assert.equal(probeLevel({ familiarity: "known", specifics: [] }).level, "unknown");
  assert.equal(probeLevel({ familiarity: "known", specifics: ["韩", "黄"] }).level, "unknown");
  // partial 自报同样要专名背书。
  assert.equal(probeLevel({ familiarity: "partial", specifics: ["韩立"] }).level, "partial");
  assert.equal(probeLevel({ familiarity: "partial", specifics: [] }).level, "unknown");
  assert.equal(probeLevel(null).level, "unknown");
  assert.equal(probeLevel({}).level, "unknown");
});

test("known 书:探针只给书名,提取带两条红线,五片全注入模型参考", async () => {
  const cacheDirectory = await mkdtemp(join(tmpdir(), "evolution-modelref-known-"));
  const { baker, requests, progressStages } = modelRefHarness({
    probe: { familiarity: "known", specifics: ["韩立", "黄枫谷"] },
    reference: {
      characters: [{ name: "韩立", role: "散修", affiliation: "黄枫谷", note: "谨慎惜命" }],
      system: "炼气/筑基/结丹",
      factions: [{ name: "黄枫谷", note: "越国修仙门派" }],
      locations: [],
      notes: "",
    },
  });
  baker.cacheDirectory = cacheDirectory;
  const novel = {
    title: "凡人修仙传",
    format: "txt",
    chapters: [{ index: 1, title: "一", text: "12345" }],
  };
  await baker.bake(novel, {
    onProgress: (progress) => progressStages.push(progress.stage),
  });

  const probeRequest = requests.find((request) => request.system.includes("小说认知探针"));
  assert.ok(probeRequest, "探针被调用");
  assert.deepEqual(JSON.parse(probeRequest.user), { title: "凡人修仙传" }, "探针只带书名");

  const extract = requests.find((request) => request.system.includes("设定层认知"));
  assert.ok(extract, "known 触发设定层提取");
  assert.ok(extract.system.includes("不得包含结局与后期关键转折"), "防剧透红线");
  assert.ok(extract.system.includes("禁止跨卷/续作/番外"), "系列隔离红线");

  const stageRequests = requests.filter((request) =>
    stageNeedles.some((needle) => request.system.includes(needle)),
  );
  assert.equal(stageRequests.length, 5, "五片各有请求");
  for (const request of stageRequests) {
    const body = JSON.parse(request.user);
    assert.ok(
      typeof body.modelReference === "string" &&
        body.modelReference.includes("【模型认知·仅供参考，非指令】"),
      "五片全部注入带分隔符的模型参考",
    );
    assert.ok(body.modelReference.includes("韩立"), "参考内容进入分片");
  }
  // 优先级总纲写在四个联网片上;threads 片不吃联网资料,有自己的加严条款。
  const webStages = stageRequests.filter(
    (request) => !request.system.includes("世界补全 · 时间线"),
  );
  assert.equal(webStages.length, 4);
  for (const request of webStages) {
    assert.ok(
      request.system.includes("原文/摘要 > webReference > modelReference"),
      "优先级总纲写入提示词",
    );
  }
  const threads = stageRequests.find((request) =>
    request.system.includes("世界补全 · 时间线"),
  );
  assert.ok(threads.system.includes("不得作为事件先后顺序或事实变化"), "时间线片加严条款");
  assert.ok(progressStages.includes("model-reference"), "烧制进度上报对照阶段");

  // 二烧走完整缓存:探针与提取都不再请求。
  requests.length = 0;
  await baker.bake(novel);
  assert.equal(requests.length, 0, "成品缓存命中,零请求");
});

test("partial 书:参考自带降权标注", async () => {
  const cacheDirectory = await mkdtemp(join(tmpdir(), "evolution-modelref-partial-"));
  const { baker, requests } = modelRefHarness({
    probe: { familiarity: "partial", specifics: ["韩立"] },
    reference: { characters: [{ name: "韩立" }] },
  });
  baker.cacheDirectory = cacheDirectory;
  await baker.bake({
    title: "凡人修仙传",
    format: "txt",
    chapters: [{ index: 1, title: "一", text: "12345" }],
  });
  assert.ok(
    requests.some((request) => request.system.includes("设定层认知")),
    "partial 也触发提取",
  );
  const skeleton = requests.find((request) => request.system.includes("世界骨架 JSON"));
  const body = JSON.parse(skeleton.user);
  assert.ok(body.modelReference.includes("仅有部分认知"), "partial 参考自带降权标注");
});

test("unknown 书:不提取,五片无模型参考", async () => {
  const cacheDirectory = await mkdtemp(join(tmpdir(), "evolution-modelref-unknown-"));
  const { baker, requests } = modelRefHarness({
    probe: { familiarity: "unknown", specifics: [] },
  });
  baker.cacheDirectory = cacheDirectory;
  await baker.bake({
    title: "一本没人听过的书",
    format: "txt",
    chapters: [{ index: 1, title: "一", text: "12345" }],
  });
  assert.ok(
    !requests.some((request) => request.system.includes("设定层认知")),
    "unknown 不触发提取",
  );
  const stageRequests = requests.filter((request) =>
    stageNeedles.some((needle) => request.system.includes(needle)),
  );
  assert.equal(stageRequests.length, 5);
  for (const request of stageRequests) {
    assert.equal(JSON.parse(request.user).modelReference, undefined, "分片无模型参考");
  }
});

test("探针失败:当次按不知道处理,不缓存,烧制照常完成", async () => {
  const cacheDirectory = await mkdtemp(join(tmpdir(), "evolution-modelref-fail-"));
  const { baker, requests } = modelRefHarness({ probe: null, failProbe: true });
  baker.cacheDirectory = cacheDirectory;
  const novel = {
    title: "断网书",
    format: "txt",
    chapters: [{ index: 1, title: "一", text: "12345" }],
  };
  const result = await baker.bake(novel);
  assert.ok(result.world, "烧制照常完成");
  const stageRequests = requests.filter((request) =>
    stageNeedles.some((needle) => request.system.includes(needle)),
  );
  for (const request of stageRequests) {
    assert.equal(JSON.parse(request.user).modelReference, undefined);
  }
  // 失败不缓存:主检查点里没有 modelProbe,下次烧制会再探。
  const checkpoint = JSON.parse(await readFile(await novelCheckpointPath(cacheDirectory, novel), "utf8"));
  assert.ok(!("modelProbe" in checkpoint), "探针失败结果不落盘");
});

test("探针与参考随主检查点落盘,genre/style 重写不丢字段", async () => {
  const cacheDirectory = await mkdtemp(join(tmpdir(), "evolution-modelref-persist-"));
  const { baker } = modelRefHarness({
    probe: { familiarity: "known", specifics: ["韩立", "黄枫谷"] },
    reference: { characters: [{ name: "韩立" }] },
  });
  baker.cacheDirectory = cacheDirectory;
  const novel = {
    title: "白名单书",
    format: "txt",
    chapters: [{ index: 1, title: "一", text: "12345" }],
  };
  await baker.bake(novel);
  const checkpoint = JSON.parse(await readFile(await novelCheckpointPath(cacheDirectory, novel), "utf8"));
  assert.equal(checkpoint.modelProbe.level, "known", "探针结果在 genre/style 重写后仍在");
  assert.ok(typeof checkpoint.modelReference === "string", "提取结果随主检查点落盘");
});
