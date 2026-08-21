import assert from "node:assert/strict";
import test from "node:test";

import { BakeLimiter } from "../src/bake-limiter.js";

function tick() {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

test("预算内直接放行，满了排队等释放", async () => {
  const gate = new BakeLimiter(2);
  await gate.acquire();
  await gate.acquire();
  let admitted = false;
  const waiting = gate.acquire().then(() => (admitted = true));
  await tick();
  assert.equal(admitted, false, "预算占满时应排队");
  assert.deepEqual(gate.stats(), { active: 2, budget: 2, waiting: 1 });

  gate.release();
  await waiting;
  assert.equal(admitted, true);
  assert.equal(gate.stats().active, 2, "释放一名补进一名");
});

test("扩容立即放行等待者，收缩不生效（防收缩卡死在飞请求）", async () => {
  const gate = new BakeLimiter(1);
  await gate.acquire();
  let admitted = false;
  const waiting = gate.acquire().then(() => (admitted = true));
  await tick();
  assert.equal(admitted, false);

  gate.updateBudget(4);
  await waiting;
  assert.equal(admitted, true);

  gate.updateBudget(1);
  assert.equal(gate.budget, 4, "预算只增不减");
});

test("abort 唤醒排队者：取消的等待者出列，不占名额", async () => {
  const gate = new BakeLimiter(1);
  await gate.acquire();
  const controller = new AbortController();
  const attempt = gate.acquire(controller.signal);
  await tick();
  controller.abort();
  // 原生 AbortController 的 reason 是 DOMException（AbortError），自建回退才是中文。
  await assert.rejects(attempt);
  assert.deepEqual(gate.stats(), { active: 1, budget: 1, waiting: 0 });

  // 名额没被取消者占住：下一个等待者释放后照常补进。
  let next = false;
  const second = gate.acquire().then(() => (next = true));
  gate.release();
  await second;
  assert.equal(next, true);
});

test("已 abort 的信号直接拒绝，不进队", async () => {
  const gate = new BakeLimiter(1);
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(() => gate.acquire(controller.signal));
  assert.equal(gate.stats().waiting, 0);
});

test("三本并烧共享总量：三个 job 的九路请求在预算 4 内排队", async () => {
  const gate = new BakeLimiter(4);
  let running = 0;
  let peak = 0;
  const request = async () => {
    await gate.acquire();
    running += 1;
    peak = Math.max(peak, running);
    await tick();
    running -= 1;
    gate.release();
  };
  await Promise.all(Array.from({ length: 9 }, () => request()));
  assert.equal(peak, 4, "峰值恰好等于预算，三本并烧不放大总量");
});
