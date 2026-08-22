// 供应商层：OpenAI 兼容接口的多厂商注册表（拍板 2026-08-22 多密钥）。
// 起家是 DeepSeek 与阿里千问两家；现收录 OpenAI、月之暗面 Kimi、智谱 GLM、
// 硅基流动。思考参数按厂商语义归一化（deepseek / qwen / openai 三种模式）；
// 未登记思考语义的厂商一律不发厂商参数，客户端保持通用兼容——发错参数会
// 吃 400，宁可不发。运行时只可能配置注册表内的地址：设置入口（main.js
// 白名单 + 凭证迁移过滤）与槽位解析共用 isKnownProviderBaseUrl。

export const DEEPSEEK_BASE_URL = "https://api.deepseek.com";
export const QWEN_BASE_URL = "https://dashscope.aliyuncs.com/compatible-mode/v1";

// 注册表：hosts 是主机名后缀（子域任意，点边界防「aliyuncs.com.evil.test」
// 这类伪装）；models 是首配代选（null = 不代选，型号漂移快的厂商宁缺毋滥）；
// bakeConcurrency 是烧制并发自动档；thinking 是思考参数的归一化模式。
export const PROVIDERS = [
  {
    id: "deepseek",
    label: "DeepSeek",
    baseUrl: DEEPSEEK_BASE_URL,
    hosts: ["deepseek.com"],
    models: { fast: "deepseek-chat", strong: "deepseek-chat" },
    bakeConcurrency: 4,
    thinking: "deepseek",
  },
  {
    id: "qwen",
    label: "阿里千问",
    baseUrl: QWEN_BASE_URL,
    hosts: ["aliyuncs.com"],
    models: { fast: "qwen-turbo", strong: "qwen-plus" },
    bakeConcurrency: 3,
    thinking: "qwen",
  },
  {
    id: "openai",
    label: "OpenAI",
    baseUrl: "https://api.openai.com/v1",
    hosts: ["openai.com"],
    models: { fast: "gpt-4.1-mini", strong: "gpt-4.1" },
    bakeConcurrency: 3,
    thinking: "openai",
  },
  {
    id: "kimi",
    label: "月之暗面 Kimi",
    short: "Kimi",
    baseUrl: "https://api.moonshot.cn/v1",
    hosts: ["moonshot.cn", "moonshot.ai"],
    models: { fast: "kimi-k2-turbo-preview", strong: "kimi-k2-0711-preview" },
    bakeConcurrency: 3,
    thinking: "none",
  },
  {
    id: "zhipu",
    label: "智谱 GLM",
    baseUrl: "https://open.bigmodel.cn/api/paas/v4",
    hosts: ["bigmodel.cn"],
    models: { fast: "glm-4.5-flash", strong: "glm-4.6" },
    bakeConcurrency: 3,
    thinking: "none",
  },
  {
    id: "siliconflow",
    label: "硅基流动",
    baseUrl: "https://api.siliconflow.cn/v1",
    hosts: ["siliconflow.cn"],
    models: null,
    bakeConcurrency: 3,
    thinking: "none",
  },
];

// 界面下拉的供应商预设（client.js 转出给渲染层，本机调试地址由界面自加）。
// short 是芯片场景的短名（添加墨行一行五个时全名放不下才需要）。
export const PROVIDER_PRESETS = PROVIDERS.map(({ id, label, short, baseUrl }) => ({ id, label, short, baseUrl }));

function hostOf(rawUrl) {
  const raw = String(rawUrl ?? "").trim();
  try {
    return new URL(raw).hostname.toLowerCase();
  } catch {
    // 无协议的裸主机名按主机处理（与旧版正则兜底行为对齐）；带路径的一律不认。
    if (raw && !raw.includes("://") && !raw.includes("/")) return raw.toLowerCase();
    return "";
  }
}

function providerOf(baseUrl) {
  const host = hostOf(baseUrl);
  if (!host) return null;
  return (
    PROVIDERS.find((provider) =>
      provider.hosts.some((suffix) => host === suffix || host.endsWith("." + suffix)),
    ) ?? null
  );
}

// 输出上限参数名（百炼文档：max_tokens 即将废弃，新接入用 max_completion_tokens；
// DeepSeek 两侧同义，沿用 max_tokens）。
export function outputLimitParamFor(baseUrl) {
  return isQwenBaseUrl(baseUrl) ? "max_completion_tokens" : "max_tokens";
}

// 官方输出上限：截断重试时按模型自动取官方最大输出。已知档位来自厂商文档；
// 版本会漂——端点若拒绝（400 带上限说明），客户端按报错值自愈重试并记住该
// 模型的实际上限，所以「估高」是安全的。
const VENDOR_DEFAULT_OUTPUT_TOKENS = 8192;

export function maxOutputTokensFor(model) {
  const name = String(model ?? "").toLowerCase();
  if (/qwen3-max/.test(name)) return 32768;
  if (/qwen3-\d+[a-z]/.test(name)) return 16384;
  return VENDOR_DEFAULT_OUTPUT_TOKENS;
}

const VENDOR_BAKE_CONCURRENCY = Object.freeze({ deepseek: 4, qwen: 3 });

export function recommendedBakeConcurrency(baseUrl) {
  const provider = providerOf(baseUrl);
  if (provider?.bakeConcurrency) return provider.bakeConcurrency;
  return VENDOR_BAKE_CONCURRENCY.deepseek;
}

// 首配代选的推荐笔杆：试墨成功后自动填进空槽，已有值不覆盖。模型名随厂商
// 迭代会漂——只是代选，用户随时可改；未登记推荐与未知厂商不代选。
const RECOMMENDED_MODELS = Object.freeze(
  Object.fromEntries(PROVIDERS.filter((p) => p.models).map((p) => [p.id, p.models])),
);

export function recommendedModelsFor(baseUrl) {
  const provider = providerOf(baseUrl);
  if (!provider) return null;
  return RECOMMENDED_MODELS[provider.id] ?? null;
}

export function isDeepSeekBaseUrl(baseUrl) {
  return providerOf(baseUrl)?.id === "deepseek";
}

// 阿里千问（百炼）:dashscope.aliyuncs.com 及各地域/业务空间专属域名
//（如 {WorkspaceId}.cn-beijing.maas.aliyuncs.com、dashscope-us 等）都在
// aliyuncs.com 之下——按阿里云域名整体识别,路径不限 compatible-mode。
export function isQwenBaseUrl(baseUrl) {
  return providerOf(baseUrl)?.id === "qwen";
}

export function isKnownProviderBaseUrl(baseUrl) {
  return providerOf(baseUrl) != null;
}

// 凭证标签:注册表给中文名,其余(本机调试地址)兜底显示主机名。
export function providerLabel(baseUrl) {
  const provider = providerOf(baseUrl);
  if (provider) return provider.label;
  const host = hostOf(baseUrl);
  return host || "自定义接口";
}

// DeepSeek:思考参数只对支持思考的模型下发。白名单之外的模型静默不发:
// 开关静默失效,不报错。
export function supportsThinking(model) {
  return /v4|reasoner|chat/i.test(String(model ?? ""));
}

// 千问:enable_thinking 只对混合思考模型有意义(qwen3 系)。其余 qwen 模型
// 静默不发——发错参数会吃 400。
function supportsQwenThinking(model) {
  return /qwen3/i.test(String(model ?? ""));
}

// OpenAI:reasoning_effort 只对推理系模型(o1/o3/o4/gpt-5)有意义。
function supportsOpenAIThinking(model) {
  return /\bo[134]\b|gpt-5/i.test(String(model ?? ""));
}

// 归一化层:一个端点一次请求的思考参数与配套剥离标志。
// - thinking=true:DeepSeek 发 reasoning_effort(快槽 low / 强槽 high);千问发
//   enable_thinking:true;OpenAI 推理系同发 reasoning_effort。思考模式下
//   temperature 与 max_tokens 均不生效且会吃掉输出预算,请求体必须剥离
//   (thinkingActive=true 时调用方负责)。
// - thinking=false:DeepSeek 发 thinking:{type:"disabled"} 关闭默认思维链;
//   千问发 enable_thinking:false(qwen3 开源系默认开思考,是「生成慢」的根因);
//   其余厂商不发(没有需要关的默认思维链,乱发参数会 400)。
// - thinking 未指定(undefined):不发参数,走端点默认行为。
export function normalizeThinking({ baseUrl, thinking, slot, model }) {
  const mode = providerOf(baseUrl)?.thinking ?? "none";
  if (mode === "deepseek") {
    if (!supportsThinking(model)) return { params: {}, thinkingActive: false };
    if (thinking === true) {
      return {
        params: { reasoning_effort: slot === "strong" ? "high" : "low" },
        thinkingActive: true,
      };
    }
    if (thinking === false) {
      return { params: { thinking: { type: "disabled" } }, thinkingActive: false };
    }
    return { params: {}, thinkingActive: false };
  }
  if (mode === "qwen") {
    if (!supportsQwenThinking(model)) return { params: {}, thinkingActive: false };
    if (thinking === true) {
      return { params: { enable_thinking: true }, thinkingActive: true };
    }
    if (thinking === false) {
      return { params: { enable_thinking: false }, thinkingActive: false };
    }
    return { params: {}, thinkingActive: false };
  }
  if (mode === "openai") {
    if (!supportsOpenAIThinking(model)) return { params: {}, thinkingActive: false };
    if (thinking === true) {
      return {
        params: { reasoning_effort: slot === "strong" ? "high" : "low" },
        thinkingActive: true,
      };
    }
    return { params: {}, thinkingActive: false };
  }
  return { params: {}, thinkingActive: false };
}
