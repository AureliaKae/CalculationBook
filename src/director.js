// 弧线导演(拍板:剧情层叠加):围绕玩家意图规划多回合剧情弧,隐藏执行、动态改写。
// 本模块只放纯逻辑——弧线的净化、推进、收束与漂移判定;LLM 调用(规划/漂移/回顾)
// 在 openai-client,提示词在 prompt.js。代码继续管判定/势能/终局/时间线,弧线只做
// 戏剧编排:节拍可以指向命运节点,但不碰骰子与势能。

// 每 8 回合做一次漂移检查:玩家用行动投票,导演得看得见。
export const ARC_DRIFT_INTERVAL = 8;
// 同一节拍滞留超过 3 回合仍未达成/落空,代码强制推进——弧线不能把故事拖死。
export const BEAT_STALL_LIMIT = 3;
// 弧线规划的目标回合数区间(净化时钳位,规划提示词同此口径)。
const ARC_MIN_TURNS = 5;
const ARC_MAX_TURNS = 10;

const BEAT_KINDS = ["setup", "obstacle", "turn", "resolution"];
// 转折与收束是真高潮:这两个节拍上的回合,叙事与选项都升强模型(拍板:节拍升级)。
const KEY_BEAT_KINDS = new Set(["turn", "resolution"]);

// 净化规划结果:模型给的节拍最多取 6 项、至少要 4 项,kind 落枚举、文本截长;
// 缺收束节拍补一条(此时可到 7 项),缺转折不补(有的弧线就是平推)。形状坏到
// 救不回来返回 null,引擎退回即兴。
export function sanitizeArc(plan, { turn }) {
  if (!plan || typeof plan !== "object" || Array.isArray(plan)) return null;
  const title = String(plan.title ?? "").replace(/\s+/g, " ").trim().slice(0, 12);
  const premise = String(plan.premise ?? "")
    .replace(/[\u0000-\u001f\u007f]/g, "")
    .trim()
    .slice(0, 80);
  const rawBeats = Array.isArray(plan.beats) ? plan.beats : [];
  const beats = [];
  for (const raw of rawBeats.slice(0, 6)) {
    if (!raw || typeof raw !== "object") continue;
    const kind = BEAT_KINDS.includes(raw.kind) ? raw.kind : "obstacle";
    const aim = String(raw.aim ?? "")
      .replace(/[\u0000-\u001f\u007f]/g, "")
      .trim()
      .slice(0, 60);
    if (!aim) continue;
    beats.push({ id: `beat-${beats.length + 1}`, kind, aim });
  }
  if (beats.length < 4) return null;
  if (!beats.some((beat) => beat.kind === "resolution")) {
    beats.push({ id: `beat-${beats.length + 1}`, kind: "resolution", aim: "这一卷的事了结,余波落定" });
  }
  const plannedTurns = Math.min(
    ARC_MAX_TURNS,
    Math.max(ARC_MIN_TURNS, Number.isFinite(plan.plannedTurns) ? Math.round(plan.plannedTurns) : beats.length + 2),
  );
  if (!title || !premise) return null;
  return {
    title,
    premise,
    beats,
    currentBeatIndex: 0,
    beatTurns: 0,
    startTurn: turn,
    plannedEndTurn: turn + plannedTurns,
  };
}

// 上下文公开投影(拍板:隐藏+回望):只给当前节拍与弧线走向,不给卷名/节拍名/
// 全节拍表——防剧透也防模型把弧线当剧本直写。isKey 供引擎判断升档。
export function arcBeatView(arc) {
  if (!arc || !Array.isArray(arc.beats) || !arc.beats.length) return null;
  const index = Math.min(arc.currentBeatIndex ?? 0, arc.beats.length - 1);
  const beat = arc.beats[index];
  return {
    kind: beat.kind,
    aim: beat.aim,
    arcAim: arc.premise,
    isKey: KEY_BEAT_KINDS.has(beat.kind),
    concluding: index === arc.beats.length - 1,
  };
}

// 「调整」型漂移(拍板:四触发器):不重规划,直接跳到收束节拍——
// 玩家绕开了中段障碍,故事就该认账,奔着了结去。
export function jumpToResolution(arc) {
  if (!arc) return arc;
  return { ...arc, currentBeatIndex: Math.max(0, arc.beats.length - 1), beatTurns: 0 };
}

// 漂移判定只认三个枚举;快模型说别的都当 keep(不动作保底)。
export function sanitizeDriftVerdict(value) {
  return value === "adjust" || value === "replace" ? value : "keep";
}

// 回顾兜底:快模型失败时由代码拼一句,回望卡不能空着。
export function fallbackRetrospective(arc) {
  return `${arc.premise.slice(0, 30)},这一卷就此翻过。`;
}
