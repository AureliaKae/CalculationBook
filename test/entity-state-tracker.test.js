import assert from "node:assert/strict";
import test from "node:test";

import { EntityStateTracker } from "../src/entity-state-tracker.js";

const world = {
  characters: [
    { id: "lin", name: "林雾", summary: "灯塔看守", persona: { temperament: "谨慎", manner: "话少" } },
    { id: "captain", name: "闻舟", summary: "船长" },
    { id: "doctor", name: "顾青", summary: "医师" },
    { id: "warden", name: "阎策", summary: "狱吏" },
  ],
  locations: [{ id: "dock", name: "旧码头" }, { id: "lighthouse", name: "灯塔" }],
};

function baseState() {
  return {
    turn: 6,
    locationId: "dock",
    entityStates: {
      lin: { locationId: "dock", status: "active" },
      captain: { locationId: "lighthouse", status: "active" },
      doctor: { locationId: "lighthouse", status: "dead" },
    },
    entityStateNotes: { lin: { note: "在灯塔养伤", turn: 1 } },
  };
}

test("候选人物：在场优先，近两回合行动对象入选，死者默认排除", () => {
  const tracker = new EntityStateTracker({ completeJson: async () => ({}) });
  const history = [
    { number: 5, choice: { target: { type: "character", id: "warden" } } },
    { number: 6, choice: {} },
  ];
  const candidates = tracker.candidates(world, baseState(), history);
  assert.deepEqual(candidates.map((character) => character.id), ["lin", "warden"]);
  // doctor 已死且未被指向：排除。
  const withoutTarget = tracker.candidates(world, baseState(), []);
  assert.deepEqual(withoutTarget.map((character) => character.id), ["lin"]);
});

test("update 只收已知人物、清洗笔记，并把旧笔记与近期演出喂给模型", async () => {
  let seen;
  const tracker = new EntityStateTracker({
    completeJson: async (messages) => {
      seen = messages;
      return {
        states: [
          { characterId: "lin", note: "在旧码头\u0000与玩家结盟，伤愈" },
          { characterId: "unknown-id", note: "不在清单里的人物" },
          { characterId: "warden", note: "短" },
        ],
      };
    },
  });
  const history = [
    { number: 5, choice: { text: "向狱吏打听" }, narrative: "阎策盯着来人。".repeat(20) },
    { number: 6, choice: { text: "与林雾结盟" }, narrative: "林雾点了头。".repeat(20) },
  ];
  const { notes } = await tracker.update({ world, state: baseState(), history });
  assert.deepEqual(Object.keys(notes), ["lin"]);
  // 控制字符在压空白之前被整段剔除，不会留下空格残渣。
  assert.equal(notes.lin.note, "在旧码头与玩家结盟，伤愈");
  assert.equal(notes.lin.turn, 6);
  // 载荷带上旧笔记与人物档案，模型才能「沿用要点」而不是每次从零猜。
  const payload = JSON.parse(seen.at(-1).content);
  const lin = payload.characters.find((character) => character.characterId === "lin");
  assert.equal(lin.priorNote, "在灯塔养伤");
  assert.equal(lin.persona.temperament, "谨慎");
  assert.equal(lin.locationName, "旧码头");
  assert.ok(payload.recentTurns.length === 2);
});

test("构造缺 completeJson 直接抛错", () => {
  assert.throws(() => new EntityStateTracker({}), /completeJson/);
});
