import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "./lib/bridge.js";
import { mapTerms } from "./lib/terms.js";
import { bakePercent } from "./lib/engine-display.js";
import { classifyBakeError, classifyTurnError } from "../../src/client.js";
import { DENSITY } from "./mock.js";
import Reading from "./components/Reading.jsx";
import Desk from "./components/Desk.jsx";
import Gate from "./components/Gate.jsx";
import Creation from "./components/Creation.jsx";
import Studio from "./components/Studio.jsx";
import Plotting from "./components/Plotting.jsx";
import BakeHud from "./components/BakeHud.jsx";
import ConfirmDialog from "./components/ConfirmDialog.jsx";
import Chronicle from "./components/Chronicle.jsx";
import FadeIn from "./components/FadeIn.jsx";
import { WorldExportDialog, WorldImportDialog } from "./components/WorldShareDialog.jsx";

/* 面路由器 + 桥接编排：desk → creation → reading；reading ↔ map / studio；
   起稿 HUD 全局常驻；首启未就绪锁文房（配墨）。 */

/* 主进程抛来的回合错误先翻译再给玩家看：剥掉 Electron 的
   「Error invoking remote method 'x':」外壳（IPC 还会抹掉原始 error.name，
   从 message 里找回来），再交给回合错误分类器拼「标题——建议」，
   认不出才回退原始文案。 */
function describeTurnError(error) {
  const message = String(error?.message ?? "").replace(/^Error invoking remote method '[^']+':\s*/, "");
  let name = error?.name === "Error" ? "" : String(error?.name ?? "");
  if (!name && /AbortError|operation was aborted/i.test(message)) name = "AbortError";
  if (!name && /TimeoutError|signal timed out/i.test(message)) name = "TimeoutError";
  const classified = classifyTurnError({ name, message });
  // 分类文案也过一遍词表：bake-error 的建议文里仍用「烧制」旧词。
  return classified ? mapTerms(`${classified.title}——${classified.advice}`) : mapTerms(message);
}

/* 主题/排版的本地偏好键：更名前用 lj- 前缀（rujuan 时代遗留）。读到旧键
   就一次性搬进 cp- 新键并清掉旧键，老用户的偏好无缝带过来。 */
function readLocalPref(key, legacyKey) {
  let value = localStorage.getItem(key);
  if (value === null) {
    value = localStorage.getItem(legacyKey);
    if (value !== null) {
      localStorage.setItem(key, value);
      localStorage.removeItem(legacyKey);
    }
  }
  return value;
}

export default function App() {
  const noteTimer = useRef(null);
  const [theme, setTheme] = useState(() => {
    const saved = readLocalPref("cp-theme", "lj-theme");
    if (saved === "paper" || saved === "night") return saved;
    return window.matchMedia?.("(prefers-color-scheme: dark)").matches ? "night" : "paper";
  });
  const [density, setDensity] = useState(() => {
    const saved = readLocalPref("cp-density", "lj-density");
    return DENSITY.find((d) => d.key === saved) ?? DENSITY[1];
  });

  // 开门（拍板 2026-08-24）：启动先落模式选择页；选完才进各面。首启未配钥
  // 时仍直接锁进文房（启动 effect 会覆盖 gate），配置完成后照常走开门。
  const [surface, setSurface] = useState("gate"); // gate | desk | creation | reading | map | studio | plotting
  const [returnTo, setReturnTo] = useState("desk");
  const [studioLocked, setStudioLocked] = useState(false);

  const [settings, setSettings] = useState(null);
  const [books, setBooks] = useState([]);
  const [deskNote, setDeskNote] = useState("");

  // 起稿多任务（拍板 2026-08-21：同时最多三本）：按 jobId 逐本跟踪。
  // Map<jobId, { bookTitle, percent, status: running|done|error, bookId?, message?, degraded? }>
  const [bakeJobs, setBakeJobs] = useState(() => new Map());
  // 单调百分比锁按 job 分键：断点续烧的进度回跳不倒退。
  const bakeRef = useRef({ percents: {} });
  // 开卷/续读在途的书：案头对应书卡转「展卷中」，其余书卡禁点。
  const [openingId, setOpeningId] = useState(null);
  // 应用内确认框（重开/重烧/下架）：{ title, detail, confirmLabel, onConfirm }。
  const [confirmAsk, setConfirmAsk] = useState(null);
  // 世界分享（.cpworld）：导出档位选择框 { book }；导入对话框开关。
  const [worldExport, setWorldExport] = useState(null);
  const [worldImportOpen, setWorldImportOpen] = useState(false);
  // 编年史（跨世史只读视图）：{ bookId, title } 时打开。
  const [chronicle, setChronicle] = useState(null);

  const [view, setView] = useState(null);
  const [phase, setPhase] = useState("read"); // read | deriving | options | resolving | resolved
  const [chosenId, setChosenId] = useState(null);
  // 回合令牌：每落一手自增。「停一下」复位界面后，旧回合的 promise 迟到落定
  // （取消确认或终章兜底完成）一律按令牌作废，不再触碰当前界面。
  const playTokenRef = useRef(0);
  // 意图令牌（对齐回合令牌）：看门狗复位或换局后，旧意图的 promise 迟到落定
  // 一律作废。主进程无法中止意图生成（story:cancel 只覆盖回合请求），只能
  // 在渲染侧丢弃迟到结果，防止它顶掉复位后的界面或别的对局。
  const intentTokenRef = useRef(0);
  // 本回合是否被玩家点过「停一下」：终章窗口取消时回合仍会完整写成并落盘，
  // 迟到到达的正常数据照常呈上，但附一句说明免得玩家困惑。
  const stoppedPlayRef = useRef(false);
  const [intents, setIntents] = useState([]); // 落笔痕迹 {turn, text}：改主意追加；只显示当前手

  const [storyPhase, setStoryPhase] = useState("");
  // 流式叙事（拍板 2026-08-19）：等待期正文逐字渐显——story:chunk 一直在推，
  // 此前无人订阅。onDiscard（重写/修复）清空重来；回合落定由正式叙事取代。
  const [inkDraft, setInkDraft] = useState("");
  // 本回合累计落墨字数（演算条可见进度用）：不受展示层 1200 字截尾影响，
  // 每回合与重写时归零——等待期「有东西在长」的最诚实证据。
  const [inkTotal, setInkTotal] = useState(0);

  const [characterWorld, setCharacterWorld] = useState(null);
  const [successor, setSuccessor] = useState(false);
  const [prefill, setPrefill] = useState(null);
  const [pc, setPc] = useState(null);

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    localStorage.setItem("cp-theme", theme);
  }, [theme]);

  useEffect(() => {
    document.documentElement.style.setProperty("--read-col", density.col);
    document.documentElement.style.setProperty("--read-size", density.size);
    localStorage.setItem("cp-density", density.key);
  }, [density]);

  /* 界面缩放（拍板 2026-08-24）：Ctrl+滚轮增减、Ctrl+=/-/0 快捷键、复位 0。
     系数夹在 0.7–1.6 并记忆到 localStorage（cp-zoom），启动时恢复——
     高 DPI 屏上整体嫌大/嫌小的用户自己拧到舒服为止。 */
  useEffect(() => {
    const clamp = (factor) => Math.min(1.6, Math.max(0.7, Math.round(factor * 100) / 100));
    const apply = (factor) => {
      api.zoom?.set(factor);
      localStorage.setItem("cp-zoom", String(factor));
      return factor;
    };
    const saved = Number(localStorage.getItem("cp-zoom"));
    if (Number.isFinite(saved) && saved >= 0.7 && saved <= 1.6 && saved !== 1) {
      api.zoom?.set(saved);
    }
    const onWheel = (event) => {
      if (!event.ctrlKey) return;
      event.preventDefault();
      const current = api.zoom?.get?.() ?? 1;
      apply(clamp(current + (event.deltaY < 0 ? 0.1 : -0.1)));
    };
    const onKey = (event) => {
      if (!event.ctrlKey || event.altKey || event.metaKey) return;
      const current = api.zoom?.get?.() ?? 1;
      if (event.key === "=" || event.key === "+") {
        event.preventDefault();
        apply(clamp(current + 0.1));
      } else if (event.key === "-") {
        event.preventDefault();
        apply(clamp(current - 0.1));
      } else if (event.key === "0") {
        event.preventDefault();
        apply(1);
      }
    };
    window.addEventListener("wheel", onWheel, { passive: false });
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("wheel", onWheel);
      window.removeEventListener("keydown", onKey);
    };
  }, []);

  const note = useCallback((message) => {
    // 新提示覆盖旧提示的计时（D17）：否则旧的 3.2s 定时器会把新提示瞬间清空。
    window.clearTimeout(noteTimer.current);
    noteTimer.current = window.setTimeout(() => setDeskNote(""), 3200);
    setDeskNote(mapTerms(message));
  }, []);

  const refreshBooks = useCallback(async () => {
    try {
      setBooks(await api.library.list());
    } catch (error) {
      note(error.message);
    }
  }, [note]);

  /* 启动：设置 + 书目 + 首启锁 */
  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const loaded = await api.settings.get();
        if (!alive) return;
        setSettings(loaded);
        if (!loaded.ready) {
          setSurface("studio");
          setStudioLocked(true);
        }
      } catch (error) {
        note(error.message);
      }
      refreshBooks();
    })();
    return () => {
      alive = false;
    };
  }, [note, refreshBooks]);

  /* 起稿事件 → 左下角进度行（按 jobId 逐本） */
  useEffect(() => {
    const upsert = (jobId, patch) => {
      setBakeJobs((jobs) => {
        const next = new Map(jobs);
        next.set(jobId, { bookTitle: "", percent: 0, status: "running", ...next.get(jobId), ...patch });
        return next;
      });
    };
    const offProgress = api.novel.onProgress((p) => {
      if (!p.jobId) return;
      const locked = Math.max(bakeRef.current.percents[p.jobId] ?? 0, bakePercent(p));
      bakeRef.current.percents[p.jobId] = locked;
      upsert(p.jobId, {
        bookTitle: p.bookTitle,
        status: "running",
        percent: p.stage === "complete" ? 100 : locked,
      });
    });
    const offDone = api.novel.onDone((d) => {
      if (!d.jobId) return;
      bakeRef.current.percents[d.jobId] = 0;
      upsert(d.jobId, {
        bookTitle: d.bookTitle,
        status: "done",
        percent: 100,
        bookId: d.bookId,
        degraded: d.degraded ?? null,
      });
      refreshBooks();
    });
    const offError = api.novel.onError((e) => {
      if (!e.jobId) return;
      bakeRef.current.percents[e.jobId] = 0;
      // 用户主动取消不是错误（C9）：该行静默撤下，不留「起稿未成」便签。
      if (e.cancelled) {
        setBakeJobs((jobs) => {
          const next = new Map(jobs);
          next.delete(e.jobId);
          return next;
        });
        return;
      }
      // 失败原因要说人话:原始报错(英文/状态码)过一遍分类器,给出
      // 「为什么 + 下一步」;重试按钮按分类给——配错 Key/余额尽这种
      // 点重试只会再失败一遍,不给按钮,提示先去文房处理。
      const classified = classifyBakeError({
        name: e.name,
        status: e.status,
        message: e.message,
      });
      upsert(e.jobId, {
        bookTitle: e.bookTitle,
        status: "error",
        message: e.message,
        reason: mapTerms(classified.title),
        advice: mapTerms(classified.advice),
        retryable: classified.retryable,
      });
    });
    const offPhase = api.story.onPhase((p) => setStoryPhase(p));
    const offChunk = api.story.onChunk((text) => {
      setInkTotal((current) => current + [...String(text ?? "")].length);
      setInkDraft((current) =>
        // 截尾 1200 字并剥掉可能被截开的半个代理对（生僻字防乱码）。
        (current + String(text ?? ""))
          .slice(-1200)
          .replace(/[\uD800-\uDBFF]$/, ""),
      );
    });
    const offDiscard = api.story.onDiscard(() => {
      setInkDraft("");
      setInkTotal(0);
    });
    return () => {
      offProgress();
      offDone();
      offError();
      offPhase();
      offChunk();
      offDiscard();
    };
  }, [refreshBooks]);

  /* ---------- 视图落位 ---------- */

  const enterView = useCallback((next, { fromResume = false } = {}) => {
    // 换对局统一重置跨会话残留（C11）：上一书的相位文案不带到新书。
    // 在途意图随之作废：旧书的迟到解法绝不并进新对局的视图；未定稿墨与
    // 落墨计数同属上一手，一并清空。
    intentTokenRef.current += 1;
    setInkDraft("");
    setInkTotal(0);
    setStoryPhase("");
    if (next?.characterSetup) {
      setCharacterWorld(next.characterWorld ?? null);
      setSuccessor(Boolean(next.successor));
      setPrefill(next.successorPrefill ?? null);
      setSurface("creation");
      setPhase("read");
      setChosenId(null);
      setIntents([]);
      return;
    }
    setView(next);
    setChosenId(null);
    setIntents([]);
    // 选点续存：续读带回上一选点（意图已生成解法）时，直接回到「有解如左」，
    // 意图回声随行——中断后从解法面前接着走，不必重写意图。
    if (fromResume && next?.options?.length) {
      setPhase("options");
      if (next.intent) {
        setIntents([{ turn: next?.turns?.length ?? 0, text: next.intent }]);
      }
    } else {
      setPhase("read");
    }
    setSurface("reading");
    // 定位交给 Reading 的挂载效果（滚到最后一手开头）：这里不再双滚跳变（C12）。
  }, []);

  /* ---------- 案头 ---------- */

  const openBook = useCallback(
    async (book) => {
      if (openingId) return;
      setOpeningId(book.id);
      try {
        // resumable=有续玩点（含 0 回合、刚建角的档）。
        // 起稿中不再一刀切拦开卷（多本并烧下会挡住刚成卷的书）：主进程容忍
        // 烧制中开书（只跳过旧档案补写），案头书卡的「起稿中」态各自可见。
        if (book.resumable ?? book.turn > 0) {
          const resumed = await api.progress.resume(book.id);
          enterView(resumed, { fromResume: true });
        } else {
          const started = await api.story.start({ bookId: book.id });
          enterView(started);
        }
      } catch (error) {
        // 回合在途被拦：直接回推演台看它跑完（相位与公式演算条都还在）。
        if (/还在推演/.test(String(error.message))) {
          note(error.message);
          setSurface("reading");
          return;
        }
        note(error.message);
        refreshBooks();
      } finally {
        setOpeningId(null);
      }
    },
    [enterView, note, openingId, refreshBooks],
  );

  /* 重开一世：作废当前进度，直接回到建角向导（同书新的一世）。
     确认走应用内 ConfirmDialog——window.confirm 在无边框 Electron 里会吞键盘。 */
  const restartBook = useCallback(
    (book) => {
      setConfirmAsk({
        title: `在《${book.title}》重新开始一世？`,
        detail: "这一世的进度与续玩点将作废。",
        confirmLabel: "重开一世",
        onConfirm: () => {
          api.story
            .start({ bookId: book.id })
            .then((started) => enterView(started))
            .catch((error) => {
              if (/还在推演/.test(String(error.message))) {
                note(error.message);
                setSurface("reading");
                return;
              }
              note(error.message);
              refreshBooks();
            });
        },
      });
    },
    [enterView, note, refreshBooks],
  );

  /* 重烧：清这本书的全部烧制缓存，用留存原文从头烧制；烧制进度走左下角进度行。 */
  const rebakeBook = useCallback(
    (book) => {
      setConfirmAsk({
        title: `重新起稿《${book.title}》？`,
        detail: "将清空起稿缓存、从头重新起稿（需数分钟），这一世的进度与续玩点一并清除。",
        confirmLabel: "重新起稿",
        onConfirm: () => {
          api.library
            .rebake(book.id)
            .then(() => {
              refreshBooks();
              note(`《${book.title}》重新起稿中…`);
            })
            .catch((error) => {
              note(error.message);
              refreshBooks();
            });
        },
      });
    },
    [note, refreshBooks],
  );

  /* 补读：采样烧成的书以全本粗读补缺口并重建世界档案；进度与存稿保留。 */
  const topupCoarseBook = useCallback(
    (book) => {
      setConfirmAsk({
        title: `补全《${book.title}》的粗读？`,
        detail: "只读采样漏掉的批次（已读的不重复计费），随后用更全的摘要重建世界档案。对局、进度与存档都保留。",
        confirmLabel: "补全粗读",
        onConfirm: () => {
          api.library
            .topupCoarse(book.id)
            .then(() => {
              note(`《${book.title}》补读中…`);
            })
            .catch((error) => {
              note(error.message);
            });
        },
      });
    },
    [note],
  );

  /* 补挂原文：轻装档导入的书挂上读者自备的原著。主进程按档案目录比对
     「同一本书」，这里只负责把比对结果说清楚、把粗读成本亮出来。 */
  const attachSourceBook = useCallback(
    (book) => {
      api.library
        .attachSource(book.id)
        .then((result) => {
          if (result?.status !== "confirm") return;
          const compare = result.indexChapterCount
            ? `档案目录 ${result.indexChapterCount} 章，标题对上 ${result.matched} 个`
            : "这本书没有留下章节目录，无法核对版本";
          const loose =
            result.verdict !== "match"
              ? "章数或标题与档案目录不完全一致（可能是不同版本），确认是同一本书再继续。"
              : "";
          const cost = Number.isFinite(result.estimatedInputTokens)
            ? `约 ${Math.round(result.estimatedInputTokens / 10000)} 万输入 token`
            : "一遍粗读";
          setConfirmAsk({
            title: `把这份原文补挂给《${result.bookTitle}》？`,
            detail:
              `解析到 ${result.chapterCount} 章（${compare}）。` +
              (loose ? loose : "") +
              `补挂后自动重跑一遍粗读重建正典账本（${cost}）：文风范本、原著此刻、人物精读全部恢复。` +
              "进行中的对局不回溯，重新开卷即生效。",
            confirmLabel: "补挂并粗读",
            onConfirm: () => {
              api.library
                .attachSourceConfirm({ action: "attach" })
                .then((done) => {
                  refreshBooks();
                  note(`《${done.bookTitle}》原文已补挂，粗读重建账本中…`);
                })
                .catch((error) => {
                  note(error.message);
                  refreshBooks();
                });
            },
          });
        })
        .catch((error) => {
          note(error.message);
        });
    },
    [note, refreshBooks],
  );

  /* 编年史入口：案头书卡「编年」→ 全屏只读视图。 */
  const openChronicle = useCallback((book) => {
    setChronicle({ bookId: book.id, title: book.title });
  }, []);

  /* 世界分享：导出打开档位选择；导入结果收口后刷新书架（skip 只关窗）。 */
  const exportBook = useCallback((book) => {
    setWorldExport({ book });
  }, []);

  const importWorldDone = useCallback(
    async (result) => {
      setWorldImportOpen(false);
      if (result?.status === "skipped") {
        note("已跳过，什么都没有改动。");
        return;
      }
      await refreshBooks();
      // 来源信息随摘要透出（导出侧 provenance）：让对方知道这是何时、
      // 哪种档位烧成的世界。
      const prov = result?.provenance;
      const bakedAt = prov?.bakedAt ? new Date(prov.bakedAt) : null;
      const bakedDate = bakedAt && !Number.isNaN(bakedAt.getTime())
        ? `${bakedAt.getFullYear()}-${String(bakedAt.getMonth() + 1).padStart(2, "0")}-${String(
            bakedAt.getDate(),
          ).padStart(2, "0")}`
        : "";
      const scope = prov?.shareScope === "with-source" ? "全档" : "轻装档";
      note(
        `《${result.title}》已上架${result.sourceless ? "（无原文 · 文风与原著此刻自动降级）" : "，导入即可开卷。"}${
          bakedDate ? ` ${scope} · 成于 ${bakedDate}。` : ""
        }`,
      );
    },
    [note, refreshBooks],
  );

  const removeBook = useCallback(
    (book) => {
      setConfirmAsk({
        title: `下架《${book.title}》？`,
        detail: "进度与续玩点一并清除，起稿缓存保留。",
        confirmLabel: "下架",
        onConfirm: () => {
          api.library
            .remove(book.id)
            .then(() => {
              refreshBooks();
              note("已下架。");
            })
            .catch((error) => note(error.message));
        },
      });
    },
    [note, refreshBooks],
  );

  const cancelBake = useCallback(
    async (jobId) => {
      try {
        await api.novel.cancel(jobId);
      } catch (error) {
        note(error.message);
      }
    },
    [note],
  );

  const retryBake = useCallback(
    async (jobId) => {
      // 旧错误行撤下；重试起新 jobId，新行等第一条进度事件点亮。
      const removeJob = (id) => {
        setBakeJobs((jobs) => {
          const next = new Map(jobs);
          next.delete(id);
          return next;
        });
      };
      try {
        const job = await api.novel.retry(jobId);
        removeJob(jobId);
        if (job?.jobId) {
          bakeRef.current.percents[job.jobId] = 0;
          setBakeJobs((jobs) => new Map(jobs).set(job.jobId, {
            bookTitle: job.bookTitle ?? "",
            percent: 0,
            status: "running",
          }));
        }
      } catch (error) {
        note(error.message);
        removeJob(jobId);
      }
    },
    [note],
  );

  // 撤下一行（成卷提示收起 / 失败「知道了」）。
  const dismissBakeJob = useCallback((jobId) => {
    setBakeJobs((jobs) => {
      const next = new Map(jobs);
      next.delete(jobId);
      return next;
    });
  }, []);

  const enterBakedBook = useCallback(
    async (bookId, jobId) => {
      if (jobId) {
        setBakeJobs((jobs) => {
          const next = new Map(jobs);
          next.delete(jobId);
          return next;
        });
      }
      try {
        // 一次拉取既刷新案头又定位书卡；refreshBooks 再各自拉一遍是重复往返。
        const list = await api.library.list();
        setBooks(list);
        const book = list.find((b) => b.id === bookId);
        if (book) openBook(book);
      } catch (error) {
        note(mapTerms(error.message));
      }
    },
    [note, openBook],
  );

  /* ---------- 开题 ---------- */

  const creationDone = useCallback(
    async (profile) => {
      try {
        setPc(profile);
        const opened = await api.story.createCharacter(profile);
        enterView(opened);
      } catch (error) {
        note(mapTerms(error.message));
      }
    },
    [enterView, note],
  );

  /* ---------- 回合循环 ---------- */

  const submitIntent = useCallback(
    async (text) => {
      const hand = view?.turns?.length ?? 0;
      setIntents((list) => [...list, { turn: hand, text }]);
      setChosenId(null);
      setPhase("deriving");
      const token = (intentTokenRef.current += 1);
      const stale = () => token !== intentTokenRef.current;
      // 看门狗（C10）：意图演算不可中止（story:cancel 只覆盖回合请求），
      // 悬挂时 180 秒后回落可输入态并提示，不让稿面永远停在「演算中」；
      // 迟到归来的结果由意图令牌作废，不会顶掉复位后的界面。
      const watchdog = window.setTimeout(() => {
        setPhase((current) => {
          if (current === "deriving") {
            note("推演迟迟未归——先回稿面，可再发一次重试。");
            return "read";
          }
          return current;
        });
      }, 180_000);
      try {
        const result = await api.story.intentOptions({ intent: text });
        if (stale()) return;
        const options = result?.options ?? [];
        if (result?.error) note(result.error);
        if (!options.length) {
          // 意图不可行（兜底已删）：不显示选项，回稿面换写法
          setView((v) => ({ ...v, options: [] }));
          setPhase("read");
          return;
        }
        setView((v) => ({ ...v, options }));
        setPhase("options");
      } catch (error) {
        if (stale()) return;
        // 落笔无下文即回滚：稿面不留没有结果的落笔痕迹，玩家重写也不叠加。
        setIntents((list) =>
          list.at(-1)?.turn === hand && list.at(-1)?.text === text ? list.slice(0, -1) : list,
        );
        note(describeTurnError(error));
        setPhase("read");
      } finally {
        window.clearTimeout(watchdog);
      }
    },
    [note, view],
  );

  const chooseOption = useCallback(
    async (option) => {
      setChosenId(option.id);
      setPhase("resolving");
      // 未定稿正文只属本回合：落定后由正式叙事取代。
      setInkDraft("");
      setInkTotal(0);
      stoppedPlayRef.current = false;
      const token = (playTokenRef.current += 1);
      const stale = () => token !== playTokenRef.current;
      try {
        const result = await api.story.play(option.id);
        if (stale()) return;
        if (result?.cancelled) {
          // 「停一下」的确认：stopPlay 已复位界面，这里收敛到选项即可。
          setPhase("options");
          setChosenId(null);
          setInkDraft("");
          setInkTotal(0);
          return;
        }
        if (result?.turns) {
          // mock 桥：整份视图
          setView({ ...result });
        } else if (result?.number) {
          // 真桥：单回合对象 → 并入视图
          setView((v) => ({
            ...v,
            turns: [
              ...(v?.turns ?? []),
              {
                number: result.number,
                narrative: result.narrative,
                consequences: result.consequences,
              },
            ],
            options: result.options ?? [],
            worldHappenings: result.worldHappenings ?? v?.worldHappenings ?? [],
            ending: result.ending ?? null,
            // 下一手关键回合预判随回合刷新（开卷 view 亦带；mock 桥无此字段）。
            nextKeyTurn: result.nextKeyTurn ?? false,
          }));
        }
        if (stoppedPlayRef.current) {
          // 终章窗口里点过「停一下」但回合其实已经写成并落盘：照常呈上，
          // 只是补一句说明，免得玩家困惑「停了怎么还出回合」。
          note("这一手其实已经写成——直接呈上。");
        }
        setPhase("resolved");
        setInkDraft("");
        setInkTotal(0);
      } catch (error) {
        if (stale()) return;
        const message = String(error.message ?? "");
        // 取消的回声：界面已由 stopPlay 复位，不再把裸 AbortError 甩给玩家。
        if (error?.name === "AbortError" || /AbortError|aborted/i.test(message)) {
          setPhase("options");
          setChosenId(null);
          setInkDraft("");
          setInkTotal(0);
          return;
        }
        // 解法表失步自愈（2026-08-19）：界面显示的选项与主进程解法表罕见
        // 失步（换局竞态残留）时，用当前意图自动重新演算一次，而不是把
        // 「请先写下你此刻想做的事」甩给玩家。
        if (/请先写下/.test(message) && view?.intent) {
          note("解法已失效——按原方向重新演算。");
          setPhase("read");
          setChosenId(null);
          void submitIntent(view.intent);
          return;
        }
        note(describeTurnError(error));
        setPhase("options");
        setChosenId(null);
      }
    },
    [note, submitIntent, view?.intent],
  );

  const restartSuccessor = useCallback(async () => {
    try {
      const next = await api.story.createSuccessor();
      enterView(next);
    } catch (error) {
      note(mapTerms(error.message));
    }
  }, [enterView, note]);

  const continueStage = useCallback(async () => {
    try {
      const next = await api.story.continueStage();
      enterView(next);
    } catch (error) {
      note(mapTerms(error.message));
    }
  }, [enterView, note]);

  /* 意图面板（三层意图的界面出口）：改写此世之志——作废当前弧线，导演
     下回合重新谋篇；改写当前谋算——只调叙事与解法取势，不动弧线。 */
  const setGoal = useCallback(
    async (goal) => {
      try {
        const result = await api.story.setGoal({ goal });
        setView((v) => ({ ...v, goal: result?.goal ?? goal }));
        note("此世之志已改写——下一回合重新谋篇。");
      } catch (error) {
        note(mapTerms(error.message));
      }
    },
    [note],
  );

  const setScheme = useCallback(
    async (scheme) => {
      try {
        const result = await api.story.setScheme({ scheme });
        setView((v) => ({ ...v, scheme: result?.scheme ?? scheme }));
        note("当前谋算已改写。");
      } catch (error) {
        note(mapTerms(error.message));
      }
    },
    [note],
  );

  /* 身份转变卡(A1):接纳/拒绝挂起的转变——此前该状态只有拦截没有出口。 */
  const resolveTransition = useCallback(
    async (accept) => {
      try {
        const result = await api.story.resolveTransition({ accept });
        setView((v) => ({
          ...v,
          roleTransition: result?.roleTransition ?? null,
          journal: result?.journal ?? v?.journal ?? [],
        }));
      } catch (error) {
        note(mapTerms(error.message));
      }
    },
    [note],
  );

  /* 身份重选卡(A2):目录失配时从本书目录重选身份,心性/所求保留。 */
  const reselectRole = useCallback(
    async (roleId) => {
      try {
        const next = await api.story.reselectRole({ roleId });
        enterView(next);
      } catch (error) {
        note(mapTerms(error.message));
      }
    },
    [enterView, note],
  );

  /* 一世导出（A）：完整故事拼 Markdown 存盘——回读与分享两用。 */
  const exportLife = useCallback(async () => {
    try {
      const result = await api.story.exportLife();
      if (result?.ok) note(`已导出：${result.path}`);
      else if (result?.canceled) note("已取消导出。");
    } catch (error) {
      note(mapTerms(error.message));
    }
  }, [note]);

  /* 深演算 45 秒后的「停一下」：中断在途回合 */
  const stopPlay = useCallback(async () => {
    try {
      await api.story.cancel();
      note("已停下手头的回合。");
      // 立即复位界面、回到上一手的选项：取消信号中断在途请求并传回
      // game:play 还要一两秒，这期间界面不该一直挂着「回合推演中」。
      stoppedPlayRef.current = true;
      setPhase("options");
      setChosenId(null);
      setInkDraft("");
      setInkTotal(0);
    } catch (error) {
      note(mapTerms(error.message));
    }
  }, [note]);

  /* ---------- 导航 ---------- */

  const goStudioFromReading = useCallback(() => {
    setReturnTo("reading");
    setSurface("studio");
  }, []);
  const goStudioFromDesk = useCallback(() => {
    setReturnTo("desk");
    setSurface("studio");
  }, []);
  // 谋篇是平级独立面（非 overlay）：进出都回案头，不需要 returnTo。
  const goPlottingFromDesk = useCallback(() => {
    setSurface("plotting");
    window.scrollTo({ top: 0 });
  }, []);
  // 开门的两个去处：进案头顺手刷新书架；进谋篇即是谋篇面。
  const enterPlayFromGate = useCallback(() => {
    setSurface("desk");
    refreshBooks();
  }, [refreshBooks]);
  const enterPlotFromGate = useCallback(() => {
    setSurface("plotting");
    window.scrollTo({ top: 0 });
  }, []);
  const backFromOverlay = useCallback(() => {
    // 回推演台保留阅读位置（C12）：只有回案头才回页顶。
    if (returnTo === "desk") window.scrollTo({ top: 0 });
    setSurface(returnTo);
  }, [returnTo]);
  const goDesk = useCallback(() => {
    setSurface("desk");
    refreshBooks();
    window.scrollTo({ top: 0 });
  }, [refreshBooks]);

  const onSettingsSaved = useCallback((saved) => {
    setSettings(saved);
    if (saved?.ready) setStudioLocked(false);
  }, []);

  const readingAlive = surface === "reading" || surface === "studio";

  return (
    <>
      {surface === "gate" && (
        <Gate
          theme={theme}
          onTheme={setTheme}
          onPlay={enterPlayFromGate}
          onPlot={enterPlotFromGate}
        />
      )}

      {surface === "desk" && (
        <Desk
          books={books}
          opening={openingId}
          baking={[...bakeJobs.values()]
            .filter((job) => job.status === "running")
            .map((job) => ({ title: job.bookTitle, percent: job.percent ?? 0 }))}
          onOpenBook={openBook}
          onRestartBook={restartBook}
          onRebakeBook={rebakeBook}
          onTopupCoarse={topupCoarseBook}
          onAttachSource={attachSourceBook}
          onChronicle={openChronicle}
          onRemoveBook={removeBook}
          onExportBook={exportBook}
          onImportWorld={() => setWorldImportOpen(true)}
          onStudio={goStudioFromDesk}
          onPlotting={goPlottingFromDesk}
          theme={theme}
          onTheme={setTheme}
          note={deskNote}
          onNote={note}
        />
      )}

      {surface === "creation" && (
        <Creation
          world={characterWorld}
          successor={successor}
          prefill={prefill}
          storyPhase={storyPhase}
          onDone={creationDone}
          onCancel={goDesk}
        />
      )}

      {/* 推演台在 map/studio 期间保持挂载，回合进度不丢 */}
      {readingAlive && view && (
        <div className="surf-holder" hidden={surface !== "reading"}>
          <Reading
            pc={pc}
            view={view}
            phase={phase}
            storyPhase={storyPhase}
            inkDraft={inkDraft}
            inkTotal={inkTotal}
            chosenId={chosenId}
            intents={intents
              .filter((entry) => entry.turn === (view?.turns?.length ?? 0))
              .map((entry) => entry.text)}
            active={surface === "reading"}
            theme={theme}
            onTheme={setTheme}
            onDesk={goDesk}
            onExport={exportLife}
            onStudio={goStudioFromReading}
            onIntent={submitIntent}
            onChoose={chooseOption}
            onRestart={restartSuccessor}
            onContinueStage={continueStage}
            onResolveTransition={resolveTransition}
            onReselectRole={reselectRole}
            onSetGoal={setGoal}
            onSetScheme={setScheme}
            onStopPlay={stopPlay}
          />
        </div>
      )}

      {chronicle && (
        <Chronicle bookId={chronicle.bookId} onBack={() => setChronicle(null)} />
      )}

      {surface === "plotting" && (
        <Plotting
          settings={settings}
          onDesk={goDesk}
          onStudio={goStudioFromDesk}
          onNote={note}
        />
      )}

      {surface === "studio" && (
        <Studio
          locked={studioLocked}
          settings={settings}
          onSettingsSaved={onSettingsSaved}
          onBack={backFromOverlay}
          onNote={note}
        />
      )}

      <BakeHud
        jobs={bakeJobs}
        onCancel={cancelBake}
        onEnter={enterBakedBook}
        onRetry={retryBake}
        onDismiss={dismissBakeJob}
      />

      <ConfirmDialog state={confirmAsk} onClose={() => setConfirmAsk(null)} />

      <WorldExportDialog state={worldExport} onClose={() => setWorldExport(null)} onNote={note} />

      <WorldImportDialog
        open={worldImportOpen}
        onClose={() => setWorldImportOpen(false)}
        onDone={importWorldDone}
        onNote={note}
      />

      {/* 全局提示（案头工具条之外的状态行，如意图不可行的换写法提示） */}
      {deskNote && surface !== "desk" && (
        <FadeIn as="p" className="global-note" role="status" deps={[deskNote]}>
          {deskNote}
        </FadeIn>
      )}
    </>
  );
}
