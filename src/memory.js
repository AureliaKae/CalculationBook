import { Bm25Index } from "./retrieval.js";

// 结构化记忆上限：consequence/relationship 记忆每个回合都会追加，只增不减的话，
// 长局里 retrieveMemories 每回合重建 BM25 索引的开销会线性恶化。
// 按重要度优先、其次新近优先修剪，事件与伏笔类高重要度记忆通常能留下。
const MAX_MEMORIES = 120;

function memoryId(type, sourceId) {
  return `${type}:${sourceId}`;
}

export function updateStructuredMemories(state, turn) {
  const memories = new Map(
    (state.longTermMemories ?? []).map((memory) => [memory.id, structuredClone(memory)]),
  );
  const write = (memory) => memories.set(memory.id, memory);
  for (const event of turn.dueEvents ?? []) {
    write({
      id: memoryId("event", event.id),
      sourceId: event.id,
      type: "event",
      text: event.text,
      importance: 3,
      chapterAnchor: event.chapterAnchor ?? state.unlockedChapter,
      status: state.eventStates?.[event.id]?.status ?? "delivered",
      sourceTurn: turn.number,
    });
  }
  for (const thread of turn.openThreads ?? []) {
    write({
      id: memoryId("thread", thread),
      type: "thread",
      text: thread,
      importance: 2,
      chapterAnchor: state.unlockedChapter,
      status: state.resolvedThreads?.includes(thread) ? "resolved" : "active",
      sourceTurn: turn.number,
    });
  }
  for (const consequence of turn.consequences ?? []) {
    write({
      id: memoryId("consequence", `${turn.number}:${consequence.statId}`),
      type: "consequence",
      text: consequence.consequence,
      importance: 3,
      chapterAnchor: state.unlockedChapter,
      status: "active",
      sourceTurn: turn.number,
    });
  }
  for (const change of turn.relationshipChanges ?? []) {
    const target = `${change.targetType}:${change.targetId}`;
    const summary = ["trust", "fear", "hostility"]
      .filter((field) => change[field])
      .map((field) => `${field}${change[field] > 0 ? "+" : ""}${change[field]}`)
      .join(" ");
    if (!summary) continue;
    write({
      id: memoryId("relationship", `${turn.number}:${target}`),
      type: "relationship",
      text: `${target} ${summary}`,
      importance: 2,
      chapterAnchor: state.unlockedChapter,
      status: "active",
      sourceTurn: turn.number,
    });
  }
  for (const memory of memories.values()) {
    if (memory.type === "thread" && state.resolvedThreads?.includes(memory.text)) {
      memory.status = "resolved";
    }
    if (memory.type === "event") {
      memory.status = state.eventStates?.[memory.sourceId]?.status ?? memory.status;
    }
  }
  const sorted = [...memories.values()].sort(
    (left, right) =>
      (right.importance ?? 0) - (left.importance ?? 0) ||
      (right.sourceTurn ?? 0) - (left.sourceTurn ?? 0),
  );
  return sorted.slice(0, MAX_MEMORIES);
}

// 检索记忆：玩家已读完小说（拍板 2026-08-17：未解锁章节一律不过滤），
// 章节不再作为可见性门槛，只排除已失效记忆。
// 重排（2026-08-21 记忆分层轮）：BM25 只认字面，转述会漏——命中之后用
// 新近度/重要度/在场人物名/未解伏笔做代码级融合重排，纯本地零成本。
export function retrieveMemories(
  memories,
  query,
  unlockedChapter,
  limit = 5,
  { presentNames = [], activeThreads = [], currentTurn = 0 } = {},
) {
  const visible = (memories ?? []).filter((memory) => memory.status !== "invalidated");
  if (!visible.length) return [];
  const ranked = new Bm25Index(visible).search(query, { limit: limit * 2 });
  const nameSet = new Set(presentNames.filter(Boolean));
  const threadTerms = activeThreads.flatMap((thread) => String(thread ?? "").split(/\s+/)).filter(Boolean);
  return ranked
    .map((memory) => {
      const text = String(memory.text ?? "");
      const presentBoost = [...nameSet].some((name) => name && text.includes(name)) ? 1.5 : 0;
      const threadBoost = threadTerms.some((term) => term.length >= 2 && text.includes(term)) ? 1.2 : 0;
      const recency = currentTurn ? Math.max(0, 1 - (currentTurn - (memory.sourceTurn ?? 0)) / 60) : 0;
      const fused =
        memory.score * (1 + presentBoost + threadBoost) + recency + (memory.importance ?? 0) * 0.05;
      return { ...memory, score: fused };
    })
    // 相关性优先、重要度作平局裁决：重要度排序在前会把高重要度的陈旧记忆
    // 排到强相关的新记忆前面，破坏检索语义。
    .sort((left, right) => right.score - left.score || right.importance - left.importance)
    .slice(0, limit);
}

export class LayeredMemory {
  constructor({ summarizer, verifier, digester = null, interval = 5, digestInterval = 15 }) {
    this.summarizer = summarizer;
    this.verifier = verifier;
    // 远期梗概合并器（记忆分层 2026-08-21）：无 digester（mock/无快通道）时
    // 分层退化为旧的单条滚动摘要，行为完全向后兼容。
    this.digester = digester;
    this.interval = interval;
    this.digestInterval = digestInterval;
  }

  // 下一次摘要应覆盖的回数（自上次成功摘要起）：错过窗口时它会大于 interval，
  // 调用方按它切历史，别固定 slice(-interval)——错过的窗口要并进同一次摘要补上。
  // 封顶 20 回（D14,2026-08-19）：摘要器/校验器连续失败时窗口会随回合无限
  // 增长，把整段历史塞进单个快模型请求——token 爆炸使失败自强化。到顶后
  // 只补最近 20 回，更早的留待摘要恢复后按记账逐窗补。
  windowFor(state, historyLength) {
    const summarized = Number(state?.memorySummarizedLength ?? 0);
    return Math.max(1, Math.min(Math.max(0, historyLength - summarized), historyLength, 20));
  }

  async update(state, history, options = {}) {
    const historyLength = options.historyLength ?? history.length;
    // 到期与补账以 memorySummarizedLength 记账，不用 % interval：某个窗口失败
    // （模型错误/校验拒绝）后，取模口径会把那一窗永远跳过去——长期摘要从此缺
    // 一段，误差在后续每次合并里逐层复合。记账口径下，失败的窗口在下一回合
    // 会连着新回合一起补摘要。
    const summarized = Number(state.memorySummarizedLength ?? 0);
    if (!historyLength || historyLength - summarized < this.interval) return state;
    let working = { ...state };
    // —— 远期折叠（记忆分层 2026-08-21）：自上次折叠起又攒满 digestInterval
    // 回已被中窗摘要覆盖的历史时，把当前中窗摘要并入远期梗概，随后中窗清空
    // 重建——从此「远期靠 digest、中观靠 chapterSummary、近期靠原文」三层
    // 各司其职，不再由一条滚动摘要扛全部历史。折叠同样走 critic-gated：
    // 校验不过保留旧 digest 与旧中窗，下个触发点整体重试（记账不推进）。
    const digestCovered = Number(state.digestSummarizedLength ?? 0);
    if (
      this.digester &&
      summarized - digestCovered >= this.digestInterval &&
      String(state.chapterSummary ?? "").trim()
    ) {
      try {
        let digest = await this.digester({
          previous: String(state.storyDigest ?? ""),
          evicted: String(state.chapterSummary ?? ""),
        });
        if (typeof digest === "string" && digest.trim()) {
          if (this.verifier) {
            const verdict = await this.verifier({
              previous: String(state.storyDigest ?? ""),
              recent: String(state.chapterSummary ?? ""),
              candidate: digest,
            });
            if (verdict && verdict.ok !== true) {
              const retried = await this.digester({
                previous: String(state.storyDigest ?? ""),
                evicted: String(state.chapterSummary ?? ""),
                correction: verdict.reason ?? "存在冲突或关键信息丢失",
              });
              const second = await this.verifier({
                previous: String(state.storyDigest ?? ""),
                recent: String(state.chapterSummary ?? ""),
                candidate: retried,
              });
              if (!(typeof retried === "string" && retried.trim() && second?.ok === true)) {
                digest = null;
              } else {
                digest = retried;
              }
            }
          }
          if (typeof digest === "string" && digest.trim()) {
            working = {
              ...working,
              storyDigest: digest,
              chapterSummary: "",
              digestSummarizedLength: summarized,
            };
          }
        }
      } catch {
        // 折叠失败静默降级：本轮照旧走中窗滚动，下个触发点再试。
      }
    }
    const recentHistory = options.recentHistory ?? history.slice(-this.interval);
    const recent = recentHistory.map((turn) => turn.narrative).join("\n");
    const previous = working.chapterSummary;
    try {
      let chapterSummary = await this.summarizer({ previous, recent });
      if (typeof chapterSummary !== "string" || !chapterSummary.trim()) return state;
      // 写入门槛（critic-gated write）：摘要只许压缩、不许改写事实。校验器发现
      // 实质冲突或关键信息丢失时，带原因定向修一次；修不好就保留旧摘要——
      // 宁可记忆少一点，也不能把错误写进长期记忆（摘要污染会逐层复合放大）。
      // （折叠后 previous 为空：中窗从零重建，校验只对 recent 负责。）
      if (this.verifier) {
        const verdict = await this.verifier({ previous, recent, candidate: chapterSummary });
        if (verdict && verdict.ok !== true) {
          const retried = await this.summarizer({
            previous,
            recent,
            correction: verdict.reason ?? "存在冲突或关键信息丢失",
          });
          const second = await this.verifier({ previous, recent, candidate: retried });
          if (typeof retried === "string" && retried.trim() && second?.ok === true) {
            chapterSummary = retried;
          } else {
            return state;
          }
        }
      }
      return { ...working, chapterSummary, memorySummarizedLength: historyLength };
    } catch {
      return state;
    }
  }
}
