import {
  DEEPSEEK_BASE_URL,
  isKnownProviderBaseUrl,
  providerLabel,
  recommendedBakeConcurrency,
} from "./providers.js";

export const DEFAULT_BASE_URL = DEEPSEEK_BASE_URL;

const SLOT_LABEL = { fast: "快模型", strong: "强模型" };

// 凭证标签认 DeepSeek 与阿里千问(百炼);其余地址(本机调试)兜底显示主机名。
export function credentialLabel(baseUrl) {
  return providerLabel(baseUrl);
}

function clampConcurrency(value) {
  // 空串 = 自动档（按快槽厂商取官方建议并发），保留原样由 resolveBakeConcurrency 落地。
  if (value === "" || value == null) return "";
  return Math.max(1, Math.min(10, Number(value) || 3));
}

// 烧制并发解析：留空 = 按快槽厂商的官方建议档（DeepSeek 4 / 千问 3）；
// 手动填的数字 1–10 原样生效。烧制走快槽，档位跟着快槽凭证走。
export function resolveBakeConcurrency(settings) {
  const stored = settings?.bakeConcurrency;
  if (stored !== "" && stored != null) {
    return Math.max(1, Math.min(10, Number(stored) || 3));
  }
  const fastCredential = (settings?.credentials ?? []).find(
    (item) => item.id === settings?.fast?.credentialId,
  );
  return recommendedBakeConcurrency(fastCredential?.baseUrl);
}

// 单次请求的最大输出 token 数：留空 = 用端点默认，填数字才下发 max_tokens。
// 不设硬上限——端点不接受的数值会以 400 报错回来，用户按报错自己收窄。
function normalizeMaxTokens(value) {
  if (value == null || value === "") return "";
  const n = Number(value);
  return Number.isFinite(n) && n >= 1 ? Math.floor(n) : "";
}

// 槽位温度:0.1–1.5,一位小数,缺省 0.2(与引擎历史硬编码一致)。
// 思考模式不支持 temperature,开启时由客户端强制剥离,滑杆在设置页置灰。
export function clampTemperature(value) {
  if (value == null || value === "") return 0.2;
  const n = Number(value);
  if (!Number.isFinite(n)) return 0.2;
  return Math.round(Math.min(1.5, Math.max(0.1, n)) * 10) / 10;
}

function normalizeSlot(slot, credentials) {
  const credentialId = credentials.some((item) => item.id === slot?.credentialId)
    ? slot.credentialId
    : "";
  return {
    credentialId,
    model: credentialId ? String(slot?.model ?? "").trim() : "",
    temperature: clampTemperature(slot?.temperature),
  };
}

export function emptySettings() {
  return {
    version: 2,
    credentials: [],
    fast: { credentialId: "", model: "", temperature: 0.2 },
    strong: { credentialId: "", model: "", temperature: 0.2 },
    // 空串 = 自动档：按快槽厂商的官方建议并发（DeepSeek 4 / 千问 3）。
    bakeConcurrency: "",
    maxTokens: "",
    // （mode: immersive|normal 已随手动存档槽删除，2026-08-21——只剩沉浸式
    // 一种节奏：进度自动存续，随关随续。）
    // 新装默认:强槽开思考(叙事质量优先,契合 DeepSeek 原生 effort=high),
    // 快槽关思考(烧制量大,速度与成本优先)。已保存用户值不受默认值影响。
    thinkingFast: false,
    thinkingStrong: true,
  };
}

// 本机 http 调试地址：设置保存(main 侧 assertSecureEndpoint 放行)、迁移过滤
// 与槽位解析共用同一判定，避免「保存时收下、迁移时丢弃」两套标准打架
// （那条凭证连同密文一起凭空消失，本机调试功能永远走不通）。
function isDevLocalBaseUrl(baseUrl) {
  try {
    const url = new URL(String(baseUrl ?? ""));
    return url.protocol === "http:" && ["localhost", "127.0.0.1", "::1"].includes(url.hostname);
  } catch {
    return false;
  }
}

// 落盘格式从 v1 的单组扁平配置升到 v2 的凭证池；v1 的那一组自动变成池里的第一条，
// 快模型与强模型都先指向它，用户之后可以把强模型改指到另一个 DeepSeek 模型。
export function migrateSettings(stored) {
  if (!stored || typeof stored !== "object") return emptySettings();
  // 未来版本的文件按 v2 结构尽力读取（字段驱动、多余字段忽略），只留警告：
  // 静默清空全部凭证再等下一次 save 落盘，对用户是纯数据丢失（降级运行/忘写
  // 迁移分支都会触发）。v1 及更早的无版本文件才走旧格式迁移。
  const version = Number(stored.version);
  if (version === 2 || (Number.isFinite(version) && version > 2)) {
    if (version > 2) {
      console.warn("[settings] 未知的设置文件版本 v" + version + "，按 v2 结构尽力读取");
    }
    const source = Array.isArray(stored.credentials) ? stored.credentials : [];
    // 后续按 id 归并时一条凭证的 Key 会静默覆盖另一条、打错凭证。
    const usedIds = new Set(source.map((item) => item?.id).filter(Boolean));
    const credentials = source
      // 双厂商(2026-08-17):DeepSeek 与阿里千问(百炼);其余地址凭证静默清除,
      // 快/强槽指向它时随之清空。本机 http 调试地址除外——保存侧明确放行。
      .filter(
        (item) =>
          item && (isKnownProviderBaseUrl(item.baseUrl) || isDevLocalBaseUrl(item.baseUrl)),
      )
      .map((item) => {
        let id = item.id;
        // 缺省 id 生成时避开已占用的 id：否则「cred-1」与已有同名凭证撞 id，
        // 后续按 id 归并时一条凭证的 Key 会静默覆盖另一条、打错凭证。
        if (!id) {
          let suffix = 1;
          do {
            id = `cred-${suffix}`;
            suffix += 1;
          } while (usedIds.has(id));
          usedIds.add(id);
        }
        return {
          id,
          label: String(item.label ?? "").trim() || credentialLabel(item.baseUrl),
          baseUrl: String(item.baseUrl).trim(),
          encryptedKey: item.encryptedKey ?? "",
        };
      });
    return {
      version: 2,
      credentials,
      fast: normalizeSlot(stored.fast, credentials),
      strong: normalizeSlot(stored.strong, credentials),
      bakeConcurrency: clampConcurrency(stored.bakeConcurrency),
      maxTokens: normalizeMaxTokens(stored.maxTokens),
      thinkingFast: Boolean(stored.thinkingFast),
      // 旧文件缺字段(从未动过开关)时吃新默认(强槽开);显式关掉的用户值原样保留。
      thinkingStrong: stored.thinkingStrong == null ? true : Boolean(stored.thinkingStrong),
    };
  }
  if (!stored.baseUrl && !stored.encryptedKey) return emptySettings();
  // v1 旧格式指向双厂商之外的地址时整组丢弃,重新走首次配置。
  if (!isKnownProviderBaseUrl(stored.baseUrl)) return emptySettings();
  const credentials = [
    {
      id: "migrated",
      label: credentialLabel(stored.baseUrl),
      baseUrl: String(stored.baseUrl ?? DEFAULT_BASE_URL).trim(),
      encryptedKey: stored.encryptedKey ?? "",
    },
  ];
  return {
    version: 2,
    credentials,
    fast: normalizeSlot({ credentialId: "migrated", model: stored.fastModel }, credentials),
    strong: normalizeSlot({ credentialId: "migrated", model: stored.strongModel }, credentials),
    bakeConcurrency: clampConcurrency(stored.bakeConcurrency),
    maxTokens: "",
    thinkingFast: Boolean(stored.thinkingFast),
    thinkingStrong: stored.thinkingStrong == null ? true : Boolean(stored.thinkingStrong),
  };
}

function resolveSlot(settings, name) {
  const slot = settings?.[name] ?? {};
  const credential = (settings?.credentials ?? []).find((item) => item.id === slot.credentialId);
  if (!credential?.baseUrl || !credential.apiKey) {
    throw new Error(`请先在设置里为${SLOT_LABEL[name]}选择一条填好 Key 的 API 凭证`);
  }
  if (!slot.model) throw new Error(`请先在设置里为${SLOT_LABEL[name]}选择具体模型`);
  // 运行时只认 DeepSeek 与阿里千问(本机 http://localhost 调试豁免)。
  if (!isKnownProviderBaseUrl(credential.baseUrl) && !isDevLocalBaseUrl(credential.baseUrl)) {
    throw new Error(`仅支持 DeepSeek(api.deepseek.com)与阿里千问(百炼)接口`);
  }
  return {
    baseUrl: credential.baseUrl,
    apiKey: credential.apiKey,
    model: slot.model,
    temperature: slot.temperature ?? 0.2,
  };
}

// 快模型与强模型各自带上凭证、思考开关与槽位标记:归一化层按槽位下发
// reasoning_effort(快槽 low / 强槽 high),两条凭证可以指向不同的 DeepSeek 模型。
export function clientConfig(settings) {
  return {
    fast: { ...resolveSlot(settings, "fast"), thinking: Boolean(settings?.thinkingFast), slot: "fast" },
    strong: { ...resolveSlot(settings, "strong"), thinking: Boolean(settings?.thinkingStrong), slot: "strong" },
    maxTokens: normalizeMaxTokens(settings?.maxTokens),
  };
}

export function isReady(settings) {
  try {
    clientConfig(settings);
    return true;
  } catch {
    return false;
  }
}

export function publicSettings(settings) {
  return {
    version: 2,
    credentials: (settings?.credentials ?? []).map(({ id, label, baseUrl, apiKey }) => ({
      id,
      label,
      baseUrl,
      hasApiKey: Boolean(apiKey),
    })),
    fast: {
      ...(settings?.fast ?? { credentialId: "", model: "" }),
      temperature: clampTemperature(settings?.fast?.temperature),
    },
    strong: {
      ...(settings?.strong ?? { credentialId: "", model: "" }),
      temperature: clampTemperature(settings?.strong?.temperature),
    },
    bakeConcurrency: settings?.bakeConcurrency === "" || settings?.bakeConcurrency == null ? "" : (settings?.bakeConcurrency ?? 3),
    maxTokens: settings?.maxTokens ?? "",
    thinkingFast: Boolean(settings?.thinkingFast),
    thinkingStrong: Boolean(settings?.thinkingStrong),
    ready: isReady(settings),
    // 解密失败计数:>0 表示系统密钥库变更,设置页要明示「原 Key 无法解密,请重新填写」。
    decryptFailed: Number(settings?.decryptFailed ?? 0),
  };
}
