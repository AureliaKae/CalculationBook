import assert from "node:assert/strict";
import test from "node:test";

import { MockLlm } from "../fixtures/mock-llm.js";
import { initialState, startingOption, world } from "../fixtures/world.js";
import { StoryEngine, styleParagraphs } from "../src/engine.js";

const CHAPTERS = [
  {
    index: 1,
    title: "一",
    text: `旧码头的黑铃在雾里悬着，铁锈顺着绳结往下淌。${"沈砚数着自己的呼吸，一下，又一下。".repeat(12)}`,
  },
  {
    index: 9,
    title: "九",
    text: `灯塔地窖的门缝里透出咸腥的风。${"他记起那半枚燕尾铜扣的凉。".repeat(12)}`,
  },
];

test("style paragraphs are chunked and chapter anchored", () => {
  const passages = styleParagraphs(CHAPTERS);
  assert.ok(passages.length >= 2);
  assert.ok(passages.every((passage) => passage.text.length <= 400));
  assert.deepEqual([...new Set(passages.map((passage) => passage.chapterAnchor))], [1, 9]);
});

test("engine injects original prose samples across the whole book (no chapter gating)", async () => {
  const engine = new StoryEngine({
    world,
    initialState,
    llm: new MockLlm(),
    sourceChapters: CHAPTERS,
  });
  const turn = await engine.play(startingOption);
  assert.ok(turn.context.styleSamples.length > 0);
  // 拍板 2026-08-17：玩家已读完小说，未解锁章节一律不过滤——
  // 文风样本可来自全书（第 9 章的灯塔地窖段落不再被章节门槛拦下）。
  assert.ok(
    turn.context.styleSamples.some(
      (sample) => sample.includes("码头") || sample.includes("沈砚"),
    ),
  );
  const later = engine.styleSamplesFor({ query: "灯塔地窖 燕尾铜扣" });
  assert.ok(later.some((sample) => sample.includes("灯塔地窖")), "未来章节样本可被召回");
});

test("retrieval keywords accumulate across the last three turns", async () => {
  let turnIndex = 0;
  const llm = {
    async generateStory(args) {
      return new MockLlm().generateStory(args);
    },
    async generateStructure(args) {
      turnIndex += 1;
      const response = await new MockLlm().generate(args);
      return { ...response, retrievalKeywords: [`词${turnIndex}`] };
    },
  };
  const engine = new StoryEngine({ world, initialState, llm });
  let option = startingOption;
  for (let index = 0; index < 4; index += 1) {
    const turn = await engine.play(option);
    // 普通回合不产出预设选项；下一步选项由意图生成（本 llm 无 generateIntentOptions，
    // 走兜底选项，仍足以继续推演）。
    option = (await engine.generateOptions({ intent: "继续" })).options[0];
  }
  assert.deepEqual(engine.store.current.retrievalKeywords, ["词2", "词3", "词4"]);
});
