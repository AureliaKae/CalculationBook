import { storyStart } from "./timeline.js";
import { emptyGameplayState, migrateGameplayState, divergenceTargetGate } from "./gameplay-systems.js";
import { characterNamesOf, isCharacterBoundName, isCharacterBoundRoleName } from "./identity-guard.js";
import { clampRules, emptyAdaptation } from "./rules.js";
import { AUTHORITY_VALUES, applyRoleIdentity } from "./role-identity.js";
import { isPowerMode, normalizeModeProfile, POWER_PREREQ_SCALE } from "./play-mode.js";

export { AUTHORITY_VALUES };

const RELATION_FIELDS = ["stance", "trust", "leverage", "fear", "hostility"];
const ENTITY_STATUSES = new Set(["active", "missing", "captured", "injured", "dead"]);
const EVENT_RESOLUTIONS = new Set(["player_action", "world_time", "system_patch", "never"]);
// 角色创建的身外字段（外貌/个人细节）合法清单：世界档案 creationFields 按书裁剪，出现即必填。
// 称谓已取消:旁人对玩家的称呼完全由叙事按故事语境自然产生。
const CREATION_FIELD_KEYS = ["appearance", "details"];
const DEFAULT_CREATION_FIELDS = {
  appearance: { key: "appearance", label: "外貌", placeholder: "一眼可见的模样" },
  details: { key: "details", label: "个人细节", placeholder: "" },
};
const STAT_ROLE_ALIASES = new Map([
  ["vital", "vital"],
  ["生命", "vital"],
  ["生存", "vital"],
  ["健康", "vital"],
  ["resource", "resource"],
  ["资源", "resource"],
  ["消耗", "resource"],
  ["progress", "progress"],
  ["进度", "progress"],
  ["成长", "progress"],
  ["relation", "relation"],
  ["关系", "relation"],
  ["社交", "relation"],
]);
const STAT_ROLE_PATTERNS = [
  ["vital", /生命|气血|血量|健康|伤势|体力|余息/],
  ["relation", /关系|好感|信任|忠诚|敌意|仇恨|声望/],
  ["progress", /修为|境界|经验|等级|线索|进度|完成度|熟练/],
  ["resource", /灵力|法力|真气|内力|耐力|物资|口粮|金钱|金币|弹药|次数/],
];
// 大五人格:五维固定、维度内选项可随书烘焙。数值 0-100 只供引擎判定与门控,
// 界面只做定性展示(沿用「创建界面不数值化」拍板)。
export const BIG_FIVE_DIMENSIONS = ["openness", "conscientiousness", "extraversion", "agreeableness", "neuroticism"];
export const BIG_FIVE_LABELS = Object.freeze({
  openness: "开放性",
  conscientiousness: "尽责性",
  extraversion: "外向性",
  agreeableness: "宜人性",
  neuroticism: "情绪稳定性",
});

// 内置通用大五目录:旧书与兜底世界使用;新烧书籍由烘焙管线按原著生成专属目录。
// 每维至少一个 high 与一个 low 极端;好面/坏面是同一行为的正反两面,无数值后果。
const DEFAULT_BIG_FIVE = Object.freeze({
  openness: [
    { id: "open-explore", name: "先探个究竟", description: "面对未知，先弄清它到底是什么", pole: "high", weight: 1, goodSide: "好奇心旺盛，总能发现暗处的门路", badSide: "容易被新鲜事带偏，忘了原本的盘算" },
    { id: "open-new-way", name: "乐意换条新路", description: "旧办法走不通时，愿意换一种活法", pole: "high", weight: 1, goodSide: "在变动里更能抓住机会", badSide: "对旧经验不够敬重，容易轻率改弦" },
    { id: "open-cautious", name: "先求稳妥", description: "面对未知，先照熟悉的办法来", pole: "low", weight: 1, goodSide: "稳当，不轻易踏进没底的坑", badSide: "守旧，容易错过别处的出路" },
    { id: "open-orthodox", name: "按老规矩行事", description: "祖辈走过的路总归有它的道理", pole: "low", weight: 1, goodSide: "少犯错，身边人觉得可靠", badSide: "僵化，新世道里反应慢半拍" },
  ],
  conscientiousness: [
    { id: "cons-plan", name: "谋定而后动", description: "动手之前，先把路数想清楚", pole: "high", weight: 1, goodSide: "可靠，许下的事会一件件做完", badSide: "固执，计划被打乱时容易焦躁" },
    { id: "cons-discipline", name: "自律克己", description: "该做的功课不拖到明天", pole: "high", weight: 1, goodSide: "耐得住苦，也守得住约", badSide: "对自己对别人都太苛刻" },
    { id: "cons-go-flow", name: "随性而行", description: "计划赶不上变化，不如临场看着办", pole: "low", weight: 1, goodSide: "随和，不拿条条框框压人", badSide: "松散，要紧事容易一拖再拖" },
    { id: "cons-spontaneous", name: "兴致来了就做", description: "心血来潮比日程表更可靠", pole: "low", weight: 1, goodSide: "有急智，也敢临时起意", badSide: "半途而废，承诺常常不了了之" },
  ],
  extraversion: [
    { id: "extra-outgoing", name: "与人打交道来劲", description: "人多的场合反而更有精神", pole: "high", weight: 1, goodSide: "结交快，消息也灵通", badSide: "耐不住独处，静不下心深想" },
    { id: "extra-voice", name: "有话就说", description: "想法摆在台面上，不藏着掖着", pole: "high", weight: 1, goodSide: "坦率，容易赢得信任", badSide: "口快，容易得罪人" },
    { id: "extra-quiet", name: "多听少说", description: "在人群里更愿意做个旁观者", pole: "low", weight: 1, goodSide: "沉得住气，看得清门道", badSide: "存在感低，诉求容易被忽略" },
    { id: "extra-solo", name: "独处自得", description: "一个人待着比应酬更自在", pole: "low", weight: 1, goodSide: "专注，心思比旁人都细", badSide: "孤立，关键时找不到帮手" },
  ],
  agreeableness: [
    { id: "agree-helpful", name: "能帮就帮一把", description: "别人的难处，看着就放不下", pole: "high", weight: 1, goodSide: "厚道，结下善缘", badSide: "心软，容易被利用" },
    { id: "agree-harmony", name: "以和为贵", description: "先退一步，把话说开", pole: "high", weight: 1, goodSide: "化解冲突，少结仇家", badSide: "一味退让，底线会被试探" },
    { id: "agree-straight", name: "该争就争", description: "自己的东西，一寸也不让", pole: "low", weight: 1, goodSide: "耿直，别人不敢随便拿捏", badSide: "尖锐，容易把路走窄" },
    { id: "agree-skeptical", name: "先怀疑三分", description: "好意来得太顺，多半有蹊跷", pole: "low", weight: 1, goodSide: "警觉，圈套难近身", badSide: "多疑，把善意也挡在门外" },
  ],
  neuroticism: [
    { id: "neuro-steady", name: "天塌了也先喘口气", description: "越乱越要稳住自己", pole: "low", weight: 1, goodSide: "沉着，危局里是众人的主心骨", badSide: "钝感，对危险与人心不够警觉" },
    { id: "neuro-level", name: "情绪不轻易上脸", description: "喜怒哀乐都收在袖子里", pole: "low", weight: 1, goodSide: "克制，不会因一时意气坏事", badSide: "压抑，心事积久了会一起找上门" },
    { id: "neuro-alert", name: "事事都往坏处想一层", description: "未雨绸缪，先想最糟的情形", pole: "high", weight: 1, goodSide: "敏锐，危险来临前先有察觉", badSide: "多虑，无风也能掀起三尺浪" },
    { id: "neuro-sensitive", name: "心细如发", description: "一句话一个眼神都放在心上", pole: "high", weight: 1, goodSide: "细腻，能体察旁人察觉不到的异样", badSide: "易碎，一句话就能伤着" },
  ],
  motivations: [
    ["survive", "先活下去", "在陌生世界中建立稳定立足点"],
    ["find-person", "寻找某人", "追查一名重要之人的下落"],
    ["learn-truth", "查明真相", "理解一件改变人生的隐秘"],
    ["belong", "找到归属", "寻找可以真正立足的人群或地方"],
    ["protect", "守护重要之物", "保住一个人、地方或承诺"],
    ["change-fate", "改变命运", "摆脱已经显露的坏结局"],
  ],
});

// 大五维度分值定性:0-100 只供引擎判定,界面只显示高/中/低档位文案。
export function bigFiveLevel(value) {
  const score = Number(value);
  if (!Number.isFinite(score)) return "均衡";
  if (score >= 70) return "偏高";
  if (score <= 30) return "偏低";
  return "均衡";
}

function idFrom(value, prefix, index) {
  const source = String(value ?? "").trim().toLowerCase();
  const slug = source
    .normalize("NFKD")
    .replace(/[^\p{Letter}\p{Number}]+/gu, "-")
    .replace(/^-|-$/g, "");
  return slug || `${prefix}-${index + 1}`;
}

// 章节号归一：模型生成的首出章节可能是 "ch1"、"ch5"、"prologue" 或纯数字。
// 归一成整数便于与 unlockedChapter 做数值比较；prologue 记为 0。
function normalizeChapter(value, fallback) {
  if (Number.isFinite(value)) return value;
  const text = String(value ?? "").trim().toLowerCase();
  if (text === "prologue" || text === "序章" || text === "楔子") return 0;
  const match = /(\d+)/.exec(text);
  if (match) return Number(match[1]);
  return fallback;
}

function normalizeStatRole(stat) {
  const direct = STAT_ROLE_ALIASES.get(String(stat.role ?? "").trim().toLowerCase());
  if (direct) return direct;
  const semanticText = `${stat.id ?? ""} ${stat.name ?? ""} ${stat.role ?? ""}`;
  return STAT_ROLE_PATTERNS.find(([, pattern]) => pattern.test(semanticText))?.[0] ?? stat.role;
}

// 出处标记：区分「原著派生（canon）」「玩家原创（player_created）」与
// 「玩家行为涌现（emergent，拍板 2026-08-17：同伴只收涌现人物）」。
// 原创/涌现实体额外带 lifeIndex（第几世出现）与 createdTurn（第几回合出现），
// 同行者入队时还会补 companionSince——跨转世写回世界时据此追溯来源；
// 旧档没有 provenance 一律视为 canon。
const PROVENANCE_SOURCES = new Set(["canon", "player_created", "emergent"]);

function normalizeProvenance(provenance) {
  const source = PROVENANCE_SOURCES.has(provenance?.source) ? provenance.source : "canon";
  const normalized = { source };
  if (source !== "canon") {
    if (Number.isInteger(provenance?.lifeIndex)) normalized.lifeIndex = provenance.lifeIndex;
    if (Number.isInteger(provenance?.createdTurn)) normalized.createdTurn = provenance.createdTurn;
    if (Number.isInteger(provenance?.companionSince)) normalized.companionSince = provenance.companionSince;
  }
  return normalized;
}

// 模型 JSON 的列表字段形状不稳:数组原样保留,单个对象包成单元素数组
// (模型常把单条内容直接写成对象),其余形状(字符串/数字等)视为空。
// 只兜形状不兜内容:坏条目交给下游校验/修复,不在这里静默丢弃。
export function toArray(value) {
  if (Array.isArray(value)) return value;
  if (value && typeof value === "object") return [value];
  return [];
}

// 规范化名:trim + 压缩空白 + 小写,用于目录词条与身外选项的去重键。
function normalizeName(value) {
  return String(value ?? "").trim().replace(/\s+/g, " ").toLowerCase();
}

function normalizeCatalogItems(items, fallback) {
  const source = items?.length ? items : fallback;
  const seen = new Set();
  return source
    .slice(0, 12)
    .map((item, index) => {
      const base = Array.isArray(item)
        ? { id: item[0], name: item[1], description: item[2] }
        : {
            id: item.id || idFrom(item.name, "choice", index),
            name: item.name,
            description: item.description ?? "",
            requires: item.requires ?? {},
            excludes: item.excludes ?? [],
            attributeModifiers: item.attributeModifiers ?? {},
          };
      // 同名近义去重:只保留首次出现者,后面同名项丢弃——
      // 建角页不该出现两条换汤不换药的词条。
      const key = normalizeName(base.name);
      if (!key || seen.has(key)) return null;
      seen.add(key);
      return base;
    })
    .filter(Boolean);
}

// 大五目录逐维归一:坏形状(单对象/字符串/缺字段)按 toArray 容错,逐项补默认;
// 缺失维度回退内置通用目录(内容问题由 world-repair 质检报错,不在这里拦)。
function normalizeBigFiveCatalog(raw) {
  const result = {};
  for (const dim of BIG_FIVE_DIMENSIONS) {
    const items = toArray(raw && typeof raw === "object" && !Array.isArray(raw) ? raw[dim] : undefined)
      .filter((item) => item && typeof item === "object" && String(item.name ?? "").trim() !== "")
      .map((item, index) => ({
        id: item.id || idFrom(item.name, dim, index),
        name: String(item.name ?? "").trim(),
        description: String(item.description ?? ""),
        pole: item.pole === "low" ? "low" : "high",
        weight: item.weight === 2 ? 2 : 1,
        goodSide: String(item.goodSide ?? ""),
        badSide: String(item.badSide ?? ""),
      }));
    result[dim] = items.length ? items : structuredClone(DEFAULT_BIG_FIVE[dim]);
  }
  return result;
}

// 规范化结果缓存：normalizeWorld 是回合热点（buildContext、optionIsAvailable 每选项、
// validateResponse、applyEvolutionPatch 等每回合调用十余次），每次 deep-clone 整个世界代价不小。
// 对同一对象返回同一规范化结果，避免重复克隆；JSON 反序列化得到的新对象不受影响。
const NORMALIZED_WORLDS = new WeakSet();

export function normalizeWorld(input) {
  if (NORMALIZED_WORLDS.has(input)) return input;
  const world = structuredClone(input);
  world.stats = (world.stats ?? []).map((stat) => ({
    ...stat,
    role: normalizeStatRole(stat),
  }));
  world.traits = (world.traits ?? []).map((trait, index) => ({
    id: trait.id || idFrom(trait.name, "trait", index),
    name: trait.name,
    value: String(trait.value ?? ""),
    description: String(trait.description ?? ""),
  }));
  world.locations = (world.locations ?? []).map((location, index) =>
    typeof location === "string"
      ? {
          id: idFrom(location, "location", index),
          name: location,
          connections: [],
          provenance: normalizeProvenance(),
        }
      : {
          connections: [],
          ...location,
          provenance: normalizeProvenance(location.provenance),
        },
  );
  const locationByName = new Map(world.locations.map((item) => [item.name, item.id]));
  world.characters = (world.characters ?? [])
    .filter((character) => character.id !== "player")
    .map((character, index) => ({
      id: character.id || idFrom(character.name, "character", index),
      name: character.name,
      role: character.role ?? "原著人物",
      factionId: character.factionId ?? null,
      locationIds: (character.locationIds ?? world.locations.map((item) => item.id)).map(
        (location) => locationByName.get(location) ?? location,
      ),
      firstChapter: normalizeChapter(character.firstChapter, 1),
      lastChapter:
        character.lastChapter === null || character.lastChapter === undefined
          ? null
          : normalizeChapter(character.lastChapter, null),
      status: character.status ?? "active",
      summary: character.summary ?? "",
      detailed: Boolean(character.detailed),
      secrets: character.secrets ?? [],
      // 人设卡(拍板:所有人物言行符合人设与世界观):四字段短文本,缺省空。
      persona: {
        temperament: String(character.persona?.temperament ?? "").trim(),
        motives: String(character.persona?.motives ?? "").trim(),
        bottomLines: String(character.persona?.bottomLines ?? "").trim(),
        manner: String(character.persona?.manner ?? "").trim(),
      },
      provenance: normalizeProvenance(character.provenance),
    }));
  world.factions = (world.factions ?? []).map((faction, index) => ({
    id: faction.id || idFrom(faction.name, "faction", index),
    name: faction.name,
    summary: faction.summary ?? "",
    locationIds: faction.locationIds ?? [],
    provenance: normalizeProvenance(faction.provenance),
  }));
  world.items = (world.items ?? []).map((item, index) => ({
    id: item.id || idFrom(item.name, "item", index),
    name: item.name,
    summary: item.summary ?? "",
    locationIds: (item.locationIds ?? []).map((location) => locationByName.get(location) ?? location),
    provenance: normalizeProvenance(item.provenance),
  }));
  const factionByName = new Map(world.factions.map((item) => [item.name, item.id]));
  world.roleTemplates = (
    world.roleTemplates?.length
      ? world.roleTemplates
      : [{ id: "outsider", name: "无名之辈", description: "无名无势的外来者", factionIds: [], locationIds: [] }]
  ).map((role) => ({
    ...role,
    description: role.description ?? "",
    // 身份首次出现的章节：建角时按「打开全部信息」范围过滤，防剧透。
    firstChapter: normalizeChapter(role.firstChapter, 1),
    factionIds: (role.factionIds ?? []).map((faction) => factionByName.get(faction) ?? faction),
    // 性别专属身份(拍板):male/female 才标,中性身份省略;建角按所选性别过滤。
    gender: role.gender === "male" || role.gender === "female" ? role.gender : null,
    provenance: normalizeProvenance(role.provenance),
  }));
  // 身份进阶路径：起点/终点按名字归一到身份 id，未知引用原样保留交给 world-repair 报错。
  const roleByName = new Map(world.roleTemplates.map((role) => [role.name, role.id]));
  world.roleProgression = toArray(world.roleProgression).map((path, index) => ({
    id: path.id || idFrom(path.fromRoleId + "-" + path.toRoleId, "progression", index),
    fromRoleId: roleByName.get(path.fromRoleId) ?? path.fromRoleId,
    toRoleId: roleByName.get(path.toRoleId) ?? path.toRoleId,
    triggerEvents: toArray(path.triggerEvents).map((event, eventIndex) => ({
      id: event.id || idFrom(event.name ?? event.description, "trigger", eventIndex),
      name: String(event.name ?? ""),
      description: String(event.description ?? ""),
    })),
    prerequisites: {
      statMinimums: Object.fromEntries(
        Object.entries(path.prerequisites?.statMinimums ?? {}),
      ),
      attributeMinimums: Object.fromEntries(
        Object.entries(path.prerequisites?.attributeMinimums ?? {}),
      ),
      factionIds: toArray(path.prerequisites?.factionIds).map(
        (faction) => factionByName.get(faction) ?? faction,
      ),
    },
    modifiers: toArray(path.modifiers).map((modifier) => ({
      attributeId: modifier?.attributeId,
      delta: modifier?.delta,
    })),
    refusalModifiers: toArray(path.refusalModifiers).map((modifier) => ({
      attributeId: modifier?.attributeId,
      delta: modifier?.delta,
    })),
    provenance: normalizeProvenance(path.provenance),
  }));
  // POV 清单(拍板 2026-08-20:并行多线书的现状卡按线并列):透传并归一——
  // 去重、滤悬空、截断 3;空数组回落主角反推(protagonistOf),旧书零迁移。
  world.povCharacters = [...new Set(toArray(world.povCharacters))]
    .filter((id) => world.characters.some((character) => character.id === id))
    .slice(0, 3);
  const catalog = world.creationCatalog ?? {};
  // 大五目录逐维归一:目录只供叙事/档案文案使用(按档位取行为词与好面/坏面),
  // 建角不再选择——缺失维度回退内置通用目录,旧书不需要重新烧治。
  world.creationCatalog = {
    bigFive: normalizeBigFiveCatalog(catalog.bigFive),
    motivations: normalizeCatalogItems(catalog.motivations, DEFAULT_BIG_FIVE.motivations),
  };
  world.creationFields = (Array.isArray(world.creationFields) ? world.creationFields : [...CREATION_FIELD_KEYS])
    .map((field) => {
      const key = typeof field === "string" ? field : field?.key;
      if (!CREATION_FIELD_KEYS.includes(key)) return null;
      const fallback = DEFAULT_CREATION_FIELDS[key];
      // 同一字段内按规范化文本去重(保留首现顺序):建角页不该出现两条一样的候选。
      const dedupe = (list) => {
        if (!Array.isArray(list)) return undefined;
        const seen = new Set();
        const cleaned = [];
        for (const raw of list) {
          const option = String(raw).trim();
          const key = normalizeName(option);
          if (!option || seen.has(key)) continue;
          seen.add(key);
          cleaned.push(option);
        }
        return cleaned.length ? cleaned : undefined;
      };
      const normalized = {
        key,
        label: typeof field?.label === "string" && field.label.trim() !== "" ? field.label : fallback.label,
        placeholder: typeof field?.placeholder === "string" ? field.placeholder : fallback.placeholder,
      };
      // 外貌按性别两套(拍板):optionsMale/optionsFemale;旧书扁平 options 回退为两套共用。
      if (key === "appearance") {
        const shared = dedupe(field?.options);
        const male = dedupe(field?.optionsMale) ?? shared;
        const female = dedupe(field?.optionsFemale) ?? shared;
        if (male) normalized.optionsMale = male;
        if (female) normalized.optionsFemale = female;
        // 缺省时不写键(undefined 经 JSON 序列化会丢,缓存前后的深比较会因此失配)。
        if (!male && !female && shared) normalized.options = shared;
      } else if (field?.options !== undefined) {
        // 选择式字段的候选选项（烧制按书生成）；缺省时不写键（undefined 经 JSON 序列化会丢，
        // 缓存前后的深比较会因此失配）。
        const options = dedupe(field.options);
        if (options?.length) normalized.options = options;
      }
      return normalized;
    })
    .filter(Boolean);
  // 跨字段去重:个人细节(details)候选不得与外貌(appearance)候选重复——
  // 烧制提示词的软约束在这里落到代码,旧档案同样生效。
  const appearanceOptions = new Set(
    (() => {
      const appearance = world.creationFields.find((field) => field.key === "appearance");
      return [
        ...(appearance?.options ?? []),
        ...(appearance?.optionsMale ?? []),
        ...(appearance?.optionsFemale ?? []),
      ].map(normalizeName);
    })(),
  );
  world.creationFields = world.creationFields.map((field) => {
    if (field.key !== "details" || !Array.isArray(field.options)) return field;
    const kept = field.options.filter((option) => !appearanceOptions.has(normalizeName(option)));
    return kept.length ? { ...field, options: kept } : field;
  });
  // 全书章数与切入范围：建角时按「打开全部信息」算开局 unlockedChapter。
  if (Number.isInteger(world.chapterCount) && world.chapterCount > 0) {
    world.chapterCount = world.chapterCount;
  } else {
    world.chapterCount = undefined;
  }
  world.creationScope = {
    focusChapter: Number.isInteger(world.creationScope?.focusChapter)
      ? world.creationScope.focusChapter
      : 1,
    openAll: Boolean(world.creationScope?.openAll),
    // 切入锚点(故事内时间):进入命运节点时由进入定约写入;缺省回退故事起点。
    ...(Number.isFinite(world.creationScope?.anchorTime)
      ? { anchorTime: world.creationScope.anchorTime }
      : {}),
  };
  // 玩法规则:AI 提议、白名单钳位;旧档案自动获得默认规则,无需迁移。
  world.rules = clampRules(world.rules);
  // creationLimits 已随「建角不再选心性」移除:大五由故事中的选择演化,没有可选上限。
  world.timeline = (world.timeline ?? []).map((event) => ({
    ...event,
    // 模型可能把这三个字段写成 null（而不是省略），null 会让后续 .some/.every 抛错，
    // 这里统一回落成空数组。
    prerequisites: Array.isArray(event.prerequisites) ? event.prerequisites : [],
    invalidatedBy: Array.isArray(event.invalidatedBy) ? event.invalidatedBy : [],
    resolution: event.resolution ?? "world_time",
    resolutionTargetIds: Array.isArray(event.resolutionTargetIds) ? event.resolutionTargetIds : [],
    time: Number.isFinite(event.time) ? event.time : (event.turn ?? 0) * 60,
    locationId: event.locationId ?? locationByName.get(event.location) ?? event.location,
  }));
  // 5:全员人设卡/身份性别/两套外貌语义;旧书(schemaVersion<5)进入时强制重烧。
  world.schemaVersion = 5;
  NORMALIZED_WORLDS.add(world);
  return world;
}

// requires/excludes 的容错读取：模型可能写成 id 数组，也可能写成按类别分组的
// 对象；统一扁平成 id 数组。
function flatIds(value) {
  if (Array.isArray(value)) {
    return value.filter((item) => typeof item === "string");
  }
  if (value && typeof value === "object") {
    return Object.values(value).flatMap((item) => flatIds(item));
  }
  return [];
}

// 大五漂移结算(拍板:性格由故事中的选择长出来):只认五维、整数、±5 以内,
// 结果钳在 0-100。越界选择由模型标更大漂移(±4~5),这里不额外加权。
export function applyBigFiveShift(bigFive, shift) {
  const next = Object.fromEntries(
    BIG_FIVE_DIMENSIONS.map((dim) => [dim, Number.isFinite(bigFive?.[dim]) ? bigFive[dim] : 50]),
  );
  if (!shift || typeof shift !== "object" || Array.isArray(shift)) return next;
  for (const dim of BIG_FIVE_DIMENSIONS) {
    const delta = Number(shift[dim]);
    if (!Number.isFinite(delta)) continue;
    const clamped = Math.max(-5, Math.min(5, Math.round(delta)));
    next[dim] = Math.max(0, Math.min(100, next[dim] + clamped));
  }
  return next;
}

// 跨档判定:30/70 为档位边界(偏低/均衡/偏高),跨越任一边界记一条变化。
export function bigFiveCrossings(before, after) {
  const crossings = [];
  for (const dim of BIG_FIVE_DIMENSIONS) {
    const from = bigFiveLevel(before?.[dim]);
    const to = bigFiveLevel(after?.[dim]);
    if (from !== to) crossings.push({ dimension: dim, level: to, before: from });
  }
  return crossings;
}

export function neutralBigFive() {
  return Object.fromEntries(BIG_FIVE_DIMENSIONS.map((dim) => [dim, 50]));
}

// 境界阶梯已抽到 ./realm.js(拍板 2026-08-19:独立突破要多处共用,原地 re-export 保公共 API)。
import { realmTraitsOf } from "./realm.js";
export { realmTraitsOf } from "./realm.js";

// 建角身份自动配置(拍板:玩家是原著不存在、没有任何背景的新来者,落点只是首次
// 登场之处,不是身份;境界高低由用户在原著阶梯里自选,模式与起点已全部移除):
// 优先「无惯常地点」的通用平朴来路(与任何地方无绑定、无能力/修正/职权的身份,
// 如散修/旅人),其次全书任意平朴来路;全部落空时合成「无名之辈」
// (只用于玩家状态快照,不写入世界目录)。
function autoAssignRole(worldInput, { location, gender } = {}) {
  const world = normalizeWorld(worldInput);
  const names = characterNamesOf(world);
  const compatible = (world.roleTemplates ?? []).filter(
    (role) => !isCharacterBoundRoleName(role.name, names) && (!role.gender || role.gender === gender),
  );
  const fallback = { id: "outsider", name: "无名之辈", description: "无名无势的外来者", synthesized: true };
  if (!compatible.length) return fallback;
  const plain = (roles) =>
    roles.filter(
      (role) =>
        !(role.abilities?.length) &&
        !role.statMods &&
        !role.attributeMods &&
        !(role.authority?.length),
    );
  const unbound = plain(compatible.filter((role) => !(role.locationIds ?? []).length));
  if (unbound.length) return unbound[0];
  const anyPlain = plain(compatible);
  return anyPlain[0] ?? fallback;
}

// —— 反向建角(拍板 2026-08-20:一页模板红字直改,意图即人设)——

// 空所愿的锚(拍板:目录默认照样生成):创角目录所求清单第一条。
export function defaultMotivationOf(worldInput) {
  const world = normalizeWorld(worldInput);
  return (
    (world.creationCatalog?.motivations ?? []).find(
      (item) => item && typeof item.name === "string" && item.name.trim(),
    )?.name.trim() ?? ""
  );
}

// 白描提案管线（R6-R13）已整条删除（拍板 2026-08-20 R14：建角退回最初形态——
// 单页五控件，身份由 autoAssignRole 静默自动配，背景不写，建角零模型调用）。

export function createPlayerState(worldInput, profile) {
  const world = normalizeWorld(worldInput);
  const location = world.locations.find((item) => item.id === profile.locationId);
  if (!location) throw new Error("请选择世界中存在的初始地点");
  const name = String(profile.name ?? "").trim();
  // 姓名长度按码点计（D13,2026-08-19）：生僻字（CJK 扩展 B 等）与界面向导
  // （[...name].length）同口径，10 个生僻字的名字不再被 UTF-16 计数误拒。
  const nameLength = [...name].length;
  // 入世之志(拍板:分层意图):玩家建角可写下长远志向;不填时从烧制出的
  // 创角目录(所求清单)取第一条作默认——导演从第一回合起就有方向可导。
  // 空串视为未填(模板的「所愿可空」传上来的是 trim 后的空串,?? 链接不住)。
  const writtenMotivation = String(profile.motivation ?? profile.motivationId ?? "").trim();
  const motivation = writtenMotivation || defaultMotivationOf(world) || "在这座书城活出自己的路";
  if (nameLength < 1 || nameLength > 20) throw new Error("姓名应为 1-20 个字符");
  if (motivation.length > 120) throw new Error("所求至多 120 个字符");
  // 性别(拍板:建角必填,影响称谓与门规/婚约/差事等剧情):男/女,旧调用方缺省为未定。
  const gender = profile.gender === "male" || profile.gender === "female" ? profile.gender : null;
  if (profile.gender !== undefined && !gender) throw new Error("性别请选择男或女");
  // 游玩模式(拍板:爽文/原味模式已移除,推演全靠用户选项):一律纯规则(classic)。
  const { playMode } = normalizeModeProfile(profile);
  const characterNames = characterNamesOf(world);
  // 玩家三律(拍板:原著不存在/零背景/符合身份能力):名字不得属于或包含原著人物
  // ——「沈砚」「沈砚舟」都不行;叙述标签(主角/反派)同样拒收。
  if (isCharacterBoundName(name, characterNames)) {
    throw new Error("这个名字属于原著中的人——你不是原著中的任何人，请另起一个名字");
  }
  // 身份(拍板:建角不再选,引擎自动配):旧调用方显式传入时,绑定原著人物或
  // 性别不符的身份照旧拒收;未显式传入或身份已不在目录时按模式/起点自动配置。
  // 另写来路(拍板 2026-08-20:身份红字=选单+自定义兜底):目录之外的来路按
  // 零能力身份合成,机制同「无名之辈」——牙齿永远来自烧制目录,自拟不带。
  const customRoleName = String(profile.customRoleName ?? "").trim();
  if (customRoleName) {
    if ([...customRoleName].length > 10) throw new Error("另写的来路至多 10 个字");
    if (isCharacterBoundRoleName(customRoleName, characterNames)) {
      throw new Error("这个来路绑着原著中的人——请另写一个通用来路");
    }
  }
  const explicit = profile.roleId
    ? world.roleTemplates.find((item) => item.id === profile.roleId)
    : null;
  if (explicit && isCharacterBoundName(explicit.name, characterNames)) {
    throw new Error("该身份属于原著具体人物——你不是原著中的任何人，请另选一个通用来路");
  }
  if (explicit && explicit.gender && explicit.gender !== gender) {
    throw new Error(`「${explicit.name}」与所选性别不符`);
  }
  const role =
    (customRoleName
      ? { id: "custom-role", name: customRoleName, description: "自拟的来路", synthesized: true }
      : null) ??
    explicit ??
    autoAssignRole(world, { location, gender });
  // 身外字段不得点名原著人物(外貌/个人细节/来历),防御旧档案里残留的污染选项。
  const background = String(profile.background ?? "").trim();
  if ([...background].length > 150) throw new Error("来历至多 150 个字符");
  for (const [key, label] of [
    ["appearance", "外貌"],
    ["details", "个人细节"],
    ["background", "来历"],
  ]) {
    const value = key === "background" ? background : String(profile[key] ?? "").trim();
    if (value && isCharacterBoundName(value, characterNames)) {
      throw new Error(`${label}不得使用原著人物的称呼或描述`);
    }
  }
  // 大五底色(拍板 2026-08-19:底色不再手选,中庸起步):五维一律 50,
  // 性子全由故事中选择的漂移长出来;传入的 bigFivePicks 一律忽略。
  const bigFive = neutralBigFive();
  const initial = structuredClone(world.initialStateTemplate ?? {});
  // 开局视野：打开全部信息=全书章数；否则只到切入章节（防剧透）。
  const scopeChapter = world.creationScope?.focusChapter ?? initial.unlockedChapter ?? 1;
  // 信息范围全书全开(拍板:意图移除后不再有范围限制,已读完全书是默认假设)。
  const unlockedChapter = world.chapterCount ?? scopeChapter;
  // 切入锚点(拍板:倒叙/插叙摊平成故事内时间线):锚定用故事内时间,不用章节号。
  // 时期选择已取消(拍板:统一从小说开头进入),锚点=故事内最早点。
  const startTime = storyStart(world);
  const anchorTime = Number.isFinite(world.creationScope?.anchorTime)
    ? world.creationScope.anchorTime
    : startTime;
  // 境界(拍板:全靠用户自选,模式与起点已移除):有境界阶梯的书,建角从原著阶梯里
  // 任选一阶(高低不限);未选或非法 id 回落显式身份的惯常档,无惯常档则最低档。
  const realmLadder = realmTraitsOf(world);
  const realmIds = new Set(realmLadder.map((trait) => trait.id));
  const roleRealmIds = (role.traitIds ?? []).filter((id) => realmIds.has(id));
  const roleOtherIds = (role.traitIds ?? []).filter((id) => !realmIds.has(id));
  let traitIds;
  if (realmIds.size) {
    const chosen =
      realmLadder.find((trait) => trait.id === profile.realmTraitId) ??
      (roleRealmIds.length
        ? realmLadder.find((trait) => trait.id === roleRealmIds[0])
        : realmLadder[0]);
    traitIds = chosen ? [chosen.id, ...roleOtherIds] : [...roleOtherIds];
  } else {
    traitIds = (role.traitIds ?? []).filter((id) =>
      world.traits.some((trait) => trait.id === id),
    );
  }
  // 出身势力(拍板:建角不选,开局也不自动绑定):旧调用方显式传入且合法时照收;
  // 势力与职权由故事中的身份进阶获得。
  const legacyFaction =
    profile.factionId && world.factions.some((item) => item.id === profile.factionId)
      ? profile.factionId
      : null;
  const factionId = legacyFaction;
  const factionMemberships = factionId
    ? [
        {
          id: `membership:${factionId}`,
          factionId,
          authority: (role.authority ?? []).filter((permission) =>
            AUTHORITY_VALUES.includes(permission),
          ),
          duties: [],
          overdueDutyIds: [],
          promotionEvidenceIds: [],
          discipline: [],
          visibility: "public",
        },
      ]
    : [];
  const state = {
    ...initial,
    // 游玩模式(拍板:模式已移除):一律 classic;旧档的 power/startingPoint 由 migrateState 保留。
    playMode,
    stats:
      initial.stats ??
      Object.fromEntries(world.stats.map((stat) => [stat.id, stat.initial])),
    attributes:
      initial.attributes ??
      Object.fromEntries(world.attributes.map((attribute) => [attribute.id, attribute.initial])),
    conditions: initial.conditions ?? [],
    resolvedEventIds: initial.resolvedEventIds ?? [],
    resolvedThreads: initial.resolvedThreads ?? [],
    retrievalKeywords: initial.retrievalKeywords ?? [],
    longTermMemories: initial.longTermMemories ?? [],
    unlockedChapter,
    turn: initial.turn ?? 0,
    player: {
      id: "player",
      name,
      roleId: role.id,
      roleName: role.name,
      factionId,
      locationId: location.id,
      motivation,
      // 当前谋算(拍板:分层意图):玩家在阅读页随时改写的中期方向(≤40字),
      // 与长远志向(personalGoals[0])、回合意图(选项区)分层——只影响叙事与选项取势。
      scheme: String(profile.scheme ?? "").trim().slice(0, 40),
      backgroundId: profile.backgroundId ?? role.id,
      // 身份履历：头一条即开局身份；快照文本，不活引用目录 id。
      roleHistory: [
        {
          roleId: role.id,
          roleName: role.name,
          sinceTurn: initial.turn ?? 0,
          reason: "开局",
        },
      ],
      // 身份进阶路径的消耗标记与失配标记：新角色默认全空。
      usedProgressionIds: [],
      refusedProgressionIds: [],
      roleDangling: false,
      // 第几世：原创实体的 provenance.lifeIndex 据此标注，转世时由 createSuccessorState 递增。
      lifeIndex: Number.isInteger(profile.lifeIndex) ? profile.lifeIndex : 1,
      // 大五人格(拍板 2026-08-19:中庸起步):初值全 50,此后只随每回合
      // 选择的 bigFiveShift 演化;行为词不再由玩家选,跨档后由引擎按词库取。
      bigFive,
      // 具名行囊(拍板 2026-08-19):回合结算里长出来的物品清单,随肉身——转世清零。
      inventory: [],
      // 习得技能(拍板 2026-08-19):拜师/悟道/苦练等契机习得,与身份能力合并生效。
      learnedAbilities: [],
      // 境界突破履历(拍板 2026-08-19):独立于身份进阶的修为成长记录。
      realmHistory: [],
      appearance: String(profile.appearance ?? "").trim().slice(0, 240),
      // 个人细节已从建角移除(拍板),旧调用方传入也照收——叙事可自然带出。
      details: String(profile.details ?? "").trim().slice(0, 500),
      // 来历(拍板 2026-08-20:意图即人设):定约写定的白描——事实不是性格、零牙齿;
      // 旧档无此字段按空串处理,开场/校验/导演据此区分新旧语义。
      background,
      // 境界/资质特质:由用户自选或回落身份惯常档合成;行动门槛按 traits/abilities
      // 硬执行(低微身份不得凭空施展高境界能力)。
      traitIds,
      // 性别:称谓与涉性别剧情(门规/婚约/差事/兵役)都从这里长出来;未定为 null。
      gender,
      personalityEvidence: [],
      personalityHistory: [],
    },
    location: location.name,
    locationId: location.id,
    traits: structuredClone(world.traits),
    relationships: {},
    entityStates: Object.fromEntries(
      // 开局现状一律「如常」(active)：烧制人物档案的 status 是全书终局命运
      // (韩立飞升仙界之类——人物卡的静态书知识)，不是故事开头的现状；身亡/
      // 飞升等命运由时间线事件在故事中投递。旧存档的 entityStates 不回改
      // (前世世界延续拍板)，开新一世/新建角即恢复正确。
      world.characters.map((character) => [
        character.id,
        { status: "active", factionId: character.factionId, locationId: character.locationIds[0] ?? null },
      ]),
    ),
    discoveredCharacterIds: world.characters
      .filter((character) => character.firstChapter <= unlockedChapter)
      .filter((character) => character.locationIds.includes(location.id))
      .map((character) => character.id),
    // 开局锚定:切入锚点(故事内时间)之前的原文事件视为「原著已发生」(backstory),不逐条演出。
    eventStates: (() => {
      const ordered = [...world.timeline].sort((left, right) => left.time - right.time);
      return Object.fromEntries(
        ordered.map((event) => [
          event.id,
          Number(event.time) < anchorTime
            ? { status: "delivered", deliveredTurn: 0, delivery: "backstory" }
            : { status: "scheduled" },
        ]),
      );
    })(),
    // 世界时钟从故事起点起算:切入命运节点时,故事已经推进到该节点之前。
    worldTime: Math.max(0, anchorTime - startTime),
    adaptation: emptyAdaptation(),
    // 本回合大五跨档记录:回合内有效,供叙事自然带出;下回合结算时覆写。
    bigFiveChanges: [],
    ...emptyGameplayState(),
    factionMemberships,
    personalGoals: [{
      id: "core-goal-1",
      kind: "core",
      status: "active",
      motive: motivation,
      direction: profile.motivationId ?? "living",
      publicDirection: motivation,
      evidenceIds: [],
      milestones: [],
      blockers: [],
      transformationHistory: [],
      endingEligible: false,
    }],
  };
  // 身份能力落地:abilities 进玩家档案;数值修饰钳制后加到初始 stats/attributes,
  // 高境界/高职权的身份从此在判定上真的更强——选项与叙事都从这个差异长出来。
  state.stats = applyRoleMods(state.stats, role.statMods, {
    bounds: Object.fromEntries(world.stats.map((stat) => [stat.id, { min: stat.min, max: stat.max }])),
  });
  state.attributes = applyRoleMods(state.attributes, role.attributeMods, {});
  applyRoleIdentity(state, role, world);
  // 境界步合成覆盖身份默认:applyRoleIdentity 已按身份回填 traitIds,这里按选择收窄/替换境界档。
  state.player.traitIds = traitIds;
  return state;
}

// 身份数值修饰的钳制应用:非法 id/非有限数直接忽略;stat 钳在 min/max 内,attribute 不为负。
export function applyRoleMods(target, mods, { bounds = {} } = {}) {
  if (!mods || typeof mods !== "object" || Array.isArray(mods)) return target;
  const next = { ...target };
  for (const [id, raw] of Object.entries(mods)) {
    const delta = Number(raw);
    if (!Number.isFinite(delta) || !(id in next)) continue;
    const { min, max } = bounds[id] ?? {};
    if (Number.isFinite(min) && Number.isFinite(max)) {
      next[id] = Math.min(max, Math.max(min, next[id] + delta));
    } else {
      // 无界字段(属性)与身份进阶路径同口径 0-100 封顶:建角时超出 100 的属性
      // 若不在此封顶,第一次身份转变就会被进阶侧的钳制静默砍掉。
      next[id] = Math.min(100, Math.max(0, next[id] + delta));
    }
  }
  return next;
}

export function migrateState(state, worldInput) {
  const world = normalizeWorld(worldInput);
  const location = world.locations.find(
    (item) => item.id === state.locationId || item.name === state.location,
  ) ?? world.locations[0];
  const gameplay = migrateGameplayState(state);
  const fallbackRole = world.roleTemplates[0] ?? { id: "outsider", name: "无名之辈" };
  state.adaptation ??= emptyAdaptation();
  // 记忆分层（2026-08-21）：远期梗概缺省为空、折叠记账与中窗记账对齐——
  // 旧档的滚动摘要继续当中窗用，攒满 15 回新历史后第一次折叠自然归入 digest
  // （不直接把旧 chapterSummary 抄成 digest：开场续写期该字段装的是开场正文，
  // 盲抄会把开场当远期梗概注入两遍）。
  state.storyDigest = typeof state.storyDigest === "string" ? state.storyDigest : "";
  state.digestSummarizedLength = Number.isFinite(Number(state.digestSummarizedLength))
    ? Number(state.digestSummarizedLength)
    : (Number(state.memorySummarizedLength) || 0);
  // 游玩模式迁移(拍板):旧档缺省 classic/scratch,原味强制 scratch。
  state.playMode = state.playMode === "power" ? "power" : "classic";
  state.startingPoint =
    state.playMode === "power" && state.startingPoint === "ceiling" ? "ceiling" : "scratch";
  const legacyPlayer = state.player ?? {
    id: "player",
    name: "旅人",
    roleId: fallbackRole.id,
    roleName: fallbackRole.name,
    factionId: null,
    locationId: location?.id,
    motivation: "在这个世界活下去",
    backgroundId: fallbackRole.id,
    bigFive: Object.fromEntries(BIG_FIVE_DIMENSIONS.map((dim) => [dim, 50])),
    appearance: "",
    details: "",
    personalityEvidence: [],
    personalityHistory: [],
  };
  // 旧档回填身份履历：只有一条「开局」，sinceTurn 无从考证，统一记第 1 回合。
  const player = {
    ...legacyPlayer,
    roleHistory: legacyPlayer.roleHistory?.length
      ? legacyPlayer.roleHistory
      : [
          {
            roleId: legacyPlayer.roleId ?? fallbackRole.id,
            roleName: legacyPlayer.roleName ?? fallbackRole.name,
            sinceTurn: 1,
            reason: "开局",
          },
        ],
    usedProgressionIds: legacyPlayer.usedProgressionIds ?? [],
    refusedProgressionIds: legacyPlayer.refusedProgressionIds ?? [],
    roleDangling: legacyPlayer.roleDangling ?? false,
  };
  // 旧档大五迁移:缺失维度补中性 50,已有分值保留(拍板:旧档接着演化,不重置)。
  player.bigFive = Object.fromEntries(
    BIG_FIVE_DIMENSIONS.map((dim) => [dim, Number.isFinite(player.bigFive?.[dim]) ? player.bigFive[dim] : 50]),
  );
  // 性别迁移:旧档缺省为未定(null),叙事保持模糊不特指。
  player.gender = player.gender === "male" || player.gender === "female" ? player.gender : null;
  // 大五底色选择恢复(拍板:建角选底色):旧档缺 picks 置空,能力块按档位兜底取词。
  player.bigFivePicks =
    player.bigFivePicks && typeof player.bigFivePicks === "object" && !Array.isArray(player.bigFivePicks)
      ? player.bigFivePicks
      : {};
  // 旧档补行囊/习得/突破履历(拍板 2026-08-19):字段晚于旧档出生,缺省空起步。
  if (!Array.isArray(player.inventory)) player.inventory = [];
  if (!Array.isArray(player.learnedAbilities)) player.learnedAbilities = [];
  if (!Array.isArray(player.realmHistory)) player.realmHistory = [];
  // 四类旧心性字段一律剥离,演化只靠回合漂移结算。
  for (const legacy of ["personalityIds", "valueIds", "strengthIds", "weaknessIds"]) delete player[legacy];
  // 称谓已取消:旧档里的 pronoun 一律剥离,称呼交给叙事按语境自然产生。
  delete player.pronoun;
  // 旧档回填身份能力:数值 mods 不回补(历史判定不可变),只补能力文本,
  // 让后续回合的选项与叙事有「这个身份能做什么」可依。
  const role = world.roleTemplates.find((item) => item.id === player.roleId);
  if (!Array.isArray(player.abilities)) {
    player.abilities = Array.isArray(role?.abilities)
      ? role.abilities.map(String).filter(Boolean)
      : [];
  }
  // 旧档回填身份特质:与能力同源,都是「身份目录里本来就该有」的信息。
  // (职权回填在下方克隆出的成员记录上做,不动入参。)
  if (!Array.isArray(player.traitIds)) {
    player.traitIds = (role?.traitIds ?? []).filter((id) =>
      world.traits.some((trait) => trait.id === id),
    );
  }
  const next = {
    ...structuredClone(state),
    player,
    location: location?.name ?? state.location,
    locationId: location?.id ?? state.locationId,
    traits: state.traits ?? structuredClone(world.traits),
    relationships: state.relationships ?? {},
    entityStates:
      state.entityStates ??
      Object.fromEntries(
        world.characters.map((character) => [
          character.id,
          { status: character.status, factionId: character.factionId, locationId: character.locationIds[0] ?? null },
        ]),
      ),
    discoveredCharacterIds: state.discoveredCharacterIds ?? [],
    eventStates:
      state.eventStates ??
      Object.fromEntries(
        world.timeline.map((event) => [
          event.id,
          { status: state.resolvedEventIds?.includes(event.id) ? "resolved" : "scheduled" },
        ]),
      ),
    longTermMemories: state.longTermMemories ?? [],
    worldTime: state.worldTime ?? (state.turn ?? 0) * 60,
    bigFiveChanges: Array.isArray(state.bigFiveChanges) ? state.bigFiveChanges : [],
    ...gameplay,
  };
  // 职权回填落在克隆出的成员记录上,不动入参(调用方可能复用同一对象)。
  const ownMembership = (next.factionMemberships ?? []).find(
    (membership) => membership.factionId === player.factionId,
  );
  if (ownMembership && !ownMembership.authority?.length && role?.authority?.length) {
    ownMembership.authority = role.authority.filter((permission) =>
      AUTHORITY_VALUES.includes(permission),
    );
  }
  return next;
}

function relationKey(targetType, targetId) {
  return `${targetType}:${targetId}`;
}

export function applyEvolutionPatch(state, patch = {}, worldInput) {
  // 空补丁零拷贝返回：每回合省一次全量深拷贝。调用方在补丁为空时拿到的是
  // 上一环节刚产出的新对象，后续原地写入安全。
  const hasWork =
    (patch?.relationships?.length ?? 0) > 0 ||
    (patch?.entities?.length ?? 0) > 0 ||
    (patch?.discoveredCharacterIds?.length ?? 0) > 0;
  if (!hasWork) return state;
  const world = normalizeWorld(worldInput);
  const next = structuredClone(state);
  const characters = new Set(world.characters.map((item) => item.id));
  const factions = new Set(world.factions.map((item) => item.id));
  for (const change of patch.relationships ?? []) {
    const valid =
      change.targetType === "character"
        ? characters.has(change.targetId)
        : change.targetType === "faction" && factions.has(change.targetId);
    if (!valid) throw new Error(`Unknown relationship target: ${change.targetId}`);
    const key = relationKey(change.targetType, change.targetId);
    const current = next.relationships[key] ?? Object.fromEntries(RELATION_FIELDS.map((field) => [field, 0]));
    const updated = { ...current };
    for (const field of RELATION_FIELDS) {
      const delta = change[field] ?? 0;
      if (!Number.isFinite(delta) || Math.abs(delta) > 2) {
        throw new Error(`Invalid relationship change: ${field}`);
      }
      updated[field] = Math.max(-10, Math.min(10, current[field] + delta));
    }
    // secrets 去重后封顶：模型每回合都可能追加，不封顶会无限膨胀存档。
    updated.secrets = [
      ...new Set([...(current.secrets ?? []), ...(change.secrets ?? [])]),
    ].slice(-24);
    next.relationships[key] = updated;
  }
  for (const change of patch.entities ?? []) {
    if (!characters.has(change.characterId)) throw new Error(`Unknown character: ${change.characterId}`);
    const current = next.entityStates[change.characterId] ?? {};
    if (change.status !== undefined && !ENTITY_STATUSES.has(change.status)) {
      throw new Error(`Invalid entity status: ${change.status}`);
    }
    if (change.factionId !== undefined && change.factionId !== null && !factions.has(change.factionId)) {
      throw new Error(`Unknown faction: ${change.factionId}`);
    }
    if (
      change.locationId !== undefined &&
      change.locationId !== null &&
      !world.locations.some((item) => item.id === change.locationId)
    ) {
      throw new Error(`Unknown entity location: ${change.locationId}`);
    }
    // 实体变更字段白名单：status/factionId/locationId 之外模型随手写的
    // 杂项键不再透传进存档（它们只会越积越多）。
    next.entityStates[change.characterId] = {
      ...current,
      status: change.status !== undefined ? change.status : current.status,
      factionId: change.factionId !== undefined ? change.factionId : current.factionId,
      locationId: change.locationId !== undefined ? change.locationId : current.locationId,
    };
  }
  const discovered = patch.discoveredCharacterIds ?? [];
  if (discovered.some((id) => !characters.has(id))) {
    throw new Error("Evolution patch discovers an unknown character");
  }
  next.discoveredCharacterIds = [...new Set([...next.discoveredCharacterIds, ...discovered])];
  return next;
}

export function optionIsAvailable(option, state, worldInput) {
  const world = normalizeWorld(worldInput);
  const requirements = option.requirements ?? {};
  if (requirements.locationId && requirements.locationId !== state.locationId) return false;
  if (requirements.roleIds?.length && !requirements.roleIds.includes(state.player.roleId)) return false;
  // 性格门控已移除(拍板:选项即意图)——回合选项不再受大五约束,心性只被动演化。
  if (requirements.factionId) {
    const membership = state.factionMemberships?.find(
      (item) => item.factionId === requirements.factionId,
    );
    // 旧存档可能在 factionMemberships 出现之前创建：玩家自己的出身势力
    // 直接视为成员（但没有 authority 记录，权限要求仍不可用）。
    const nativeFaction = requirements.factionId === state.player.factionId;
    if (!membership && !nativeFaction) return false;
    if (
      requirements.authority?.length &&
      !requirements.authority.every((permission) =>
        membership?.authority?.includes(permission),
      )
    ) {
      return false;
    }
  }
  // 特质门槛:只认玩家身份蕴含的特质(traitIds),不再用世界特质表——
  // 旧语义下「世界有元婴这个境界」会让练气修士也通过元婴门槛,形同虚设。
  if (
    requirements.traits?.some(
      (required) => !state.player?.traitIds?.includes(required.id),
    )
  ) {
    return false;
  }
  if (
    option.target?.type === "character" &&
    !state.discoveredCharacterIds.includes(option.target.id)
  ) {
    // 在场即见(拍板):实体追踪显示此人此刻就在玩家所在的地点,视为已照面,
    // 允许指向——原著场景里就在眼前的人物,不因「未登记遇见」而不可交互。
    const present = state.entityStates?.[option.target.id]?.locationId === state.locationId;
    if (!present) return false;
  }
  if (
    option.target?.type === "character" &&
    state.entityStates[option.target.id]?.status === "dead"
  ) {
    return false;
  }
  if (option.target?.type === "faction" && !world.factions.some((item) => item.id === option.target.id)) {
    return false;
  }
  // 命运偏离门槛：改命行动的时间/地点/人物前提由这里硬校验（软因果交给模型）。
  // 拍板 2026-08-17：玩家已读完小说，未解锁章节一律不过滤——不再校验
  // chapterAnchor 是否超出解锁范围，只校验事件状态与人物前提。
  // 门槛逻辑与结算路径(applyDivergence)共用 divergenceTargetGate,一道门两处把关。
  if (option.divergence?.targetId && option.divergence?.targetType) {
    if (!divergenceTargetGate(world, state, option.divergence).ok) return false;
  }
  return true;
}

// 身份进阶：当前仍可走的路径（未被使用/拒绝、起点等于当前身份、前提全部满足）。
// 只有「此刻可走」的路径才进模型上下文，避免预泄未来路径。
export function eligibleProgression(worldInput, state) {
  const world = normalizeWorld(worldInput);
  const player = state.player ?? {};
  const consumed = new Set([
    ...(player.usedProgressionIds ?? []),
    ...(player.refusedProgressionIds ?? []),
  ]);
  // 爽文拍板「成长与进阶更快」:数值前提按 50% 向下取整折算,势力前提不放松。
  const scale = isPowerMode(state) ? POWER_PREREQ_SCALE : 1;
  const scaledMinimum = (minimum) =>
    scale === 1 ? minimum : Math.max(0, Math.floor(minimum * scale));
  return world.roleProgression.filter((path) => {
    if (consumed.has(path.id)) return false;
    if (path.fromRoleId !== player.roleId) return false;
    const pre = path.prerequisites ?? {};
    for (const [statId, minimum] of Object.entries(pre.statMinimums ?? {})) {
      if (!Number.isFinite(minimum)) return false;
      if (!Number.isFinite(state.stats?.[statId]) || state.stats[statId] < scaledMinimum(minimum)) {
        return false;
      }
    }
    for (const [attributeId, minimum] of Object.entries(pre.attributeMinimums ?? {})) {
      if (!Number.isFinite(minimum)) return false;
      if (!Number.isFinite(state.attributes?.[attributeId]) || state.attributes[attributeId] < scaledMinimum(minimum)) {
        return false;
      }
    }
    if (pre.factionIds?.length && !pre.factionIds.includes(player.factionId)) return false;
    return true;
  });
}

// 模型声明的身份进阶是否合法：路径存在、此刻可走、触发事件属于该路径。
// 非法声明返回 null（调用方丢弃声明、回合照常继续），绝不因模型违约崩回合。
export function validateRoleTransition(response, state, worldInput) {
  const declaration = response?.roleTransition;
  if (!declaration || typeof declaration !== "object" || Array.isArray(declaration)) return null;
  const world = normalizeWorld(worldInput);
  const path = world.roleProgression.find((item) => item.id === declaration.progressionId);
  if (!path) return null;
  if (!eligibleProgression(world, state).some((item) => item.id === path.id)) return null;
  const trigger = path.triggerEvents.find((item) => item.id === declaration.triggerEventId);
  if (!trigger) return null;
  return {
    progressionId: path.id,
    triggerEventId: trigger.id,
    toRoleId: path.toRoleId,
  };
}

