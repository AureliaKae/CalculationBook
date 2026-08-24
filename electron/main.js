import { app, BrowserWindow, dialog, ipcMain, Menu, safeStorage, screen } from "electron";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, open, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
  NovelBaker,
  batches,
  loadSummaries,
  novelCachePrefix,
  estimateBakeInputTokens,
  estimateCoarseEtaSeconds,
  BIG_FIVE_DIMENSIONS,
  BIG_FIVE_LABELS,
  bigFiveLevel,
  createPlayerState,
  normalizeWorld,
  realmTraitsOf,
  genreVocabulary,
  guessGenreByKeywords,
  divergenceThreshold,
  divergenceTargetLabel,
  fateTierOf,
  applyRoleTransition,
  createSuccessorState,
  buildCharacterJournal,
  pastLifeFact,
  pastLifeFact as pastLifeFactOf,
  playerDeathState,
  divergenceWorldFacts,
  fateSeedsView,
  applyRoleIdentity,
  createEntity,
  seedCreatedCharacter,
  CREATABLE_KINDS,
  applyCatalogCoherence,
  CATALOG_COHERENCE_PROMPT,
  sanitizeEventFactChanges,
  sanitizeRoleCapabilities,
  playerClashCondition,
  stanceLabel,
  CLASH_CONDITIONS,
  arcBeatView,
  footstepsView,
  worldHappeningsView,
  storyStart,
  storyClockView,
  protagonistView,
  povLinesView,
  relationsView,
  emergentStoriesView,
  CharacterDetailCache,
  buildCanonLedger,
  EntityStateTracker,
  StoryEngine,
  worldviewForCheck,
  parseNovel,
  matchSourceToIndex,
  BakeLimiter,
  WORLD_BUNDLE_EXTENSION,
  buildWorldBundle,
  parseWorldBundle,
  OpenAiCompatibleClient,
  fetchModels,
  ProgressStore,
  restoreEngine,
  serializeEngine,
  resumeEnding,
  LayeredMemory,
  KeyedSingleFlight,
  clientConfig,
  publicSettings,
  resolveBakeConcurrency,
  isKnownProviderBaseUrl,
  searchBookReference,
  PLOT_SECTIONS,
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
  normalizeSection,
  normalizeFlavor,
  projectToMarkdown,
  genreSearchKeywords,
  enterInteractive,
  exitInteractive,
  waitForInteractiveIdle,
  submitCatalogCoherenceTool,
  submitDigestMergeTool,
  submitRoleAbilitiesTool,
  submitSummaryMergeTool,
  submitSummaryVerifyTool,
  submitTimelineFactsTool,
  submitUpgradeWorldTool,
} from "../src/index.js";
import { assertBookId, bookId as bookIdFor, LibraryStore } from "./library-store.js";
import { PlotStore } from "./plot-store.js";
import { SettingsStore } from "./settings-store.js";
import { UsageStore } from "./usage-store.js";
import { isPrivateOrReservedHost } from "./net-guard.js";
import { migrateUserDataDir } from "./data-dir.js";

const root = join(fileURLToPath(new URL(".", import.meta.url)), "..");
// userData 定在 calculationpaper（ASCII 固定名，不随中文 productName 派生）；
// 更名前的旧目录若还在，这一步会先整体搬入，老用户的书架/存档/设置不丢。
// dev 与打包形态都要在首次 getPath("userData") 之前完成，故放在模块顶层。
app.setPath("userData", migrateUserDataDir(app.getPath("appData")));
const BAKE_TIMEOUT_MS = 5 * 60_000;
const PLAY_TIMEOUT_MS = 5 * 60_000;
// 应用只信任自己加载的页面：来源按 URL origin 精确比对（协议+主机+端口），
// 不用字符串前缀匹配——前缀会被 http://localhost:5173.evil.com 这类变体绕过。
const rendererIndexUrl = pathToFileURL(join(root, "renderer", "dist", "index.html")).toString();

function safeOrigin(raw) {
  try {
    return new URL(raw).origin;
  } catch {
    return "";
  }
}

function devServerOrigin() {
  const devServer = process.env.VITE_DEV_SERVER_URL;
  return devServer ? safeOrigin(devServer) : "";
}

function trustedPageUrl(url) {
  const devOrigin = devServerOrigin();
  if (devOrigin) return safeOrigin(url) === devOrigin;
  return url === rendererIndexUrl || url.startsWith(`${rendererIndexUrl}#`);
}

let window;
let settingsStore;
let progressStore;
let usageStore;
let library;
let plotStore;
let engine;
let currentOptions = [];
// 意图先行(拍板 R3,2026-08-18 更新:落定即清):玩家声明的方向只服务于
// 生成当回合的选项;选项被选定、回合落定后即清空,下一回合由玩家重新起意。
// 会话内存态,不落盘;换书/开新一世/转世时同样清空。
let activeIntent = null;
let session;
let pendingNovel;
let currentSourceChapters = [];
const pendingWrites = new Set();
let quitAfterWrites = false;
// 烧制中关窗:close 拦截里的「退出」一旦批准就放行,防止确认框反复弹。
// 每次建窗时复位(macOS 关窗不退出,复用同一窗口变量)。
let closeApproved = false;
// 持久化写队列：串行所有存档写入，避免并发交错导致旧状态覆盖新状态。
let writeQueue = Promise.resolve();
// 同时最多三本在烧（拍板 2026-08-21），其余排队；左下角 HUD 按 jobId 逐本显示。
const MAX_CONCURRENT_BAKES = 3;
const bakeQueue = [];
const runningJobs = new Map(); // jobId → 在跑的 job
// 烧制请求的全局闸：并发预算在所有在跑 job 之间共享——三本并烧不放大请求总量，
// 与单本时的限流量级一致（玩家回合优先的 interactive 门仍叠在其外层）。
const bakeGate = new BakeLimiter(1);
// 烧制是否在跑（含排队中）：期间跳过开书/续读的旧档案补写（快模型请求，
// 与烧制抢同一个槽位），烧完由 upgradeAllRoleAbilities 兜底补上。
const bakeRunning = () => runningJobs.size > 0 || bakeQueue.length > 0;
// 最近一次失败的任务，供「重试」直接复用，不用再走一遍选文件。
// 持久化到 userData:重启后「重试」依然可用,断点续烧的入口不随进程消失。
let failedJob;
function failedBakePath() {
  return join(app.getPath("userData"), "failed-bake.json");
}
async function persistFailedJob() {
  if (!failedJob) return;
  // 原子写并纳入退出等待：退出瞬间正赶上失败落盘时，裸 writeFile 会留下
  // 半截 JSON（重启读档 try/catch 吞掉后重试入口丢失），或直接被杀丢档。
  const write = (async () => {
    const target = failedBakePath();
    const temporary = `${target}.tmp-${Math.random().toString(36).slice(2)}`;
    const handle = await open(temporary, "w");
    try {
      await handle.writeFile(
        JSON.stringify({
          id: failedJob.id,
          title: failedJob.title,
          focusChapter: failedJob.focusChapter,
          openAll: Boolean(failedJob.openAll),
          anchorTime: Number.isFinite(failedJob.anchorTime) ? failedJob.anchorTime : null,
          ...(failedJob.coarseBudgetChars ? { coarseBudgetChars: failedJob.coarseBudgetChars } : {}),
          filePath: failedJob.filePath ?? null,
          error: failedJob.error ?? null,
        }),
        "utf8",
      );
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(temporary, target);
  })();
  trackWrite(write);
  try {
    await write;
  } catch {}
}
async function clearPersistedFailedJob() {
  try {
    await rm(failedBakePath(), { force: true });
  } catch {}
}
// 在途回合的取消信号：等待态「停一下」用它中断正在生成的叙事。
let activePlayAbort = null;
// 回合在飞锁：整个 game:play 期间只允许一个回合在跑。第二个调用直接拒绝，
// 否则会与在途回合并发跑引擎、并覆盖 activePlayAbort（旧回合从此无法取消）。
let playInFlight = false;
// 意图在飞锁（2026-08-19）：意图演算（deriving）期间同样不许换局——否则旧
// 意图的结果会落到新会话的界面上，点它时新会话解法为空，报
// 「请先写下你此刻想做的事」。两类在途共用同一套换局守卫。
let intentInFlight = false;
const turnBusy = () => playInFlight || intentInFlight;

// 窗口可能已经关了（比如烧制中途关掉窗口），此时 webContents 已销毁，
// 直接 send 会抛 "Object has been destroyed"，把整个烧制队列炸停。
function safeSend(channel, payload) {
  if (window && !window.isDestroyed()) window.webContents.send(channel, payload);
}

async function configuredClient() {
  const settings = await settingsStore.load();
  return new OpenAiCompatibleClient({
    config: { ...clientConfig(settings), strongTimeoutMs: PLAY_TIMEOUT_MS },
    onNarrative: (text) => safeSend("story:chunk", text),
    onDiscardNarrative: () => safeSend("story:discard"),
    // 用量记账(拍板 2026-08-19):按当前对局的书归账;烧制等无主请求记入杂项。
    onUsage: (usage) => usageStore?.record(session?.bookId ?? "", usage),
  });
}

// 预设选项已取消（拍板 2026-08-17）：普通回合不展示选项，选项由玩家意图动态产生。
// 只有交锋回合由结构请求产出 2-4 个搏杀选项。开局/续阶段一律空选项，等玩家输入意图。
// 选点续存（拍板 2026-08-19）：非交锋存档若带有上一选点（意图已生成解法），
// 原样恢复——回合在途时崩溃/重启，重开回到「解法面前」，而不是回到开场从头再来。
function restoreOptionsFor(engineRef, savedOptions, ending) {
  if (ending) return [];
  if (engineRef?.store?.current?.activeClash) {
    const clashOptions = savedOptions ?? engineRef.history.at(-1)?.options ?? [];
    return Array.isArray(clashOptions) ? clashOptions : [];
  }
  return Array.isArray(savedOptions) && savedOptions.length ? savedOptions : [];
}

function summarizerFor(llm) {
  if (!(llm instanceof OpenAiCompatibleClient)) return undefined;
  const summarize = async ({ previous, recent, correction }) => {
    const result = await llm.completeFastTool(
      [
        {
          role: "system",
          content:
            '你是章节摘要合并器。把旧摘要与近期事件压缩合并成一段新摘要，只返回 {"summary":"..."}。只做压缩与合并：不得新增旧摘要和事件里都没有的事实；仍在生效的关键信息必须保留（人物生死与身份、未完成的目标与约定、未还的债、势力关系、进行中的伏笔）；新旧冲突以新事件为准，但未被推翻的旧事实不得悄悄删除；保留具体的人名、地名、物品名，不用代词替代。' +
            (correction
              ? `\n上一次合并被校验器驳回，原因：${correction}。请针对性修正后重新输出。`
              : ""),
        },
        { role: "user", content: JSON.stringify({ previous, recent }) },
      ],
      submitSummaryMergeTool(),
    );
    return result.summary;
  };
  // 远期梗概合并器（记忆分层 2026-08-21）：把被折叠出中窗的摘要并入远期
  // digest——远期只留大要（主线走向、生死身份、未了之局），细节让位。
  const digestMerge = async ({ previous, evicted, correction }) => {
    const result = await llm.completeFastTool(
      [
        {
          role: "system",
          content:
            '你是长篇故事的远期梗概合并器。把旧远期梗概与一段刚从近况层折叠出来的中期摘要，合并成一段新的远期梗概，只返回 {"digest":"..."}。远期梗概只保留大要：主线走向与转折、人物的生死与身份归属、仍在生效的宿怨/债务/约定、未了结的大伏笔；具体过程细节与一次性事件大胆舍弃。不得新增两边都没有的事实；冲突以折叠摘要（更近期）为准；保留人名地名，不用代词。篇幅以 300-600 字为度。' +
            (correction
              ? `\n上一次合并被校验器驳回，原因：${correction}。请针对性修正后重新输出。`
              : ""),
        },
        { role: "user", content: JSON.stringify({ previous, evicted }) },
      ],
      submitDigestMergeTool(),
    );
    return result.digest;
  };
  return new LayeredMemory({
    summarizer: summarize,
    digester: digestMerge,
    verifier: async ({ previous, recent, candidate }) => {
      const result = await llm.completeFastTool(
        [
          {
            role: "system",
            content:
              '你是摘要合并校验器。检查候选新摘要相对旧摘要与近期事件：是否新增了不存在的"事实"、是否悄悄删除了仍在生效的关键信息（人物生死/身份、目标、约定、债务、势力关系、进行中的伏笔）。只返回 {"ok":true} 或 {"ok":false,"reason":"一句话"}。措辞差异与小瑕疵不算问题，只有实质冲突或关键信息丢失才返回 false。旧摘要为空时只对近期事件负责。',
          },
          { role: "user", content: JSON.stringify({ previous, recent, candidate }) },
        ],
        submitSummaryVerifyTool(),
      );
      return result ?? null;
    },
  });
}

// 正典账本加载（拍板 2026-08-20：连贯性修复——账本化+按需检索）：粗读摘要日志
// （cache/<书哈希>-<批次哈希>-w3.summaries.jsonl）在烧制期逐批追加、游玩期此前
// 从未被使用。这里按烧制同参（novelCachePrefix + 默认批次划分）找回这份日志，
// 构建成可检索账本（事实账 + 伏笔簿）。找不到/解析失败一律回 null——引擎拿
// 不到账本时各注入点自动退回旧行为，永不阻塞开局。注意 bookTitle 必须用书架
// meta 里记录的原著标题（与烧制时的 novel.title 同源），不能用 world.title
// （世界档案的标题可能被改写，哈希就对不上了）。
async function loadCanonLedger({ cacheDirectory, title, chapters }) {
  const novelHash = novelCachePrefix({ title, chapters });
  const batchHash = createHash("sha1").update("default").digest("hex");
  const summariesPath = join(cacheDirectory, `${novelHash}-${batchHash}-w3.summaries.jsonl`);
  const summaries = await loadSummaries(summariesPath);
  if (!summaries.some((summary) => summary != null)) return null;
  return buildCanonLedger({ groups: batches(chapters), summaries });
}

// 构建引擎但不动全局：调用方把所有可抛步骤都走完，最后再一次性提交
// engine/session/currentOptions——中途任何失败都保持旧对局原封不动，杜绝
// 「引擎还是旧书、会话已指新书」的跨书进度/世界污染。
function buildEngine({ gameWorld, gameState, llm, sourceChapters = [], bookTitle = null, canonLedger = null }) {
  const fastJson =
    llm instanceof OpenAiCompatibleClient
      ? (messages, options = {}) =>
          options.tool
            ? llm.completeFastTool(messages, options.tool, { timeoutMs: BAKE_TIMEOUT_MS, ...options })
            : llm.completeFast(messages, { timeoutMs: BAKE_TIMEOUT_MS, ...options })
      : null;
  const detailCache =
    llm instanceof OpenAiCompatibleClient
      ? new CharacterDetailCache({
          directory: join(
            app.getPath("userData"),
            "character-cache",
            createHash("sha1").update(String(gameWorld.id)).digest("hex"),
          ),
          completeJson: fastJson,
        })
      : undefined;
  // 人物状态追踪（连贯性修复）：与人物精读共用同一条快模型通道；无通道
  // （客户端不是 OpenAI 兼容实现）时不记账，行为与旧版一致。
  const entityTracker = fastJson ? new EntityStateTracker({ completeJson: fastJson }) : undefined;
  const nextEngine = new StoryEngine({
    world: gameWorld,
    initialState: gameState,
    llm,
    seed: Date.now() >>> 0,
    memory: summarizerFor(llm),
    sourceChapters,
    // 无原文世界（导入的轻装档）没有可精读的章节，别让精读请求空手跑一遍。
    detailCharacter:
      detailCache && sourceChapters.length ? (payload) => detailCache.getOrCreate(payload) : undefined,
    canonLedger,
    entityTracker,
    onPhase: (phase) => safeSend("story:phase", phase),
  });
  // 账本懒加载：读盘+建索引是异步活，开局不等它——加载完成后挂到引擎上，
  // 之后的回合即可检索；此前的回合按旧行为注入（优雅降级）。
  if (!canonLedger && bookTitle && sourceChapters.length) {
    loadCanonLedger({
      cacheDirectory: join(app.getPath("userData"), "cache"),
      title: bookTitle,
      chapters: sourceChapters,
    })
      .then((loaded) => {
        if (loaded) nextEngine.canonLedger = loaded;
      })
      .catch(() => {});
  }
  nextEngine.world.initialStateTemplate = nextEngine.store.snapshots[0];
  return nextEngine;
}

// 全部可抛步骤成功后提交新对局：引擎、会话、源章节与选项在同一同步块里换，
// 跨 await 的读档方（game:play 等）据此检测「对局已被换掉」并放弃旧局写回。
function commitEngine(nextEngine, { sourceChapters = [], session: nextSession, options = [] }) {
  engine = nextEngine;
  currentSourceChapters = sourceChapters;
  currentOptions = options;
  session = nextSession;
}

function newStorySession(bookId) {
  return { bookId, requiresApi: true, storyId: randomUUID(), startedAt: Date.now() };
}

function trackWrite(write) {
  pendingWrites.add(write);
  // finally 派生的 promise 与原 promise 同命运：写入失败时这条链也会 reject，
  // 补一个 catch 防止未处理拒绝把整个应用带崩（Node 默认对未处理拒绝抛错）。
  write
    .finally(() => pendingWrites.delete(write))
    .catch(() => {});
  return write;
}

// 串行化一次持久化写入：排队执行，返回本次写入完成（含失败）后的 promise。
// 失败必须留日志：静默吞掉的写盘错误=玩家毫不知情地丢档。
function enqueueWrite(task) {
  const run = writeQueue.then(task, task);
  writeQueue = run.catch((error) => {
    console.error("[progress] 存档写入失败：", error?.message ?? error);
  });
  const tracked = trackWrite(run);
  return tracked;
}

// 下一手的关键回合预判（玩家落笔前亮出）：弧线当前节拍是转折/收束，或
// 搏杀中命悬一线——两者在回合开始前就已定。所选选项收束交锋的第三种
// 关键（依赖落子）无法预判，由推演中的 key-turn 相位兜底。
function nextKeyTurnOf(gameState) {
  return Boolean(arcBeatView(gameState?.arc)?.isKey) || Boolean(gameState?.activeClash?.pendingDeath);
}

function openingView(gameWorld, gameState) {
  return {
    bookId: session.bookId,
    title: gameWorld.title,
    opening: gameState.chapterSummary ?? gameWorld.summary ?? "",
    options: currentOptions,
    journal: gameState.characterJournal ?? [],
    // 游玩模式与起点(拍板:模式已移除,新档一律 classic/scratch;仅旧爽文存档
    // 原样保留,界面只在旧档上展示定性标签)。
    playMode: gameState.playMode === "power" ? "power" : "classic",
    startingPoint:
      gameState.playMode === "power" && gameState.startingPoint === "ceiling"
        ? "ceiling"
        : "scratch",
    // 意图先行(拍板 R3):当前生效的方向,供界面点亮;空串=未声明。
    intent: activeIntent ?? "",
    // 分层意图(拍板:弧线导演):此世之志与当前谋算,意图面板初始化用。
    goal: gameState.personalGoals?.[0]?.publicDirection ?? "",
    scheme: gameState.player?.scheme ?? "",
    clash: clashView(gameState, gameWorld),
    // 关键回合预判：玩家写意图/看解法时亮出（朱红标记），落笔前即知分量。
    nextKeyTurn: nextKeyTurnOf(gameState),
    footsteps: footstepsView(engine?.history ?? []),
    // 原著主角现状卡（边注栏，拍板 2026-08-19）：现状+近期。
    protagonist: protagonistView(gameState, gameWorld),
    // POV 行列（拍板 2026-08-20：并行多线书按线并列）：1-3 位每人一行；
    // 单人书首行与 protagonist 同构，界面优先消费 povs。
    povs: povLinesView(gameState, gameWorld),
    // 关系簿+时钟（拍板 2026-08-19）：已遇人物定性档与故事时钟，阅读页常驻。
    relations: relationsView(gameState, gameWorld),
    clock: storyClockView(gameWorld, gameState).label,
    // 角色卡（拍板 2026-08-19）：境界/技能/行囊/履历，边注摘要+弹窗详情共用。
    playerSheet: playerSheetView(gameState, gameWorld),
    fate: fateView(gameState, gameWorld),
    // 世界见闻(拍板 2026-08-17:平行推演的可读呈现):已投递事件流与生长中的涌现故事。
    worldHappenings: worldHappeningsView(gameState, gameWorld),
    emergentStories: emergentStoriesView(gameState),
    fateSeeds: fateSeedsView(gameState, gameWorld),
    roleTransition: roleTransitionView(gameState, gameWorld),
    roleReselect: Boolean(gameState.player?.roleDangling),
    ...(gameState.player?.roleDangling ? { roleWorld: gameWorld } : {}),
  };
}

// 身份转变卡视图：把存档里的 pending 转成界面可渲染的定性信息。
function roleTransitionView(gameState, gameWorld) {
  const pending = gameState?.pendingRoleTransition;
  if (!pending) return null;
  const toRole = gameWorld.roleTemplates.find((item) => item.id === pending.toRoleId);
  const path = gameWorld.roleProgression?.find((item) => item.id === pending.progressionId);
  const trigger = path?.triggerEvents?.find((item) => item.id === pending.triggerEventId);
  return {
    progressionId: pending.progressionId,
    triggerEventId: pending.triggerEventId,
    fromRoleName: pending.fromRoleName ?? gameState.player?.roleName ?? "",
    toRole: toRole
      ? { id: toRole.id, name: toRole.name, description: toRole.description ?? "" }
      : { id: pending.toRoleId, name: pending.toRoleId, description: "" },
    reason: trigger?.description ?? trigger?.name ?? "",
    modifiers: (path?.modifiers ?? []).map((modifier) => ({
      name: gameWorld.attributes.find((item) => item.id === modifier.attributeId)?.name ?? modifier.attributeId,
      delta: modifier.delta,
    })),
  };
}

// 存档身份与目录失配：标记悬空，界面立即弹重选；目录为空时无从重选，不标记。
// 引擎合成的正统身份「无名之辈」(outsider)按设计不写入世界目录——能力补写
// 满档的书(autoAssignRole 的平朴筛选全数落空)人人都是它,必须放行,否则
// 每次续读都被误判悬空,卡进「重选身份」死循环。
function markDanglingRole(gameState, gameWorld) {
  if (!gameState?.player) return;
  if (!gameWorld.roleTemplates?.length) return;
  if (gameState.player.roleId === "outsider") return;
  if (gameWorld.roleTemplates.some((item) => item.id === gameState.player.roleId)) return;
  gameState.player.roleDangling = true;
  gameState.characterJournal = buildCharacterJournal(gameState);
}

// 对峙条只显示文字标签：数值留在引擎里。
function clashView(state, world) {
  const clash = state?.activeClash;
  if (!clash) return null;
  return {
    opponentName: clash.opponentName,
    opponentCondition: CLASH_CONDITIONS[clash.opponentCondition] ?? "无伤",
    playerCondition: playerClashCondition(state, world),
    stance: stanceLabel(clash.stance),
    step: clash.step,
    maxSteps: clash.maxSteps,
    origin: clash.origin,
    reason: clash.reason,
    pendingDeath: clash.pendingDeath,
  };
}

// 改命结果视图：只给定性信息（阶段、目标称呼、改写后的当前事实），势能数值留在引擎里。
// seeded/pending 由叙事承担，不插卡；resolved/backlash 渲染层据此插「改命已成/命运反噬」卡。
function divergenceView(turn) {
  const result = turn?.divergence;
  if (!result?.stage) return null;
  return {
    stage: result.stage,
    target: result.target ?? "",
    override: result.overrides?.[0]?.text ?? null,
    fateResistance: Boolean(result.fateResistance),
  };
}

// 命数卡（拍板 2026-08-22）：铺垫期的改命进度常驻边注——目标用称呼
// （divergenceTargetLabel，防剧透与它同款），火候用三档意象（fateTierOf），
// 不泄露势能数值；临门档与叙事征兆（divergenceApproach）同拍。
function fateView(state, world) {
  return (state?.pendingDivergences ?? []).map((item) => ({
    label: divergenceTargetLabel(world, item, state),
    tier: fateTierOf(item.momentum, divergenceThreshold(world, item.targetType, item.targetId)),
  }));
}

// 角色卡视图（拍板 2026-08-19：边注摘要+弹窗详情）：境界阶梯（标当前位）、
// 技能（身份带/习得两源）、行囊明细、履历（身份变化+境界突破）。
// 大五不进卡（全隐性拍板）；stats/attributes 不在展示范围。
function playerSheetView(state, world) {
  const player = state?.player ?? {};
  const ladder = realmTraitsOf(world);
  // 词表随书（拍板 2026-08-22）：技能/行囊的叫法按题材变。新起稿的 world
  // 带 genre（烧制时 LLM 分类）；旧档缺省用全书摘要关键词猜（起稿兜底同款）。
  const vocabulary = genreVocabulary(world?.genre ?? guessGenreByKeywords(world?.summary ?? ""));
  const realmIds = new Set(ladder.map((trait) => trait.id));
  const currentRealmId =
    (Array.isArray(player.traitIds) ? player.traitIds : []).find((id) => realmIds.has(id)) ?? null;
  const role = world.roleTemplates?.find((item) => item.id === player.roleId);
  const identityAbilities = Array.isArray(player.abilities)
    ? player.abilities
    : Array.isArray(role?.abilities)
      ? role.abilities
      : [];
  const learned = Array.isArray(player.learnedAbilities) ? player.learnedAbilities : [];
  const roleHistory = Array.isArray(player.roleHistory)
    ? player.roleHistory.map((entry) => ({
        roleName: entry.roleName ?? "",
        sinceTurn: entry.sinceTurn ?? 0,
        reason: entry.reason ?? "",
      }))
    : [];
  const realmHistory = Array.isArray(player.realmHistory)
    ? player.realmHistory.map((entry) => ({
        name: entry.name ?? "",
        turn: entry.turn ?? 0,
        note: entry.note ?? "",
      }))
    : [];
  return {
    name: player.name ?? "",
    roleName: player.roleName ?? "",
    lifeIndex: player.lifeIndex ?? 1,
    location: state?.location ?? "",
    motivation: player.motivation ?? "",
    // 来历(拍板 2026-08-20:来历进卡):定约写定的白描全文,随时可查这一世是谁。
    background: player.background ?? "",
    realm: {
      current: ladder.find((trait) => trait.id === currentRealmId)?.name ?? null,
      ladder: ladder.map((trait) => ({
        id: trait.id,
        name: trait.name,
        current: trait.id === currentRealmId,
      })),
    },
    abilities: [
      ...identityAbilities.map((text) => ({ text, source: "identity" })),
      ...learned.map((text) => ({ text, source: "learned" })),
    ],
    abilityLabel: vocabulary.ability,
    inventoryLabel: vocabulary.inventory,
    inventory: (Array.isArray(player.inventory) ? player.inventory : []).map((item) => ({
      name: item.name ?? "",
      note: item.note ?? "",
    })),
    roleHistory,
    realmHistory,
  };
}

// 身份一致校验 + 一次重写:开场与终章都要与当前身份对得上。
// 校验与重写失败一律静默回退原文本——提示词约束仍在,校验只是加一层保险。
function playerCapabilitiesOf(world, state) {
  const player = state?.player ?? {};
  const role = world.roleTemplates?.find((item) => item.id === player.roleId);
  // 习得技能(拍板 2026-08-19)与身份能力合并——与引擎 buildPlayerCapabilities 同口径。
  const identityAbilities = Array.isArray(player.abilities)
    ? player.abilities
    : Array.isArray(role?.abilities)
      ? role.abilities
      : [];
  const learned = Array.isArray(player.learnedAbilities) ? player.learnedAbilities : [];
  return {
    roleName: player.roleName ?? role?.name ?? "",
    roleDescription: role?.description ?? "",
    abilities: [...identityAbilities, ...learned],
    traitIds: Array.isArray(player.traitIds) ? player.traitIds : [],
    // 来历(拍板 2026-08-20:意图即人设):校验器⑦据此区分新旧语义——非空查
    // 「与既定来历矛盾」,空串维持旧档新来者约束。
    background: player.background ?? "",
    gender: player.gender ?? null,
    // 行囊(拍板 2026-08-19):校验器据此判断行动是否用了囊中没有的东西。
    inventory: (Array.isArray(player.inventory) ? player.inventory : []).map((item) =>
      item.note ? `${item.name}（${item.note}）` : item.name,
    ),
    bigFive: BIG_FIVE_DIMENSIONS.map((dim) => {
      const value = Number(player.bigFive?.[dim] ?? 50);
      const level = bigFiveLevel(value);
      const options = world.creationCatalog?.bigFive?.[dim] ?? [];
      // 底色中庸起步(拍板 2026-08-19):行为词由演化选——跨档取该极词,均衡不带词。
      const side = level === "偏低" ? "low" : level === "偏高" ? "high" : null;
      const traits = side ? options.filter((item) => item.pole === side).slice(0, 2) : [];
      return {
        dimension: BIG_FIVE_LABELS[dim] ?? dim,
        key: dim,
        value: Number.isFinite(value) ? value : 50,
        level,
        selections: traits.map((item) => item.name),
        goodSide: traits.map((item) => item.goodSide).filter(Boolean),
        badSide: traits.map((item) => item.badSide).filter(Boolean),
      };
    }),
  };
}

async function ensureIdentityConsistent(text, capabilities, characters, regenerate, worldview, signal) {
  const client = engine?.llm;
  if (!client?.checkIdentityConsistency || typeof text !== "string" || !text.trim()) return text;
  try {
    const verdict = await client.checkIdentityConsistency({
      narrative: text,
      options: [],
      capabilities,
      characters,
      worldview,
      timeoutMs: 60_000,
      signal,
    });
    const issues = verdict?.issues ?? [];
    if (verdict?.ok === false && issues.length) {
      const rewritten = await regenerate(
        "上次文本有身份一致违例，请重写：保持情节与格式不变，只修正违例。违例清单：\n" +
          issues.map((item) => `- ${item.text}`).join("\n"),
      );
      if (typeof rewritten === "string" && rewritten.trim()) return rewritten;
    }
  } catch {}
  return text;
}

function fallbackOpening(gameWorld, gameState, successor = false) {
  const location = gameWorld.locations.find((item) => item.id === gameState.locationId);
  return `${successor ? "这个世界已经被前人的选择改变。" : ""}${gameState.player.name}以${gameState.player.roleName}的身份来到${location?.name ?? gameState.location}，心中仍记着“${gameState.player.motivation}”。眼前没有写好的命运，只有此刻能够承担的选择。`;
}

async function createWindow() {
  closeApproved = false;
  // 窗口不超出屏幕工作区（2026-08-24）：高 DPI 笔记本在 Windows 125%/150%
  // 缩放下逻辑分辨率可能只有 1280×720——固定 1240×860 会比屏幕还高，
  // 整个界面显得巨大。按主屏工作区钳制，留 24px 呼吸边。
  const workArea = screen.getPrimaryDisplay().workArea;
  const created = new BrowserWindow({
    width: Math.min(1240, workArea.width - 24),
    height: Math.min(860, workArea.height - 24),
    minWidth: Math.min(900, workArea.width - 24),
    minHeight: Math.min(640, workArea.height - 24),
    frame: false,
    title: "推演书",
    backgroundColor: "#ffe9ce",
    // 任务栏/窗口图标与打包图标同源（开发态 exe 还是 Electron 默认脸）。
    icon: join(root, "build", "icon.png"),
    webPreferences: {
      preload: join(root, "electron", "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  window = created;
  created.on("closed", () => {
    // 只有当前登记的窗口才清变量:双激活建了两个窗时,先关掉的旧窗不能把
    // 变量清掉——否则活着的窗口从此收不到任何推送(烧制 HUD/叙事流冻结)。
    if (window === created) window = undefined;
  });
  // 烧制中关窗:拦截在这里问一句。before-quit 里再问已经晚了——
  // 窗口关了就是关了,确认框只会变成静默中止(旧 bug)。
  created.on("close", (event) => {
    if (closeApproved || (!runningJobs.size && !bakeQueue.length)) return;
    event.preventDefault();
    const baking = runningJobs.size + bakeQueue.length;
    const choice = dialog.showMessageBoxSync(created, {
      type: "question",
      buttons: ["继续起稿", "退出"],
      defaultId: 0,
      cancelId: 0,
      message:
        baking === 1
          ? `《${[...runningJobs.values()][0]?.title ?? bakeQueue[0]?.title ?? ""}》还在起稿`
          : `还有 ${baking} 部书稿在起稿`,
      detail: "已完成的部分已经保存，下次导入这本书会从中断处继续。",
    });
    if (choice === 0) return;
    bakeQueue.length = 0;
    for (const job of runningJobs.values()) job.controller.abort();
    closeApproved = true;
    created.destroy();
  });
  const notifyState = () => created.webContents.send("window:state", created.isMaximized());
  created.on("maximize", notifyState);
  created.on("unmaximize", notifyState);
  // 纵深防御：应用只加载本地页面（或 dev server）。渲染层一旦触发任何
  // 导航/新窗口都拦下，避免新页面继承 preload 拿到完整 IPC 权限。
  created.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  const devServer = process.env.VITE_DEV_SERVER_URL;
  created.webContents.on("will-navigate", (event, url) => {
    if (!trustedPageUrl(url)) event.preventDefault();
  });
  if (devServer) {
    await created.loadURL(devServer);
  } else {
    await created.loadFile(join(root, "renderer", "dist", "index.html"));
  }
  // 渲染进程崩溃/被杀此前是静默白窗：给用户一个明确的出错框与重载出路
  // （ErrorBoundary 只能兜 React 树内的异常，进程级崩溃到不了它）。
  created.webContents.on("render-process-gone", (_event, details) => {
    if (details.reason === "clean-exit") return;
    console.error("[window] 渲染进程异常退出:", details.reason, details.exitCode);
    dialog
      .showMessageBox(created, {
        type: "error",
        title: "推演书",
        message: "界面进程崩了",
        detail: "书库、进度与设置都在本机盘上，一并无损。重新加载即可回到上次落笔处。",
        buttons: ["重新加载", "就这样"],
        defaultId: 0,
        cancelId: 1,
      })
      .then(({ response }) => {
        if (response === 0) created.webContents.reload();
      })
      .catch(() => {});
  });
}

const gotSingleInstanceLock = app.requestSingleInstanceLock();
if (!gotSingleInstanceLock) {
  // 已有实例在运行：本实例直接退出，避免双实例互相覆盖存档、并发烧制。
  app.quit();
}

app.on("second-instance", () => {
  if (windowAlive()) {
    if (window.isMinimized()) window.restore();
    window.focus();
  }
});

app.on("activate", () => {
  // macOS 关窗后应用仍在运行：从 Dock 点回时重新建窗。失败要落到日志，
  // 不能变成未处理拒绝把整个主进程带崩。
  if (!windowAlive()) {
    createWindow().catch((error) => console.error("[window] 重新建窗失败：", error));
  }
});

// 主进程兜底:任何漏网的异步拒绝只记日志,不触发 Node 默认的崩溃行为——
// 静默闪退比一条错误日志糟糕得多。
process.on("unhandledRejection", (reason) => {
  console.error("[main] 未处理的异步拒绝:", reason);
});

app.whenReady().then(async () => {
  if (!gotSingleInstanceLock) return;
  Menu.setApplicationMenu(null);
  const userData = app.getPath("userData");
  settingsStore = new SettingsStore(join(userData, "settings.json"));
  progressStore = new ProgressStore(join(userData, "progress"));
  usageStore = new UsageStore(join(userData, "usage.json"));
  // 上次崩溃可能留下半截写入的 .tmp：完好的采纳为主档，损坏的丢弃。
  await progressStore.recover();
  // 检查点与分支已经取消，旧的多份存档直接作废。
  await rm(join(userData, "saves"), { recursive: true, force: true });
  // 手动存档槽已随「只留沉浸式续玩点」拍板删除（2026-08-21）：旧 slots/
  // 目录整树清掉，不给用户留打不开的孤儿文件。
  await rm(join(userData, "progress", "slots"), { recursive: true, force: true });
  // 上次失败的重试入口:重启后依然可用(瘦身版任务,只有路径与参数)。
  try {
    const saved = JSON.parse(await readFile(failedBakePath(), "utf8"));
    if (typeof saved?.filePath === "string" && saved.filePath && saved.title) {
      failedJob = { ...saved, novel: undefined };
    }
  } catch {}
  library = new LibraryStore(join(userData, "books"));
  plotStore = new PlotStore(join(userData, "plotting"));
  await createWindow().catch((error) => console.error("[window] 初始建窗失败：", error));
  // 全库身份能力补写:后台串行,不阻塞启动,也不抢烧制配额。
  void upgradeAllRoleAbilities().catch(() => {});
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

app.on("before-quit", (event) => {
  // close 事件拦截已处理正常关窗;这里只剩系统级退出/窗口已灭的兜底:
  // 直接放弃烧制,已落盘的批次仍留在缓存里。
  if (!closeApproved && (runningJobs.size || bakeQueue.length)) {
    bakeQueue.length = 0;
    for (const job of runningJobs.values()) job.controller.abort();
  }
  // 用量账本最终落盘(节流未触发时)。
  void usageStore?.flush().catch(() => {});
  if (quitAfterWrites || !pendingWrites.size) return;
  event.preventDefault();
  void drainPendingWritesThenQuit();
});

// 循环快照等待在途写入：allSettled 只等当次快照，等待期间仍在飞的 IPC
// 处理器还会入队新写入——不等完就放行 quit，新写入会被拦腰杀掉（原子写
// 保住文件不坏，但数据丢了）。上限轮次防异常情况下退出被永久卡死。
async function drainPendingWritesThenQuit() {
  for (let round = 0; round < 50 && pendingWrites.size; round += 1) {
    await Promise.allSettled([...pendingWrites]);
  }
  quitAfterWrites = true;
  app.quit();
}

function windowAlive() {
  return Boolean(window && !window.isDestroyed());
}

ipcMain.on("window:minimize", () => {
  if (windowAlive()) window.minimize();
});
ipcMain.on("window:toggle", () => {
  if (!windowAlive()) return;
  if (window.isMaximized()) window.unmaximize();
  else window.maximize();
});
ipcMain.on("window:close", () => {
  if (windowAlive()) window.close();
});
ipcMain.handle("window:state", (event) => {
  if (!trustedSender(event)) throw new Error("拒绝来自未知来源的调用");
  return Boolean(windowAlive() && window.isMaximized());
});

ipcMain.handle("settings:get", async (event) => {
  if (!trustedSender(event)) throw new Error("拒绝来自未知来源的调用");
  return {
    ...publicSettings(await settingsStore.load()),
    // Linux 无密钥环时 safeStorage 退回 basic_text 弱混淆：设置页据此提示用户。
    secureStorage: safeStorageAvailable(),
  };
});
ipcMain.handle("settings:save", async (event, settings) => {
  if (!trustedSender(event)) throw new Error("拒绝来自未知来源的调用");
  for (const credential of Array.isArray(settings?.credentials) ? settings.credentials : []) {
    assertSecureEndpoint(credential?.baseUrl ?? "");
    assertKnownEndpoint(credential?.baseUrl ?? "");
  }
  await settingsStore.save(settings);
  return publicSettings(await settingsStore.load());
});
function safeStorageAvailable() {
  try {
    return safeStorage.isEncryptionAvailable();
  } catch {
    return false;
  }
}

// IPC 来源校验：只有应用自己的窗口（本地页面 / dev server）能调用敏感通道。
function trustedSender(event) {
  return trustedPageUrl(event?.senderFrame?.url ?? "");
}

// 厂商白名单:https 地址必须落在注册表内的厂商域名(见 src/providers.js)。
// http 地址已由 assertSecureEndpoint 只放行 localhost 本机调试,这里不重复拦截。
function assertKnownEndpoint(baseUrl) {
  if (!baseUrl) return;
  const url = new URL(baseUrl);
  if (url.protocol === "http:") return;
  if (!isKnownProviderBaseUrl(baseUrl)) {
    throw new Error("仅支持已收录的 OpenAI 兼容接口（DeepSeek、千问、OpenAI、Kimi、智谱、硅基流动）");
  }
}

// 只放行 https（本机调试允许 http://localhost）：避免 API Key 明文走网络。
// https 端点再拒绝内网/保留地址：防把带 Key 的请求打到内网服务或云元数据端点。
function assertSecureEndpoint(baseUrl) {
  if (!baseUrl) return;
  let url;
  try {
    url = new URL(baseUrl);
  } catch {
    throw new Error("API 地址不是合法 URL");
  }
  const host = url.hostname.replace(/^\[|\]$/g, ""); // URL 对 IPv6 字面量保留方括号
  if (url.protocol === "https:") {
    if (isPrivateOrReservedHost(host)) {
      throw new Error("仅支持公网 https:// 地址，拒绝内网/保留地址");
    }
    return;
  }
  if (url.protocol === "http:" && ["localhost", "127.0.0.1", "::1"].includes(host)) return;
  throw new Error("仅支持 https:// 地址（本机调试可用 http://localhost），避免 API Key 明文传输");
}

// IPv4/IPv6 字面量判定（含整数/十六进制等非常规写法）移到 net-guard.js，
// 与 electron 解耦后可直接单测。

// 凭证池里每条都自带地址与 Key，所以拉模型和测连接都按 credentialId 定位那一条。
async function resolveCredential({ credentialId, baseUrl, apiKey }) {
  const saved = await settingsStore.load();
  const stored = saved.credentials.find((item) => item.id === credentialId);
  const targetBaseUrl = (baseUrl || stored?.baseUrl || "").trim();
  assertSecureEndpoint(targetBaseUrl);
  // 地址被改过就不再回退到已存 Key，避免拿旧家的 Key 去请求新家。
  const sameProvider = stored && targetBaseUrl === stored.baseUrl;
  return {
    baseUrl: targetBaseUrl,
    apiKey: apiKey || (sameProvider ? stored.apiKey : ""),
  };
}

function credentialError(error) {
  const network = error.name === "TypeError" || error.name === "TimeoutError";
  return network ? "连不上这个 API 地址，检查地址与网络" : error.message;
}

// 拉到模型列表就等于连接成功，所以「测试连接」和「读取模型」共用这一个通道。
ipcMain.handle("settings:models", async (event, target = {}) => {
  if (!trustedSender(event)) throw new Error("拒绝来自未知来源的调用");
  try {
    return { models: await fetchModels(await resolveCredential(target)) };
  } catch (error) {
    return { error: credentialError(error) };
  }
});


// 用量账目（文房「账目」面板）：按书累计的输入/输出 token 与请求数 + 合计。
ipcMain.handle("usage:get", async (event) => {
  if (!trustedSender(event)) throw new Error("拒绝来自未知来源的调用");
  const [books, plots] = await Promise.all([library.list(), plotStore.list()]);
  // 谋篇项目的用量按 projectId 归账，标题并入同一张账目表。
  const titles = new Map(books.map((book) => [book.id, book.title]));
  for (const plot of plots) titles.set(plot.id, `谋篇 · ${plot.title}`);
  titles.set("plot-ideas", "谋篇 · 灵感");
  return usageStore.view(titles);
});

ipcMain.handle("library:list", async (event) => {
  if (!trustedSender(event)) throw new Error("拒绝来自未知来源的调用");
  const [books, turns] = await Promise.all([library.list(), progressStore.turns()]);
  // resumable 区分「0 回合但有续玩点」（建角即落档）与「从未开卷」：
  // 案头卡片与开卷入口都按它判断，而不是只看 turn 数字。
  return books.map((book) => ({
    ...book,
    turn: turns[book.id] ?? 0,
    resumable: Object.prototype.hasOwnProperty.call(turns, book.id),
  }));
});

// 从书架移除一本书：只删书册目录、进度与人物精读缓存，不动烧制缓存——
// 重新导入同一文件仍可从断点续烧。「重新烧制」走 library:rebake 才会清烧制缓存。
async function removeBookFromShelf(id) {
  const target = (await library.list()).find((book) => book.id === id);
  // 正在烧制的同名任务先取消/出队：否则烧完 library.add 会把书重新写回书架。
  // abort 是协作式的，只在下一个信号检查点生效——烧制已生成完结果时靠
  // cancelled 标记拦住 library.add，删除才不会被「复活」。
  if (target) {
    for (const job of runningJobs.values()) {
      if (job.title === target.title) {
        job.cancelled = true;
        job.controller.abort();
      }
    }
    const kept = bakeQueue.filter((job) => job.title !== target.title);
    bakeQueue.length = 0;
    bakeQueue.push(...kept);
  }
  await library.remove(id);
  await enqueueWrite(async () => {
    await progressStore.clear(id);
  });
  // 人物精读缓存按世界 id 分目录，删书时一并清掉，不留孤儿目录。
  if (target?.worldId) {
    const cacheDir = join(
      app.getPath("userData"),
      "character-cache",
      createHash("sha1").update(String(target.worldId)).digest("hex"),
    );
    await rm(cacheDir, { recursive: true, force: true }).catch(() => {});
  }
  if (session?.bookId === id) {
    engine = undefined;
    currentOptions = [];
    activeIntent = null;
    session = undefined;
  }
  return target;
}

ipcMain.handle("library:remove", async (event, id) => {
  if (!trustedSender(event)) throw new Error("拒绝来自未知来源的调用");
  await removeBookFromShelf(id);
  // 账目随书清：下架后不再在账目页挂「已下架的书」残行（重烧不清账）。
  usageStore?.removeBook(id);
  return library.list();
});

// 重新烧制：清掉这本书的全部烧制缓存，用已存原文真正从头烧一遍，
// 烧完由 library.add 把新档案放回书架；进度与存档随旧书册一并清除。
ipcMain.handle("library:rebake", async (event, { bookId }) => {
  if (!trustedSender(event)) throw new Error("拒绝来自未知来源的调用");
  if (typeof bookId !== "string" || !bookId) throw new Error("请先选择一本书");
  const book = await library.load(bookId);
  if (!Array.isArray(book.chapters) || !book.chapters.length) {
    throw new Error("这本书没有留存原文，无法重新起稿");
  }
  const novel = {
    title: book.meta.title,
    format: book.meta.format,
    chapters: book.chapters.map(({ index, title, text }) => ({ index, title, text })),
  };
  // 清掉这本书在烧制缓存里的所有文件（全模型、全切入点、摘要日志一起删）。
  const cacheDirectory = join(app.getPath("userData"), "cache");
  const prefix = novelCachePrefix(novel);
  try {
    for (const name of await readdir(cacheDirectory)) {
      if (name.startsWith(`${prefix}-`)) {
        await rm(join(cacheDirectory, name), { force: true }).catch(() => {});
      }
    }
  } catch {}
  // 旧书册先下架；烧完自动回到书架。
  await removeBookFromShelf(bookId);
  const scope = book.world?.creationScope ?? {};
  const job = {
    id: randomUUID(),
    novel,
    title: novel.title,
    focusChapter: Number.isInteger(scope.focusChapter) ? scope.focusChapter : 1,
    openAll: Boolean(scope.openAll),
    // 保留上次切入的时间锚点:丢锚点会让进入故事时「时点未变」被误判为已变,
    // 每次都触发一次多余的切入重烧。
    anchorTime: Number.isFinite(scope.anchorTime) ? scope.anchorTime : undefined,
    controller: new AbortController(),
  };
  bakeQueue.push(job);
  // 三槽已满才需要排队；drain 只补空位，不重复起跑。
  const queued = runningJobs.size >= MAX_CONCURRENT_BAKES;
  drainBakeQueue();
  return { jobId: job.id, bookTitle: job.title, queued, ...bakeSnapshot() };
});

// 补读:采样烧成的书以全本预算重跑——摘要日志里已有的批次不重读,只烧缺口,
// 五片因覆盖度键变化用更全的摘要重建。不清缓存、不下架,对局/进度/存稿原样保留。
ipcMain.handle("library:coarse-topup", async (event, { bookId } = {}) => {
  if (!trustedSender(event)) throw new Error("拒绝来自未知来源的调用");
  if (typeof bookId !== "string" || !bookId) throw new Error("请先选择一本书");
  const book = await library.load(bookId);
  if (!Array.isArray(book.chapters) || !book.chapters.length) {
    throw new Error("这本书没有留存原文，无法补读");
  }
  if (!book.meta?.coarse?.sampled) throw new Error("这本书不是采样粗读，无需补读");
  const novel = {
    title: book.meta.title,
    format: book.meta.format,
    chapters: book.chapters.map(({ index, title, text }) => ({ index, title, text })),
  };
  const scope = book.world?.creationScope ?? {};
  const job = {
    id: randomUUID(),
    novel,
    title: novel.title,
    focusChapter: Number.isInteger(scope.focusChapter) ? scope.focusChapter : 1,
    openAll: Boolean(scope.openAll),
    // 沿用上次的切入与时间锚点,补读后的世界与旧档开局一致。
    anchorTime: Number.isFinite(scope.anchorTime) ? scope.anchorTime : undefined,
    controller: new AbortController(),
  };
  bakeQueue.push(job);
  const queued = runningJobs.size >= MAX_CONCURRENT_BAKES;
  drainBakeQueue();
  return { jobId: job.id, bookTitle: job.title, queued, ...bakeSnapshot() };
});
// —— 世界分享（拍板 2026-08-21：.cpworld 世界文件）——
// 导出：把烧制产物打包成可分享/备份的 ZIP 容器。轻装档（默认）不带原文；
// 全档带原文与粗读摘要，自用备份/跨机迁移。导出读的是书库当前状态：游玩期
// 写回的跨世事实、涌现实体与人物精读一并携带——那是这个世界被活过的痕迹。

// 人物精读缓存随行：文件名是 sha1(人物id)，导入侧按世界 id 归位后命中即免
// 重新精读。目录不存在（还没精读过）就安静地不带。
async function gatherCharacterCache(worldId) {
  const directory = join(
    app.getPath("userData"),
    "character-cache",
    createHash("sha1").update(String(worldId ?? "")).digest("hex"),
  );
  const entries = [];
  try {
    for (const name of await readdir(directory)) {
      if (!/^[a-f0-9]{40}\.json$/.test(name)) continue;
      entries.push({ name, content: await readFile(join(directory, name), "utf8") });
    }
  } catch {}
  return entries;
}

ipcMain.handle("library:export-world", async (event, { bookId, withSource } = {}) => {
  if (!trustedSender(event)) throw new Error("拒绝来自未知来源的调用");
  if (typeof bookId !== "string" || !bookId) throw new Error("请先选择一本书");
  assertBookId(bookId);
  const book = await library.load(bookId);
  // 粗读摘要与烧制同参找回（同 loadCanonLedger）：书名 + 全文哈希 + 默认批次。
  let summariesText = null;
  if (withSource && book.chapters.length) {
    const novelHash = novelCachePrefix({ title: book.meta.title, chapters: book.chapters });
    const batchHash = createHash("sha1").update("default").digest("hex");
    summariesText = await readFile(
      join(app.getPath("userData"), "cache", `${novelHash}-${batchHash}-w3.summaries.jsonl`),
      "utf8",
    ).catch(() => null);
  }
  const { bytes, manifest } = await buildWorldBundle(
    {
      meta: { title: book.meta.title, format: book.meta.format },
      world: book.world,
      initialState: book.initialState,
      chapters: book.chapters,
      summariesText,
      characterCache: await gatherCharacterCache(book.world?.id),
      provenance: { appVersion: app.getVersion() },
    },
    { withSource: Boolean(withSource) },
  );
  const safeTitle = String(book.meta.title ?? "世界").replace(/[\\/:*?"<>|]/g, "_");
  const result = await dialog.showSaveDialog(window, {
    defaultPath: join(app.getPath("downloads"), `${safeTitle}.${WORLD_BUNDLE_EXTENSION}`),
    filters: [{ name: "推演书世界", extensions: [WORLD_BUNDLE_EXTENSION] }],
  });
  if (result.canceled || !result.filePath) return { ok: false, canceled: true };
  await writeFile(result.filePath, bytes);
  return { ok: true, path: result.filePath, includes: manifest.includes };
});

// 落库一个已解析的世界：书册三文件 → 正典摘要归位 → 人物精读缓存归位。
// 轻装档 chapters 为空数组占位（library.load 对它是硬依赖），meta 标 sourceless；
// 章节目录随书落盘 chapter-index.json——补挂原文时它是「同一本书」的比对基准。
async function commitWorldImport(parsed, title) {
  const meta = parsed.manifest.meta;
  await library.add({
    world: parsed.world,
    initialState: parsed.initialState,
    source: { title, format: meta.format, chapters: parsed.chapters, chapterIndex: parsed.chapterIndex },
    sourceless: parsed.chapters.length === 0,
  });
  // 摘要日志按「书名+全文」哈希归位，只有原名导入才对得上；改名导入时宁可不带
  // （账本优雅降级），也不能写错位置污染别的书的缓存。
  if (parsed.summariesText && parsed.chapters.length && title === meta.title) {
    const novelHash = novelCachePrefix({ title, chapters: parsed.chapters });
    const batchHash = createHash("sha1").update("default").digest("hex");
    const cacheDirectory = join(app.getPath("userData"), "cache");
    await mkdir(cacheDirectory, { recursive: true });
    await writeFile(
      join(cacheDirectory, `${novelHash}-${batchHash}-w3.summaries.jsonl`),
      parsed.summariesText,
      "utf8",
    );
  }
  const worldId = String(parsed.world.id ?? parsed.manifest.worldId ?? "");
  if (worldId && parsed.characterCache.length) {
    const cacheDirectory = join(
      app.getPath("userData"),
      "character-cache",
      createHash("sha1").update(worldId).digest("hex"),
    );
    await mkdir(cacheDirectory, { recursive: true });
    for (const entry of parsed.characterCache) {
      await writeFile(join(cacheDirectory, entry.name), entry.content, "utf8");
    }
  }
}

function worldImportSummary(parsed) {
  return {
    title: parsed.manifest.meta.title,
    format: parsed.manifest.meta.format,
    chapterCount: parsed.manifest.meta.chapterCount,
    includes: parsed.manifest.includes,
    provenance: parsed.manifest.provenance,
    sourceless: parsed.chapters.length === 0,
  };
}

// 导入冲突的挂起态：解析结果在内存里等渲染层拍板（覆盖/跳过/改名），不落盘。
let pendingWorldImport = null;

ipcMain.handle("library:import-world", async (event) => {
  if (!trustedSender(event)) throw new Error("拒绝来自未知来源的调用");
  const result = await dialog.showOpenDialog(window, {
    properties: ["openFile"],
    filters: [{ name: "推演书世界", extensions: [WORLD_BUNDLE_EXTENSION] }],
  });
  if (result.canceled || !result.filePaths?.length) return { status: "canceled" };
  // 大文件先按大小拒绝，别把压缩炸弹整包读进内存（解析侧还有逐条目预检）。
  const info = await stat(result.filePaths[0]);
  if (info.size > 256 * 1024 * 1024) throw new Error("世界文件超过 256MB 上限");
  const parsed = await parseWorldBundle(await readFile(result.filePaths[0]));
  const id = bookIdFor(parsed.manifest.meta.title, parsed.manifest.meta.format);
  if ((await library.list()).some((book) => book.id === id)) {
    pendingWorldImport = { parsed };
    return { status: "conflict", ...worldImportSummary(parsed) };
  }
  await commitWorldImport(parsed, parsed.manifest.meta.title);
  return { status: "imported", ...worldImportSummary(parsed) };
});

ipcMain.handle("library:import-world-confirm", async (event, { action, newTitle } = {}) => {
  if (!trustedSender(event)) throw new Error("拒绝来自未知来源的调用");
  if (!pendingWorldImport) throw new Error("没有待确认的世界导入");
  const { parsed } = pendingWorldImport;
  if (action === "skip") {
    pendingWorldImport = null;
    return { status: "skipped" };
  }
  const title =
    action === "rename"
      ? String(newTitle ?? "").trim().slice(0, 200)
      : parsed.manifest.meta.title;
  if (!title) throw new Error("请为这个世界填写一个新的书名");
  // 改名后仍可能撞上另一本：一次校验，撞上就让用户再换个名字（挂起态保留）。
  const id = bookIdFor(title, parsed.manifest.meta.format);
  if ((await library.list()).some((book) => book.id === id)) {
    throw new Error("这个书名也已有同格式的一本书，请换个名字");
  }
  pendingWorldImport = null;
  // 覆盖 = 先按删书清理（对局/进度/存档/精读缓存一并收走），再落新世界；
  // 旧世界的游玩痕迹不该混进别人分享的版本里。
  if (action === "overwrite") await removeBookFromShelf(id);
  await commitWorldImport(parsed, title);
  return { status: "imported", title, ...worldImportSummary(parsed) };
});

// —— 补挂原文（轻装档导入后的满血通道）——
// 读者自有原著（txt/epub）：按档案自带的章节目录比对「同一本书」，比对过才
// 落库；落库后重跑一遍定向粗读（coarseOnly：只烧摘要日志，不重建世界档案），
// 正典账本、文风范本、人物精读随 chapters 就位全部自动恢复。钱由读者付、
// 版本由目录把关、世界档案原样保留——这就是轻装档分享的完整闭环。
let pendingAttach = null;

ipcMain.handle("library:attach-source", async (event, { bookId } = {}) => {
  if (!trustedSender(event)) throw new Error("拒绝来自未知来源的调用");
  if (typeof bookId !== "string" || !bookId) throw new Error("请先选择一本书");
  assertBookId(bookId);
  const book = await library.load(bookId);
  if (Array.isArray(book.chapters) && book.chapters.length) {
    throw new Error("这本书已有原文，无需补挂");
  }
  if (!book.meta?.sourceless) throw new Error("只有无原文的导入世界才需要补挂原文");
  const result = await dialog.showOpenDialog(window, {
    properties: ["openFile"],
    filters: [{ name: "小说", extensions: ["txt", "epub"] }],
  });
  if (result.canceled || !result.filePaths?.length) return { status: "canceled" };
  const path = result.filePaths[0];
  const info = await stat(path);
  if (info.size > 512 * 1024 * 1024) throw new Error("文件超过 512MB 上限，请先精简后重试");
  const novel = await parseNovel({
    name: path.split(/[\\/]/).at(-1),
    buffer: await readFile(path),
  });
  novel.filePath = path;
  // 摘要日志的缓存键 = sha1(书名 + 全部正文)：必须用书架 meta 的书名（账本
  // 加载侧 loadCanonLedger 用的就是它），文件名推导的书名只配进警告。
  const titleFromFileName = novel.title;
  novel.title = book.meta.title;
  const chapterIndex = await library.loadChapterIndex(bookId);
  const match = chapterIndex.length
    ? matchSourceToIndex({ chapters: novel.chapters, chapterIndex })
    : { countIndex: 0, countParsed: novel.chapters.length, matched: 0, ratio: 0, verdict: "unverified" };
  if (match.verdict === "mismatch") {
    throw new Error(
      `这份原文与档案目录对不上（档案 ${match.countIndex} 章、原文 ${match.countParsed} 章、标题仅对上 ${match.matched} 个），` +
        "不能确定是同一本书。请确认选的是同版本原著，或换一份更完整的文件。",
    );
  }
  const characters = novel.chapters.reduce((total, item) => total + item.text.length, 0);
  pendingAttach = { bookId, novel };
  return {
    status: "confirm",
    bookId,
    bookTitle: book.meta.title,
    parsedTitle: titleFromFileName,
    format: novel.format,
    chapterCount: novel.chapters.length,
    indexChapterCount: chapterIndex.length || null,
    matched: match.matched,
    ratio: match.ratio,
    verdict: match.verdict,
    characters,
    estimatedInputTokens: estimateBakeInputTokens(characters),
    warnings: [
      ...(novel.warnings ?? []),
      ...(titleFromFileName !== book.meta.title
        ? [`文件名看是《${titleFromFileName}》，与书架标题不同——已按书架标题对齐粗读缓存`]
        : []),
    ],
  };
});

ipcMain.handle("library:attach-source-confirm", async (event, { action } = {}) => {
  if (!trustedSender(event)) throw new Error("拒绝来自未知来源的调用");
  if (!pendingAttach) throw new Error("没有待确认的补挂");
  const { bookId, novel } = pendingAttach;
  if (action !== "attach") {
    pendingAttach = null;
    return { status: "canceled" };
  }
  pendingAttach = null;
  // 下架竞态：确认前书被移走就别挂了（挂进幽灵书位只会变成孤儿目录）。
  const book = await library.load(bookId);
  const scope = book.world?.creationScope ?? {};
  const meta = await library.attachSource(bookId, novel.chapters, book.world);
  const job = {
    id: randomUUID(),
    coarseOnly: true,
    bookId,
    novel,
    title: meta.title,
    // 采样窗口按档案记录的切入章重演：与导出方烧制时的选批口径一致。
    focusChapter: Number.isInteger(scope.focusChapter) ? scope.focusChapter : 1,
    controller: new AbortController(),
  };
  bakeQueue.push(job);
  const queued = runningJobs.size >= MAX_CONCURRENT_BAKES;
  drainBakeQueue();
  return { status: "attached", jobId: job.id, bookTitle: meta.title, queued, ...bakeSnapshot() };
});

// 跨世编年史（拍板 2026-08-19）：世界跨世延续的可读呈现——历世生死、改命
// 记录、大事记与当前世基业。数据全部已在档：past-life/role-transition 事实
// 由转世写入书库，改命数据由 divergence 路径留存，大事记即世界时间线。
ipcMain.handle("library:chronicle", async (event, bookId) => {
  if (!trustedSender(event)) throw new Error("拒绝来自未知来源的调用");
  assertBookId(bookId);
  const book = await library.load(bookId);
  const world = book.world ?? {};
  const facts = world.facts ?? [];
  const start = storyStart(world);
  const day = (time) => Math.max(0, Math.floor((Number(time) || 0) - start) / 1440) + 1;
  const lives = facts
    .filter((fact) => fact.id?.startsWith("past-life-") || fact.id?.startsWith("role-transition-"))
    .map((fact) => ({ text: String(fact.text ?? "").trim() }))
    .filter((item) => item.text);
  const divergences = facts
    .filter((fact) => fact.source === "player_divergence" || fact.id?.startsWith("div-override:"))
    .map((fact) => ({ text: String(fact.text ?? "").trim() }))
    .filter((item) => item.text);
  const events = [...(world.timeline ?? [])]
    .sort((left, right) => (Number(left.time) || 0) - (Number(right.time) || 0))
    .slice(-40)
    .map((item) => ({
      day: day(item.time),
      text: String(item.text ?? "").trim(),
      source: item.source === "emergent" ? "emergent" : "canon",
      tier: item.tier ?? "side",
    }))
    .filter((item) => item.text);
  let ventures = [];
  try {
    const saved = await progressStore.read(bookId);
    ventures = (saved?.snapshots?.at(-1)?.emergentStories ?? [])
      .filter((story) => story.kind === "venture")
      .map((story) => ({ title: story.title, erupted: Boolean(story.erupted) }));
  } catch {}
  return {
    title: world.title ?? book.meta.title,
    lives,
    divergences,
    events,
    ventures,
  };
});

async function upgradeBookIfNeeded(book, client) {
  if (!book.legacyWorld || !client) return book;
  const upgraded = await client.completeFastTool(
    [
      {
        role: "system",
        content:
          "补齐这个旧小说世界档案，只返回 JSON：factions、roleTemplates、locations、characters。保留原有 id/name/summary，不删除任何原人物；人物补 factionId、locationIds、firstChapter、lastChapter、status、summary。",
      },
      {
        role: "user",
        content: JSON.stringify({
          world: book.world,
          chapters: book.chapters.map(({ index, title, text }) => ({ index, title, text })),
        }),
      },
    ],
    submitUpgradeWorldTool(),
    { timeoutMs: BAKE_TIMEOUT_MS },
  );
  const nextWorld = normalizeWorld({ ...book.world, ...upgraded, schemaVersion: 2 });
  await library.updateWorld(book.meta.id, nextWorld, book.initialState);
  return { ...book, world: nextWorld };
}

// 身份能力补写:旧书(角色档案里没有 abilities)打开时补一次快模型请求,
// 给每个身份写「能做什么/数值修饰」,让创角信息能驱动回合选项与叙事。
// 同时补「目录一致性」(跨类近义重叠/矛盾互斥)——旧书没有 excludes 时,
// 建角向导无法灰掉矛盾组合。失败静默回退旧行为。
// 同一本书的补写经 KeyedSingleFlight 去重:开书路径与后台升级循环并发跑
// 同一本书时,两个 load→LLM→updateWorld 是最后写者赢,先完成的一轮会被
// 静默覆盖丢失;后到的调用直接跳过,返回未补写的旧书。
const roleAbilityFill = new KeyedSingleFlight();
async function ensureRoleAbilities(book, client) {
  if (!client) return book;
  const { skipped, value } = await roleAbilityFill.run(book.meta.id, () =>
    fillRoleAbilities(book, client),
  );
  return skipped ? book : value;
}

async function fillRoleAbilities(book, client) {
  let updated = book;
  const roles = book.world?.roleTemplates ?? [];
  const rolesNeedFill =
    roles.length > 0 &&
    !roles.some((role) => Array.isArray(role.abilities) && role.abilities.length);
  const catalog = book.world?.creationCatalog ?? {};
  const catalogNeedsCoherence =
    Object.keys(catalog).length > 0 &&
    !Object.values(catalog)
      .flat()
      .some((item) => Array.isArray(item?.excludes) && item.excludes.length > 0);
  // 时间线事实变化:旧书事件没有 factsToAdd/factsToInvalidate 时补写——
  // 「原文已发生即世界现状」靠它落地(黄枫谷已灭这类背景事实)。
  const timelineNeedsFactChanges =
    (book.world?.timeline ?? []).length > 0 &&
    !book.world.timeline.some(
      (event) =>
        (event.factsToAdd?.length ?? 0) > 0 || (event.factsToInvalidate?.length ?? 0) > 0,
    );
  if (!rolesNeedFill && !catalogNeedsCoherence && !timelineNeedsFactChanges) return book;
  try {
    if (rolesNeedFill) {
      const filled = await client.completeFastTool(
        [
          {
            role: "system",
            content:
              "你是小说身份能力补写器。给每个身份补 abilities 与可选 statMods/attributeMods/traitIds/authority，只返回 JSON：{\"roles\":[{\"id\":\"...\",\"abilities\":[\"一条能力短句\"],\"statMods\":{\"修为\":5},\"attributeMods\":{\"定力\":10},\"traitIds\":[\"元婴\"],\"authority\":[\"inspect\"]}]}。abilities 是 1-3 条、每条不超过 40 字的短句：写这个身份在原文世界观里实际能做什么与做不到什么，必须与身份名和描述一致，禁止编造原文没有的能力——能力随题材而异（仙侠=法术/神识，武侠=内功/招式，都市=职权/人脉/技能，悬疑=刑侦手段/权限，历史=官职权柄），一律以原文为准；statMods/attributeMods 的键只能引用给出的 stat/attribute id，值是有限数字，stat 增减后仍须落在 min/max 内、attribute 增减后不得为负；traitIds 是该身份蕴含的 traits 特质 id（境界/资质类，最多 6 个），只引用给出的 traits id；authority 是该身份在其惯常势力内的职权权限数组，只能是 command/manage/inspect 中的值，无职权则省略；没有把握就省略数值与特质字段。",
          },
          {
            role: "user",
            content: JSON.stringify({
              title: book.world.title,
              stats: book.world.stats.map((stat) => ({ id: stat.id, name: stat.name, min: stat.min, max: stat.max, initial: stat.initial })),
              attributes: book.world.attributes.map((attribute) => ({ id: attribute.id, name: attribute.name, initial: attribute.initial })),
              traits: book.world.traits,
              roles: roles.map((role) => ({ id: role.id, name: role.name, description: role.description })),
            }),
          },
        ],
        submitRoleAbilitiesTool(),
        { timeoutMs: BAKE_TIMEOUT_MS },
      );
      const byId = new Map((Array.isArray(filled?.roles) ? filled.roles : []).map((role) => [role.id, role]));
      if (byId.size) {
        const nextWorld = normalizeWorld({
          ...updated.world,
          roleTemplates: roles.map((role) => sanitizeRoleCapabilities({ ...role, ...(byId.get(role.id) ?? {}) })),
        });
        await library.updateWorld(book.meta.id, nextWorld, book.initialState);
        updated = { ...updated, world: nextWorld };
      }
    }
    if (catalogNeedsCoherence) {
      const coherence = await client.completeFastTool(
        [
          { role: "system", content: CATALOG_COHERENCE_PROMPT },
          {
            role: "user",
            content: JSON.stringify({ catalog: updated.world.creationCatalog }),
          },
        ],
        submitCatalogCoherenceTool(),
        { timeoutMs: BAKE_TIMEOUT_MS },
      );
      const nextWorld = applyCatalogCoherence(updated.world, coherence);
      if (nextWorld !== updated.world) {
        await library.updateWorld(book.meta.id, nextWorld, book.initialState);
        updated = { ...updated, world: nextWorld };
      }
    }
    if (timelineNeedsFactChanges) {
      const filled = await client.completeFastTool(
        [
          {
            role: "system",
            content:
              "你是小说时间线事实补写器。给每个改变世界状态的关键事件补 factsToAdd/factsToInvalidate，只返回 JSON：{\"timeline\":[{\"id\":\"...\",\"factsToAdd\":[{\"id\":\"...\",\"text\":\"...\",\"chapterAnchor\":章节号}],\"factsToInvalidate\":[\"已有事实id\"]}]}。factsToInvalidate 只能引用给出的 facts id；factsToAdd 是该事件发生后成为真的事实（灭门/陨落/易主/城破/政变/破产/婚变等，全题材通用，id 不得与已有事实重复）；切入章节之前已发生的节点尤其要写；拿不准的省略。",
          },
          {
            role: "user",
            content: JSON.stringify({
              timeline: updated.world.timeline.map((event) => ({
                id: event.id,
                text: event.text,
                chapterAnchor: event.chapterAnchor,
                time: event.time,
              })),
              facts: updated.world.facts.map((fact) => ({
                id: fact.id,
                text: fact.text,
                chapterAnchor: fact.chapterAnchor,
              })),
            }),
          },
        ],
        submitTimelineFactsTool(),
        { timeoutMs: BAKE_TIMEOUT_MS },
      );
      const byId = new Map(
        (Array.isArray(filled?.timeline) ? filled.timeline : []).map((event) => [event.id, event]),
      );
      if (byId.size) {
        const nextWorld = normalizeWorld({
          ...updated.world,
          timeline: updated.world.timeline.map((event) =>
            sanitizeEventFactChanges({ ...event, ...(byId.get(event.id) ?? {}) }),
          ),
        });
        await library.updateWorld(book.meta.id, nextWorld, book.initialState);
        updated = { ...updated, world: nextWorld };
      }
    }
    return updated;
  } catch {
    return updated;
  }
}

// 全库身份能力补写:不只为「正在读的那一本」——启动后后台串行过一遍所有
// 还没有 abilities 的旧书,失败静默(下次启动再补),烧制在跑时不抢配额。
// 只改书库世界文件;进行中的存档在打开时经 mergeRoleCapabilities 合入。
async function upgradeAllRoleAbilities() {
  let client;
  try {
    client = await configuredClient();
  } catch {
    return;
  }
  for (const book of await library.list()) {
    if (bakeRunning()) return;
    try {
      // 同样向玩家回合让路:补写是后台活,不跟交互抢快模型配额。
      await waitForInteractiveIdle();
      // 等待空闲期间可能排进了烧制:再查一次,别跟烧制抢同一个快模型配额
      // (waitForInteractiveIdle 只看玩家回合,不看烧制)。
      if (bakeRunning()) return;
      await ensureRoleAbilities(await library.load(book.id), client);
    } catch {}
  }
}

// 存档里的世界是旧档案快照:把书库(可能已补写能力)的身份能力按 id 合入,
// 只填 abilities/mods/traitIds/authority,不动存档里原有的身份集合与内容。
function mergeRoleCapabilities(savedWorld, libraryWorld) {
  const byId = new Map((libraryWorld?.roleTemplates ?? []).map((role) => [role.id, role]));
  if (!byId.size) return savedWorld;
  return {
    ...savedWorld,
    roleTemplates: (savedWorld.roleTemplates ?? []).map((role) => {
      const upgraded = byId.get(role.id);
      if (!upgraded) return role;
      return {
        ...role,
        ...(Array.isArray(upgraded.abilities) ? { abilities: upgraded.abilities } : {}),
        ...(upgraded.statMods ? { statMods: upgraded.statMods } : {}),
        ...(upgraded.attributeMods ? { attributeMods: upgraded.attributeMods } : {}),
        ...(Array.isArray(upgraded.traitIds) ? { traitIds: upgraded.traitIds } : {}),
        ...(Array.isArray(upgraded.authority) ? { authority: upgraded.authority } : {}),
      };
    }),
  };
}

ipcMain.handle("story:new", async (event, { bookId }) => {
  if (!trustedSender(event)) throw new Error("拒绝来自未知来源的调用");
  if (typeof bookId !== "string" || !bookId) throw new Error("请先选择一本书");
  // 回合/意图在途时拒绝任何换局(⓪3,不限书):换书同样会顶掉活对局。已完成的
  // 回合虽会无条件落盘,但界面/全局态仍属旧会话——让它先落定再换。
  if (turnBusy()) {
    throw new Error("这一手还在推演——稍候再开，或先回推演台等它落定");
  }
  // 凭据解析放在任何全局状态改变之前：失败直接抛给渲染层，旧对局原封不动。
  const client = await configuredClient();
  // 先把书和世界读进来，成功之后再动续玩点：load 失败不该已经删掉旧一世。
  let book = await library.load(bookId);
  try {
    // 烧制在跑时跳过旧档案补写:这些是快模型请求,与烧制抢同一个槽位,
    // 会让开书卡上几分钟;烧制结束后由 upgradeAllRoleAbilities 兜底补上。
    if (!bakeRunning()) book = await upgradeBookIfNeeded(book, client);
  } catch (error) {
    // 补齐旧档案是锦上添花，失败了就用规范化后的世界照常开局。
    console.warn("[world-upgrade]", error.message);
  }
  // 身份能力补写:旧书一次快模型请求,失败静默;创角信息与选项由此挂钩。
  if (!bakeRunning()) book = await ensureRoleAbilities(book, client);
  // 引擎建好之前不换会话：这里任何一步抛出，engine/session 仍是旧对局。
  const nextEngine = buildEngine({
    gameWorld: book.world,
    gameState: book.initialState,
    llm: client,
    sourceChapters: book.chapters,
    bookTitle: book.meta?.title ?? null,
  });
  commitEngine(nextEngine, {
    sourceChapters: book.chapters,
    // 预设选项已取消：开局不预设选项，由玩家输入意图动态产生。
    options: [],
    session: newStorySession(bookId),
  });
  activeIntent = null;
  // 引擎建立成功之后才清旧的续玩点。清理仍走写队列，与之前排队的自动存档串行，
  // 否则旧存档会在清档之后「复活」，把新一世的续玩点覆盖成旧一世。
  await enqueueWrite(() => progressStore.clear(bookId));
  return {
    ...openingView(engine.world, engine.store.current),
    characterSetup: true,
    characterWorld: engine.world,
  };
});

ipcMain.handle("story:create-character", async (event, profile) => {
  if (!trustedSender(event)) throw new Error("拒绝来自未知来源的调用");
  if (!engine) throw new Error("请先选择一本书");
  // 所愿合一(拍板 2026-08-20):建角传入的 motivation 既当过 personalGoals[0],
  // 也当过拟稿的锚;空串由 createPlayerState 回落创角目录默认。
  const created = createPlayerState(engine.world, profile);
  const state = profile.successor
      ? createSuccessorState(
        engine.store.current,
        created,
        engine.world,
      )
    : created;
  // 建角/转世换引擎也走「先建后提交」：局部建好、会话一并确定后才动全局——
  // 中途任何失败都保持旧对局原样（与 story:new 同一防串档纪律）。
  const nextEngine = buildEngine({
    gameWorld: engine.world,
    gameState: state,
    llm: engine.llm,
    sourceChapters: currentSourceChapters,
    // 同一本书换引擎（建角/转世）：账本是书级资产，直接复用不重读。
    canonLedger: engine.canonLedger,
  });
  commitEngine(nextEngine, {
    sourceChapters: currentSourceChapters,
    options: [],
    // 转世沿用同一本书的会话，但要把「已死」标记摘掉，新的一世才能落续玩点。
    session: profile.successor ? { ...session, dead: false } : newStorySession(session.bookId),
  });
  // 新的一世,方向重新由玩家定。
  activeIntent = null;
  let opening = fallbackOpening(engine.world, engine.store.current, profile.successor);
  if (engine.llm instanceof OpenAiCompatibleClient) {
    enterInteractive();
    try {
      safeSend("story:phase", "opening");
      // 前世留下的世界事实:传闻/遗物/余波要能自然浮现在新一世的开场里。
      const pastLifeFacts = (engine.world.facts ?? []).filter(
        (fact) =>
          (fact.id?.startsWith("past-life-") ||
            fact.id?.startsWith("role-transition-") ||
            fact.source === "player_divergence") &&
          (fact.chapterAnchor ?? 1) <= engine.store.current.unlockedChapter,
      );
      opening = await engine.llm.generateOpening({
        world: engine.world,
        state: engine.store.current,
        successor: profile.successor,
        styleSamples: engine.styleSamplesFor({ query: opening }),
        pastLifeFacts,
      });
      // 开场也要与身份对得上:违例则带清单重写一次,失败静默。
      opening = await ensureIdentityConsistent(
        opening,
        playerCapabilitiesOf(engine.world, engine.store.current),
        engine.world.characters ?? [],
        (rewriteNote) =>
          engine.llm.generateOpening({
            world: engine.world,
            state: engine.store.current,
            successor: profile.successor,
            styleSamples: engine.styleSamplesFor({ query: opening }),
            pastLifeFacts,
            rewriteNote,
          }),
        worldviewForCheck(engine.world),
      );
    } catch {} finally {
      exitInteractive();
    }
  }
  // 开场必须写回引擎状态：第一回合的上下文只带 chapterSummary 和历史回合，
  // 开场若只留在界面上，模型看不到它，就会另起一个和开场无关的场景。
  const opened = engine.store.current;
  opened.chapterSummary = opening;
  // 标记「开场已写给读者」:第一回合据此接续开场而不是复述一遍。
  opened.openingNarrated = true;
  engine.store.snapshots[engine.store.snapshots.length - 1] = opened;
  // 建角即落续玩点(拍板 2026-08-19):开场已写回状态,此刻关窗/崩溃也要能
  // 从书架续读——否则第一回合落定前退出,重开就要重新建角,白写一世的开场。
  if (!session.dead) {
    const targetEngine = engine;
    const targetSession = { ...session };
    await enqueueWrite(async () => {
      const targetOptions = structuredClone(currentOptions);
      await progressStore.write(
        targetSession.bookId,
        serializeEngine(targetEngine, { ...targetSession, currentOptions: targetOptions }),
      );
    });
  }
  return { ...openingView(engine.world, opened), opening };
});

ipcMain.handle("novel:choose", async (event) => {
  if (!trustedSender(event)) throw new Error("拒绝来自未知来源的调用");
  const result = await dialog.showOpenDialog(window, {
    properties: ["openFile"],
    filters: [{ name: "小说", extensions: ["txt", "epub"] }],
  });
  if (result.canceled) return null;
  const path = result.filePaths[0];
  // 大文件先按大小拒绝，别把几个 G 的文件整本读进内存。
  const info = await stat(path);
  if (info.size > 512 * 1024 * 1024) {
    throw new Error("文件超过 512MB 上限，请先精简后重试");
  }
  pendingNovel = await parseNovel({
    name: path.split(/[\\/]/).at(-1),
    buffer: await readFile(path),
  });
  // 记下原文件路径：失败重试时按路径重读，不必把整本小说常驻内存。
  pendingNovel.filePath = path;
  const settings = await settingsStore.load();
  const characterCount = pendingNovel.chapters.reduce((total, item) => total + item.text.length, 0);
  return {
    title: pendingNovel.title,
    format: pendingNovel.format,
    chapterCount: pendingNovel.chapters.length,
    characters: characterCount,
    // 烧前成本预估:粗读=通读全书,占输入 token 九成以上。
    estimatedInputTokens: estimateBakeInputTokens(characterCount),
    warnings: pendingNovel.warnings ?? [],
    cleanedLines: pendingNovel.cleanedLines ?? 0,
    currentModel: settings.fast.model,
    // 世界片缓存按模型分家(粗读/文风书级共享),提示「上次是用 X 烧的」。
    cachedModels: await cachedModelsFor(pendingNovel),
    // 烧到一半的断点:重新导入会接着烧,导入页给一句预告。
    cachedBake: await unfinishedBakeFor(pendingNovel),
  };
});

// 同一本书在缓存里按模型分成多份，读回每份记下的模型名，用来提示「上次是用 X 烧的」。
async function cachedModelsFor(novel) {
  const directory = join(app.getPath("userData"), "cache");
  const prefix = novelCachePrefix(novel);
  let names;
  try {
    names = await readdir(directory);
  } catch {
    return [];
  }
  const found = new Set();
  for (const name of names) {
    if (!name.startsWith(`${prefix}-`) || !name.endsWith(".json")) continue;
    try {
      const checkpoint = JSON.parse(await readFile(join(directory, name), "utf8"));
      if (checkpoint.modelName) found.add(checkpoint.modelName);
    } catch {}
  }
  return [...found];
}

// 这本书有没有烧到一半的缓存:切入章节对应的焦点检查点存在但没有 complete 标记。
// 重新导入同一文件会从断点续烧,导入页据此给一句预告。
async function unfinishedBakeFor(novel) {
  const directory = join(app.getPath("userData"), "cache");
  const prefix = novelCachePrefix(novel);
  let names;
  try {
    names = await readdir(directory);
  } catch {
    return null;
  }
  for (const name of names) {
    if (!name.startsWith(`${prefix}-`) || !name.endsWith(".json")) continue;
    // 只有 focus 文件(五段:novelHash-模型哈希-批次哈希-w3-切入章)承载烧制进度,
    // complete 标记也在那里;书级元数据文件(三/四段)没有「烧到一半」的概念,
    // 不按段数过滤会被误当成断点档。采样烧制的 focus 文件多一段覆盖度哈希
    // (六段),切入章取倒数第二段。
    const segments = name.slice(0, -".json".length).split("-");
    if (segments.length !== 5 && segments.length !== 6) continue;
    try {
      const checkpoint = JSON.parse(await readFile(join(directory, name), "utf8"));
      if (checkpoint.complete === true) continue;
      const focusChapter = Number(
        segments[segments.length - (segments.length === 5 ? 1 : 2)],
      );
      return {
        focusChapter: Number.isInteger(focusChapter) && focusChapter > 0 ? focusChapter : null,
        modelName: checkpoint.modelName ?? "",
      };
    } catch {}
  }
  return null;
}

function bakeSnapshot() {
  // 纯聚合快照：多本并发下没有「当前这本」可言，jobId/bookTitle 由每个 job
  // 自己的事件载荷携带（进度/完成/失败事件的闭包各带各的）。
  return {
    // 队列计数单独命名，免得和阶段进度的 current/total 撞名。
    running: runningJobs.size,
    queued: bakeQueue.length,
  };
}

async function runBakeJob(job) {
  const client = await configuredClient();
  const settings = await settingsStore.load();
  // 并发自动档（2026-08-17）：留空时按快槽厂商官方建议（DeepSeek 4 / 千问 3）。
  // 这份预算是全局闸的总量（所有在跑 job 共享），不是本 job 独享；只增不减。
  bakeGate.updateBudget(resolveBakeConcurrency(settings));
  const baker = new NovelBaker({
    cacheDirectory: join(app.getPath("userData"), "cache"),
    // 交互请求优先:玩家在跑回合时烧制让路,回合的叙事/结构请求不再与
    // 烧制并发抢快模型配额(429 会把回合拖到超时失败)。取消时同步放行,
    // 随后 completeFast 会因同一信号立即失败。烧制闸叠在其外层:三本并烧
    // 的请求总量与单本时同一量级,不放大限流压力。
    completeJson: async (messages, options = {}) => {
      const signal = options.signal ?? job.controller.signal;
      await waitForInteractiveIdle({ signal });
      await bakeGate.acquire(signal);
      try {
        return options.tool
          ? client.completeFastTool(messages, options.tool, { timeoutMs: BAKE_TIMEOUT_MS, ...options })
          : client.completeFast(messages, { timeoutMs: BAKE_TIMEOUT_MS, ...options });
      } finally {
        bakeGate.release();
      }
    },
    modelName: settings.fast.model,
    concurrency: resolveBakeConcurrency(settings),
    // 烧制先联网搜公开资料:关键词按题材定制,搜不到/断网自动回退纯摘要生成,永不阻塞烧制。
    webSearch: ({ title, genre }) => searchBookReference({ title, keywords: genreSearchKeywords(genre) }),
  });
  // 粗读批次完成速率的滚动样本:ETA 只在粗读阶段有意义,换阶段即清空。
  const coarseSamples = [];
  const baked = await baker.bake(job.novel, {
    focusChapter: job.focusChapter,
    openAll: Boolean(job.openAll),
    anchorTime: job.anchorTime,
    // 采样粗读预算:缺省=全本。补读(library:coarse-topup)不传预算,即烧满全书。
    coarseBudgetChars: job.coarseBudgetChars,
    // 定向粗读(补挂原文):只烧摘要日志,不产出世界。
    coarseOnly: Boolean(job.coarseOnly),
    onProgress: (progress) => {
      if (progress.stage !== "coarse") {
        coarseSamples.length = 0;
      } else if (Number.isFinite(progress.current) && Number.isFinite(progress.total)) {
        coarseSamples.push({ current: progress.current, total: progress.total, at: Date.now() });
        if (coarseSamples.length > 8) coarseSamples.shift();
      }
      const etaSeconds = progress.stage === "coarse" ? estimateCoarseEtaSeconds(coarseSamples) : null;
      safeSend("bake:progress", {
        jobId: job.id,
        bookTitle: job.title,
        ...bakeSnapshot(),
        ...progress,
        ...(etaSeconds == null ? {} : { etaSeconds }),
      });
    },
    signal: job.controller.signal,
  });
  // 书在烧制途中被下架：abort 没赶上生成收尾时，结果直接丢弃，不许写回书架。
  if (job.cancelled) return null;
  // 定向粗读不写回书架：世界档案来自导入、原样在架，这里只烧了摘要日志。
  // 返回既有 bookId 的伪 meta，完成事件据此走 HUD 常规收口。
  if (baked?.coarseOnly) {
    return { id: job.bookId, title: job.title, degraded: null, coarse: null, coarseOnly: true };
  }
  const meta = await library.add({ ...baked });
  return meta;
}

// 补满空槽的调度：每个 job 的生命周期独立收口，结束时让出槽位并再补一轮。
// 队列与在跑全空时做一次旧档案补写兜底。
function drainBakeQueue() {
  while (bakeQueue.length && runningJobs.size < MAX_CONCURRENT_BAKES) {
    const job = bakeQueue.shift();
    runningJobs.set(job.id, job);
    void runBakeJobLifecycle(job);
  }
}

async function runBakeJobLifecycle(job) {
  try {
    const meta = await runBakeJob(job);
    // 书已下架的烧制结果丢弃：不广播 bake:done，渲染层不该把它当新书。
    if (meta) {
      safeSend("bake:done", {
        jobId: job.id,
        bookId: meta.id,
        bookTitle: job.title,
        degraded: meta.degraded ?? null,
        // 采样粗读的覆盖度:HUD/案头可提示「这卷是采样烧的,可补读」。
        coarse: meta.coarse ?? null,
      });
    }
  } catch (error) {
    // 用户主动取消不算失败:不写 failed-bake.json,否则重启后会出现一条
    // 指向已取消任务的「重试」入口,点了只会把整本书重复烧一遍。
    const cancelled = error.name === "BakeCancelledError";
    if (!cancelled) {
      // 失败槽只留最近一次（多本并发的取舍）：两本同败时后者覆盖前者，
      // 重试入口只有一个。重试会把整本重烧，留最新失败的大概率是对的。
      failedJob = {
        id: job.id,
        title: job.title,
        focusChapter: job.focusChapter,
        openAll: Boolean(job.openAll),
        anchorTime: job.anchorTime,
        ...(job.coarseBudgetChars ? { coarseBudgetChars: job.coarseBudgetChars } : {}),
        // 定向粗读的失败任务必须原样重试：丢了这两个标记，重试会退化成完整
        // 起稿并 library.add 覆盖导入的世界档案——那是灾难性的静默降级。
        ...(job.coarseOnly ? { coarseOnly: true, bookId: job.bookId } : {}),
        filePath: job.novel?.filePath ?? null,
        // 没有路径可依赖时才保留已解析的小说（正常导入路径都有 filePath）。
        novel: job.novel?.filePath ? undefined : job.novel,
        // 失败原因随任务落盘:重启后的重试入口也能说清上次为什么没烧成。
        error: {
          name: error.name ?? "",
          status: Number.isFinite(error.status) ? error.status : null,
          message: String(error.message ?? ""),
        },
      };
      await persistFailedJob();
    }
    safeSend("bake:error", {
      jobId: job.id,
      bookTitle: job.title,
      cancelled,
      name: error.name,
      status: error.status,
      message: error.message,
    });
  } finally {
    runningJobs.delete(job.id);
    drainBakeQueue();
    // 烧制全部结束:把烧制期间跳过的旧档案补写兜底补上(此时 bakeRunning
    // 已为假,后台升级照常跑;玩家回合仍优先)。
    if (!runningJobs.size && !bakeQueue.length) {
      void upgradeAllRoleAbilities().catch(() => {});
    }
  }
}

ipcMain.handle(
  "novel:bake",
  async (event, { focusChapter = 1, openAll = false, coarseBudgetChars } = {}) => {
    if (!trustedSender(event)) throw new Error("拒绝来自未知来源的调用");
    if (!pendingNovel) throw new Error("请先选择小说文件");
    // 采样粗读预算(字符数):只收正数,其余一律按全本处理。
    const budget = Number(coarseBudgetChars);
    const job = {
      id: randomUUID(),
      novel: pendingNovel,
      title: pendingNovel.title,
      focusChapter,
      openAll: Boolean(openAll),
      ...(Number.isFinite(budget) && budget > 0 ? { coarseBudgetChars: Math.floor(budget) } : {}),
      controller: new AbortController(),
    };
    pendingNovel = undefined;
    bakeQueue.push(job);
    const queued = runningJobs.size >= MAX_CONCURRENT_BAKES;
    drainBakeQueue();
    return { jobId: job.id, bookTitle: job.title, queued, ...bakeSnapshot() };
  },
);

ipcMain.handle("novel:bake-retry", async (event, { jobId } = {}) => {
  if (!trustedSender(event)) throw new Error("拒绝来自未知来源的调用");
  if (failedJob?.id !== jobId) throw new Error("这次起稿已经无法重试，请重新导入");
  const job = { ...failedJob, id: randomUUID(), controller: new AbortController() };
  // 上次的失败原因只用于展示,不是重跑参数。
  delete job.error;
  failedJob = undefined;
  await clearPersistedFailedJob();
  if (!job.novel) {
    if (!job.filePath) throw new Error("这次起稿已经无法重试，请重新导入这本书");
    // 重试时按路径重新读文件：内存里不养整本小说。
    try {
      job.novel = await parseNovel({
        name: job.filePath.split(/[\\/]/).at(-1),
        buffer: await readFile(job.filePath),
      });
    } catch {
      throw new Error("原文件已经读不到了，请重新导入这本书");
    }
    // 定向粗读按路径重读会把书名重新推导成文件名——摘要缓存键立刻和账本
    // 加载侧对不上，粗读白烧。按书架 meta 再对齐一次。
    if (job.coarseOnly) {
      try {
        const book = await library.load(job.bookId);
        job.novel.title = book.meta.title;
      } catch {
        throw new Error("这本书已不在书架上，无法重试补挂粗读");
      }
    }
  }
  bakeQueue.push(job);
  const queued = runningJobs.size >= MAX_CONCURRENT_BAKES;
  drainBakeQueue();
  return { jobId: job.id, bookTitle: job.title, queued, ...bakeSnapshot() };
});

ipcMain.handle("novel:bake-cancel", async (event, { jobId } = {}) => {
  if (!trustedSender(event)) throw new Error("拒绝来自未知来源的调用");
  const waiting = bakeQueue.findIndex((item) => item.id === jobId);
  if (waiting >= 0) {
    bakeQueue.splice(waiting, 1);
    return { cancelled: true };
  }
  const running = runningJobs.get(jobId);
  if (!running) return { cancelled: false };
  running.controller.abort();
  return { cancelled: true };
});

ipcMain.handle("game:play", async (event, optionId) => {
  if (!trustedSender(event)) throw new Error("拒绝来自未知来源的调用");

  if (!engine) throw new Error("请先从书架选择一本小说");
  if (playInFlight) throw new Error("上一回合仍在推进，稍候再试");
  // 崩溃残留/重载的死亡续玩点：恢复时已按存档重算 session.dead，死了就是死了。
  if (session?.dead) throw new Error("这一世已经落幕，请转世或从书架重新进入");
  if (engine.store.current.endingCandidate?.ready) {
    throw new Error("这一卷已经合上，请先续写新的阶段");
  }
  if (engine.store.current.pendingRoleTransition) {
    throw new Error("先处理眼前的身份转变，再继续走下去");
  }
  if (engine.store.current.player?.roleDangling) {
    throw new Error("当前身份已不在本书目录中，请先重选身份");
  }
  // 普通回合没有预设选项：未输入意图生成选项前，无处可走。
  if (!currentOptions.length) throw new Error("请先写下你此刻想做的事，再落向这一步");
  const option = currentOptions.find((item) => item.id === optionId);
  if (!option) throw new Error("这一步已经翻过去了");
  // 捕获本回合的对局引用：回合耗时以分钟计，期间可能发生 resume/loadSlot/
  // story:new——全程只用捕获值，落盘前再核对是否已被换掉。
  // 注意引用捕获（不能用 {...session} 浅拷贝）：superseded 按引用比较，拷贝
  // 会让判断永真——曾让回合写盘被整体跳过（丢档链的真正根因）。
  const targetEngine = engine;
  const targetSession = session;
  const superseded = () => engine !== targetEngine || session !== targetSession;
  const controller = new AbortController();
  activePlayAbort = controller;
  let turn;
  let ending = null;
  let resultOptions = [];
  // 交互优先:整个回合期间烧制让路,回合结束后烧制自动继续。
  // ⓪2 playInFlight 覆盖整个回合处理器(2026-08-19 拍板):终章生成、世界回写
  // 与进度落盘全部完成后才放行——完成到写盘之间的窗口里,任何换局入口都会
  // 被守卫拦下,不再出现「正文已出、写盘被顶掉」的丢失。
  playInFlight = true;
  enterInteractive();
  try {
    // 意图已被 game:intent-options 消费（选项围绕意图生成），回合本身不再透传。
    try {
      turn = await targetEngine.play(option, { signal: controller.signal });
    } catch (error) {
      // 「停一下」的用户取消：回合未落定，引擎内部已回滚随机数与状态，
      // 回一声 cancelled 即可。绝不能让 AbortError 穿透处理器——IPC 会把它
      // 包装成「Error invoking remote method 'game:play'」的裸英文 rejection。
      if (controller.signal.aborted || error?.name === "AbortError") {
        return { cancelled: true };
      }
      throw error;
    } finally {
      exitInteractive();
    }
    const player = targetEngine.store.current.player;
    ending = turn.death.dead
      ? { type: "death", cause: turn.death.cause, name: player.name, turns: turn.number }
      : turn.endingCandidate?.ready
        ? { type: "stage", goalId: turn.endingCandidate.goalId }
        : null;
    // 转世落款(拍板 2026-08-17):这一世留下了什么——前世传闻、已成气候的基业、
    // 同行过的人。缺项不显示,让积累感在墓志铭上有个交代。
    if (ending?.type === "death") {
      const state = targetEngine.store.current;
      const ventures = (state.emergentStories ?? [])
        .filter((story) => story.kind === "venture" && story.erupted)
        .map((story) => story.title);
      const companions = (state.companions ?? []).map((item) => item.name);
      ending.legacy = {
        fact: pastLifeFactOf(state, turn.death, state.turn).text,
        ventures,
        companions,
      };
    }
    if (ending) {
      let epilogue =
        ending.type === "death"
          ? `你的旅程止于${ending.cause}，但已经发生的一切仍留在这个世界里。`
          : "这一阶段的选择已经结出结果，未竟之事仍在世界中继续生长。";
      if (targetEngine.llm instanceof OpenAiCompatibleClient) {
        try {
          safeSend("story:phase", "epilogue");
          // 终章也接取消信号：用户在终章窗口点「停一下」时立即中断在途请求，
          // 由下方 catch 落回默认文案，已生成的回合正文照常落定（死亡不丢弃）。
          epilogue = await targetEngine.llm.generateEpilogue({
            world: targetEngine.world,
            state: targetEngine.store.current,
            history: targetEngine.history,
            ending,
            styleSamples: targetEngine.styleSamplesFor({ query: ending.cause ?? "" }),
            signal: controller.signal,
          });
          // 终章也要与身份对得上:违例则带清单重写一次,失败静默。
          epilogue = await ensureIdentityConsistent(
            epilogue,
            playerCapabilitiesOf(targetEngine.world, targetEngine.store.current),
            targetEngine.world.characters ?? [],
            (rewriteNote) =>
              targetEngine.llm.generateEpilogue({
                world: targetEngine.world,
                state: targetEngine.store.current,
                history: targetEngine.history,
                ending,
                styleSamples: targetEngine.styleSamplesFor({ query: ending.cause ?? "" }),
                rewriteNote,
                signal: controller.signal,
              }),
            worldviewForCheck(targetEngine.world),
            controller.signal,
          );
        } catch {}
      }
      turn.narrative = `${turn.narrative}\n\n${epilogue}`;
      targetEngine.history.at(-1).narrative = turn.narrative;
    }
    // 本回合的下一手解法：在任何 superseded 判定之前捕获,落盘与返回都用它。
    resultOptions = structuredClone(ending ? [] : turn.options);
    const supersededNow = superseded();
    if (!supersededNow) {
      // 意图已被本回合消费（拍板更新：落定即清）。superseded 时全局意图属于
      // 新会话，不得代清。
      activeIntent = null;
      // 改命引发的替代事件、涌现故事的新实体与同伴印记已进入世界档案:立即
      // 持久化世界(与转世路径同构;world 与进度两份落盘,先世界后进度)。
      // B7 保护:会话开始后这本书被重新起稿过(同名重导入)时跳过回写——
      // 旧会话的世界快照会抹掉新档案与刚补写的身份能力。
      if (turn.derivedEvent || turn.emergent || turn.companionsChanged) {
        try {
          const book = await library.load(targetSession.bookId);
          const rebakedAfterStart =
            targetSession.startedAt &&
            book?.meta?.addedAt &&
            Date.parse(book.meta.addedAt) > targetSession.startedAt;
          if (rebakedAfterStart) {
            console.warn("[world] 书册在会话开始后已重新起稿，跳过旧会话的世界回写");
          } else {
            await library.updateWorld(targetSession.bookId, targetEngine.world, book.initialState);
          }
        } catch {}
      }
      currentOptions = resultOptions;
      if (ending?.type === "death") session = { ...targetSession, dead: true };
    }
    // ⓪1 已完成的回合无条件落盘(2026-08-19 拍板):死了清续玩点;活着带着
    // 下一手解法写进它自己的书。superseded 只跳过上面的内存全局——玩家看过
    // 的正文永远不因换局蒸发;同书的迟到写入最多让内存落后磁盘一拍,下次
    // 续读即见,远好于整手丢失。
    if (ending?.type === "death") {
      await enqueueWrite(() => progressStore.clear(targetSession.bookId));
    } else {
      await enqueueWrite(async () => {
        await progressStore.write(
          targetSession.bookId,
          serializeEngine(targetEngine, {
            ...targetSession,
            currentOptions: structuredClone(resultOptions),
          }),
        );
      });
    }
  } finally {
    playInFlight = false;
    // 取消器覆盖整个处理器（含终章与世界回写窗口）：终章在途时点「停一下」
    // 同样能立即中断，而不是空操作让界面干等数分钟。
    if (activePlayAbort === controller) activePlayAbort = null;
  }
  return {
    number: turn.number,
    narrative: turn.narrative,
    options: resultOptions,
    consequences: turn.consequences,
    journal: turn.journal,
    dominantSystems: turn.dominantSystems,
    ending,
    clash: clashView(targetEngine.store.current, targetEngine.world),
    // 下一手关键回合预判：落笔前亮出（用回合后状态算，比开卷时更准）。
    nextKeyTurn: nextKeyTurnOf(targetEngine.store.current),
    footsteps: footstepsView(targetEngine.history),
    protagonist: protagonistView(targetEngine.store.current, targetEngine.world),
    povs: povLinesView(targetEngine.store.current, targetEngine.world),
    relations: relationsView(targetEngine.store.current, targetEngine.world),
    clock: storyClockView(targetEngine.world, targetEngine.store.current).label,
    playerSheet: playerSheetView(targetEngine.store.current, targetEngine.world),
    fate: fateView(targetEngine.store.current, targetEngine.world),
    // 世界见闻(拍板 2026-08-17):已投递事件流与生长中的涌现故事,
    // 以及本回合新生的故事/人物/事件摘要(供界面织入或提示)。
    worldHappenings: worldHappeningsView(targetEngine.store.current, targetEngine.world),
    emergentStories: emergentStoriesView(targetEngine.store.current),
    fateSeeds: fateSeedsView(targetEngine.store.current, targetEngine.world),
    emergent: turn.emergent
      ? {
          newStory: turn.emergent.newStory?.title ?? null,
          newStoryKind: turn.emergent.newStory?.kind === "venture" ? "venture" : "tale",
          newCharacters: turn.emergent.newCharacters.map((item) => item.name),
          eruptions: turn.emergent.eruptions.map((item) => item.title),
        }
      : null,
    roleTransition: roleTransitionView(targetEngine.store.current, targetEngine.world),
    intent: activeIntent ?? "",
    // 卷终回望(拍板:隐藏+回望):弧线收束的回合才有值,渲染层据此插卷终卡。
    arcRetrospective: turn.arcRetrospective ?? null,
    // 改命反馈(拍板 2026-08-17):本回合改命结果的定性视图与替代事件摘要,
    // 渲染层据此插「改命已成/命运反噬」卡——成败不再只靠叙事正文暗示。
    divergence: divergenceView(turn),
    derivedEvent: turn.derivedEvent ? { text: turn.derivedEvent.text } : null,
  };
});

// 意图先行（拍板 2026-08-17 追加：预设选项全部取消，普通回合选项由玩家意图动态产生）。
// 玩家输入意图后，围绕意图重生成当前处境的选项。不消耗回合、不推进时间；
// 意图不可行时返回兜底选项并附提示。交锋回合拒绝（搏杀选项由结构请求生成）。
ipcMain.handle("game:intent-options", async (event, { intent } = {}) => {
  if (!trustedSender(event)) throw new Error("拒绝来自未知来源的调用");
  if (!engine) throw new Error("请先从书架选择一本小说");
  // 在途自锁（对齐 game:play）：两次意图并发在飞时，后到的会覆盖前一次的
  // 解法表落盘，看门狗复位后旧请求迟到落定还会顶掉新解法——直接拒绝重入。
  if (turnBusy()) throw new Error("这一手还在推演——先等它落定");
  if (session?.dead) throw new Error("这一世已经落幕，请转世或从书架重新进入");
  if (engine.store.current.endingCandidate?.ready) {
    throw new Error("这一卷已经合上，请先续写新的阶段");
  }
  if (engine.store.current.pendingRoleTransition) {
    throw new Error("先处理眼前的身份转变，再考虑方向");
  }
  if (engine.store.current.player?.roleDangling) {
    throw new Error("当前身份已不在本书目录中，请先重选身份");
  }
  // 搏杀回合同样意图先行（拍板 2026-08-19）：选项规则本就有搏杀条款
  // （context.activeClash 存在时只给 2-4 个搏杀行动），围绕玩家意图生成
  // 搏杀解法替换在途解法表即可，不再拒绝「另想方向」。
  const cleaned = String(intent ?? "")
    .replace(/[\u0000-\u001f\u007f]/g, "")
    .trim()
    .slice(0, 40);
  // ⓪3 捕获在先(2026-08-19):生成耗时数十秒,期间对局可能被换——全部状态
  // 引用在 await 前定格;完成后先校验 superseded 再动全局,选点无条件写进
  // 它自己的会话,绝不把 A 书的意图/解法盖到 B 书头上。
  // 引用捕获（同 game:play）：{...session} 浅拷贝会让比较永真，
  // 每次意图生成都被误判为「对局已切换」。
  const targetEngine = engine;
  const targetSession = session;
  const intentSuperseded = () => engine !== targetEngine || session !== targetSession;
  // 在途锁覆盖整个处理器(2026-08-19 补):不只 generateOptions 的 await——
  // 生成完成后到选点落盘之间还有一个换局窗口,锁提前释放会让 resume 在
  // 写盘期间顶掉对局,界面拿到幽灵选项、主进程解法表却被清空/替换,
  // 点击即报「请先写下你此刻想做的事」。
  intentInFlight = true;
  try {
    let options;
    let fallback;
    ({ options, fallback } = await targetEngine.generateOptions({ intent: cleaned }));
    if (fallback) {
      // 兜底选项已删（拍板 2026-08-19）：意图不可行时不给选项，让玩家换写法。
      if (!intentSuperseded()) currentOptions = [];
      return {
        error: "这个方向眼下无路可走——换个写法再落一笔。",
        intent: activeIntent ?? "",
        options: [],
      };
    }
    // 观望项已删（拍板 2026-08-19）：axis="exit" 的等待/观察类选项不再下发。
    const optionsSnapshot = structuredClone(options.filter((item) => item?.axis !== "exit"));
    const intentSnapshot = cleaned || null;
    if (intentSuperseded()) {
      // 对局已被换:绝不把旧会话的选项交给界面——那是点不动也玩不了的
      // 幽灵选项(主进程解法表已归新会话)。指路回案头重新进入。
      return {
        error: "对局已切换——旧方向的解法已失效，请回案头重新进入。",
        intent: "",
        options: [],
      };
    }
    activeIntent = intentSnapshot;
    currentOptions = optionsSnapshot;
    // 选点续存（拍板 2026-08-19）：意图与解法一经生成立即落盘——回合在途时
    // 崩溃/重启/更新，重开也回到「解法面前」，而不是回到开场从头再来。
    if (!targetSession.dead) {
      await enqueueWrite(async () => {
        await progressStore.write(
          targetSession.bookId,
          serializeEngine(targetEngine, {
            ...targetSession,
            intent: intentSnapshot,
            currentOptions: structuredClone(optionsSnapshot),
          }),
        );
      });
    }
    return { options: optionsSnapshot, intent: intentSnapshot ?? "" };
  } finally {
    intentInFlight = false;
  }
});

// 分层意图(拍板:弧线导演):改写此世之志——引擎作废当前弧线,下一回合围绕新志向
// 重规划;改写当前谋算——只调叙事与选项取取势,弧线在节拍间隙自然吸收。
// 两者都不消耗回合;改写后立即落续玩点,崩溃/关窗也不丢这一笔心意。
ipcMain.handle("game:set-goal", async (event, { goal } = {}) => {
  if (!trustedSender(event)) throw new Error("拒绝来自未知来源的调用");
  if (!engine) throw new Error("请先从书架选择一本小说");
  const result = engine.updateGoal({ goal });
  // 死亡回合后 session.dead 且续玩点已清:不再落盘,免得把已死的一世救活。
  if (!session.dead) {
    const targetEngine = engine;
    const targetSession = { ...session };
    await enqueueWrite(async () => {
      const targetOptions = structuredClone(currentOptions);
      await progressStore.write(
        targetSession.bookId,
        serializeEngine(targetEngine, { ...targetSession, currentOptions: targetOptions }),
      );
    });
  }
  return result;
});

ipcMain.handle("game:set-scheme", async (event, { scheme } = {}) => {
  if (!trustedSender(event)) throw new Error("拒绝来自未知来源的调用");
  if (!engine) throw new Error("请先从书架选择一本小说");
  const result = engine.updateScheme({ scheme });
  if (!session.dead) {
    const targetEngine = engine;
    const targetSession = { ...session };
    await enqueueWrite(async () => {
      const targetOptions = structuredClone(currentOptions);
      await progressStore.write(
        targetSession.bookId,
        serializeEngine(targetEngine, { ...targetSession, currentOptions: targetOptions }),
      );
    });
  }
  return result;
});

ipcMain.handle("story:cancel", async (event) => {
  if (!trustedSender(event)) throw new Error("拒绝来自未知来源的调用");
  activePlayAbort?.abort();
  return true;
});

// 一世导出（拍板 2026-08-19）：把当前世的完整故事拼成 Markdown 存盘——
// 回读与分享两用。楔子只在尚未落子时单独成段（此后开场已融入第一章叙事，
// 章摘会被分层记忆逐步替换，不再可靠）。
ipcMain.handle("story:export", async (event) => {
  if (!trustedSender(event)) throw new Error("拒绝来自未知来源的调用");
  if (!engine || !session) throw new Error("当前没有可导出的故事");
  const world = engine.world;
  const player = engine.store.current.player ?? {};
  const turns = engine.history;
  const lastTurn = turns.at(-1);
  const death = lastTurn?.death?.dead ? lastTurn.death : null;
  const lines = [];
  lines.push(`# ${world.title} · ${player.name ?? "无名者"}`);
  lines.push("");
  lines.push(
    `> 身份：${player.roleName ?? "无名之辈"} · 历 ${engine.store.current.turn ?? turns.length} 手而${death ? "终" : "未竟"}`,
  );
  lines.push("");
  if (!turns.length && engine.store.snapshots[0]?.chapterSummary) {
    lines.push(engine.store.snapshots[0].chapterSummary);
    lines.push("");
  }
  for (const turn of turns) {
    lines.push(`## 第 ${turn.number} 手`);
    if (turn.choice?.text) lines.push(`> ${turn.choice.text}`);
    lines.push("");
    lines.push(turn.narrative ?? "");
    lines.push("");
  }
  if (death) {
    lines.push("## 判词");
    lines.push("");
    lines.push(
      `${player.name ?? "无名者"}，殁于${death.cause ?? "命数"}。历 ${lastTurn.number} 手而终。`,
    );
    lines.push("");
  }
  const markdown = lines.join("\n");
  const safeTitle = String(world.title ?? "书").replace(/[\\/:*?"<>|]/g, "_");
  const safeName = String(player.name ?? "无名").replace(/[\\/:*?"<>|]/g, "_");
  const result = await dialog.showSaveDialog(window, {
    defaultPath: join(app.getPath("downloads"), `${safeTitle}·${safeName}·第${engine.store.current.turn ?? 0}手.md`),
    filters: [{ name: "Markdown", extensions: ["md"] }],
  });
  if (result.canceled || !result.filePath) return { ok: false, canceled: true };
  await writeFile(result.filePath, markdown, "utf8");
  return { ok: true, path: result.filePath };
});

ipcMain.handle("story:continue-stage", async (event) => {
  if (!trustedSender(event)) throw new Error("拒绝来自未知来源的调用");
  if (!engine || !session) throw new Error("当前没有可继续的故事");
  // 在途守卫(B6):续阶段会改快照,与在途回合/意图的提交互相覆盖。
  if (turnBusy()) throw new Error("这一手还在推演——先等它落定");
  // 死档不复活（D17）：与所有写盘处理器同一纪律。
  if (session.dead) throw new Error("这一世已经落幕，请另起一稿");
  const state = engine.store.current;
  const completed = state.personalGoals.find(
    (goal) => goal.id === state.endingCandidate?.goalId,
  );
  state.personalGoals = state.personalGoals.map((goal) =>
    goal.id === completed?.id ? { ...goal, endingEligible: false } : goal,
  );
  state.personalGoals.push({
    id: `core-goal-${state.turn + 1}`,
    kind: "core",
    status: "active",
    motive: `承接“${completed?.publicDirection ?? "上一段旅程"}”留下的后果`,
    direction: "consequence",
    publicDirection: "面对上一段旅程留下的后果",
    evidenceIds: [],
    milestones: [],
    blockers: [],
    transformationHistory: [{ fromGoalId: completed?.id, turn: state.turn }],
    endingEligible: false,
  });
  state.endingCandidate = null;
  // 新阶段开始后旧目标已标记完成，journal 要重建，否则界面还会挂着已完成目标的条目。
  state.characterJournal = buildCharacterJournal(state);
  engine.store.snapshots[engine.store.snapshots.length - 1] = state;
  // 续写新阶段即落续玩点:此刻关窗,重开应回到新阶段,而不是退回终局画面。
  {
    const targetEngine = engine;
    const targetSession = { ...session };
    await enqueueWrite(async () => {
      const targetOptions = structuredClone(currentOptions);
      await progressStore.write(
        targetSession.bookId,
        serializeEngine(targetEngine, { ...targetSession, currentOptions: targetOptions }),
      );
    });
  }
  // 新阶段的第一手：没有预设选项，由玩家输入意图动态产生。
  currentOptions = [];
  return openingView(engine.world, state);
});

// 身份转变卡：接纳则换身份（履历/一次性修正/势力/世界事实），拒绝则路径永闭。
ipcMain.handle("story:resolve-transition", async (event, { accept } = {}) => {
  if (!trustedSender(event)) throw new Error("拒绝来自未知来源的调用");
  if (!engine || !session) throw new Error("当前没有可继续的故事");
  if (turnBusy()) throw new Error("这一手还在推演——先等它落定");
  const state = engine.store.current;
  if (!state.pendingRoleTransition) throw new Error("没有待处理的转变");
  const targetEngine = engine;
  const targetSession = { ...session };
  const next = applyRoleTransition(state, targetEngine.world, Boolean(accept));
  targetEngine.store.snapshots[targetEngine.store.snapshots.length - 1] = next;
  // 与 progress:save 同构：入队闭包只吃捕获值，排队等待期间对局被换也不串档。
  await enqueueWrite(async () => {
    const targetOptions = structuredClone(currentOptions);
    await progressStore.write(
      targetSession.bookId,
      serializeEngine(targetEngine, { ...targetSession, currentOptions: targetOptions }),
    );
  });
  return {
    roleTransition: roleTransitionView(next, targetEngine.world),
    journal: next.characterJournal ?? [],
  };
});

// 身份失配重选：只重选身份与出身势力，心性/动机原样保留。
ipcMain.handle("story:reselect-role", async (event, { roleId, factionId } = {}) => {
  if (!trustedSender(event)) throw new Error("拒绝来自未知来源的调用");
  if (!engine || !session) throw new Error("当前没有可继续的故事");
  if (turnBusy()) throw new Error("这一手还在推演——先等它落定");
  const state = engine.store.current;
  if (!state.player?.roleDangling) throw new Error("当前身份无需重选");
  const role = engine.world.roleTemplates.find((item) => item.id === roleId);
  if (!role) throw new Error("请选择世界中存在的身份");
  const factions = role.factionIds ?? [];
  const nextFaction =
    factionId && engine.world.factions.some((item) => item.id === factionId)
      ? factionId
      : factions[0] ?? null;
  state.player.roleId = role.id;
  state.player.roleName = role.name;
  state.player.factionId = nextFaction;
  state.player.roleDangling = false;
  state.player.roleHistory = [
    ...(state.player.roleHistory ?? []),
    {
      roleId: role.id,
      roleName: role.name,
      sinceTurn: state.turn,
      reason: "重选（旧身份已从目录移除）",
    },
  ];
  // 身份变了,能力立刻跟着变:先补势力成员记录(若有),再同步能力与职权。
  if (nextFaction && !state.factionMemberships?.some((item) => item.factionId === nextFaction)) {
    state.factionMemberships = [
      ...(state.factionMemberships ?? []),
      {
        id: "membership:player:" + nextFaction,
        factionId: nextFaction,
        authority: [],
        duties: [],
        overdueDutyIds: [],
        promotionEvidenceIds: [],
        discipline: [],
        visibility: "public",
      },
    ];
  }
  applyRoleIdentity(state, role, engine.world);
  state.characterJournal = buildCharacterJournal(state);
  engine.store.snapshots[engine.store.snapshots.length - 1] = state;
  // 与 progress:save 同构：入队闭包只吃捕获值，排队等待期间对局被换也不串档。
  const targetEngine = engine;
  const targetSession = { ...session };
  await enqueueWrite(async () => {
    const targetOptions = structuredClone(currentOptions);
    await progressStore.write(
      targetSession.bookId,
      serializeEngine(targetEngine, { ...targetSession, currentOptions: targetOptions }),
    );
  });
  return openingView(engine.world, state);
});

// 转世：前世的名字与死法留在世界档案里，后来者可能听到传闻、碰到遗物。
ipcMain.handle("story:create-successor", async (event) => {
  if (!trustedSender(event)) throw new Error("拒绝来自未知来源的调用");
  if (!engine || !session) throw new Error("当前没有可继续的故事");
  const state = engine.store.current;
  // 交锋死亡的死因只写进最后一回合的 death 记录，不落在 survivalPressures 里；
  // 直接重算 playerDeathState 会把它漏成「走过这里」，转世传闻就丢了真正的死因。
  const death = engine.history.at(-1)?.death ?? playerDeathState(state);
  const fact = pastLifeFact(state, death, randomUUID().slice(0, 8));
  // 已写回的命运偏离也一并落进世界档案：下一世面对「被上一世改过的世界」。
  // 按 id 去重（D15）：completedDivergences 跨世延续，转世的 override id 含
  // 回合号——前世回合号会与今世撞车，不去重会让同一改命事实跨世反复堆积。
  const divergenceFacts = divergenceWorldFacts(state).filter(
    (item) => !engine.world.facts.some((existing) => existing.id === item.id),
  );
  engine.world.facts = [...engine.world.facts, fact, ...divergenceFacts];
  try {
    const book = await library.load(session.bookId);
    await library.updateWorld(session.bookId, engine.world, book.initialState);
  } catch {}
  return {
    ...openingView(engine.world, state),
    characterSetup: true,
    characterWorld: engine.world,
    successor: true,
    // 转世预填(拍板:模式已移除,预填只带性别/落点/境界):向导里可直接一路下一步,也可逐项改;
    // playMode/startingPoint 仅作旧档字段透传,向导与建角逻辑已不消费。
    successorPrefill: {
      roleId: state.player?.roleId ?? "",
      locationId: state.locationId ?? "",
      // 上一世带走的境界:从 traitIds 里挑出境界阶梯那条(无则留空由向导默认)。
      realmTraitId: (state.player?.traitIds ?? []).find((id) =>
        realmTraitsOf(engine.world).some((trait) => trait.id === id),
      ) ?? "",
      // 心性(拍板 2026-08-19:全额继承):带上上一世演化终了的五维分值,向导只读展示;建角后由 createSuccessorState 落进新档。
      bigFive: state.player?.bigFive ?? null,
      appearance: state.player?.appearance ?? "",
      gender: state.player?.gender ?? null,
      playMode: state.playMode === "power" ? "power" : "classic",
      startingPoint:
        state.playMode === "power" && state.startingPoint === "ceiling" ? "ceiling" : "scratch",
    },
  };
});

// 原创实体代写草稿：软校验交给模型（合味道），硬校验留给 world:create-entity。
ipcMain.handle("world:draft-entity", async (event, { kind, intent, fields } = {}) => {
  if (!trustedSender(event)) throw new Error("拒绝来自未知来源的调用");
  if (!engine || !session) throw new Error("请先选择一本书并开始一世");
  if (!CREATABLE_KINDS[kind]) throw new Error(`未知的实体类型 “${kind}”`);
  const client = await configuredClient();
  enterInteractive();
  try {
    return await client.generateEntityDraft({ kind, intent, world: engine.world, fields });
  } finally {
    exitInteractive();
  }
});

// 原创实体写回：硬校验 → 挂 provenance → 落库。跨转世存续。
ipcMain.handle("world:create-entity", async (event, { kind, draft } = {}) => {
  if (!trustedSender(event)) throw new Error("拒绝来自未知来源的调用");
  if (!engine || !session) throw new Error("请先选择一本书并开始一世");
  if (turnBusy()) throw new Error("这一手还在推演——先等它落定");
  const meta = {
    lifeIndex: engine.store.current?.player?.lifeIndex ?? 1,
    createdTurn: engine.store.current?.turn ?? 0,
  };
  const nextWorld = createEntity(kind, draft, engine.world, meta);
  engine.world = nextWorld;
  const created = nextWorld[CREATABLE_KINDS[kind].collection].at(-1);
  // 原创人物当世即活（拍板 2026-08-21）：照涌现人物同款补种引擎状态——
  // 不登记相遇与行踪，此人在引擎眼里不存在，意图与选项都指向不了。
  // 经 store.push 落快照，随下方 enqueueWrite 一并持久化。
  if (kind === "character") {
    engine.store.push(seedCreatedCharacter(engine.store.current, created));
  }
  try {
    const book = await library.load(session.bookId);
    await library.updateWorld(session.bookId, nextWorld, book.initialState);
  } catch {}
  // 落当前世续玩点（补漏,2026-08-19）:实体已进 engine.world,但续玩点的
  // world 快照还是旧的——此刻退出重进,这一世的档里没有新实体(只有书库有,
  // 下一世才见)。与其它写盘处理器同构,立即把带新世界的进度落盘。
  if (!session.dead) {
    const targetEngine = engine;
    const targetSession = { ...session };
    await enqueueWrite(async () => {
      const targetOptions = structuredClone(currentOptions);
      await progressStore.write(
        targetSession.bookId,
        serializeEngine(targetEngine, {
          ...targetSession,
          intent: activeIntent,
          currentOptions: targetOptions,
        }),
      );
    });
  }
  return { world: nextWorld, created };
});

// 读档/续玩的公共恢复路径：局部建引擎并完整恢复，全部成功后才一次性提交
// 全局对局（与 story:new 同一防跨书污染纪律）；session.dead 从恢复结果重建，
// 清档前崩溃等残留的死亡续玩点不能再被当成活着的一世接着玩。
async function restoreProgressSession(bookId, saved) {
  const llm = await configuredClient();
  const libraryBook = await library.load(bookId);
  // 旧存档的世界快照可能没有身份能力:书库补写后按 id 合入,只加能力字段。
  // 烧制在跑时跳过补写(快模型请求,与烧制抢槽位),烧完由后台升级兜底。
  const upgradedBook = bakeRunning() ? libraryBook : await ensureRoleAbilities(libraryBook, llm);
  saved.world = mergeRoleCapabilities(saved.world, upgradedBook.world);
  const nextEngine = buildEngine({
    gameWorld: saved.world,
    gameState: saved.snapshots[0],
    llm,
    sourceChapters: libraryBook.chapters,
    bookTitle: libraryBook.meta?.title ?? null,
  });
  restoreEngine(nextEngine, saved);
  // 存档身份与目录失配：标记悬空，界面立即弹重选。
  const liveState = nextEngine.store.current;
  markDanglingRole(liveState, nextEngine.world);
  if (liveState.player?.roleDangling) {
    nextEngine.store.snapshots[nextEngine.store.snapshots.length - 1] = liveState;
  }
  const ending = resumeEnding(nextEngine);
  commitEngine(nextEngine, {
    sourceChapters: libraryBook.chapters,
    session: {
      bookId,
      requiresApi: true,
      storyId: saved.metadata?.storyId ?? randomUUID(),
      startedAt: Date.now(),
      dead: ending?.type === "death" || Boolean(liveState.playerDead),
    },
    // 终局回合的选项被清空保存，恢复时必须把终局状态一起还原；
    // 普通回合恢复上一选点（若有）；交锋中的存档保留搏杀选项。
    options: restoreOptionsFor(nextEngine, saved.metadata?.currentOptions ?? null, ending),
  });
  // 意图随选点一并恢复：续读直接回到解法面前，界面点亮当前方向。
  activeIntent = typeof saved.metadata?.intent === "string" ? saved.metadata.intent : null;
  return ending;
}

// 读档/续玩的公共视图：提交完成后统一从当前对局现算。
function progressResumeView(bookId, saved, ending) {
  return {
    bookId,
    title: saved.world.title,
    // 楔子只在尚无回合史时显示（D16）：serializeEngine 只留最近三份快照，
    // 有回合史时 snapshots[0] 的章摘是三轮前的旧摘要，冒充开场会误导。
    opening: (saved.history?.length ?? 0) > 0 ? "" : saved.snapshots[0].chapterSummary ?? "",
    turns: engine.history.map((turn) => ({
      number: turn.number,
      narrative: turn.narrative,
      divergence: divergenceView(turn),
      companions: Array.isArray(turn.companions) ? turn.companions : [],
    })),
    options: currentOptions,
    journal: engine.store.current.characterJournal ?? [],
    ending,
    clash: clashView(engine.store.current, engine.world),
    footsteps: footstepsView(engine.history),
    protagonist: protagonistView(engine.store.current, engine.world),
    povs: povLinesView(engine.store.current, engine.world),
    relations: relationsView(engine.store.current, engine.world),
    clock: storyClockView(engine.world, engine.store.current).label,
    playerSheet: playerSheetView(engine.store.current, engine.world),
    fate: fateView(engine.store.current, engine.world),
    worldHappenings: worldHappeningsView(engine.store.current, engine.world),
    emergentStories: emergentStoriesView(engine.store.current),
    fateSeeds: fateSeedsView(engine.store.current, engine.world),
    roleTransition: roleTransitionView(engine.store.current, engine.world),
    intent: activeIntent ?? "",
    // 分层意图(意图面板):此世之志与当前谋算随续读带回,面板据此初始化。
    goal: engine.store.current.personalGoals?.[0]?.publicDirection ?? "",
    scheme: engine.store.current.player?.scheme ?? "",
    roleReselect: Boolean(engine.store.current.player?.roleDangling),
    ...(engine.store.current.player?.roleDangling
      ? { roleWorld: engine.world }
      : {}),
  };
}

ipcMain.handle("progress:resume", async (event, bookId) => {
  if (!trustedSender(event)) throw new Error("拒绝来自未知来源的调用");
  // 回合/意图在途时拒绝任何续读(⓪3,不限书):先回推演台等这一手落定。
  if (turnBusy()) {
    throw new Error("这一手还在推演——先回推演台等它落定，再离开或续读");
  }
  const saved = await progressStore.read(bookId);
  if (!saved) throw new Error("这本书没有可以接着读的进度");
  const ending = await restoreProgressSession(bookId, saved);
  return progressResumeView(bookId, saved, ending);
});

/* ============ 谋篇（作家构思工作台，2026-08-24） ============
   与游玩完全解耦的独立面：项目存 plotting/，LLM 用量按 projectId 归账。
   生成类请求走 interactive 门（不与烧制抢配额）；同一时刻只允许一节在生成，
   防止并发写穿同一份 project.json。样章流式走 plot:chunk 频道（与 story:chunk
   分家，互不串台）。 */

// 谋篇专用的客户端装配：与 configuredClient 同一套配置，但叙事流接到
// plot:chunk、用量记到项目自己的桶。
async function plotClient(projectId) {
  const settings = await settingsStore.load();
  return new OpenAiCompatibleClient({
    config: { ...clientConfig(settings), strongTimeoutMs: PLAY_TIMEOUT_MS },
    onNarrative: (text) => safeSend("plot:chunk", text),
    onUsage: (usage) => usageStore?.record(projectId ?? "", usage),
  });
}

// 谋篇生成在飞锁与样章取消信号。
let plotBusy = false;
let plotSampleAbort = null;

ipcMain.handle("plot:list", async (event) => {
  if (!trustedSender(event)) throw new Error("拒绝来自未知来源的调用");
  return plotStore.list();
});

ipcMain.handle("plot:create", async (event, { title, idea, genre, reference, flavor } = {}) => {
  if (!trustedSender(event)) throw new Error("拒绝来自未知来源的调用");
  return plotStore.create({ title, idea, genre, reference, flavor });
});

ipcMain.handle("plot:get", async (event, { projectId } = {}) => {
  if (!trustedSender(event)) throw new Error("拒绝来自未知来源的调用");
  const project = await plotStore.load(projectId ?? "");
  if (!project) throw new Error("谋篇项目不存在");
  return project;
});

ipcMain.handle("plot:rename", async (event, { projectId, title } = {}) => {
  if (!trustedSender(event)) throw new Error("拒绝来自未知来源的调用");
  return plotStore.rename(projectId ?? "", title);
});

ipcMain.handle("plot:remove", async (event, { projectId } = {}) => {
  if (!trustedSender(event)) throw new Error("拒绝来自未知来源的调用");
  await plotStore.remove(projectId ?? "");
  // 用量清账与下架书同一纪律：项目没了，账目不留残行。
  usageStore.removeBook(projectId ?? "");
  return { ok: true };
});

// 手工编辑写回：按节归一后落库（normalizeSection 拒绝未知节与脏结构）。
ipcMain.handle("plot:save-section", async (event, { projectId, section, value } = {}) => {
  if (!trustedSender(event)) throw new Error("拒绝来自未知来源的调用");
  if (plotBusy) throw new Error("这一节正在生成——稍候再编辑");
  const project = await plotStore.load(projectId ?? "");
  if (!project) throw new Error("谋篇项目不存在");
  if (section === "seeds") {
    // 种子里点子与创作度杠杆可改（题材与参考在建项时定下，改了等于另一个项目）；
    // 只动其一时不强求另一个也在载荷里。
    const nextSeeds = { ...project.seeds };
    if (value?.idea !== undefined) {
      const idea = String(value.idea ?? "").trim().slice(0, 300);
      if (!idea) throw new Error("点子不能为空");
      nextSeeds.idea = idea;
    }
    if (value?.flavor !== undefined) nextSeeds.flavor = normalizeFlavor(value.flavor);
    project.seeds = nextSeeds;
  } else {
    project[section] = normalizeSection(section, value);
  }
  project.updatedAt = new Date().toISOString();
  return plotStore.save(project);
});

// 分节生成。文风节带 channel（ai/sample/library）；样章节流式（plot:chunk）。
ipcMain.handle(
  "plot:generate",
  async (event, { projectId, section, note = "", channel = "ai", sampleText = "", bookId = "" } = {}) => {
    if (!trustedSender(event)) throw new Error("拒绝来自未知来源的调用");
    if (plotBusy) throw new Error("上一节还在生成——稍候");
    const meta = PLOT_SECTIONS.find((item) => item.key === section);
    if (!meta) throw new Error(`未知的谋篇节 “${section}”`);
    const project = await plotStore.load(projectId ?? "");
    if (!project) throw new Error("谋篇项目不存在");
    // 上游检查：缺哪节先补哪节，界面按 requires 预先禁点，这里是硬闸。
    for (const required of meta.requires) {
      if (!project[required]) {
        const label = PLOT_SECTIONS.find((item) => item.key === required)?.label ?? required;
        throw new Error(`先完成「${label}」，再生成「${meta.label}」`);
      }
    }
    // 文风 · 案头书通道零 LLM：不建客户端、不进 interactive 门。
    if (section === "style" && channel === "library") {
      const styles = await library.styles();
      const hit = styles.find((item) => item.id === bookId) ?? null;
      if (!hit) throw new Error("案头没有这本书的文风档案（或书未起稿完成）");
      const next = {
        ...project,
        style: styleFromLibrary(hit.title, hit.style),
        updatedAt: new Date().toISOString(),
      };
      return plotStore.save(next);
    }
    const client = await plotClient(project.id);
    enterInteractive();
    plotBusy = true;
    try {
      let value;
      if (section === "premise") value = await generatePremise(client, project, { note });
      else if (section === "worldview") value = await generateWorldview(client, project, { note });
      else if (section === "style") {
        if (channel === "sample") value = await analyzeStyleSample(client, sampleText);
        else value = await proposeStyle(client, project, { note });
      } else if (section === "characters") value = await generateCharacters(client, project, { note });
      else if (section === "outline") value = await generateOutline(client, project, { note });
      else if (section === "sample") {
        plotSampleAbort = new AbortController();
        try {
          value = await generateSample(client, project, { note, signal: plotSampleAbort.signal });
        } finally {
          plotSampleAbort = null;
        }
      }
      if (!value) throw new Error("这一节没有生成出可用内容——换个说法再试一次");
      const next = { ...project, [section]: value, updatedAt: new Date().toISOString() };
      return plotStore.save(next);
    } finally {
      plotBusy = false;
      plotSampleAbort = null;
      exitInteractive();
    }
  },
);

ipcMain.handle("plot:sample-cancel", async (event) => {
  if (!trustedSender(event)) throw new Error("拒绝来自未知来源的调用");
  plotSampleAbort?.abort();
  return { cancelled: true };
});

// 灵感卡（帮我想通道）：项目尚未创建，用量记入专属桶 plot-ideas。
ipcMain.handle("plot:idea-cards", async (event, { genres = [], avoid = [], flavor = 3 } = {}) => {
  if (!trustedSender(event)) throw new Error("拒绝来自未知来源的调用");
  if (plotBusy) throw new Error("上一节还在生成——稍候");
  const settings = await settingsStore.load();
  const client = new OpenAiCompatibleClient({
    config: { ...clientConfig(settings), strongTimeoutMs: PLAY_TIMEOUT_MS },
    onUsage: (usage) => usageStore?.record("plot-ideas", usage),
  });
  enterInteractive();
  try {
    const cards = await generateIdeaCards(client, { genres, avoid, flavor });
    if (!cards.length) throw new Error("这一批没有出可用的灵感——再试一次");
    return { cards };
  } finally {
    exitInteractive();
  }
});

// 参考作品搜索：复用起稿的公网资料源（维基/百度百科/DDG，只发书名）。
ipcMain.handle("plot:search-reference", async (event, { name } = {}) => {
  if (!trustedSender(event)) throw new Error("拒绝来自未知来源的调用");
  const cleaned = String(name ?? "").trim().slice(0, 60);
  if (!cleaned) throw new Error("先填一个参考作品名");
  const digest = await searchBookReference({ title: cleaned });
  return { name: cleaned, digest: digest.slice(0, 6000), found: Boolean(digest) };
});

ipcMain.handle("plot:library-styles", async (event) => {
  if (!trustedSender(event)) throw new Error("拒绝来自未知来源的调用");
  return library.styles();
});

// 谋篇导出：整档拼 Markdown 存盘（照 story:export 的保存对话框模式）。
ipcMain.handle("plot:export", async (event, { projectId } = {}) => {
  if (!trustedSender(event)) throw new Error("拒绝来自未知来源的调用");
  const project = await plotStore.load(projectId ?? "");
  if (!project) throw new Error("谋篇项目不存在");
  const markdown = projectToMarkdown(project);
  const safeTitle = String(project.title ?? "谋篇").replace(/[\\/:*?"<>|]/g, "_");
  const result = await dialog.showSaveDialog(window, {
    defaultPath: join(app.getPath("downloads"), `谋篇·${safeTitle}.md`),
    filters: [{ name: "Markdown", extensions: ["md"] }],
  });
  if (result.canceled || !result.filePath) return { ok: false, canceled: true };
  await writeFile(result.filePath, markdown, "utf8");
  return { ok: true, path: result.filePath };
});
