import { AUTHORITY_VALUES, BIG_FIVE_DIMENSIONS, normalizeWorld, toArray } from "./evolution.js";
import { characterNamesOf, isCharacterBoundName, isCharacterBoundRoleName } from "./identity-guard.js";
import { clampRules } from "./rules.js";
import { DIVERGENCE_TIERS } from "./gameplay-systems.js";

const STAT_ROLES = new Set(["vital", "resource", "progress", "relation"]);
const TRAIT_NAMES = /灵根|血脉|种族|职业|体质|天赋|阵营|性别|出身|信仰/;
// 称谓已取消:身外字段只剩外貌与个人细节。
const CREATION_FIELD_KEYS = ["appearance", "details"];

function numberValue(value) {
  if (typeof value === "number") return value;
  if (typeof value === "string" && value.trim() !== "") {
    const number = Number(value);
    if (Number.isFinite(number)) return number;
  }
  return value;
}

function uniqueIdErrors(items, collection, errors) {
  const seen = new Set();
  items.forEach((item, index) => {
    if (!item?.id) {
      errors.push(error(`${collection}[${index}].id`, "missing_id", "缺少稳定 ID"));
    } else if (seen.has(item.id)) {
      errors.push(error(`${collection}[${index}].id`, "duplicate_id", `ID “${item.id}” 重复`));
    }
    seen.add(item?.id);
  });
}

function error(path, code, message) {
  return { path, code, message: `${path}：${message}` };
}

export function unwrapWorldDraft(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) return {};
  if (input.world && typeof input.world === "object" && !Array.isArray(input.world)) {
    return input.world;
  }
  if (
    input.result?.world &&
    typeof input.result.world === "object" &&
    !Array.isArray(input.result.world)
  ) {
    return input.result.world;
  }
  return input;
}

// 身份能力字段的形状净化:abilities 只保留 1-3 条非空短句;
// statMods/attributeMods 只保留有限数值;traitIds 只保留非空字符串;
// authority 只保留白名单职权。引用合法性与越界由 createPlayerState
// 应用时再校验——这里只丢「形状都不对」的垃圾,不报错、不触发修复轮。
export function sanitizeRoleCapabilities(role) {
  const next = { ...role };
  if (role.abilities !== undefined) {
    if (Array.isArray(role.abilities)) {
      const cleaned = role.abilities
        .map((ability) => (typeof ability === "string" ? ability.trim().slice(0, 40) : ""))
        .filter(Boolean)
        .slice(0, 3);
      if (cleaned.length) next.abilities = cleaned;
      else delete next.abilities;
    } else {
      delete next.abilities;
    }
  }
  for (const key of ["statMods", "attributeMods"]) {
    if (role[key] === undefined) continue;
    if (role[key] && typeof role[key] === "object" && !Array.isArray(role[key])) {
      const cleaned = Object.fromEntries(
        Object.entries(role[key]).filter(([, value]) => Number.isFinite(Number(value))),
      );
      if (Object.keys(cleaned).length) next[key] = cleaned;
      else delete next[key];
    } else {
      delete next[key];
    }
  }
  if (role.traitIds !== undefined) {
    if (Array.isArray(role.traitIds)) {
      const cleaned = [...new Set(role.traitIds.filter((id) => typeof id === "string" && id.trim()))].slice(0, 6);
      if (cleaned.length) next.traitIds = cleaned;
      else delete next.traitIds;
    } else {
      delete next.traitIds;
    }
  }
  if (role.authority !== undefined) {
    if (Array.isArray(role.authority)) {
      const cleaned = [...new Set(role.authority.filter((permission) => AUTHORITY_VALUES.includes(permission)))];
      if (cleaned.length) next.authority = cleaned;
      else delete next.authority;
    } else {
      delete next.authority;
    }
  }
  return next;
}

// 目录一致性质检结果的机械应用:删除近义重复词条;纯函数、不报错——烧制质检与旧书升级共用。
// 输入 coherence 形如 {removeIds:[id]}。大五选项没有 requires/excludes(选择即得分,
// 互斥在评分语义里自然成立),质检只做去重与两端保底。
export function applyCatalogCoherence(worldInput, coherence) {
  const world = structuredClone(worldInput);
  const catalog = world?.creationCatalog;
  if (!catalog || typeof catalog !== "object") return world;
  const removeIds = new Set(
    (coherence?.removeIds ?? []).filter((id) => typeof id === "string"),
  );
  if (!removeIds.size) return world;
  if (catalog.bigFive && typeof catalog.bigFive === "object" && !Array.isArray(catalog.bigFive)) {
    for (const dim of BIG_FIVE_DIMENSIONS) {
      if (!Array.isArray(catalog.bigFive[dim])) continue;
      const next = catalog.bigFive[dim].filter((item) => !removeIds.has(item?.id));
      const hasHigh = next.some((item) => item?.pole !== "low");
      const hasLow = next.some((item) => item?.pole === "low");
      // 每维至少保留两端各 1 项:删过头就放弃删除。
      if (next.length >= 2 && hasHigh && hasLow) catalog.bigFive[dim] = next;
    }
  }
  if (Array.isArray(catalog.motivations)) {
    const next = catalog.motivations.filter((item) => !removeIds.has(item?.id));
    if (next.length >= 3) catalog.motivations = next;
  }
  return world;
}

// 目录一致性质检的质检提示词:烧制与旧书升级共用同一套标准。
export const CATALOG_COHERENCE_PROMPT =
  "你是创角目录质检器。检查大五人格选项(bigFive 五个维度:openness/conscientiousness/extraversion/agreeableness/neuroticism 各自的选项)与动机(motivations)之间的重叠与矛盾，只返回 JSON：{\"removeIds\":[\"要删除的词条 id\"]}。规则：①同一维度内近义重复的选项(同义词换词、同一行为倾向换个说法)只保留更有区分度的一个，其余 id 放进 removeIds；②动机与五维选项表述重叠时，保留归类更准的一侧(动机写所求、五维写行为倾向)；③每个维度必须保留两端(pole=high 与 pole=low)各至少一项，删过头就少删；④不得改动词条文本。只报确有把握的，拿不准就留空数组。";

// 时间线事件的事实变化字段净化:factsToAdd 只保留 id/text 齐全且 id 不重复的条目;
// factsToInvalidate 只保留非空字符串。坏形状静默丢弃,不报错、不触发修复轮。
export function sanitizeEventFactChanges(event) {
  const next = {};
  if (event.factsToAdd !== undefined) {
    if (Array.isArray(event.factsToAdd)) {
      const cleaned = [];
      const seen = new Set();
      for (const fact of event.factsToAdd) {
        if (!fact || typeof fact !== "object") continue;
        const id = String(fact.id ?? "").trim();
        const text = String(fact.text ?? "").trim();
        if (!id || seen.has(id) || !text) continue;
        seen.add(id);
        cleaned.push({ id, text, chapterAnchor: Number.isInteger(fact.chapterAnchor) && fact.chapterAnchor > 0 ? fact.chapterAnchor : 1 });
      }
      if (cleaned.length) next.factsToAdd = cleaned;
      else delete next.factsToAdd;
    } else {
      delete next.factsToAdd;
    }
  }
  if (event.factsToInvalidate !== undefined) {
    if (Array.isArray(event.factsToInvalidate)) {
      const cleaned = [...new Set(event.factsToInvalidate.filter((id) => typeof id === "string" && id.trim()))];
      if (cleaned.length) next.factsToInvalidate = cleaned;
      else delete next.factsToInvalidate;
    } else {
      delete next.factsToInvalidate;
    }
  }
  return next;
}

export function normalizeWorldDraft(input) {
  const draft = structuredClone(unwrapWorldDraft(input));  const movedTraits = [];
  draft.attributes = (draft.attributes ?? []).filter((attribute) => {
    const initial = numberValue(attribute.initial);
    if (!Number.isFinite(initial) && TRAIT_NAMES.test(`${attribute.id ?? ""}${attribute.name ?? ""}`)) {
      movedTraits.push({
        id: attribute.id,
        name: attribute.name,
        value: String(attribute.value ?? attribute.initial ?? attribute.description ?? "未定"),
        description: String(attribute.description ?? ""),
      });
      return false;
    }
    attribute.initial = initial;
    return true;
  });
  draft.traits = [...(draft.traits ?? []), ...movedTraits].map((trait) => ({
    id: trait.id,
    name: trait.name,
    value: String(trait.value ?? ""),
    description: String(trait.description ?? ""),
  }));
  draft.stats = (draft.stats ?? []).map((stat) => ({
    ...stat,
    min: numberValue(stat.min),
    max: numberValue(stat.max),
    initial: numberValue(stat.initial),
  }));
  draft.timeline = (draft.timeline ?? []).map((event) => ({
    ...event,
    time: numberValue(event.time),
    // 命运层级:非法/缺失一律回落 side(旧书无 tier 同样落 side,无需重烧)。
    tier: DIVERGENCE_TIERS[event.tier] ? event.tier : "side",
    ...sanitizeEventFactChanges(event),
  }));
  draft.facts = (draft.facts ?? []).map((fact) => ({
    ...fact,
    chapterAnchor: numberValue(fact.chapterAnchor),
  }));
  draft.characters = (draft.characters ?? []).map((character) => ({
    ...character,
    firstChapter: numberValue(character.firstChapter),
    lastChapter:
      character.lastChapter === null || character.lastChapter === undefined
        ? character.lastChapter
        : numberValue(character.lastChapter),
  }));
  draft.roleTemplates = (draft.roleTemplates ?? []).map((role) => ({
    ...sanitizeRoleCapabilities(role),
    firstChapter: numberValue(role.firstChapter),
  }));
  // POV 清单(拍板 2026-08-20:双线书的现状卡按线并列):去重、滤悬空、截断 3;
  // 全空时留空数组——运行时回落 protagonistOf 反推(旧书零迁移)。
  draft.povCharacters = [
    ...new Set(
      (Array.isArray(draft.povCharacters) ? draft.povCharacters : [])
        .filter((id) => typeof id === "string" && id.trim()),
    ),
  ]
    .filter((id) => (draft.characters ?? []).some((character) => character.id === id))
    .slice(0, 3);
  draft.facts ??= [];
  draft.timeline ??= [];
  draft.characters ??= [];
  draft.factions ??= [];
  draft.roleTemplates ??= [];
  draft.roleProgression ??= [];
  draft.locations ??= [];
  draft.items ??= [];
  const world = normalizeWorld(draft);
  return world;
}

export function diagnoseWorld(worldInput, state) {
  const world = normalizeWorldDraft(worldInput);
  const errors = [];
  if (!world.id) errors.push(error("id", "missing_id", "世界缺少 ID"));
  if (!world.title) errors.push(error("title", "missing_title", "世界缺少标题"));
  if (!world.locations.length) errors.push(error("locations", "empty", "至少需要一个地点"));
  if (!world.attributes.length) errors.push(error("attributes", "empty", "至少需要一个数值判定属性"));
  if (!world.stats.length) errors.push(error("stats", "empty", "至少需要一个状态数值"));
  for (const [collection, items] of [
    ["stats", world.stats],
    ["attributes", world.attributes],
    ["traits", world.traits],
    ["locations", world.locations],
    ["characters", world.characters],
    ["factions", world.factions],
    ["items", world.items],
    ["roleTemplates", world.roleTemplates],
    ["roleProgression", world.roleProgression],
    ["timeline", world.timeline],
    ["facts", world.facts],
  ]) {
    uniqueIdErrors(items, collection, errors);
  }
  const catalog = world.creationCatalog ?? {};
  for (const dim of BIG_FIVE_DIMENSIONS) {
    const items = Array.isArray(catalog.bigFive?.[dim]) ? catalog.bigFive[dim] : [];
    uniqueIdErrors(items, `creationCatalog.bigFive.${dim}`, errors);
    if (items.length < 2) {
      errors.push(error(`creationCatalog.bigFive.${dim}`, "too_few", "每个维度至少需要 2 个角色创建候选"));
    }
    if (items.length > 8) {
      errors.push(error(`creationCatalog.bigFive.${dim}`, "too_many", "每个维度最多保留 8 个角色创建候选"));
    }
    if (!items.some((item) => item?.pole === "high") || !items.some((item) => item?.pole === "low")) {
      errors.push(error(`creationCatalog.bigFive.${dim}`, "missing_pole", "维度必须同时包含 pole=high 与 pole=low 的选项"));
    }
    for (const item of items) {
      if (item && item.weight !== undefined && item.weight !== 1 && item.weight !== 2) {
        errors.push(error(`creationCatalog.bigFive.${dim}.${item.id}`, "invalid_weight", "weight 只能是 1 或 2"));
      }
      if (item && item.pole !== undefined && item.pole !== "high" && item.pole !== "low") {
        errors.push(error(`creationCatalog.bigFive.${dim}.${item.id}`, "invalid_pole", "pole 只能是 high 或 low"));
      }
    }
  }
  for (const items of [Array.isArray(catalog.motivations) ? catalog.motivations : []]) {
    uniqueIdErrors(items, "creationCatalog.motivations", errors);
    if (items.length < 3) {
      errors.push(error("creationCatalog.motivations", "too_few", "至少需要 3 个初始诉求候选"));
    }
    if (items.length > 12) {
      errors.push(error("creationCatalog.motivations", "too_many", "最多保留 12 个初始诉求候选"));
    }
  }
  if (world.creationFields !== undefined) {
    if (!Array.isArray(world.creationFields)) {
      errors.push(error("creationFields", "invalid_type", "必须是数组（appearance/details 或其 {key,label,placeholder} 对象）"));
    } else {
      const seen = new Set();
      world.creationFields.forEach((field, index) => {
        const key = typeof field === "string" ? field : field?.key;
        if (!CREATION_FIELD_KEYS.includes(key)) {
          errors.push(error(`creationFields[${index}]`, "invalid_enum", "只能是 appearance/details"));
        } else if (seen.has(key)) {
          errors.push(error(`creationFields[${index}]`, "duplicate_id", `字段 “${key}” 重复`));
        }
        if (field !== null && typeof field === "object" && !Array.isArray(field)) {
          if (field.label !== undefined && typeof field.label !== "string") {
            errors.push(error(`creationFields[${index}].label`, "invalid_type", "必须是字符串"));
          }
          if (field.placeholder !== undefined && typeof field.placeholder !== "string") {
            errors.push(error(`creationFields[${index}].placeholder`, "invalid_type", "必须是字符串"));
          }
          // 身外字段选项:不得点名原著人物,每项 2-16 字;少于 4 个候选视为质量不达标(软)。
          // 外貌按性别两套(拍板):optionsMale/optionsFemale 分别校验,旧书扁平 options 兼容。
          const optionGroups =
            key === "appearance"
              ? [["optionsMale", field.optionsMale], ["optionsFemale", field.optionsFemale], ["options", field.options]]
              : [["options", field.options]];
          for (const [groupKey, group] of optionGroups) {
            if (!Array.isArray(group)) continue;
            const characterNames = characterNamesOf(world);
            group.forEach((option, optionIndex) => {
              const text = String(option ?? "").trim();
              if (isCharacterBoundName(text, characterNames)) {
                errors.push(error(
                  `creationFields[${index}].${groupKey}[${optionIndex}]`,
                  "character_bound_option",
                  `选项不得绑定原著人物:「${text}」`,
                ));
              } else if (text.length < 2 || text.length > 16) {
                errors.push(error(
                  `creationFields[${index}].${groupKey}[${optionIndex}]`,
                  "bad_option_length",
                  "每个选项应为 2-16 字",
                ));
              }
            });
            const usable = group.filter((option) => {
              const text = String(option ?? "").trim();
              return !isCharacterBoundName(text, characterNames) && text.length >= 2 && text.length <= 16;
            });
            if (usable.length > 0 && usable.length < 4) {
              errors.push(error(
                `creationFields[${index}].${groupKey}`,
                "too_few_options",
                "选项至少 4 个(4-8 个为宜)",
              ));
            }
          }
          // 个人细节与身份划界:选项与任一身份模板完全同名即算重叠。
          if (key === "details" && Array.isArray(field.options)) {
            const roleNames = new Set(
              (world.roleTemplates ?? [])
                .map((role) => String(role?.name ?? "").trim())
                .filter(Boolean),
            );
            field.options.forEach((option, optionIndex) => {
              const text = String(option ?? "").trim();
              if (roleNames.has(text)) {
                errors.push(error(
                  `creationFields[${index}].options[${optionIndex}]`,
                  "details_role_overlap",
                  `个人细节不得与身份重名:「${text}」`,
                ));
              }
            });
          }
        }
        seen.add(key);
      });
    }
  }
  world.stats.forEach((stat, index) => {
    const path = `stats[${index}]`;
    if (!STAT_ROLES.has(stat.role)) errors.push(error(`${path}.role`, "invalid_enum", "必须是 vital/resource/progress/relation"));
    if (!Number.isFinite(stat.min)) errors.push(error(`${path}.min`, "invalid_number", "必须是数字"));
    if (!Number.isFinite(stat.max)) errors.push(error(`${path}.max`, "invalid_number", "必须是数字"));
    if (Number.isFinite(stat.min) && Number.isFinite(stat.max) && stat.min >= stat.max) {
      errors.push(error(path, "invalid_range", "min 必须小于 max"));
    }
    if (!Number.isFinite(stat.initial)) errors.push(error(`${path}.initial`, "invalid_number", "必须是数字"));
    if (
      Number.isFinite(stat.initial) &&
      Number.isFinite(stat.min) &&
      Number.isFinite(stat.max) &&
      (stat.initial < stat.min || stat.initial > stat.max)
    ) {
      errors.push(error(`${path}.initial`, "out_of_range", "必须位于 min 与 max 之间"));
    }
    if (stat.role === "vital" && !stat.zeroConsequence) {
      errors.push(error(`${path}.zeroConsequence`, "missing_value", "vital 状态必须给出耗尽时的后果文案"));
    }
  });
  world.attributes.forEach((attribute, index) => {
    if (!Number.isFinite(attribute.initial)) {
      errors.push(error(`attributes[${index}].initial`, "invalid_number", "判定属性必须有数字初始值；分类设定应放入 traits"));
    }
  });
  world.traits.forEach((trait, index) => {
    if (!trait.name) errors.push(error(`traits[${index}].name`, "missing_name", "缺少名称"));
    if (!trait.value) errors.push(error(`traits[${index}].value`, "missing_value", "缺少特质取值"));
  });

  const locationIds = new Set(world.locations.map((item) => item.id));
  const characterIds = new Set(world.characters.map((item) => item.id));
  const factionIds = new Set(world.factions.map((item) => item.id));
  const eventIds = new Set(world.timeline.map((item) => item.id));
  // 事件故事时间表（因果倒挂检测用，拍板 2026-08-20）。
  const eventTimes = new Map(world.timeline.map((item) => [item.id, Number(item.time)]));
  world.locations.forEach((location, index) => {
    for (const id of location.connections ?? []) {
      if (!locationIds.has(id)) errors.push(error(`locations[${index}].connections`, "unknown_reference", `未知地点 “${id}”`));
    }
  });
  world.characters.forEach((character, index) => {
    if (character.factionId && !factionIds.has(character.factionId)) {
      errors.push(error(`characters[${index}].factionId`, "unknown_reference", `未知势力 “${character.factionId}”`));
    }
    for (const id of character.locationIds ?? []) {
      if (!locationIds.has(id)) errors.push(error(`characters[${index}].locationIds`, "unknown_reference", `未知地点 “${id}”`));
    }
  });
  world.factions.forEach((faction, index) => {
    for (const id of faction.locationIds ?? []) {
      if (!locationIds.has(id)) errors.push(error(`factions[${index}].locationIds`, "unknown_reference", `未知地点 “${id}”`));
    }
  });
  world.items.forEach((item, index) => {
    if (!item.name || String(item.name).trim() === "") {
      errors.push(error(`items[${index}].name`, "missing_name", "物品必须有名字"));
    }
    for (const id of item.locationIds ?? []) {
      if (!locationIds.has(id)) errors.push(error(`items[${index}].locationIds`, "unknown_reference", `未知地点 “${id}”`));
    }
  });
  if (world.roleTemplates.length < 3) {
    errors.push(error("roleTemplates", "too_few", "至少需要 3 个可选身份"));
  }
  // 身份目录按书规模覆盖全书(8-30+):只保留防灌水的健全上限,不再当质量上限。
  if (world.roleTemplates.length > 40) {
    errors.push(error("roleTemplates", "too_many", "最多保留 40 个可选身份"));
  }
  const characterNames = characterNamesOf(world);
  world.roleTemplates.forEach((role, index) => {
    if (!role.name || String(role.name).trim() === "") {
      errors.push(error(`roleTemplates[${index}].name`, "missing_value", "身份必须有名字"));
    }
    if (isCharacterBoundRoleName(role.name, characterNames)) {
      // 玩家永远是原著里不存在的新角色:身份目录不得收录绑定原著人物的身份。
      // 用目录专用判定:误报会静默删掉合法身份且无恢复路径。
      errors.push(error(
        `roleTemplates[${index}].name`,
        "character_bound_role",
        `身份不得绑定原著具体人物:「${String(role.name).trim()}」`,
      ));
    }
    if (!role.description || String(role.description).trim() === "") {
      errors.push(error(`roleTemplates[${index}].description`, "missing_value", "身份必须有描述（是什么来路、能做什么、有何限制）"));
    }
    for (const id of role.locationIds ?? []) {
      if (!locationIds.has(id)) errors.push(error(`roleTemplates[${index}].locationIds`, "unknown_reference", `未知地点 “${id}”`));
    }
    for (const id of role.factionIds ?? []) {
      if (!factionIds.has(id)) errors.push(error(`roleTemplates[${index}].factionIds`, "unknown_reference", `未知势力 “${id}”`));
    }
    if (
      role.firstChapter != null &&
      (!Number.isInteger(role.firstChapter) || role.firstChapter < 1)
    ) {
      errors.push(error(`roleTemplates[${index}].firstChapter`, "invalid_anchor", "身份首次出现章节必须是正整数"));
    }
  });
  // 身份进阶路径硬校验：引用合法、无自环、触发事件非空、修正幅度有限数。
  // 报错只含 id 不含目标身份名：身份进阶本身就是剧透源，错误信息不能泄。
  const roleIds = new Set(world.roleTemplates.map((role) => role.id));
  const statIds = new Set(world.stats.map((stat) => stat.id));
  const attributeIds = new Set(world.attributes.map((attribute) => attribute.id));
  world.roleProgression.forEach((path, index) => {
    const base = "roleProgression[" + index + "]";
    if (!roleIds.has(path.fromRoleId)) {
      errors.push(error(base + ".fromRoleId", "unknown_reference", "未知身份 “" + path.fromRoleId + "”"));
    }
    if (!roleIds.has(path.toRoleId)) {
      errors.push(error(base + ".toRoleId", "unknown_reference", "未知身份 “" + path.toRoleId + "”"));
    }
    if (path.fromRoleId && path.fromRoleId === path.toRoleId) {
      errors.push(error(base, "self_loop", "进阶路径的起点与终点不能是同一身份"));
    }
    if (!path.triggerEvents?.length) {
      errors.push(error(base + ".triggerEvents", "empty", "进阶路径至少需要一个触发事件"));
    }
    path.triggerEvents.forEach((event, eventIndex) => {
      if (!event.name || String(event.name).trim() === "") {
        errors.push(error(base + ".triggerEvents[" + eventIndex + "].name", "missing_value", "触发事件必须有名字"));
      }
      if (!event.description || String(event.description).trim() === "") {
        errors.push(error(base + ".triggerEvents[" + eventIndex + "].description", "missing_value", "触发事件必须有描述"));
      }
    });
    for (const [key, label, known] of [
      ["statMinimums", "数值", statIds],
      ["attributeMinimums", "属性", attributeIds],
    ]) {
      for (const [id, minimum] of Object.entries(path.prerequisites?.[key] ?? {})) {
        if (!known.has(id)) {
          errors.push(error(base + ".prerequisites." + key + "." + id, "unknown_reference", "未知" + label + " “" + id + "”"));
        } else if (!Number.isFinite(minimum)) {
          errors.push(error(base + ".prerequisites." + key + "." + id, "invalid_number", label + "门槛必须是数字"));
        }
      }
    }
    for (const id of path.prerequisites?.factionIds ?? []) {
      if (!factionIds.has(id)) {
        errors.push(error(base + ".prerequisites.factionIds", "unknown_reference", "未知势力 “" + id + "”"));
      }
    }
    for (const [key, label] of [["modifiers", "属性修正"], ["refusalModifiers", "拒绝代价"]]) {
      for (const modifier of toArray(path[key])) {
        if (!attributeIds.has(modifier?.attributeId)) {
          errors.push(error(base + "." + key, "unknown_reference", "未知属性 “" + modifier?.attributeId + "”"));
        } else if (!Number.isFinite(modifier?.delta)) {
          errors.push(error(base + "." + key, "invalid_number", label + "幅度必须是数字"));
        }
      }
    }
  });
  // 身份目录必须覆盖原著中的通用身份/职业类型;绑定原著具体人物的角色标签
  // (主角、XX道侣、XX同伴……)不是可选的通用来路,不要求覆盖,否则会逼着模型
  // 生成「主角」这类身份,让玩家顶替原著人物。
  const canonRoles = new Set(
    world.characters
      .map((character) => String(character.role ?? "").trim())
      .filter((role) => role !== "" && !isCharacterBoundName(role, characterNames)),
  );
  const templateNames = world.roleTemplates
    .map((role) => String(role.name ?? "").trim())
    .filter(Boolean);
  const uncoveredRoles = [...canonRoles].filter(
    (canon) => !templateNames.some((name) => canon === name || name.includes(canon) || canon.includes(name)),
  );
  if (uncoveredRoles.length > 2) {
    for (const role of uncoveredRoles) {
      errors.push(error("roleTemplates", "uncovered_role", `身份目录未覆盖原著身份「${role}」`));
    }
  }
  world.timeline.forEach((event, index) => {
    if (event.locationId && !locationIds.has(event.locationId)) {
      errors.push(error(`timeline[${index}].locationId`, "unknown_reference", `未知地点 “${event.locationId}”`));
    }
    if (!Number.isFinite(event.time) || event.time < 0) {
      errors.push(error(`timeline[${index}].time`, "invalid_number", "必须是非负分钟数"));
    }
    if (!["player_action", "world_time", "system_patch", "never"].includes(event.resolution)) {
      errors.push(error(`timeline[${index}].resolution`, "invalid_value", "必须是可识别的解决方式"));
    }
    if (!Array.isArray(event.resolutionTargetIds)) {
      errors.push(error(`timeline[${index}].resolutionTargetIds`, "invalid_value", "必须是 ID 数组"));
    }
    if (event.tier !== undefined && !DIVERGENCE_TIERS[event.tier]) {
      errors.push(error(`timeline[${index}].tier`, "invalid_value", "只能是 core/side/local"));
    }
    for (const id of [...(event.prerequisites ?? []), ...(event.invalidatedBy ?? [])]) {
      if (!eventIds.has(id)) errors.push(error(`timeline[${index}]`, "unknown_reference", `未知事件 “${id}”`));
    }
    // 因果倒挂（拍板 2026-08-20）：prerequisites/invalidatedBy 指向的事件
    // 故事时间晚于自身——前置/顶替关系要求被引事件更早发生（或同时），
    // 倒挂说明 time 归位错了（常见于插叙/多线书），报错交模型修。
    for (const id of event.prerequisites ?? []) {
      const prereqTime = eventTimes.get(id);
      if (Number.isFinite(prereqTime) && Number.isFinite(event.time) && prereqTime > event.time) {
        errors.push(
          error(`timeline[${index}].prerequisites`, "causal_inversion", `前置事件 “${id}” 的故事时间晚于本事件（因果倒挂）`),
        );
      }
    }
    for (const id of event.invalidatedBy ?? []) {
      const sourceTime = eventTimes.get(id);
      if (Number.isFinite(sourceTime) && Number.isFinite(event.time) && sourceTime > event.time) {
        errors.push(
          error(`timeline[${index}].invalidatedBy`, "causal_inversion", `顶替事件 “${id}” 的故事时间晚于本事件（因果倒挂）`),
        );
      }
    }
  });
  world.facts.forEach((fact, index) => {
    if (!Number.isInteger(fact.chapterAnchor) || fact.chapterAnchor < 1) {
      errors.push(error(`facts[${index}].chapterAnchor`, "invalid_anchor", "必须是正整数章节"));
    }
  });

  if (state) {
    if (!locationIds.has(state.locationId)) errors.push(error("initialState.locationId", "unknown_reference", "初始地点不存在"));
    world.stats.forEach((stat) => {
      if (!Number.isFinite(state.stats?.[stat.id])) errors.push(error(`initialState.stats.${stat.id}`, "invalid_number", "缺少数字初始值"));
    });
    world.attributes.forEach((attribute) => {
      if (!Number.isFinite(state.attributes?.[attribute.id])) {
        errors.push(error(`initialState.attributes.${attribute.id}`, "invalid_number", "缺少数字初始值"));
      }
    });
  }
  return { world, errors };
}

function coreCompleteness(world) {
  return [
    Boolean(world.id),
    Boolean(world.title),
    world.locations.length > 0,
    world.attributes.length > 0,
    world.stats.length > 0,
  ].filter(Boolean).length;
}

// 内容守恒：修复不得靠「删光人物/事实」把错误数凑到零。
function contentMass(world) {
  return {
    characters: world.characters?.length ?? 0,
    factions: world.factions?.length ?? 0,
    locations: world.locations?.length ?? 0,
    items: world.items?.length ?? 0,
    timeline: world.timeline?.length ?? 0,
    facts: world.facts?.length ?? 0,
  };
}

export function selectBetterWorldDraft(currentInput, proposedInput, style) {
  const current = diagnoseWorld({ ...unwrapWorldDraft(currentInput), style });
  const proposed = diagnoseWorld({ ...unwrapWorldDraft(proposedInput), style });
  const currentCore = coreCompleteness(current.world);
  const proposedCore = coreCompleteness(proposed.world);
  const currentMass = contentMass(current.world);
  const proposedMass = contentMass(proposed.world);
  // 任一项内容低于当前 60% 即视为「靠删内容过关」，拒绝；
  // 当前为空的项目不设门槛（双方都空不算删减）。
  const preservesContent = Object.keys(currentMass).every(
    (key) => currentMass[key] === 0 || proposedMass[key] >= Math.floor(currentMass[key] * 0.6),
  );
  const fewerErrors = proposed.errors.length < current.errors.length;
  // 错误数相等时，内容更全（且没有删减项）的候选可以入选，不再白白浪费修复请求。
  const richerWithSameErrors =
    proposed.errors.length === current.errors.length &&
    Object.keys(currentMass).some((key) => proposedMass[key] > currentMass[key]) &&
    Object.keys(currentMass).every((key) => proposedMass[key] >= currentMass[key]);
  const accepted =
    preservesContent && proposedCore >= currentCore && (fewerErrors || richerWithSameErrors);
  return {
    accepted,
    diagnosis: accepted ? proposed : current,
    proposedErrors: proposed.errors,
    currentCore,
    proposedCore,
  };
}

export class WorldRepairError extends Error {
  constructor(errors) {
    super(`世界档案校验失败：\n${errors.map((item) => `- ${item.message}`).join("\n")}`);
    this.name = "WorldRepairError";
    this.errors = errors;
  }
}

// 硬错误 = 引擎玩不下去、且机械修复也救不回来的结构性缺陷。
// 软错误 = 确定性规则能修掉的残留；修掉后直接容忍，不再整本拦下。
export function isHardDiagnosisError(item) {
  const path = item.path ?? "";
  if (item.code === "duplicate_id") return true;
  if (path === "id" || path === "title") return true;
  // 集合级空（locations/attributes/stats 一处都没有）：机械修复不能凭空造内容，仍是硬错误。
  if (path === "locations" || path === "attributes" || path === "stats") return true;
  if (path.startsWith("initialState.")) return true;
  return false;
}

// 章节锚点兜底归一：数字原样，字符串取第一个数字，都没有则回落 1。
function anchorOrOne(value) {
  if (Number.isFinite(value)) return value;
  const match = String(value ?? "").match(/(\d+)/);
  return match ? Number(match[1]) : 1;
}

// 数值兜底：数字原样，字符串取第一个数字，都没有则用回落值。
function finiteNumber(value, fallback) {
  if (Number.isFinite(value)) return value;
  const match = String(value ?? "").match(/(-?\d+(?:\.\d+)?)/);
  const parsed = match ? Number(match[1]) : NaN;
  return Number.isFinite(parsed) ? parsed : fallback;
}

const STAT_ROLE_ORDER = ["vital", "resource", "progress", "relation"];

function slug(value) {
  const base = String(value ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return base || "world";
}

// 同一集合内 ID 去重：第一次出现的原样保留，重复的加数字后缀，空 ID 按集合名补出。
// 引用不必改写——去重只改名后面的重复者，引用仍指向保留的第一个。
function uniqueIds(items, kind) {
  const used = new Set();
  return (items ?? []).map((item, index) => {
    if (!item || typeof item !== "object") return item;
    const cloned = { ...item };
    let id = String(cloned.id ?? "").trim();
    if (!id) id = kind + "-" + (index + 1);
    if (used.has(id)) {
      let suffix = 2;
      while (used.has(id + "-" + suffix)) suffix += 1;
      id = id + "-" + suffix;
    }
    used.add(id);
    cloned.id = id;
    return cloned;
  });
}

// 软错误的确定性修复：删掉悬空引用、补上可安全补的缺省值。
// 不造内容、不改判定语义——只让诊断不再对这些残留项报错。
// meta.title 用于补出模型漏写的 world.id/title（书名永远已知，不该成为硬错误）。
export function mechanicallyRepairWorld(worldInput, meta = {}) {
  const world = structuredClone(worldInput);
  world.id = String(world.id ?? "").trim() || slug(meta.title) || "world";
  world.rules = clampRules(world.rules);
  world.title = String(world.title ?? "").trim() || String(meta.title ?? "").trim() || "world";
  world.locations = uniqueIds(world.locations, "location");
  world.characters = uniqueIds(world.characters, "character");
  world.factions = uniqueIds(world.factions, "faction");
  world.items = uniqueIds(world.items, "item");
  world.roleTemplates = uniqueIds(world.roleTemplates, "role");
  // 身份净化(仅烧制期生效):玩家永远是原著之外的新角色——丢弃绑定原著人物的
  // 模板,并按 name 去重(同名保留首个,模型常把同一身份写两遍)。
  const characterNames = characterNamesOf(world);
  const seenRoleNames = new Set();
  world.roleTemplates = (world.roleTemplates ?? []).filter((role) => {
    const name = String(role?.name ?? "").trim();
    if (!name) return true; // 空名留给诊断报错
    if (isCharacterBoundRoleName(name, characterNames)) return false;
    if (seenRoleNames.has(name)) return false;
    seenRoleNames.add(name);
    return true;
  });
  world.roleProgression = uniqueIds(world.roleProgression, "path");
  world.timeline = uniqueIds(world.timeline, "event");
  world.facts = uniqueIds(world.facts, "fact");
  world.attributes = uniqueIds(world.attributes, "attribute");
  world.stats = uniqueIds(world.stats, "stat");
  world.traits = uniqueIds(world.traits, "trait");
  if (world.creationCatalog && typeof world.creationCatalog === "object") {
    if (world.creationCatalog.bigFive && typeof world.creationCatalog.bigFive === "object" && !Array.isArray(world.creationCatalog.bigFive)) {
      for (const dim of BIG_FIVE_DIMENSIONS) {
        const entries = Array.isArray(world.creationCatalog.bigFive[dim]) ? world.creationCatalog.bigFive[dim] : [];
        world.creationCatalog.bigFive[dim] = entries
          .filter((item) => item && typeof item === "object" && String(item.name ?? "").trim() !== "")
          .map((item, index) => ({
            ...item,
            id: item.id || `bf-${dim}-${index + 1}`,
            pole: item.pole === "low" ? "low" : "high",
            weight: item.weight === 2 ? 2 : 1,
            goodSide: String(item.goodSide ?? ""),
            badSide: String(item.badSide ?? ""),
          }));
        world.creationCatalog.bigFive[dim] = uniqueIds(world.creationCatalog.bigFive[dim], "bf-" + dim);
      }
    }
    if (Array.isArray(world.creationCatalog.motivations)) {
      world.creationCatalog.motivations = uniqueIds(world.creationCatalog.motivations, "catalog-motivations");
    }
  }
  const locationIds = new Set((world.locations ?? []).map((item) => item.id));
  const factionIds = new Set((world.factions ?? []).map((item) => item.id));
  const eventIds = new Set((world.timeline ?? []).map((item) => item.id));
  // 事件故事时间表（机械剪除因果倒挂边用，与 diagnoseWorld 的检测同口径）。
  const repairEventTimes = new Map((world.timeline ?? []).map((item) => [item.id, Number(item.time)]));
  const statIds = new Set((world.stats ?? []).map((item) => item.id));
  const attributeIds = new Set((world.attributes ?? []).map((item) => item.id));
  const roleIds = new Set((world.roleTemplates ?? []).map((item) => item.id));

  // 数值型硬错误的机械挽救：模型乱写的属性/状态数值钳回可玩区间，不拦整本烧制。
  world.attributes = (world.attributes ?? []).map((attribute, index) => ({
    ...attribute,
    id: attribute.id || `attribute-${index + 1}`,
    initial: finiteNumber(attribute.initial, 10),
  }));
  world.stats = (world.stats ?? []).map((stat, index) => {
    const min = finiteNumber(stat.min, 0);
    const max = finiteNumber(stat.max, min + 100) > min ? finiteNumber(stat.max, min + 100) : min + 100;
    const initial = Math.min(max, Math.max(min, finiteNumber(stat.initial, Math.round((min + max) / 2))));
    const role = STAT_ROLE_ORDER.includes(stat.role) ? stat.role : "progress";
    return {
      ...stat,
      id: stat.id || `stat-${index + 1}`,
      role,
      min,
      max,
      initial,
      zeroConsequence:
        stat.zeroConsequence && String(stat.zeroConsequence).trim() !== ""
          ? stat.zeroConsequence
          : "状态耗尽，处境将急转直下。",
    };
  });
  world.traits = (world.traits ?? []).filter(
    (trait) =>
      trait?.name &&
      String(trait.name).trim() !== "" &&
      trait?.value !== undefined &&
      String(trait.value) !== "",
  );

  for (const location of world.locations ?? []) {
    location.id = location.id || `location-${world.locations.indexOf(location) + 1}`;
    location.connections = (location.connections ?? []).filter((id) => locationIds.has(id));
  }
  for (const character of world.characters ?? []) {
    character.id = character.id || `character-${world.characters.indexOf(character) + 1}`;
    if (character.factionId && !factionIds.has(character.factionId)) character.factionId = null;
    character.locationIds = (character.locationIds ?? []).filter((id) => locationIds.has(id));
  }
  for (const faction of world.factions ?? []) {
    faction.id = faction.id || `faction-${world.factions.indexOf(faction) + 1}`;
    faction.locationIds = (faction.locationIds ?? []).filter((id) => locationIds.has(id));
  }
  for (const item of world.items ?? []) {
    item.id = item.id || `item-${world.items.indexOf(item) + 1}`;
    item.locationIds = (item.locationIds ?? []).filter((id) => locationIds.has(id));
  }
  world.roleTemplates = (world.roleTemplates ?? []).map((role, index) => ({
    ...role,
    id: role.id || `role-${index + 1}`,
    name: role.name && String(role.name).trim() !== "" ? role.name : `来路${index + 1}`,
    description:
      role.description && String(role.description).trim() !== "" ? role.description : "原著中的一种来路。",
    firstChapter: anchorOrOne(role.firstChapter),
    locationIds: (role.locationIds ?? []).filter((id) => locationIds.has(id)),
    factionIds: (role.factionIds ?? []).filter((id) => factionIds.has(id)),
  }));
  world.roleProgression = toArray(world.roleProgression)
    .filter(
      (path) =>
        roleIds.has(path.fromRoleId) && roleIds.has(path.toRoleId) && path.fromRoleId !== path.toRoleId,
    )
    .map((path) => ({
      ...path,
      prerequisites: {
        statMinimums: Object.fromEntries(
          Object.entries(path.prerequisites?.statMinimums ?? {}).filter(
            ([id, value]) => statIds.has(id) && Number.isFinite(value),
          ),
        ),
        attributeMinimums: Object.fromEntries(
          Object.entries(path.prerequisites?.attributeMinimums ?? {}).filter(
            ([id, value]) => attributeIds.has(id) && Number.isFinite(value),
          ),
        ),
        factionIds: (path.prerequisites?.factionIds ?? []).filter((id) => factionIds.has(id)),
      },
      modifiers: toArray(path.modifiers).filter(
        (modifier) => attributeIds.has(modifier?.attributeId) && Number.isFinite(modifier?.delta),
      ),
      refusalModifiers: toArray(path.refusalModifiers).filter(
        (modifier) => attributeIds.has(modifier?.attributeId) && Number.isFinite(modifier?.delta),
      ),
    }));
  for (const event of world.timeline ?? []) {
    event.id = event.id || `event-${world.timeline.indexOf(event) + 1}`;
    if (event.locationId && !locationIds.has(event.locationId)) event.locationId = undefined;
    if (!["player_action", "world_time", "system_patch", "never"].includes(event.resolution)) {
      event.resolution = "never";
    }
    if (!DIVERGENCE_TIERS[event.tier]) event.tier = "side";
    event.prerequisites = (event.prerequisites ?? []).filter(
      (id) => eventIds.has(id) && !(Number.isFinite(repairEventTimes.get(id)) && Number.isFinite(event.time) && repairEventTimes.get(id) > event.time),
    );
    event.invalidatedBy = (event.invalidatedBy ?? []).filter(
      (id) => eventIds.has(id) && !(Number.isFinite(repairEventTimes.get(id)) && Number.isFinite(event.time) && repairEventTimes.get(id) > event.time),
    );
    if (!Array.isArray(event.resolutionTargetIds)) event.resolutionTargetIds = [];
  }
  for (const fact of world.facts ?? []) {
    fact.id = fact.id || `fact-${world.facts.indexOf(fact) + 1}`;
    fact.chapterAnchor = anchorOrOne(fact.chapterAnchor);
  }
  return world;
}

// 最后兜底：核心集合（地点/属性/状态）仍为空时，补一个最小可玩骨架，绝不整本拦下。
// 这是模型重生成与机械修复全部失败后的最后手段；降级留痕 degraded.reasons 供用户查证。
export function fallbackWorldCore(worldInput, { title = "" } = {}) {
  const world = structuredClone(worldInput ?? {});
  const reasons = [];
  if (!String(world.id ?? "").trim()) {
    world.id = slug(title) || "world";
    reasons.push("missing-id");
  }
  if (!String(world.title ?? "").trim()) {
    world.title = String(title ?? "").trim() || "未命名世界";
    reasons.push("missing-title");
  }
  if (!world.locations?.length) {
    world.locations = [{ id: "fb-place", name: "故事之地", connections: [] }];
    reasons.push("empty-locations");
  }
  if (!world.attributes?.length) {
    world.attributes = [{ id: "fb-aptitude", name: "资质", initial: 10 }];
    reasons.push("empty-attributes");
  }
  if (!world.stats?.length) {
    world.stats = [
      {
        id: "fb-condition",
        name: "状态",
        role: "vital",
        min: 0,
        max: 100,
        initial: 100,
        zeroConsequence: "处境急转直下。",
      },
    ];
    reasons.push("empty-stats");
  }
  if (reasons.length) {
    world.degraded = {
      reasons,
      note: "模型多次未能生成完整世界档案，已用最小可玩骨架补全；建议换更强的模型重烧，获得更贴合原著的世界。",
    };
  }
  return world;
}
