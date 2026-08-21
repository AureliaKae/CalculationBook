import assert from "node:assert/strict";
import test from "node:test";

import { classifyBakeError, classifyTurnError } from "../src/bake-error.js";

test("取消不算失败，也不该给重试按钮", () => {
  const result = classifyBakeError({ name: "BakeCancelledError", message: "烧制已取消" });
  assert.equal(result.kind, "cancelled");
  assert.equal(result.retryable, false);
});

test("缺凭证要指向设置，重试无意义", () => {
  const result = classifyBakeError({
    message: "请先在设置里为快模型选择一条填好 Key 的 API 凭证",
  });
  assert.equal(result.kind, "credentials");
  assert.equal(result.retryable, false);
});

test("按状态码区分鉴权、限流与服务端故障", () => {
  assert.equal(classifyBakeError({ status: 401 }).kind, "auth");
  assert.equal(classifyBakeError({ status: 401 }).retryable, false);

  const throttled = classifyBakeError({ status: 429, message: "Model API 429: rate limit" });
  assert.equal(throttled.kind, "quota");
  assert.equal(throttled.retryable, true);

  const drained = classifyBakeError({ status: 429, message: "Model API 429: insufficient_quota" });
  assert.equal(drained.kind, "quota");
  assert.equal(drained.retryable, false);

  const broken = classifyBakeError({ status: 503, message: "Model API 503: bad gateway" });
  assert.equal(broken.kind, "server");
  assert.equal(broken.retryable, true);
  assert.match(broken.title, /503/);
});

test("网络与修复失败都可以重试", () => {
  assert.equal(classifyBakeError({ name: "TypeError", message: "fetch failed" }).kind, "network");
  assert.equal(classifyBakeError({ name: "WorldRepairError" }).kind, "repair");
  assert.equal(classifyBakeError({ name: "WorldRepairError" }).retryable, true);
});

test("认不出来的错误保留原文并允许重试", () => {
  const result = classifyBakeError({ name: "Error", message: "JSON 解析失败" });
  assert.equal(result.kind, "unknown");
  assert.equal(result.advice, "JSON 解析失败");
  assert.equal(result.retryable, true);
});

test("空参数也不抛异常", () => {
  assert.equal(classifyBakeError().kind, "unknown");
});

test("402 余额用尽不可重试,提示充值或换凭证", () => {
  const result = classifyBakeError({ status: 402, message: "Model API 402: Insufficient Balance" });
  assert.equal(result.kind, "balance");
  assert.equal(result.retryable, false);
  assert.match(result.advice, /充值/);
});

test("回合错误分类:模型错误给友好文案,业务错误返回 null", () => {
  const balance = classifyTurnError({ status: 402, message: "Model API 402: Insufficient Balance" });
  assert.equal(balance.title, "这条凭证的余额用完了");
  assert.equal(balance.retryable, false);

  const abort = classifyTurnError({ name: "AbortError", message: "aborted" });
  assert.match(abort.title, /已停下这一回合/);
  assert.equal(abort.retryable, true);

  const network = classifyTurnError({ name: "TypeError", message: "fetch failed" });
  assert.match(network.title, /没能连上接口/);

  const auth = classifyTurnError({ status: 401, message: "Model API 401" });
  assert.match(auth.title, /接口拒绝了这把 Key/);
  assert.equal(auth.retryable, false);

  // 普通业务错误不套「这一回合」的帽子,调用方回退原文。
  assert.equal(classifyTurnError(new Error("这本书没有可以接着读的进度")), null);
  assert.equal(classifyTurnError({ name: "Error", message: "请先从书架选择一本小说" }), null);
});
