// 烧制失败的原因只有几类，说清楚「为什么」和「下一步做什么」比抛原始报错有用。
// 这里刻意不 import electron，主进程只把 { name, status, message } 递过来，方便单测。

export function classifyBakeError({ name = "", status, message = "" } = {}) {
  if (name === "BakeCancelledError") {
    return {
      kind: "cancelled",
      title: "已取消烧制",
      advice: "已完成的批次留在缓存里，重新烧制会接着上次的断点。",
      retryable: false,
    };
  }

  if (name === "ConfigError" || message.includes("API 凭证") || message.includes("请先在设置里")) {
    return {
      kind: "credentials",
      title: "还没有可用的 API 凭证",
      advice: "到设置里为对应档位选一条填好 Key 的凭证，再回来烧制。",
      retryable: false,
    };
  }

  if (status === 401 || status === 403) {
    return {
      kind: "auth",
      title: "接口拒绝了这把 Key",
      advice: "检查设置里的 Key 是否过期或抄漏了字符。",
      retryable: false,
    };
  }

  if (status === 413) {
    return {
      kind: "payload",
      title: "请求太大，接口拒绝了",
      advice: "这本书的粗读批次太大：换一个上下文更长的模型，或换更强模型再烧一次。",
      retryable: false,
    };
  }

  if (status === 429) {
    return {
      kind: "quota",
      title: "被限流或额度不足",
      advice: message.includes("insufficient_quota")
        ? "这条凭证的额度用完了，换一条再试。"
        : "等一会儿再重试，或者换一条凭证分担。",
      retryable: !message.includes("insufficient_quota"),
    };
  }

  // DeepSeek 对余额耗尽返回 HTTP 402:重试无意义,直说去充值/换 Key。
  if (status === 402) {
    return {
      kind: "balance",
      title: "这条凭证的余额用完了",
      advice: "到 DeepSeek 平台充值，或换一条还有额度的凭证再试。",
      retryable: false,
    };
  }

  if (typeof status === "number" && status >= 500) {
    return {
      kind: "server",
      title: `接口暂时不可用（${status}）`,
      advice: "对方服务在抖，稍后重试即可，已烧好的批次不会白费。",
      retryable: true,
    };
  }

  if (name === "TypeError" || name === "TimeoutError" || name === "AbortError") {
    return {
      kind: "network",
      title: "没能连上接口",
      advice: "确认网络与 Base URL 是否可达，然后重试。",
      retryable: true,
    };
  }

  if (name === "WorldRepairError") {
    return {
      kind: "repair",
      title: "世界档案没能补齐",
      advice: "多半是模型这次答得太随意，重试一次通常就好；老是失败就换个更强的模型。",
      retryable: true,
    };
  }

  return {
    kind: "unknown",
    title: "烧制中断了",
    advice: message || "重试一次；若反复失败，把这段报错告诉开发者。",
    retryable: true,
  };
}

// 回合失败的错误分类:与烧制共用同一套规则,但文案面向「这一回合没生成出来」的场景。
// 渲染层 catch 到错误后用它拼「标题:怎么办」,不再把模型原文直接甩给玩家。
// 认不出的普通业务错误(如「这本书没有进度」)返回 null,调用方回退到原文。
export function classifyTurnError(problem = {}) {
  const { name = "", status, message = "" } = problem ?? {};
  const looksLikeModelError =
    Number.isFinite(status) ||
    String(message).startsWith("Model API ") ||
    name === "ModelApiError" ||
    name === "TypeError" ||
    name === "TimeoutError" ||
    name === "AbortError" ||
    name === "ConfigError" ||
    message.includes("API 凭证") ||
    message.includes("请先在设置里");
  if (!looksLikeModelError) return null;
  if (name === "AbortError") {
    return { title: "已停下这一回合", advice: "再选一次就好，刚才的回合没有生效。", retryable: true };
  }
  const classified = classifyBakeError({ name, status, message });
  switch (classified.kind) {
    case "balance":
      return { title: classified.title, advice: classified.advice, retryable: false };
    case "auth":
      return { title: "接口拒绝了这把 Key", advice: "检查设置里的 Key 是否过期或抄漏了字符。", retryable: false };
    case "quota":
      return { title: "接口限流或额度不足", advice: classified.advice, retryable: classified.retryable };
    case "server":
      return { title: classified.title, advice: "对方服务在抖，稍后重试即可。", retryable: true };
    case "network":
      return { title: classified.title, advice: classified.advice, retryable: true };
    case "credentials":
      return { title: classified.title, advice: classified.advice, retryable: false };
    case "payload":
      return { title: classified.title, advice: classified.advice, retryable: false };
    default:
      return {
        title: "这一回合没能生成出来",
        advice: message || "再试一次；若反复失败，把这段报错告诉开发者。",
        retryable: true,
      };
  }
}
