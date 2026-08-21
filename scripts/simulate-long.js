// 长局模拟（第二轮打磨拍板 2026-08-21：叙事质量主轴）。
//
// 固定种子 MockLlm 跑多世长局，采集回归指标（进 npm test 防退化）；
// `--live` 接真 API 供人工抽读（DEEPSEEK_API_KEY / QWEN_API_KEY 环境变量）。
//
// 指标口径：
//   - 错误率：任何一回合抛错记一次并停止当世（引擎侧回归的第一信号）；
//   - 回合时长分布：p50/p95/max——引擎每回合成本随手数增长（长局退化）在此现形；
//   - 叙事健康：非空率、连续整段字面重复次数（mock 下重复模板句是常态，
//     但整段与上一手完全相同=合成回归）、平均字数（live 模式看叙事密度）；
//   - 转世链：pastLife 事实入世界档案、世界对象跨世同一引用延续；
//   - 存档往返：每世结束 serializeEngine → restoreEngine 成活（长局可存可续）。
import { randomUUID } from "node:crypto";
import { performance } from "node:perf_hooks";
import { pathToFileURL } from "node:url";

import { MockLlm } from "../fixtures/mock-llm.js";
import { initialState, startingOption, world as seedWorld } from "../fixtures/world.js";
import { StoryEngine } from "../src/engine.js";
import { createPlayerState } from "../src/evolution.js";
import { createSuccessorState, pastLifeFact } from "../src/gameplay-systems.js";
import { restoreEngine, serializeEngine } from "../src/save-store.js";

const percentile = (sorted, ratio) => {
  if (!sorted.length) return 0;
  const index = Math.min(sorted.length - 1, Math.floor(ratio * sorted.length));
  return sorted[index];
};

export async function runLongSimulation({ lives = 3, turnsPerLife = 60, llm, seed = 20260821 } = {}) {
  const engineLlm = llm ?? new MockLlm();
  // 世界对象跨世同一引用：转世链的「世界延续」由它物理承载。
  const world = structuredClone(seedWorld);
  const metrics = {
    lives,
    turnsPerLife,
    completedTurns: 0,
    errors: [],
    durations: [],
    narrativeChars: [],
    duplicateNarratives: 0,
    emptyNarratives: 0,
    pastLifeFacts: 0,
    worldPersisted: true,
    savesRoundTripped: 0,
    finalLifeIndex: 1,
  };

  let state = structuredClone(initialState);
  let option = { ...startingOption };

  for (let life = 1; life <= lives; life += 1) {
    const engine = new StoryEngine({
      world,
      initialState: structuredClone(state),
      llm: engineLlm,
      seed: seed + life,
    });
    let previousNarrative = "";
    for (let index = 0; index < turnsPerLife; index += 1) {
      const startedAt = performance.now();
      try {
        const turn = await engine.play(option);
        metrics.durations.push(performance.now() - startedAt);
        metrics.completedTurns += 1;
        const narrative = String(turn.narrative ?? "");
        if (!narrative.trim()) metrics.emptyNarratives += 1;
        if (narrative && narrative === previousNarrative) metrics.duplicateNarratives += 1;
        metrics.narrativeChars.push([...narrative].length);
        previousNarrative = narrative;
        // 挑一条非观望解法保持故事向前（mock 的 exit 轴只在无路时兜底）。
        const candidates = turn.options ?? [];
        option = candidates.find((item) => item?.axis !== "exit") ?? candidates[0] ?? option;
      } catch (error) {
        metrics.errors.push({ life, turn: index + 1, message: String(error?.message ?? error) });
        break;
      }
    }

    // 存档往返：长局的档要能存也能复活。
    try {
      const saved = serializeEngine(engine, { bookId: "longrun" });
      const revived = new StoryEngine({
        world,
        initialState: saved.snapshots[0],
        llm: engineLlm,
        seed,
      });
      restoreEngine(revived, saved);
      metrics.savesRoundTripped += 1;
    } catch (error) {
      metrics.errors.push({ life, phase: "save-roundtrip", message: String(error?.message ?? error) });
    }

    if (life === lives) {
      metrics.finalLifeIndex = engine.store.current.player?.lifeIndex ?? 1;
      break;
    }

    // 转世：优先采用自然死亡记录，否则以模拟死因收卷（长局模拟不追求真死，
    // 只驱动「前世事实入档 → 世界延续 → 新一世开局」整条链）。
    const lastDeath = engine.history.at(-1)?.death;
    const death = lastDeath?.dead ? lastDeath : { dead: true, cause: "灯油耗尽（长局模拟收卷）" };
    const fact = pastLifeFact(engine.store.current, death, randomUUID().slice(0, 8));
    if (!world.facts.some((existing) => existing.id === fact.id)) {
      world.facts = [...world.facts, fact];
      metrics.pastLifeFacts += 1;
    }
    const successor = createSuccessorState(
      engine.store.current,
      createPlayerState(world, {
        name: `拾遗人${life + 1}`,
        locationId: "旧码头",
        motivation: "接着前人没走完的路",
      }),
      world,
    );
    // createPlayerState 不带初始数值（真流程由书册 initialState 合入）：
    // 这里以固定初值开局，数值校验才过得了。
    successor.stats = { ...initialState.stats };
    successor.attributes = { ...initialState.attributes };
    state = successor;
    option = { ...startingOption };
  }

  const sorted = [...metrics.durations].sort((left, right) => left - right);
  metrics.durationMs = {
    p50: Math.round(percentile(sorted, 0.5)),
    p95: Math.round(percentile(sorted, 0.95)),
    max: Math.round(sorted.at(-1) ?? 0),
    total: Math.round(metrics.durations.reduce((sum, value) => sum + value, 0)),
  };
  metrics.meanNarrativeChars = metrics.narrativeChars.length
    ? Math.round(metrics.narrativeChars.reduce((sum, value) => sum + value, 0) / metrics.narrativeChars.length)
    : 0;
  return metrics;
}

function printReport(metrics) {
  const lines = [
    `世数 ${metrics.lives} × 每世上限 ${metrics.turnsPerLife}｜完成 ${metrics.completedTurns} 回合`,
    `错误 ${metrics.errors.length}${metrics.errors.length ? "：" + JSON.stringify(metrics.errors) : ""}`,
    `回合时长 p50/p95/max：${metrics.durationMs.p50}/${metrics.durationMs.p95}/${metrics.durationMs.max} ms（合计 ${metrics.durationMs.total} ms）`,
    `叙事：均长 ${metrics.meanNarrativeChars} 字｜空段 ${metrics.emptyNarratives}｜连续重复 ${metrics.duplicateNarratives}`,
    `转世：pastLife 事实 ${metrics.pastLifeFacts} 条｜存档往返 ${metrics.savesRoundTripped}/${metrics.lives}｜末世 lifeIndex ${metrics.finalLifeIndex}`,
  ];
  console.log(lines.join("\n"));
}

async function buildLiveClient() {
  const { OpenAiCompatibleClient } = await import("../src/openai-client.js");
  const qwen = Boolean(process.env.QWEN_API_KEY);
  const apiKey = process.env.DEEPSEEK_API_KEY ?? process.env.QWEN_API_KEY;
  if (!apiKey) {
    console.error("--live 需要 DEEPSEEK_API_KEY 或 QWEN_API_KEY 环境变量。");
    process.exit(2);
  }
  const baseUrl = qwen
    ? "https://dashscope.aliyuncs.com/compatible-mode/v1"
    : "https://api.deepseek.com";
  const strongModel = qwen ? (process.env.QWEN_MODEL ?? "qwen-plus") : (process.env.DEEPSEEK_MODEL ?? "deepseek-chat");
  const fastModel = qwen ? (process.env.QWEN_FAST_MODEL ?? "qwen-turbo") : (process.env.DEEPSEEK_FAST_MODEL ?? strongModel);
  const slot = (model, thinking) => ({
    baseUrl,
    apiKey,
    model,
    temperature: 0.2,
    thinking,
    slot: "fast",
  });
  return new OpenAiCompatibleClient({
    config: {
      fast: slot(fastModel, false),
      strong: { ...slot(strongModel, true), slot: "strong" },
      maxTokens: "",
      strongTimeoutMs: 180_000,
    },
  });
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  const lives = Number(process.env.LIVES ?? 3);
  const turnsPerLife = Number(process.env.TURNS ?? 60);
  const llm = process.argv.includes("--live") ? await buildLiveClient() : undefined;
  const metrics = await runLongSimulation({ lives, turnsPerLife, llm });
  printReport(metrics);
  process.exitCode = metrics.errors.length ? 1 : 0;
}
