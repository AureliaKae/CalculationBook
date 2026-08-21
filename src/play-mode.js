// 游玩模式(拍板 2026-08-17:爽文/原味模式与起点选择已全部移除,故事推演全靠
// 用户选项):新的一世一律纯规则。本文件保留的爽文常量与判定仅供旧爽文存档
// 读档时沿用原规则,新档永不可达;数值永不进提示词与界面。
//
//   playMode:      新档恒 "classic";旧档的 "power" 由 migrateState 原样保留。
//   startingPoint: 已移除,仅作旧档迁移字段,不再参与任何逻辑。

// 爽文判定偏差(仅旧档):隐藏骰子对玩家恒定有利(约等于难度下调一档的感知)。
export const POWER_ROLL_BIAS = 10;
// 爽文进阶门槛折算(仅旧档):身份进阶路径的数值前提按 50% 向下取整(势力前提不放松)。
export const POWER_PREREQ_SCALE = 0.5;

export function isPowerMode(state) {
  return state?.playMode === "power";
}

// 建角模式归一(拍板:模式已移除):一律 classic;显式传入 power 也不再接受,
// 建角界面已无模式可选,这里只兜底旧调用方。
export function normalizeModeProfile() {
  return { playMode: "classic" };
}

// 绝境转机(爽文拍板:几乎不死):死亡结算后调用,把致死结局改写为「死里逃生」。
//   压力致死 → 移除致命压力;交锋致死 → 引擎侧已收束交锋(濒死标记随交锋
//   一起消失,这里的清理只是防御性兜底);vital 属性恢复至下限之上;写入一次性
//   powerEscape 标记,转机经过与代价由下一回合叙事演出。非爽文或未死亡时
//   零拷贝原样返回。
export function resolvePowerEscape(state, death, world) {
  if (!death?.dead || state?.playMode !== "power") {
    return { state, death, escaped: false };
  }
  const next = structuredClone(state);
  if (death.pressureId) {
    next.survivalPressures = (next.survivalPressures ?? []).filter(
      (pressure) => pressure.id !== death.pressureId,
    );
  }
  if (next.activeClash?.pendingDeath) {
    next.activeClash = { ...next.activeClash, pendingDeath: false };
  }
  const vitals = (world?.stats ?? []).filter((stat) => stat.role === "vital");
  if (vitals.length) {
    const stats = { ...(next.stats ?? {}) };
    for (const stat of vitals) {
      const current = Number(stats[stat.id]);
      if (Number.isFinite(current) && current <= Number(stat.min)) {
        stats[stat.id] = Number(stat.min) + 1;
      }
    }
    next.stats = stats;
  }
  next.powerEscape = {
    turn: next.turn ?? 0,
    cause: death.cause ?? "",
    clearedTurn: (next.turn ?? 0) + 1,
  };
  return {
    state: next,
    death: { dead: false, escaped: true, cause: death.cause },
    escaped: true,
  };
}

// 卷宗「这一世」条目文案(拍板:模式已移除,新档卷宗不再写模式):仅供旧爽文
// 存档标注这一世沿用旧规则;非爽文档返回空串,调用方 buildCharacterJournal
// 只在 isPowerMode 时调用本函数。
export function playModeSummary(state) {
  if (state?.playMode !== "power") return "";
  return state.startingPoint === "ceiling" ? "爽文模式 · 天花板开局" : "爽文模式 · 从头修炼";
}
