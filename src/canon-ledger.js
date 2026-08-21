// 正典账本（拍板 2026-08-20：连贯性修复——账本化+按需检索）。
// 烧制期的粗读摘要日志（cache/*.summaries.jsonl，每批一份 characters/locations/
// factions/events/facts 提取物）此前只在烧制时被裁剪消费（digestCoarse 4 万字符），
// 游玩期从不回读——超长书的正典细节在裁剪处不可逆丢失。本模块把这份日志
// 懒加载成两本可检索账（事实账 + 事件账），供回合上下文按需检索注入：
// 事实账扩大 retrievedFacts 的可召回面，事件账构成 canonHorizon（伏笔簿）。
// 原文细节不常驻上下文，但随时可回收——这就是「分层阅读」的检索层。

import { Bm25Index } from "./retrieval.js";

// 批提取工具的条目是自由对象（additionalProperties: true），不同模型回的字段名
// 不统一。按常见字段名依次取第一个非空字符串；一个字都取不到的条目直接丢弃。
const TEXT_KEYS = ["text", "fact", "content", "description", "summary", "note", "name"];
const CHAPTER_KEYS = ["chapter", "chapterAnchor", "chapters"];

// 账本条目上限：粗读按 5 万字/批，300 万字的书约 60 批、每批几十条——正常远够；
// 上限只防模型失控回出海量条目把索引构建拖成 O(百万级 token)。
const MAX_LEDGER_ENTRIES = 4000;
// 单条文本截断：账本条目是检索锚点不是正文，超长条目只挤兑回合上下文预算。
const MAX_ENTRY_CHARS = 120;

function cleanText(value) {
  return String(value ?? "").replace(/\s+/g, " ").trim();
}

function entryText(item) {
  if (typeof item === "string") return cleanText(item);
  if (!item || typeof item !== "object" || Array.isArray(item)) return "";
  for (const key of TEXT_KEYS) {
    const text = cleanText(item[key]);
    if (text) return text;
  }
  return "";
}

function entryChapter(item, batchEndChapter) {
  if (item && typeof item === "object" && !Array.isArray(item)) {
    for (const key of CHAPTER_KEYS) {
      const chapter = Number(item[key]);
      if (Number.isFinite(chapter) && chapter >= 1) return Math.floor(chapter);
    }
  } else if (Number.isFinite(Number(item))) {
    const chapter = Number(item);
    if (chapter >= 1) return Math.floor(chapter);
  }
  // 条目自带不了章号时挂到批次末章：到期窗口按「锚章之后」过滤，挂末章只会
  // 让该条晚进窗口，不会把早已过去的事漏进「将至」。
  return batchEndChapter ?? null;
}

function normalizedKey(text) {
  return text.replace(/\s+/g, "");
}

export class CanonLedger {
  constructor({ facts = [], events = [] } = {}) {
    this.facts = facts;
    this.events = events;
    this.factIndex = facts.length ? new Bm25Index(facts) : null;
    this.eventIndex = events.length ? new Bm25Index(events) : null;
  }

  get size() {
    return this.facts.length + this.events.length;
  }

  // 事实账检索：返回 {id,text,chapter} 条目，供 retrievedFacts 并列注入。
  searchFacts(query, { limit = 6 } = {}) {
    if (!this.factIndex || !query) return [];
    return this.factIndex.search(query, { limit });
  }

  // 伏笔簿（canonHorizon）：锚章之后的账本事件，两条召回路径——
  // ① 到期窗口：锚章之后最近的若干条（事件按章升序预排，取头部）；
  // ② 相关性补召：以当前处境检索词 BM25 补齐余量，专治长线伏笔
  //    （「前 8 条将至」永远轮不到几十章后到期、但此刻正相关的旧线）。
  // 与 canonUpcoming 的分工：canonUpcoming 是带故事时间的权威时间线（烧制
  // threads 片产出，条数有限）；本账本是全书粗读的长尾，只作走向参考。
  horizon({ anchorChapter = 1, query = "", limit = 6 } = {}) {
    if (!this.events.length) return [];
    const anchor = Number(anchorChapter) || 1;
    const future = this.events.filter((event) => event.chapter != null && event.chapter > anchor);
    if (!future.length) return [];
    const windowSize = Math.max(1, Math.ceil(limit / 2));
    const dueWindow = future.slice(0, windowSize);
    const dueIds = new Set(dueWindow.map((event) => event.id));
    const relevant =
      query && this.eventIndex
        ? this.eventIndex.search(query, {
            limit: Math.max(0, limit - dueWindow.length),
            filter: (document) =>
              document.chapter != null &&
              document.chapter > anchor &&
              !dueIds.has(document.id),
          })
        : [];
    return [...dueWindow, ...relevant];
  }
}

// 从烧制缓存构建账本：groups 是批次划分（batches(chapters) 的产物，与烧制同参
// 同序），summaries 是按批索引的提取物数组（loadSummaries 的产物）。两者对齐
// 即可还原每条的章节归属——条目自带章号用自带的，否则挂批次末章。
export function buildCanonLedger({ groups = [], summaries = [] }) {
  const facts = [];
  const events = [];
  const seenFacts = new Set();
  const seenEvents = new Set();
  const push = (target, seen, { id, text, chapter }) => {
    const key = normalizedKey(text);
    if (!key || seen.has(key)) return;
    seen.add(key);
    target.push({ id, text, chapter });
  };
  for (const [index, group] of groups.entries()) {
    const summary = summaries[index];
    if (!summary || typeof summary !== "object") continue;
    const batchEndChapter = group.at(-1)?.index ?? null;
    for (const item of Array.isArray(summary.facts) ? summary.facts : []) {
      if (facts.length >= MAX_LEDGER_ENTRIES) break;
      const text = entryText(item).slice(0, MAX_ENTRY_CHARS);
      if (text.length < 4) continue;
      push(facts, seenFacts, {
        id: `ledger-fact-${facts.length}`,
        text,
        chapter: entryChapter(item, batchEndChapter),
      });
    }
    for (const item of Array.isArray(summary.events) ? summary.events : []) {
      if (events.length >= MAX_LEDGER_ENTRIES) break;
      const text = entryText(item).slice(0, MAX_ENTRY_CHARS);
      if (text.length < 4) continue;
      push(events, seenEvents, {
        id: `ledger-event-${events.length}`,
        text,
        chapter: entryChapter(item, batchEndChapter),
      });
    }
    if (facts.length >= MAX_LEDGER_ENTRIES && events.length >= MAX_LEDGER_ENTRIES) break;
  }
  // 事件按章升序：到期窗口的「锚章之后最近若干条」直接取头部。
  events.sort((left, right) => (left.chapter ?? Infinity) - (right.chapter ?? Infinity));
  return new CanonLedger({ facts, events });
}
