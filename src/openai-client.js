import { buildNarrativeMessages, buildStructureMessages, buildOpeningMessages, buildConsistencyCheckMessages, buildIntentOptionsMessages, buildArcPlanMessages, buildArcDriftMessages, buildArcRetrospectiveMessages } from "./prompt.js";
import { normalizeThinking, maxOutputTokensFor, outputLimitParamFor } from "./providers.js";
import { submitTurnTool, submitOptionsTool, submitArcTool } from "./turn-schema.js";
import {
  submitConsistencyTool,
  submitDriftTool,
  submitRetrospectiveTool,
  submitObservationTool,
  submitOpeningTool,
  submitEpilogueTool,
  submitDraftTool,
  submitRepairedTurnTool,
} from "./structured-tools.js";
import { tolerantParse } from "./json-tolerant.js";
import { collectStreamText, readPlainStream } from "./stream-protocol.js";
import { buildCreationDraftMessages } from "./world-creation.js";

// 快模型与强模型各自是一个完整端点:两条凭证可以指向不同的 DeepSeek 模型。
function validateEndpoint(endpoint, name) {
  if (!endpoint?.baseUrl || !endpoint.apiKey || !endpoint.model) {
    const error = new Error(`Model config requires ${name}.baseUrl, ${name}.apiKey and ${name}.model`);
    // 结构化错误名：烧制失败分类按名字识别，不再依赖中文文案子串。
    error.name = "ConfigError";
    throw error;
  }
}

function validateConfig(config) {
  validateEndpoint(config?.fast, "fast");
  validateEndpoint(config?.strong, "strong");
}

function apiUrl(baseUrl, path) {
  const normalized = String(baseUrl ?? "").replace(/\/+$/, "");
  return normalized.endsWith("/v1") ? `${normalized}${path}` : `${normalized}/v1${path}`;
}

function chatCompletionsUrl(baseUrl) {
  return apiUrl(baseUrl, "/chat/completions");
}

// 脱敏：服务商错误体里可能回显密钥（如 "Incorrect API key provided: sk-…"）。
// 在错误消息进入 UI/日志前把疑似密钥串替换掉，避免明文泄漏。
function redactSecrets(text) {
  if (typeof text !== "string") return String(text ?? "");
  return String(text)
    .replace(/\bsk-[A-Za-z0-9_-]{8,}\b/g, "sk-***")
    .replace(/(Bearer\s+)[A-Za-z0-9._~+/=-]+/gi, "$1***");
}

class ModelApiError extends Error {
  constructor(status, body, headers) {
    super(`Model API ${status}: ${redactSecrets(body)}`);
    this.status = status;
    this.retryAfter = headers?.get("retry-after");
  }
}

// 内容级失败：模型返回空内容或无法解析的 JSON。与传输层错误区分开，
// 让 completeFast 知道「这个形状没吐出可用结果，该换一种请求形状再试」。
class ModelContentError extends Error {
  constructor(message) {
    super(message);
    this.name = "ModelContentError";
  }
}

// 取证：解析失败时把失败点附近的原文一起带进报错。长 JSON 的烂尾几乎都在
// 文档末尾，只印开头 200 字看不到任何线索。V8 的解析错误格式是
// "… at position N (line L column C)"，position 相对 tolerantParse 的候选切片
// （通常就从文档开头起，前置旁白会造成少量偏移，取证够用）；取不到位置时退回末尾。
function failureNeighborhood(error, content) {
  const match = /position (\d+)/.exec(error.message);
  const position = match ? Number(match[1]) : NaN;
  if (Number.isFinite(position)) {
    return `…${content.slice(Math.max(0, position - 160), position + 80)}…`;
  }
  return `…${content.slice(-300)}…`;
}

export function retryDelay(error, attempt) {
  // DeepSeek 对过载/配额不足返回 429/503,遵循 retry-after;缺头时用指数退避 + 抖动,
  // 避免并发烧制时多个请求同步重试、再次撞限。官方未发布硬性 QPS 限流,此处不做令牌桶。
  // retry-after 头缺失时为 null：Number(null) === 0 会命中零延迟分支，
  // 让 5xx 的指数退避形同虚设、对着故障端点狂轰。先判存在再取值。
  if (error.retryAfter != null) {
    const seconds = Number(error.retryAfter);
    if (Number.isFinite(seconds) && seconds >= 0) return Math.min(seconds * 1000, 15_000);
    const date = Date.parse(error.retryAfter);
    // HTTP 日期分支同样封顶 15s:恶意的远期日期(Fri, 01 Jan 20xx)会把调用方
    // 挂进不可中断的长眠,烧制/回合全部冻住。两个分支必须同一上限。
    if (Number.isFinite(date)) return Math.min(Math.max(0, date - Date.now()), 15_000);
  }
  return Math.min(15_000, 500 * 2 ** attempt) * (0.75 + Math.random() * 0.5);
}

function isRetryable(error) {
  if (error instanceof ModelApiError) {
    // DeepSeek 余额不足(insufficient_quota)重试无意义,直接暴露给用户;其余 429/503 按负载退避。
    if (error.status === 429 && /insufficient_quota/i.test(error.message)) return false;
    // 402 = Insufficient Balance:DeepSeek 对余额用尽的响应码,重试同样无意义。
    if (error.status === 402) return false;
    return error.status === 408 || error.status === 429 || error.status >= 500;
  }
  return error?.name === "TypeError" || error?.name === "TimeoutError";
}

// 请求形状是否值得换一种再试：内容级失败，或「这个形状不被支持」类的 4xx。
function isShapeDegradable(error) {
  if (error instanceof ModelContentError) return true;
  if (error instanceof ModelApiError) {
    // 404 是端点/路径写错，换形状无济于事，直接抛。
    if (error.status === 404) return false;
    if (
      error.status >= 400 &&
      error.status < 500 &&
      ![401, 403, 408, 429].includes(error.status)
    ) {
      // 400/422 语义很杂：只有明确指向「请求形状/参数不被支持」时才值得换形状。
      return /response_format|format|shape|parameter|stream|流式|不支持|not support/i.test(error.message);
    }
    return false;
  }
  return false;
}

const sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

// 退避等待的可取消版：重试间隔最长 15 秒，若用户在此期间点了「停一下」，
// 立即以 AbortError 结束而不是睡满——取消延迟不再被退避窗口拖住。
const sleepInterruptible = (milliseconds, signal) =>
  new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason ?? new DOMException("This operation was aborted", "AbortError"));
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, Math.max(0, milliseconds));
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal.reason ?? new DOMException("This operation was aborted", "AbortError"));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });

export async function fetchModels({
  baseUrl,
  apiKey,
  timeoutMs = 20_000,
  fetchImpl = globalThis.fetch,
}) {
  if (!baseUrl || !apiKey) {
    const error = new Error("请先填写 API 地址与 Key");
    error.name = "ConfigError";
    throw error;
  }
  const response = await fetchImpl(apiUrl(baseUrl, "/models"), {
    headers: { Authorization: `Bearer ${apiKey}`, Accept: "application/json" },
    signal: AbortSignal.timeout(timeoutMs),
    redirect: "error",
  });
  if (!response.ok) {
    const body = (await response.text()).slice(0, 300);
    throw new Error(`模型列表接口 ${response.status}：${redactSecrets(body) || response.statusText}`);
  }
  let payload;
  try {
    payload = await response.json();
  } catch (error) {
    throw new Error("模型列表接口返回了非 JSON 内容");
  }
  const models = (Array.isArray(payload.data) ? payload.data : [])
    .map((item) => (typeof item === "string" ? item : item?.id))
    .filter((id) => typeof id === "string" && id);
  if (!models.length) throw new Error("该接口没有返回任何可用模型");
  return [...new Set(models)].sort((left, right) => left.localeCompare(right));
}


export class OpenAiCompatibleClient {
  constructor({
    config,
    fetchImpl = globalThis.fetch,
    onNarrative,
    onDiscardNarrative,
    onUsage,
  }) {
    this.onUsage = typeof onUsage === "function" ? onUsage : null;
    validateConfig(config);
    if (typeof fetchImpl !== "function") throw new Error("A fetch implementation is required");
    this.config = { timeoutMs: 60_000, strongTimeoutMs: 300_000, maxRetries: 3, maxTokens: "", ...config };
    this.fetch = fetchImpl;
    // 端点报错自愈学到的每模型输出上限（model → cap），估高的官方档位被修正后记住。
    this.learnedMaxTokens = new Map();
    this.onNarrative = onNarrative;
    this.onDiscardNarrative = onDiscardNarrative;
  }

  // DeepSeek 思考归一化:一个端点一次请求的思考参数与剥离标志。
  // thinkingActive 为 true(开思考)时请求体不得再带 temperature 与 max_tokens——
  // 思考模式下这两项不生效,而且 max_tokens 会先吃掉推理预算把正文砍成残卷。
  #thinkingExtras(endpoint) {
    return normalizeThinking({
      baseUrl: endpoint.baseUrl,
      thinking: endpoint.thinking,
      slot: endpoint.slot,
      model: endpoint.model,
    });
  }

  // 双请求协议：叙事请求。模型只写小说正文，不含任何分隔符或 JSON——
  // 流式逐块交给渲染层，结束时返回全文。
  async generateStory({ context, choice, check, keyTurn = false, endingTurn = false, timeoutMs, onNarrative, signal, rewriteNote = "" }) {
    const heavy = Boolean(keyTurn || endingTurn);
    return this.#streamPlain({
      endpoint: heavy ? this.config.strong : this.config.fast,
      messages: buildNarrativeMessages({ context, choice, check, keyTurn, rewriteNote }),
      onNarrative: onNarrative ?? this.onNarrative,
      signal,
      timeoutMs: timeoutMs ?? (heavy ? this.config.strongTimeoutMs : this.config.timeoutMs),
    });
  }

  // 双请求协议：结构请求。首选 function calling（API 层按 JSON Schema 保证结构合法，
  // 从机制上消除 options 缺失/非法 JSON 这类随机违约）；服务商不支持工具或模型拒不调用时，
  // 回退到 json_object 老路。strong=true 走强槽(拍板:节拍升级——转折/收束节拍的选项)。
  async generateStructure({ narrative, context, choice, check, attempt = 0, timeoutMs, signal, correctionNote = "", strong = false }) {
    const messages = buildStructureMessages({ narrative, context, choice, check, attempt, correctionNote });
    try {
      return await this.#functionJson(messages, submitTurnTool(), {
        timeoutMs,
        signal,
        ...(strong ? { endpoint: this.config.strong } : {}),
      });
    } catch (error) {
      if (!isShapeDegradable(error)) throw error;
      return strong
        ? this.completeStrong(messages, { timeoutMs, signal })
        : this.completeFast(messages, { timeoutMs, signal });
    }
  }

  // 意图先行(拍板 R3):玩家声明方向后,只用快模型围绕意图重生成当前处境的选项。
  // 不产出回合数据;形状坏/拒不调用时抛错,由引擎回落兜底选项。
  async generateIntentOptions({ context, intent, correctionNote = "", timeoutMs, signal }) {
    const messages = buildIntentOptionsMessages({ context, intent, correctionNote });
    const result = await this.#functionJson(messages, submitOptionsTool(), {
      timeoutMs: timeoutMs ?? 60_000,
      signal,
    });
    if (!Array.isArray(result?.options) || !result.options.length) {
      throw new Error("Intent options response lacks an options array");
    }
    return result.options;
  }

  // 弧线导演(拍板:剧情层叠加):三个低频调用。规划走强槽 function calling
  // (#functionJson 恒关思考,强槽同样适用);漂移与回顾走快槽纯 JSON。
  // 引擎侧持有全部失败兜底(规划失败→即兴,漂移失败→keep,回顾失败→代码拼句)。
  async generateArcPlan({ world, state, history, arcHistory = [], timeoutMs, signal }) {
    const messages = buildArcPlanMessages({ world, state, history, arcHistory });
    return this.#functionJson(messages, submitArcTool(), {
      timeoutMs: timeoutMs ?? 120_000,
      signal,
      endpoint: this.config.strong,
    });
  }

  async checkArcDrift({ arc, state, history, timeoutMs, signal }) {
    const result = await this.#functionOrFallback(
      buildArcDriftMessages({ arc, state, history }),
      submitDriftTool(),
      { timeoutMs: timeoutMs ?? 30_000, signal },
    );
    return result ?? null;
  }

  async generateArcRetrospective({ arc, history, styleSamples = [], timeoutMs, signal }) {
    const result = await this.#functionOrFallback(
      buildArcRetrospectiveMessages({ arc, history, styleSamples }),
      submitRetrospectiveTool(),
      { timeoutMs: timeoutMs ?? 30_000, signal },
    );
    return result ?? null;
  }


  // 身份一致校验:快模型核对叙事/选项是否符合玩家身份能力、在场原著人物人设与世界观。
  // 只报实质违例;客户端没有该方法(如 mock)时引擎跳过校验。
  async checkIdentityConsistency({ narrative, options, capabilities, characters, worldview, canonNow, canonUpcoming, canonHorizon = [], storyClock, storyClockPrev, signal, timeoutMs = 60_000 }) {
    const result = await this.#functionOrFallback(
      buildConsistencyCheckMessages({ narrative, options, capabilities, characters, worldview, canonNow, canonUpcoming, canonHorizon, storyClock, storyClockPrev }),
      submitConsistencyTool(),
      { timeoutMs, signal },
    );
    return result ?? null;
  }

  // 行为自适应观察者:每满 10 回合调用一次,只允许提议受控微调。
  async observePlayer({ turn, player, current, recentTurns, timeoutMs = 60_000, signal }) {
    const result = await this.#functionOrFallback(
      [
        {
          role: "system",
          content:
            "你是游戏节奏观察者。根据玩家近期的选择与成败,只返回 JSON:{\"difficultyBias\":-2 到 2 的整数,\"optionFlavor\":\"dangerous\"|\"cautious\"|\"neutral\",\"pacing\":\"faster\"|\"slower\"|\"neutral\"}。difficultyBias 为正=玩家太顺需要加压,为负=玩家连连受挫需要减压,0 或省略=不动;optionFlavor 是下一步选项的风格倾向;pacing 是叙事节奏。只能改这三项,不得输出其他字段。",
        },
        {
          role: "user",
          content: JSON.stringify({ turn, player, current, recentTurns }),
        },
      ],
      submitObservationTool(),
      { timeoutMs, signal },
    );
    return result;
  }

  async repairOptions({ narrative, options, context, missing, signal }) {
    const repaired = await this.#functionOrFallback(
      [
        {
          role: "system",
          content:
            "你是互动小说选项修复器。保留已定正文和结果，只返回 JSON 数组，包含 2-10 个选项。选项必须彼此独立、符合角色身份/性格/已知事实，包含 axis=exit，并覆盖错误说明中的紧迫事项。不得显示概率或内部数值。",
        },
        {
          role: "user",
          content: JSON.stringify({
            narrative,
            options,
            missing,
            player: context.state.player,
            locationId: context.state.locationId,
            knownCharacters: context.state.discoveredCharacterIds,
            attributes: context.world.attributes.map((item) => item.id),
            dominantSystems: context.dominantSystems,
          }),
        },
      ],
      submitOptionsTool(),
      { signal },
    );
    return Array.isArray(repaired) ? repaired : repaired.options;
  }

  // 原创实体草稿：输入用户意图 + 世界观摘要 + 文风，输出符合原著的实体设定草稿
  // 与一句世界观符合度自评。短字段手打、长描述代写（软校验交给模型，硬校验在 world-creation）。
  async generateEntityDraft({ kind, intent, world, fields, timeoutMs }) {
    const messages = buildCreationDraftMessages({ kind, intent, world, fields });
    return this.#functionOrFallback(messages, submitDraftTool(), { timeoutMs });
  }

  async generateOpening({ world, state, successor = false, styleSamples = [], pastLifeFacts = [], rewriteNote = "" }) {
    const messages = buildOpeningMessages({ world, state, successor, styleSamples, pastLifeFacts, rewriteNote });
    const result = await this.#functionOrFallback(messages, submitOpeningTool(), {
      timeoutMs: 180_000,
      endpoint: this.config.strong,
    });
    return result.opening;
  }

  async generateEpilogue({ world, state, history, ending, styleSamples = [], rewriteNote = "", signal }) {
    const sampleBlock = styleSamples.length
      ? `\n以下原著段落是文风范本，模仿其语感与标点习惯，不得抄袭或复述情节：\n${styleSamples.join("\n---\n")}`
      : "";
    const result = await this.#functionOrFallback(
      [
        {
          role: "system",
          content:
            "你是互动小说命运终章叙事器。根据已提交事实写 500-900 字中文终章，只返回 JSON：{\"epilogue\":\"...\"}。文风必须贴着原著：遵守给定 style 的人称、时态、句长与意象习惯，仿照文风范本的语感。只能回顾真实发生的选择、关系和代价，不得补造结果。死亡终章必须承认死亡；阶段终章应收束当前目标但保留世界后果。终章中玩家角色的能力与身份必须一致：应有的能力可以回望，做不到的事不得写成做过。",
        },
        {
          role: "user",
          content: JSON.stringify({
            title: world.title,
            ending,
            player: state.player,
            goals: state.personalGoals,
            bonds: state.bonds,
            memberships: state.factionMemberships,
            pressures: state.survivalPressures,
            style: world.style,
            recentTurns: history.slice(-5).map(({ narrative, choice }) => ({
              narrative,
              choice: choice?.text,
            })),
          }) + sampleBlock + (rewriteNote ? `\n${rewriteNote}` : ""),
        },
      ],
      submitEpilogueTool(),
      { timeoutMs: 300_000, endpoint: this.config.strong, signal },
    );
    return result.epilogue;
  }

  async repairResponse({ narrative, payload, error, context, check, signal }) {
    const repaired = await this.#functionOrFallback(
      [
      {
        role: "system",
        content:
          "你是回合 JSON 修复器。只修复给定 JSON，使其满足错误说明和上下文约束。不得改写正文，不得改变既定判定，不得添加上下文中不存在的 ID。返回完整 JSON 对象，不要解释。",
      },
      {
        role: "user",
        content: JSON.stringify({
          payload,
          error: error.message,
          adjudication: check.result,
          allowed: {
            stats: context.world.stats.map((item) => item.id),
            attributes: context.world.attributes.map((item) => item.id),
            characters: context.world.characters.map((item) => item.id),
            locations: context.world.locations.map((item) => item.id),
          },
        }),
      },
      ],
      submitRepairedTurnTool(),
      { signal },
    );
    return { narrative, ...repaired };
  }

  async completeFast(messages, options = {}) {
    const attempts = [
      { stream: false, response_format: { type: "json_object" } },
      { stream: false },
      { stream: true },
    ];
    // 三种形状共享一份请求预算（含传输重试与内容重问）：端点持续故障时最多
    // 打 maxAttempts 次，而不是每种形状各自用满重试与重问（最坏 ~24 次）。
    const attemptBudget = { used: 0, max: options.maxAttempts ?? 8 };
    let lastError;
    for (const shape of attempts) {
      try {
        // 结构类请求永远关思考(烧制/摘要/判定/修复):速度与成本优先,JSON 服从性更高。
        return await this.#json(messages, shape, { ...options, attemptBudget, thinking: false });
      } catch (error) {
        lastError = error;
        // 内容级失败（空内容/非法 JSON）与「形状不被支持」的 4xx 都换一种形状再试；
        // 鉴权失败、限流与服务端故障换多少种形状都一样，别白白多打两次注定失败的请求。
        if (!isShapeDegradable(error)) throw error;
      }
    }
    throw lastError;
  }

  async completeStrong(messages, options = {}) {
    return this.#json(
      messages,
      { stream: false, response_format: { type: "json_object" } },
      {
        ...options,
        endpoint: this.config.strong,
        attemptBudget: { used: 0, max: options.maxAttempts ?? this.config.maxRetries + 1 },
      },
    );
  }

  // 拍板:所有模型的结构化请求都走 function calling(API 层按 JSON Schema 保证结构合法)。
  // 公共入口:快槽/强槽各自一套,服务商不支持工具或模型拒不调用时自动退回 json_object 老路。
  async completeFastTool(messages, tool, options = {}) {
    return this.#functionOrFallback(messages, tool, options);
  }

  async completeStrongTool(messages, tool, options = {}) {
    return this.#functionOrFallback(messages, tool, { ...options, endpoint: this.config.strong });
  }

  // 用量上报（2026-08-19）：usage 形状各异（prompt_tokens/prompt_tokens_details.
  // cached_tokens 等），只取两个主数;没有 usage 的响应静默跳过。
  #reportUsage(endpoint, usage) {
    if (!this.onUsage || !usage || typeof usage !== "object") return;
    const promptTokens = Number(usage.prompt_tokens);
    const completionTokens = Number(
      usage.completion_tokens ?? usage.completion_tokens_details?.total_tokens,
    );
    if (!Number.isFinite(promptTokens) && !Number.isFinite(completionTokens)) return;
    try {
      this.onUsage({
        model: endpoint?.model ?? "",
        promptTokens: Number.isFinite(promptTokens) ? promptTokens : 0,
        completionTokens: Number.isFinite(completionTokens) ? completionTokens : 0,
      });
    } catch {}
  }

  async #functionOrFallback(messages, tool, options = {}) {
    try {
      return await this.#functionJson(messages, tool, options);
    } catch (error) {
      if (!isShapeDegradable(error)) throw error;
      return this.#json(
        messages,
        { stream: false, response_format: { type: "json_object" } },
        {
          ...options,
          thinking: false,
          attemptBudget: options.attemptBudget ?? { used: 0, max: this.config.maxRetries + 1 },
        },
      );
    }
  }

  // 该模型学到的输出上限（端点报错自愈时记下，估高的官方档位会被修正）。
  #effectiveMaxTokens(model) {
    return this.learnedMaxTokens.get(model) ?? maxOutputTokensFor(model);
  }

  // 从 400 报错里解析端点声明的 max_tokens 上限（中英文口径都认）。
  #capFromErrorMessage(message) {
    const text = String(message ?? "");
    const patterns = [
      /max(?:_completion)?_tokens[^\d]{0,60}?(\d{4,6})/i,
      /(?:不能超过|不得超过|不能大于|上限为|最大为|at most|less than or equal to)[^\d]{0,16}(\d{4,6})/i,
      /(\d{4,6})[^\d]{0,16}(?:是|为)?(?:最大|上限|maximum)/i,
    ];
    for (const pattern of patterns) {
      const hit = text.match(pattern);
      if (!hit) continue;
      const value = Number(hit[1]);
      if (Number.isFinite(value) && value >= 256 && value <= 200_000) return value;
    }
    return null;
  }

  async #json(messages, shape, options) {
    const endpoint = options.endpoint ?? this.config.fast;
    // options.thinking 允许调用方覆盖端点开关(completeFast 强制关思考);
    // completeStrong(开场/终章)不传,跟随强槽开关。
    const thinking = this.#thinkingExtras({ ...endpoint, thinking: options.thinking ?? endpoint.thinking });
    // 请求预算跨「重问递归」共享：内容失败的重问会递归调用 #json 并重置本地
    // attempt 计数，预算若不共享，一次调用最坏会打出十几个注定失败的请求。
    const budget = options.attemptBudget ?? { used: 0, max: this.config.maxRetries + 1 };
    // 最大输出上限（2026-08-17 自动档）：用户留空 = 平时不发限制；截断重试按
    // 官方档位自动取（学到的上限优先）。显式值高于已学上限时按上限收口，
    // 免吃 400；开思考时不发 max_tokens。
    const requestedMaxTokens = !thinking.thinkingActive
      ? (options.forcedMaxTokens ?? this.config.maxTokens)
      : "";
    const learnedCap = this.learnedMaxTokens.get(endpoint.model);
    const effectiveMaxTokens =
      requestedMaxTokens && learnedCap && Number(requestedMaxTokens) > learnedCap
        ? learnedCap
        : requestedMaxTokens;
    let content;
    // 取证：记录本次响应的结束方式（stop/length/...）。流式与非流式一致:
    // length 截断先按 8192 重试一次,重试仍截断才判失败,报错带出 finish 证据。
    let finishReason = null;
    let response;
    let attempt = 0;
    while (true) {
      try {
        budget.used += 1;
        const timeoutSignal = AbortSignal.timeout(options.timeoutMs ?? this.config.timeoutMs);
        response = await this.fetch(chatCompletionsUrl(endpoint.baseUrl), {
          method: "POST",
          headers: {
            Authorization: `Bearer ${endpoint.apiKey}`,
            "Content-Type": "application/json",
            Accept: shape.stream ? "text/event-stream" : "application/json",
          },
          redirect: "error",
          body: JSON.stringify({
            model: endpoint.model,
            messages,
            ...(thinking.thinkingActive ? {} : { temperature: options.temperature ?? endpoint.temperature ?? 0.2 }),
            ...thinking.params,
            // 参数名按厂商：百炼新接入应使用 max_completion_tokens（max_tokens 已被
            // 标记废弃）；DeepSeek 沿用 max_tokens。
            ...(effectiveMaxTokens
              ? { [outputLimitParamFor(endpoint.baseUrl)]: effectiveMaxTokens }
              : {}),
            ...shape,
          }),
          signal: options.signal
            ? AbortSignal.any([options.signal, timeoutSignal])
            : timeoutSignal,
        });
        if (!response.ok) {
          const body = (await response.text()).slice(0, 500);
          throw new ModelApiError(response.status, body || response.statusText, response.headers);
        }
        // 响应体读取也在重试范围内：AbortSignal.timeout 一直绑到响应体，长响应
        // 读了一半超时会在这里抛——留在循环外就成了「无重试的裸超时」（流式），
        // 或被误判成内容错误烧完整个降级链（非流式）。
        if (shape.stream) {
          if (!response.body) throw new Error("Model API returned an empty response body");
          const usageOut = {};
          ({ content, finishReason } = await collectStreamText(response.body, { usageOut }));
          this.#reportUsage(endpoint, usageOut.usage);
        } else {
          let payload;
          try {
            payload = await response.json();
          } catch (error) {
            // 读体阶段的超时/网络中断是传输错误，按可重试处理；真的非 JSON 才是内容错误。
            if (
              error?.name === "TimeoutError" ||
              error?.name === "AbortError" ||
              error?.name === "TypeError"
            ) {
              throw error;
            }
            throw new ModelContentError("Model API returned a non-JSON response body");
          }
          this.#reportUsage(endpoint, payload.usage);
          const message = payload.choices?.[0]?.message ?? {};
          finishReason = payload.choices?.[0]?.finish_reason ?? null;
          content = message.content ?? "";
          // 思维型模型偶尔把正文写进 reasoning_content 而 content 留空。思维链文本不是
          // JSON，只有「整段看起来像 JSON 文档」时才回退，避免把思考过程喂给解析器。
          if (!content && typeof message.reasoning_content === "string") {
            content = /^\s*[{[]/.test(message.reasoning_content) ? message.reasoning_content : "";
          }
        }
        break;
      } catch (error) {
        // 上限自愈（2026-08-17 自动档）：端点 400 里声明了 max_tokens 上限时，
        // 按报错值记住并立即低档重试——官方档位估高（或用户填大）不再硬失败。
        if (
          error instanceof ModelApiError &&
          error.status === 400 &&
          effectiveMaxTokens &&
          !options.capHealed &&
          budget.used < budget.max &&
          !options.signal?.aborted
        ) {
          const cap = this.#capFromErrorMessage(error.message);
          if (cap && cap < Number(effectiveMaxTokens)) {
            this.learnedMaxTokens.set(endpoint.model, cap);
            return this.#json(messages, shape, {
              ...options,
              capHealed: true,
              forcedMaxTokens: cap,
            });
          }
        }
        if (
          !isRetryable(error) ||
          attempt >= this.config.maxRetries ||
          budget.used >= budget.max ||
          options.signal?.aborted
        ) {
          throw error;
        }
        await sleepInterruptible(retryDelay(error, attempt), options.signal);
        attempt += 1;
      }
    }

    if (finishReason === "length") {
      // max_tokens 截断的 JSON 是残卷:不直接判死,先按最大输出重试一次。
      // 提示词逐字一致,命中 DeepSeek 自动上下文缓存,输入几乎不额外计费;
      // 重试仍截断(或预算已尽)才判内容失败走降级链。
      if (!options.truncationRetried && budget.used < budget.max) {
        return this.#json(messages, shape, {
          ...options,
          truncationRetried: true,
          forcedMaxTokens: this.#effectiveMaxTokens(endpoint.model),
        });
      }
      throw new ModelContentError(
        `Model response was truncated (finish_reason=length) after retrying with max_tokens=${this.#effectiveMaxTokens(endpoint.model)}`,
      );
    }
    if (!content) {
      // 空内容与非法 JSON 同等对待：再问一次并把要求说死，仍空才判失败交给降级链。
      if (!options.reasked && budget.used < budget.max) {
        return this.#json(
          [
            ...messages,
            {
              role: "system",
              content: "上一次回复是空的。请只输出一个合法 JSON，不要解释、不要注释、不要代码围栏。",
            },
          ],
          shape,
          { ...options, reasked: true },
        );
      }
      throw new ModelContentError("Model API returned no JSON content");
    }

    try {
      return tolerantParse(content);
    } catch (error) {
      // 修补也救不回来时，再问一次并把要求说死；仍失败才带原文抛出。
      if (!options.reasked && budget.used < budget.max) {
        return this.#json(
          [
            ...messages,
            {
              role: "system",
              content: "上一次回复不是合法 JSON。只输出一个合法 JSON，不要解释、不要注释、不要代码围栏。",
            },
          ],
          shape,
          { ...options, reasked: true },
        );
      }
      throw new ModelContentError(
        `Invalid model JSON: ${error.message}｜finish=${finishReason ?? "none"}｜出错点附近：${failureNeighborhood(error, content)}`,
      );
    }
  }

  emitNarrative(text) {
    this.onNarrative?.(text);
  }

  discardNarrative() {
    this.onDiscardNarrative?.();
  }

  // 函数调用请求：把结构化输出交给 API 层的 JSON Schema 强约束。
  // 返回解析后的工具参数对象；工具未被调用或参数非法时抛 ModelContentError，
  // 交给 generateStructure 回退到 json_object。
  async #functionJson(messages, tool, options) {
    // 结构类请求永远关思考:function calling 也是结构路径,不走思维链。
    const endpoint = { ...(options.endpoint ?? this.config.fast), thinking: false };
    const thinking = this.#thinkingExtras(endpoint);
    // 上限与参数名和 #json 同一套规则（自动档+已学上限收口+厂商参数名）。
    const requestedMaxTokens = !thinking.thinkingActive
      ? (options.forcedMaxTokens ?? this.config.maxTokens)
      : "";
    const learnedCap = this.learnedMaxTokens.get(endpoint.model);
    const effectiveMaxTokens =
      requestedMaxTokens && learnedCap && Number(requestedMaxTokens) > learnedCap
        ? learnedCap
        : requestedMaxTokens;
    let payload;
    let attempt = 0;
    while (true) {
      try {
        const timeoutSignal = AbortSignal.timeout(options.timeoutMs ?? this.config.timeoutMs);
        const response = await this.fetch(chatCompletionsUrl(endpoint.baseUrl), {
          method: "POST",
          headers: {
            Authorization: `Bearer ${endpoint.apiKey}`,
            "Content-Type": "application/json",
            Accept: "application/json",
          },
          redirect: "error",
          body: JSON.stringify({
            model: endpoint.model,
            messages,
            ...(thinking.thinkingActive ? {} : { temperature: options.temperature ?? endpoint.temperature ?? 0.2 }),
            ...thinking.params,
            ...(effectiveMaxTokens
              ? { [outputLimitParamFor(endpoint.baseUrl)]: effectiveMaxTokens }
              : {}),
            tools: [tool],
            tool_choice: { type: "function", function: { name: tool.function.name } },
          }),
          signal: options.signal
            ? AbortSignal.any([options.signal, timeoutSignal])
            : timeoutSignal,
        });
        if (!response.ok) {
          const body = (await response.text()).slice(0, 500);
          throw new ModelApiError(response.status, body || response.statusText, response.headers);
        }
        // 读体也在重试范围内（与 #json 同理）：读一半超时是传输错误，按重试处理；
        // 真的非 JSON 才判内容错误走降级链。
        try {
          payload = await response.json();
        } catch (error) {
          if (
            error?.name === "TimeoutError" ||
            error?.name === "AbortError" ||
            error?.name === "TypeError"
          ) {
            throw error;
          }
          throw new ModelContentError("Model API returned a non-JSON response body");
        }
        break;
      } catch (error) {
        // 上限自愈（与 #json 同款）：端点 400 里声明了上限时按报错值记住并低档重试，
        // 函数调用路径不再因上限估高硬失败后白回退一次 json_object。
        if (
          error instanceof ModelApiError &&
          error.status === 400 &&
          effectiveMaxTokens &&
          !options.capHealed &&
          !options.signal?.aborted
        ) {
          const cap = this.#capFromErrorMessage(error.message);
          if (cap && cap < Number(effectiveMaxTokens)) {
            this.learnedMaxTokens.set(endpoint.model, cap);
            return this.#functionJson(messages, tool, {
              ...options,
              capHealed: true,
              forcedMaxTokens: cap,
            });
          }
        }
        if (!isRetryable(error) || attempt >= this.config.maxRetries || options.signal?.aborted) {
          throw error;
        }
        await sleepInterruptible(retryDelay(error, attempt), options.signal);
        attempt += 1;
      }
    }
    const message = payload.choices?.[0]?.message ?? {};
    const call = message.tool_calls?.[0];
    const raw = call?.function?.arguments;
    if (!call || (typeof raw !== "string" && typeof raw !== "object")) {
      throw new ModelContentError("Model API returned no tool call");
    }
    try {
      // 参数可能是 JSON 字符串，也可能已被服务商解析成对象。
      return typeof raw === "string" ? tolerantParse(raw) : raw;
    } catch (error) {
      throw new ModelContentError(`Invalid tool arguments: ${error.message}`);
    }
  }


  // 纯文本流式请求：叙事请求没有分隔符，逐块直发、结束返回全文。
  async #streamPlain({ endpoint, messages, onNarrative, signal, timeoutMs }) {
    const startedAt = performance.now();
    let ttftMs;
    let attempt = 0;
    let emitted = false;
    const thinking = this.#thinkingExtras(endpoint);
    // 与 #json/#functionJson 同一套上限规则：显式 max_tokens 高于已学上限时按上限
    // 收口。叙事流此前完全无视学到的上限——低上限端点上每个叙事请求都硬吃 400。
    const requestedMaxTokens = !thinking.thinkingActive ? this.config.maxTokens : "";
    const learnedCap = this.learnedMaxTokens.get(endpoint.model);
    const effectiveMaxTokens =
      requestedMaxTokens && learnedCap && Number(requestedMaxTokens) > learnedCap
        ? learnedCap
        : requestedMaxTokens;
    while (true) {
      let response;
      try {
        const timeoutSignal = AbortSignal.timeout(timeoutMs ?? this.config.timeoutMs);
        const requestSignal = signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal;
        response = await this.fetch(chatCompletionsUrl(endpoint.baseUrl), {
          method: "POST",
          headers: {
            Authorization: `Bearer ${endpoint.apiKey}`,
            "Content-Type": "application/json",
            Accept: "text/event-stream",
          },
          redirect: "error",
          body: JSON.stringify({
            model: endpoint.model,
            messages,
            stream: true,
            // 用量采集（2026-08-19）：OpenAI 兼容端点在末块回 usage；不支持该参数的
            // 端点会 400，isShapeDegradable 之外由重试链按可重试错误兜底。
            stream_options: { include_usage: true },
            ...(thinking.thinkingActive ? {} : { temperature: 0.8 }),
            ...thinking.params,
            ...(effectiveMaxTokens
              ? { [outputLimitParamFor(endpoint.baseUrl)]: effectiveMaxTokens }
              : {}),
          }),
          signal: requestSignal,
        });
        if (!response.ok) {
          const body = (await response.text()).slice(0, 500);
          throw new ModelApiError(response.status, body || response.statusText, response.headers);
        }
      } catch (error) {
        if (!isRetryable(error) || attempt >= this.config.maxRetries || signal?.aborted) {
          throw error;
        }
        await sleepInterruptible(retryDelay(error, attempt), signal);
        attempt += 1;
        continue;
      }
      if (!response.body) throw new Error("Model API returned an empty response body");
      try {
        const usageOut = {};
        const narrative = await readPlainStream(response.body, {
          usageOut,
          onNarrative: (text) => {
            if (text) emitted = true;
            ttftMs ??= performance.now() - startedAt;
            onNarrative?.(text);
          },
        });
        this.#reportUsage(endpoint, usageOut.usage);
        return {
          narrative,
          transportTimings: {
            ttftMs: ttftMs ?? performance.now() - startedAt,
          },
        };
      } catch (error) {
        // 拿到 200 之后的中途断流：还没给读者播出任何内容时值得重试一次；
        // 已经播出过半则直接失败，避免把重复段落推给读者。截断/非法 SSE 等
        // 内容级失败不重试（isRetryable 只认传输层错误）。
        if (!emitted && isRetryable(error) && attempt < this.config.maxRetries && !signal?.aborted) {
          await sleepInterruptible(retryDelay(error, attempt), signal);
          attempt += 1;
          continue;
        }
        throw error;
      }
    }
  }
}
