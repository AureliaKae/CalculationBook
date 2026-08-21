// 原创实体写回：玩家可在「原著没讲到的地方」创建自己的身份、门派、地点、物品、人物，
// 并持久化进 world（带 provenance 标记区分「原著派生」与「玩家原创」），跨转世存续。
//
// 这里只做「硬校验」——ID 唯一、引用合法、不破坏既有事实。「合味道 / 不矛盾」的软校验
// 交给 LLM（见 buildCreationDraftMessages），两段式：代码管结构合法，模型管世界观符合度。

// 支持创建的五类实体，各自映射到 world 上的集合与必要字段。
export const CREATABLE_KINDS = Object.freeze({
  faction: {
    collection: "factions",
    required: ["name", "summary"],
    referenceFields: ["locationIds"],
    label: "门派/势力",
  },
  role: {
    collection: "roleTemplates",
    required: ["name", "description"],
    referenceFields: ["locationIds", "factionIds"],
    label: "身份",
  },
  location: {
    collection: "locations",
    required: ["name"],
    referenceFields: ["connections"],
    label: "地点",
  },
  item: {
    collection: "items",
    required: ["name", "summary"],
    referenceFields: ["locationIds"],
    label: "物品",
  },
  character: {
    collection: "characters",
    required: ["name", "summary"],
    referenceFields: ["locationIds", "factionId"],
    label: "人物",
  },
});

// 合法引用目标：locationIds/connections 指向地点，factionId/factionIds 指向势力。
const LOCATION_REF_FIELDS = new Set(["locationIds", "connections"]);
const FACTION_REF_FIELDS = new Set(["factionId", "factionIds"]);

function existingIds(world) {
  return {
    locations: new Set(world.locations.map((item) => item.id)),
    factions: new Set(world.factions.map((item) => item.id)),
    characters: new Set(world.characters.map((item) => item.id)),
    roleTemplates: new Set(world.roleTemplates.map((item) => item.id)),
    items: new Set(world.items.map((item) => item.id)),
  };
}

// 生成一个不与既有集合冲突的稳定 ID：优先用 name 归一化的 slug，撞了追加序号。
export function uniqueEntityId(kind, draft, world, index = 0) {
  const { collection } = CREATABLE_KINDS[kind];
  const ids = existingIds(world)[collection];
  const slug = String(draft.name ?? "")
    .trim()
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^\p{Letter}\p{Number}]+/gu, "-")
    .replace(/^-|-$/g, "");
  const base = slug || `${kind}-${index + 1}`;
  let candidate = base;
  let suffix = 2;
  while (ids.has(candidate)) {
    candidate = `${base}-${suffix}`;
    suffix += 1;
  }
  return candidate;
}

function collectErrors(draft, world) {
  const errors = [];
  const locationIds = new Set(world.locations.map((item) => item.id));
  const factionIds = new Set(world.factions.map((item) => item.id));
  for (const [field, value] of Object.entries(draft)) {
    if (LOCATION_REF_FIELDS.has(field)) {
      for (const id of Array.isArray(value) ? value : [value]) {
        if (id == null || id === "") continue;
        if (!locationIds.has(id)) errors.push(`引用了不存在的地点 “${id}”`);
      }
    }
    if (FACTION_REF_FIELDS.has(field)) {
      for (const id of Array.isArray(value) ? value : [value]) {
        if (id == null || id === "") continue;
        if (!factionIds.has(id)) errors.push(`引用了不存在的势力 “${id}”`);
      }
    }
  }
  return errors;
}

// 硬校验：kind 合法、必要字段齐全、引用存在、ID 不与既有实体冲突。
// 返回 { ok, errors, entity }。不修改 world。
export function validateCreation(kind, draft, world, options = {}) {
  const spec = CREATABLE_KINDS[kind];
  if (!spec) return { ok: false, errors: [`未知的实体类型 “${kind}”`] };
  const errors = [];
  for (const field of spec.required) {
    const value = draft[field];
    if (typeof value !== "string" || value.trim() === "") {
      errors.push(`${spec.label}必须提供 ${field}`);
    }
  }
  const id = options.allowExistingId && draft.id ? draft.id : uniqueEntityId(kind, draft, world);
  const ids = existingIds(world)[spec.collection];
  if (ids.has(id)) errors.push(`ID “${id}” 已存在`);
  errors.push(...collectErrors(draft, world));
  // 身份可以顺带声明一条进阶路径：起点/终点都必须是本书身份（含正在创建的这个），
  // 触发契机一句即可，由 LLM 软校验兜底合味道。
  if (kind === "role" && draft.progression) {
    const progression = draft.progression ?? {};
    // "__new__" 是界面侧的占位标记：指代正在创建的这个身份。
    const fromRoleId = progression.fromRoleId === "__new__" ? id : progression.fromRoleId;
    const toRoleId = progression.toRoleId === "__new__" ? id : progression.toRoleId;
    const roleIds = existingIds(world).roleTemplates;
    roleIds.add(id);
    if (!roleIds.has(fromRoleId) || !roleIds.has(toRoleId)) {
      errors.push("进阶路径的起点与终点必须是本书已有的身份");
    } else if (fromRoleId === toRoleId) {
      errors.push("进阶路径的起点与终点不能是同一身份");
    }
    if (
      typeof progression.triggerDescription !== "string" ||
      progression.triggerDescription.trim() === ""
    ) {
      errors.push("进阶路径需要一句触发契机描述");
    }
  }
  return { ok: errors.length === 0, errors, id };
}

// 统一入口：把一份合法草稿写回 world，返回新的 world 对象（不原地修改）。
// meta 提供 provenance 信息：{ lifeIndex, createdTurn }。
export function createEntity(kind, draft, world, meta = {}) {
  const spec = CREATABLE_KINDS[kind];
  if (!spec) throw new Error(`未知的实体类型 “${kind}”`);
  const validation = validateCreation(kind, draft, world);
  if (!validation.ok) throw new Error(`创建失败：${validation.errors.join("；")}`);
  const provenance = {
    source: "player_created",
    ...(Number.isInteger(meta.lifeIndex) ? { lifeIndex: meta.lifeIndex } : {}),
    ...(Number.isInteger(meta.createdTurn) ? { createdTurn: meta.createdTurn } : {}),
  };
  const entity = {
    ...draft,
    id: validation.id,
    provenance,
  };
  const next = structuredClone(world);
  next[spec.collection] = [...(next[spec.collection] ?? []), entity];
  // 双向挂链（拍板 2026-08-21：原创一笔要在意图中起作用）：新地点单向指向
  // 既有地点时，既有地点不会反向挂链——上下文的可见地点集合（当前地点 ∪
  // connections）永远不含新地点，模型无从生成「去那里」的选项，
  // statePatch.locationId 也无从引用。回写反向连接，让造得出就走得到。
  if (kind === "location") {
    for (const connectedId of entity.connections ?? []) {
      const existing = next.locations.find((item) => item.id === connectedId);
      if (existing && !(existing.connections ?? []).includes(entity.id)) {
        existing.connections = [...(existing.connections ?? []), entity.id];
      }
    }
  }
  // 玩家原创身份可顺带声明进阶路径：与新身份一起写回，与烧制路径同走 repair 校验。
  if (kind === "role" && draft.progression) {
    const progression = draft.progression;
    const triggerDescription = String(progression.triggerDescription ?? "").trim();
    const fromRoleId = progression.fromRoleId === "__new__" ? validation.id : progression.fromRoleId;
    const toRoleId = progression.toRoleId === "__new__" ? validation.id : progression.toRoleId;
    const used = new Set((next.roleProgression ?? []).map((item) => item.id));
    const base = "progression-" + fromRoleId + "-" + toRoleId;
    let progressionId = base;
    let suffix = 2;
    while (used.has(progressionId)) {
      progressionId = base + "-" + suffix;
      suffix += 1;
    }
    next.roleProgression = [
      ...(next.roleProgression ?? []),
      {
        id: progressionId,
        fromRoleId,
        toRoleId,
        triggerEvents: [
          {
            id: "trigger-" + progressionId,
            name: triggerDescription,
            description: triggerDescription,
          },
        ],
        prerequisites: {},
        modifiers: [],
        refusalModifiers: [],
        provenance,
      },
    ];
  }
  return next;
}

// 玩家原创实体的上下文清单（拍板 2026-08-21：原创一笔要在意图中起作用）：
// 按 provenance 过滤五集合，只带模型需要的紧凑字段。world 跨转世持久，
// 历世所造一并可见——它们与原著实体同权，是真实世界事实。
export function playerCreationsView(world) {
  const by = (collection) =>
    (world[collection] ?? []).filter((item) => item?.provenance?.source === "player_created");
  return {
    factions: by("factions").map((item) => ({ id: item.id, name: item.name, summary: item.summary })),
    roles: by("roleTemplates").map((item) => ({
      id: item.id,
      name: item.name,
      description: item.description,
    })),
    locations: by("locations").map((item) => ({
      id: item.id,
      name: item.name,
      connections: item.connections ?? [],
      ...(item.summary ? { summary: item.summary } : {}),
    })),
    items: by("items").map((item) => ({ id: item.id, name: item.name, summary: item.summary })),
    characters: by("characters").map((item) => ({
      id: item.id,
      name: item.name,
      summary: item.summary,
      locationIds: item.locationIds ?? [],
      factionId: item.factionId ?? null,
    })),
  };
}

// 原创人物当世即活（照涌现人物同款补种，见 story-emergence 的 applyEmergentPatch）：
// 只写 world 不动 state 的话，此人不进 entityStates、不进已发现名单——
// 上下文不出现、optionIsAvailable 拒绝指向她/他的选项（幽灵 NPC）。创建即
// 登记「已相遇」，落点取草稿首选地点、缺省落在玩家眼前。转世经
// createSuccessorState 继承 entityStates，自然存续。
export function seedCreatedCharacter(state, entity) {
  const locationId = entity?.locationIds?.[0] ?? state.locationId ?? null;
  return {
    ...state,
    entityStates: {
      ...(state.entityStates ?? {}),
      [entity.id]: {
        status: "active",
        factionId: entity.factionId ?? null,
        locationId,
      },
    },
    discoveredCharacterIds: [
      ...new Set([...(state.discoveredCharacterIds ?? []), entity.id]),
    ],
  };
}

// 生成「原创实体草稿」的 LLM 消息：输入用户意图 + 世界观摘要 + 文风，
// 输出该书文风与世界观下合规的实体设定，并附一句世界观符合度自评。
// 短字段（名字/关键事实）由用户手打，长描述（summary/description）由此代写。
export function buildCreationDraftMessages({ kind, intent, world, fields }) {
  const spec = CREATABLE_KINDS[kind];
  const payload = {
    kind,
    label: spec.label,
    intent,
    userFields: fields ?? {},
    world: {
      title: world.title,
      summary: world.summary,
      factions: world.factions.map((f) => ({ id: f.id, name: f.name, summary: f.summary })),
      locations: world.locations.map((l) => ({ id: l.id, name: l.name })),
      roleTemplates: world.roleTemplates.map((r) => ({ id: r.id, name: r.name, description: r.description })),
      traits: world.traits,
    },
    style: world.style,
  };
  return [
    {
      role: "system",
      content: `你是文字生存小说的世界观扩建器。用户要在“原著没有讲到的地方”创建一个${spec.label}。你必须让这个${spec.label}符合原著的世界观、时代、力量上限与社会结构——只做加法，不得与已知事实矛盾，不得凭空引入超出原著的设定。严格模仿给定 style 的文风与措辞。只返回 JSON，形如：{"draft":{"name":"...","summary":"...","locationIds":[],"factionIds":[]},"worldviewNote":"一句话说明为什么符合原著、与哪些已知设定呼应"}${
        kind === "role" ? "（role 用 description 而非 summary）" : ""
      }${kind === "location" ? "（location 用 connections 而非 locationIds）" : ""}`,
    },
    {
      role: "user",
      content: JSON.stringify(payload),
    },
  ];
}
