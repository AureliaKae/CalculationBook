import assert from "node:assert/strict";
import test from "node:test";

import { KeyedSingleFlight } from "../src/keyed-single-flight.js";

test("同键并发只跑一个,后到的跳过并拿到 skipped 标记", async () => {
  const guard = new KeyedSingleFlight();
  let running = 0;
  let peak = 0;
  const task = async () => {
    running += 1;
    peak = Math.max(peak, running);
    await new Promise((resolve) => setTimeout(resolve, 20));
    running -= 1;
    return "done";
  };
  const [first, second] = await Promise.all([
    guard.run("book-a", task),
    guard.run("book-a", task),
  ]);
  assert.equal(first.skipped, false);
  assert.equal(first.value, "done");
  assert.equal(second.skipped, true, "同键第二个调用被跳过");
  assert.equal(peak, 1, "同键任务从不并发");
});

test("不同键互不阻塞", async () => {
  const guard = new KeyedSingleFlight();
  let running = 0;
  let peak = 0;
  const task = async () => {
    running += 1;
    peak = Math.max(peak, running);
    await new Promise((resolve) => setTimeout(resolve, 20));
    running -= 1;
  };
  await Promise.all([guard.run("a", task), guard.run("b", task)]);
  assert.equal(peak, 2, "不同键可以并发");
});

test("任务失败后键被释放,可再次执行", async () => {
  const guard = new KeyedSingleFlight();
  let attempts = 0;
  const bump = async () => {
    attempts += 1;
    return "ok";
  };
  await assert.rejects(() =>
    guard.run("k", async () => {
      attempts += 1;
      throw new Error("boom");
    }),
  );
  const retry = await guard.run("k", bump);
  assert.equal(retry.skipped, false);
  assert.equal(retry.value, "ok");
  assert.equal(attempts, 2, "失败释放键后第二次真的执行了");
});
