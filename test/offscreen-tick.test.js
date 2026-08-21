import test from "node:test";
import assert from "node:assert/strict";
import { offscreenLocationTick } from "../src/engine.js";

// 世界时间 48 小时为一格，每个角色带自己的错峰偏移（hash 作起始时刻）。
const world = {
  characters: [
    { id: "a", name: "甲", locationIds: ["north", "south"], status: "active" },
    { id: "b", name: "乙", locationIds: ["north"], status: "active" },
    { id: "c", name: "丙", locationIds: ["east", "west"], status: "dead" },
  ],
};

test("offscreen tick moves remote characters deterministically", () => {
  const state = {
    turn: 10,
    worldTime: 100_000,
    locationId: "home",
    entityStates: {
      a: { status: "active", factionId: null, locationId: "north" },
      b: { status: "active", factionId: null, locationId: "north" },
      c: { status: "dead", factionId: null, locationId: "east" },
    },
  };
  const once = offscreenLocationTick(state, world, new Set());
  const twice = offscreenLocationTick(state, world, new Set());
  // 确定性：同一状态永远漂出同一位置。
  assert.deepEqual(once.entityStates, twice.entityStates);
  // a 有两个惯常地点，只能在其中轮换；b 只有一个地点不动；c 已死不漂移。
  assert.ok(["north", "south"].includes(once.entityStates.a.locationId));
  assert.equal(once.entityStates.b.locationId, "north");
  assert.equal(once.entityStates.c.locationId, "east");
  // 换一个世界时间格：位置若变化，则记录 lastSeenTurn。
  const later = offscreenLocationTick(
    { ...state, worldTime: state.worldTime + 2 * 2880 },
    world,
    new Set(),
  );
  if (later.entityStates.a.locationId !== once.entityStates.a.locationId) {
    assert.equal(later.entityStates.a.lastSeenTurn, state.turn);
  }
});

test("offscreen tick leaves on-screen and co-located characters alone", () => {
  const state = {
    turn: 10,
    worldTime: 100_000,
    locationId: "north",
    entityStates: {
      a: { status: "active", factionId: null, locationId: "north" },
    },
  };
  // 行动对象不漂移。
  const targeted = offscreenLocationTick(state, world, new Set(["a"]));
  assert.equal(targeted.entityStates.a.locationId, "north");
  // 与玩家同地的角色即使不在目标集合里也不漂移。
  const colocated = offscreenLocationTick(state, world, new Set());
  assert.equal(colocated.entityStates.a.locationId, "north");
});

test("offscreen tick is a no-op before the first stagger boundary", () => {
  const state = {
    turn: 1,
    worldTime: 0,
    locationId: "home",
    entityStates: {
      a: { status: "active", factionId: null, locationId: "north" },
    },
  };
  // worldTime 0 时任何角色的错峰偏移都凑不满一格：tickIndex 必 < 1，不漂移。
  const next = offscreenLocationTick(state, world, new Set());
  assert.equal(next.entityStates.a.locationId, "north");
});

test("offscreen tick does not mutate the input state when nothing moves", () => {
  const state = {
    turn: 1,
    worldTime: 0,
    locationId: "home",
    entityStates: {
      b: { status: "active", factionId: null, locationId: "north" },
    },
  };
  const next = offscreenLocationTick(state, world, new Set());
  assert.equal(next, state);
});
