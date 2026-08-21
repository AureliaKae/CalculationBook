// 引擎展示适配：renderer 侧自持的纯展示逻辑（不把引擎模块链拖进浏览器包）。

// 与 src/evolution.js realmTraitsOf 同一套判定：境界阶梯特质过滤。
const REALM_TRAIT_PATTERN =
  /境界|阶梯|修为|等级|品阶|阶位|段位|道行|斗气|魂力|星阶|内力|武功|化神|元婴|金丹|筑基|练气|炼气|结丹|炼虚|合体|大乘|渡劫|飞升/;
const REALM_NAME_SUFFIX_PATTERN = /(?:期|境|阶|级|段|重)$/;

export function realmTraitsOf(world) {
  return (world?.traits ?? []).filter((trait) => {
    const name = String(trait.name ?? "");
    const description = String(trait.description ?? "");
    return (
      REALM_TRAIT_PATTERN.test(`${name}${description}`) ||
      REALM_NAME_SUFFIX_PATTERN.test(name)
    );
  });
}

// （BAKE_STAGE_LABEL 的 renderer 副本已删——Fiction 重写遗留的复制件，
// 活表在 src/bake-progress.js；清理轮 2026-08-21。）

export function bakePercent(progress) {
  if (!progress) return 0;
  const ratio = progress.total ? progress.current / progress.total : 0;
  switch (progress.stage) {
    case "model-reference":
      return Math.min(4, 1 + ratio * 3);
    case "style":
      return 10;
    case "coarse":
      return ratio * 70;
    case "detail":
      return 85;
    case "merge":
      return 86;
    case "repair":
      return 88 + ratio * 8;
    case "complete":
      return 100;
    default:
      return 0;
  }
}

// 演算相位 → 页缘状态行文案（分层：过程抽象，不泄露推理）。
export function phaseCopy(phase) {
  switch (phase) {
    case "opening":
      return "循意起笔";
    // 反向建角（拍板 2026-08-20）：进建角页即拟三套候选的等待相位。
    case "proposals":
      return "依愿拟稿";
    case "directing":
      return "循意起笔";
    // 关键回合（交锋收束/濒死一搏/弧线关键节拍）的叙事酝酿：强模型全笔，
    // 等待远长于普通回合；前缀「关键回合」由 DeriveStrip 另加。
    case "key-turn":
      return "慎思落笔";
    case "narrative-done":
    case "structure":
    case "options-check":
      return "推演诸解";
    case "epilogue":
    case "rewriting":
    case "repair":
    case "observing":
      return "掷骰无回";
    default:
      return "推演中";
  }
}
