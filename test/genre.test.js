import assert from "node:assert/strict";
import test from "node:test";

import { GENRES, genreNote, genreSearchKeywords, genreVocabulary, guessGenreByKeywords, normalizeGenre } from "../src/genre.js";

test("关键词启发识别常见题材", () => {
  assert.equal(guessGenreByKeywords("韩立修炼长春功,练气三层后筑基,最终飞升仙界。"), "仙侠");
  assert.equal(guessGenreByKeywords("少年觉醒斗气,闯荡斗罗大陆,加入佣兵工会。"), "玄幻");
  assert.equal(guessGenreByKeywords("江湖恩怨,门派林立,少侠剑法通神。"), "武侠");
  assert.equal(guessGenreByKeywords("星际飞船跨越银河,机甲与外星文明开战。"), "科幻");
  assert.equal(guessGenreByKeywords("某朝年间,皇帝昏聩,科举舞弊,将军起兵。"), "历史");
  assert.equal(guessGenreByKeywords("一间密室,一桩凶案,侦探步步解谜。"), "悬疑");
  assert.equal(guessGenreByKeywords("一段没有关键词的文字。"), null);
});

test("题材搜索关键词与分片化引导文案", () => {
  assert.ok(genreSearchKeywords("仙侠").includes("境界体系"));
  assert.deepEqual(genreSearchKeywords("其他"), []);
  // 有境界体系的题材:骨架片要求生成境界阶梯。
  assert.match(genreNote("仙侠", "skeleton"), /境界/);
  assert.match(genreNote("仙侠", "skeleton"), /每一阶一个独立 trait/);
  assert.match(genreNote("玄幻", "skeleton"), /每一阶一个独立 trait/);
  assert.match(genreNote("仙侠", "people"), /地位/);
  assert.match(genreNote("仙侠", "catalog"), /修仙日常|外貌/);
  assert.doesNotMatch(genreNote("仙侠", "catalog"), /道友/, "称谓引导已取消");
  // 无境界体系的题材:骨架片明确禁止编造修为。
  assert.match(genreNote("都市", "skeleton"), /不得生成|无修炼境界/);
  assert.equal(genreNote("都市", "skeleton").includes("修为"), true);
  assert.equal(genreNote("其他", "skeleton"), "");
  assert.equal(genreNote("仙侠", "threads"), "");
});

test("LLM 分类结果归一化", () => {
  assert.equal(normalizeGenre("仙侠"), "仙侠");
  assert.equal(normalizeGenre({ genre: "武侠" }), "武侠");
  assert.equal(normalizeGenre("随便写的"), null);
  assert.equal(normalizeGenre({}), null);
});

test("题材词表:每个题材都有技能/行囊的展示词,未知回落通用词", () => {
  for (const genre of GENRES) {
    const vocabulary = genreVocabulary(genre);
    assert.equal(typeof vocabulary.ability, "string", `${genre} 有技能词`);
    assert.equal(typeof vocabulary.inventory, "string", `${genre} 有行囊词`);
  }
  assert.deepEqual(genreVocabulary("仙侠"), { ability: "功法", inventory: "法器" });
  assert.deepEqual(genreVocabulary("都市"), { ability: "专长", inventory: "随身" });
  assert.deepEqual(genreVocabulary("其他"), { ability: "技能", inventory: "行囊" });
  assert.deepEqual(genreVocabulary(null), { ability: "技能", inventory: "行囊" });
  assert.deepEqual(genreVocabulary("没登记的题材"), { ability: "技能", inventory: "行囊" });
});
