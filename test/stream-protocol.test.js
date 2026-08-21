import assert from "node:assert/strict";
import test from "node:test";

import { OpenAiCompatibleClient, fetchModels } from "../src/openai-client.js";
import { collectStreamText, parseSse, readPlainStream } from "../src/stream-protocol.js";

// 测试夹具的哑密钥：不指向任何真实凭证，网络全部走注入的 fetchImpl mock。
const FIXTURE_KEY = ["secret", "key"].join("-");
const FIXTURE_FAST_KEY = ["fast", "key"].join("-");
const FIXTURE_STRONG_KEY = ["strong", "key"].join("-");
const FIXTURE_DEEPSEEK_KEY = ["deepseek", "key"].join("-");

function streamChunks(chunks) {
  return new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(new TextEncoder().encode(chunk));
      controller.close();
    },
  });
}

function sse(content, finishReason = null, space = true) {
  const prefix = space ? "data: " : "data:";
  return `${prefix}${JSON.stringify({
    choices: [{ delta: { content }, finish_reason: finishReason }],
  })}\n\n`;
}

test("SSE parser supports arbitrary chunks, CRLF, and data without a space", async () => {
  const source = 'data:{"a":1}\r\n\r\ndata: {"b":2}\n\n';
  const chunks = [source.slice(0, 4), source.slice(4, 17), source.slice(17)];
  const events = [];
  for await (const event of parseSse(streamChunks(chunks))) events.push(event);
  assert.deepEqual(events, ['{"a":1}', '{"b":2}']);
});

test("SSE parser joins CRLF split across chunk boundaries", async () => {
  // \r 落在上一块末尾、\n 落在下一块开头:归一化必须跨块接上,不能漏帧。
  const chunks = ['data: {"a":1}\r', '\n\r\n'];
  const events = [];
  for await (const event of parseSse(streamChunks(chunks))) events.push(event);
  assert.deepEqual(events, ['{"a":1}']);
});

test("readPlainStream returns full narrative across chunks", async () => {
  const chunks = [sse("潮声", null), sse("靠近。", "stop")];
  const result = await readPlainStream(streamChunks(chunks));
  assert.equal(result, "潮声靠近。");
});

test("流式用量采集:末块 usage 经 usageOut 带出", async () => {
  const usageFrame =
    'data: ' +
    JSON.stringify({
      choices: [],
      usage: { prompt_tokens: 1200, completion_tokens: 340 },
    }) +
    "\n\n";
  const plainOut = {};
  await readPlainStream(streamChunks([sse("潮声", null), sse("落定。", "stop"), usageFrame]), {
    usageOut: plainOut,
  });
  assert.equal(plainOut.usage.prompt_tokens, 1200);
  assert.equal(plainOut.usage.completion_tokens, 340);

  const collectOut = {};
  const collected = await collectStreamText(
    streamChunks([sse("{", null), sse('"}', "stop"), usageFrame]),
    { usageOut: collectOut },
  );
  assert.equal(collected.content, '{"}');
  assert.equal(collectOut.usage.prompt_tokens, 1200);
});

test("readPlainStream rejects truncated and empty responses", async () => {
  await assert.rejects(
    () => readPlainStream(streamChunks([sse("没有结束")])),
    /terminal signal/,
  );
  await assert.rejects(
    () => readPlainStream(streamChunks([sse("", "stop")])),
    /no narrative/,
  );
});

test("readPlainStream rejects finish_reason=length truncation", async () => {
  await assert.rejects(
    () => readPlainStream(streamChunks([sse("被截断", "length")])),
    /truncated/,
  );
});

test("collectStreamText captures content and the last finish_reason", async () => {
  const chunks = [sse('{"a":', null), sse("1}", "length")];
  assert.deepEqual(await collectStreamText(streamChunks(chunks)), {
    content: '{"a":1}',
    finishReason: "length",
  });
});

test("invalid JSON surfaces finish_reason and the failure neighborhood", async () => {
  // 非法但未被截断的 JSON(finish=stop):解析失败后报错必须带出 finish 证据与
  // 失败点附近原文,方便定位是烂尾还是截断。
  const broken = '{"world": {"id": "fanren", "characters": [ { "name": "韩立" 山';
  const client = new OpenAiCompatibleClient({
    config: {
      fast: { baseUrl: "https://example.test", apiKey: FIXTURE_KEY, model: "fast" },
      strong: { baseUrl: "https://example.test", apiKey: FIXTURE_KEY, model: "strong" },
      maxRetries: 0,
    },
    fetchImpl: async (_url, init) => {
      const body = JSON.parse(init.body);
      if (body.response_format) {
        // 该端点不支持 json_object：进入普通非流式形状。
        return new Response("response_format 不支持", { status: 400 });
      }
      if (!body.stream) {
        return new Response(
          JSON.stringify({ choices: [{ finish_reason: "stop", message: { content: broken } }] }),
          { status: 200 },
        );
      }
      return new Response(streamChunks([sse(broken, "stop")]), { status: 200 });
    },
  });
  await assert.rejects(
    () => client.completeFast([{ role: "user", content: "试" }]),
    (error) =>
      error.message.includes("Invalid model JSON") &&
      error.message.includes("finish=stop") &&
      error.message.includes("出错点附近") &&
      error.message.includes("韩立"),
  );
});

test("non-stream truncation retries with max_tokens=8192 and succeeds", async () => {
  const payload = { summary: "港口起雾" };
  let calls = 0;
  const client = new OpenAiCompatibleClient({
    config: {
      fast: { baseUrl: "https://example.test", apiKey: FIXTURE_KEY, model: "fast" },
      strong: { baseUrl: "https://example.test", apiKey: FIXTURE_KEY, model: "strong" },
      maxRetries: 0,
    },
    fetchImpl: async (_url, init) => {
      calls += 1;
      const body = JSON.parse(init.body);
      if (!body.stream) {
        // 端点默认上限截断 → 8192 重试后放得下。
        if (body.max_tokens !== 8192) {
          return new Response(
            JSON.stringify({ choices: [{ finish_reason: "length", message: { content: "{" } }] }),
            { status: 200 },
          );
        }
        return new Response(
          JSON.stringify({ choices: [{ message: { content: JSON.stringify(payload) } }] }),
          { status: 200 },
        );
      }
      return new Response(streamChunks([sse(JSON.stringify(payload), "stop")]), { status: 200 });
    },
  });
  const result = await client.completeFast([{ role: "user", content: "试" }]);
  assert.deepEqual(result, payload);
  assert.equal(calls, 2, "4K 截断 → 8192 重试成功,不需要流式降级");
});

test("stream truncation retries with max_tokens=8192 then fails with evidence", async () => {
  const bodies = [];
  const client = new OpenAiCompatibleClient({
    config: {
      fast: { baseUrl: "https://example.test", apiKey: FIXTURE_KEY, model: "fast" },
      strong: { baseUrl: "https://example.test", apiKey: FIXTURE_KEY, model: "strong" },
      maxRetries: 0,
    },
    fetchImpl: async (_url, init) => {
      const body = JSON.parse(init.body);
      bodies.push(body);
      if (body.response_format) return new Response("response_format 不支持", { status: 400 });
      if (!body.stream) return new Response("仅支持流式输出", { status: 400 });
      // 8192 也放不下:重试后仍截断,必须干净地报「截断」而不是拿残卷硬解析。
      return new Response(streamChunks([sse("被截断", "length")]), { status: 200 });
    },
  });
  await assert.rejects(
    () => client.completeFast([{ role: "user", content: "试" }]),
    (error) => error.message.includes("truncated") && error.message.includes("8192"),
  );
  const streamed = bodies.filter((body) => body.stream);
  assert.equal(streamed.length, 2, "默认上限截断 → 8192 重试");
  assert.equal(streamed[1].max_tokens, 8192);
});

test("普通回合走 fast 端点，关键回合与终局才用 strong，报错不泄露 Key", async () => {
  const requests = [];
  const fetchImpl = async (url, init) => {
    requests.push({ url, init });
    return new Response(streamChunks([sse("叙事", "stop")]), { status: 200 });
  };
  const client = new OpenAiCompatibleClient({
    config: {
      fast: { baseUrl: "https://example.test/v1/", apiKey: FIXTURE_FAST_KEY, model: "fast" },
      strong: { baseUrl: "https://example.test/v1/", apiKey: FIXTURE_KEY, model: "strong" },
    },
    fetchImpl,
  });
  const turn = { context: {}, choice: { text: "等待" }, check: { result: "success" } };

  await client.generateStory(turn);
  assert.equal(requests[0].url, "https://example.test/v1/chat/completions");
  assert.equal(JSON.parse(requests[0].init.body).model, "fast");
  assert.equal(requests[0].init.headers.Authorization, "Bearer fast-key");

  await client.generateStory({ ...turn, keyTurn: true });
  assert.equal(JSON.parse(requests[1].init.body).model, "strong");
  assert.equal(requests[1].init.headers.Authorization, "Bearer secret-key");

  await client.generateStory({ ...turn, endingTurn: true });
  assert.equal(JSON.parse(requests[2].init.body).model, "strong");

  const failing = new OpenAiCompatibleClient({
    config: {
      fast: { baseUrl: "https://example.test", apiKey: FIXTURE_KEY, model: "fast" },
      strong: { baseUrl: "https://example.test", apiKey: FIXTURE_KEY, model: "strong" },
    },
    fetchImpl: async () => new Response("quota exceeded", { status: 429 }),
  });
  await assert.rejects(
    () => failing.generateStory(turn),
    (error) => error.message.includes("429") && !error.message.includes("secret-key"),
  );
});

test("model list is fetched from the API, deduplicated and sorted", async () => {
  let requested;
  const models = await fetchModels({
    baseUrl: "https://example.test/v1/",
    apiKey: FIXTURE_KEY,
    fetchImpl: async (url, init) => {
      requested = { url, init };
      return new Response(
        JSON.stringify({ data: [{ id: "gpt-b" }, { id: "gpt-a" }, { id: "gpt-a" }] }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    },
  });

  assert.deepEqual(models, ["gpt-a", "gpt-b"]);
  assert.equal(requested.url, "https://example.test/v1/models");
  assert.equal(requested.init.headers.Authorization, "Bearer secret-key");

  await assert.rejects(
    () => fetchModels({ baseUrl: "https://example.test", apiKey: "" }),
    /API 地址与 Key/,
  );
  await assert.rejects(
    () =>
      fetchModels({
        baseUrl: "https://example.test",
        apiKey: FIXTURE_KEY,
        fetchImpl: async () => new Response("forbidden", { status: 403 }),
      }),
    (error) => error.message.includes("403") && !error.message.includes("secret-key"),
  );
  await assert.rejects(
    () =>
      fetchModels({
        baseUrl: "https://example.test",
        apiKey: FIXTURE_KEY,
        fetchImpl: async () =>
          new Response(JSON.stringify({ data: [] }), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          }),
      }),
    /没有返回任何可用模型/,
  );
});

test("fast completion degrades on 4xx with thinking always disabled", async () => {
  const payload = { summary: "港口起雾" };
  const bodies = [];
  const urls = [];
  const client = new OpenAiCompatibleClient({
    config: {
      fast: {
        baseUrl: "https://api.deepseek.com",
        apiKey: FIXTURE_DEEPSEEK_KEY,
        model: "deepseek-chat",
      },
      strong: {
        baseUrl: "https://api.deepseek.com",
        apiKey: FIXTURE_DEEPSEEK_KEY,
        model: "deepseek-v4-pro",
      },
    },
    fetchImpl: async (url, init) => {
      const body = JSON.parse(init.body);
      bodies.push(body);
      urls.push(url);
      if (body.response_format) return new Response("response_format 不支持", { status: 400 });
      if (!body.stream) return new Response("该模型仅支持流式输出", { status: 400 });
      return new Response(
        streamChunks([sse("```json\n" + JSON.stringify(payload) + "\n```", "stop")]),
        { status: 200 },
      );
    },
  });

  assert.deepEqual(await client.completeFast([{ role: "user", content: "试" }]), payload);
  assert.equal(bodies.length, 3);
  // 结构类请求永远关思考:三种形状都带 thinking disabled。
  assert.ok(bodies.every((body) => body.thinking?.type === "disabled"));
  assert.equal(bodies[0].model, "deepseek-chat");
  assert.equal(bodies[2].stream, true);
  assert.ok(urls.every((url) => url.startsWith("https://api.deepseek.com/")));
});

test("two DeepSeek slots carry their own key and thinking mode", async () => {
  const payload = { summary: "双槽 DeepSeek" };
  const requests = [];
  const client = new OpenAiCompatibleClient({
    config: {
      fast: {
        baseUrl: "https://api.deepseek.com",
        apiKey: FIXTURE_FAST_KEY,
        model: "deepseek-chat",
      },
      strong: {
        baseUrl: "https://api.deepseek.com",
        apiKey: FIXTURE_STRONG_KEY,
        model: "deepseek-v4-pro",
        thinking: true,
        slot: "strong",
      },
    },
    fetchImpl: async (url, init) => {
      requests.push({ url, init, body: JSON.parse(init.body) });
      return new Response(
        JSON.stringify({ choices: [{ message: { content: JSON.stringify(payload) } }] }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    },
  });

  await client.completeStrong([{ role: "user", content: "试" }]);
  const [strong] = requests;
  assert.equal(strong.url, "https://api.deepseek.com/v1/chat/completions");
  assert.equal(strong.init.headers.Authorization, "Bearer strong-key");
  assert.equal(strong.body.model, "deepseek-v4-pro");
  // 强槽开思考:effort=high,剥离 temperature。
  assert.equal(strong.body.reasoning_effort, "high");
  assert.equal(strong.body.temperature, undefined);
  assert.equal(strong.body.thinking, undefined);

  await client.completeFast([{ role: "user", content: "试" }]);
  const fast = requests[1];
  assert.equal(fast.url, "https://api.deepseek.com/v1/chat/completions");
  assert.equal(fast.init.headers.Authorization, "Bearer fast-key");
  assert.equal(fast.body.model, "deepseek-chat");
  // 快槽结构请求强制关思考:disabled + 常规 temperature。
  assert.deepEqual(fast.body.thinking, { type: "disabled" });
  assert.equal(fast.body.temperature, 0.2);
});

test("narrative thinking on strips temperature and max_tokens, off keeps both", async () => {
  const bodies = [];
  const buildClient = (fast) =>
    new OpenAiCompatibleClient({
      config: {
        fast: {
          baseUrl: "https://api.deepseek.com",
          apiKey: FIXTURE_DEEPSEEK_KEY,
          model: fast.model,
          thinking: fast.thinking,
          slot: "fast",
        },
        strong: {
          baseUrl: "https://api.deepseek.com",
          apiKey: FIXTURE_DEEPSEEK_KEY,
          model: "deepseek-v4-pro",
        },
        maxTokens: 8192,
      },
      fetchImpl: async (_url, init) => {
        bodies.push(JSON.parse(init.body));
        return new Response(streamChunks([sse("叙事", "stop")]), { status: 200 });
      },
    });

  // 开思考:reasoning_effort=low,不发 temperature 与 max_tokens。
  await buildClient({ model: "deepseek-v4-flash", thinking: true }).generateStory({
    context: {},
    choice: { text: "等待" },
    check: { result: "success" },
  });
  assert.equal(bodies[0].reasoning_effort, "low");
  assert.equal(bodies[0].temperature, undefined);
  assert.equal(bodies[0].max_tokens, undefined);

  // 关思考:disabled + 叙事温度 0.8 + 用户 max_tokens。
  await buildClient({ model: "deepseek-chat", thinking: false }).generateStory({
    context: {},
    choice: { text: "等待" },
    check: { result: "success" },
  });
  assert.deepEqual(bodies[1].thinking, { type: "disabled" });
  assert.equal(bodies[1].temperature, 0.8);
  assert.equal(bodies[1].max_tokens, 8192);
});

test("thinking toggles are silent no-ops for non-whitelisted DeepSeek models", async () => {
  const bodies = [];
  const client = new OpenAiCompatibleClient({
    config: {
      fast: {
        baseUrl: "https://api.deepseek.com",
        apiKey: FIXTURE_DEEPSEEK_KEY,
        model: "deepseek-v3",
        thinking: true,
        slot: "fast",
      },
      strong: {
        baseUrl: "https://api.deepseek.com",
        apiKey: FIXTURE_DEEPSEEK_KEY,
        model: "deepseek-v4-pro",
      },
    },
    fetchImpl: async (_url, init) => {
      bodies.push(JSON.parse(init.body));
      return new Response(streamChunks([sse("叙事", "stop")]), { status: 200 });
    },
  });
  await client.generateStory({ context: {}, choice: { text: "等待" }, check: { result: "success" } });
  // 白名单外静默失效:不发思考参数,常规 temperature 照发。
  assert.equal(bodies[0].reasoning_effort, undefined);
  assert.equal(bodies[0].thinking, undefined);
  assert.equal(bodies[0].temperature, 0.8);
});

test("fast completion retries transient failures but not permanent errors", async () => {
  const payload = { summary: "恢复" };
  let transientCalls = 0;
  const recovering = new OpenAiCompatibleClient({
    config: {
      fast: { baseUrl: "https://example.test", apiKey: FIXTURE_KEY, model: "fast" },
      strong: { baseUrl: "https://example.test", apiKey: FIXTURE_KEY, model: "strong" },
      maxRetries: 3,
    },
    fetchImpl: async () => {
      transientCalls += 1;
      if (transientCalls === 1) {
        return new Response("busy", { status: 503, headers: { "Retry-After": "0" } });
      }
      if (transientCalls === 2) {
        return new Response("limited", { status: 429, headers: { "Retry-After": "0" } });
      }
      return new Response(
        JSON.stringify({ choices: [{ message: { content: JSON.stringify(payload) } }] }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    },
  });
  assert.deepEqual(await recovering.completeFast([{ role: "user", content: "试" }]), payload);
  assert.equal(transientCalls, 3);

  let permanentCalls = 0;
  const rejected = new OpenAiCompatibleClient({
    config: {
      fast: { baseUrl: "https://example.test", apiKey: FIXTURE_KEY, model: "fast" },
      strong: { baseUrl: "https://example.test", apiKey: FIXTURE_KEY, model: "strong" },
      maxRetries: 3,
    },
    fetchImpl: async () => {
      permanentCalls += 1;
      return new Response("insufficient_quota", { status: 429 });
    },
  });
  await assert.rejects(
    () => rejected.completeFast([{ role: "user", content: "试" }]),
    /insufficient_quota/,
  );
  assert.equal(permanentCalls, 1);
});

test("fast completion does not try other request shapes on auth failures", async () => {
  let calls = 0;
  const client = new OpenAiCompatibleClient({
    config: {
      fast: { baseUrl: "https://example.test", apiKey: FIXTURE_KEY, model: "fast" },
      strong: { baseUrl: "https://example.test", apiKey: FIXTURE_KEY, model: "strong" },
      maxRetries: 3,
    },
    fetchImpl: async () => {
      calls += 1;
      return new Response("invalid api key", { status: 401 });
    },
  });
  await assert.rejects(
    () => client.completeFast([{ role: "user", content: "试" }]),
    /401/,
  );
  // 鉴权失败换 response_format、换流式都注定失败，只该打一次请求。
  assert.equal(calls, 1);
});

test("fast completion honors a request-specific timeout", async () => {
  let timeoutSignal;
  const client = new OpenAiCompatibleClient({
    config: {
      fast: { baseUrl: "https://example.test", apiKey: FIXTURE_KEY, model: "fast" },
      strong: { baseUrl: "https://example.test", apiKey: FIXTURE_KEY, model: "strong" },
      timeoutMs: 1,
      strongTimeoutMs: 300_000,
    },
    fetchImpl: async (_url, init) => {
      timeoutSignal = init.signal;
      return new Response(
        JSON.stringify({ choices: [{ message: { content: '{"ok":true}' } }] }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    },
  });
  assert.deepEqual(
    await client.completeFast([{ role: "user", content: "试" }], { timeoutMs: 300_000 }),
    { ok: true },
  );
  assert.equal(timeoutSignal.aborted, false);
});

test("maxTokens setting is sent as max_tokens and omitted when empty", async () => {
  const payload = { summary: "上限" };
  const requests = [];
  const buildClient = (maxTokens) =>
    new OpenAiCompatibleClient({
      config: {
        fast: { baseUrl: "https://example.test", apiKey: FIXTURE_KEY, model: "fast" },
        strong: { baseUrl: "https://example.test", apiKey: FIXTURE_KEY, model: "strong" },
        ...(maxTokens == null ? {} : { maxTokens }),
      },
      fetchImpl: async (_url, init) => {
        requests.push(JSON.parse(init.body));
        return new Response(
          JSON.stringify({ choices: [{ message: { content: JSON.stringify(payload) } }] }),
          { status: 200 },
        );
      },
    });

  await buildClient(8192).completeFast([{ role: "user", content: "试" }]);
  assert.equal(requests[0].max_tokens, 8192);

  await buildClient(undefined).completeFast([{ role: "user", content: "试" }]);
  assert.equal(requests[1].max_tokens, undefined);
});

test("strong streaming completion honors a request-specific timeout", async () => {
  let timeoutSignal;
  const client = new OpenAiCompatibleClient({
    config: {
      fast: { baseUrl: "https://example.test", apiKey: FIXTURE_KEY, model: "fast" },
      strong: { baseUrl: "https://example.test", apiKey: FIXTURE_KEY, model: "strong" },
      timeoutMs: 1,
    },
    fetchImpl: async (_url, init) => {
      timeoutSignal = init.signal;
      return new Response(streamChunks([sse("正文", "stop")]), { status: 200 });
    },
  });

  const result = await client.generateStory({
    context: {},
    choice: {},
    check: {},
  });

  assert.equal(result.narrative, "正文");
  assert.equal(timeoutSignal.aborted, false);
});

test("empty content asks once more, then degrades to another request shape", async () => {
  const payload = { summary: "重问后成功" };
  const calls = [];
  const client = new OpenAiCompatibleClient({
    config: {
      fast: { baseUrl: "https://example.test", apiKey: FIXTURE_KEY, model: "fast" },
      strong: { baseUrl: "https://example.test", apiKey: FIXTURE_KEY, model: "strong" },
      maxRetries: 0,
    },
    fetchImpl: async (_url, init) => {
      const body = JSON.parse(init.body);
      calls.push(body);
      if (calls.length === 1) {
        return new Response(
          JSON.stringify({ choices: [{ message: { content: "" } }] }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      return new Response(
        JSON.stringify({ choices: [{ message: { content: JSON.stringify(payload) } }] }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    },
  });

  assert.deepEqual(await client.completeFast([{ role: "user", content: "试" }]), payload);
  assert.equal(calls.length, 2);
  assert.match(calls[1].messages.at(-1).content, /空的/);
});

test("reasoning_content is used as a fallback when content is empty", async () => {
  const payload = { summary: "思考型模型" };
  const client = new OpenAiCompatibleClient({
    config: {
      fast: { baseUrl: "https://example.test", apiKey: FIXTURE_KEY, model: "fast" },
      strong: { baseUrl: "https://example.test", apiKey: FIXTURE_KEY, model: "strong" },
      maxRetries: 0,
    },
    fetchImpl: async () =>
      new Response(
        JSON.stringify({
          choices: [{ message: { content: "", reasoning_content: JSON.stringify(payload) } }],
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
  });

  assert.deepEqual(await client.completeFast([{ role: "user", content: "试" }]), payload);
});

test("structure generation prefers tool calls and parses arguments", async () => {
  const payload = {
    delta: { clue: 1 },
    options: [
      { id: "a", text: "观察", axis: "investigate", risk: "safe", attribute: "resolve" },
      { id: "b", text: "离开", axis: "exit", risk: "safe", attribute: "agility" },
    ],
    openThreads: [],
    retrievalKeywords: [],
  };
  const bodies = [];
  const client = new OpenAiCompatibleClient({
    config: {
      fast: { baseUrl: "https://example.test", apiKey: FIXTURE_KEY, model: "fast" },
      strong: { baseUrl: "https://example.test", apiKey: FIXTURE_KEY, model: "strong" },
      maxRetries: 0,
    },
    fetchImpl: async (_url, init) => {
      bodies.push(JSON.parse(init.body));
      return new Response(
        JSON.stringify({
          choices: [
            {
              message: {
                tool_calls: [
                  { function: { name: "submit_turn", arguments: JSON.stringify(payload) } },
                ],
              },
            },
          ],
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    },
  });

  const result = await client.generateStructure({
    narrative: "潮声靠近。",
    context: {},
    choice: { text: "观察" },
    check: { result: "success" },
  });

  assert.deepEqual(result.delta, { clue: 1 });
  assert.equal(result.options.length, 2);
  assert.equal(bodies[0].tools[0].function.name, "submit_turn");
  assert.equal(bodies[0].tool_choice.function.name, "submit_turn");
});

test("completeFastTool sends the tool and tool_choice, and falls back to json_object when the tool is not called", async () => {
  const payload = { ok: true, issues: [] };
  let calls = 0;
  const bodies = [];
  const client = new OpenAiCompatibleClient({
    config: {
      fast: { baseUrl: "https://example.test", apiKey: FIXTURE_KEY, model: "fast" },
      strong: { baseUrl: "https://example.test", apiKey: FIXTURE_KEY, model: "strong" },
      maxRetries: 0,
    },
    fetchImpl: async (_url, init) => {
      calls += 1;
      const body = JSON.parse(init.body);
      bodies.push(body);
      if (body.tools) {
        return new Response(
          JSON.stringify({ choices: [{ message: { content: "抱歉，我无法调用工具。" } }] }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      return new Response(
        JSON.stringify({ choices: [{ message: { content: JSON.stringify(payload) } }] }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    },
  });

  const result = await client.completeFastTool(
    [{ role: "user", content: "检查" }],
    {
      type: "function",
      function: { name: "submit_check", description: "提交检查结论", parameters: { type: "object", properties: { ok: { type: "boolean" }, issues: { type: "array", items: { type: "object" } } }, required: ["ok"] } },
    },
  );

  assert.deepEqual(result, payload);
  assert.equal(calls, 2);
  assert.equal(bodies[0].tools[0].function.name, "submit_check");
  assert.equal(bodies[0].tool_choice.function.name, "submit_check");
  assert.equal(bodies[1].response_format.type, "json_object");
});

test("structure generation falls back to json_object when tool call is missing", async () => {
  const payload = {
    delta: {},
    options: [
      { id: "a", text: "观察", axis: "investigate", risk: "safe", attribute: "resolve" },
      { id: "b", text: "离开", axis: "exit", risk: "safe", attribute: "agility" },
    ],
    openThreads: [],
    retrievalKeywords: [],
  };
  let calls = 0;
  const client = new OpenAiCompatibleClient({
    config: {
      fast: { baseUrl: "https://example.test", apiKey: FIXTURE_KEY, model: "fast" },
      strong: { baseUrl: "https://example.test", apiKey: FIXTURE_KEY, model: "strong" },
      maxRetries: 0,
    },
    fetchImpl: async (_url, init) => {
      calls += 1;
      const body = JSON.parse(init.body);
      if (body.tools) {
        return new Response(
          JSON.stringify({ choices: [{ message: { content: "抱歉，我无法输出结构化数据。" } }] }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      return new Response(
        JSON.stringify({ choices: [{ message: { content: JSON.stringify(payload) } }] }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    },
  });

  const result = await client.generateStructure({
    narrative: "潮声靠近。",
    context: {},
    choice: { text: "观察" },
    check: { result: "success" },
  });

  assert.deepEqual(result.delta, {});
  assert.equal(result.options.length, 2);
  assert.equal(calls, 2);
});

test("a 404 fails fast instead of retrying every request shape", async () => {
  let calls = 0;
  const client = new OpenAiCompatibleClient({
    config: {
      fast: { baseUrl: "https://example.test", apiKey: FIXTURE_KEY, model: "fast" },
      strong: { baseUrl: "https://example.test", apiKey: FIXTURE_KEY, model: "strong" },
      maxRetries: 2,
    },
    fetchImpl: async () => {
      calls += 1;
      return new Response("没有这个端点", { status: 404 });
    },
  });
  await assert.rejects(() => client.completeFast([{ role: "user", content: "试" }]), /404/);
  assert.equal(calls, 1, "404 换什么形状都没用，应一次失败");
});

test("persistent headerless 5xx retries within the transport budget, then fails", async () => {
  let calls = 0;
  const client = new OpenAiCompatibleClient({
    config: {
      fast: { baseUrl: "https://example.test", apiKey: FIXTURE_KEY, model: "fast" },
      strong: { baseUrl: "https://example.test", apiKey: FIXTURE_KEY, model: "strong" },
      maxRetries: 2,
    },
    fetchImpl: async () => {
      calls += 1;
      // 无 Retry-After 头的 500：仍应按指数退避重试（而不是零延迟狂轰）。
      return new Response("服务端抖动", { status: 500 });
    },
  });
  await assert.rejects(() => client.completeFast([{ role: "user", content: "试" }]), /500/);
  assert.equal(calls, 3, "1 次原始请求 + 2 次重试");
});

// 保真校验数据链(拍板 2026-08-17):canonNow/canonUpcoming/worldview 必须完整
// 送达到校验器——此前客户端签名漏参,校验器⑧⑨两类违例无数据可对照,形同虚设。
test("checkIdentityConsistency forwards canonNow, canonUpcoming and worldview to the checker", async () => {
  let capturedUser = null;
  const verdict = { ok: true, issues: [] };
  const client = new OpenAiCompatibleClient({
    config: {
      fast: { baseUrl: "https://example.test", apiKey: FIXTURE_KEY, model: "fast" },
      strong: { baseUrl: "https://example.test", apiKey: FIXTURE_KEY, model: "strong" },
      maxRetries: 0,
    },
    fetchImpl: async (_url, init) => {
      const body = JSON.parse(init.body);
      if (!body.stream) {
        capturedUser = body.messages.find((message) => message.role === "user").content;
        return new Response(
          JSON.stringify({
            choices: [
              { finish_reason: "stop", message: { content: JSON.stringify(verdict) } },
            ],
          }),
          { status: 200 },
        );
      }
      return new Response(streamChunks([sse(JSON.stringify(verdict), "stop")]), { status: 200 });
    },
  });
  const result = await client.checkIdentityConsistency({
    narrative: "雾里传来铃声。",
    options: [],
    capabilities: { roleName: "斥候" },
    characters: [],
    worldview: { title: "灰港余烬", summary: "", traits: [], rules: {} },
    canonNow: [{ chapter: 3, text: "黑铃在雾中响起" }],
    canonUpcoming: [{ id: "event-1", text: "灯灭之夜", time: 120, chapterAnchor: 4 }],
    storyClock: { label: "第 3 日 · 黄昏", day: 3, hour: 18, segment: "黄昏" },
  });
  assert.deepEqual(result, verdict);
  const payload = JSON.parse(capturedUser);
  assert.deepEqual(
    payload.canonNow,
    [{ chapter: 3, text: "黑铃在雾中响起" }],
    "原著此刻片段必须送达到校验器",
  );
  assert.deepEqual(
    payload.canonUpcoming,
    [{ id: "event-1", text: "灯灭之夜", time: 120, chapterAnchor: 4 }],
    "原著将至事件必须送达到校验器",
  );
  assert.equal(payload.worldview.title, "灰港余烬", "世界观摘要必须送达到校验器");
  assert.equal(payload.storyClock.label, "第 3 日 · 黄昏", "故事时钟必须送达到校验器");
});


test("非流式读体超时按传输错误重试,不误判成内容错误", async () => {
  // 读体阶段的超时(AbortSignal.timeout 绑到响应体)此前被包成
  // ModelContentError——内容错误不可重试还会烧完整个降级链。
  const timeoutLike = () => {
    const error = new Error("The operation was aborted due to timeout");
    error.name = "TimeoutError";
    return error;
  };
  let calls = 0;
  const client = new OpenAiCompatibleClient({
    config: {
      fast: { baseUrl: "https://example.test", apiKey: FIXTURE_KEY, model: "fast" },
      strong: { baseUrl: "https://example.test", apiKey: FIXTURE_KEY, model: "strong" },
      maxRetries: 1,
    },
    fetchImpl: async () => {
      calls += 1;
      if (calls === 1) {
        return {
          ok: true,
          status: 200,
          headers: new Headers(),
          async json() {
            throw timeoutLike();
          },
        };
      }
      return new Response(
        JSON.stringify({ choices: [{ finish_reason: "stop", message: { content: '{"ok":1}' } }] }),
        { status: 200 },
      );
    },
  });
  const result = await client.completeFast([{ role: "user", content: "试" }]);
  assert.deepEqual(result, { ok: 1 });
  assert.equal(calls, 2, "读体超时被重试");
});

test("流式读体超时也在重试范围内", async () => {
  const timeoutLike = () => {
    const error = new Error("stream aborted");
    error.name = "TimeoutError";
    return error;
  };
  let calls = 0;
  const client = new OpenAiCompatibleClient({
    config: {
      fast: { baseUrl: "https://example.test", apiKey: FIXTURE_KEY, model: "fast" },
      strong: { baseUrl: "https://example.test", apiKey: FIXTURE_KEY, model: "strong" },
      maxRetries: 2,
    },
    fetchImpl: async (_url, init) => {
      const body = JSON.parse(init.body);
      calls += 1;
      if (body.response_format) {
        // 首选形状被端点拒绝,进入流式降级。
        return new Response("response_format 不支持", { status: 400 });
      }
      if (calls === 2) {
        return new Response(
          new ReadableStream({
            start(controller) {
              controller.error(timeoutLike());
            },
          }),
          { status: 200 },
        );
      }
      return new Response(streamChunks([sse('{"ok":2}', "stop")]), { status: 200 });
    },
  });
  const result = await client.completeFast([{ role: "user", content: "试" }]);
  assert.deepEqual(result, { ok: 2 });
  assert.ok(calls >= 3, "流式读体超时被重试后成功");
});

test("Retry-After 的远期 HTTP 日期也封顶 15 秒", async () => {
  const { retryDelay } = await import("../src/openai-client.js");
  const far = new Date(Date.now() + 365 * 24 * 3600 * 1000).toUTCString();
  const delay = retryDelay({ retryAfter: far }, 0);
  assert.ok(delay <= 15_000, `远期日期的退避封顶 15s,实际 ${delay}`);
  // 数字分支原有的封顶行为不变。
  assert.equal(retryDelay({ retryAfter: "120" }, 0), 15_000);
  assert.ok(retryDelay({ retryAfter: "3" }, 0) === 3000);
});

test("叙事流遵守学到的 max_tokens 上限(与结构请求同款自愈)", async () => {
  const bodies = [];
  const client = new OpenAiCompatibleClient({
    config: {
      fast: { baseUrl: "https://api.deepseek.com", apiKey: FIXTURE_KEY, model: "fast" },
      strong: { baseUrl: "https://api.deepseek.com", apiKey: FIXTURE_KEY, model: "strong" },
      maxTokens: 8192,
      maxRetries: 0,
    },
    fetchImpl: async (_url, init) => {
      const body = JSON.parse(init.body);
      bodies.push(body);
      assert.equal(body.stream, true, "叙事走流式");
      return new Response(streamChunks([sse("潮声漫过石阶。", "stop")]), { status: 200 });
    },
  });
  // 模拟此前结构请求学到的上限:显式 8192 高于已学 4096 时必须收口,
  // 否则低上限端点上每个叙事请求都硬吃 400。
  client.learnedMaxTokens.set("strong", 4096);
  await client.generateStory({ context: {}, choice: {}, check: {}, keyTurn: true });
  assert.equal(bodies.at(-1).max_tokens, 4096, "叙事流按已学上限下发");
});
