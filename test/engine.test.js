import assert from "node:assert/strict";
import test from "node:test";

import { MockLlm } from "../fixtures/mock-llm.js";
import { initialState, startingOption, world } from "../fixtures/world.js";
import {
  actionModifiers,
  applyDelta,
  buildContext,
  canonNowPassages,
  createSeededRandom,
  foldableEnding,
  mergeDetailInto,
  rollCheck,
  SnapshotStore,
  StoryEngine,
  styleParagraphs,
  validateInitialState,
  validateResponse,
  validateWorld,
} from "../src/engine.js";

import { migrateState, neutralBigFive, normalizeWorld } from "../src/evolution.js";
import { worldHappeningsView } from "../src/timeline.js";
import { LayeredMemory } from "../src/memory.js";
import { Bm25Index } from "../src/retrieval.js";
import { basicStructure, dualLlm } from "./helpers/llm.js";

test("mergeDetailInto drops prototype-hazard keys from model detail output", () => {
  // 模型精读 JSON 可能带 __proto__ 自有属性：JSON.parse 照单全收，直接
  // Object.assign 会把 character 的原型换成模型可控对象。
  const character = { id: "guide", name: "引路人" };
  const detailed = JSON.parse(
    '{"__proto__":{"polluted":true},"constructor":{"evil":1},"prototype":{"evil":2},"summary":"补写"}',
  );
  mergeDetailInto(character, detailed, { id: "guide", detailed: true });
  assert.equal(character.summary, "补写");
  assert.equal(character.detailed, true);
  assert.equal(character.id, "guide");
  assert.equal(Object.getPrototypeOf(character), Object.prototype);
  assert.ok(!("summary" in Object.prototype));
  assert.equal({}.polluted, undefined);
});

test("foldableEnding 把 resolved 的命运节点算作已落下", () => {
  // world_time 解析方式的命运节点在投递的同一回合就被 resolveTimelineEvents
  // 转成 resolved——漏了它,大多数书的终卷永远合不上。
  const fateWorld = normalizeWorld({
    ...world,
    timeline: [
      {
        id: "fate-1",
        time: 10,
        text: "命运节点",
        chapterAnchor: 1,
        resolution: "world_time",
        resolutionTargetIds: [],
        factsToAdd: [{ id: "f-1", text: "既定之事已成", chapterAnchor: 1 }],
      },
    ],
  });
  const resolved = migrateState(
    { ...structuredClone(initialState), eventStates: { "fate-1": { status: "resolved" } } },
    fateWorld,
  );
  assert.equal(foldableEnding(resolved, fateWorld), true, "resolved 也算落下");
  const scheduled = migrateState(structuredClone(initialState), fateWorld);
  assert.equal(foldableEnding(scheduled, fateWorld), false, "未落下的节点不合卷");
});

test("命运终卷一次性:合卷后续写新阶段,不再每手重新收卷", async () => {
  // 命运节点全部落定 → foldableEnding 恒真。续写(只清快照候选)之后,
  // 下一手若再次 ready 就会陷入「一手一卷」的无限收卷循环。
  const fateWorld = normalizeWorld({
    ...world,
    timeline: [
      {
        id: "fate-1",
        time: 10,
        text: "命运节点",
        chapterAnchor: 1,
        resolution: "never",
        resolutionTargetIds: [],
        factsToAdd: [{ id: "f-1", text: "既定之事已成", chapterAnchor: 1 }],
      },
    ],
  });
  const base = structuredClone(initialState);
  base.eventStates = { "fate-1": { status: "delivered" } };
  const engine = new StoryEngine({
    world: fateWorld,
    initialState: base,
    llm: dualLlm({ structure: () => basicStructure() }),
    seed: 3,
  });
  const first = await engine.play(startingOption);
  assert.equal(first.endingCandidate?.ready, true, "命运既定→卷合");
  assert.equal(engine.store.current.fateEndingConsumed, true, "终卷被一次性消耗");
  // 模拟 continue-stage:只清快照的候选(生产路径同此)。
  const current = engine.store.current;
  current.endingCandidate = null;
  engine.store.snapshots[engine.store.snapshots.length - 1] = current;
  const second = await engine.play(nextStep());
  assert.notEqual(second.endingCandidate?.ready, true, "续写后不再每手收卷");
  assert.notEqual(engine.store.current.endingCandidate?.ready, true);
});

test("替代事件落地时顶替原著旧事:见闻换线不留多余", async () => {
  // 拍板 2026-08-19:derived 事件带 replacesIds,投递时把被顶替的原著事件
  // 标 invalidated——「通过炼骨崖测试成为记名弟子」直接代替「三叔来访商定
  // 考验」,两条不并列。
  const canonWorld = normalizeWorld({
    ...world,
    timeline: [
      { id: "canon-a", time: 0, text: "三叔来访，商定送韩立参加考验。", chapterAnchor: 1, resolution: "world_time", resolutionTargetIds: [] },
    ],
  });
  const base = structuredClone(initialState);
  base.eventStates = { "canon-a": { status: "delivered", deliveredTurn: 0, delivery: "rumor" } };
  // 替代事件:10 分钟后落地,顶替 canon-a。
  canonWorld.timeline.push({
    id: "derived-b",
    time: 10,
    text: "韩立经三叔举荐，通过炼骨崖测试成为七玄门记名弟子。",
    chapterAnchor: 1,
    source: "derived",
    replacesIds: ["canon-a"],
    resolution: "never",
    resolutionTargetIds: [],
    prerequisites: [],
    invalidatedBy: [],
  });
  const engine = new StoryEngine({
    world: canonWorld,
    initialState: base,
    llm: dualLlm({ structure: () => basicStructure() }),
    seed: 5,
  });
  await engine.play({ ...startingOption, timeCost: 30 });
  const happenings = worldHappeningsView(engine.store.current, engine.world);
  const ids = happenings.map((item) => item.id);
  assert.ok(ids.includes("derived-b"), "替代事件已投递");
  assert.ok(!ids.includes("canon-a"), "被顶替的原著旧事不再出现（直接换线）");
  assert.equal(engine.store.current.eventStates["canon-a"].status, "invalidated");
  assert.equal(engine.store.current.eventStates["canon-a"].supersededBy, "derived-b");
});

test("seeded checks are reproducible", () => {  const first = createSeededRandom(42);
  const second = createSeededRandom(42);
  const firstChecks = Array.from({ length: 5 }, () =>
    rollCheck({ attributeValue: 30, risk: "risky", random: first }),
  );
  const secondChecks = Array.from({ length: 5 }, () =>
    rollCheck({ attributeValue: 30, risk: "risky", random: second }),
  );
  assert.deepEqual(firstChecks, secondChecks);
});

test("critical rolls must align with the margin", () => {
  // random() 返回 0-1：0.955 → roll 96，0.025 → roll 3，0.495 → roll 50。
  const queue = [0.955, 0.025, 0.495];
  const random = () => queue.shift();
  // 骰 96 但 margin 为负（属性 0 + 修正 -30 压不过 dire 难度）：只能算普通失败，不能凭空「大成功」。
  const highRollAgainstTheOdds = rollCheck({
    attributeValue: 0,
    risk: "dire",
    modifier: -30,
    random,
  });
  assert.equal(highRollAgainstTheOdds.roll, 96);
  assert.ok(highRollAgainstTheOdds.margin < 0);
  assert.equal(highRollAgainstTheOdds.result, "failure");
  // 骰 3 但 margin 为正：普通成功，不能被吞成「大失败」。
  const lowRollInYourFavor = rollCheck({
    attributeValue: 30,
    risk: "safe",
    random,
  });
  assert.equal(lowRollInYourFavor.roll, 3);
  assert.ok(lowRollInYourFavor.margin >= 0 && lowRollInYourFavor.margin < 30);
  assert.equal(lowRollInYourFavor.result, "success");
  // 大成功仍按原规则触发：margin 达标即可。
  const critical = rollCheck({
    attributeValue: 60,
    risk: "safe",
    random,
  });
  assert.ok(critical.margin >= 30);
  assert.equal(critical.result, "critical_success");
});

test("response requires distinct axes, an exit, and known stats", () => {
  const valid = {
    narrative: "潮声逼近。",
    delta: { clue: 1 },
    options: [
      { id: "a", text: "观察", axis: "investigate", risk: "safe", attribute: "resolve" },
      { id: "b", text: "交涉", axis: "social", risk: "risky", attribute: "resolve" },
      { id: "c", text: "离开", axis: "exit", risk: "safe", attribute: "agility" },
    ],
  };
  assert.equal(validateResponse(valid, world), true);
  assert.throws(
    () => validateResponse({ ...valid, delta: { unknown: 1 } }, world),
    /unknown stat/,
  );
  assert.throws(
    () =>
      validateResponse(
        {
          ...valid,
          options: valid.options.map((option) => ({ ...option, axis: "social" })),
        },
        world,
      ),
    /unique/,
  );
  assert.throws(
    () =>
      validateResponse(
        {
          ...valid,
          options: valid.options.map((option) => ({ ...option, id: "same" })),
        },
        world,
      ),
    /unique/,
  );
  assert.throws(
    () =>
      validateResponse(
        {
          ...valid,
          options: valid.options.map((option) => ({ ...option, timeCost: 999999 })),
        },
        world,
      ),
    /timeCost/,
  );
  // 字符串检索词/伏笔会被 spread 拆成单个字符，必须在入口拦下。
  assert.throws(
    () => validateResponse({ ...valid, retrievalKeywords: "燕尾" }, world),
    /array/,
  );
  assert.throws(
    () => validateResponse({ ...valid, openThreads: "铜扣" }, world),
    /array/,
  );
});

test("world and initial state are validated before play", () => {
  assert.throws(() => validateWorld({ ...world, attributes: [] }), /attribute/);
  assert.throws(
    () =>
      validateInitialState(
        { ...initialState, stats: { ...initialState.stats, breath: 11 } },
        world,
      ),
    /breath/,
  );
});

test("failed turns preserve random state and concurrent turns are rejected", async () => {
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const engine = new StoryEngine({
    world,
    initialState,
    seed: 42,
    llm: {
      async generateStory() {
        await gate;
        throw new Error("model unavailable");
      },
      async generateStructure(args) {
        return new MockLlm().generateStructure(args);
      },
    },
  });

  const failedTurn = engine.play(startingOption);
  await assert.rejects(() => engine.play(startingOption), /already in progress/);
  release();
  await assert.rejects(() => failedTurn, /model unavailable/);

  const expectedRandom = createSeededRandom(42);
  const expectedCheck = rollCheck({
    attributeValue: initialState.attributes.resolve,
    risk: startingOption.risk,
    random: expectedRandom,
  });
  engine.llm = {
    async generateStory({ check, context }) {
      assert.deepEqual(check, {
        ...expectedCheck,
        modifiers: {
          total: 0,
          relationship: 0,
          faction: 0,
          resource: 0,
          approach: "resist",
        },
      });
      return new MockLlm().generateStory({ check, context });
    },
    async generateStructure(args) {
      return new MockLlm().generateStructure(args);
    },
  };
  await engine.play(startingOption);
});

test("回合上下文带上一手时钟:两时钟日差即正文要交代的流逝", async () => {
  // 时间流逝必须写明(拍板 2026-08-21):storyClockPrev 是上一手结算后的时刻,
  // 叙事提示词据此要求开头交代时段推移/跨日天数。
  const contexts = [];
  const mock = new MockLlm();
  const llm = {
    async generateStory(args) {
      contexts.push(args.context);
      return mock.generateStory(args);
    },
    async generateStructure(args) {
      return mock.generateStructure(args);
    },
  };
  const engine = new StoryEngine({ world, initialState: structuredClone(initialState), llm, seed: 1 });
  await engine.play({ ...startingOption, timeCost: 2880 });
  assert.match(contexts[0].storyClockPrev?.label ?? "", /第 \d+ 日/, "上一手时钟随回合上下文送达");
  assert.ok(
    contexts[0].storyClock.day - contexts[0].storyClockPrev.day >= 1,
    "本回合耗时跨日:两时钟日差可算出该写明的天数",
  );
});

test("记忆分层:远期梗概随上下文送达;普通回合无选项时跳过选项侧校验", async () => {
  // 记忆分层(2026-08-21):storyDigest 注入叙事上下文;结构响应不带选项的
  // 普通回合,选项侧保真校验整次请求都是空转——跳过,省一次快调用。
  const contexts = [];
  const optionCountsAtCheck = [];
  const mock = new MockLlm();
  const llm = {
    async generateStory(args) {
      contexts.push(args.context);
      return mock.generateStory(args);
    },
    async generateStructure(args) {
      // 模拟真模型的普通回合协议:结构响应不带 options(选项由意图流另行生成)。
      const base = await mock.generateStructure(args);
      return { ...base, options: [] };
    },
    async checkIdentityConsistency(args) {
      optionCountsAtCheck.push((args.options ?? []).length);
      return { ok: true, issues: [] };
    },
  };
  const engine = new StoryEngine({
    world,
    initialState: { ...structuredClone(initialState), storyDigest: "远期梗概:旧事已定。" },
    llm,
    seed: 1,
  });
  const turn = await engine.play(startingOption);
  assert.equal(turn.number, 1);
  assert.equal(contexts[0].storyDigest, "远期梗概:旧事已定。", "远期梗概随回合上下文送达");
  assert.deepEqual(
    optionCountsAtCheck,
    [0],
    "只剩叙事侧一次校验;结构响应无选项时选项侧不再发请求",
  );
});

test("a failed narrative discards the stream and never rewrites", async () => {
  let storyCalls = 0;
  let discards = 0;
  const llm = {
    async generateStory() {
      storyCalls += 1;
      throw new Error("missing stream");
    },
    async generateStructure(args) {
      return new MockLlm().generateStructure(args);
    },
    discardNarrative() {
      discards += 1;
    },
  };
  const engine = new StoryEngine({ world, initialState, llm, seed: 1 });
  await assert.rejects(() => engine.play(startingOption), /missing stream/);
  assert.equal(storyCalls, 1);
  assert.equal(discards, 1);
  assert.equal(engine.rewriteCount, 0);
});

test("structure failures retry without rewriting the narrative", async () => {
  let storyCalls = 0;
  let structureCalls = 0;
  const llm = {
    async generateStory(args) {
      storyCalls += 1;
      return new MockLlm().generateStory(args);
    },
    async generateStructure(args) {
      structureCalls += 1;
      if (structureCalls === 1) throw new Error("invalid model json");
      return new MockLlm().generateStructure(args);
    },
  };
  const engine = new StoryEngine({ world, initialState, llm, seed: 1 });
  const turn = await engine.play(startingOption);
  assert.equal(storyCalls, 1);
  assert.equal(structureCalls, 2);
  assert.equal(engine.rewriteCount, 1);
  assert.equal(turn.number, 1);
});

test("engine drops unknown stats in delta without triggering repair", async () => {
  let repairCalls = 0;
  const valid = await new MockLlm().generateStructure({
    context: buildContext({ world, state: { ...initialState, turn: 1 }, history: [], dueEvents: [] }),
    check: { result: "success" },
    attempt: 0,
  });
  const engine = new StoryEngine({
    world,
    initialState,
    llm: {
      async generateStory() {
        return { narrative: "保留的正文" };
      },
      async generateStructure() {
        // 未知 stat 在 sanitize 阶段被静默丢弃，不再触发修复链。
        return { ...valid, delta: { ghost: 1 } };
      },
      async repairResponse() {
        repairCalls += 1;
        throw new Error("repair should not be called");
      },
    },
  });

  const turn = await engine.play(startingOption);

  assert.equal(turn.narrative, "保留的正文");
  assert.equal(repairCalls, 0);
  assert.equal(turn.number, 1);
});

test("engine repairs a missing narrative without regenerating it elsewhere", async () => {
  let storyCalls = 0;
  let repairCalls = 0;
  const valid = await new MockLlm().generateStructure({
    context: buildContext({ world, state: { ...initialState, turn: 1 }, history: [], dueEvents: [] }),
    check: { result: "success" },
    attempt: 0,
  });
  const engine = new StoryEngine({
    world,
    initialState,
    llm: {
      async generateStory() {
        storyCalls += 1;
        return { narrative: "" };
      },
      async generateStructure() {
        return valid;
      },
      async repairResponse({ narrative }) {
        repairCalls += 1;
        return { ...valid, narrative: "修复后的正文" };
      },
    },
  });

  const turn = await engine.play(startingOption);

  assert.equal(turn.narrative, "修复后的正文");
  assert.equal(storyCalls, 1);
  assert.equal(repairCalls, 1);
  assert.equal(turn.number, 1);
});

// 预设选项已取消(拍板 2026-08-17):普通回合不再由结构请求产出选项,
// 下一步选项由玩家意图动态产生。测试里需要「再走一步」时,
// 要么用 generateOptions,要么直接传一个合法的手写选项。
const nextStep = (id = "next", risk = "safe") => ({
  id,
  text: "沿着线索继续走",
  axis: "investigate",
  approach: "resist",
  risk,
  attribute: "resolve",
  timeCost: 30,
});

test("开场已写过的第一回合接续叙事:priorOpening 进上下文,标志只活一回合", async () => {
  const state = structuredClone(initialState);
  state.chapterSummary = "雾起时，她推开了院门，院中空无一人。";
  state.openingNarrated = true;
  const contexts = [];
  const engine = new StoryEngine({
    world,
    initialState: state,
    llm: {
      async generateStory({ context }) {
        contexts.push(context);
        return { narrative: "她听见身后的门闩轻轻一响。" };
      },
      async generateStructure() {
        return basicStructure();
      },
    },
    seed: 1,
  });

  const first = await engine.play(startingOption);
  assert.equal(contexts[0].priorOpening, state.chapterSummary, "第一回合带开场正文信号");
  assert.equal(engine.store.current.openingNarrated, false, "开场标志一回合后清除");

  await engine.play(nextStep());
  assert.equal(contexts[1].priorOpening, null, "后续回合不再带开场信号");
});

test("engine returns a completed turn before background memory finishes", async () => {
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const engine = new StoryEngine({
    world,
    initialState,
    llm: new MockLlm(),
    memory: {
      async update(state) {
        await gate;
        return { ...state, chapterSummary: "后台摘要" };
      },
    },
  });

  const turn = await engine.play(startingOption);
  assert.equal(turn.number, 1);
  assert.notEqual(engine.store.current.chapterSummary, "后台摘要");
  release();
  await engine.flushBackground();
  assert.equal(engine.store.current.chapterSummary, "后台摘要");
});

test("engine prefetches character details from generated option targets", async () => {
  let detailCalls = 0;
  const state = {
    ...initialState,
    discoveredCharacterIds: ["lin"],
    entityStates: {
      lin: { status: "active", factionId: null, locationId: "旧码头" },
    },
  };
  const llm = {
    async generateStory(args) {
      return new MockLlm().generateStory(args);
    },
    async generateStructure(args) {
      const response = await new MockLlm().generateStructure(args);
      response.options[0] = {
        ...response.options[0],
        target: { type: "character", id: "lin" },
      };
      return response;
    },
    // 意图生成选项带人物目标：预取随之而来（普通回合选项由此产生）。
    async generateIntentOptions() {
      return [
        {
          id: "intent-lin",
          text: "去找林雾",
          axis: "social",
          approach: "persuade",
          risk: "safe",
          attribute: "resolve",
          target: { type: "character", id: "lin" },
        },
        {
          id: "intent-exit",
          text: "退到阴影中等待",
          axis: "exit",
          approach: "avoid",
          risk: "safe",
          attribute: "agility",
        },
      ];
    },
  };
  const engine = new StoryEngine({
    world,
    initialState: state,
    llm,
    detailCharacter: async () => {
      detailCalls += 1;
      return { summary: "精读后的林雾" };
    },
  });

  await engine.play(startingOption);
  await new Promise((resolve) => setImmediate(resolve));
  await engine.generateOptions({ intent: "找林雾" });
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(detailCalls, 1);
  assert.equal(engine.world.characters.find((item) => item.id === "lin").detailed, true);
});

test("ordinary and event turns stay fast; only clash resolutions go key", async () => {
  const keyTurns = [];
  const llm = {
    async generateStory(args) {
      keyTurns.push(args.keyTurn);
      return new MockLlm().generateStory(args);
    },
    async generateStructure(args) {
      return new MockLlm().generateStructure(args);
    },
  };
  const engine = new StoryEngine({ world, initialState, llm });

  const first = await engine.play(startingOption);
  await engine.play(nextStep("start-2", "safe"));

  // 主线事件、暴击等不再抬升为关键回合，普通回合与事件回合都走快模型。
  assert.deepEqual(keyTurns, [false, false]);
});

test("engine passes ordinary timeout to non-clash turns", async () => {
  const calls = [];
  const llm = {
    async generateStory(args) {
      calls.push(args.timeoutMs);
      return new MockLlm().generateStory(args);
    },
    async generateStructure(args) {
      return new MockLlm().generateStructure(args);
    },
  };
  const engine = new StoryEngine({ world, initialState, llm });
  const first = await engine.play(startingOption);
  await engine.play(nextStep("start-2", "safe"));
  assert.deepEqual(calls, [150_000, 150_000]);
});

test("普通回合不再产出预设选项:结构请求的 options 一律清空,repair 不触发", async () => {
  let repairCalls = 0;
  const llm = {
    async generateStory() {
      return { narrative: "正文保持不变。" };
    },
    async generateStructure(args) {
      const response = await new MockLlm().generateStructure(args);
      // 模型即使照旧写了 options(含重复 axis 这类坏数据),普通回合也不采纳。
      response.options = [
        {
          id: "missing",
          text: "追赶未曾见过的人",
          axis: "investigate",
          risk: "safe",
          attribute: "resolve",
          target: { type: "character", id: "lin" },
        },
        {
          id: "exit",
          text: "离开",
          axis: "investigate", // 重复 axis:结构不合法
          risk: "safe",
          attribute: "resolve",
        },
      ];
      return response;
    },
    async repairOptions() {
      repairCalls += 1;
      throw new Error("option repair unavailable");
    },
  };
  const engine = new StoryEngine({ world, initialState, llm });
  const turn = await engine.play(startingOption);
  assert.equal(turn.narrative, "正文保持不变。");
  assert.deepEqual(turn.options, [], "普通回合不产出预设选项");
  assert.equal(repairCalls, 0, "普通回合不触发选项修复");
  assert.equal(engine.store.current.turn, 1);
});

test("普通回合 options 缺省/过少一律清空,不回落兜底选项", async () => {
  let repairOptionsCalls = 0;
  const llm = {
    async generateStory() {
      return { narrative: "正文保持不变。" };
    },
    async generateStructure(args) {
      const response = await new MockLlm().generateStructure(args);
      // 模型漏写选项:只给了 1 个,低于协议下限——普通回合同样不采纳。
      response.options = [response.options[0]];
      return response;
    },
    async repairOptions() {
      repairOptionsCalls += 1;
      throw new Error("option repair unavailable");
    },
  };
  const engine = new StoryEngine({ world, initialState, llm });
  const turn = await engine.play(startingOption);
  assert.equal(turn.narrative, "正文保持不变。");
  assert.deepEqual(turn.options, []);
  assert.equal(repairOptionsCalls, 0);
  assert.equal(engine.store.current.turn, 1);
});

test("普通回合 options 完全缺失也照常推进,选项为空", async () => {
  const llm = {
    async generateStory() {
      return { narrative: "正文保持不变。" };
    },
    async generateStructure(args) {
      const response = await new MockLlm().generateStructure(args);
      // 模型完全没写 options 字段，或写成了非数组：普通回合照常推进。
      delete response.options;
      return response;
    },
    async repairOptions() {
      throw new Error("option repair unavailable");
    },
  };
  const engine = new StoryEngine({ world, initialState, llm });
  const turn = await engine.play(startingOption);
  assert.equal(turn.narrative, "正文保持不变。");
  assert.deepEqual(turn.options, []);
  assert.equal(engine.store.current.turn, 1);
});

test("engine treats a missing or null delta as no stat change", async () => {
  const llm = {
    async generateStory() {
      return { narrative: "正文保持不变。" };
    },
    async generateStructure(args) {
      const response = await new MockLlm().generateStructure(args);
      // 模型把 delta 写成 null（schema 要求对象却给了 null）：按空对象处理，回合照常推进。
      response.delta = null;
      return response;
    },
  };
  const engine = new StoryEngine({ world, initialState, llm });
  const turn = await engine.play(startingOption);
  assert.equal(turn.narrative, "正文保持不变。");
  assert.equal(turn.number, 1);
  // 没有数值变化，状态保持初始值。
  assert.equal(engine.store.current.stats.breath, initialState.stats.breath);
});

test("delta clamps out-of-range changes to stat boundaries", () => {
  const applied = applyDelta(initialState, { breath: -10 }, world);
  assert.equal(applied.state.stats.breath, 0);
  assert.deepEqual(applied.state.conditions, ["重伤昏迷"]);
  assert.equal(applied.consequences[0].type, "vital_zero");

  // 越界变化钳到边界，而不是抛错：-11 与 -10 一样把余息压到 0。
  const clamped = applyDelta(initialState, { breath: -11 }, world);
  assert.equal(clamped.state.stats.breath, 0);
});

test("vital stats without zeroConsequence never pollute conditions", () => {
  const bareWorld = {
    stats: [{ id: "life", role: "vital", min: 0, max: 10 }],
  };
  const applied = applyDelta(
    { turn: 1, stats: { life: 0 }, conditions: [] },
    { life: 0 },
    bareWorld,
  );
  assert.deepEqual(applied.state.conditions, []);
  assert.deepEqual(applied.consequences, []);
});

test("snapshot undo restores byte-equivalent state", () => {
  const store = new SnapshotStore(initialState);
  const expected = store.current;
  store.push({ ...expected, turn: 1, stats: { ...expected.stats, clue: 1 } });
  assert.deepEqual(store.undo(), expected);
});

test("context keeps unresolved early thread and retrieves its fact", () => {
  const context = buildContext({
    world,
    state: {
      ...initialState,
      turn: 20,
      retrievalKeywords: ["燕尾"],
    },
    dueEvents: [],
    history: [
      { number: 2, narrative: "发现铜扣", openThreads: ["燕尾铜扣"] },
      ...Array.from({ length: 18 }, (_, index) => ({
        number: index + 3,
        narrative: "后续",
        openThreads: [],
      })),
    ],
  });
  assert.ok(context.unresolvedThreads.includes("燕尾铜扣"));
  assert.ok(context.retrievedFacts.some((fact) => fact.text.includes("燕尾")));
});

test("completed turns create structured memories for later context", async () => {
  const engine = new StoryEngine({ world, initialState, llm: new MockLlm() });
  const first = await engine.play(startingOption);
  const second = await engine.play(nextStep());
  assert.ok(engine.store.current.longTermMemories.some((item) => item.type === "thread"));
  await engine.play(nextStep("next-2"));
  assert.ok(engine.history.at(-1).context.retrievedMemories.some((item) =>
    item.text.includes("燕尾"),
  ));
});

test("relationship approach modifies hidden checks", () => {
  const state = {
    ...initialState,
    relationships: {
      "character:lin": { trust: 7, fear: 2, hostility: 3 },
    },
  };
  const relationship = actionModifiers(
    {
      axis: "social",
      approach: "persuade",
      risk: "safe",
      target: { type: "character", id: "lin" },
    },
    state,
  );
  assert.deepEqual(relationship, {
    total: 5,
    relationship: 5,
    faction: 0,
    resource: 0,
    approach: "persuade",
  });
});

test("context reuses a shared fact index without chapter gates", () => {
  let searches = 0;
  const factIndex = {
    search(query, options) {
      searches += 1;
      assert.match(query, /燕尾/);
      // 拍板 2026-08-17：玩家已读完小说，未解锁章节一律不过滤——
      // 检索不再带 chapterAnchor 过滤，全书事实都可命中。
      assert.equal(options.filter, undefined);
      return world.facts.slice(0, options.limit);
    },
  };

  const context = buildContext({
    world,
    state: { ...initialState, retrievalKeywords: ["燕尾"], unlockedChapter: 1 },
    history: [],
    dueEvents: [],
    factIndex,
  });

  assert.equal(searches, 1);
  assert.ok(context.retrievedFacts.length >= 1);
});

test("context includes only local discovered characters and related factions", () => {
  const localWorld = {
    ...world,
    locations: [
      { id: "dock", name: "旧码头", connections: ["tower"] },
      { id: "tower", name: "灯塔", connections: ["dock"] },
      { id: "warehouse", name: "盐仓", connections: [] },
    ],
    characters: [
      { id: "local", name: "近人", factionId: "watch", locationIds: ["dock"] },
      { id: "adjacent", name: "邻人", factionId: "watch", locationIds: ["tower"] },
      { id: "far", name: "远人", factionId: "merchants", locationIds: ["warehouse"] },
    ],
    factions: [
      { id: "watch", name: "守夜人" },
      { id: "merchants", name: "商会" },
    ],
  };
  const state = {
    ...initialState,
    location: "旧码头",
    locationId: "dock",
    discoveredCharacterIds: ["local", "adjacent", "far"],
    entityStates: {
      local: { status: "active", factionId: "watch", locationId: "dock" },
      adjacent: { status: "active", factionId: "watch", locationId: "tower" },
      far: { status: "active", factionId: "merchants", locationId: "warehouse" },
    },
  };

  const context = buildContext({
    world: localWorld,
    state,
    history: [],
    dueEvents: [],
  });

  assert.deepEqual(context.world.locations.map((item) => item.id), ["dock", "tower"]);
  assert.deepEqual(context.world.characters.map((item) => item.id), ["local", "adjacent"]);
  assert.deepEqual(context.world.factions.map((item) => item.id), ["watch"]);
});

test("engine completes 20 turns with timeline, intent options, memory, and hard rules", async () => {
  const engine = new StoryEngine({
    world,
    initialState,
    llm: new MockLlm(),
    seed: 20260810,
  });

  let option = startingOption;
  let beforeUndo;
  for (let index = 0; index < 20; index += 1) {
    if (index === 6) beforeUndo = engine.store.current;
    const turn = await engine.play(option);
    assert.match(turn.narrative, /\S/);
    // 普通回合不产出预设选项（拍板：选项由玩家意图动态产生）。
    assert.deepEqual(turn.options, []);
    const generated = await engine.generateOptions({ intent: "继续探查" });
    assert.ok(generated.options.length >= 2 && generated.options.length <= 10);
    assert.equal(new Set(generated.options.map((item) => item.axis)).size, generated.options.length);
    assert.ok(generated.options.some((item) => item.axis === "exit"));
    option = generated.options[index % generated.options.length];
  }

  assert.equal(engine.history.length, 20);
  assert.ok(engine.rewriteCount <= 2);
  assert.equal(engine.store.current.resolvedEventIds.length, 10);
  assert.ok(
    engine.history.some((turn) =>
      turn.dueEvents.some((event) => event.delivery === "present"),
    ),
  );
  assert.ok(
    engine.history.some((turn) =>
      turn.dueEvents.some((event) => event.delivery === "rumor"),
    ),
  );
  assert.ok(engine.store.current.conditions.includes("重伤昏迷"));
  assert.ok(engine.history.at(-1).context.unresolvedThreads.includes("燕尾铜扣"));
  assert.ok(engine.history.at(-1).context.retrievedFacts.some((fact) => fact.text.includes("燕尾")));
  // 最新一条回合保留完整 context，且其 recentTurns 里不嵌套 context。
  assert.ok(
    engine.history.at(-1).context.recentTurns.every((recent) => !("context" in recent)),
  );
  // 历史只保留最新一条回合的完整 context：更早回合不再内嵌（存档瘦身）。
  assert.ok(engine.history.slice(0, -1).every((turn) => !("context" in turn)));

  const finalBeforeUndo = engine.store.snapshots.at(-2);
  assert.deepEqual(engine.undo(), finalBeforeUndo);
  assert.notDeepEqual(engine.store.current, beforeUndo);
  // 内存快照封顶：不随回合数线性膨胀（undo 只需倒数第二份）。
  assert.ok(engine.store.snapshots.length <= 5);
});

test("state patches move location and resolve threads; chapters follow the river", async () => {
  const llm = {
    async generateStory(args) {
      return new MockLlm().generateStory(args);
    },
    async generateStructure(args) {
      const response = await new MockLlm().generateStructure(args);
      return {
        ...response,
        statePatch: {
          locationId: "灯塔",
          unlockedChapter: 4, // 模型仍可能写:引擎一律丢弃,章节只由原文时间推演。
          resolvedThreads: ["燕尾铜扣"],
        },
      };
    },
  };
  const engine = new StoryEngine({ world, initialState, llm });
  await engine.play(startingOption);
  assert.equal(engine.store.current.location, "灯塔");
  assert.deepEqual(engine.store.current.resolvedThreads, ["燕尾铜扣"]);
  // 阅读范围固定(拍板:由进入意图一次定死,不再随时间推演):模型写的 4 不采纳,开局值不变。
  assert.notEqual(engine.store.current.unlockedChapter, 4);
  assert.equal(engine.store.current.unlockedChapter, initialState.unlockedChapter, "阅读范围不再扩张");
});

test("observer proposes whitelisted adaptation every 10 turns", async () => {
  const mock = new MockLlm();
  const safeStructure = () => ({
    delta: {},
    statePatch: {},
    options: [
      { id: "o1", text: "观察", axis: "investigate", approach: "resist", risk: "safe", attribute: "resolve", timeCost: 30 },
      { id: "o2", text: "退开", axis: "exit", approach: "avoid", risk: "safe", attribute: "agility", timeCost: 30 },
      { id: "o3", text: "搭话", axis: "social", approach: "persuade", risk: "safe", attribute: "resolve", timeCost: 30 },
    ],
    openThreads: [],
    retrievalKeywords: [],
  });
  const observations = [];
  const llm = {
    generateStory: (args) => mock.generateStory(args),
    generateStructure: () => safeStructure(),
    observePlayer: async (payload) => {
      observations.push(payload);
      return { difficultyBias: 1, optionFlavor: "dangerous", pacing: "faster" };
    },
  };
  const engine = new StoryEngine({ world, initialState, llm });
  for (let index = 0; index < 10; index += 1) await engine.play(startingOption);
  assert.equal(observations.length, 1, "第 10 回合调用一次观察者");
  assert.equal(engine.store.current.adaptation.difficultyBias, 1);
  assert.equal(engine.store.current.adaptation.optionFlavor, "dangerous");
  assert.equal(engine.store.current.adaptation.pacing, "faster");
  assert.equal(engine.store.current.adaptation.updatedTurn, 10);
});

test("invalid observer proposals are dropped and failures stay silent", async () => {
  const mock = new MockLlm();
  const safeStructure = () => ({
    delta: {},
    statePatch: {},
    options: [
      { id: "o1", text: "观察", axis: "investigate", approach: "resist", risk: "safe", attribute: "resolve", timeCost: 30 },
      { id: "o2", text: "退开", axis: "exit", approach: "avoid", risk: "safe", attribute: "agility", timeCost: 30 },
    ],
    openThreads: [],
    retrievalKeywords: [],
  });
  const bad = new StoryEngine({
    world,
    initialState,
    llm: {
      generateStory: (args) => mock.generateStory(args),
      generateStructure: () => safeStructure(),
      observePlayer: async () => ({ difficultyBias: 99, optionFlavor: "banana" }),
    },
  });
  for (let index = 0; index < 10; index += 1) await bad.play(startingOption);
  assert.equal(bad.store.current.adaptation.difficultyBias, 3, "越界偏差钳到封顶 ±3");
  assert.equal(bad.store.current.adaptation.optionFlavor, "neutral", "非法风格枚举整体丢弃");
  const failing = new StoryEngine({
    world,
    initialState,
    llm: {
      generateStory: (args) => mock.generateStory(args),
      generateStructure: () => safeStructure(),
      observePlayer: async () => {
        throw new Error("down");
      },
    },
  });
  for (let index = 0; index < 10; index += 1) await failing.play(startingOption);
  assert.equal(failing.store.current.adaptation.difficultyBias, 0, "观察者失败静默继续");
});

test("jumpMinutes advances world time while reading scope stays fixed", async () => {
  const llm = {
    async generateStory(args) {
      return new MockLlm().generateStory(args);
    },
    async generateStructure(args) {
      const response = await new MockLlm().generateStructure(args);
      return { ...response, jumpMinutes: 120 };
    },
  };
  const engine = new StoryEngine({ world, initialState, llm });
  await engine.play(startingOption);
  // 回合 timeCost 60 + 跳跃 120 = 180 分钟;阅读范围固定(拍板),不再按时间推演章节。
  assert.equal(engine.store.current.worldTime, 180);
  assert.equal(engine.store.current.unlockedChapter, initialState.unlockedChapter, "阅读范围不随世界时间扩张");
  // 非法跳跃被清洗:负数与超上限都不生效。
  const bad = new StoryEngine({ world, initialState, llm: {
    async generateStory(args) { return new MockLlm().generateStory(args); },
    async generateStructure(args) {
      const response = await new MockLlm().generateStructure(args);
      return { ...response, jumpMinutes: 999999 };
    },
  } });
  await bad.play(startingOption);
  assert.equal(bad.store.current.worldTime, 60);
});

test("canon events are delivered as present or rumor by current location", async () => {
  const engine = new StoryEngine({
    world,
    initialState: { ...initialState, turn: 1 },
    llm: new MockLlm(),
  });
  const turn = await engine.play(startingOption);
  assert.ok(turn.dueEvents.length > 0);
  assert.ok(turn.dueEvents.every((event) => ["present", "rumor"].includes(event.delivery)));
  assert.equal(turn.dueEvents[0].delivery, "present");
});

test("player action events remain delivered until their declared target is chosen", async () => {
  const eventWorld = {
    ...world,
    timeline: [{
      id: "rescue",
      time: 60,
      locationId: "旧码头",
      text: "林雾被困",
      chapterAnchor: 1,
      prerequisites: [],
      invalidatedBy: [],
      resolution: "player_action",
      resolutionTargetIds: ["lin"],
    }],
  };
  const state = {
    ...initialState,
    player: {
      id: "player",
      roleId: "outsider",
      roleName: "外来者",
    },
    discoveredCharacterIds: ["lin"],
    entityStates: { lin: { status: "active", locationId: "旧码头" } },
    eventStates: { rescue: { status: "scheduled" } },
  };
  const engine = new StoryEngine({ world: eventWorld, initialState: state, llm: new MockLlm() });

  const delivered = await engine.play(startingOption);
  assert.equal(delivered.dueEvents[0].id, "rescue");
  assert.equal(engine.store.current.eventStates.rescue.status, "delivered");

  const unrelated = await engine.play(nextStep("unrelated"));
  assert.equal(unrelated.dueEvents.length, 0);
  assert.equal(engine.store.current.eventStates.rescue.status, "delivered");

  await engine.play({
    ...nextStep("help-lin"),
    target: { type: "character", id: "lin" },
  });
  assert.equal(engine.store.current.eventStates.rescue.status, "resolved");
});

test("play reports phase events in pipeline order", async () => {
  const phases = [];
  const engine = new StoryEngine({
    world,
    initialState,
    llm: new MockLlm(),
    seed: 1,
    onPhase: (phase) => phases.push(phase),
  });
  await engine.play(startingOption);
  // directing:弧线导演的规划/漂移阶段(拍板:剧情层叠加),先于叙事发生。
  assert.deepEqual(phases, ["directing", "narrative-done", "structure"]);
});

test("a throwing phase callback never breaks the turn", async () => {
  const engine = new StoryEngine({
    world,
    initialState,
    llm: new MockLlm(),
    seed: 1,
    onPhase: () => {
      throw new Error("phase sink exploded");
    },
  });
  const turn = await engine.play(startingOption);
  assert.equal(turn.number, 1);
});

test("narrative identity violations trigger exactly one rewrite", async () => {
  const mock = new MockLlm();
  let storyCalls = 0;
  let lastRewriteNote = "";
  const llm = {
    async generateStory(args) {
      storyCalls += 1;
      lastRewriteNote = args.rewriteNote ?? "";
      return mock.generateStory(args);
    },
    generateStructure: (args) => mock.generateStructure(args),
    async checkIdentityConsistency({ options }) {
      // 叙事校验(options 为空)第一次报违例,之后一律通过。
      if (!(options?.length) && storyCalls === 1) {
        return { ok: false, issues: [{ where: "narrative", text: "练气修士不该御剑飞行" }] };
      }
      return { ok: true, issues: [] };
    },
  };
  const engine = new StoryEngine({ world, initialState, llm, seed: 1 });
  const turn = await engine.play(startingOption);
  assert.equal(turn.number, 1);
  assert.equal(storyCalls, 2, "叙事违例应重写一次");
  assert.match(lastRewriteNote, /身份一致违例/);
  assert.match(lastRewriteNote, /练气修士不该御剑飞行/);
});

test("option identity violations trigger exactly one structure regeneration", async () => {
  const mock = new MockLlm();
  let structureCalls = 0;
  let lastCorrectionNote = "";
  const llm = {
    generateStory: (args) => mock.generateStory(args),
    async generateStructure(args) {
      structureCalls += 1;
      lastCorrectionNote = args.correctionNote ?? "";
      return mock.generateStructure(args);
    },
    async checkIdentityConsistency({ options }) {
      // 第一份结构生成完后报选项违例。
      if (options?.length && structureCalls === 1) {
        return { ok: false, issues: [{ where: "options", text: "选项出现了超出身份的御剑行动" }] };
      }
      return { ok: true, issues: [] };
    },
  };
  const engine = new StoryEngine({ world, initialState, llm, seed: 1 });
  const turn = await engine.play(startingOption);
  assert.equal(turn.number, 1);
  assert.equal(structureCalls, 2, "选项违例应重生成一次结构");
  assert.match(lastCorrectionNote, /身份一致违例/);
  assert.match(lastCorrectionNote, /超出身份的御剑行动/);
});

test("personality conflicts in options trigger exactly one regeneration", async () => {
  const mock = new MockLlm();
  let structureCalls = 0;
  const llm = {
    generateStory: (args) => mock.generateStory(args),
    async generateStructure(args) {
      structureCalls += 1;
      return mock.generateStructure(args);
    },
    async checkIdentityConsistency({ options }) {
      if (options?.length && structureCalls === 1) {
        return { ok: false, issues: [{ where: "options", text: "冷血的玩家不该出现毫无代价的施救选项" }] };
      }
      return { ok: true, issues: [] };
    },
  };
  const engine = new StoryEngine({ world, initialState, llm, seed: 1 });
  const turn = await engine.play(startingOption);
  assert.equal(turn.number, 1);
  assert.equal(structureCalls, 2, "性格冲突违例应重生成一次结构");
});

test("buildContext carries canonPast and retrieves only effective facts", () => {
  const eventWorld = structuredClone(world);
  eventWorld.timeline = [
    {
      id: "e1",
      time: 10,
      text: "黄枫谷被灭门",
      chapterAnchor: 2,
      locationId: "旧码头",
      prerequisites: [],
      invalidatedBy: [],
      resolution: "world_time",
      resolutionTargetIds: [],
      factsToInvalidate: ["f2"],
      factsToAdd: [{ id: "f-new", text: "黄枫谷已成废墟", chapterAnchor: 2 }],
    },
    {
      id: "e2",
      time: 999,
      text: "未来之事",
      chapterAnchor: 9,
      locationId: "旧码头",
      prerequisites: [],
      invalidatedBy: [],
      resolution: "world_time",
      resolutionTargetIds: [],
      factsToAdd: [{ id: "f-future", text: "未来事实", chapterAnchor: 9 }],
    },
  ];
  eventWorld.facts = [
    { id: "f1", chapterAnchor: 1, text: "旧码头的黑铃从不被海风吹响。" },
    { id: "f2", chapterAnchor: 1, text: "黄枫谷为越国大派。" },
  ];
  const withEvents = migrateState(structuredClone(initialState), eventWorld);
  withEvents.eventStates = {
    e1: { status: "delivered", delivery: "backstory" },
    e2: { status: "scheduled" },
  };
  withEvents.retrievalKeywords = ["黄枫谷"];
  const context = buildContext({
    world: eventWorld,
    state: withEvents,
    history: [],
    dueEvents: [],
    dominantSystems: [],
    unresolvedThreads: [],
  });
  assert.deepEqual(context.canonPast.map((event) => event.id), ["e1"]);
  assert.match(context.canonPast[0].text, /黄枫谷被灭门/);
  assert.ok(
    context.retrievedFacts.some((fact) => fact.id === "f-new"),
    "检索应命中已交付事件新增的事实",
  );
  assert.ok(
    !context.retrievedFacts.some((fact) => fact.id === "f2"),
    "失效事实不再进入检索结果",
  );
  assert.ok(
    !context.retrievedFacts.some((fact) => fact.id === "f-future"),
    "未发生事件的事实不出现",
  );
});

test("buildContext carries player creations for intent options and turns", () => {
  const createdWorld = normalizeWorld(structuredClone(world));
  createdWorld.factions.push({
    id: "ting-yu-ge",
    name: "听雨阁",
    summary: "旧码头的散修结社",
    provenance: { source: "player_created", lifeIndex: 1, createdTurn: 3 },
  });
  const context = buildContext({
    world: createdWorld,
    state: structuredClone(initialState),
    history: [],
    dueEvents: [],
  });
  assert.equal(context.playerCreations.factions.length, 1);
  assert.equal(context.playerCreations.factions[0].name, "听雨阁");
  assert.equal(context.playerCreations.factions[0].id, "ting-yu-ge");
  // 原著实体不混入玩家原创清单。
  assert.equal(
    context.playerCreations.characters.some((item) => item.provenance?.source === "canon"),
    false,
  );
  assert.equal(context.playerCreations.locations.length, 0);
});

test("identity checker failures never block the turn", async () => {
  const mock = new MockLlm();
  const llm = {
    generateStory: (args) => mock.generateStory(args),
    generateStructure: (args) => mock.generateStructure(args),
    async checkIdentityConsistency() {
      throw new Error("checker down");
    },
  };
  const engine = new StoryEngine({ world, initialState, llm, seed: 1 });
  const turn = await engine.play(startingOption);
  assert.equal(turn.number, 1, "校验器挂了回合照常完成");
});

test("buildContext flags a pending stage ending for foreshadowing", () => {
  const base = migrateState(structuredClone(initialState), world);
  base.personalGoals = [
    {
      id: "core-goal-1",
      kind: "core",
      status: "completed",
      endingEligible: true,
      publicDirection: "把灯带回来",
    },
  ];
  base.endingCandidate = {
    type: "stage",
    goalId: "core-goal-1",
    createdTurn: 5,
    stableTurns: 1,
    ready: false,
  };
  const context = buildContext({
    world,
    state: base,
    history: [],
    dueEvents: [],
    dominantSystems: [],
    unresolvedThreads: [],
  });
  assert.deepEqual(context.endingApproach, {
    stableTurns: 1,
    publicDirection: "把灯带回来",
  });

  const folded = structuredClone(base);
  folded.endingCandidate.ready = true;
  const foldedContext = buildContext({
    world,
    state: folded,
    history: [],
    dueEvents: [],
    dominantSystems: [],
    unresolvedThreads: [],
  });
  assert.equal(foldedContext.endingApproach, null, "合拢回合不再注入临近信号");
});

test("buildContext carries the player capability profile", () => {
  const base = migrateState(structuredClone(initialState), world);
  base.player = {
    id: "player",
    name: "沈砚",
    roleId: "elder",
    roleName: "元婴长老",
    factionId: null,
    locationId: "旧码头",
    motivation: "活下去",
    bigFive: { openness: 70, conscientiousness: 50, extraversion: 50, agreeableness: 30, neuroticism: 50 },
    abilities: ["能以神识扫探方圆数里"],
  };
  const realmWorld = structuredClone(world);
  realmWorld.roleTemplates = [
    {
      id: "elder",
      name: "元婴长老",
      description: "修为深厚的外来长老",
      factionIds: [],
      locationIds: ["旧码头"],
      abilities: ["能以神识扫探方圆数里"],
    },
  ];
  realmWorld.traits = [
    { id: "t1", name: "境界", value: "练气/筑基/金丹/元婴", description: "修行阶梯" },
  ];
  realmWorld.creationCatalog = {
    ...(realmWorld.creationCatalog ?? {}),
    bigFive: {
      openness: [
        { id: "open-prudent", name: "谨慎行事", description: "先看后动", pole: "high", weight: 1, goodSide: "稳当", badSide: "保守" },
      ],
    },
  };
  const context = buildContext({
    world: realmWorld,
    state: base,
    history: [],
    dueEvents: [],
    dominantSystems: [],
    unresolvedThreads: [],
  });
  assert.equal(context.playerCapabilities.roleName, "元婴长老");
  assert.deepEqual(context.playerCapabilities.abilities, ["能以神识扫探方圆数里"]);
  assert.ok(context.playerCapabilities.realmTraits.length >= 1, "境界阶梯 traits 应摘录");
  assert.ok(Array.isArray(context.playerCapabilities.bigFive), "大五摘要进能力块");
  assert.equal(context.playerCapabilities.bigFive.length, 5);
  const openness = context.playerCapabilities.bigFive.find((item) => item.key === "openness");
  assert.equal(openness.value, 70, "分值进能力块");
  assert.equal(openness.level, "偏高", "档位定性");
  assert.deepEqual(openness.selections, ["谨慎行事"], "跨档后按词库取该极行为词");
  assert.deepEqual(openness.goodSide, ["稳当"], "好面进能力块");
  assert.deepEqual(openness.badSide, ["保守"], "坏面进能力块");
  const extraversion = context.playerCapabilities.bigFive.find((item) => item.key === "extraversion");
  assert.equal(extraversion.level, "均衡");
  assert.deepEqual(extraversion.selections, [], "均衡维不带行为词(中庸起步,白纸不落性子)");
  assert.equal(context.playerCapabilities.stats.clue, 0);

  // 玩家成长三补丁(拍板 2026-08-19):习得技能并入 abilities、行囊摘要进能力块——
  // 模型据此知道玩家会什么、有什么。
  base.player.learnedAbilities = ["能以神识扫探方圆数里"];
  base.player.inventory = [
    { id: "item:sword", name: "养父的遗剑", note: "剑鞘刻着燕尾", obtainedTurn: 3, source: "emergent" },
    { id: "item:coin", name: "燕尾铜扣", note: "", obtainedTurn: 5, source: "catalog" },
  ];
  const grown = buildContext({
    world: realmWorld,
    state: base,
    history: [],
    dueEvents: [],
    dominantSystems: [],
    unresolvedThreads: [],
  });
  assert.ok(grown.playerCapabilities.abilities.includes("能以神识扫探方圆数里"), "习得技能并入能力块");
  assert.deepEqual(grown.playerCapabilities.inventory, [
    "养父的遗剑（剑鞘刻着燕尾）",
    "燕尾铜扣",
  ], "行囊摘要有注带注、无注只列名");

  // 身份蕴含特质进入能力块:traitIds 与 traitList 同源。
  base.player.traitIds = ["t1"];
  const withTraits = buildContext({
    world: realmWorld,
    state: base,
    history: [],
    dueEvents: [],
    dominantSystems: [],
    unresolvedThreads: [],
  });
  assert.deepEqual(withTraits.playerCapabilities.traitIds, ["t1"]);
  assert.ok(
    withTraits.playerCapabilities.traitList.some((text) => text.includes("元婴")),
    "traitList 应含特质描述",
  );

  // 非修炼题材(都市)同样成立:能力是职权/技能,无境界阶梯也不炸。
  const urbanWorld = structuredClone(world);
  urbanWorld.roleTemplates = [
    {
      id: "editor",
      name: "报社主编",
      description: "主管整份报纸的刊发",
      factionIds: [],
      locationIds: ["旧码头"],
      abilities: ["以主编之权调阅稿件档案", "认得全城所有报贩"],
      authority: ["inspect"],
    },
  ];
  urbanWorld.traits = [{ id: "t2", name: "行业惯例", value: "报馆规矩", description: "无修炼体系" }];
  urbanWorld.factions = [{ id: "press", name: "报社", summary: "", locationIds: [] }];
  const urbanState = migrateState(structuredClone(initialState), urbanWorld);
  urbanState.player = {
    id: "player",
    name: "沈砚",
    roleId: "editor",
    roleName: "报社主编",
    factionId: "press",
    locationId: "旧码头",
    motivation: "查明真相",
  };
  const urbanContext = buildContext({
    world: urbanWorld,
    state: urbanState,
    history: [],
    dueEvents: [],
    dominantSystems: [],
    unresolvedThreads: [],
  });
  assert.deepEqual(
    urbanContext.playerCapabilities.abilities,
    ["以主编之权调阅稿件档案", "认得全城所有报贩"],
    "非修炼题材的身份能力同样进入能力块",
  );
  assert.deepEqual(urbanContext.playerCapabilities.realmTraits, [], "无修炼体系不产生境界阶梯");
  assert.equal(urbanContext.playerCapabilities.roleName, "报社主编");

  // 无 abilities 的旧世界退化不炸:能力块只剩身份与数值。
  const plain = buildContext({
    world,
    state: migrateState(structuredClone(initialState), world),
    history: [],
    dueEvents: [],
    dominantSystems: [],
    unresolvedThreads: [],
  });
  assert.equal(Array.isArray(plain.playerCapabilities.abilities), true);
  assert.equal(plain.playerCapabilities.abilities.length, 0);
});


test("response validates bigFiveShift shape and bounds", () => {
  const valid = {
    narrative: "潮声逼近。",
    delta: { clue: 1 },
    options: [
      { id: "a", text: "观察", axis: "investigate", risk: "safe", attribute: "resolve" },
      { id: "b", text: "交涉", axis: "social", risk: "risky", attribute: "resolve" },
      { id: "c", text: "离开", axis: "exit", risk: "safe", attribute: "agility" },
    ],
  };
  const withShift = {
    ...valid,
    options: [
      { ...valid.options[0], bigFiveShift: { openness: 3, agreeableness: -2 } },
      ...valid.options.slice(1),
    ],
  };
  assert.equal(validateResponse(withShift, world), true);
  assert.throws(
    () =>
      validateResponse(
        { ...valid, options: [{ ...valid.options[0], bigFiveShift: "nope" }, ...valid.options.slice(1)] },
        world,
      ),
    /bigFiveShift must be an object/,
  );
  assert.throws(
    () =>
      validateResponse(
        { ...valid, options: [{ ...valid.options[0], bigFiveShift: { openness: 9 } }, ...valid.options.slice(1)] },
        world,
      ),
    /±5/,
  );
  assert.throws(
    () =>
      validateResponse(
        { ...valid, options: [{ ...valid.options[0], bigFiveShift: { bogus: 2 } }, ...valid.options.slice(1)] },
        world,
      ),
    /unknown dimension/,
  );
});

test("selected option drifts bigFive and records evidence with crossing notes", async () => {
  const state = migrateState(structuredClone(initialState), world);
  state.player = {
    ...state.player,
    bigFive: { openness: 65, conscientiousness: 50, extraversion: 50, agreeableness: 50, neuroticism: 50 },
  };
  const engine = new StoryEngine({ world, initialState: state, llm: new MockLlm() });
  const option = { ...startingOption, bigFiveShift: { openness: 5, agreeableness: -3 } };
  const turn = await engine.play(option);
  assert.equal(engine.store.current.player.bigFive.openness, 70);
  assert.equal(engine.store.current.player.bigFive.agreeableness, 47);
  assert.deepEqual(turn.personalityNotes, [{ dimension: "openness", level: "偏高", before: "均衡" }]);
  const evidence = engine.store.current.player.personalityEvidence;
  assert.equal(evidence.at(-1).optionId, "start");
  assert.deepEqual(evidence.at(-1).shift, { openness: 5, agreeableness: -3 });
  const history = engine.store.current.player.personalityHistory;
  assert.equal(history.at(-1).turn, turn.number);
  assert.deepEqual(history.at(-1).crossings, [{ dimension: "openness", level: "偏高" }]);
  assert.deepEqual(engine.store.current.bigFiveChanges, [{ dimension: "openness", level: "偏高", before: "均衡" }]);
});

test("non-crossing shifts accumulate silently", async () => {
  const state = migrateState(structuredClone(initialState), world);
  state.player = { ...state.player, bigFive: neutralBigFive() };
  const engine = new StoryEngine({ world, initialState: state, llm: new MockLlm() });
  const turn = await engine.play({ ...startingOption, bigFiveShift: { openness: 5 } });
  assert.equal(engine.store.current.player.bigFive.openness, 55);
  assert.deepEqual(turn.personalityNotes, []);
  assert.deepEqual(engine.store.current.bigFiveChanges, []);
});

// —— 游玩模式:爽文判定偏差接线 ——

test("爽文模式的判定恒带有利偏差,原味不受影响", async () => {
  const powerEngine = new StoryEngine({
    world,
    initialState: { ...initialState, playMode: "power", startingPoint: "scratch" },
    llm: new MockLlm(),
    seed: 42,
  });
  await powerEngine.play(startingOption);
  const classicEngine = new StoryEngine({
    world,
    initialState: { ...initialState, playMode: "classic", startingPoint: "scratch" },
    llm: new MockLlm(),
    seed: 42,
  });
  await classicEngine.play(startingOption);
  assert.equal(
    powerEngine.history[0].check.margin,
    classicEngine.history[0].check.margin + 10,
    "爽文偏差 +10 落在同一随机序列上",
  );
  assert.equal(powerEngine.history[0].powerEscape, null, "未死亡无转机标记");
  assert.equal(powerEngine.store.current.playMode, "power");
  assert.equal(classicEngine.store.current.playMode, "classic");
});

test("爽文绝境转机:交锋濒死判定失败也不死,转机标记留给下一回合叙事", async () => {
  const state = migrateState(structuredClone(initialState), world);
  state.playMode = "power";
  state.player = { ...state.player, name: "沈砚" };
  // 布好一场濒死交锋:本回合失败的最后一搏本该致死。
  state.activeClash = {
    opponentId: "warden",
    opponentName: "阎策",
    origin: "player",
    reason: "搏杀",
    step: 2,
    maxSteps: 3,
    stance: -2,
    opponentCondition: 2,
    pendingDeath: true,
  };
  state.stats.breath = 0;
  const engine = new StoryEngine({ world, initialState: state, llm: new MockLlm() });
  // 定死骰子:roll 2 + 属性 35 + 偏差 10 = 47 < 55 → 濒死一搏失败。
  engine.random = Object.assign(() => 0.01, {
    getState: () => 0,
    setState: () => {},
  });
  const option = { ...startingOption, risk: "risky", approach: "resist", axis: "force" };
  const turn = await engine.play(option);
  // 爽文模式下濒死一搏失败:不判死,转机标记写入状态与回合。
  assert.equal(turn.death.dead, false);
  assert.equal(turn.death.escaped, true);
  assert.equal(turn.powerEscape.turn, turn.number);
  assert.equal(engine.store.current.player.dead, undefined);
  assert.equal(engine.store.current.stats.breath, 1, "vital 恢复到下限之上");
});

// —— 命运松动征兆与保真校验扩展(2026-08-17) ——

test("buildContext signals divergenceApproach once momentum reaches the tier threshold", () => {
  const tieredWorld = structuredClone(world);
  tieredWorld.timeline = [
    {
      id: "core-1",
      time: 10,
      text: "主线大战",
      chapterAnchor: 1,
      locationId: "旧码头",
      prerequisites: [],
      invalidatedBy: [],
      resolution: "never",
      resolutionTargetIds: [],
      tier: "core",
    },
  ];
  const base = migrateState(initialState, tieredWorld);
  const contextFor = (momentum) =>
    buildContext({
      world: tieredWorld,
      state: {
        ...base,
        pendingDivergences: [
          { id: "d", targetId: "core-1", targetType: "timeline", momentum },
        ],
      },
      history: [],
      dueEvents: [],
      styleIndex: null,
      factIndex: null,
      targetIds: [],
      dominantSystems: [],
      unresolvedThreads: [],
    });
  const below = contextFor(3);
  assert.equal(below.divergenceApproach.length, 0, "势能未达 core 阈值不注入征兆");
  assert.equal(below.activeDivergence[0].threshold, 4, "activeDivergence 带分级阈值");
  const ready = contextFor(4);
  assert.equal(ready.divergenceApproach.length, 1, "势能达阈值注入命运松动征兆");
  assert.equal(ready.divergenceApproach[0].targetType, "timeline");
  assert.equal(ready.divergenceApproach[0].label, "主线大战");
  assert.equal(typeof ready.divergenceApproach[0].label, "string");
});

test("consistency checks receive on-screen persona cards and worldview digest", async () => {
  const mock = new MockLlm();
  const testWorld = structuredClone(world);
  testWorld.characters[1] = {
    ...testWorld.characters[1],
    firstChapter: 1,
    locationIds: ["旧码头"],
    persona: {
      temperament: "谨慎多疑",
      motives: "查清封港真相",
      bottomLines: "不伤无辜",
      manner: "寡言",
    },
  };
  const calls = [];
  const llm = {
    generateStory: (args) => mock.generateStory(args),
    generateStructure: (args) => mock.generateStructure(args),
    async checkIdentityConsistency(args) {
      calls.push(args);
      return { ok: true, issues: [] };
    },
  };
  const engine = new StoryEngine({ world: testWorld, initialState, llm, seed: 1 });
  const turn = await engine.play(startingOption);
  assert.equal(turn.number, 1);
  // 叙事与选项两处校验都补传了人设卡与世界观摘要。
  assert.equal(calls.length, 2, "叙事与选项各校验一次");
  for (const call of calls) {
    assert.ok(Array.isArray(call.characters), "校验收到人物卡数组");
    assert.ok(
      call.characters.some((item) => item.id === "lin" && item.persona?.temperament === "谨慎多疑"),
      "在场原著人物的人设卡进入校验载荷",
    );
    assert.equal(call.worldview.title, "灰港余烬");
    assert.ok(Array.isArray(call.worldview.traits));
  }
});

test("timeline divergence fire invalidates the event and commits a derived replacement", async () => {
  const mock = new MockLlm();
  const testWorld = structuredClone(world);
  testWorld.timeline = [
    {
      id: "fate-1",
      time: 10,
      text: "引路人将在第 3 章死去",
      chapterAnchor: 2,
      locationId: "旧码头",
      prerequisites: [],
      invalidatedBy: [],
      resolution: "never",
      resolutionTargetIds: [],
      tier: "side",
    },
    {
      id: "down-1",
      time: 20,
      text: "下游复仇",
      chapterAnchor: 4,
      locationId: "旧码头",
      prerequisites: ["fate-1"],
      invalidatedBy: [],
      resolution: "world_time",
      resolutionTargetIds: [],
      factsToAdd: [{ id: "revenge-happened", text: "复仇发生", chapterAnchor: 4 }],
    },
  ];
  const state = migrateState(initialState, testWorld);
  state.pendingDivergences = [
    { id: "d", targetId: "fate-1", targetType: "timeline", momentum: 2 },
  ];
  const fireOption = {
    ...startingOption,
    divergence: { targetId: "fate-1", targetType: "timeline", fire: true },
  };
  const llm = {
    async generateStory(args) {
      const story = await mock.generateStory(args);
      // 火候判定必须成功才能写回覆盖。
      return story;
    },
    async generateStructure(args) {
      const structure = await mock.generateStructure(args);
      return {
        ...structure,
        divergencePatch: {
          targetId: "fate-1",
          targetType: "timeline",
          fire: true,
          override: { text: "引路人没有死。" },
          evidence: "提前示警",
        },
        replacementEvent: {
          time: 30,
          text: "引路人生还,引出一段新的恩怨。",
          locationId: "旧码头",
          tier: "side",
          resolution: "never",
        },
      };
    },
    async checkIdentityConsistency() {
      return { ok: true, issues: [] };
    },
  };
  const engine = new StoryEngine({ world: testWorld, initialState: state, llm, seed: 1 });
  // 定死骰子必成:roll 2 + 属性 35 = 37 ≥ safe 难度 30 → success。
  engine.random = Object.assign(() => 0.01, {
    getState: () => 0,
    setState: () => {},
  });
  const turn = await engine.play(fireOption);
  assert.equal(turn.divergence?.stage, "resolved");
  assert.equal(turn.derivedEvent?.id, "derived-1-1");
  assert.equal(turn.derivedEvent?.source, "derived");
  assert.equal(turn.derivedEvent?.text, "引路人生还,引出一段新的恩怨。");
  // 被改事件失效,替代事件进入引擎世界时间线,且时间被钳到当前时钟之后。
  assert.equal(engine.store.current.eventStates["fate-1"].status, "invalidated");
  assert.ok(engine.world.timeline.some((event) => event.id === "derived-1-1"));
  const derived = engine.world.timeline.find((event) => event.id === "derived-1-1");
  assert.ok(derived.time > 10, "替代事件不得早于当前世界时钟");
  assert.equal(derived.chapterAnchor, 3, "替代事件锚定当前解锁章节");
});

// —— 原著此刻(canonNow):推演必须仔细贴着用户导入的小说的故事 ——

const CANON_CHAPTERS = [
  {
    index: 1,
    title: "一",
    text: `旧码头的黑铃在雾里悬着。${"沈砚数着自己的呼吸。".repeat(20)}`,
  },
  {
    index: 2,
    title: "二",
    text: `灯塔的灯在夜里亮着。${"林雾在塔上值夜。".repeat(20)}`,
  },
  {
    index: 9,
    title: "九",
    text: `盐仓地窖里藏着一册账本。${"真相在账页之间。".repeat(20)}`,
  },
];

function canonStyleIndex() {
  return new Bm25Index(styleParagraphs(CANON_CHAPTERS));
}

test("canonNowPassages 取当前故事时刻附近的原文段落,全文不过滤", () => {
  const state = migrateState(structuredClone(initialState), world);
  // 最新已交付事件锚定第 2 章:窗口取 [1,3];玩家已读完小说,未解锁章节一律不过滤。
  state.eventStates = {
    "event-1": { status: "delivered" },
    "event-2": { status: "scheduled" },
  };
  const worldWithAnchors = {
    ...world,
    timeline: [
      { id: "event-1", time: 10, text: "雾起", chapterAnchor: 2 },
      { id: "event-2", time: 20, text: "灯灭", chapterAnchor: 9 },
    ],
  };
  const now = canonNowPassages({
    world: worldWithAnchors,
    state,
    styleIndex: canonStyleIndex(),
    retrievalTerms: ["旧码头"],
    upcomingEvents: [{ id: "event-2", text: "真相藏于账本", chapterAnchor: 9 }],
  });
  assert.ok(now.length >= 1 && now.length <= 4);
  assert.ok(now.some((passage) => passage.text.includes("黑铃")), "窗口内原文片段在场");
  // 检索词并入将至事件文本后,未来章节(第 9 章)的段落可被召回——不再防剧透。
  assert.ok(now.some((passage) => passage.chapter === 9), "未来章节段落可被召回");
  assert.ok(now.some((passage) => passage.text.includes("账本")), "未来章节内容不再保密");
});

test("canonNowPassages 无事件时退到开篇窗口,无索引返回空", () => {
  const state = migrateState(structuredClone(initialState), world);
  state.eventStates = {};
  const early = canonNowPassages({
    world,
    state,
    styleIndex: canonStyleIndex(),
    retrievalTerms: [],
  });
  assert.ok(early.every((passage) => passage.chapter <= 2), "开篇窗口");

  const none = canonNowPassages({ world, state, styleIndex: undefined, retrievalTerms: [] });
  assert.deepEqual(none, []);
});

test("canonNowPassages 窗口内检索选段:插叙书不取邻章「现在时」段落", () => {
  // 部分插叙的书(拍板 2026-08-20):第 5 章是回忆(故事时间 10),第 4/6 章是
  // 「现在」(故事时间 9 万)。已投递的回忆事件锚定第 5 章,窗口 [4,6] 混着
  // 两条时间线的段落——检索应选中真正叙述回忆的段落,而非盲取窗口末段
  // (第 6 章的「现在时」)。
  const chapters = [
    { index: 4, title: "四", text: `北境战事吃紧，军情如火。${"京中人心惶惶，粮价一日三涨。".repeat(20)}` },
    { index: 5, title: "五", text: `十年前沈家镖局一夜灭门，只余幼子。旧案卷宗落灰无人翻。${"这段回忆漫长而沉重。".repeat(20)}` },
    { index: 6, title: "六", text: `北境军情急报入京。${"朝堂争论不休，战和未决。".repeat(20)}` },
  ];
  const flashbackState = migrateState(structuredClone(initialState), world);
  flashbackState.eventStates = {
    "fb-old": { status: "delivered" },
    "fb-now": { status: "scheduled" },
  };
  const now = canonNowPassages({
    world: {
      ...world,
      timeline: [
        { id: "fb-old", time: 10, text: "沈家镖局一夜灭门，旧案卷宗落灰", chapterAnchor: 5 },
        { id: "fb-now", time: 90000, text: "北境战事吃紧，军情急报入京", chapterAnchor: 4 },
      ],
    },
    state: flashbackState,
    styleIndex: new Bm25Index(styleParagraphs(chapters)),
    retrievalTerms: [],
    upcomingEvents: [],
  });
  assert.ok(now.length >= 1);
  assert.equal(now[0].chapter, 5, "检索首选叙述回忆的第 5 章段落");
  assert.match(now[0].text, /灭门|旧案|卷宗/);
});

test("buildContext 注入 canonNow 与 canonUpcoming,generateOptions 上下文也带 styleIndex", async () => {
  const state = migrateState(structuredClone(initialState), world);
  const engine = new StoryEngine({
    world,
    initialState: state,
    llm: new MockLlm(),
    sourceChapters: CANON_CHAPTERS,
  });
  const turn = await engine.play(startingOption);
  assert.ok(Array.isArray(turn.context.canonNow));
  assert.ok(turn.context.canonNow.every((item) => item.chapter >= 1 && item.text));
  // 原著将至:按故事时间升序、只含 scheduled 事件的走向预告。
  assert.ok(Array.isArray(turn.context.canonUpcoming));
  assert.ok(turn.context.canonUpcoming.length <= 8);
  assert.ok(
    turn.context.canonUpcoming.every(
      (item) => item.id && typeof item.text === "string" && item.time >= 0,
    ),
  );

  const generated = await engine.generateOptions({ intent: "继续探查" });
  assert.ok(generated.options.length >= 2);
  assert.ok(generated.options.some((item) => item.axis === "exit"));
});

// —— 意图驱动选项(拍板 2026-08-17 追加:预设选项全部取消,普通回合选项由玩家意图动态产生) ——

test("意图重生成:合法选项集通过校验,全非法回落兜底", async () => {
  const state = migrateState(structuredClone(initialState), world);
  const engine = new StoryEngine({ world, initialState: state, llm: new MockLlm() });
  const generated = await engine.generateOptions({ intent: "复仇" });
  assert.equal(generated.fallback, false);
  assert.ok(generated.options.length >= 2);
  assert.ok(generated.options.some((item) => item.axis === "exit"), "选项集必须含 exit");

  // 全部校验不过(属性不存在):回落兜底选项,不抛错。
  const badLlm = new MockLlm();
  badLlm.generateIntentOptions = async () => [
    { id: "x", text: "做不到的事", axis: "force", risk: "dire", attribute: "unknown" },
  ];
  const badEngine = new StoryEngine({ world, initialState: state, llm: badLlm });
  const fallback = await badEngine.generateOptions({ intent: "复仇" });
  assert.equal(fallback.fallback, true);
  assert.ok(fallback.options.some((item) => item.id.startsWith("fallback-")));
});

test("意图只流向选项生成,不再透传结构请求;play 与结构解耦", async () => {
  const state = migrateState(structuredClone(initialState), world);
  const llm = new MockLlm();
  const engine = new StoryEngine({ world, initialState: state, llm });
  await engine.generateOptions({ intent: "复仇" });
  assert.equal(llm.lastIntentOptionsIntent, "复仇", "意图交给选项生成器");
  await engine.play(startingOption);
  assert.equal(llm.lastStructureIntent, "", "play 不再向结构请求透传意图");
});

// —— 意图选项保真校验(拍板 2026-08-17):普通回合选项的失真入口收紧 ——

const intentOption = (id, axis = "investigate") => ({
  id,
  text: `围绕线索的行动 ${id}`,
  axis,
  approach: "resist",
  risk: "safe",
  attribute: "resolve",
});

test("意图选项保真校验:违例带清单重生成一次,采用修正版", async () => {
  const state = migrateState(structuredClone(initialState), world);
  const correctionNotes = [];
  const checks = [];
  let round = 0;
  const llm = {
    async generateIntentOptions({ correctionNote }) {
      round += 1;
      correctionNotes.push(correctionNote ?? "");
      return round === 1
        ? [intentOption("intent-bad"), intentOption("intent-exit", "exit")]
        : [intentOption("intent-fixed"), intentOption("intent-exit", "exit")];
    },
    async checkIdentityConsistency(args) {
      checks.push(args);
      return round === 1
        ? { ok: false, issues: [{ where: "options", text: "选项超出当前身份的能力上限" }] }
        : { ok: true, issues: [] };
    },
  };
  const engine = new StoryEngine({ world, initialState: state, llm });
  const generated = await engine.generateOptions({ intent: "查探码头" });
  assert.equal(generated.fallback, false);
  assert.equal(round, 2, "违例后带清单重生成一次");
  assert.match(correctionNotes[1], /能力上限/, "重生成请求带违例清单");
  assert.ok(
    generated.options.some((item) => item.id === "intent-fixed"),
    "采用重生成选项",
  );
  // 校验输入与叙事校验同源:世界观 + 原著此刻/将至 + 故事时钟都要送达。
  assert.ok(Array.isArray(checks[0].canonNow), "canonNow 送达到选项校验器");
  assert.ok(Array.isArray(checks[0].canonUpcoming), "canonUpcoming 送达到选项校验器");
  assert.equal(checks[0].worldview.title, "灰港余烬");
  assert.match(checks[0].storyClock?.label ?? "", /第 \d+ 日/, "故事时钟送达到选项校验器");
});

test("意图选项保真校验失败不拦意图:静默放行首轮选项", async () => {
  const state = migrateState(structuredClone(initialState), world);
  const llm = {
    async generateIntentOptions() {
      return [intentOption("intent-a"), intentOption("intent-exit", "exit")];
    },
    async checkIdentityConsistency() {
      throw new Error("网络抖动");
    },
  };
  const engine = new StoryEngine({ world, initialState: state, llm });
  const generated = await engine.generateOptions({ intent: "查探" });
  assert.equal(generated.fallback, false, "校验抛错不算生成失败");
  assert.equal(generated.options.length, 2, "首轮选项照常放行");
});

test("意图选项无需强制 exit:贴合意图的选项整组放行", async () => {
  // 拍板:意图选项必须贴合意图,不强制塞 exit 项。
  const state = migrateState(structuredClone(initialState), world);
  const llm = {
    async generateIntentOptions() {
      return [
        intentOption("intent-a", "social"),
        intentOption("intent-b", "investigate"),
        intentOption("intent-c", "force"),
        intentOption("intent-d", "social"),
      ];
    },
  };
  const engine = new StoryEngine({ world, initialState: state, llm });
  const generated = await engine.generateOptions({ intent: "找林雾" });
  assert.equal(generated.fallback, false, "无 exit 不整组作废");
  assert.ok(generated.options.some((item) => item.id === "intent-a"), "保留意图选项");
  assert.ok(!generated.options.some((item) => item.id.startsWith("fallback-")), "不塞兜底项");
});

test("选项指向未遇见且不在场的人物时,剥除 target 放行而不是整组兜底", async () => {
  // 线上回归:模型围绕原著现场文本生成指向未登记「已遇见」人物的选项,
  // 硬过滤把整套选项滤到不足 2 条,玩家写任何意图都被兜底。
  const state = migrateState(structuredClone(initialState), world);
  const llm = {
    async generateIntentOptions() {
      return [
        { ...intentOption("intent-a", "social"), target: { type: "character", id: "stranger-99" } },
        { ...intentOption("intent-b", "investigate"), target: { type: "character", id: "stranger-99" } },
        intentOption("intent-c", "force"),
      ];
    },
  };
  const engine = new StoryEngine({ world, initialState: state, llm });
  const generated = await engine.generateOptions({ intent: "找赵武" });
  assert.equal(generated.fallback, false, "剥除未遇见目标的选项后放行");
  assert.ok(generated.options.some((item) => item.id === "intent-a"), "保留意图选项");
  assert.ok(
    generated.options.every((item) => !item.target || item.target.id !== "stranger-99"),
    "未遇见人物的 target 已剥除",
  );
});

test("意图选项重生成坏形状时保留首轮:软兜底不抛穿", async () => {
  const state = migrateState(structuredClone(initialState), world);
  let round = 0;
  const llm = {
    async generateIntentOptions() {
      round += 1;
      if (round === 1) return [intentOption("intent-a"), intentOption("intent-exit", "exit")];
      throw new Error("重生成失败");
    },
    async checkIdentityConsistency() {
      return { ok: false, issues: [{ where: "options", text: "违例" }] };
    },
  };
  const engine = new StoryEngine({ world, initialState: state, llm });
  const generated = await engine.generateOptions({ intent: "查探" });
  assert.equal(generated.fallback, false);
  assert.ok(
    generated.options.some((item) => item.id === "intent-a"),
    "重生成失败时保留首轮选项",
  );
});

// —— 改命上下文(拍板 2026-08-17):失效铺垫过滤 + 天命难违信号 ——

test("buildContext 惰性过滤已定/失联的改命铺垫,天命难违信号来自上一回合", () => {
  const state = migrateState(structuredClone(initialState), world);
  state.eventStates = { "event-1": { status: "resolved" }, "event-2": { status: "scheduled" } };
  state.pendingDivergences = [
    { id: "d1", targetId: "event-1", targetType: "timeline", momentum: 1 },
    { id: "d2", targetId: "event-2", targetType: "timeline", momentum: 1 },
    { id: "d3", targetId: "event-999", targetType: "timeline", momentum: 1 },
  ];
  const context = buildContext({
    world,
    state,
    history: [],
    styleIndex: undefined,
    unresolvedThreads: [],
  });
  assert.deepEqual(
    context.activeDivergence.map((item) => item.targetId),
    ["event-2"],
    "已 resolved 与目标不存在的铺垫不再进上下文",
  );

  // 故事时钟(拍板:推演的时间贴着原著走):起点即第 1 日,下一件大事的距离随之给出。
  assert.equal(context.storyClock.label, "第 1 日 · 深夜", "上下文带可读故事时钟");
  assert.equal(context.storyClock.nextEventGapMinutes, 120, "时钟带距下一件原著大事的分钟数");

  const resisting = buildContext({
    world,
    state,
    history: [
      { number: 1, divergence: { stage: "seeded", fateResistance: true, target: "灯塔之变" } },
    ],
    styleIndex: undefined,
    unresolvedThreads: [],
  });
  assert.deepEqual(resisting.fateResistance, { target: "灯塔之变" }, "上一回合铺垫失败带天命反弹信号");
  const calm = buildContext({
    world,
    state,
    history: [{ number: 1, divergence: null }],
    styleIndex: undefined,
    unresolvedThreads: [],
  });
  assert.equal(calm.fateResistance, null, "无失败铺垫时无信号");
});


test("意图选项按 id+axis 双去重,重复 id 不再执行错选项", async () => {
  // 渲染层与主进程都按 id find 定位选项:两条同 id 不同 axis 的选项都放行的话,
  // 点击第二条执行的其实是第一条(find 恒取首个)。
  const engine = new StoryEngine({
    world,
    initialState,
    llm: {
      async generateIntentOptions() {
        return [
          { id: "dup", text: "打探码头", axis: "investigate", risk: "safe", attribute: "resolve" },
          { id: "dup", text: "完全不同的另一条路", axis: "social", risk: "risky", attribute: "resolve" },
          { id: "exit-1", text: "退开", axis: "exit", risk: "safe", attribute: "agility" },
        ];
      },
      async checkIdentityConsistency() {
        return { ok: true, issues: [] };
      },
    },
  });
  const { options, fallback } = await engine.generateOptions({ intent: "查案" });
  assert.equal(fallback, false);
  assert.deepEqual(
    options.map((option) => option.id),
    ["dup", "exit-1"],
    "重复 id 的第二条被去重,只剩两条可用",
  );
});

test("终局就绪后拒绝再推进回合与生成选项", async () => {
  const engine = new StoryEngine({ world, initialState, llm: new MockLlm() });
  const state = engine.store.snapshots[engine.store.snapshots.length - 1];
  state.endingCandidate = {
    type: "stage",
    goalId: "fate-complete",
    createdTurn: 1,
    stableTurns: 0,
    ready: true,
  };
  await assert.rejects(() => engine.play(startingOption), /这一卷已经合上/);
  await assert.rejects(() => engine.generateOptions({ intent: "继续" }), /这一卷已经合上/);
});

test("跳跃窗口内的原著事件当回合投递,不推迟到下一回合", async () => {
  // 事件落在 timeCost 之后、跳跃终点之前:旧实现要到下一回合才把这批事件
  // 一次性涌给玩家,时间线顺序与叙事脱节。
  const jumpWorld = {
    ...world,
    timeline: [
      {
        id: "jump-event",
        time: 150,
        locationId: "旧码头",
        text: "闭关期间港中生变",
        chapterAnchor: 1,
        prerequisites: [],
        invalidatedBy: [],
        resolution: "world_time",
        resolutionTargetIds: [],
      },
    ],
  };
  const engine = new StoryEngine({
    world: jumpWorld,
    initialState,
    llm: {
      async generateStory(args) {
        return new MockLlm().generateStory(args);
      },
      async generateStructure(args) {
        const response = await new MockLlm().generateStructure(args);
        return { ...response, jumpMinutes: 120 };
      },
    },
  });
  const turn = await engine.play(startingOption);
  assert.equal(engine.store.current.worldTime, 180);
  assert.ok(
    turn.dueEvents.some((event) => event.id === "jump-event"),
    "窗口内事件随跳跃当回合投递",
  );
  // 投递后可能随即被 resolveTimelineEvents 按声明收束(resolved),关键是在本回合进入过投递。
  assert.ok(["delivered", "resolved"].includes(engine.store.current.eventStates["jump-event"].status), "事件本回合已进入世界状态");
});

test("undo 回退伏笔集合:被撤销回合开启的线头不再残留", async () => {
  const engine = new StoryEngine({ world, initialState, llm: new MockLlm() });
  await engine.play(startingOption);
  await engine.play(startingOption);
  // MockLlm 第 2 回合起开「燕尾铜扣」伏笔;undo 掉第 2 回合后它不该还在集合里。
  const before = [...engine.openThreadSet];
  assert.ok(before.includes("燕尾铜扣"));
  engine.undo();
  assert.ok(!engine.openThreadSet.has("燕尾铜扣"), "撤销回合开启的伏笔随快照一起回退");
});

test("接生产同款 LayeredMemory 的回合:窗口记账路径不炸且摘要推进", async () => {
  // 回归:windowFor 曾在 .then 外层引用 targetState(未定义),且三元惰性求值
  // 让 duck-typed 测试替身(无 windowFor)永远踩不到——只有生产接线才炸。
  // 本测试用真正的 LayeredMemory 走 play→flushBackground 全链路。
  const memory = new LayeredMemory({
    summarizer: async ({ previous, recent }) =>
      `摘要(${(previous ?? "").length}/${recent.length})`,
  });
  const engine = new StoryEngine({
    world,
    initialState,
    llm: new MockLlm(),
    memory,
    seed: 7,
  });
  for (let index = 0; index < 6; index += 1) {
    await engine.play(startingOption);
  }
  await engine.flushBackground();
  assert.equal(engine.store.current.memorySummarizedLength, 6, "记账随回合推进");
  assert.ok(engine.store.current.chapterSummary.startsWith("摘要("), "长期摘要已写入");
});
