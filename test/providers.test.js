import assert from "node:assert/strict";
import test from "node:test";

import {
  DEEPSEEK_BASE_URL,
  isDeepSeekBaseUrl,
  isKnownProviderBaseUrl,
  isQwenBaseUrl,
  normalizeThinking,
  outputLimitParamFor,
  providerLabel,
  recommendedBakeConcurrency,
  recommendedModelsFor,
  supportsThinking,
} from "../src/providers.js";

test("DeepSeek 地址识别与默认地址", () => {
  assert.equal(DEEPSEEK_BASE_URL, "https://api.deepseek.com");
  assert.equal(isDeepSeekBaseUrl("https://api.deepseek.com"), true);
  assert.equal(isDeepSeekBaseUrl("https://api.deepseek.com/v1"), true);
  assert.equal(isDeepSeekBaseUrl("https://deepseek.com"), true);
  assert.equal(isDeepSeekBaseUrl("https://api.openai.com"), false);
  assert.equal(isDeepSeekBaseUrl("https://dashscope.aliyuncs.com/compatible-mode/v1"), false);
  assert.equal(isDeepSeekBaseUrl(""), false);
});

test("思考白名单:V4/reasoner/chat 系才发思考参数", () => {
  assert.equal(supportsThinking("deepseek-v4-pro"), true);
  assert.equal(supportsThinking("deepseek-v4-flash"), true);
  assert.equal(supportsThinking("deepseek-reasoner"), true);
  assert.equal(supportsThinking("deepseek-chat"), true);
  assert.equal(supportsThinking("deepseek-v3"), false);
  assert.equal(supportsThinking(""), false);
});

test("强槽开思考:reasoning_effort=high 且请求体剥离 temperature/max_tokens", () => {
  assert.deepEqual(
    normalizeThinking({
      baseUrl: "https://api.deepseek.com",
      thinking: true,
      slot: "strong",
      model: "deepseek-v4-pro",
    }),
    { params: { reasoning_effort: "high" }, thinkingActive: true },
  );
});

test("快槽开思考:reasoning_effort=low", () => {
  assert.deepEqual(
    normalizeThinking({
      baseUrl: "https://api.deepseek.com",
      thinking: true,
      slot: "fast",
      model: "deepseek-v4-flash",
    }),
    { params: { reasoning_effort: "low" }, thinkingActive: true },
  );
});

test("关思考注入 disabled,未指定走默认,白名单外静默失效", () => {
  assert.deepEqual(
    normalizeThinking({
      baseUrl: "https://api.deepseek.com",
      thinking: false,
      slot: "fast",
      model: "deepseek-reasoner",
    }),
    { params: { thinking: { type: "disabled" } }, thinkingActive: false },
  );
  // 未指定 thinking:不发参数,走 DeepSeek 默认行为。
  assert.deepEqual(
    normalizeThinking({
      baseUrl: "https://api.deepseek.com",
      thinking: undefined,
      slot: "strong",
      model: "deepseek-v4-pro",
    }),
    { params: {}, thinkingActive: false },
  );
  // 白名单之外的模型:开关静默失效,不发参数、不报错。
  assert.deepEqual(
    normalizeThinking({
      baseUrl: "https://api.deepseek.com",
      thinking: true,
      slot: "strong",
      model: "deepseek-v3",
    }),
    { params: {}, thinkingActive: false },
  );
  assert.deepEqual(
    normalizeThinking({
      baseUrl: "https://api.deepseek.com",
      thinking: false,
      slot: "fast",
      model: "deepseek-v3",
    }),
    { params: {}, thinkingActive: false },
  );
});

test("非 DeepSeek 地址不发任何厂商参数(客户端保持通用兼容)", () => {
  assert.deepEqual(
    normalizeThinking({
      baseUrl: "https://example.test",
      thinking: true,
      slot: "strong",
      model: "deepseek-v4-pro",
    }),
    { params: {}, thinkingActive: false },
  );
});

test("千问地址识别:dashscope 与业务空间专属域名都算阿里千问", () => {
  assert.equal(isQwenBaseUrl("https://dashscope.aliyuncs.com/compatible-mode/v1"), true);
  assert.equal(isQwenBaseUrl("https://dashscope-us.aliyuncs.com/compatible-mode/v1"), true);
  assert.equal(
    isQwenBaseUrl("https://ws123.cn-beijing.maas.aliyuncs.com/compatible-mode/v1"),
    true,
  );
  assert.equal(isQwenBaseUrl("https://api.deepseek.com"), false);
  assert.equal(isQwenBaseUrl("https://aliyuncs.com.evil.test"), false);
  assert.equal(isKnownProviderBaseUrl("https://dashscope.aliyuncs.com/compatible-mode/v1"), true);
  assert.equal(isKnownProviderBaseUrl("https://api.deepseek.com"), true);
});

test("多厂商注册表:收录地址识别与代选,伪装域名不认", () => {
  assert.equal(isKnownProviderBaseUrl("https://api.openai.com/v1"), true);
  assert.equal(isKnownProviderBaseUrl("https://api.moonshot.cn/v1"), true);
  assert.equal(isKnownProviderBaseUrl("https://open.bigmodel.cn/api/paas/v4"), true);
  assert.equal(isKnownProviderBaseUrl("https://api.siliconflow.cn/v1"), true);
  assert.equal(isKnownProviderBaseUrl("https://api.example.com/v1"), false);
  // 点边界防伪装:注册表后缀拼在别的域名里不认。
  assert.equal(isKnownProviderBaseUrl("https://openai.com.evil.test/v1"), false);
  assert.equal(isKnownProviderBaseUrl("https://moonshot.cn.evil.test/v1"), false);

  assert.equal(providerLabel("https://api.moonshot.cn/v1"), "月之暗面 Kimi");
  assert.equal(providerLabel("https://open.bigmodel.cn/api/paas/v4"), "智谱 GLM");
  assert.equal(recommendedModelsFor("https://api.moonshot.cn/v1").fast, "kimi-k2-turbo-preview");
  assert.equal(recommendedModelsFor("https://open.bigmodel.cn/api/paas/v4").strong, "glm-4.6");
  assert.equal(recommendedModelsFor("https://api.siliconflow.cn/v1"), null, "硅基流动不代选");
  assert.equal(recommendedBakeConcurrency("https://api.openai.com/v1"), 3);
  assert.equal(recommendedBakeConcurrency("https://api.deepseek.com"), 4);
});

test("OpenAI 思考参数:推理系发 reasoning_effort,普通模型静默不发", () => {
  const base = "https://api.openai.com/v1";
  assert.deepEqual(
    normalizeThinking({ baseUrl: base, thinking: true, slot: "strong", model: "o3" }),
    { params: { reasoning_effort: "high" }, thinkingActive: true },
  );
  assert.deepEqual(
    normalizeThinking({ baseUrl: base, thinking: true, slot: "fast", model: "gpt-4.1-mini" }),
    { params: {}, thinkingActive: false },
  );
  // OpenAI 没有需要关的默认思维链,关思考不发参数。
  assert.deepEqual(
    normalizeThinking({ baseUrl: base, thinking: false, slot: "fast", model: "o4-mini" }),
    { params: {}, thinkingActive: false },
  );
});

test("未登记思考语义的厂商:开关开了也不发任何厂商参数", () => {
  assert.deepEqual(
    normalizeThinking({ baseUrl: "https://api.moonshot.cn/v1", thinking: true, slot: "strong", model: "kimi-k2-0711-preview" }),
    { params: {}, thinkingActive: false },
  );
  assert.deepEqual(
    normalizeThinking({ baseUrl: "https://api.siliconflow.cn/v1", thinking: true, slot: "strong", model: "deepseek-ai/DeepSeek-V3" }),
    { params: {}, thinkingActive: false },
  );
});

test("输出上限参数名按厂商:千问 max_completion_tokens,DeepSeek max_tokens", () => {
  assert.equal(outputLimitParamFor("https://dashscope.aliyuncs.com/compatible-mode/v1"), "max_completion_tokens");
  assert.equal(outputLimitParamFor("https://api.deepseek.com"), "max_tokens");
});

test("千问思考参数:qwen3 系发 enable_thinking,其余 qwen 静默不发", () => {
  const base = "https://dashscope.aliyuncs.com/compatible-mode/v1";
  // 开思考:enable_thinking=true,且 thinkingActive 剥离 temperature/max_tokens。
  assert.deepEqual(
    normalizeThinking({ baseUrl: base, thinking: true, slot: "strong", model: "qwen3-max" }),
    { params: { enable_thinking: true }, thinkingActive: true },
  );
  // 关思考:enable_thinking=false(qwen3 开源系默认开,关掉省时)。
  assert.deepEqual(
    normalizeThinking({ baseUrl: base, thinking: false, slot: "fast", model: "qwen3-235b-a22b" }),
    { params: { enable_thinking: false }, thinkingActive: false },
  );
  // 未指定:不发参数。
  assert.deepEqual(
    normalizeThinking({ baseUrl: base, thinking: undefined, slot: "fast", model: "qwen3-max" }),
    { params: {}, thinkingActive: false },
  );
  // 非 qwen3 模型:静默不发(发错参数会吃 400)。
  assert.deepEqual(
    normalizeThinking({ baseUrl: base, thinking: true, slot: "fast", model: "qwen-turbo" }),
    { params: {}, thinkingActive: false },
  );
  // DeepSeek 模型名配千问地址:不混发 DeepSeek 参数。
  assert.deepEqual(
    normalizeThinking({ baseUrl: base, thinking: true, slot: "fast", model: "deepseek-v4-pro" }),
    { params: {}, thinkingActive: false },
  );
});

test("首配推荐笔杆:两家按槽位给默认模型,未知厂商不代选", () => {
  const qwen = recommendedModelsFor("https://dashscope.aliyuncs.com/compatible-mode/v1");
  assert.equal(recommendedModelsFor("https://api.deepseek.com").fast, "deepseek-chat");
  assert.equal(recommendedModelsFor("https://api.deepseek.com").strong, "deepseek-chat");
  assert.equal(qwen.fast, "qwen-turbo");
  assert.equal(qwen.strong, "qwen-plus");
  assert.equal(recommendedModelsFor("http://localhost:11434/v1"), null, "本机调试地址不代选");
});
