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
  plotChunk: new Set(),
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

// 谋篇演示数据（真桥侧由 src/plotting.js 归一后落库）：一份已走完六节的项目
// + 各节的「重掷」脚本，供浏览器走查整套谋篇面。
const MOCK_PLOT_ID = "plot-0123456789abcdef";
function mockPlotSeed(overrides = {}) {
  return {
    version: 1,
    id: MOCK_PLOT_ID,
    title: "长夜灯夫",
    createdAt: new Date(Date.now() - 3 * 86400_000).toISOString(),
    updatedAt: new Date().toISOString(),
    seeds: {
      idea: "一个灯夫在永不天亮的城市里守最后一盏灯",
      genre: "玄幻",
      reference: null,
    },
    premise: {
      logline: "永不天亮的雾都里，最后一个灯夫守着城中仅存的灯——灯灭之日，便是城陷之时。",
      theme: "微小的坚守如何在庞大的遗忘里保住一点人的温度。",
      hook: "灯夫发现今晚要收走的灯油，比昨夜又少了半勺。",
      titles: ["长夜灯夫", "一盏之城", "雾都燃灯录"],
      notes: [
        "卖点：把「守灯」写成可以输的日常——每晚都要赢一次。",
        "可展开矛盾：城里想灭灯的人，理由比灯夫更充分。",
        "避坑：不写成打怪升级的亮灯流水账。",
      ],
    },
    worldview: {
      summary:
        "雾都临海，天被雾锁了三百年。城里的光不靠天亮，靠灯——灯油产自城外雾渊，点灯人世代守着街巷的灯。灯不灭，雾就不进城；灯一灭，那条街连同街上的人第二天就会被雾抹去，只剩别人记忆里的一个空位。",
      highlights: [
        "灯油产自雾渊，捞油人下水一次折损一年阳寿。",
        "每盏灯配一名灯夫，灯卡即身份，无卡者不得在夜里上街。",
        "灯政司垄断灯油配额，配额逐年削减。",
        "雾里的人没有影子，靠影子辨认彼此是老城人的本能。",
      ],
      conflicts: [
        "灯政司要缩灯保油，灯夫要灯满城明。",
        "雾渊在涨，捞油人不够死。",
        "「让城里人学会活在黑暗里」的思潮正在灯夫内部生长。",
      ],
    },
    style: {
      narration: "第三人称贴身跟灯夫一人，偶用街坊旁笔。",
      tense: "过去时为骨，紧张处切现在时。",
      sentence: "短句为主，三五字一顿；雾景放长句，人事收短句。",
      punctuation: "逗号密、句号狠；对话不加「说道」，直接冒号起。",
      imagery: ["雾", "灯芯", "湿石板", "影子"],
      diction: ["灯卡", "捞油人", "雾渊", "灯政司"],
      chapterForm: "每章一盏灯，章名即街名。",
      avoid: ["不用现代词", "不写心理独白长段", "不解释雾的原理"],
      source: { kind: "ai", label: "AI 按题材与立意提议" },
    },
    characters: [
      {
        name: "陆灯生",
        role: "老城最后的长街灯夫",
        summary: "父亲死在灯卡换发的前夜，他接了卡，也接了那夜没说完的话。",
        persona: {
          temperament: "话少手稳，先做后说，被人逼急了才亮态度。",
          motives: ["查清父亲换卡前夜见过的灯政司来人", "让长街的灯撑过这个冬天"],
          bottomLines: ["不拿别人的灯油续自己的灯。"],
          manner: "短句，爱用灯行话打比方，骂人只骂半句。",
        },
        arc: "从「守灯是差事」到「守灯是要紧的证词」。",
      },
      {
        name: "沈算盘",
        role: "灯政司削减科主事",
        summary: "算得出每盏灯的账，也算得出这座城还能撑几年。",
        persona: {
          temperament: "客气到近乎无情，把难听的话排在数字后面说。",
          motives: ["在灯油耗尽前把城迁进黑暗预案", "让削减案通过司议"],
          bottomLines: ["不当场撒谎，哪怕说真话挨骂。"],
          manner: "长句，先摆数后下结论，口头禅「账在这摆着」。",
        },
        arc: "从笃信算盘到发现有些账灯夫不认。",
      },
    ],
    outline: {
      logline: "从「灯还够点」走到「灯快见底」，灯夫用一盏灯换来全城对黑暗的第一次正视。",
      volumes: [
        {
          title: "半勺油",
          summary:
            "长街灯油配额首减，灯夫发现削减背后有人在数街上的灯。冬天将至，灯卡年审把守灯人逼到明面。",
          beats: [
            { title: "配额削减落到长街", note: "陆灯生第一次在账面上看到「缩灯」两个字。" },
            { title: "夜访者数灯", note: "有人趁雾数灯，灯生跟丢了他，却捡到半页名单。" },
            { title: "灯卡年审风波", note: "老灯夫的卡被停，灯生替他顶了一夜班。" },
            { title: "雾抹掉一条小巷", note: "灯灭的巷子消失，全城只当那巷子从没存在过。" },
            { title: "削减科上门", note: "沈算盘带来补偿条款，条件是长街自灭三盏。" },
          ],
        },
      ],
    },
    sample: {
      text: "雾从海上过来，到长街已经凉透了。\n\n陆灯生提着油壶走过第七盏灯，火苗矮下去半寸，他停了脚。风没有动，雾也没有动，是油的事。他翻开灯卡背面的小格子，今夜的油，比昨夜又少了半勺。\n\n少的不是他一个人的油。他在灯政司的账房外站了一个下午，看见每一册账都是这样：字没变，数变了。\n\n「灯生，」巷口卖浆的老何招手，「明晚还点么？」\n\n「点。」\n\n「油呢？」\n\n「油的事，」他把壶盖拧紧，「是我的事。」",
    },
    ...overrides,
  };
}
let plotProjects = [mockPlotSeed()];

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
  zoom: {
    set() {},
    get() {
      return 1;
    },
  },
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
    async attachSource() {
      throw new Error("浏览器演示不支持补挂原文，请在桌面版使用");
    },
    async attachSourceConfirm() {
      throw new Error("浏览器演示不支持补挂原文，请在桌面版使用");
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
  plot: {
    async list() {
      return plotProjects.map((p) => ({
        id: p.id,
        title: p.title,
        idea: p.seeds.idea,
        genre: p.seeds.genre,
        createdAt: p.createdAt,
        updatedAt: p.updatedAt,
        done: {
          premise: Boolean(p.premise),
          worldview: Boolean(p.worldview),
          style: Boolean(p.style),
          characters: Boolean(p.characters),
          outline: Boolean(p.outline),
          sample: Boolean(p.sample),
        },
      }));
    },
    async create({ title, idea, genre, flavor } = {}) {
      await wait(300);
      const project = mockPlotSeed({
        id: `plot-${Math.random().toString(16).slice(2, 18).padEnd(16, "0")}`,
        title: title || "未命名之作",
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        seeds: { idea, genre: genre ?? "", reference: null, flavor: flavor ?? 3 },
        premise: null,
        worldview: null,
        style: null,
        characters: null,
        outline: null,
        sample: null,
      });
      plotProjects = [project, ...plotProjects];
      return project;
    },
    async get(projectId) {
      const project = plotProjects.find((p) => p.id === projectId);
      if (!project) throw new Error("谋篇项目不存在");
      return project;
    },
    async rename(projectId, title) {
      const project = plotProjects.find((p) => p.id === projectId);
      if (!project) throw new Error("谋篇项目不存在");
      project.title = String(title ?? "").trim() || project.title;
      return project;
    },
    async remove(projectId) {
      plotProjects = plotProjects.filter((p) => p.id !== projectId);
      return { ok: true };
    },
    async saveSection({ projectId, section, value } = {}) {
      const project = plotProjects.find((p) => p.id === projectId);
      if (!project) throw new Error("谋篇项目不存在");
      if (section === "seeds") {
        project.seeds = { ...project.seeds, idea: value?.idea ?? project.seeds.idea };
      } else {
        project[section] = value ?? null;
      }
      project.updatedAt = new Date().toISOString();
      return project;
    },
    // 演示版生成：各节照搬种子档案（真桥走 LLM）；样章流式渐显。
    async generate({ projectId, section, channel = "ai" } = {}) {
      const project = plotProjects.find((p) => p.id === projectId);
      if (!project) throw new Error("谋篇项目不存在");
      await wait(700 + Math.random() * 500);
      const seed = mockPlotSeed();
      if (section === "sample") {
        const text = seed.sample.text;
        for (const piece of text.match(/[\s\S]{1,18}/g) ?? []) {
          await wait(90);
          emit("plotChunk", piece);
        }
      }
      project[section] = section === "style" && channel === "library"
        ? { ...seed.style, source: { kind: "library", label: "《北望行》的文风档案" } }
        : seed[section];
      project.updatedAt = new Date().toISOString();
      return project;
    },
    async cancelSample() {
      return { cancelled: true };
    },
    // 灵感卡演示（真桥走 plot:idea-cards）：六张覆盖不同题材，avoid 不生效。
    async ideaCards() {
      await wait(900);
      const seedCards = [
        { idea: "外卖骑手发现每次超时的订单，都来自同一栋不存在的大楼", genre: "都市", hook: "每一单都在往城市背面送货。" },
        { idea: "守夜的书吏发现：史书里被墨笔涂掉的名字，第二天就会从城里消失", genre: "玄幻", hook: "删改历史是門手艺，也是凶器。" },
        { idea: "小镇殡仪馆的新学徒能听见死者最后一句话，但只能听一句", genre: "灵异", hook: "一句话，够破一桩案子，也够误一桩。" },
        { idea: "被贬到边陲小驿的驿丞，要在驿站预算与过路神仙之间两头周旋", genre: "仙侠", hook: "编制内打工人，伺候的是编外神仙。" },
        { idea: "刑警队新来的搭档查案滴水不漏，唯独雨天的案发现场从不出现", genre: "悬疑", hook: "他不是懒——是雨里有他不能踩的线。" },
        { idea: "星际殖民船的图书管理员发现：船上所有人读过的书，都悄悄少了一页", genre: "科幻", hook: "被删掉的那一页，指向他们真正的目的地。" },
      ];
      return { cards: seedCards };
    },
    async searchReference({ name } = {}) {
      await wait(900);
      return {
        name: String(name ?? "").slice(0, 60),
        digest: `《${String(name ?? "参考")}》：网络文学，连载中。以……（演示摘要：维基/百度百科/DDG 的公开资料会汇总到这里，供立意与世界观参考。）`,
        found: true,
      };
    },
    async libraryStyles() {
      return [{ id: "a1b2c3d4e5f60718", title: BOOK.title, style: mockPlotSeed().style }];
    },
    async exportProject() {
      return { ok: true, path: "演示环境不写盘" };
    },
    onChunk: subscribe("plotChunk"),
  },
};
