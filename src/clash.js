// 交锋机制：dire 的搏杀不再一击定音，而是展开成几步有决策点的对峙。
// 原则：存数值、显标签——对手状态只有文字标签，玩家伤势由真实 vital 数值映射。

const CLASH_MAX_STEPS = 4;
export const CLASH_CONDITIONS = ["无伤", "轻伤", "重伤", "强弩之末"];

// 按 vital 数值比例映射成文字标签（vitals 里取最差的一个）。
export function playerClashCondition(state, world) {
  const vitals = (world.stats ?? []).filter((stat) => stat.role === "vital");
  if (!vitals.length) return "无伤";
  let worst = 1;
  for (const stat of vitals) {
    const max = stat.max;
    if (!Number.isFinite(max) || max <= 0) continue;
    const value = state.stats?.[stat.id];
    if (!Number.isFinite(value)) continue;
    worst = Math.min(worst, value / max);
  }
  return conditionLabel(worst);
}

export function conditionLabel(ratio) {
  if (ratio >= 1) return "无伤";
  if (ratio > 0.6) return "轻伤";
  if (ratio > 0.3) return "重伤";
  if (ratio > 0) return "强弩之末";
  return "命悬一线";
}

export function stanceLabel(stance) {
  if (stance > 0) return "上风";
  if (stance < 0) return "下风";
  return "均势";
}

// 建立交锋。对手必须是世界里的真实人物，调用方负责校验可行性。
export function beginClash(state, { opponentId, opponentName, origin, reason = "" }, world) {
  const opponent = world.characters.find((character) => character.id === opponentId);
  if (!opponent) throw new Error(`Unknown clash opponent: ${opponentId}`);
  return {
    ...state,
    activeClash: {
      opponentId,
      opponentName: opponentName ?? opponent.name,
      opponentCondition: 0,
      stance: 0,
      step: 0,
      maxSteps: CLASH_MAX_STEPS,
      origin,
      reason,
      pendingDeath: false,
    },
  };
}

// AI 提议的被动掀桌：对手必须存活、且玩家已发现或与其同处一地。
export function validateClashStart(state, proposal, world) {
  if (!proposal || typeof proposal.opponentId !== "string") return false;
  if (state.activeClash) return false;
  const opponent = world.characters.find((character) => character.id === proposal.opponentId);
  if (!opponent) return false;
  const entity = state.entityStates?.[opponent.id];
  if (entity?.status === "dead") return false;
  const discovered = (state.discoveredCharacterIds ?? []).includes(opponent.id);
  const here = (opponent.locationIds ?? []).includes(state.locationId);
  if (!discovered && !here) return false;
  return true;
}

// 交锋中的一步结算。返回 { state, ended, endReason }。
// endReason: "victory" | "retreat" | "mercy" | "escape" | "exhausted" | "death"
// （escape=濒死窗口里搏回一命脱身，mercy=求饶成功）
export function advanceClash({ state, option, check, world }) {
  const clash = state.activeClash;
  if (!clash) return { state, ended: false };
  const next = { ...state, activeClash: { ...clash } };
  const active = next.activeClash;
  const success = check.result === "success" || check.result === "critical_success";
  const retreating = option.axis === "exit" || option.approach === "avoid";
  // 交锋中 cooperate 的语义就是求饶/讲和：成功收手，失败失一步。
  const pleading = option.approach === "cooperate";

  // 濒死窗口：这一搏定生死。进入回合就被打趴时（step 0），先不判死，
  // 但必须把这一步宽限消耗掉：否则 step 永远停在 0，交锋既不死也不胜、永不收束。
  if (active.pendingDeath) {
    if (active.step === 0) {
      active.step = 1;
      return { state: next, ended: false };
    }
    if (success) {
      if (option.axis === "force" && option.approach !== "cooperate") {
        active.opponentCondition = Math.min(3, active.opponentCondition + 1);
        if (active.opponentCondition >= 3) {
          return { state: { ...next, activeClash: null }, ended: true, endReason: "victory" };
        }
      }
      return {
        state: { ...next, activeClash: null },
        ended: true,
        endReason: pleading ? "mercy" : "escape",
      };
    }
    return { state: { ...next, activeClash: null }, ended: true, endReason: "death" };
  }

  // 撤退与求饶：成功即离场，失败失一步。
  if (retreating || pleading) {
    active.step += 1;
    if (success) {
      return {
        state: { ...next, activeClash: null },
        ended: true,
        endReason: retreating ? "retreat" : "mercy",
      };
    }
    active.stance = Math.max(-3, active.stance - 1);
  } else {
    active.step += 1;
    if (success) {
      active.stance = Math.min(3, active.stance + 1);
      active.opponentCondition = Math.min(3, active.opponentCondition + 1);
    } else {
      active.stance = Math.max(-3, active.stance - 1);
    }
    if (active.opponentCondition >= 3) {
      return { state: { ...next, activeClash: null }, ended: true, endReason: "victory" };
    }
  }

  if (active.step >= active.maxSteps) {
    return { state: { ...next, activeClash: null }, ended: true, endReason: "exhausted" };
  }
  return { state: next, ended: false };
}

// vital 归零时交锋进入濒死窗口，而不是当场判死：最后一搏的窗口就是回应机会。
// 窗口可逆：已置位后若 vital 被拉回下限之上（中途治疗），濒死解除——否则标记
// 永不清除，机制上的「一步之遥死亡」与真实伤势/叙事口径从此分道扬镳。
export function markPendingDeath(state, world) {
  const clash = state.activeClash;
  if (!clash) return state;
  const vitals = (world.stats ?? []).filter((stat) => stat.role === "vital");
  const down = vitals.some((stat) => (state.stats?.[stat.id] ?? stat.max) <= stat.min);
  if (down && !clash.pendingDeath) {
    return { ...state, activeClash: { ...clash, pendingDeath: true } };
  }
  if (!down && clash.pendingDeath) {
    return { ...state, activeClash: { ...clash, pendingDeath: false } };
  }
  return state;
}
