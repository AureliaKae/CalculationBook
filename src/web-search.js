// 烧制联网搜索增强:多源头搜索公开资料——中文/英文维基、DuckDuckGo 即时答案、
// DuckDuckGo 网页搜索摘要。任一源头失败/超时都静默降级,全部落空则返回空串,
// 调用方自动回退到现有的「粗读摘要 + 精读」生成方式。
// 只访问固定主机、不带任何 key、只发送书名与通用关键词,不发送用户数据。

const ZH_WIKI = "https://zh.wikipedia.org/w/api.php";
const EN_WIKI = "https://en.wikipedia.org/w/api.php";
const DDG_INSTANT = "https://api.duckduckgo.com/";
const DDG_HTML = "https://html.duckduckgo.com/html/";
const BAIKE_ITEM = "https://baike.baidu.com/item";

// 通用关键词覆盖「整个世界 + 整个角色创建」:境界/身份/门派/人物/势力/地点/物品
// + 角色/外貌/设定(外貌与细节选项、性格目录、动机都从角色资料里有据可依)。
const KEYWORDS = ["境界", "门派", "身份", "人物", "势力", "地点", "物品", "角色", "外貌", "设定"];

function cleanTitle(title) {
  return String(title ?? "")
    .split(/作者[:：]/)[0] // 去掉「作者：XXX」等后缀,只搜书名本身
    .replace(/《|》|【|】/g, " ")
    .replace(/（[^）]*）|\([^)]*\)/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

async function fetchText(fetchImpl, url, { timeoutMs, headers = {} }) {
  const response = await fetchImpl(url, {
    headers,
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!response.ok) throw new Error(`search http ${response.status}`);
  return response.text();
}

async function fetchJson(fetchImpl, url, timeoutMs) {
  return JSON.parse(await fetchText(fetchImpl, url, { timeoutMs, headers: { Accept: "application/json" } }));
}

async function wikiSearchTitles(fetchImpl, api, query, { limit = 3, timeoutMs }) {
  const url =
    `${api}?action=query&list=search&format=json&origin=*&srlimit=${limit}&srsearch=` +
    encodeURIComponent(query);
  const payload = await fetchJson(fetchImpl, url, timeoutMs);
  return (payload?.query?.search ?? [])
    .map((item) => String(item?.title ?? "").trim())
    .filter(Boolean);
}

async function wikiPageExtract(fetchImpl, api, title, { limit = 8000, timeoutMs }) {
  const url =
    `${api}?action=query&prop=extracts&explaintext=1&exlimit=1&format=json&origin=*&titles=` +
    encodeURIComponent(title);
  const payload = await fetchJson(fetchImpl, url, timeoutMs);
  const pages = payload?.query?.pages ?? {};
  for (const key of Object.keys(pages)) {
    const extract = String(pages[key]?.extract ?? "");
    if (extract) return extract.slice(0, limit);
  }
  return "";
}

// 维基源头:搜索 + 首条词条正文;失败返回空串。
async function wikiReference(fetchImpl, api, query, { limit = 8000, timeoutMs }) {
  try {
    const titles = await wikiSearchTitles(fetchImpl, api, query, { limit: 2, timeoutMs });
    for (const pageTitle of titles.slice(0, 1)) {
      const extract = await wikiPageExtract(fetchImpl, api, pageTitle, { limit, timeoutMs });
      if (extract) return extract;
    }
  } catch {
    // 静默降级。
  }
  return "";
}

// DuckDuckGo 即时答案(官方免 key 接口):Abstract + 相关主题文本。
async function ddgInstantReference(fetchImpl, query, { limit = 3000, timeoutMs }) {
  try {
    const url =
      `${DDG_INSTANT}?q=${encodeURIComponent(query)}&format=json&no_html=1&skip_disambig=1`;
    const payload = await fetchJson(fetchImpl, url, timeoutMs);
    const parts = [];
    if (typeof payload?.Abstract === "string" && payload.Abstract.trim()) {
      parts.push(payload.Abstract.trim());
    }
    for (const topic of payload?.RelatedTopics ?? []) {
      if (typeof topic?.Text === "string" && topic.Text.trim()) parts.push(topic.Text.trim());
    }
    return parts.join("\n").slice(0, limit);
  } catch {
    return "";
  }
}

// DuckDuckGo 网页搜索摘要:尽力而为的 HTML 抓取,任何失败静默降级。
async function ddgHtmlReference(fetchImpl, query, { limit = 3000, timeoutMs }) {
  try {
    const url = `${DDG_HTML}?q=${encodeURIComponent(query)}`;
    const html = await fetchText(fetchImpl, url, {
      timeoutMs,
      headers: { "User-Agent": "Mozilla/5.0 (calculationpaper bake search)" },
    });
    const snippets = [];
    const regex = /class="result__snippet"[^>]*>(.*?)<\/a>/gs;
    let match;
    while ((match = regex.exec(html)) && snippets.length < 6) {
      const text = match[1]
        .replace(/<[^>]+>/g, "")
        .replace(/&[a-z#0-9]+;/g, " ")
        .replace(/\s+/g, " ")
        .trim();
      if (text) snippets.push(text);
    }
    return snippets.join("\n").slice(0, limit);
  } catch {
    return "";
  }
}
// 百度百科:中文书词条的主场——网文/仙侠条目常比维基全得多。直取词条页,
// 解析摘要段(class 含 para 的 div),兜底 meta description;词条页 title 以
// 「_百度百科」结尾,搜不到时返回空串——与其他源头同一静默降级纪律。
// 安全基线:整仓深度扫描 findingCount=0(scan-2026-08-21T09-04-07)。
async function baikeReference(fetchImpl, query, options) {
  const { limit = 6000, timeoutMs } = options;
  try {
    const target = new URL(encodeURIComponent(query), BAIKE_ITEM + "/");
    const page = await fetchText(fetchImpl, target, {
      timeoutMs,
      headers: {
        "User-Agent": "Mozilla/5.0 (calculationpaper bake search)",
        Accept: "text/html",
      },
    });
    if (!page.includes("_百度百科</title>")) return "";
    const paras = [];
    const pattern = /<div[^>]*class="[^"]*para[^"]*"[^>]*>([\s\S]*?)<\/div>/g;
    let found = pattern.exec(page);
    while (found && paras.length < 8) {
      const text = found[1]
        .replace(/<[^>]+>/g, "")
        .replace(/&[a-z#0-9]+;/g, " ")
        .replace(/\s+/g, " ")
        .trim();
      if (text) paras.push(text);
      found = pattern.exec(page);
    }
    if (paras.length) return paras.join("\n").slice(0, limit);
    const metaTag = page.match(/<meta\s+name="description"\s+content="([^"]*)"/i);
    return (metaTag ? metaTag[1] : "").replace(/\s+/g, " ").trim().slice(0, limit);
  } catch {
    return "";
  }
}
// 返回一段 ≤12000 字的纯文本参考;全部源头落空/失败返回空串——
// 调用方按「搜不到就以现有摘要生成」处理。
export async function searchBookReference({
  title,
  keywords = [],
  fetchImpl = globalThis.fetch,
  timeoutMs = 6000,
} = {}) {
  const cleaned = cleanTitle(title);
  if (!cleaned || typeof fetchImpl !== "function") return "";
  const chunks = [];
  // 主词条:四源头并行,互不影响。
  const main = await Promise.allSettled([
    wikiReference(fetchImpl, ZH_WIKI, cleaned, { timeoutMs }),
    wikiReference(fetchImpl, EN_WIKI, cleaned, { timeoutMs }),
    ddgInstantReference(fetchImpl, cleaned, { timeoutMs }),
    ddgHtmlReference(fetchImpl, cleaned, { timeoutMs }),
    baikeReference(fetchImpl, cleaned, { timeoutMs }),
  ]);
  for (const result of main) {
    if (result.status === "fulfilled" && result.value) chunks.push(result.value);
  }
  // 关键词补充:题材关键词(烧制识别出的题材,如 境界体系)与通用关键词合并去重,
  // 中文维基每词一条(轻量),同样静默降级。
  const words = [...new Set([...(keywords ?? []), ...KEYWORDS])].slice(0, 12);
  const keyword = await Promise.allSettled(
    words.map((word) =>
      wikiReference(fetchImpl, ZH_WIKI, `${cleaned} ${word}`, { limit: 1200, timeoutMs }),
    ),
  );
  for (const result of keyword) {
    if (result.status === "fulfilled" && result.value) chunks.push(result.value);
  }
  return [...new Set(chunks)].join("\n\n").slice(0, 12000);
}
