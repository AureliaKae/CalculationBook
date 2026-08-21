// 供应商层（2026-08-17 起双厂商）：DeepSeek 与阿里千问（百炼 DashScope 的
// OpenAI 兼容接口）。思考参数按厂商语义归一化：DeepSeek 走 reasoning_effort /
// thinking:{type}，千问走顶层 enable_thinking（混合思考模型）；两家属默认
// max_tokens=4096，length 截断统一按 8192 重试一次。其余地址一律不发厂商参数，
// 客户端保持通用兼容，由设置入口（main.js 白名单 + 凭证迁移过滤）保证运行时
// 只可能配置这两家。

export const DEEPSEEK_BASE_URL = "https://api.deepseek.com";
export const QWEN_BASE_URL = "https://dashscope.aliyuncs.com/compatible-mode/v1";

// 输出上限参数名（百炼文档：max_tokens 即将废弃，新接入用 max_completion_tokens；
// DeepSeek 两侧同义，沿用 max_tokens）。
export function outputLimitParamFor(baseUrl) {
  return isQwenBaseUrl(baseUrl) ? "max_completion_tokens" : "max_tokens";
}

// 官方输出上限（2026-08-17 自动档）：截断重试时按模型自动取官方最大输出。
// 已知档位来自两厂商官方文档/模型列表；版本会漂——端点若拒绝（400 带上限说明），
// 客户端按报错值自愈重试并记住该模型的实际上限，所以「估高」是安全的。
const VENDOR_DEFAULT_OUTPUT_TOKENS = 8192;

export function maxOutputTokensFor(model) {
  const name = String(model ?? "").toLowerCase();
  if (/qwen3-max/.test(name)) return 32768;
  if (/qwen3-\d+[a-z]/.test(name)) return 16384;
  // DeepSeek 全系与 qwen 商用系（plus/turbo/max）官方输出上限均为 8192。
  return VENDOR_DEFAULT_OUTPUT_TOKENS;
}

// 烧制并发的自动档（留空时按快槽厂商取）：DeepSeek 限流按 RPM/TPM 计、
// 档位宽裕（官方示例并发 10）；百炼按模型分档限流、免费额度期更紧——保守 3。
const VENDOR_BAKE_CONCURRENCY = Object.freeze({ deepseek: 4, qwen: 3 });

export function recommendedBakeConcurrency(baseUrl) {
  if (isQwenBaseUrl(baseUrl)) return VENDOR_BAKE_CONCURRENCY.qwen;
  return VENDOR_BAKE_CONCURRENCY.deepseek;
}

// 首配代选的推荐笔杆：试墨成功后自动填进空槽，已有值不覆盖。模型名随厂商
// 迭代会漂——只是代选，用户随时可改；未知厂商（本机调试地址）不代选。
const RECOMMENDED_MODELS = Object.freeze({
  deepseek: { fast: "deepseek-chat", strong: "deepseek-chat" },
  qwen: { fast: "qwen-turbo", strong: "qwen-plus" },
});

export function recommendedModelsFor(baseUrl) {
  if (isDeepSeekBaseUrl(baseUrl)) return RECOMMENDED_MODELS.deepseek;
  if (isQwenBaseUrl(baseUrl)) return RECOMMENDED_MODELS.qwen;
  return null;
}

export function isDeepSeekBaseUrl(baseUrl) {
  const raw = String(baseUrl ?? "").trim();
  if (!raw) return false;
  try {
    // 解析主机名再匹配:https://deepseek.com 与 api.deepseek.com/v1 都算,路径不影响判定。
    return /(^|\.)deepseek\.com$/i.test(new URL(raw).hostname);
  } catch {
    return /(^|\.)deepseek\.com/i.test(raw);
  }
}

// 阿里千问（百炼）:dashscope.aliyuncs.com 及各地域/业务空间专属域名
//（如 {WorkspaceId}.cn-beijing.maas.aliyuncs.com、dashscope-us 等）都在
// aliyuncs.com 之下——按阿里云域名整体识别,路径不限 compatible-mode。
export function isQwenBaseUrl(baseUrl) {
  const raw = String(baseUrl ?? "").trim();
  if (!raw) return false;
  try {
    return /(^|\.)aliyuncs\.com$/i.test(new URL(raw).hostname);
  } catch {
    return /(^|\.)aliyuncs\.com/i.test(raw);
  }
}

export function isKnownProviderBaseUrl(baseUrl) {
  return isDeepSeekBaseUrl(baseUrl) || isQwenBaseUrl(baseUrl);
}

// 凭证标签:两家给中文名,其余(本机调试地址)兜底显示主机名。
export function providerLabel(baseUrl) {
  if (isDeepSeekBaseUrl(baseUrl)) return "DeepSeek";
  if (isQwenBaseUrl(baseUrl)) return "阿里千问";
  try {
    return new URL(baseUrl).host;
  } catch {
    return "自定义接口";
  }
}

// DeepSeek:思考参数只对支持思考的模型下发(V4/reasoner 系)。白名单之外的
// DeepSeek 模型静默不发:开关静默失效,不报错。
export function supportsThinking(model) {
  return /v4|reasoner|chat/i.test(String(model ?? ""));
}

// 千问:enable_thinking 只对混合思考模型有意义(qwen3 系)。其余 qwen 模型
// 静默不发——发错参数会吃 400。
function supportsQwenThinking(model) {
  return /qwen3/i.test(String(model ?? ""));
}

// 归一化层:一个端点一次请求的思考参数与配套剥离标志。
// - thinking=true:DeepSeek 发 reasoning_effort(快槽 low / 强槽 high);千问发
//   enable_thinking:true。思考模式下 temperature 与 max_tokens 均不生效且会
//   吃掉输出预算,请求体必须剥离(thinkingActive=true 时调用方负责)。
// - thinking=false:DeepSeek 发 thinking:{type:"disabled"} 关闭默认思维链;
//   千问发 enable_thinking:false(qwen3 开源系默认开思考,是「生成慢」的根因)。
// - thinking 未指定(undefined):不发参数,走端点默认行为。
export function normalizeThinking({ baseUrl, thinking, slot, model }) {
  if (isDeepSeekBaseUrl(baseUrl)) {
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
  if (isQwenBaseUrl(baseUrl)) {
    if (!supportsQwenThinking(model)) return { params: {}, thinkingActive: false };
    if (thinking === true) {
      return { params: { enable_thinking: true }, thinkingActive: true };
    }
    if (thinking === false) {
      return { params: { enable_thinking: false }, thinkingActive: false };
    }
    return { params: {}, thinkingActive: false };
  }
  return { params: {}, thinkingActive: false };
}
