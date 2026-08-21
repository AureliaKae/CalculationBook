// 关系簿（拍板 2026-08-19：定性档位，不显数值）：引擎里 relationships 是
// ±10 的五维数值（stance/trust/leverage/fear/hostility），但产品承诺
// 「no stat panels, no spreadsheets」——界面只见定性，数值只喂判定。
// stance 是玩家对 ta 的立场(模型语义),不进界面定性:定性只看 ta 对玩家的
// trust/fear/hostility 三维。

// 数值 → 定性档。返回 { key, label, tone }:tone 供界面着色
// (good=青灰绿 / bad=朱红 / cool=灰)。
export function relationLabel(relation) {
  const trust = Number(relation?.trust) || 0;
  const fear = Number(relation?.fear) || 0;
  const hostility = Number(relation?.hostility) || 0;
  // 敌意最重,优先定性:结仇的人心再热也是敌。
  if (hostility >= 4) return { key: "hostile", label: "敌对", tone: "bad" };
  if (fear >= 4) return { key: "wary", label: "忌惮", tone: "cool" };
  if (trust >= 4) return { key: "close", label: "亲近", tone: "good" };
  if (trust <= -4) return { key: "strained", label: "生隙", tone: "bad" };
  // 有过来往(trust/fear/hostility 任一非零,或 stance/leverage 有值)算相识。
  const touched =
    trust !== 0 ||
    fear !== 0 ||
    hostility !== 0 ||
    (Number.isFinite(Number(relation?.stance)) && Number(relation.stance) !== 0) ||
    (Number.isFinite(Number(relation?.leverage)) && Number(relation.leverage) !== 0);
  if (touched) return { key: "acquainted", label: "相识", tone: "cool" };
  return { key: "met", label: "一面之缘", tone: "cool" };
}

// 关系簿视图（拍板 2026-08-20 收紧：只认有交集的人）：唯一来源是
// state.relationships——它只在真正打过交道时才建条目（模型逐回合申报的
// 信任/敌意/立场变化），在场旁观、开局预填、只被看见的人都一律不显示。
// 排序按条目建立顺序倒序（最近的交集在前）；上限 12 人，超出计余数。
// 人物卡所需字段一次带全——persona 四卡来自烧制,summary/精读数组在活
// world 对象上(motive 等字段可能缺,渲染层做可选)。
// 空簿返回 null(整块隐藏)。
export function relationsView(state, world, limit = 12) {
  const relationships = state?.relationships ?? {};
  const byId = new Map((world?.characters ?? []).map((character) => [character.id, character]));
  const all = [];
  for (const key of Object.keys(relationships).reverse()) {
    if (!key.startsWith("character:")) continue; // 势力关系不进人物簿
    const id = key.slice("character:".length);
    const character = byId.get(id);
    if (!character) continue;
    const relation = relationships[key];
    const entity = (state?.entityStates ?? {})[id] ?? {};
    const stance = relationLabel(relation);
    all.push({
      id,
      name: character.name ?? "",
      role: character.role ?? "",
      // 精读后的摘要更准;未精读回落烧制 summary。
      summary: String(
        character.summary ?? character.persona?.temperament ?? "",
      ).slice(0, 40),
      stance: entity.status === "dead" ? { key: "dead", label: "已故", tone: "dead" } : stance,
      status: entity.status && entity.status !== "active" ? entity.status : null,
      locationName:
        (world?.locations ?? []).find((location) => location.id === entity.locationId)?.name ??
        (world?.locations ?? []).find((location) => location.id === character.locationIds?.[0])?.name ??
        null,
      persona: character.persona
        ? {
            temperament: character.persona.temperament ?? "",
            motives: character.persona.motives ?? "",
            bottomLines: character.persona.bottomLines ?? "",
            manner: character.persona.manner ?? "",
          }
        : null,
      // 精读明细(活对象上可能有,normalize 重建的世界会缺):人物卡可选渲染。
      detail: character.detailed
        ? {
            motives: Array.isArray(character.motives) ? character.motives.slice(0, 4) : [],
            habits: Array.isArray(character.habits) ? character.habits.slice(0, 4) : [],
          }
        : null,
    });
  }
  if (!all.length) return null;
  return { entries: all.slice(0, limit), more: Math.max(0, all.length - limit) };
}
