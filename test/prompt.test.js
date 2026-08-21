import assert from "node:assert/strict";
import test from "node:test";

import {
  buildNarrativeMessages,
  buildStructureMessages,
  buildOpeningMessages,
  buildConsistencyCheckMessages,
  buildIntentOptionsMessages,
  buildArcPlanMessages,
} from "../src/prompt.js";
import { SUBMIT_TURN_FUNCTION, submitOptionsTool } from "../src/turn-schema.js";

test("story prompt assigns adaptive narrative lengths", () => {
  const base = {
    context: {},
    choice: { text: "观察" },
    check: { result: "success" },
  };
  const ordinary = JSON.parse(
    buildNarrativeMessages({ ...base, keyTurn: false })[1].content.split("\n").at(-1),
  );
  const key = JSON.parse(
    buildNarrativeMessages({ ...base, keyTurn: true })[1].content.split("\n").at(-1),
  );

  assert.equal(ordinary.narrativeLength, "普通回合，400-700 字");
  assert.equal(key.narrativeLength, "关键回合，800-1200 字");
});

test("反AI腔条款注入叙事、选项与开场提示词", () => {
  const narrative = buildNarrativeMessages({
    context: {},
    choice: { text: "观察" },
    check: { result: "success" },
  });
  assert.match(narrative[0].content, /反AI腔/);
  assert.match(narrative[0].content, /否定式排比/);

  const intent = buildIntentOptionsMessages({ context: {}, intent: "上山采药" });
  assert.match(intent[0].content, /同样反AI腔/);

  const opening = buildOpeningMessages({ world: {}, state: {} });
  assert.match(opening[0].content, /反AI腔：不用/);
});

test("adaptation directives inject only whitelisted flavors", () => {
  const narrative = buildNarrativeMessages({
    context: { state: { adaptation: { pacing: "faster", optionFlavor: "dangerous" } } },
    choice: { text: "观察" },
    check: { result: "success" },
  });
  assert.match(narrative[1].content, /节奏偏快/);
  assert.doesNotMatch(narrative[1].content, /谨慎/);

  const structure = buildStructureMessages({
    narrative: "潮声。",
    context: { state: { adaptation: { optionFlavor: "cautious", pacing: "neutral" } } },
    choice: { text: "观察" },
    check: { result: "success" },
  });
  assert.match(structure[1].content, /更谨慎/);
  assert.doesNotMatch(structure[1].content, /节奏偏/);

  const neutral = buildNarrativeMessages({
    context: { state: { adaptation: { optionFlavor: "neutral", pacing: "neutral" } } },
    choice: { text: "观察" },
    check: { result: "success" },
  });
  assert.doesNotMatch(neutral[1].content, /节奏偏|谨慎/);
});

test("本世第一回合注入开场续写指令,普通回合不注入", () => {
  const withOpening = buildNarrativeMessages({
    context: { priorOpening: "雾起时,她推开了院门。" },
    choice: { text: "观察" },
    check: { result: "success" },
  });
  assert.match(withOpening[1].content, /已经写好的开场正文/);
  assert.match(withOpening[1].content, /不得复述或改写开场/);

  const ordinary = buildNarrativeMessages({
    context: {},
    choice: { text: "观察" },
    check: { result: "success" },
  });
  assert.doesNotMatch(ordinary[1].content, /开场正文/);
});

test("原著距离条款注入叙事与结构:不硬拉原著人物,无名龙套可写", () => {
  const narrative = buildNarrativeMessages({
    context: {},
    choice: { text: "观察" },
    check: { result: "success" },
  });
  assert.match(narrative[0].content, /不硬拉原著人物/);
  assert.match(narrative[0].content, /无名原创龙套/);
  assert.match(narrative[0].content, /禁止为让原著人物入戏制造巧合/);
  assert.match(narrative[0].content, /不是必演剧本/);

  const structure = buildStructureMessages({
    narrative: "潮声。",
    context: {},
    choice: { text: "观察" },
    check: { result: "success" },
  });
  assert.match(structure[0].content, /选项不必围绕原著人物/);
  assert.match(structure[0].content, /不涉及具体人物的行动完全合法/);
});

test("jumpMinutes 条款绑定正文流逝与固定换算基准:几日按 3 日计", () => {
  // 时间约束(拍板:推演的时间贴着原著走):模糊时间词要有确定换算,时钟是唯一起点。
  const structure = buildStructureMessages({
    narrative: "过了几日，他才重新落座。",
    context: {},
    choice: { text: "闭门不出" },
    check: { result: "success" },
  });
  assert.match(structure[0].content, /与正文写出的流逝等量/);
  assert.match(structure[0].content, /几日\/数日.{0,12}3 日（4320 分钟）/);
  assert.match(structure[0].content, /storyClock 为起点/);

  const narrative = buildNarrativeMessages({
    context: {},
    choice: { text: "观察" },
    check: { result: "success" },
  });
  assert.match(narrative[0].content, /时间推进约束/);
  assert.match(narrative[0].content, /jumpMinutes 声明等量分钟/);
  // 时间流逝必须写明(拍板 2026-08-21):正文开头交代距上一手时钟的流逝。
  assert.match(narrative[0].content, /storyClockPrev/);
  assert.match(narrative[0].content, /跨日必须明写天数/);
});

test("structure prompt carries the narrative and protocol corrections", () => {
  const messages = buildStructureMessages({
    narrative: "潮声靠近。",
    context: {},
    choice: { text: "观察" },
    check: { result: "failure" },
    attempt: 1,
  });
  const system = messages[0].content;
  assert.match(system, /上次输出未通过协议校验/);
  const input = JSON.parse(messages[1].content.split("\n").at(-1));
  assert.equal(input.narrative, "潮声靠近。");
  assert.equal(input.adjudication, "failure");
});

test("canon-past directives demand consistency with already-happened canon events", () => {
  const narrative = buildNarrativeMessages({
    context: {},
    choice: { text: "观察" },
    check: { result: "success" },
  });
  assert.match(narrative[0].content, /原著现状约束/);
  assert.match(narrative[0].content, /已灭门的门派不得照常存在/);
  assert.match(narrative[0].content, /canonPast/);

  const structure = buildStructureMessages({
    narrative: "潮声。",
    context: {},
    choice: { text: "观察" },
    check: { result: "success" },
  });
  assert.match(structure[0].content, /原著现状约束/);
  assert.match(structure[0].content, /不得去投奔已灭门的门派/);
});

test("ending-approach directives live in both prompts", () => {
  const narrative = buildNarrativeMessages({
    context: {},
    choice: { text: "观察" },
    check: { result: "success" },
  });
  assert.match(narrative[0].content, /context\.endingApproach 存在时，命运阶段临近收束/);

  const structure = buildStructureMessages({
    narrative: "潮声。",
    context: {},
    choice: { text: "观察" },
    check: { result: "success" },
  });
  assert.match(structure[0].content, /了结未竟之事/);
  assert.match(structure[0].content, /不得写明这是终局前夜/);
});

test("divergence-approach foreshadowing directives live in both prompts", () => {
  const narrative = buildNarrativeMessages({
    context: {},
    choice: { text: "观察" },
    check: { result: "success" },
  });
  assert.match(narrative[0].content, /context\.divergenceApproach 存在时，改命的火候已到/);
  assert.match(narrative[0].content, /不得出现「势能」「阈值」「判定」「机制」等字样/);

  const structure = buildStructureMessages({
    narrative: "潮声。",
    context: {},
    choice: { text: "观察" },
    check: { result: "success" },
  });
  assert.match(structure[0].content, /context\.divergenceApproach 存在时，options 应提供发动最终改写的行动方向/);
  // 结构侧阈值口径:按 context.activeDivergence 的 threshold 判断,代码再硬校验。
  assert.match(structure[0].content, /momentum 已达到其 threshold/);
  assert.match(structure[0].content, /已发生（resolved\/invalidated）的原著事件不再是可改目标/);
});

test("replacement-event directive lives in the structure prompt", () => {
  const structure = buildStructureMessages({
    narrative: "潮声。",
    context: {},
    choice: { text: "观察" },
    check: { result: "success" },
  });
  assert.match(structure[0].content, /replacementEvent 是可选字段/);
  assert.match(structure[0].content, /被改命运的下游原著事件会自然停摆/);
  assert.match(structure[0].content, /非法引用会被代码丢弃/);
});

test("successor openings inject past-life facts without naming the past life", () => {
  const messages = buildOpeningMessages({
    world: { title: "灰港", summary: "港", locations: [], factions: [], style: {} },
    state: { player: { name: "后来者" }, locationId: "gate", personalGoals: [] },
    successor: true,
    styleSamples: [],
    pastLifeFacts: [
      { text: "沈砚曾以旅人出身，活到第 12 回合，最终力竭而亡。" },
      { text: "半枚燕尾铜扣被重新熔成了灯芯。" },
    ],
  });
  const content = messages[1].content;
  assert.match(content, /沈砚曾以旅人出身/);
  assert.match(content, /不得点破前世的姓名/);
  const [jsonPart] = content.split("\n以下世界事实");
  const input = JSON.parse(jsonPart);
  assert.equal(input.successor, true);
  assert.equal(input.pastLifeFacts.length, 2);
});

test("fresh openings never carry past-life facts", () => {
  const messages = buildOpeningMessages({
    world: { title: "灰港", summary: "港", locations: [], factions: [], style: {} },
    state: { player: { name: "沈砚" }, locationId: "gate", personalGoals: [] },
    successor: false,
    styleSamples: [],
    pastLifeFacts: [{ text: "沈砚曾以旅人出身，活到第 12 回合，最终力竭而亡。" }],
  });
  assert.doesNotMatch(messages[1].content, /以下世界事实/);
  assert.doesNotMatch(messages[1].content, /活到第 12 回合/);
});

test("capability directives drive options and narration", () => {
  const narrative = buildNarrativeMessages({
    context: {},
    choice: { text: "观察" },
    check: { result: "success" },
  });
  assert.match(narrative[0].content, /能力一致约束/);
  assert.match(narrative[0].content, /playerCapabilities/);

  const structure = buildStructureMessages({
    narrative: "潮声。",
    context: {},
    choice: { text: "观察" },
    check: { result: "success" },
  });
  assert.match(structure[0].content, /能力式选项约束/);
  assert.match(structure[0].content, /禁止超出身份与原文上限的神通/);
});

test("capability directives stay genre-neutral across all book types", () => {
  const narrative = buildNarrativeMessages({
    context: {},
    choice: { text: "观察" },
    check: { result: "success" },
  });
  // 叙事指令按题材写明能力词汇来源,不只仙侠。
  for (const example of ["仙侠玄幻是法术/神识/御器", "武侠是内功/招式/轻功", "都市与职场是职权/人脉/技能", "悬疑是刑侦手段/权限", "历史是官职权柄"]) {
    assert.ok(narrative[0].content.includes(example), `叙事指令应含「${example}」`);
  }
  assert.match(narrative[0].content, /能力随题材而异/);
  const structure = buildStructureMessages({
    narrative: "潮声。",
    context: {},
    choice: { text: "观察" },
    check: { result: "success" },
  });
  for (const example of ["放出神识扫探院落", "以内力震开锁闩", "以主编之权调阅稿件", "调取片区监控", "以钦差之权开仓放粮"]) {
    assert.ok(structure[0].content.includes(example), `结构指令应含 ${example}`);
  }
});

test("creation inputs fully wire into option generation", () => {
  const structure = buildStructureMessages({
    narrative: "潮声。",
    context: {},
    choice: { text: "观察" },
    check: { result: "success" },
  });
  const system = structure[0].content;
  // 特质门槛改为玩家身份蕴含的特质,而非世界特质表。
  assert.match(system, /playerCapabilities\.traitIds/);
  assert.match(system, /低微身份不得凭空拿到高境界行动/);
  // 职权行动必须带 factionId + authority,只有身份自带职权才生成。
  assert.match(system, /必须带 requirements\.factionId 与 authority/);
  // 诉求由时局自然长成:不再要求每回合贴近固定动机。
  assert.match(system, /由时局自然长成/);
  assert.match(system, /不得生造目标硬凑选项/);
  // 性格门控已取消(选项即意图):bigFive 阈值与 excludedBigFive 全部移除。
  assert.doesNotMatch(system, /excludedBigFive/);
  assert.doesNotMatch(system, /openness≥60/);
  assert.match(system, /选项不设性格门槛/);
  // 心性漂移:选项标注 bigFiveShift,与性子相悖的行动漂移更大。
  assert.match(system, /bigFiveShift/);
  assert.match(system, /±4~5/);
  // 道德弹性:不同人物可立场迥异。
  assert.match(system, /对一人行善、对另一人行恶完全自由/);
  // 性别设定:称谓与涉性别剧情按 gender 走,未定保持模糊。
  assert.match(system, /性别设定（context\.playerCapabilities\.gender）/);
  assert.match(system, /性别未定（null）时不要生成只有特定性别才成立的桥段/);
});

test("全员人设条款注入结构与叙事", () => {
  const structure = buildStructureMessages({
    narrative: "潮声。",
    context: {},
    choice: { text: "观察" },
    check: { result: "success" },
  });
  assert.match(structure[0].content, /全员人设约束/);
  assert.match(structure[0].content, /context\.world\.characters\[\]\.persona/);
  const narrative = buildNarrativeMessages({
    context: {},
    choice: { text: "观察" },
    check: { result: "success" },
  });
  assert.match(narrative[0].content, /全员人设约束/);
  assert.match(narrative[0].content, /世界观约束/);
});

test("opening carries role abilities, traits and the consistency clause", () => {
  const messages = buildOpeningMessages({
    world: {
      title: "灰港",
      summary: "港",
      locations: [],
      factions: [],
      style: {},
      traits: [{ id: "t1", name: "境界", value: "元婴", description: "老祖" }],
    },
    state: {
      player: { name: "沈砚", abilities: ["能以神识扫探方圆数里"] },
      locationId: "gate",
      personalGoals: [],
    },
    successor: false,
    styleSamples: [],
    pastLifeFacts: [],
  });
  const input = JSON.parse(messages[1].content);
  assert.deepEqual(input.player.abilities, ["能以神识扫探方圆数里"]);
  assert.deepEqual(input.world.traits, [{ id: "t1", name: "境界", value: "元婴", description: "老祖" }]);
  assert.match(messages[0].content, /开场演出要与角色的身份与能力一致/);
});

test("rewrite notes append violation lists to narrative, structure and opening", () => {
  const narrative = buildNarrativeMessages({
    context: {},
    choice: { text: "观察" },
    check: { result: "success" },
    rewriteNote: "违例清单：- 练气修士不该御剑飞行",
  });
  assert.match(narrative[1].content, /违例清单：- 练气修士不该御剑飞行/);

  const structure = buildStructureMessages({
    narrative: "潮声。",
    context: {},
    choice: { text: "观察" },
    check: { result: "success" },
    correctionNote: "违例清单：- 选项超出了身份上限",
  });
  assert.match(structure[0].content, /违例清单：- 选项超出了身份上限/);

  const opening = buildOpeningMessages({
    world: { title: "灰港", summary: "港", locations: [], factions: [], style: {}, traits: [] },
    state: { player: { name: "沈砚", abilities: [] }, locationId: "gate", personalGoals: [] },
    successor: false,
    styleSamples: [],
    pastLifeFacts: [],
    rewriteNote: "违例清单：- 开场让凡人放出了神识",
  });
  assert.match(opening[1].content, /违例清单：- 开场让凡人放出了神识/);
});

test("consistency checker messages carry capabilities, narrative and options", () => {
  const messages = buildConsistencyCheckMessages({
    narrative: "他放出神识扫探。",
    options: [{ id: "a", text: "放出神识扫探院落" }],
    capabilities: {
      roleName: "元婴长老",
      abilities: ["能以神识扫探方圆数里"],
      bigFive: [{ key: "openness", level: "偏低", selections: ["先求稳妥"] }],
    },
  });
  const input = JSON.parse(messages[1].content);
  assert.equal(input.capabilities.roleName, "元婴长老");
  assert.deepEqual(input.capabilities.bigFive[0].key, "openness");
  assert.equal(input.narrative, "他放出神识扫探。");
  assert.equal(input.options.length, 1);
  assert.match(messages[0].content, /只报实质违例/);
  assert.match(messages[0].content, /高修为\/高职权的身份被写成凡人手忙脚乱/);
  // 心性只作参考,不再作为违例依据(选项即意图):人格冲突条款已移除。
  assert.match(messages[0].content, /capabilities\.bigFive/);
  assert.match(messages[0].content, /不作为违例依据/);
  assert.doesNotMatch(messages[0].content, /把低分维度的行为写成玩家的自然反应/);
  // 道德豁免(行动即立场):玩家的善恶摇摆从不检查。
  assert.match(messages[0].content, /善恶摇摆/);
  assert.match(messages[0].content, /绝不检查玩家道德/);
});

test("consistency checker carries the story clock and a time-violation clause", () => {
  // 时间约束(拍板:推演的时间贴着原著走):时钟必须送达,⑩类违例只查硬矛盾。
  const messages = buildConsistencyCheckMessages({
    narrative: "翌日正午，他再次登楼。",
    options: [],
    capabilities: { roleName: "散修", abilities: [], bigFive: [] },
    storyClock: { label: "第 3 日 · 黄昏", day: 3, hour: 18, segment: "黄昏" },
    storyClockPrev: { label: "第 1 日 · 深夜", day: 1, hour: 1, segment: "深夜" },
  });
  const input = JSON.parse(messages[1].content);
  assert.equal(input.storyClock.label, "第 3 日 · 黄昏");
  assert.equal(input.storyClockPrev.day, 1, "上一手时钟送达到校验器");
  assert.match(messages[0].content, /⑩时间表述与故事时钟矛盾/);
  assert.match(messages[0].content, /昼夜颠倒/);
  // 模糊时间不算违例:防止校验器把「片刻」「不知过了多久」当违例刷重写。
  assert.match(messages[0].content, /不算违例/);
  // 跨日不提即违例(拍板 2026-08-21):正文必须交代过了多少天。
  assert.match(messages[0].content, /跨了天却只字不提/);
});

test("consistency checker carries persona cards and worldview digest", () => {
  const messages = buildConsistencyCheckMessages({
    narrative: "他御剑而起。",
    options: [],
    capabilities: { roleName: "散修", abilities: ["能望气辨凶吉"], bigFive: [] },
    characters: [
      {
        id: "han",
        name: "韩立",
        persona: { temperament: "谨慎多疑", motives: "求长生", bottomLines: "不背信", manner: "寡言" },
      },
    ],
    worldview: {
      title: "凡人书",
      summary: "仙侠世界",
      traits: [{ id: "t1", name: "筑基期", value: "御物", description: "境界阶梯" }],
      rules: {},
    },
  });
  const input = JSON.parse(messages[1].content);
  assert.equal(input.characters[0].id, "han");
  assert.equal(input.characters[0].persona.temperament, "谨慎多疑");
  assert.equal(input.worldview.title, "凡人书");
  assert.equal(input.worldview.traits[0].name, "筑基期");
  // 扩范围条款:世界观礼法违例作为第 ⑥ 类实质违例。
  assert.match(messages[0].content, /⑥世界观礼法违例/);
  assert.match(messages[0].content, /超出 traits\/rules 上限的力量/);
});

// —— 行动即立场:同一世在不同事上作恶/行善 ——

test("叙事层行动即立场:不下道德总评、后果按对象分别结算", () => {
  const narrative = buildNarrativeMessages({
    context: {},
    choice: { text: "观察" },
    check: { result: "success" },
  });
  const system = narrative[0].content;
  assert.match(system, /行动即立场/);
  assert.match(system, /在这一事上行恶、另一事上行善/);
  assert.match(system, /不得给玩家下道德总评/);
  assert.match(system, /不得强塞良心谴责、愧疚救赎或「改邪归正」弧/);
  assert.match(system, /后果按对象分别结算/);
  assert.match(system, /名声扩散必须有具体因果链/);
});

test("结构层道德弹性:善恶两路选项都要出现,不预设立场", () => {
  const structure = buildStructureMessages({
    narrative: "潮声。",
    context: {},
    choice: { text: "观察" },
    check: { result: "success" },
  });
  const system = structure[0].content;
  assert.match(system, /道德弹性/);
  assert.match(system, /作恶与行善的方向都应当自然出现为选项/);
  assert.match(system, /不得预设玩家立场/);
  assert.match(system, /不得因一次行恶或行善整体上调或下调无关人物/);
});

// —— 游玩模式:爽文/原味提示词接线 ——

test("爽文模式注入基调指令,原味不注入", () => {
  const powerNarrative = buildNarrativeMessages({
    context: { state: { playMode: "power" } },
    choice: { text: "观察" },
    check: { result: "success" },
  });
  assert.match(powerNarrative[1].content, /本世基调\(爽文/);
  assert.match(powerNarrative[1].content, /爽不能崩人设/);

  const powerStructure = buildStructureMessages({
    narrative: "潮声。",
    context: { state: { playMode: "power" } },
    choice: { text: "观察" },
    check: { result: "success" },
  });
  assert.match(powerStructure[1].content, /本世基调\(爽文/);
  assert.match(powerStructure[1].content, /改命铺垫\(fire=false\)/);

  const classic = buildStructureMessages({
    narrative: "潮声。",
    context: { state: { playMode: "classic" } },
    choice: { text: "观察" },
    check: { result: "success" },
  });
  assert.doesNotMatch(classic[1].content, /本世基调/);
});

test("绝境转机标记注入下一回合叙事指令", () => {
  const narrative = buildNarrativeMessages({
    context: { state: { playMode: "power", powerEscape: { turn: 3, cause: "坠海" } } },
    choice: { text: "观察" },
    check: { result: "success" },
  });
  assert.match(narrative[1].content, /绝境转机\(重要\)/);
  assert.match(narrative[1].content, /死里逃生/);

  const classic = buildNarrativeMessages({
    context: { state: { playMode: "classic", powerEscape: { turn: 3, cause: "坠海" } } },
    choice: { text: "观察" },
    check: { result: "success" },
  });
  assert.doesNotMatch(classic[1].content, /绝境转机\(重要\)/, "原味不注入转机指令");
});

test("爽文开场带向上气象指令,原味不带", () => {
  const openingBase = {
    world: { title: "灰港", summary: "港", locations: [], factions: [], style: {}, traits: [] },
    successor: false,
    styleSamples: [],
    pastLifeFacts: [],
  };
  const power = buildOpeningMessages({
    ...openingBase,
    state: { player: { name: "沈砚", abilities: [] }, locationId: "gate", personalGoals: [], playMode: "power" },
  });
  assert.match(power[0].content, /爽文开局/);
  assert.match(power[0].content, /不得点破模式/);

  const classic = buildOpeningMessages({
    ...openingBase,
    state: { player: { name: "沈砚", abilities: [] }, locationId: "gate", personalGoals: [], playMode: "classic" },
  });
  assert.doesNotMatch(classic[0].content, /爽文开局/);
});

test("回合协议取消性格门控字段,保留心性漂移", () => {
  const optionSchema =
    SUBMIT_TURN_FUNCTION.parameters.properties.options.items.properties;
  const requirements = optionSchema.requirements.properties;
  assert.equal("bigFive" in requirements, false, "bigFive 门槛字段已移除");
  assert.equal("excludedBigFive" in requirements, false, "excludedBigFive 门槛字段已移除");
  assert.equal("bigFiveShift" in optionSchema, true, "心性漂移字段保留");
});

// —— 意图驱动选项(拍板 2026-08-17 追加:预设选项取消,选项由玩家意图动态产生) ——

test("意图指令只注入意图生成消息,不注入叙事与结构请求", () => {
  const intentMessages = buildIntentOptionsMessages({
    context: { state: { turn: 1 } },
    intent: "复仇",
  });
  assert.match(intentMessages[1].content, /玩家意图/);
  assert.match(intentMessages[1].content, /复仇/);
  // 意图生成器系统提示以「意图是靶心、不可偏离」为核心。
  assert.match(intentMessages[0].content, /意图是唯一的靶心/);

  const structure = buildStructureMessages({
    narrative: "潮声。",
    context: {},
    choice: { text: "观察" },
    check: { result: "success" },
  });
  assert.doesNotMatch(structure[1].content, /玩家意图/, "结构请求不再注入意图(选项由意图生成)");

  const narrative = buildNarrativeMessages({
    context: {},
    choice: { text: "观察" },
    check: { result: "success" },
  });
  assert.doesNotMatch(narrative[1].content, /玩家意图/, "叙事不被方向偏好扭曲");
});

test("普通回合结构请求不产选项:只交锋回合输出搏杀选项", () => {
  const structure = buildStructureMessages({
    narrative: "潮声。",
    context: {},
    choice: { text: "观察" },
    check: { result: "success" },
  });
  assert.match(structure[0].content, /普通回合一律省略/);
  assert.match(structure[0].content, /options 仅交锋回合输出/);
  // 交锋规则仍在(交锋回合照旧输出 2-4 个搏杀选项)。
  assert.match(structure[0].content, /options 只给 2-4 个搏杀行动/);
});

test("意图重生成消息带净化后的意图,submit_options 工具只含 options", () => {
  const messages = buildIntentOptionsMessages({
    context: { state: { turn: 1 } },
    intent: '  「复仇」\u0007 ',
  });
  assert.match(messages[1].content, /玩家意图/);
  assert.match(messages[1].content, /复仇/);
  assert.doesNotMatch(messages[1].content, /\u0007/, "控制字符被净化");

  const tool = submitOptionsTool();
  assert.equal(tool.function.name, "submit_options");
  const properties = tool.function.parameters.properties;
  assert.equal("options" in properties, true);
  assert.equal("delta" in properties, false, "意图重生成不产出回合数据");
  assert.deepEqual(properties.options, SUBMIT_TURN_FUNCTION.parameters.properties.options, "选项 schema 与回合协议一致");
});

// —— 玩家三律(拍板:原著不存在/零背景/符合身份能力)的提示词防线 ——

test("opening forbids invented background; start location is first appearance only", () => {
  const messages = buildOpeningMessages({
    world: { title: "灰港", summary: "港", locations: [], factions: [], style: {}, traits: [] },
    state: { player: { name: "阿禾", abilities: [] }, locationId: "gate", personalGoals: [] },
    successor: false,
    styleSamples: [],
    pastLifeFacts: [],
  });
  assert.match(messages[0].content, /没有任何背景的新来者/);
  assert.match(messages[0].content, /首次登场之处/);
  assert.match(messages[0].content, /不得写成其出身故里或长居之地/);
  assert.match(messages[0].content, /不得编造其来历、家世、师承、亲眷或故旧/);
});

test("story and structure prompts carry the settled background rules", () => {
  // 拍板 2026-08-20（意图即人设，背景零牙齿）：background 非空=定约写定的
  // 既定事实可自然带出；为空=旧档新来者，维持不得编造来历的旧约束。
  const narrative = buildNarrativeMessages({
    context: {},
    choice: { text: "观察" },
    check: { result: "success" },
  });
  assert.match(narrative[0].content, /来历约束/);
  assert.match(narrative[0].content, /playerCapabilities\.background 是玩家定约写定的来历/);
  assert.match(narrative[0].content, /不得把落点写成其出身故里/);
  assert.match(narrative[0].content, /不带判定能力/);

  const structure = buildStructureMessages({
    narrative: "潮声。",
    context: {},
    choice: { text: "观察" },
    check: { result: "success" },
  });
  assert.match(structure[0].content, /选项的来历前提以 playerCapabilities\.background/);
  assert.match(structure[0].content, /background 为空时不得生成依赖任何来历的行动/);
  assert.match(structure[0].content, /背景不带能力/);
});

test("consistency checker distinguishes settled background from fabrication", () => {
  const messages = buildConsistencyCheckMessages({
    narrative: "他想起幼时在燕尾巷的家。",
    options: [],
    capabilities: { roleName: "行脚游方", abilities: [], background: "燕尾巷长大的脚夫" },
    characters: [],
    worldview: { summary: "", traits: [], rules: [] },
  });
  assert.match(messages[0].content, /玩家背景违例/);
  assert.match(messages[0].content, /定约写定的来历/);
  assert.match(messages[0].content, /起始地点写成出身故里/);
  assert.match(messages[0].content, /立场自由，背景不是笼子/);
  const input = JSON.parse(messages[1].content);
  assert.equal(input.capabilities.background, "燕尾巷长大的脚夫");
});

// —— 原文保真(canonNow + canonUpcoming):推演必须仔细贴着原文、符合原著走向 ——

test("story prompt grounds narration in the canon-now excerpts", () => {
  const narrative = buildNarrativeMessages({
    context: {},
    choice: { text: "观察" },
    check: { result: "success" },
  });
  assert.match(narrative[0].content, /原著此刻（?\(?context\.canonNow/);
  assert.match(narrative[0].content, /推演必须仔细贴着原文/);
  assert.match(narrative[0].content, /已发生之事不得写成未发生/);
  assert.match(narrative[0].content, /人物不得出现在原文没写的位置/);
});

test("canon prompts acknowledge simultaneous parallel events (拍板 2026-08-20)", () => {
  const narrative = buildNarrativeMessages({
    context: {},
    choice: { text: "观察" },
    check: { result: "success" },
  });
  assert.match(narrative[0].content, /多条事件可能同时异地发生/);
  assert.match(narrative[0].content, /并行多线的书，同一故事时刻两线各有进展/);
  assert.match(narrative[0].content, /同一时刻两线各有将至之事，属正常交织/);
  assert.match(narrative[0].content, /不得写成玩家亲历/);
});

test("story prompt enforces the canon direction via canonUpcoming", () => {
  const narrative = buildNarrativeMessages({
    context: {},
    choice: { text: "观察" },
    check: { result: "success" },
  });
  assert.match(narrative[0].content, /原著走向/);
  assert.match(narrative[0].content, /context\.canonUpcoming/);
  assert.match(narrative[0].content, /推演若影响重大/);
  assert.match(narrative[0].content, /必须符合原著走向/);
  assert.match(narrative[0].content, /改命行动/);
});

test("structure options must not contradict the canon direction", () => {
  const structure = buildStructureMessages({
    narrative: "潮声。",
    context: {},
    choice: { text: "观察" },
    check: { result: "success" },
  });
  assert.match(structure[0].content, /原著走向约束/);
  assert.match(structure[0].content, /context\.canonUpcoming/);
  assert.match(structure[0].content, /divergence 声明/);
});

test("consistency checker receives canon excerpts and flags both canon contradictions", () => {
  const messages = buildConsistencyCheckMessages({
    narrative: "林雾在盐仓里清点账册。",
    options: [],
    capabilities: { roleName: "行脚游方", abilities: [] },
    characters: [],
    worldview: { summary: "", traits: [], rules: [] },
    canonNow: [{ chapter: 2, text: "此刻林雾应在灯塔值夜。" }],
    canonUpcoming: [{ id: "e9", text: "第 9 章盐仓账册将被烧毁", time: 500 }],
  });
  const input = JSON.parse(messages[1].content);
  assert.equal(input.canonNow.length, 1);
  assert.match(input.canonNow[0].text, /灯塔值夜/);
  assert.equal(input.canonUpcoming.length, 1);
  assert.match(input.canonUpcoming[0].text, /盐仓账册将被烧毁/);
  assert.match(messages[0].content, /与原著此刻不符/);
  assert.match(messages[0].content, /canonNow 片段明显矛盾/);
  assert.match(messages[0].content, /与原著走向不符/);
  assert.match(messages[0].content, /canonUpcoming/);
  assert.match(messages[0].content, /改命机制（divergence）主动改变命运不属于违例/);
});

test("arc planner carries player role capabilities and boundary rules", () => {
  const messages = buildArcPlanMessages({
    world: {
      title: "灰港",
      summary: "港城",
      characters: [{ id: "lin", name: "林雾", role: "守灯人" }],
      locations: [{ id: "gate", name: "旧码头", connections: [] }],
      factions: [],
      traits: [{ id: "r1", name: "练气期", value: "吐纳" }],
      timeline: [],
      roleTemplates: [{ id: "wanderer", name: "行脚游方", locationIds: [], factionIds: [] }],
    },
    state: {
      turn: 3,
      location: "旧码头",
      locationId: "gate",
      player: {
        roleId: "wanderer",
        roleName: "行脚游方",
        abilities: ["认得港城的潮水时辰"],
        traitIds: ["r1"],
      },
      discoveredCharacterIds: ["lin"],
      personalGoals: [],
    },
    history: [],
    arcHistory: [],
  });
  assert.match(messages[0].content, /玩家能力边界/);
  assert.match(messages[0].content, /不得与原著人物伪造旧识/);
  const input = JSON.parse(messages[1].content);
  assert.equal(input.playerRole.roleName, "行脚游方");
  assert.deepEqual(input.playerRole.abilities, ["认得港城的潮水时辰"]);
  assert.deepEqual(input.playerRole.realmTraits, ["练气期"]);
  assert.equal(input.playerRole.background, "");
});

// 反向建角的提案构建器已随白描管线整删（拍板 2026-08-20 R14）。

test("opening prompt weaves the settled background and keeps the blank-save fallback", () => {
  const messages = buildOpeningMessages({
    world: { title: "灰港", summary: "港城", locations: [], factions: [], style: {}, traits: [] },
    state: {
      playMode: "classic",
      player: { name: "李拾", gender: "male", background: "自北边来的脚夫" },
      personalGoals: [{ publicDirection: "挣出基业" }],
    },
    styleSamples: [],
    pastLifeFacts: [],
  });
  assert.match(messages[0].content, /player\.background 是定约写定的来历/);
  assert.match(messages[0].content, /background 为空时/);
  assert.match(messages[0].content, /不得与原著人物伪造旧识/);
  const input = JSON.parse(messages[1].content);
  assert.equal(input.player.background, "自北边来的脚夫");
  assert.equal(input.publicGoal, "挣出基业");
});
