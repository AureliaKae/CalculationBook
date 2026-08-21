import assert from "node:assert/strict";
import test from "node:test";

import { buildCanonLedger, CanonLedger } from "../src/canon-ledger.js";

function group(...indexes) {
  return indexes.map((index) => ({ index, title: `第${index}章`, text: "正文".repeat(50) }));
}

test("buildCanonLedger 汇集事实与事件，条目自带章号优先、缺失挂批次末章", () => {
  const ledger = buildCanonLedger({
    groups: [group(1, 2, 3), group(4, 5)],
    summaries: [
      {
        facts: [
          { text: "灯塔守夜人在雾夜失踪。", chapter: 2 },
          { fact: "黑铃从不被海风吹响。" },
        ],
        events: [{ text: "守夜人归来盐仓。", chapter: 4 }],
      },
      { facts: [{ content: "地窖藏着断粮的真相。" }], events: [{ summary: "商队抵达灯塔。" }] },
    ],
  });
  assert.equal(ledger.facts.length, 3);
  assert.equal(ledger.events.length, 2);
  // 自带章号用自带的；缺失挂批次末章（第 3 章 / 第 5 章）。
  assert.deepEqual(
    ledger.facts.map((fact) => [fact.text, fact.chapter]),
    [
      ["灯塔守夜人在雾夜失踪。", 2],
      ["黑铃从不被海风吹响。", 3],
      ["地窖藏着断粮的真相。", 5],
    ],
  );
  // 事件按章升序预排，供 horizon 的到期窗口直接取头部。
  assert.deepEqual(ledger.events.map((event) => event.chapter), [4, 5]);
});

test("buildCanonLedger 容忍退化输入：字符串条目、空批、重复文本去重", () => {
  const ledger = buildCanonLedger({
    groups: [group(1), group(2)],
    summaries: [
      { facts: ["黑铃从不被海风吹响。", { text: "黑铃从不被海风吹响。" }, "太短" ], events: [] },
      null,
    ],
  });
  // 重复文本（字符串与对象各一）只留一条；过短条目丢弃；空批跳过。
  assert.equal(ledger.facts.length, 1);
  assert.equal(ledger.events.length, 0);
});

test("searchFacts 按查询召回账本事实", () => {
  const ledger = buildCanonLedger({
    groups: [group(1)],
    summaries: [
      {
        facts: [
          { text: "灯塔守夜人在雾夜失踪。", chapter: 1 },
          { text: "盐仓的账簿被人涂改。", chapter: 1 },
        ],
        events: [],
      },
    ],
  });
  const hits = ledger.searchFacts("守夜人 灯塔 失踪", { limit: 2 });
  assert.equal(hits.length, 1);
  assert.match(hits[0].text, /守夜人/);
  assert.equal(ledger.searchFacts("", { limit: 2 }).length, 0);
});

test("horizon 到期窗口取锚章之后最近的事件，相关性补召长线伏笔", () => {
  const ledger = buildCanonLedger({
    groups: [group(1, 2, 3, 4, 5, 6)],
    summaries: [
      {
        facts: [],
        events: [
          { text: "商队抵达盐仓。", chapter: 4 },
          { text: "灯塔换防。", chapter: 5 },
          { text: "黑铃再响。", chapter: 6 },
          { text: "守夜人与盐商的旧契曝光。", chapter: 50 },
          { text: "守夜人初到灰港。", chapter: 1 },
        ],
      },
    ],
  });
  const horizon = ledger.horizon({ anchorChapter: 3, query: "守夜人 契据 盐商", limit: 6 });
  // 锚章之前的事件（第 1 章）不得进入「将至」；窗口 3 条 + 相关补召 1 条。
  assert.deepEqual(
    horizon.map((event) => event.chapter),
    [4, 5, 6, 50],
  );
  assert.ok(horizon.at(-1).text.includes("旧契"));
});

test("horizon 锚章之后无事件时返回空；空账本恒空", () => {
  const ledger = buildCanonLedger({ groups: [group(1)], summaries: [{ events: [{ text: "旧事。", chapter: 1 }] }] });
  assert.equal(ledger.horizon({ anchorChapter: 5, query: "旧事", limit: 6 }).length, 0);
  assert.equal(new CanonLedger().horizon({ anchorChapter: 1, query: "x", limit: 6 }).length, 0);
});
