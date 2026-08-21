import test from "node:test";
import assert from "node:assert/strict";

import { relationLabel, relationsView } from "../src/relations.js";

test("relationLabel：五维数值翻定性档，敌意最重优先", () => {
  // 敌对优先:结怨的人心再热也是敌。
  assert.deepEqual(relationLabel({ trust: 8, hostility: 5 }), { key: "hostile", label: "敌对", tone: "bad" });
  assert.deepEqual(relationLabel({ fear: 6, hostility: 5 }), { key: "hostile", label: "敌对", tone: "bad" });
  assert.deepEqual(relationLabel({ fear: 5 }), { key: "wary", label: "忌惮", tone: "cool" });
  assert.deepEqual(relationLabel({ trust: 4 }), { key: "close", label: "亲近", tone: "good" });
  assert.deepEqual(relationLabel({ trust: -4 }), { key: "strained", label: "生隙", tone: "bad" });
  // 有过来往(任一维非零)算相识;全零是一面之缘。
  assert.deepEqual(relationLabel({ trust: 1 }), { key: "acquainted", label: "相识", tone: "cool" });
  assert.deepEqual(relationLabel({ stance: -2 }), { key: "acquainted", label: "相识", tone: "cool" });
  assert.deepEqual(relationLabel(null), { key: "met", label: "一面之缘", tone: "cool" });
  assert.deepEqual(relationLabel({}), { key: "met", label: "一面之缘", tone: "cool" });
});

const world = {
  characters: [
    {
      id: "lin",
      name: "林雾",
      role: "医师",
      summary: "灯塔下的哑医",
      locationIds: ["灯塔"],
      persona: { temperament: "沉默寡言", motives: "寻找失踪的兄长", bottomLines: "不害就医之人", manner: "句短而准" },
    },
    { id: "captain", name: "闻舟", role: "船长", summary: "盐船队的老大", locationIds: ["旧码头"] },
    { id: "ghost", name: "雾中人", role: "不详", summary: "无迹可寻", locationIds: ["旧码头"], detailed: true, motives: ["守住灯塔的秘密"], habits: ["夜里巡滩"] },
  ],
  locations: [{ id: "灯塔", name: "灯塔" }, { id: "旧码头", name: "旧码头" }],
};

test("relationsView：最近交集优先、只认打过交道的人、人物卡字段一次带全", () => {
  const state = {
    // lin 先有交集、captain 后有:倒序后 captain 在前。
    relationships: {
      "character:lin": { trust: 5, hostility: 0 },
      "character:captain": { hostility: 4 },
      // 势力关系不进人物簿。
      "faction:guild": { trust: 2 },
    },
    entityStates: {
      lin: { status: "active", locationId: "灯塔" },
      captain: { status: "active", locationId: "旧码头" },
    },
  };
  const view = relationsView(state, world);
  assert.equal(view.entries.length, 2, "势力条目不计入");
  assert.equal(view.entries[0].name, "闻舟");
  assert.deepEqual(view.entries[0].stance, { key: "hostile", label: "敌对", tone: "bad" });
  assert.equal(view.entries[1].stance.label, "亲近");
  // persona 四卡与行踪带全;未精读者 detail 为 null。
  assert.equal(view.entries[1].persona.motives, "寻找失踪的兄长");
  assert.equal(view.entries[1].locationName, "灯塔");
  assert.equal(view.entries[1].detail, null);
  assert.equal(view.more, 0);
});

test("relationsView 只认有交集（拍板 2026-08-20）：没打过交道的一律不显示", () => {
  // 在场旁观/开局预填/只被看见:只有 discovered 没有关系条目 → 整块隐藏。
  const bystander = {
    discoveredCharacterIds: ["lin", "captain", "ghost"],
    relationships: {},
  };
  assert.equal(relationsView(bystander, world), null, "零交集:整块隐藏");
  // 只要有一条人物关系,簿里只有那个人。
  const single = relationsView(
    { discoveredCharacterIds: ["lin", "captain"], relationships: { "character:lin": { trust: 1 } } },
    world,
  );
  assert.deepEqual(
    single.entries.map((entry) => entry.name),
    ["林雾"],
    "有交集者进簿,其余隐藏",
  );
});

test("relationsView：已故灰显、精读明细可选、上限与余数、空簿 null", () => {
  const dead = relationsView(
    {
      relationships: { "character:lin": { trust: 1 } },
      entityStates: { lin: { status: "dead", locationId: "灯塔" } },
    },
    world,
  );
  assert.deepEqual(dead.entries[0].stance, { key: "dead", label: "已故", tone: "dead" });
  assert.equal(dead.entries[0].status, "dead");

  const capped = relationsView(
    {
      relationships: {
        "character:ghost": { trust: 1 },
        "character:lin": { trust: 1 },
        "character:captain": { trust: 1 },
      },
      entityStates: { ghost: { status: "active", locationId: "旧码头" } },
    },
    world,
    2,
  );
  assert.equal(capped.entries.length, 2, "上限截断");
  assert.equal(capped.more, 1, "超出计余数");

  // 精读明细:ghost 单独入簿验证(上面限 2 恰好把它截掉了)。
  const detailed = relationsView(
    {
      relationships: { "character:ghost": { trust: 1 } },
      entityStates: { ghost: { status: "active", locationId: "旧码头" } },
    },
    world,
  );
  assert.deepEqual(detailed.entries[0].detail.motives, ["守住灯塔的秘密"], "精读明细带上");

  assert.equal(relationsView({ relationships: {} }, world), null, "空簿隐藏");
  assert.equal(
    relationsView({ relationships: { "character:nobody": { trust: 1 } } }, world),
    null,
    "目录外条目也隐藏",
  );
});
