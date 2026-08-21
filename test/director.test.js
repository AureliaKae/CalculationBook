import assert from "node:assert/strict";
import test from "node:test";

import { MockLlm } from "../fixtures/mock-llm.js";
import { initialState, startingOption, world } from "../fixtures/world.js";
import { StoryEngine, buildContext } from "../src/engine.js";
import { restoreEngine, serializeEngine } from "../src/save-store.js";
import {
  ARC_DRIFT_INTERVAL,
  BEAT_STALL_LIMIT,
  arcBeatView,
  jumpToResolution,
  sanitizeArc,
  sanitizeDriftVerdict,
} from "../src/director.js";
import { normalizeWorld } from "../src/evolution.js";

const normalized = normalizeWorld(world);

function engineWith(llm) {
  return new StoryEngine({ world, initialState, llm, seed: 1 });
}

async function playTurns(engine, count) {
  const turns = [];
  for (let index = 0; index < count; index += 1) {
    const option = turns.length
      ? (await engine.generateOptions({ intent: "继续走这条线" })).options[0]
      : startingOption;
    turns.push(await engine.play(option));
  }
  return turns;
}

// —— 纯逻辑:sanitizeArc / arcBeatView ——

test("sanitizeArc clamps shape, keeps kinds, and guarantees a resolution beat", () => {
  const arc = sanitizeArc(
    {
      title: "  雨夜  燕尾卷 ",
      premise: "玩家要在燕尾巷立足。",
      plannedTurns: 99,
      beats: [
        { kind: "setup", aim: "规矩摆上桌" },
        { kind: "weird", aim: "奇怪 kind 落 obstacle" },
        { kind: "turn", aim: "把柄到手" },
        { kind: "", aim: "   " },
        { kind: "obstacle", aim: "再拦一道" },
      ],
    },
    { turn: 3 },
  );
  assert.equal(arc.title, "雨夜 燕尾卷");
  // 空白 aim 被丢弃:4 条有效节拍 + 补上的收束 = 5。
  assert.equal(arc.beats.length, 5);
  assert.equal(arc.beats[1].kind, "obstacle");
  assert.ok(arc.beats.at(-1).kind === "resolution");
  assert.equal(arc.startTurn, 3);
  assert.ok(arc.plannedEndTurn <= 3 + 10);
});

test("sanitizeArc rejects unusable plans", () => {
  assert.equal(sanitizeArc(null, { turn: 1 }), null);
  assert.equal(sanitizeArc({ title: "x", premise: "y", beats: [] }, { turn: 1 }), null);
  assert.equal(sanitizeArc({ title: "", premise: "y", beats: [{ kind: "setup", aim: "a" }] }, { turn: 1 }), null);
});

test("arcBeatView exposes only the current beat, never the full plan", () => {
  const arc = sanitizeArc(
    {
      title: "雨夜燕尾",
      premise: "立足燕尾巷。",
      beats: [
        { kind: "setup", aim: "a" },
        { kind: "obstacle", aim: "b" },
        { kind: "turn", aim: "c" },
        { kind: "resolution", aim: "d" },
      ],
    },
    { turn: 1 },
  );
  const view = arcBeatView(arc);
  assert.equal(view.aim, "a");
  assert.equal(view.isKey, false);
  assert.equal(view.arcAim, "立足燕尾巷。");
  assert.ok(!("title" in view));
  assert.ok(!("beats" in view));
  const turned = arcBeatView({ ...arc, currentBeatIndex: 2 });
  assert.equal(turned.isKey, true);
  assert.equal(arcBeatView(null), null);
});

test("drift verdict and jump helpers stay in enum", () => {
  assert.equal(sanitizeDriftVerdict("replace"), "replace");
  assert.equal(sanitizeDriftVerdict("adjust"), "adjust");
  assert.equal(sanitizeDriftVerdict("keep"), "keep");
  assert.equal(sanitizeDriftVerdict("nonsense"), "keep");
  const jumped = jumpToResolution(
    sanitizeArc(
      {
        title: "t",
        premise: "p",
        beats: [
          { kind: "setup", aim: "a" },
          { kind: "obstacle", aim: "b" },
          { kind: "turn", aim: "c" },
          { kind: "resolution", aim: "d" },
        ],
      },
      { turn: 1 },
    ),
  );
  assert.equal(jumped.currentBeatIndex, 3);
  assert.equal(arcBeatView(jumped).concluding, true);
});

// —— 引擎集成:规划、推进、收束、重规划 ——

test("engine plans an arc on the first turn and injects arcBeat into context", async () => {
  const llm = new MockLlm();
  const engine = engineWith(llm);
  const turn = await engine.play(startingOption);
  assert.equal(llm.arcPlans, 1);
  const arc = engine.store.current.arc;
  assert.ok(arc && Array.isArray(arc.beats) && arc.beats.length >= 4);
  // turn.context 是本回合的完整上下文:arcBeat 只带当前节拍,不带全表。
  assert.equal(turn.context.arcBeat.kind, arc.beats[0].kind);
  assert.ok(!("beats" in turn.context.arcBeat));
  assert.ok(!turn.arcRetrospective);
});

test("beats advance by model declaration and the arc concludes with a retrospective", async () => {
  const llm = new MockLlm();
  const engine = engineWith(llm);
  // mock 在偶数回合声明 beatAdvance:四节拍弧线会在若干回合内收束。
  let turns = [];
  for (let index = 0; index < 8 && !turns.some((item) => item.arcRetrospective); index += 1) {
    const option = turns.length
      ? (await engine.generateOptions({ intent: "继续走这条线" })).options[0]
      : startingOption;
    turns.push(await engine.play(option));
  }
  const concluded = turns.find((item) => item.arcRetrospective);
  assert.ok(concluded, "弧线应当收束并带回望卡");
  assert.equal(concluded.arcRetrospective.title, "雨夜燕尾");
  assert.ok(engine.store.current.arcHistory.length >= 1);
  assert.equal(engine.store.current.arc, null);
  // 收束后的下一回合重规划新弧线(四触发器之二:弧线收束→重规划)。
  const next = await engine.play(
    (await engine.generateOptions({ intent: "继续走这条线" })).options[0],
  );
  assert.equal(llm.arcPlans, 2);
  assert.ok(engine.store.current.arc);
  assert.ok(!next.arcRetrospective);
});

test("a stalled beat is force-advanced after the stall limit", async () => {
  // 模型从不声明 beatAdvance:同一节拍滞留超过上限后代码硬推进,弧线仍能收束。
  const base = new MockLlm();
  const llm = {
    generateStory: (args) => base.generateStory(args),
    generateStructure: async (args) => {
      const payload = await base.generateStructure(args);
      delete payload.beatAdvance;
      return payload;
    },
    generateArcPlan: (args) => base.generateArcPlan(args),
    checkArcDrift: (args) => base.checkArcDrift(args),
    generateArcRetrospective: (args) => base.generateArcRetrospective(args),
    checkIdentityConsistency: () => ({ ok: true, issues: [] }),
  };
  const engine = engineWith(llm);
  const turns = [];
  const limit = BEAT_STALL_LIMIT * 4 + 6;
  for (let index = 0; index < limit && !turns.some((item) => item.arcRetrospective); index += 1) {
    const option = turns.length
      ? (await engine.generateOptions({ intent: "继续走这条线" })).options[0]
      : startingOption;
    turns.push(await engine.play(option));
  }
  assert.ok(
    turns.some((item) => item.arcRetrospective),
    `滞留硬推进应当在约 ${BEAT_STALL_LIMIT + 1} 回合/节拍内走完弧线`,
  );
});

test("drift check runs every 8 turns and replace triggers replanning", async () => {
  const base = new MockLlm();
  const llm = {
    generateStory: (args) => base.generateStory(args),
    generateStructure: (args) => base.generateStructure(args),
    generateArcPlan: (args) => base.generateArcPlan(args),
    checkArcDrift: async (args) => {
      base.checkArcDrift(args);
      return { verdict: "replace", reason: "mock 换线" };
    },
    generateArcRetrospective: (args) => base.generateArcRetrospective(args),
    checkIdentityConsistency: () => ({ ok: true, issues: [] }),
  };
  const engine = engineWith(llm);
  // 第 1 回合规划;第 8 回合触发漂移检查→replace→丢弧线→同回合重规划。
  const turns = await playTurns(engine, ARC_DRIFT_INTERVAL);
  assert.equal(base.arcDriftChecks, 1);
  const arcBefore = engine.store.current.arc;
  assert.ok(arcBefore, "replace 后应当已有新弧线");
  // 重规划的弧线 startTurn 是第 8 回合。
  assert.equal(arcBefore.startTurn, ARC_DRIFT_INTERVAL);
});

test("adjust drift jumps to the resolution beat without replanning", async () => {
  const base = new MockLlm();
  let driftSeen = null;
  const llm = {
    generateStory: (args) => base.generateStory(args),
    generateStructure: async (args) => {
      const payload = await base.generateStructure(args);
      delete payload.beatAdvance;
      return payload;
    },
    generateArcPlan: (args) => base.generateArcPlan(args),
    checkArcDrift: async (args) => {
      driftSeen = args.arc;
      return { verdict: "adjust", reason: "mock 绕障" };
    },
    generateArcRetrospective: (args) => base.generateArcRetrospective(args),
    checkIdentityConsistency: () => ({ ok: true, issues: [] }),
  };
  const engine = engineWith(llm);
  const turns = await playTurns(engine, ARC_DRIFT_INTERVAL);
  const arc = engine.store.current.arc;
  if (arc) {
    // adjust 后要么已在收束节拍,要么收束节拍已被走完(收束→arcHistory)。
    const atResolution = arc.currentBeatIndex === arc.beats.length - 1;
    assert.ok(atResolution || engine.store.current.arcHistory.length >= 1);
    assert.ok(driftSeen);
  } else {
    assert.ok(engine.store.current.arcHistory.length >= 1, "弧线已收束入历史");
  }
});

test("updateGoal invalidates the arc; updateScheme does not", async () => {
  const llm = new MockLlm();
  const engine = engineWith(llm);
  await engine.play(startingOption);
  assert.ok(engine.store.current.arc);
  engine.updateScheme({ scheme: "摸清地头蛇的账本" });
  assert.equal(engine.store.current.player.scheme, "摸清地头蛇的账本");
  assert.ok(engine.store.current.arc, "改谋算不动弧线");
  const result = engine.updateGoal({ goal: "把燕尾巷的盐路握在手里" });
  assert.equal(result.goal, "把燕尾巷的盐路握在手里");
  assert.equal(engine.store.current.arc, null, "改志向作废当前弧线");
  assert.equal(
    engine.store.current.personalGoals[0].publicDirection,
    "把燕尾巷的盐路握在手里",
  );
  // 空串回落默认志向,而不是把志向清成空。
  const cleared = engine.updateGoal({ goal: "" });
  assert.equal(cleared.goal, "在这座书城活出自己的路");
});

test("engine without director methods falls back to improvised turns", async () => {
  const engine = new StoryEngine({
    world,
    initialState,
    seed: 1,
    llm: {
      async generateStory(args) {
        return new MockLlm().generateStory(args);
      },
      async generateStructure(args) {
        return new MockLlm().generateStructure(args);
      },
    },
  });
  const turn = await engine.play(startingOption);
  assert.equal(turn.number, 1);
  assert.equal(engine.store.current.arc, null);
  assert.equal(turn.context.arcBeat, null);
});

test("arc and arcHistory survive a save/load roundtrip", async () => {
  const llm = new MockLlm();
  const engine = engineWith(llm);
  const turns = [];
  for (let index = 0; index < 12 && !turns.some((item) => item.arcRetrospective); index += 1) {
    const option = turns.length
      ? (await engine.generateOptions({ intent: "继续走这条线" })).options[0]
      : startingOption;
    turns.push(await engine.play(option));
  }
  assert.ok(turns.some((item) => item.arcRetrospective), "弧线应已收束出回望卡");
  const saved = serializeEngine(engine, { bookId: "b", storyId: "s" });
  const restored = restoreEngine(engineWith(new MockLlm()), saved);
  const state = restored.store.current;
  assert.ok(state.arcHistory.length >= 1, "arcHistory 应随快照持久化");
  assert.equal(state.arcHistory.at(-1).title, "雨夜燕尾");
  if (state.arc) {
    assert.ok(Array.isArray(state.arc.beats));
    assert.equal(typeof state.arc.title, "string");
  }
});

// —— persona 注入修复:叙事上下文必须带人设卡 ——

test("buildContext carries persona cards for relevant characters", () => {
  const persona = {
    temperament: "谨慎多疑",
    motives: "想守住灯塔的秘密",
    bottomLines: "不背信",
    manner: "寡言，句短",
  };
  const doctored = normalizeWorld({
    ...world,
    characters: world.characters.map((character) =>
      character.id === "lin" ? { ...character, persona } : character,
    ),
  });
  const state = {
    ...initialState,
    player: { id: "player", name: "沈砚" },
    discoveredCharacterIds: ["lin"],
    entityStates: { lin: { status: "alive", locationId: doctored.locations[0].id } },
  };
  const context = buildContext({ world: doctored, state, history: [] });
  const lin = context.world.characters.find((character) => character.id === "lin");
  assert.ok(lin, "已发现人物应进入上下文");
  assert.deepEqual(lin.persona, persona);
});
