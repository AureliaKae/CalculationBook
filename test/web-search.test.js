import assert from "node:assert/strict";
import test from "node:test";

import { searchBookReference } from "../src/web-search.js";

function wikiFetch({ onSearch, onExtract }) {
  return async (url) => {
    const params = new URL(url).searchParams;
    if (params.get("list") === "search") {
      return new Response(
        JSON.stringify({ query: { search: onSearch(params.get("srsearch") ?? "") } }),
        { status: 200 },
      );
    }
    if (params.get("prop") === "extracts") {
      return new Response(
        JSON.stringify({ query: { pages: { 1: { extract: onExtract(params.get("titles") ?? "") } } } }),
        { status: 200 },
      );
    }
    return new Response("{}", { status: 200 });
  };
}

test("书名词条与关键词资料汇总进参考文本,书名号被清洗", async () => {
  const searched = [];
  const reference = await searchBookReference({
    title: "《凡人修仙传》（校对版全本+番外）作者：忘语",
    fetchImpl: wikiFetch({
      onSearch: (query) => {
        searched.push(query);
        if (query === "凡人修仙传") return [{ title: "凡人修仙传" }];
        if (query === "凡人修仙传 境界") return [{ title: "境界体系" }];
        return [];
      },
      onExtract: (title) => {
        if (title === "凡人修仙传") return "炼气筑基结丹元婴化神。".repeat(2000);
        if (title === "境界体系") return "境界资料补充。";
        return "";
      },
    }),
  });
  assert.ok(searched.includes("凡人修仙传"), "主词条应搜「凡人修仙传」");
  assert.ok(searched.every((query) => !query.includes("《") && !query.includes("作者")), "书名号/括号/作者后缀应被清洗");
  assert.ok(
    searched.some((query) => query.includes("外貌")) && searched.some((query) => query.includes("角色")),
    "关键词应覆盖整个角色创建(角色/外貌等)",
  );
  assert.ok(reference.includes("炼气筑基"), "书名词条正文应进参考");
  assert.ok(reference.includes("境界资料补充"), "关键词资料应进参考");
  assert.ok(reference.length <= 12000, "参考文本应截断到预算内");
});

test("搜索无结果返回空串,调用方回退摘要生成", async () => {
  const reference = await searchBookReference({
    title: "冷门小说",
    fetchImpl: wikiFetch({ onSearch: () => [], onExtract: () => "" }),
  });
  assert.equal(reference, "");
});

test("网络失败与非 200 响应都静默降级为空串", async () => {
  assert.equal(
    await searchBookReference({
      title: "某书",
      fetchImpl: async () => {
        throw new Error("network down");
      },
    }),
    "",
  );
  assert.equal(
    await searchBookReference({
      title: "某书",
      fetchImpl: async () => new Response("oops", { status: 503 }),
    }),
    "",
  );
});

test("多源头聚合:中/英文维基 + DDG 即时答案 + DDG 网页摘要 + 百度百科", async () => {
  const hosts = [];
  const fetchImpl = async (url) => {
    const parsed = new URL(url);
    hosts.push(parsed.host);
    if (parsed.host === "zh.wikipedia.org") {
      if (parsed.searchParams.get("list") === "search") {
        return new Response(JSON.stringify({ query: { search: [{ title: "中文词条" }] } }), { status: 200 });
      }
      return new Response(JSON.stringify({ query: { pages: { 1: { extract: "中文维基资料" } } } }), { status: 200 });
    }
    if (parsed.host === "en.wikipedia.org") {
      if (parsed.searchParams.get("list") === "search") {
        return new Response(JSON.stringify({ query: { search: [{ title: "EN" }] } }), { status: 200 });
      }
      return new Response(JSON.stringify({ query: { pages: { 1: { extract: "EN WIKI 资料" } } } }), { status: 200 });
    }
    if (parsed.host === "baike.baidu.com") {
      return new Response(
        "<title>凡人修仙传_百度百科</title>" +
          '<div class="para">百科词条摘要：一名普通少年踏上修仙路。</div>' +
          '<div class="para">第二段设定资料。</div>',
        { status: 200 },
      );
    }
    if (parsed.host === "api.duckduckgo.com") {
      return new Response(
        JSON.stringify({ Abstract: "DDG 摘要", RelatedTopics: [{ Text: "DDG 相关主题" }] }),
        { status: 200 },
      );
    }
    if (parsed.host === "html.duckduckgo.com") {
      return new Response(
        '<a class="result__snippet">DDG 网页片段</a><a class="result__snippet">片段二</a>',
        { status: 200 },
      );
    }
    return new Response("{}", { status: 200 });
  };
  const reference = await searchBookReference({ title: "凡人修仙传", fetchImpl });
  assert.ok(reference.includes("中文维基资料"), "中文维基应贡献资料");
  assert.ok(reference.includes("EN WIKI 资料"), "英文维基应贡献资料");
  assert.ok(reference.includes("DDG 摘要"), "DDG 即时答案应贡献资料");
  assert.ok(reference.includes("DDG 网页片段"), "DDG 网页摘要应贡献资料");
  assert.ok(reference.includes("百科词条摘要"), "百度百科应贡献资料");
  assert.ok(
    hosts.includes("zh.wikipedia.org") &&
      hosts.includes("en.wikipedia.org") &&
      hosts.includes("api.duckduckgo.com") &&
      hosts.includes("html.duckduckgo.com") &&
      hosts.includes("baike.baidu.com"),
    "五个源头都应被访问",
  );
});

test("百度百科未命中词条(搜索提示页)静默降级,其余源头照常", async () => {
  const fetchImpl = async (url) => {
    const parsed = new URL(url);
    if (parsed.host === "baike.baidu.com") {
      // 无词条时站点返回搜索提示页——title 不是「词条名_百度百科」。
      return new Response("<title>百度百科_全球领先的中文百科全书</title><div>搜索结果页</div>", {
        status: 200,
      });
    }
    if (parsed.host === "html.duckduckgo.com") {
      return new Response('<a class="result__snippet">DDG 网页片段</a>', { status: 200 });
    }
    return new Response("{}", { status: 200 });
  };
  const reference = await searchBookReference({ title: "冷门网文", fetchImpl });
  assert.ok(!reference.includes("搜索结果页"), "提示页正文不得混进参考");
  assert.ok(reference.includes("DDG 网页片段"), "其余源头照常聚合");
});

test("单个源头失败不影响其余源头聚合", async () => {
  const fetchImpl = async (url) => {
    const parsed = new URL(url);
    if (parsed.host === "html.duckduckgo.com") throw new Error("html source down");
    if (parsed.host === "api.duckduckgo.com") {
      return new Response(JSON.stringify({ Abstract: "DDG 摘要" }), { status: 200 });
    }
    return new Response("{}", { status: 200 });
  };
  const reference = await searchBookReference({ title: "某书", fetchImpl });
  assert.ok(reference.includes("DDG 摘要"), "一个源头挂了,其余源头照常聚合");
});

test("空书名与缺省 fetch 不抛错", async () => {
  assert.equal(await searchBookReference({ title: "" }), "");
  assert.equal(await searchBookReference({ title: "《》" }), "");
});
