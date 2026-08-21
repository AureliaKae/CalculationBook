import test from "node:test";
import assert from "node:assert/strict";
import {
  enterInteractive,
  exitInteractive,
  interactiveActive,
  waitForInteractiveIdle,
} from "../src/request-priority.js";

test("idle 时立即放行", async () => {
  await waitForInteractiveIdle();
  assert.equal(interactiveActive(), false);
});

test("交互在途时后台等待,退出后放行", async () => {
  enterInteractive();
  let resolved = false;
  const waiting = waitForInteractiveIdle().then(() => {
    resolved = true;
  });
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(resolved, false);
  exitInteractive();
  await waiting;
  assert.equal(resolved, true);
  assert.equal(interactiveActive(), false);
});

test("嵌套进入只认最后一次退出", async () => {
  enterInteractive();
  enterInteractive();
  exitInteractive();
  assert.equal(interactiveActive(), true);
  exitInteractive();
  assert.equal(interactiveActive(), false);
});

test("多个后台等待者同批放行", async () => {
  enterInteractive();
  let first = false;
  let second = false;
  const a = waitForInteractiveIdle().then(() => {
    first = true;
  });
  const b = waitForInteractiveIdle().then(() => {
    second = true;
  });
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(first, false);
  assert.equal(second, false);
  exitInteractive();
  await Promise.all([a, b]);
  assert.equal(first, true);
  assert.equal(second, true);
});

test("信号中止立即放行(调用方随后因同一信号失败)", async () => {
  const controller = new AbortController();
  enterInteractive();
  const waiting = waitForInteractiveIdle({ signal: controller.signal });
  controller.abort();
  await waiting;
  exitInteractive();
  assert.equal(interactiveActive(), false);
});

test("已经中止的信号在交互中直接放行", async () => {
  const controller = new AbortController();
  controller.abort();
  enterInteractive();
  await waitForInteractiveIdle({ signal: controller.signal });
  exitInteractive();
});
