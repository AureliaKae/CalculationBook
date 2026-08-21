import assert from "node:assert/strict";
import test from "node:test";

import { tolerantParse } from "../src/json-tolerant.js";

test("合法 JSON 原样解析", () => {
  assert.deepEqual(tolerantParse('{"a":[1,2]}'), { a: [1, 2] });
});

test("数组元素之间漏逗号能补回来（线上那次的报错）", () => {
  // Invalid model JSON: Expected ',' or ']' after array element at position 128 (line 7 column 8)
  const broken = `{
  "id": "world",
  "title": "书",
  "stats": [
    { "id": "life", "name": "生命" }
    { "id": "mind", "name": "神智" }
    { "id": "food", "name": "饥饿" }
  ]
}`;
  assert.throws(() => JSON.parse(broken));
  assert.deepEqual(tolerantParse(broken).stats.map((item) => item.id), ["life", "mind", "food"]);
});

test("字符串数组漏逗号也能补", () => {
  assert.deepEqual(tolerantParse('["起点"\n"荒原"\n"渡口"]'), ["起点", "荒原", "渡口"]);
});

test("尾逗号、注释、代码围栏与前后杂字都能扛住", () => {
  const messy = '这是结果：```json\n{\n  // 说明\n  "a": 1,\n  "b": [2, 3,],\n}\n```\n以上。';
  assert.deepEqual(tolerantParse(messy), { a: 1, b: [2, 3] });
});

test("字符串里的括号与逗号不被当成结构", () => {
  const value = tolerantParse('{"text":"他说：{不要，别走]"}');
  assert.equal(value.text, "他说：{不要，别走]");
});

test("字符串里直接敲了回车（Bad control character）也能救回来", () => {
  // Invalid model JSON: Bad control character in string literal at position 909 (line 60 column 15)
  const broken = '{"summary":"第一段\n第二段\t带缩进","id":"world"}';
  assert.throws(() => JSON.parse(broken));
  const value = tolerantParse(broken);
  assert.equal(value.summary, "第一段\n第二段\t带缩进");
  assert.equal(value.id, "world");
});

test("前言里的裸括号、中文引号与注释不会被当成 JSON 结构", () => {
  assert.deepEqual(tolerantParse("这是前言 [注意] 后面 {\"a\": 1}"), { a: 1 });
  assert.deepEqual(tolerantParse("前言说“集合{1,2}很重要” {\"a\": 1}"), { a: 1 });
  assert.deepEqual(tolerantParse("// 注释 [x]\n{\"a\": 1}"), { a: 1 });
  assert.deepEqual(tolerantParse("/* 注释 {\"x\":1} */ {\"a\": 2}"), { a: 2 });
});

test("真的修不动就抛错", () => {
  assert.throws(() => tolerantParse('{"a": '));
});

test("字面 null 不再被当成功返回(调用方会把 null 存档)", () => {
  // 旧实现:null 解析成功→落入 arrayFallback→整函数返回 null。
  // 调用方一律把「非异常返回」当成功,null 被写进检查点,断点续烧永不收敛。
  assert.throws(() => tolerantParse("null"));
  assert.throws(() => tolerantParse("  null  "));
});

test("整篇是裸标量(数字/字符串/true)按解析失败抛出", () => {
  assert.throws(() => tolerantParse("42"));
  assert.throws(() => tolerantParse("\"一段话\""));
  assert.throws(() => tolerantParse("true"));
});

test("数组兜底语义保留:只有数组没有对象时返回首个数组", () => {
  assert.deepEqual(tolerantParse('["注意"] 后面没有对象了'), ["注意"]);
  // 对象候选仍然优先于前置旁白数组。
  assert.deepEqual(tolerantParse('["注意"] {"a": 1}'), { a: 1 });
});
