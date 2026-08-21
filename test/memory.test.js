import assert from "node:assert/strict";
import test from "node:test";

import { LayeredMemory, retrieveMemories } from "../src/memory.js";
import { migrateState } from "../src/evolution.js";
import { world, initialState } from "../fixtures/world.js";

const turns = (count) =>
  Array.from({ length: count }, (_, index) => ({ number: index + 1, narrative: `第${index + 1}段。` }));

function countingMemory({ failFirst = 0 } = {}) {
  let calls = 0;
  const memory = new LayeredMemory({
    summarizer: async ({ previous, recent }) => {
      calls += 1;
      if (calls <= failFirst) throw new Error("模型错误");
      return `合并(${(previous ? previous.length : 0)}+${recent.length})`;
    },
  });
  return { memory, calls: () => calls };
}

test("窗口边界照常摘要并记账", async () => {
  const { memory, calls } = countingMemory();
  const state = { chapterSummary: "" };
  const updated = await memory.update(state, turns(5), { historyLength: 5 });
  assert.ok(updated.chapterSummary.startsWith("合并"));
  assert.equal(updated.memorySummarizedLength, 5);
  assert.equal(calls(), 1);
  // 未满下一窗:不动笔。
  const again = await memory.update(updated, turns(6), { historyLength: 6 });
  assert.equal(again, updated);
});

test("失败窗口不再被取模口径永久跳过", async () => {
  const { memory, calls } = countingMemory({ failFirst: 1 });
  const state = { chapterSummary: "" };
  // 第 5 回合摘要失败:返回原状态,不记账。
  const failed = await memory.update(state, turns(5), { historyLength: 5 });
  assert.equal(failed, state);
  // 下一回合(第 6 回合,非 5 的倍数)补窗:旧实现 % interval 会直接跳过,
  // 第 6-10 段从此缺席长期摘要。
  const recovered = await memory.update(state, turns(6), { historyLength: 6 });
  assert.ok(recovered.chapterSummary.startsWith("合并"), "失败后的下一回合补摘要");
  assert.equal(recovered.memorySummarizedLength, 6);
  assert.equal(calls(), 2);
});

test("windowFor:落后越多窗口越宽,补窗不丢段", async () => {
  const { memory } = countingMemory();
  assert.equal(memory.windowFor({ memorySummarizedLength: 0 }, 12), 12);
  assert.equal(memory.windowFor({ memorySummarizedLength: 10 }, 12), 2);
  assert.equal(memory.windowFor({ memorySummarizedLength: 10 }, 13), 3);
  // 未到期时窗口小于 interval,调用方切片无害(update 自会早退)。
  assert.equal(memory.windowFor({}, 2), 2);
});

test("windowFor 封顶 20 回:摘要连续失败不再把全史塞进单请求", async () => {
  // 摘要器/校验器连续驳回时 summarized 不再前进,无封顶的窗口会随回合数
  // 无限增长——token 爆炸使失败自强化。封顶后只补最近 20 回。
  const { memory } = countingMemory();
  assert.equal(memory.windowFor({ memorySummarizedLength: 0 }, 50), 20);
  assert.equal(memory.windowFor({ memorySummarizedLength: 0 }, 500), 20);
  assert.equal(memory.windowFor({ memorySummarizedLength: 45 }, 50), 5, "未到顶的窗口照常");
});

test("校验器驳回后重写失败保留旧摘要,但下一回合仍可补", async () => {
  let verdicts = 0;
  const memory = new LayeredMemory({
    summarizer: async () => "新摘要",
    verifier: async () => {
      verdicts += 1;
      return { ok: false, reason: "丢了关键信息" };
    },
  });
  const state = { chapterSummary: "旧摘要" };
  const failed = await memory.update(state, turns(5), { historyLength: 5 });
  assert.equal(failed, state, "校验不过保留旧摘要");
  assert.equal(verdicts, 2, "驳回后定向重写一次仍要过校验");
  const retried = await memory.update(state, turns(6), { historyLength: 6 });
  assert.equal(retried, state, "仍失败继续保留——但窗口没丢,修复后能补上");
});

/* —— 记忆分层（2026-08-21）：远期梗概折叠 + 检索重排 + 旧档迁移 —— */

function layeredWithDigest() {
  const seen = { digest: 0 };
  const memory = new LayeredMemory({
    summarizer: async ({ previous, recent }) => `中窗(${previous ? "续" : "新"}|${recent.length})`,
    digester: async ({ previous, evicted }) => {
      seen.digest += 1;
      return `远期[${(previous || "无").slice(0, 2)}+${(evicted || "无").slice(0, 2)}]`;
    },
    verifier: async () => ({ ok: true }),
  });
  return { memory, seen };
}

test("记忆分层:攒满折叠间隔后中窗并入远期梗概,中窗清零重建", async () => {
  const { memory, seen } = layeredWithDigest();
  const state = {
    chapterSummary: "一段积攒了很久的中窗摘要。",
    memorySummarizedLength: 15,
    digestSummarizedLength: 0,
    storyDigest: "",
  };
  const updated = await memory.update(state, turns(20), { historyLength: 20 });
  assert.equal(seen.digest, 1, "折叠器应被调用一次");
  assert.ok(updated.storyDigest.startsWith("远期["), "远期梗概已写入");
  assert.equal(updated.digestSummarizedLength, 15, "折叠记账推进到中窗覆盖位");
  assert.ok(updated.chapterSummary.startsWith("中窗(新"), "中窗从零重建(折叠后 previous 为空)");
  assert.equal(updated.memorySummarizedLength, 20, "中窗记账照常推进");
});

test("折叠校验不过:保留旧远期与旧中窗,记账不推进", async () => {
  const memory = new LayeredMemory({
    summarizer: async ({ previous }) => `中窗(${previous ? "续" : "新"})`,
    digester: async () => "有问题的远期稿",
    // 校验器只驳折叠稿(以「有问题的」开头),中窗摘要照常放行。
    verifier: async ({ candidate }) =>
      String(candidate).startsWith("有问题的") ? { ok: false, reason: "丢了关键信息" } : { ok: true },
  });
  const state = {
    chapterSummary: "旧中窗。",
    memorySummarizedLength: 15,
    digestSummarizedLength: 0,
    storyDigest: "旧远期。",
  };
  const updated = await memory.update(state, turns(20), { historyLength: 20 });
  assert.equal(updated.storyDigest, "旧远期。", "远期不动");
  assert.equal(updated.digestSummarizedLength, 0, "折叠记账不推进,下个触发点重试");
  assert.ok(updated.chapterSummary.startsWith("中窗(续"), "中窗回退为滚动合并");
});

test("折叠间隔未满不折叠;无 digester 时完全退化为旧的单层行为", async () => {
  const { memory, seen } = layeredWithDigest();
  const state = { chapterSummary: "中窗。", memorySummarizedLength: 5, digestSummarizedLength: 0 };
  const updated = await memory.update(state, turns(10), { historyLength: 10 });
  assert.equal(seen.digest, 0, "距上次折叠仅 5 回,未满 15 不动远期");
  assert.equal(updated.storyDigest, undefined);
  const single = new LayeredMemory({
    summarizer: async ({ previous }) => `中窗(${previous ? "续" : "新"})`,
  });
  const plain = await single.update(
    { chapterSummary: "旧。", memorySummarizedLength: 5 },
    turns(10),
    { historyLength: 10 },
  );
  assert.ok(plain.chapterSummary.startsWith("中窗(续"), "无 digester 时照旧滚动");
});

test("检索重排:在场人物名与未解伏笔提权,新近参与融合", () => {
  const memories = [
    { id: "a", type: "consequence", text: "潮痕线索指向盐仓的旧账。", importance: 2, status: "active", sourceTurn: 2 },
    { id: "b", type: "consequence", text: "林雾在灯下核对潮痕的来路。", importance: 2, status: "active", sourceTurn: 40 },
  ];
  const ranked = retrieveMemories(memories, "潮痕", 3, 5, {
    presentNames: ["林雾"],
    activeThreads: [],
    currentTurn: 42,
  });
  assert.equal(ranked[0].id, "b", "在场人物名命中应提权到首位");
  const again = retrieveMemories(memories, "潮痕", 3, 5, {
    presentNames: [],
    activeThreads: ["潮痕 旧账"],
    currentTurn: 0,
  });
  assert.equal(again[0].id, "a", "无重排信号时字面相关度照旧裁决");
});

test("旧档迁移:storyDigest 缺省为空,折叠记账与中窗记账对齐", () => {
  const migrated = migrateState(
    { ...structuredClone(initialState), chapterSummary: "旧摘要。", memorySummarizedLength: 12 },
    world,
  );
  assert.equal(migrated.storyDigest, "", "远期梗概从空开始");
  assert.equal(migrated.digestSummarizedLength, 12, "折叠记账对齐既有中窗记账:旧摘要先继续当中窗滚动");
});
