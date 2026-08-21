import { MockLlm } from "../fixtures/mock-llm.js";
import { initialState, startingOption, world } from "../fixtures/world.js";
import { StoryEngine } from "../src/engine.js";

// fixture 是模块级共享对象：先克隆再用，脚本间不会互相污染。
const engine = new StoryEngine({
  world: structuredClone(world),
  initialState: structuredClone(initialState),
  llm: new MockLlm(),
  seed: 20260810,
});

let option = startingOption;
for (let index = 0; index < 20; index += 1) {
  const turn = await engine.play(option);
  console.log(`${turn.number.toString().padStart(2, "0")} | ${turn.narrative}`);
  option = turn.options[index % turn.options.length];
}

console.log(`\n完成 ${engine.history.length} 回合，重写 ${engine.rewriteCount} 次。`);
