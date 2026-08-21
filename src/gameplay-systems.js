import { applyRoleIdentity } from "./role-identity.js";
import { realmTraitsOf } from "./realm.js";
import { isPowerMode, playModeSummary } from "./play-mode.js";

const SYSTEMS = ["survival", "faction", "relationship", "personal"];
const EVIDENCE_STATUSES = new Set(["available", "committed", "expired"]);
const PRESSURE_STAGES = ["latent", "warning", "urgent", "critical", "resolved"];
const BOND_STATUSES = new Set(["forming", "active", "strained", "broken", "resolved"]);
const GOAL_STATUSES = new Set(["active", "blocked", "transformed", "completed", "abandoned"]);
// 因果证据总量上限：补丁由模型逐回合产出，无上限时长局会无限累积；到顶后
// 拒绝登记新证据（补丁被丢弃并留 reason），已有的引用关系一律不动。
const MAX_EVIDENCE = 200;
// 键黑名单：这些名字经 obj[key]=value 赋值会触发原型 setter（__proto__）或
// 遮蔽敏感属性，模型输出的 key 一律不得使用。
const UNSAFE_KEYS = new Set(["__proto__", "constructor", "prototype"]);

function clone(value) {
  return structuredClone(value);
}

function unique(items) {
  return [...new Set(items)];
}

function requireId(value, label) {
  if (!value || typeof value !== "string") throw new Error(`${label} requires id`);
}

function evidenceKey(sourceType, sourceId, system) {
  return `${sourceType}:${sourceId}:${system}`;
}

export function emptyGameplayState() {
  return {
    personalGoals: [],
    bonds: [],
    factionMemberships: [],
    survivalPressures: [],
    causalEvidence: {},
    pendingRevelations: [],
    schedulerState: Object.fromEntries(
      SYSTEMS.map((system) => [system, { dormantTurns: 0, lastDominantTurn: null }]),
    ),
    endingCandidate: null,
    characterJournal: [],
    // 生死搏斗的多回合对峙状态；无交锋时为 null。
    activeClash: null,
    // 连续无实质变化的回合数：情节原地打转的检测信号，>=2 时向模型注入僵局警告。
    consecutiveStaticTurns: 0,
    // 命运偏离：pending 是铺垫中的改命（攒势能），completed 是已写回的偏离。
    pendingDivergences: [],
    completedDivergences: [],
    // 涌现故事（拍板 2026-08-17）：玩家行动长出的原创故事线（含动量与档位）。
    emergentStories: [],
    // 同行者（拍板 2026-08-17：仅涌现人物、叙事存在）：当前队伍与离队存档。
    companions: [],
    companionsLog: [],
    // 可选资源池（resource id → 数值），供骰子修正读取；缺省为空不影响判定。
    resources: {},
    // 身份进阶：待玩家在转变卡上处理的转变；未处理时阻塞选项。
    pendingRoleTransition: null,
    // 上一次拒绝的转变：下回合一次性注入叙事，让代价由剧情揭晓。
    lastRefusedTransition: null,
  };
}

export function migrateGameplayState(state = {}) {
  const empty = emptyGameplayState();
  return {
    ...empty,
    personalGoals: clone(state.personalGoals ?? empty.personalGoals),
    bonds: clone(state.bonds ?? empty.bonds),
    factionMemberships: clone(state.factionMemberships ?? empty.factionMemberships),
    survivalPressures: clone(state.survivalPressures ?? empty.survivalPressures),
    causalEvidence: clone(state.causalEvidence ?? empty.causalEvidence),
    pendingRevelations: clone(state.pendingRevelations ?? empty.pendingRevelations),
    schedulerState: {
      ...empty.schedulerState,
      ...clone(state.schedulerState ?? {}),
    },
    endingCandidate: clone(state.endingCandidate ?? null),
    characterJournal: clone(state.characterJournal ?? empty.characterJournal),
    // 旧存档没有交锋字段：默认无交锋。字段内部做浅校验，坏数据整段丢弃。
    activeClash: isValidClash(state.activeClash) && state.activeClash ? clone(state.activeClash) : null,
    // 旧存档没有停滞计数：默认 0。
    consecutiveStaticTurns: Number.isInteger(state.consecutiveStaticTurns)
      ? state.consecutiveStaticTurns
      : 0,
    // 命运偏离：旧档没有则空。
    pendingDivergences: clone(state.pendingDivergences ?? empty.pendingDivergences),
    completedDivergences: clone(state.completedDivergences ?? empty.completedDivergences),
    // 涌现故事：旧档没有则空；坏形状的条目整段丢弃，只留结构齐全的。
    emergentStories: (Array.isArray(state.emergentStories) ? state.emergentStories : [])
      .filter(
        (story) =>
          story &&
          typeof story === "object" &&
          !Array.isArray(story) &&
          story.id &&
          story.title &&
          Number.isFinite(Number(story.momentum)),
      )
      .map((story) => ({
        id: String(story.id),
        title: String(story.title),
        summary: String(story.summary ?? ""),
        originTurn: Number(story.originTurn) || 1,
        worldTime: Number(story.worldTime) || 0,
        characterIds: Array.isArray(story.characterIds) ? story.characterIds.filter((id) => typeof id === "string") : [],
        eventIds: Array.isArray(story.eventIds) ? story.eventIds.filter((id) => typeof id === "string") : [],
        momentum: Math.max(0, Math.min(9, Math.round(Number(story.momentum) || 0))),
        tier: ["local", "side", "world"].includes(story.tier) ? story.tier : "local",
        kind: story.kind === "venture" ? "venture" : "tale",
        erupted: Boolean(story.erupted),
      })),
    // 同行者：旧档没有则空；结构不全的条目丢弃。
    companions: (Array.isArray(state.companions) ? state.companions : [])
      .filter(
        (item) =>
          item &&
          typeof item === "object" &&
          !Array.isArray(item) &&
          item.characterId &&
          item.name,
      )
      .map((item) => ({
        id: String(item.id ?? `companion:${item.characterId}`),
        characterId: String(item.characterId),
        name: String(item.name),
        sinceTurn: Number(item.sinceTurn) || 1,
        note: String(item.note ?? ""),
      }))
      .slice(0, 3),
    companionsLog: (Array.isArray(state.companionsLog) ? state.companionsLog : [])
      .filter((item) => item && typeof item === "object" && item.name)
      .map((item) => ({
        turn: Number(item.turn) || 1,
        name: String(item.name),
        reason: String(item.reason ?? ""),
      }))
      .slice(-20),
    resources: clone(state.resources ?? empty.resources),
    // 身份进阶：旧档没有则空；结构不全的转变整段丢弃，不阻塞局面。
    pendingRoleTransition: isValidPendingTransition(state.pendingRoleTransition)
      ? clone(state.pendingRoleTransition)
      : null,
    lastRefusedTransition: isValidRefusedTransition(state.lastRefusedTransition)
      ? clone(state.lastRefusedTransition)
      : null,
  };
}

// 待处理的身份转变：必须带路径与目标身份，否则视为坏数据丢弃。
function isValidPendingTransition(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  return Boolean(value.progressionId && value.toRoleId);
}

function isValidRefusedTransition(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  return typeof value.progressionId === "string";
}

// 只认结构完整的交锋状态，防止半截数据污染存档。
function isValidClash(clash) {
  if (clash === null || clash === undefined) return true;
  if (typeof clash !== "object" || Array.isArray(clash)) return false;
  return (
    typeof clash.opponentId === "string" &&
    typeof clash.opponentName === "string" &&
    Number.isInteger(clash.opponentCondition) &&
    Number.isInteger(clash.stance) &&
    Number.isInteger(clash.step) &&
    Number.isInteger(clash.maxSteps)
  );
}

export function validateGameplayState(state, world) {
  const characterIds = new Set(world.characters.map((item) => item.id));
  const factionIds = new Set(world.factions.map((item) => item.id));
  const evidenceIds = new Set(Object.keys(state.causalEvidence ?? {}));
  for (const [key, evidence] of Object.entries(state.causalEvidence ?? {})) {
    if (!EVIDENCE_STATUSES.has(evidence.status)) throw new Error(`Invalid evidence status: ${key}`);
    if (!SYSTEMS.includes(evidence.system)) throw new Error(`Invalid evidence system: ${key}`);
  }
  for (const goal of state.personalGoals ?? []) {
    requireId(goal.id, "Goal");
    if (!GOAL_STATUSES.has(goal.status)) throw new Error(`Invalid goal status: ${goal.id}`);
    if (!(goal.evidenceIds ?? []).every((id) => evidenceIds.has(id))) {
      throw new Error(`Goal references unknown evidence: ${goal.id}`);
    }
  }
  for (const bond of state.bonds ?? []) {
    requireId(bond.id, "Bond");
    if (!BOND_STATUSES.has(bond.status)) throw new Error(`Invalid bond status: ${bond.id}`);
    if (bond.fromId !== "player" && !characterIds.has(bond.fromId)) {
      throw new Error(`Bond references unknown source: ${bond.id}`);
    }
    if (bond.toId !== "player" && !characterIds.has(bond.toId)) {
      throw new Error(`Bond references unknown target: ${bond.id}`);
    }
  }
  for (const membership of state.factionMemberships ?? []) {
    requireId(membership.id, "Membership");
    if (!factionIds.has(membership.factionId)) {
      throw new Error(`Membership references unknown faction: ${membership.id}`);
    }
  }
  for (const pressure of state.survivalPressures ?? []) {
    requireId(pressure.id, "Pressure");
    if (!PRESSURE_STAGES.includes(pressure.stage)) {
      throw new Error(`Invalid pressure stage: ${pressure.id}`);
    }
    if (
      pressure.permanentConsequence &&
      !(
        pressure.causeEvidenceId &&
        evidenceIds.has(pressure.causeEvidenceId) &&
        pressure.warningObserved &&
        pressure.responseOpportunityOffered
      )
    ) {
      throw new Error(`Permanent consequence lacks warning chain: ${pressure.id}`);
    }
  }
  return true;
}

function registerEvidence(next, item, system) {
  const key = item.key ?? evidenceKey(item.sourceType, item.sourceId, system);
  // key 出自模型输出：非字符串/空串/危险名一律拒绝，防止 __proto__ 触发原型
  // setter 把 causalEvidence 的原型换掉；超长键也会被正常路径拒绝。
  if (
    typeof key !== "string" ||
    !key ||
    key.length > 120 ||
    UNSAFE_KEYS.has(key)
  ) {
    throw new Error(`Invalid evidence key: ${String(key)}`);
  }
  const current = next.causalEvidence[key];
  if (current?.status === "committed") throw new Error(`Evidence already consumed: ${key}`);
  if (Object.keys(next.causalEvidence).length >= MAX_EVIDENCE && !current) {
    throw new Error(`Evidence limit reached (${MAX_EVIDENCE})`);
  }
  next.causalEvidence[key] = {
    sourceType: item.sourceType,
    sourceId: item.sourceId,
    system,
    public: Boolean(item.public),
    summary: item.summary ?? "",
    status: item.status ?? "available",
  };
  return key;
}

function consumeEvidence(next, ids) {
  for (const id of ids ?? []) {
    const evidence = next.causalEvidence[id];
    if (!evidence) throw new Error(`Unknown evidence: ${id}`);
    if (evidence.status !== "available") throw new Error(`Evidence is not available: ${id}`);
    evidence.status = "committed";
  }
}

function upsertById(items, change) {
  const index = items.findIndex((item) => item.id === change.id);
  if (index < 0) items.push(change);
  else items[index] = { ...items[index], ...change };
}

export function applySystemPatch(state, system, patch = {}, world) {
  if (!SYSTEMS.includes(system)) throw new Error(`Unknown gameplay system: ${system}`);
  const next = { ...clone(state), ...migrateGameplayState(state) };
  for (const item of patch.evidence ?? []) registerEvidence(next, item, system);
  consumeEvidence(next, patch.consumeEvidenceIds);

  if (system === "personal") {
    for (const goal of patch.goals ?? []) {
      upsertById(next.personalGoals, {
        evidenceIds: [],
        milestones: [],
        blockers: [],
        transformationHistory: [],
        endingEligible: false,
        status: "active",
        ...clone(goal),
      });
    }
  } else if (system === "relationship") {
    for (const bond of patch.bonds ?? []) {
      upsertById(next.bonds, {
        evidenceIds: [],
        obligations: [],
        breachHistory: [],
        status: "forming",
        ...clone(bond),
      });
    }
  } else if (system === "faction") {
    for (const membership of patch.memberships ?? []) {
      upsertById(next.factionMemberships, {
        authority: [],
        duties: [],
        overdueDutyIds: [],
        promotionEvidenceIds: [],
        discipline: [],
        visibility: "public",
        ...clone(membership),
      });
    }
  } else {
    for (const pressure of patch.pressures ?? []) {
      upsertById(next.survivalPressures, {
        stage: "latent",
        advanceConditions: [],
        reliefConditions: [],
        signs: [],
        reversible: true,
        warningObserved: false,
        responseOpportunityOffered: false,
        ...clone(pressure),
      });
    }
  }

  for (const revelation of patch.pendingRevelations ?? []) {
    if (!revelation.id || !revelation.summary) throw new Error("Revelation requires id and summary");
    upsertById(next.pendingRevelations, { visible: false, ...clone(revelation) });
  }
  validateGameplayState(next, world);
  return next;
}

function preconditionMatches(state, condition) {
  // 前置条件由模型写出，path 缺失或不是字符串时无法求值，按不满足处理，
  // 让这条补丁被丢弃，而不是把整个回合炸掉。
  if (typeof condition?.path !== "string" || !condition.path) return false;
  const value = condition.path
    .split(".")
    .reduce((current, segment) => current?.[segment], state);
  if ("equals" in condition) return value === condition.equals;
  if ("includes" in condition) return Array.isArray(value) && value.includes(condition.includes);
  return value !== undefined;
}

export function applyLayeredPatches(state, patches = {}, world) {
  // 没有补丁时零拷贝返回：调用方拿到的状态是 applyDelta 刚产出的新对象，
  // 后续原地写入安全。
  if (!patches || Object.keys(patches).length === 0) {
    return { state, committed: [], dropped: [] };
  }
  let next = clone(state);
  const committed = [];
  const dropped = [];
  for (const system of SYSTEMS) {
    const patch = patches[system];
    if (!patch) continue;
    // 模型偶尔把 dependsOn/preconditions 写成单个对象而非数组:
    // 形状不对一律按「不满足」处理,让这条补丁被丢弃(与缺 path 的条件同等待遇),
    // 而不是在 .every 上把整个回合炸掉。
    const dependsOnOk = patch.dependsOn === undefined || Array.isArray(patch.dependsOn);
    const preconditionsOk =
      patch.preconditions === undefined || Array.isArray(patch.preconditions);
    const dependenciesMet =
      dependsOnOk && (patch.dependsOn ?? []).every((id) => committed.includes(id));
    const versionMatches =
      patch.readTurn === undefined || patch.readTurn === next.turn;
    const preconditionsMet =
      preconditionsOk &&
      (patch.preconditions ?? []).every((condition) => preconditionMatches(next, condition));
    if (!dependenciesMet || !versionMatches || !preconditionsMet) {
      dropped.push({ system, id: patch.id, reason: "precondition" });
      continue;
    }
    try {
      next = applySystemPatch(next, system, patch, world);
      committed.push(patch.id ?? system);
    } catch (error) {
      dropped.push({ system, id: patch.id, reason: error.message });
    }
  }
  return { state: next, committed, dropped };
}

function systemOpportunity(state, system) {
  if (system === "survival") {
    return state.survivalPressures.some((item) => !["resolved"].includes(item.stage));
  }
  if (system === "faction") {
    return state.factionMemberships.some(
      (item) => item.duties.length || item.overdueDutyIds.length,
    );
  }
  if (system === "relationship") {
    return state.bonds.some((item) => !["broken", "resolved"].includes(item.status));
  }
  return state.personalGoals.some((item) => ["active", "blocked"].includes(item.status));
}

export function scheduleGameplaySystems(state, turn = state.turn) {
  // 本函数只读写 schedulerState：只克隆调度器，不再整份深拷贝状态。
  const schedulerState = Object.fromEntries(
    SYSTEMS.map((system) => [
      system,
      { ...(state.schedulerState?.[system] ?? { dormantTurns: 0, lastDominantTurn: null }) },
    ]),
  );
  const candidates = SYSTEMS.filter((system) => systemOpportunity(state, system)).map(
    (system, stableIndex) => {
      const scheduler = schedulerState[system];
      const immediate =
        system === "survival" &&
        state.survivalPressures.some((item) => ["urgent", "critical"].includes(item.stage));
      const overdue =
        system === "faction" &&
        state.factionMemberships.some((item) => item.overdueDutyIds.length);
      return {
        system,
        stableIndex,
        score: (immediate ? 100 : 0) + (overdue ? 50 : 0) + Math.min(scheduler.dormantTurns, 6) * 5,
      };
    },
  );
  candidates.sort((left, right) => right.score - left.score || left.stableIndex - right.stableIndex);
  const dominant = candidates.slice(0, 2).map((item) => item.system);
  for (const system of SYSTEMS) {
    const scheduler = schedulerState[system];
    if (!systemOpportunity(state, system)) scheduler.dormantTurns = 0;
    else if (dominant.includes(system)) {
      scheduler.dormantTurns = 0;
      scheduler.lastDominantTurn = turn;
    } else scheduler.dormantTurns += 1;
  }
  return { dominant, schedulerState };
}

export function buildCharacterJournal(state) {
  const entries = [];
  // 这一世(拍板:爽文/原味模式已移除,新档一律纯规则,卷宗不再写模式;
  // 仅旧爽文存档保留一条定性标注,让读档者知道这一世沿用旧规则,不带数值)。
  if (isPowerMode(state)) {
    entries.push({
      id: "life:mode",
      section: "这一世",
      text: playModeSummary(state),
    });
  }
  for (const goal of state.personalGoals ?? []) {
    if (goal.publicDirection && ["active", "blocked"].includes(goal.status)) {
      entries.push({ id: `goal:${goal.id}`, section: "心中所向", text: goal.publicDirection });
    }
  }
  for (const bond of state.bonds ?? []) {
    if (bond.known && bond.obligations?.length) {
      entries.push({
        id: `bond:${bond.id}`,
        section: "承诺与债务",
        text: bond.obligations.join("；"),
      });
    }
  }
  for (const membership of state.factionMemberships ?? []) {
    for (const duty of membership.duties ?? []) {
      if (duty.known !== false && duty.status !== "completed") {
        entries.push({ id: `duty:${membership.id}:${duty.id}`, section: "职责", text: duty.text });
      }
    }
  }
  for (const pressure of state.survivalPressures ?? []) {
    if (pressure.warningObserved && pressure.stage !== "resolved") {
      entries.push({
        id: `pressure:${pressure.id}`,
        section: "身体与险境",
        text: pressure.publicSign ?? pressure.signs?.at(-1) ?? pressure.name,
      });
    }
  }
  // 身份履历：曾用身份与获得回合，供老玩家回望这一世的来路。
  const roleHistory = state.player?.roleHistory ?? [];
  for (const entry of roleHistory.slice(1)) {
    entries.push({
      id: `role:${entry.roleId}:${entry.sinceTurn}`,
      section: "身份履历",
      text: "第" + entry.sinceTurn + "回合，因" + (entry.reason ?? "机缘") + "转为" + entry.roleName,
    });
  }
  if (state.player?.roleDangling) {
    entries.push({
      id: "role:dangling",
      section: "身份履历",
      text: "当前身份已不在本书目录中，需要重选身份。",
    });
  }
  return entries;
}

export function advanceEndingCandidate(state) {
  const eligible = state.personalGoals.find(
    (goal) => goal.kind === "core" && goal.endingEligible && goal.status === "completed",
  );
  const immediateThreat = state.survivalPressures.some((item) =>
    ["urgent", "critical"].includes(item.stage),
  );
  // 没有候选目标、也没有残留的终局标记：本回合无事可做，直接复用原状态。
  if (!eligible && !state.endingCandidate) return state;
  const next = clone(state);
  if (!eligible) {
    // 已就绪的候选（含折叠来源 fate-complete）不是目标推进系统的资产：它的
    // 去留由终局处置路径（续阶段）决定。这里清掉/降级会让已合拢的终局在
    // 下一回合凭空消失，引擎又再次触发终局。
    if (state.endingCandidate?.ready) return state;
    next.endingCandidate = null;
    return next;
  }
  if (!next.endingCandidate || next.endingCandidate.goalId !== eligible.id) {
    next.endingCandidate = {
      type: "stage",
      goalId: eligible.id,
      createdTurn: next.turn,
      stableTurns: 0,
      ready: false,
    };
    return next;
  }
  if (immediateThreat) return next;
  next.endingCandidate.stableTurns += 1;
  // 合拢前留足伏笔回合:核心目标完成后连续 3 个回合叙事都会收到
  // endingApproach 信号(见 engine.buildContext),第 4 回合才合拢。
  next.endingCandidate.ready = next.endingCandidate.stableTurns >= 3;
  return next;
}

export function playerDeathState(state) {
  // 死亡已经落定在状态上（playerDead）：短路口径优先于一切重算——交锋致死
  // 的状态里 survivalPressures 没有致命项，重算会把死人判成活人。
  if (state.playerDead) {
    return { dead: true, cause: state.playerDeathCause ?? "伤重不治" };
  }
  // 交锋濒死窗口里 vital 归零不算死：最后一搏的判定才定生死。
  if (state.activeClash?.pendingDeath) return { dead: false };
  const fatal = state.survivalPressures.find(
    (item) =>
      item.permanentConsequence === "death" &&
      item.stage === "critical" &&
      item.warningObserved &&
      item.responseOpportunityOffered,
  );
  return fatal
    ? { dead: true, cause: fatal.name ?? fatal.id, pressureId: fatal.id }
    : { dead: false };
}

// 转世不带走属性，只在世界里留下一条前世传闻，后来者可能听到、可能撞上。
export function pastLifeFact(state, death, id) {
  const player = state.player;
  const history = player?.roleHistory?.length
    ? player.roleHistory
    : [{ roleName: player?.roleName ?? "旅人", sinceTurn: 1, reason: "开局" }];
  const first = history[0];
  // 前世最浓缩的传记：出身 → 历次转变 → 终点。单条履历时退化为旧句式。
  const arc = history
    .slice(1)
    .map((entry) => "第" + entry.sinceTurn + "回合转为" + entry.roleName)
    .join("，");
  const text = death?.dead
    ? player.name + "曾以" + first.roleName + "出身，活到第" + state.turn + "回合" +
      (arc ? "，" + arc : "") + "，最终" + death.cause + "。"
    : player.name + "曾以" + first.roleName + "出身" +
      (arc ? "，" + arc : "") + "，走过这里，那段旅程留下的后果还在。";
  return { id: `past-life-${id}`, text, chapterAnchor: 1 };
}

export function createSuccessorState(state, createdState, world) {
  const publicEvidence = Object.fromEntries(
    Object.entries(state.causalEvidence ?? {}).filter(([, evidence]) => evidence.public),
  );
  const location = world.locations.find((item) => item.id === createdState.locationId);
  const base = {
    ...clone(state),
    turn: state.turn,
    worldTime: state.worldTime,
    // 游玩模式(拍板:模式已移除):新一世一律纯规则 classic;向导已无模式可选,
    // 这里只做防御归一——旧档的 power 由 migrateState 保留,新一世不可达。
    playMode: createdState.playMode === "power" ? "power" : "classic",
    startingPoint:
      createdState.playMode === "power" && createdState.startingPoint === "ceiling"
        ? "ceiling"
        : "scratch",
    // 心性随转世继承(拍板:当世演化后的五维带走),前世的选择记录随前世作废。
    player: {
      ...clone(createdState.player),
      bigFive: clone(state.player?.bigFive ?? createdState.player.bigFive),
      lifeIndex: (state.player?.lifeIndex ?? 1) + 1,
    },
    stats: clone(createdState.stats),
    attributes: clone(createdState.attributes),
    traits: clone(createdState.traits),
    conditions: clone(createdState.conditions),
    locationId: createdState.locationId,
    location: location?.name ?? createdState.location,
    relationships: {},
    // 前世是另一个人：ta 认识谁、记得什么、上一世的僵局计数都不该跟过来。
    // 世界层面的实体状态、时间线与已解锁章节继续继承（原著人物在幕后继续生活）。
    discoveredCharacterIds: clone(createdState.discoveredCharacterIds ?? []),
    longTermMemories: clone(createdState.longTermMemories ?? []),
    consecutiveStaticTurns: 0,
    personalGoals: clone(createdState.personalGoals),
    bonds: [],
    // 新角色的出身势力记录随角色档案一起带过来（createPlayerState 会为所选势力建立）。
    factionMemberships: clone(createdState.factionMemberships ?? []),
    survivalPressures: [],
    causalEvidence: publicEvidence,
    pendingRevelations: (state.pendingRevelations ?? []).filter((item) => item.public),
    endingCandidate: null,
    characterJournal: [],
    retrievalKeywords: [],
    // 命运偏离：已写回的（completed）随世界延续；铺垫中的（pending）随前世作废。
    pendingDivergences: [],
    completedDivergences: clone(state.completedDivergences ?? []),
    // 涌现故事：已爆发的故事已化作世界时间线上的事件与事实（随 world 延续）；
    // 尚在生长的故事随前世作废——动量属于前世之人的所作所为。
    emergentStories: [],
    // 同行者随前世作废：新来者不认识前世之人的队伍；
    // 谁曾与哪一世同行，记在世界档案的 provenance.companionSince 里。
    companions: [],
    companionsLog: [],
    // 身份进阶：前世未处理的转变卡与拒绝记录随前世作废。
    pendingRoleTransition: null,
    lastRefusedTransition: null,
    // 前世未收束的交锋一并作废(A3,2026-08-19):带着 activeClash 转世会让
    // 新一世「先写意图」(无解法)与「搏杀正酣」(拒意图)互斥,开局即死锁。
    activeClash: null,
    // 新一世是活人：前世已死的事实是「那一世」的属性，不随状态克隆带过来。
    playerDead: false,
    playerDeathCause: null,
    chapterSummary: state.publicWorldSummary ?? world.summary ?? "",
  };
  return { ...base, ...migrateGameplayState(base) };
}

// 具名行囊(拍板 2026-08-19:物品=具名清单,非数值池):回合结算里叙事声明
// 物品易手才动这里。gain 按 itemId/名去重入囊(目录物品以目录名为准),
// lose 按 itemId/名移除;上限 24 件——满了再 gain 的新物直接忽略。
// sanitize 已保证形状,这里只做语义结算。
export function applyInventoryPatch(state, patch) {
  const changes = patch?.changes;
  if (!Array.isArray(changes) || !changes.length) return state;
  const player = state.player ?? {};
  const inventory = Array.isArray(player.inventory) ? [...player.inventory] : [];
  for (const change of changes) {
    if (!change || typeof change !== "object") continue;
    if (change.action === "gain") {
      // 满员只跳过这一条 gain——同一补丁里后面的 lose(用掉/丢失)仍要结算。
      if (inventory.length >= 24 || !change.name) continue;
      const existing = change.itemId
        ? inventory.find((item) => item.id === change.itemId)
        : inventory.find((item) => item.name === change.name);
      if (existing) continue;
      inventory.push({
        id: change.itemId ?? `item:${change.name}`,
        name: change.name,
        note: change.note ?? "",
        obtainedTurn: state.turn ?? 0,
        source: change.itemId ? "catalog" : "emergent",
      });
    } else if (change.action === "lose") {
      const index = change.itemId
        ? inventory.findIndex((item) => item.id === change.itemId)
        : inventory.findIndex((item) => item.name === change.name);
      if (index >= 0) inventory.splice(index, 1);
    }
  }
  return { ...state, player: { ...player, inventory } };
}

// 技能习得(拍板 2026-08-19:习得制):一句「能做什么」累积进 learnedAbilities,
// 与身份能力镜像(player.abilities)分家——换身份只换身份带,习得的跟着人走。
// 去重(习得内 + 与身份能力重合的一律跳过,能力块里不出现重复行)、总量 cap 12;
// sanitize 已截每回合至多 2 条。
export function applyLearnedAbilities(state, learned) {
  if (!Array.isArray(learned) || !learned.length) return state;
  const player = state.player ?? {};
  const identity = Array.isArray(player.abilities) ? player.abilities : [];
  const existing = Array.isArray(player.learnedAbilities)
    ? [...player.learnedAbilities]
    : [];
  for (const text of learned) {
    const trimmed = String(text ?? "").trim();
    if (!trimmed || existing.includes(trimmed) || identity.includes(trimmed)) continue;
    if (existing.length >= 12) break;
    existing.push(trimmed);
  }
  return { ...state, player: { ...player, learnedAbilities: existing } };
}

// 境界突破(拍板 2026-08-19:独立于身份进阶):目标必须在原著阶梯里且高于当前阶,
// 换掉 traitIds 里的境界阶并记入 realmHistory。越阶/降阶/未知 id 一律拒绝
// (静默返回原状态——叙事已演出突破而补丁被拒时,下一回合模型通常会重提)。
export function applyRealmBreakthrough(state, breakthrough, world) {
  if (!breakthrough || typeof breakthrough !== "object") return state;
  const ladder = realmTraitsOf(world);
  if (!ladder.length) return state;
  const target = ladder.find((trait) => trait.id === breakthrough.toTraitId);
  if (!target) return state;
  const realmIds = new Set(ladder.map((trait) => trait.id));
  const player = state.player ?? {};
  const traitIds = Array.isArray(player.traitIds) ? [...player.traitIds] : [];
  const currentRealmId = traitIds.find((id) => realmIds.has(id));
  const targetRank = ladder.findIndex((trait) => trait.id === target.id);
  const currentRank = currentRealmId
    ? ladder.findIndex((trait) => trait.id === currentRealmId)
    : -1;
  if (targetRank <= currentRank) return state;
  const nextTraitIds = [
    target.id,
    ...traitIds.filter((id) => id !== target.id && !realmIds.has(id)),
  ];
  const realmHistory = [
    ...(Array.isArray(player.realmHistory) ? player.realmHistory : []),
    {
      toTraitId: target.id,
      name: target.name,
      turn: state.turn ?? 0,
      note: String(breakthrough.note ?? "").slice(0, 40),
    },
  ];
  return { ...state, player: { ...player, traitIds: nextTraitIds, realmHistory } };
}

// 身份进阶结算：accept 换身份（履历/一次性修正/势力/世界事实），
// 拒绝则路径永闭并付出烧制时声明的拒绝代价。pending 为空时零拷贝返回。
// world 必须是规范化后的世界对象：转变事实会直接写进 world.facts。
export function applyRoleTransition(state, world, accept) {
  const pending = state.pendingRoleTransition;
  if (!pending) return state;
  const next = clone(state);
  next.pendingRoleTransition = null;
  const path = world.roleProgression?.find((item) => item.id === pending.progressionId);
  const player = next.player ?? {};
  next.player = player;
  // 接纳或拒绝，路径都只走一次。
  player.usedProgressionIds = [
    ...new Set([...(player.usedProgressionIds ?? []), pending.progressionId]),
  ];
  if (accept) {
    const toRole = world.roleTemplates?.find((item) => item.id === pending.toRoleId);
    if (!toRole) {
      // 目录已变（重烧删掉了目标身份）：路径照常关闭，但身份不动。
      next.characterJournal = buildCharacterJournal(next);
      return next;
    }
    const trigger = path?.triggerEvents?.find((item) => item.id === pending.triggerEventId);
    player.roleId = toRole.id;
    player.roleName = toRole.name;
    player.roleHistory = [
      ...(player.roleHistory ?? []),
      {
        roleId: toRole.id,
        roleName: toRole.name,
        sinceTurn: next.turn,
        reason: trigger?.description ?? trigger?.name ?? "机缘",
      },
    ];
    // 世界已过 normalizeWorld 此处必为数组;再兜一层,避免异常存档里出现非数组形状。
    for (const modifier of Array.isArray(path?.modifiers) ? path.modifiers : []) {
      const current = next.attributes?.[modifier.attributeId];
      if (!Number.isFinite(current) || !Number.isFinite(modifier.delta)) continue;
      next.attributes[modifier.attributeId] = Math.max(0, Math.min(100, current + modifier.delta));
    }
    // 新身份唯一绑定势力时自动切换；多个或不绑定时保留玩家当前出身。
    if (toRole.factionIds?.length === 1) {
      player.factionId = toRole.factionIds[0];
    }
    // 身份变了,能力立刻跟着变:abilities/traitIds/职权同步到新身份。
    // 数值不在此处应用——进阶数值走路径 modifiers(已在上方结算)。
    applyRoleIdentity(next, toRole, world);
    // 转变写进世界事实：后世传闻与检索都能看到这一步。
    world.facts.push({
      id: `role-transition-${pending.progressionId}-${next.turn}`,
      text:
        "第" + next.turn + "回合，" + player.name + "自「" + pending.fromRoleName + "」转为「" + toRole.name + "」" +
        (trigger?.description ? "，起因：" + trigger.description : "") + "。",
      chapterAnchor: next.unlockedChapter ?? 1,
      source: "role_transition",
    });
  } else {
    player.refusedProgressionIds = [
      ...new Set([...(player.refusedProgressionIds ?? []), pending.progressionId]),
    ];
    for (const modifier of path?.refusalModifiers ?? []) {
      const current = next.attributes?.[modifier.attributeId];
      if (!Number.isFinite(current) || !Number.isFinite(modifier.delta)) continue;
      next.attributes[modifier.attributeId] = Math.max(0, Math.min(100, current + modifier.delta));
    }
    // 代价的具体叙事交给下一回合：context.refusedTransition 一次性注入。
    next.lastRefusedTransition = {
      progressionId: pending.progressionId,
      turn: next.turn,
      toRoleName:
        world.roleTemplates?.find((item) => item.id === pending.toRoleId)?.name ??
        pending.toRoleId,
    };
  }
  next.characterJournal = buildCharacterJournal(next);
  return next;
}

// —— 命运偏离：多回合铺垫 → 火候判定 → 写回/反噬 ——
// 原著 timeline/facts/entityStates 的既定命运只读保留作对照基线，偏离成功生成
// 「当前覆盖事实」，跨转世写回 world.facts，让下一世面对「被上一世改过的世界」。
export const DIVERGENCE_THRESHOLD = 2;
// 命运锚点分级(拍板 2026-08-17:核心命运极难撬动,地方小事一蹴而就):
// core=主线命运(主角结局/主线势力存亡/全局大战),side=重要支线人物与地方势力,
// local=地方性小事。阈值是发动最终改写所需的势能;旧书无 tier 一律回落 side。
export const DIVERGENCE_TIERS = Object.freeze({ core: 4, side: 2, local: 1 });

export function divergenceThreshold(world, targetType, targetId) {
  if (targetType === "timeline") {
    const event = (world?.timeline ?? []).find((item) => item.id === targetId);
    return DIVERGENCE_TIERS[event?.tier] ?? DIVERGENCE_TIERS.side;
  }
  return DIVERGENCE_TIERS.side;
}

// 改命硬门槛（选项路径与结算路径共用同一道门）：
//   - 目标必须存在（timeline/fact 在世界档案里、entity 已发现且未死）；
//   - 已定命运不可改（resolved/invalidated 的 timeline 事件、已死 entity）；
//   - fire=true 的最终改写必须势能攒够分级阈值。
// 返回 { ok, reason }，reason ∈ "" | "missing_target" | "settled_fate" | "not_ready"。
export function divergenceTargetGate(world, state, { targetId, targetType, fire } = {}) {
  if (!targetId || !targetType) return { ok: false, reason: "missing_target" };
  if (targetType === "timeline") {
    const event = (world?.timeline ?? []).find((item) => item.id === targetId);
    if (!event) return { ok: false, reason: "missing_target" };
    const status = state.eventStates?.[targetId]?.status ?? "scheduled";
    if (status !== "scheduled" && status !== "delivered") return { ok: false, reason: "settled_fate" };
  } else if (targetType === "fact") {
    if (!(world?.facts ?? []).some((item) => item.id === targetId)) {
      return { ok: false, reason: "missing_target" };
    }
  } else if (targetType === "entity") {
    if (!state.discoveredCharacterIds?.includes(targetId)) {
      return { ok: false, reason: "missing_target" };
    }
    if (state.entityStates?.[targetId]?.status === "dead") {
      return { ok: false, reason: "settled_fate" };
    }
  } else {
    return { ok: false, reason: "missing_target" };
  }
  if (fire) {
    const threshold = divergenceThreshold(world, targetType, targetId);
    const pending = (state.pendingDivergences ?? []).find(
      (item) => item.targetId === targetId && item.targetType === targetType,
    );
    if (!pending || pending.momentum < threshold) return { ok: false, reason: "not_ready" };
  }
  return { ok: true, reason: "" };
}

function matchingDivergence(item, targetId, targetType) {
  return item.targetId === targetId && item.targetType === targetType;
}

function upsertDivergence(items, next) {
  const index = items.findIndex((item) => item.id === next.id);
  if (index < 0) return [...items, next];
  const copy = [...items];
  copy[index] = next;
  return copy;
}

function targetLabel(targetType, targetId, world) {
  if (targetType === "fact") {
    return world.facts.find((f) => f.id === targetId)?.text ?? targetId;
  }
  if (targetType === "timeline") {
    return world.timeline.find((e) => e.id === targetId)?.text ?? targetId;
  }
  if (targetType === "entity") {
    return world.characters.find((c) => c.id === targetId)?.name ?? targetId;
  }
  return targetId;
}

function buildOverrides(targetType, targetId, divergencePatch, state, world) {
  const text =
    divergencePatch?.override?.text ??
    divergencePatch?.overrideText ??
    `命运被改写：${targetLabel(targetType, targetId, world)}不再照原样发生。`;
  return [
    {
      id: `div-override:${targetType}:${targetId}:${state.turn}`,
      overridesId: targetId,
      targetType,
      text,
      evidence: String(divergencePatch?.evidence ?? ""),
      chapterAnchor: state.unlockedChapter ?? 1,
    },
  ];
}

// 纯函数：根据本回合所选行动与判定推进/收尾一条命运偏离。
//   - 铺垫（fire 缺省/为 false）：成功势能 +1，失败势能归零（安全，无代价）。
//   - 火候判定（fire 为 true）：成功写回完成偏离；失败反噬（压入生存压力）。
// 偏离只能由玩家所选选项的改命声明驱动：divergencePatch 只是模型对该声明的
// 回声（补写 override 文本与因果凭据），选项未声明改命时补丁整体忽略，模型
// 不能自起炉灶改命运。选项与补丁指向不同目标时同样丢弃补丁，防止张冠李戴。
// 结算前重过 divergenceTargetGate 硬门槛：目标已定/势能不足的「发动」不会
// 写回——势能不足降级为铺垫，目标已定则本回合无改命结果。
// 返回 { state, result }，不改动入参。
export function applyDivergence(state, world, { option, check, divergencePatch } = {}) {
  const optionDecl = option?.divergence;
  // 偏离只能由玩家所选选项的改命声明驱动:选项没声明改命时,补丁是模型自起的
  // 炉灶,整体忽略——「改命必须由玩家铺垫攒势能驱动」的承诺在补丁路径同样成立。
  if (!optionDecl?.targetId || !optionDecl?.targetType) return { state, result: null };
  let patch = divergencePatch;
  if (
    patch &&
    ((patch.targetId !== undefined && patch.targetId !== optionDecl.targetId) ||
      (patch.targetType !== undefined && patch.targetType !== optionDecl.targetType))
  ) {
    // 目标错配防护：补丁明写了一个不同于选项声明的目标时,它描述的是另一个命运,
    // 不能拿来改写选项指向的目标——补丁整体丢弃,override 用目标称呼兜底。
    // 补丁不带目标字段时视为纯文本回声(只提供 override 文本与凭据),不算错配。
    patch = undefined;
  }
  const declared = optionDecl;
  if (!declared?.targetId || !declared?.targetType) return { state, result: null };
  const { targetId, targetType } = declared;
  let fire = Boolean(declared.fire);
  const gate = divergenceTargetGate(world, state, { targetId, targetType, fire });
  if (!gate.ok) {
    if (gate.reason === "not_ready") {
      fire = false;
    } else {
      return { state, result: null };
    }
  }
  const next = clone(state);
  const existing = next.pendingDivergences.find((item) =>
    matchingDivergence(item, targetId, targetType),
  );
  const pending = existing ?? {
    id: `divergence:${targetType}:${targetId}`,
    targetId,
    targetType,
    momentum: 0,
    source: "player",
  };
  const success = check?.result === "success" || check?.result === "critical_success";
  const failure = check?.result === "failure" || check?.result === "critical_failure";

  if (!fire) {
    // 爽文拍板「改命机会更多」:成功铺垫一次 +2(阈值 2 不变⇒一次成功即够火候),
    // 原味 +1;失败仍归零。归零不是数值惩罚的口吻——result.fateResistance 标记
    // 让叙事以「天命难违、命运反弹」落笔,而不是主角无能。
    pending.momentum = success ? pending.momentum + (isPowerMode(state) ? 2 : 1) : 0;
    next.pendingDivergences = upsertDivergence(next.pendingDivergences, pending);
    return {
      state: next,
      result: {
        id: pending.id,
        stage: "seeded",
        momentum: pending.momentum,
        target: targetLabel(targetType, targetId, world),
        fateResistance: failure || undefined,
      },
    };
  }

  if (!success && !failure) {
    next.pendingDivergences = upsertDivergence(next.pendingDivergences, pending);
    return {
      state: next,
      result: {
        id: pending.id,
        stage: "pending",
        momentum: pending.momentum,
        target: targetLabel(targetType, targetId, world),
      },
    };
  }

  if (success) {
    const completed = {
      id: `divergence:${targetType}:${targetId}:${next.turn}`,
      targetId,
      targetType,
      overrides: buildOverrides(targetType, targetId, patch, next, world),
      source: "player_divergence",
      lifeIndex: next.player?.lifeIndex ?? 1,
      resolvedTurn: next.turn,
    };
    next.pendingDivergences = next.pendingDivergences.filter(
      (item) => !matchingDivergence(item, targetId, targetType),
    );
    // 惰性重验(拍板 2026-08-17):成功改掉 timeline 事件后把它置为 invalidated——
    // 它自身的 factsToAdd/factsToInvalidate 不再生效(effectiveFacts 只结算
    // delivered/resolved),依赖它 prerequisites 的下游事件也因前置永不 resolved 而
    // 自动停摆;原文之河与终卷判定(foldableEnding)都把 invalidated 视为已落下。
    if (targetType === "timeline") {
      next.eventStates ??= {};
      next.eventStates[targetId] = {
        status: "invalidated",
        invalidatedTurn: next.turn,
        diverged: true,
      };
    }
    // 只留最近 40 条：超长一生会积累成百上千条偏离，全量随存档膨胀；
    // 转世时已持久化为世界事实，本世内存态截断不影响已改写的持久结果。
    next.completedDivergences = [...(next.completedDivergences ?? []), completed].slice(-40);
    return {
      state: next,
      result: {
        id: completed.id,
        stage: "resolved",
        target: targetLabel(targetType, targetId, world),
        overrides: completed.overrides,
      },
    };
  }

  // 失败反噬：目标警觉 / 势力反扑，压入生存压力，势能清零。
  // 同一目标的反噬只保留最新一条（按 id 前缀去重）：反复失败不叠加新条目，
  // 否则 survivalPressures 随失败次数无限膨胀。
  const backlashIdPrefix = `divergence-backlash:${targetId}:`;
  const otherPressures = (next.survivalPressures ?? []).filter(
    (pressure) => !pressure.id?.startsWith(backlashIdPrefix),
  );
  const backlash = {
    id: `${backlashIdPrefix}${next.turn}`,
    name: "改命反噬",
    stage: "warning",
    warningObserved: true,
    responseOpportunityOffered: true,
    reversible: true,
    advanceConditions: [],
    reliefConditions: [],
    signs: [`试图改变「${targetLabel(targetType, targetId, world)}」的命运失败，反噬随之而来`],
    publicSign: "你感到那股被拨动的命运正在回弹",
  };
  next.survivalPressures = [...otherPressures, backlash];
  next.pendingDivergences = next.pendingDivergences.filter(
    (item) => !matchingDivergence(item, targetId, targetType),
  );
  return {
    state: next,
    result: { id: pending.id, stage: "backlash", target: targetLabel(targetType, targetId, world) },
  };
}

// 命运种子（拍板 2026-08-17：铺垫中的改命要看得见火候）：
// pendingDivergences 的势能与阈值翻成界面可读的一行，最多两条，防刷屏。
// 目标称呼不做章节遮蔽——能铺垫的命运，玩家在选项里早已见过它的名字。
export function fateSeedsView(state, world, limit = 2) {
  return (state?.pendingDivergences ?? [])
    .map((item) => ({
      target: targetLabel(item.targetType, item.targetId, world),
      momentum: Number(item.momentum) || 0,
      threshold: divergenceThreshold(world, item.targetType, item.targetId),
    }))
    .filter((item) => item.threshold > 0)
    .slice(0, limit);
}

// 把已写回的偏离压平为可追加进 world.facts 的事实（转世时持久化，带出处标记）。
export function divergenceWorldFacts(state) {
  return (state.completedDivergences ?? []).flatMap((divergence) =>
    (divergence.overrides ?? []).map((override) => ({
      id: override.id,
      text: override.text,
      chapterAnchor: override.chapterAnchor ?? 1,
      source: "player_divergence",
      lifeIndex: divergence.lifeIndex ?? null,
    })),
  );
}

// 原著基线 + 当前覆盖的合并视图：偏离过的 fact 用覆盖文本，未偏离的照旧。
// 时间线事件的事实变化：已交付/已解决(delivered/resolved)的事件按声明
// 新增(factsToAdd)与失效(factsToInvalidate)事实——切入章之前的 backstory 事件
// 开局即交付,所以「原文已发生的事」从第一回合起就是世界现状。
// 被 invalidated 的事件不算发生,其事实变化不应用。
// 原著 facts 数组不被修改，反剧透（chapterAnchor 过滤）由调用方照常生效。
const EVENT_FACT_STATUSES = new Set(["delivered", "resolved"]);

export function effectiveFacts(world, state) {
  const overrides = new Map(
    (state.completedDivergences ?? [])
      .flatMap((divergence) => divergence.overrides ?? [])
      .map((override) => [override.overridesId, override]),
  );
  const invalidated = new Set();
  const added = [];
  for (const event of world.timeline ?? []) {
    if (!EVENT_FACT_STATUSES.has(state.eventStates?.[event.id]?.status)) continue;
    for (const id of event.factsToInvalidate ?? []) invalidated.add(id);
    for (const fact of event.factsToAdd ?? []) {
      if (!fact?.id || !fact.text) continue;
      added.push({ id: fact.id, text: fact.text, chapterAnchor: fact.chapterAnchor ?? 1, source: "canon_event" });
    }
  }
  const base = world.facts
    .filter((fact) => !invalidated.has(fact.id))
    .map((fact) => {
      const override = overrides.get(fact.id);
      return override ? { ...fact, text: override.text, overridden: true } : fact;
    });
  // 事件新增事实在基线之后:同 id 不重复(净化层已保证),检索与事实表都能看到。
  return [...base, ...added];
}
