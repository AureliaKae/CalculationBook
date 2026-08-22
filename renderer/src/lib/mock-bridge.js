// 浏览器 mock 桥：window.calculationpaper 不在场时（纯浏览器打开 renderer），
// 以与 preload 完全相同的面 + 剧本化假数据驱动整套 UI。
// 供设计走查与离线演示；Electron 内永远走真桥。
import { TURNS, BOOK, CREATION_STEPS } from "../mock.js";

const listeners = {
  progress: new Set(),
  done: new Set(),
  error: new Set(),
  chunk: new Set(),
  phase: new Set(),
  discard: new Set(),
};
function emit(name, payload) {
  listeners[name].forEach((cb) => cb(payload));
}
function subscribe(name) {
  return (callback) => {
    listeners[name].add(callback);
    return () => listeners[name].delete(callback);
  };
}
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const MOCK_LOCATIONS = CREATION_STEPS[1].options.map((o, i) => ({
  id: `loc-${i}`,
  name: o.v,
  note: o.note,
}));
const MOCK_REALMS = CREATION_STEPS[2].options.map((o, i) => ({
  id: `realm-${i}`,
  name: o.v,
  note: o.note,
}));
const MOCK_WORLD = {
  id: "mock-world",
  title: BOOK.title,
  summary: "雨落寒山，寺门内外各怀心事。",
  locations: MOCK_LOCATIONS,
  // Creation 直接读 realmTraits（真桥侧由 realmTraitsOf(world) 推导）
  realmTraits: MOCK_REALMS,
  characters: [],
  // 反向建角（拍板 2026-08-20）：身份选单 + 拟稿候选的通用身份清单。
  roleTemplates: [
    { id: "role-handyman", name: "码头脚夫", description: "凭力气换饭吃的通用来路", abilities: [] },
    { id: "role-physician", name: "游方郎中", description: "背着药箱走四方的通用来路", abilities: ["粗通药理"] },
    { id: "role-swordsman", name: "佩剑游侠", description: "一路向南寻活计的通用来路", abilities: ["三招剑式", "认得几家剑铺的门路"] },
  ],
  // 底色演示目录（真桥侧由烧制目录 creationCatalog.bigFive 提供）
  creationCatalog: {
    bigFive: {
      openness: [
        { id: "o-1", name: "爱琢磨稀奇事", pole: "high", goodSide: "多有巧思", badSide: "易被新奇分神" },
        { id: "o-2", name: "守着老规矩", pole: "low", goodSide: "行事稳重", badSide: "少见多怪" },
      ],
      conscientiousness: [
        { id: "c-1", name: "事事有始有终", pole: "high", goodSide: "托付可靠", badSide: "不知变通" },
        { id: "c-2", name: "随遇而安", pole: "low", goodSide: "不钻牛角尖", badSide: "易荒废时日" },
      ],
      extraversion: [
        { id: "e-1", name: "自来熟", pole: "high", goodSide: "广结人缘", badSide: "言多必失" },
        { id: "e-2", name: "独来独往", pole: "low", goodSide: "不惹是非", badSide: "无人相助" },
      ],
      agreeableness: [
        { id: "a-1", name: "心软好说话", pole: "high", goodSide: "人皆愿近", badSide: "易被人欺" },
        { id: "a-2", name: "生人勿近", pole: "low", goodSide: "不受裹挟", badSide: "难得人心" },
      ],
      neuroticism: [
        { id: "n-1", name: "泰山崩于前而色不变", pole: "low", goodSide: "临危不乱", badSide: "少几分急智" },
        { id: "n-2", name: "风声鹤唳", pole: "high", goodSide: "嗅觉灵敏", badSide: "易自乱阵脚" },
      ],
    },
  },
};

let settingsState = {
  version: 2,
  credentials: [],
  fast: { credentialId: "", model: "", temperature: 0.2 },
  strong: { credentialId: "", model: "", temperature: 0.2 },
    bakeConcurrency: "",
    maxTokens: "",
    thinkingFast: false,
  thinkingStrong: true,
  ready: true,
  decryptFailed: 0,
  secureStorage: true,
};

let books = [
  {
    id: "a1b2c3d4e5f60718",
    title: BOOK.title,
    format: "txt",
    chapterCount: 12,
    addedAt: new Date().toISOString(),
    worldId: "mock-world",
    degraded: null,
    bytes: 486231,
    turn: 0,
  },
];

let story = null; // { bookId, turnIndex, phase, options, chosen, pc, ended, dead }
let lastView = null;

function openingViewMock(extra = {}) {
  return {
    bookId: story.bookId,
    title: BOOK.title,
    opening: story.turnIndex < 0 ? story.pc.opening : "",
    turns: story.turns.map((t) => ({
      number: t.number,
      narrative: t.narrative,
      consequences: t.consequences ?? [],
    })),
    options: story.options,
    consequences: [],
    journal: [],
    worldHappenings: [],
    emergentStories: [],
    ending: story.ending ?? null,
    clash: null,
    intent: story.intent ?? "",
    goal: story.goal ?? "",
    scheme: story.scheme ?? "",
    // 行迹/名录演示（真桥侧由主进程视图提供）。
    footsteps: story.turns.slice(-5).reverse().map((t) => ({
      number: t.number,
      choice: story.lastChoice ?? "",
      result: "success",
    })),
    roster: [],
    ...extra,
  };
}

export const mockBridge = {
  window: {
    minimize() {},
    toggle() {},
    close() {},
    async isMaximized() {
      return false;
    },
    onState() {
      return () => {};
    },
  },
  settings: {
    async get() {
      return { ...settingsState };
    },
    async save(value) {
      settingsState = {
        ...settingsState,
        ...value,
        // 凭证表按真桥口径落：明文 Key 只进不出，转成 hasApiKey 标记
        //（存稿载荷里留空=未配、__KEEP__ 或真 Key 都判定为有墨）。
        credentials: (value?.credentials ?? settingsState.credentials).map(
          ({ apiKey, ...rest }) => ({
            ...rest,
            hasApiKey: apiKey === undefined ? Boolean(rest.hasApiKey) : Boolean(apiKey),
          }),
        ),
        fast: { ...settingsState.fast, ...(value?.fast ?? {}) },
        strong: { ...settingsState.strong, ...(value?.strong ?? {}) },
        ready: settingsState.ready,
      };
      return { ...settingsState };
    },
    async models() {
      await wait(600);
      return { models: ["deepseek-chat", "deepseek-reasoner", "deepseek-v3"] };
    },
    async usage() {
      // 账目演示数据（真桥侧由 usage.json 聚合）。
      return {
        books: [
          {
            id: "a1b2c3d4e5f60718",
            title: BOOK.title,
            promptTokens: 1284300,
            completionTokens: 96200,
            requests: 214,
            updatedAt: new Date().toISOString(),
          },
          {
            id: "misc",
            title: "起稿与其他",
            promptTokens: 21400,
            completionTokens: 5100,
            requests: 9,
            updatedAt: new Date().toISOString(),
          },
        ],
        total: {
          promptTokens: 1305700,
          completionTokens: 101300,
          requests: 223,
        },
      };
    },
  },
  library: {
    async chronicle(bookId) {
      // 编年史演示（真桥侧由书库事实与进度档组装）。
      return {
        title: BOOK.title,
        lives: [
          { text: "沈砚曾以游学书生活到第 7 手，最终殁于山门夜袭。" },
          { text: "无名者曾以斥候活到第 3 手，最终殁于严寒。" },
        ],
        divergences: [{ text: "玩家改写了黄枫谷之祸：灭门未至，仇怨暗结。" }],
        events: [
          { day: 1, text: "山门外雨夜，来客投宿。", source: "canon", tier: "side" },
          { day: 3, text: "知客僧起疑，书箱夹层露角。", source: "canon", tier: "core" },
          { day: 5, text: "青蚨钱庄之局生根。", source: "emergent", tier: "local" },
        ],
        ventures: [{ title: "青蚨钱庄", erupted: false }],
      };
    },
    async list() {
      return books.map((b) => {
        const mine = story?.bookId === b.id && !story.dead;
        return {
          ...b,
          turn: mine ? story.turns.length : b.turn ?? 0,
          // 建角完成即有续玩点（与真桥一致），书卡据此显示「已入卷」可续读。
          resumable: Boolean(mine && story.pc),
        };
      });
    },
    async remove(id) {
      books = books.filter((b) => b.id !== id);
      if (story?.bookId === id) story = null;
      return books;
    },
    async rebake(bookId) {
      // 演示版重烧：假进度走一遍起稿 HUD，完成后原书回架。
      const jobId = "demo-rebake-" + Date.now();
      emit("progress", { jobId, bookTitle: BOOK.title, queueIndex: 1, queueTotal: 1, stage: "coarse", current: 2, total: 8 });
      await wait(800);
      emit("progress", { jobId, bookTitle: BOOK.title, queueIndex: 1, queueTotal: 1, stage: "complete", current: 8, total: 8 });
      emit("done", { jobId, bookId, bookTitle: BOOK.title, degraded: null, coarse: null });
      return { jobId, bookTitle: BOOK.title, queued: false, queueIndex: 1, queueTotal: 1 };
    },
    async topupCoarse(bookId) {
      // 演示版补读：与重烧同一套假进度。
      const jobId = "demo-topup-" + Date.now();
      emit("progress", { jobId, bookTitle: BOOK.title, queueIndex: 1, queueTotal: 1, stage: "coarse", current: 2, total: 8 });
      await wait(800);
      emit("progress", { jobId, bookTitle: BOOK.title, queueIndex: 1, queueTotal: 1, stage: "complete", current: 8, total: 8 });
      emit("done", { jobId, bookId, bookTitle: BOOK.title, degraded: null, coarse: null });
      return { jobId, bookTitle: BOOK.title, queued: false, queueIndex: 1, queueTotal: 1 };
    },
    async exportWorld() {
      throw new Error("浏览器演示不支持导出世界，请在桌面版使用");
    },
    async importWorld() {
      throw new Error("浏览器演示不支持导入世界，请在桌面版使用");
    },
    async importWorldConfirm() {
      throw new Error("浏览器演示不支持导入世界，请在桌面版使用");
    },
  },
  novel: {
    async choose() {
      await wait(400);
      return {
        title: "北望行",
        format: "txt",
        chapterCount: 412,
        characters: 1_480_000,
        estimatedInputTokens: 1_292_000,
        warnings: [],
        cleanedLines: 0,
        currentModel: "mock",
        cachedModels: [],
        cachedBake: null,
      };
    },
    async bake() {
      const jobId = "mock-job-" + Date.now();
      const stages = [
        { stage: "style", current: 1, total: 1 },
        { stage: "coarse", current: 3, total: 12 },
        { stage: "coarse", current: 8, total: 12 },
        { stage: "coarse", current: 12, total: 12 },
        { stage: "detail", current: 1, total: 1 },
        { stage: "merge", current: 3, total: 5 },
        { stage: "complete", current: 1, total: 1 },
      ];
      (async () => {
        for (const progress of stages) {
          await wait(450);
          emit("progress", { jobId, bookTitle: "北望行", queueIndex: 1, queueTotal: 1, ...progress });
        }
        const bookId = "b" + Math.random().toString(16).slice(2, 17).padEnd(16, "0");
        books = [
          { id: bookId, title: "北望行", format: "txt", chapterCount: 412, addedAt: new Date().toISOString(), worldId: "mock-world", degraded: null, bytes: 812345, turn: 0 },
          ...books,
        ];
        emit("done", { jobId, bookId, bookTitle: "北望行", degraded: null });
      })();
      return { jobId, bookTitle: "北望行", queued: false, queueIndex: 0, queueTotal: 0 };
    },
    async cancel() {
      return { cancelled: true };
    },
    async retry() {
      throw new Error("没有可重试的起稿任务");
    },
    onProgress: subscribe("progress"),
    onDone: subscribe("done"),
    onError: subscribe("error"),
  },
  story: {
    async start({ bookId }) {
      const book = books.find((b) => b.id === bookId);
      if (!book) throw new Error("请先选择一本书");
      story = { bookId, turns: [], options: [], ending: null, dead: false, pc: null };
      return { ...openingViewMock(), characterSetup: true, characterWorld: MOCK_WORLD };
    },
    async createCharacter(profile) {
      if (!story) throw new Error("请先选择一本书");
      story.pc = { ...profile };
      story.turns = [];
      story.ending = null;
      story.dead = false;
      emit("phase", "opening");
      await wait(1200);
      const roleText = profile.customRoleName || profile.roleName || "无名之辈";
      const opening = `${profile.name}以${MOCK_REALMS.find((r) => r.id === profile.realmTraitId)?.name ?? roleText}之姿，来到${MOCK_LOCATIONS.find((l) => l.id === profile.locationId)?.name ?? "书页翻开的地方"}。${profile.background ? `\n\n${profile.background}\n` : ""}\n此刻想做什么，写下便知。`;
      story.opening = opening;
      lastView = { ...openingViewMock(), opening };
      return lastView;
    },
    async continueStage() {
      if (!story) throw new Error("当前没有可继续的故事");
      story.ending = null;
      story.dead = false;
      return openingViewMock();
    },
    async createSuccessor() {
      if (!story) throw new Error("当前没有可继续的故事");
      const prefill = {
        roleId: "",
        locationId: story.pc?.locationId ?? "",
        realmTraitId: story.pc?.realmTraitId ?? "",
        gender: story.pc?.gender ?? null,
      };
      story.dead = false;
      story.ending = null;
      return {
        ...openingViewMock(),
        characterSetup: true,
        characterWorld: MOCK_WORLD,
        successor: true,
        successorPrefill: prefill,
      };
    },
    async resolveTransition() {
      return { roleTransition: null, journal: [] };
    },
    async reselectRole() {
      return openingViewMock();
    },
    async intentOptions({ intent }) {
      if (!story || story.dead) throw new Error("这一世已经落幕，请重开一世");
      emit("phase", "directing");
      await wait(1100);
      emit("phase", "options-check");
      // 演示 fallback：意图带「不可行」时走兜底路径（兜底已删，返回空选项）
      if (/不可行|做不到/.test(String(intent))) {
        return { error: "这个方向眼下无路可走——换个写法再发一次。", intent, options: [] };
      }
      const turn = TURNS[Math.min(story.turns.length, TURNS.length - 1)];
      // 观望项已删：watch 类选项不再下发
      story.options = turn.options
        .filter((o) => !o.watch)
        .map((o) => ({ id: "opt-" + o.id, text: o.text, stakes: o.stakes, dice: o.dice }));
      story.intent = intent;
      // 选点续存的 mock 版（与真桥对齐）：重进回到解法面前而非清空重来。
      lastView = { ...openingViewMock(), options: story.options, intent };
      return { options: story.options, intent };
    },
    async play(optionId) {
      if (!story) throw new Error("请先选择一本书");
      const turn = TURNS[Math.min(story.turns.length, TURNS.length - 1)];
      const chosen = story.options.find((o) => o.id === optionId);
      if (!chosen) throw new Error("这一步已经翻过去了");
      story.lastChoice = chosen.text;
      const outcomeKey = Number(String(optionId).replace(/^opt-/, ""));
      const outcome = turn.outcomes[outcomeKey] ?? Object.values(turn.outcomes)[0];
      const narrative = outcome.paragraphs.join("\n\n");
      // 流式叙事演示：正文分段渐显（真桥侧 story:chunk 同形）。
      emit("phase", "directing");
      for (const piece of narrative.match(/[\s\S]{1,24}/g) ?? []) {
        await wait(140);
        emit("chunk", piece);
      }
      await wait(300);
      emit("phase", "narrative-done");
      await wait(500);
      // 第二手演示一次重写相位（深推演里旧行会被叉划）
      if (story.turns.length === 1) {
        emit("phase", "rewriting");
        await wait(600);
      }
      emit("phase", "structure");
      await wait(500);
      const number = story.turns.length + 1;
      story.turns.push({
        number,
        narrative: outcome.paragraphs.join("\n\n"),
        consequences: outcome.notes.map((n) => ({
          text: String(n.text).replaceAll("{name}", story.pc?.name ?? "沈砚"),
          kind: n.kind,
        })),
        marks: outcome.marks ?? [],
        grade: outcome.grade,
        verdict: outcome.verdict,
        death: outcome.death ?? false,
        epitaph: outcome.epitaph ?? null,
        chosenText: chosen.text,
        intent: story.intent ?? "",
      });
      story.options = [];
      if (outcome.death) {
        story.ending = {
          type: "death",
          cause: "井栏边的谎",
          name: story.pc?.name ?? "沈砚",
          turns: number,
          legacy: { fact: outcome.epitaph?.[2] ?? "", ventures: [], companions: [] },
        };
        story.dead = true;
      }
      const view = {
        ...openingViewMock(),
        consequences: story.turns.at(-1).consequences,
        chosen,
        verdictText: outcome.verdict,
        grade: outcome.grade,
      };
      lastView = view;
      return view;
    },
    async setGoal({ goal } = {}) {
      const cleaned = String(goal ?? "").trim().slice(0, 60);
      if (cleaned) story.goal = cleaned;
      return { goal: story.goal ?? "" };
    },
    async setScheme({ scheme } = {}) {
      const cleaned = String(scheme ?? "").trim().slice(0, 40);
      if (cleaned) story.scheme = cleaned;
      return { scheme: story.scheme ?? "" };
    },
    async cancel() {
      return true;
    },
    async exportLife() {
      // 演示环境不落盘：给一个假路径供文案走查。
      return { ok: true, path: "演示环境不写盘" };
    },
    onChunk: subscribe("chunk"),
    onPhase: subscribe("phase"),
    onDiscard: subscribe("discard"),
  },
  progress: {
    async resume(bookId) {
      if (!story || story.bookId !== bookId) throw new Error("这本书没有可以接着读的进度");
      return lastView ?? openingViewMock();
    },
  },
  world: {
    // 原创一笔演示：代笔给一份合形草稿（与真桥同形：{ draft, worldviewNote }），
    // 写回进 mock 世界并留痕。
    async draftEntity({ kind, intent } = {}) {
      await wait(700);
      const label = { faction: "门派", role: "身份", location: "地点", item: "物品", character: "人物" }[kind] ?? "新物";
      return {
        draft: {
          name: `${String(intent ?? "").slice(0, 6) || "无名"}之${label === "门派" ? "会" : "属"}`,
          summary: `由「${String(intent ?? "").slice(0, 20)}」而起，原著未载，就此生根。`,
        },
        worldviewNote: "与山门近郊的散修往来呼应，原著未载之处，合乎情理。",
      };
    },
    async createEntity({ kind, draft } = {}) {
      await wait(400);
      return { created: { name: draft?.name ?? "新物" }, world: MOCK_WORLD };
    },
  },
};
