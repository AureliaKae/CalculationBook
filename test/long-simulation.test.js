import assert from "node:assert/strict";
import test from "node:test";

import { MockLlm } from "../fixtures/mock-llm.js";
import { initialState, startingOption, world } from "../fixtures/world.js";
import { StoryEngine } from "../src/engine.js";
import { validateGameplayState } from "../src/gameplay-systems.js";
import { restoreEngine, serializeEngine } from "../src/save-store.js";

class LongSimulationLlm extends MockLlm {
  async generateStructure(args) {
    const response = await super.generateStructure(args);
    const state = args.context.state;
    if ((state.stats.clue ?? 0) >= 10) delete response.delta.clue;
    response.systemPatches = {};
    if (state.turn === 3) {
      response.systemPatches.relationship = {
        id: "bond-create",
        readTurn: state.turn,
        bonds: [{
          id: "lin-promise",
          fromId: "player",
          toId: "lin",
          type: "promise",
          status: "active",
          known: true,
          obligations: ["查清燕尾铜扣的来历"],
        }],
      };
    }
    if (state.turn === 5) {
      response.systemPatches.faction = {
        id: "watch-duty",
        readTurn: state.turn,
        memberships: [{
          id: "watch-helper",
          factionId: "watch",
          role: "临时协助者",
          authority: ["inspect"],
          duties: [{ id: "report", text: "向守夜人报告码头异动", status: "active" }],
          overdueDutyIds: [],
        }],
      };
    }
    if (state.turn === 7) {
      response.systemPatches.survival = {
        id: "cold-warning",
        readTurn: state.turn,
        pressures: [{
          id: "cold",
          name: "失温",
          stage: "warning",
          warningObserved: true,
          responseOpportunityOffered: true,
          signs: ["手指开始僵硬"],
          publicSign: "海雾让你的手指逐渐失去知觉",
        }],
      };
    }
    return response;
  }
}

for (const seed of [7, 42, 20260811]) {
  test(`seed ${seed} remains deterministic for 100 turns`, async () => {
    const simulationWorld = {
      ...world,
      factions: [{ id: "watch", name: "守夜人", locationIds: ["旧码头"] }],
    };
    const engine = new StoryEngine({
      world: simulationWorld,
      initialState,
      llm: new LongSimulationLlm(),
      seed,
    });
    let option = startingOption;
    for (let index = 0; index < 100; index += 1) {
      const turn = await engine.play(option);
      // 普通回合不产出预设选项（拍板：选项由玩家意图动态产生）。
      assert.deepEqual(turn.options, []);
      const generated = await engine.generateOptions({ intent: "继续沿着这条线走" });
      assert.ok(generated.options.length >= 2 && generated.options.length <= 10);
      assert.equal(new Set(generated.options.map((item) => item.id)).size, generated.options.length);
      assert.equal(new Set(generated.options.map((item) => item.axis)).size, generated.options.length);
      assert.ok(generated.options.some((item) => item.axis === "exit"));
      validateGameplayState(engine.store.current, engine.world);
      for (const [id, entity] of Object.entries(engine.store.current.entityStates)) {
        if (entity.status === "dead") {
          assert.ok(
            generated.options.every(
              (candidate) =>
                candidate.target?.type !== "character" || candidate.target.id !== id,
            ),
          );
        }
      }
      option = generated.options[index % generated.options.length];
    }

    const serialized = serializeEngine(engine);
    const restored = restoreEngine(
      new StoryEngine({
        world: simulationWorld,
        initialState,
        llm: new LongSimulationLlm(),
        seed: 1,
      }),
      serialized,
    );
    assert.deepEqual(restored.store.current, engine.store.current);
    assert.deepEqual(restored.history, engine.history);

    const expected = engine.store.snapshots.at(-2);
    assert.deepEqual(engine.undo(), expected);
    assert.ok(engine.store.current.bonds.some((bond) => bond.id === "lin-promise"));
    assert.ok(
      engine.store.current.factionMemberships.some(
        (membership) => membership.id === "watch-helper",
      ),
    );
    assert.ok(
      engine.store.current.survivalPressures.some((pressure) => pressure.id === "cold"),
    );
  });
}
