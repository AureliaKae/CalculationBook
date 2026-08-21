import assert from "node:assert/strict";
import test from "node:test";

import {
  clampTemperature,
  clientConfig,
  credentialLabel,
  DEFAULT_BASE_URL,
  emptySettings,
  isReady,
  migrateSettings,
  publicSettings,
  resolveBakeConcurrency,
} from "../src/settings-schema.js";
import { maxOutputTokensFor } from "../src/providers.js";

test("v1 单组配置迁移成凭证池里的第一条", () => {
  const migrated = migrateSettings({
    baseUrl: "https://api.deepseek.com",
    encryptedKey: "cipher",
    fastModel: "deepseek-chat",
    strongModel: "deepseek-reasoner",
    bakeConcurrency: 4,
  });
  assert.equal(migrated.version, 2);
  assert.equal(migrated.credentials.length, 1);
  assert.equal(migrated.credentials[0].id, "migrated");
  assert.equal(migrated.credentials[0].encryptedKey, "cipher");
  assert.deepEqual(migrated.fast, { credentialId: "migrated", model: "deepseek-chat", temperature: 0.2 });
  assert.deepEqual(migrated.strong, { credentialId: "migrated", model: "deepseek-reasoner", temperature: 0.2 });
  assert.equal(migrated.bakeConcurrency, 4);
});

test("空配置与坏配置都退化成空凭证池", () => {
  assert.deepEqual(migrateSettings(null), emptySettings());
  assert.deepEqual(migrateSettings({}), emptySettings());
  assert.equal(isReady(emptySettings()), false);
});

test("默认地址与凭证标签认双厂商", () => {
  assert.equal(DEFAULT_BASE_URL, "https://api.deepseek.com");
  assert.equal(credentialLabel("https://api.deepseek.com"), "DeepSeek");
  assert.equal(credentialLabel("https://api.deepseek.com/v1"), "DeepSeek");
  assert.equal(credentialLabel("https://dashscope.aliyuncs.com/compatible-mode/v1"), "阿里千问");
  assert.equal(credentialLabel("https://ws.cn-beijing.maas.aliyuncs.com/compatible-mode/v1"), "阿里千问");
});

test("迁移时静默清除双厂商之外的凭证并清空指向它的槽位", () => {
  const migrated = migrateSettings({
    version: 2,
    credentials: [
      { id: "a", baseUrl: "https://api.deepseek.com" },
      { id: "b", baseUrl: "https://api.openai.com" },
      { id: "c", baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1" },
    ],
    fast: { credentialId: "b", model: "gpt-4o" },
    strong: { credentialId: "a", model: "deepseek-v4-pro" },
  });
  // DeepSeek 与阿里千问(百炼)都保留,其余清除。
  assert.deepEqual(migrated.credentials.map((item) => item.id), ["a", "c"]);
  assert.equal(migrated.credentials[1].label, "阿里千问");
  assert.deepEqual(migrated.fast, { credentialId: "", model: "", temperature: 0.2 });
  assert.equal(migrated.strong.model, "deepseek-v4-pro");
});

test("v1 旧格式指向非双厂商地址时整组丢弃", () => {
  const migrated = migrateSettings({
    baseUrl: "https://api.openai.com",
    encryptedKey: "cipher",
    fastModel: "gpt-4o",
    strongModel: "gpt-4o",
  });
  assert.deepEqual(migrated, emptySettings());
});

test("clientConfig 接受阿里千问凭证并拒绝双厂商之外的地址", () => {
  const qwen = clientConfig({
    credentials: [
      { id: "q", baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1", apiKey: "sk-q" },
    ],
    fast: { credentialId: "q", model: "qwen-turbo" },
    strong: { credentialId: "q", model: "qwen3-max" },
  });
  assert.equal(qwen.strong.baseUrl, "https://dashscope.aliyuncs.com/compatible-mode/v1");
  assert.equal(qwen.strong.model, "qwen3-max");
  assert.throws(
    () =>
      clientConfig({
        credentials: [{ id: "a", baseUrl: "https://api.openai.com", apiKey: "key" }],
        fast: { credentialId: "a", model: "gpt-4o" },
        strong: { credentialId: "a", model: "gpt-4o" },
      }),
    /仅支持 DeepSeek/,
  );
});

test("指向已删除凭证的槽位会被清空", () => {
  const migrated = migrateSettings({
    version: 2,
    credentials: [{ id: "a", baseUrl: "https://api.deepseek.com" }],
    fast: { credentialId: "a", model: "deepseek-chat" },
    strong: { credentialId: "gone", model: "gpt-4o" },
  });
  assert.deepEqual(migrated.strong, { credentialId: "", model: "", temperature: 0.2 });
  assert.equal(migrated.credentials[0].label, credentialLabel("https://api.deepseek.com"));
});

test("两条 DeepSeek 凭证各自带上地址、Key、槽位标记与思考链开关", () => {
  const config = clientConfig({
    credentials: [
      { id: "a", baseUrl: "https://api.deepseek.com", apiKey: "key-a" },
      { id: "b", baseUrl: "https://api.deepseek.com", apiKey: "key-b" },
    ],
    fast: { credentialId: "a", model: "deepseek-chat" },
    strong: { credentialId: "b", model: "deepseek-v4-pro" },
    thinkingFast: true,
    thinkingStrong: false,
  });
  assert.deepEqual(config.fast, {
    baseUrl: "https://api.deepseek.com",
    apiKey: "key-a",
    model: "deepseek-chat",
    temperature: 0.2,
    thinking: true,
    slot: "fast",
  });
  assert.deepEqual(config.strong, {
    baseUrl: "https://api.deepseek.com",
    apiKey: "key-b",
    model: "deepseek-v4-pro",
    temperature: 0.2,
    thinking: false,
    slot: "strong",
  });
});

test("槽位温度钳制到 0.1–1.5、缺省 0.2,并随迁移与 publicSettings 传递", () => {
  assert.equal(clampTemperature(undefined), 0.2);
  assert.equal(clampTemperature(""), 0.2);
  assert.equal(clampTemperature(0), 0.1);
  assert.equal(clampTemperature(0.74), 0.7);
  assert.equal(clampTemperature(9), 1.5);
  assert.equal(clampTemperature("abc"), 0.2);

  const migrated = migrateSettings({
    version: 2,
    credentials: [{ id: "a", baseUrl: "https://api.deepseek.com", apiKey: "key" }],
    fast: { credentialId: "a", model: "deepseek-v4-flash", temperature: 0.9 },
    strong: { credentialId: "a", model: "deepseek-v4-pro" },
  });
  assert.equal(migrated.fast.temperature, 0.9);
  assert.equal(migrated.strong.temperature, 0.2, "缺省吃默认 0.2");

  const exposed = publicSettings(migrated);
  assert.equal(exposed.fast.temperature, 0.9);
  assert.equal(exposed.strong.temperature, 0.2);

  const config = clientConfig({
    version: 2,
    credentials: [{ id: "a", baseUrl: "https://api.deepseek.com", apiKey: "key" }],
    fast: { credentialId: "a", model: "deepseek-v4-flash", temperature: 0.9 },
    strong: { credentialId: "a", model: "deepseek-v4-pro" },
    thinkingStrong: true,
  });
  assert.equal(config.fast.temperature, 0.9);
  assert.equal(config.strong.temperature, 0.2);
});

test("maxTokens 留空用端点默认，填数字才下发并随 clientConfig 传递", () => {
  assert.equal(emptySettings().maxTokens, "");
  const migrated = migrateSettings({
    version: 2,
    credentials: [{ id: "a", baseUrl: "https://api.deepseek.com", apiKey: "key" }],
    fast: { credentialId: "a", model: "deepseek-v4-flash" },
    strong: { credentialId: "a", model: "deepseek-v4-pro" },
    maxTokens: "16384",
  });
  assert.equal(migrated.maxTokens, 16384);
  assert.equal(migrateSettings({ ...migrated, maxTokens: "abc" }).maxTokens, "");
  assert.equal(migrateSettings({ ...migrated, maxTokens: "0" }).maxTokens, "");
  assert.equal(migrateSettings({ ...migrated, maxTokens: "" }).maxTokens, "");
  // clientConfig 读的是「已解密」的 in-memory 设置（credentials 带 apiKey）。
  assert.equal(
    clientConfig({ ...migrated, credentials: [{ ...migrated.credentials[0], apiKey: "key" }] })
      .maxTokens,
    16384,
  );
});

test("thinking 开关有默认值并随配置迁移（mode 已随存档槽删除）", () => {
  assert.equal(emptySettings().thinkingFast, false);
  // 新默认:强槽开思考(叙事质量优先),快槽关(烧制速度优先)。
  assert.equal(emptySettings().thinkingStrong, true);
  assert.equal(emptySettings().mode, undefined, "mode 字段已删，不再出现在设置里");

  const migrated = migrateSettings({
    version: 2,
    credentials: [{ id: "a", baseUrl: "https://api.deepseek.com" }],
    fast: { credentialId: "a", model: "deepseek-v4-flash" },
    strong: { credentialId: "a", model: "deepseek-v4-pro" },
    mode: "normal",
    thinkingStrong: true,
  });
  assert.equal(migrated.mode, undefined, "旧档里的 mode 被静默丢弃");
  assert.equal(migrated.thinkingFast, false);
  assert.equal(migrated.thinkingStrong, true);
});

test("thinkingStrong 缺省吃新默认 true,显式关闭的用户值原样保留", () => {
  assert.equal(migrateSettings({ version: 2 }).thinkingStrong, true);
  const explicit = migrateSettings({
    version: 2,
    credentials: [{ id: "a", baseUrl: "https://api.deepseek.com" }],
    thinkingStrong: false,
  });
  assert.equal(explicit.thinkingStrong, false);
  const v1 = migrateSettings({
    baseUrl: "https://api.deepseek.com",
    encryptedKey: "cipher",
  });
  assert.equal(v1.thinkingStrong, true);
});

test("缺 Key 或缺模型时报错指明是哪个槽位", () => {
  const credentials = [{ id: "a", baseUrl: "https://api.deepseek.com", apiKey: "" }];
  assert.throws(
    () => clientConfig({ credentials, fast: { credentialId: "a", model: "x" }, strong: {} }),
    /快模型.*凭证/,
  );
  assert.throws(
    () =>
      clientConfig({
        credentials: [{ ...credentials[0], apiKey: "key" }],
        fast: { credentialId: "a", model: "x" },
        strong: { credentialId: "a", model: "" },
      }),
    /强模型.*模型/,
  );
});

test("publicSettings 只吐出是否存过 Key，不带密文也不带明文", () => {
  const exposed = publicSettings({
    credentials: [
      { id: "a", label: "自家", baseUrl: "https://api.deepseek.com", apiKey: "secret", encryptedKey: "cipher" },
      { id: "b", label: "备用", baseUrl: "https://api.deepseek.com", apiKey: "" },
    ],
    fast: { credentialId: "a", model: "deepseek-chat" },
    strong: { credentialId: "a", model: "deepseek-reasoner" },
    bakeConcurrency: 3,
    maxTokens: 8192,
  });
  assert.equal(exposed.maxTokens, 8192);
  assert.deepEqual(exposed.credentials, [
    { id: "a", label: "自家", baseUrl: "https://api.deepseek.com", hasApiKey: true },
    { id: "b", label: "备用", baseUrl: "https://api.deepseek.com", hasApiKey: false },
  ]);
  assert.equal(exposed.ready, true);
  assert.doesNotMatch(JSON.stringify(exposed), /secret|cipher/);
});

// —— 自动档（2026-08-17）：输出上限按模型官方最大、并发按厂商官方建议 ——
test("官方输出上限表:qwen3-max 32768、qwen3 开源 16384、其余 8192", () => {
  assert.equal(maxOutputTokensFor("qwen3-max"), 32768);
  assert.equal(maxOutputTokensFor("qwen3-235b-a22b-instruct"), 16384);
  assert.equal(maxOutputTokensFor("qwen-plus"), 8192);
  assert.equal(maxOutputTokensFor("deepseek-v4-pro"), 8192);
  assert.equal(maxOutputTokensFor(""), 8192);
});

test("烧制并发自动档:留空按快槽厂商,手动数字原样", () => {
  const deepseekAuto = {
    credentials: [{ id: "a", baseUrl: "https://api.deepseek.com", apiKey: "k" }],
    fast: { credentialId: "a", model: "deepseek-v3" },
    bakeConcurrency: "",
  };
  assert.equal(resolveBakeConcurrency(deepseekAuto), 4);
  const qwenAuto = {
    credentials: [{ id: "q", baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1", apiKey: "k" }],
    fast: { credentialId: "q", model: "qwen-turbo" },
    bakeConcurrency: "",
  };
  assert.equal(resolveBakeConcurrency(qwenAuto), 3);
  assert.equal(resolveBakeConcurrency({ ...deepseekAuto, bakeConcurrency: 8 }), 8);
  // 空配置(还没有凭证)回落 DeepSeek 档。
  assert.equal(resolveBakeConcurrency({}), 4);
});

test("空并发随迁移与 publicSettings 透传为自动档", () => {
  const migrated = migrateSettings({ version: 2, credentials: [{ id: "a", baseUrl: "https://api.deepseek.com" }] });
  assert.equal(migrated.bakeConcurrency, "", "旧档缺省并发变为自动档");
  assert.equal(emptySettings().bakeConcurrency, "");
  const exposed = publicSettings(migrated);
  assert.equal(exposed.bakeConcurrency, "");
});

test("本机调试凭据(http://localhost)存取往返不丢", () => {
  // 保存侧 assertSecureEndpoint/assertKnownEndpoint 都放行 localhost;
  // 迁移过滤若按已知厂商白名单走,这条凭据连同密文一起被静默删除,
  // 本机调试功能永远走不通。
  const migrated = migrateSettings({
    version: 2,
    credentials: [
      { id: "dev", label: "本机", baseUrl: "http://localhost:8000/v1", encryptedKey: "cipher" },
      { id: "far", label: "野站", baseUrl: "http://evil.example/v1", encryptedKey: "cipher" },
    ],
    fast: { credentialId: "dev", model: "local-model" },
    strong: { credentialId: "dev", model: "local-model" },
  });
  assert.equal(migrated.credentials.length, 1, "localhost 保留,未知 http 站点清除");
  assert.equal(migrated.credentials[0].id, "dev");
  assert.equal(migrated.fast.credentialId, "dev", "槽位指向不被清空");
  // 运行时同口径放行(不带 Key 报的是配置缺失,不是厂商拦截)。
  const ready = (() => {
    try {
      clientConfig({ ...migrated, credentials: [{ ...migrated.credentials[0], apiKey: "k" }] });
      return true;
    } catch (error) {
      return error.message;
    }
  })();
  assert.equal(ready, true);
});

test("未知未来版本的设置文件不再被静默清空", () => {
  // 降级运行/忘写迁移分支时,v3 文件不该按 v1 空档处理——那会把全部凭证
  // 密文当「空配置」读出,下一次 save 就永久覆盖丢失。
  const migrated = migrateSettings({
    version: 3,
    credentials: [
      { id: "a", baseUrl: "https://api.deepseek.com", encryptedKey: "cipher" },
    ],
    fast: { credentialId: "a", model: "m1" },
  });
  assert.equal(migrated.credentials.length, 1, "按 v2 结构尽力读取,凭证保留");
  assert.equal(migrated.credentials[0].encryptedKey, "cipher");
  assert.equal(migrated.fast.credentialId, "a");
});
