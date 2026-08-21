// 视图适配：引擎/桥返回的 view → 推演台 UI 结构。
// 对 consequences/journal 等形状保持防御式读取（引擎侧字段随版本演进）。

export function narrativeParagraphs(text) {
  return String(text ?? "")
    .split(/\n{2,}/)
    .map((p) => p.trim())
    .filter(Boolean);
}

function noteText(item) {
  if (item == null) return "";
  if (typeof item === "string") return item;
  return item.consequence ?? item.text ?? item.summary ?? item.title ?? "";
}

// 数值一律不显数字，用语言抒写：行内「+1 / -2 / ＋3」等量变改写为程度语。
// 只动「量词尾巴」，主体措辞原样保留（引擎文案 + mock 演示双轨适用）。
const DEGREE_UP = { 1: "添了一分" };
const DEGREE_DOWN = { 1: "减了一分" };
function degreeWord(sign, n) {
  if (sign > 0) return n === 1 ? DEGREE_UP[1] : "添了几分";
  return n === 1 ? DEGREE_DOWN[1] : "减了几分";
}
function verbalizeNumbers(text) {
  return String(text ?? "").replace(
    /([＋+\-−－])\s*(\d+)\s*$/u,
    (_all, signRaw, nRaw) => {
      const sign = /[＋+]/u.test(signRaw) ? 1 : -1;
      return "· " + degreeWord(sign, Number(nRaw));
    },
  );
}

export function notesFromTurn(turn, view) {
  const notes = [];
  for (const consequence of turn?.consequences ?? []) {
    const text = verbalizeNumbers(noteText(consequence));
    if (text) notes.push({ text, kind: consequence?.kind === "warn" ? "warn" : "world" });
  }
  // 世界见闻只取最近两三条（视图给的是全量已投递事件）
  const happenings = [...(view?.worldHappenings ?? [])]
    .filter((h) => h?.text && h.text !== "尚未揭晓")
    .slice(-2)
    .reverse();
  for (const happening of happenings) {
    const text = verbalizeNumbers(noteText(happening));
    if (text) notes.push({ text, kind: "growth" });
  }
  const emergent = turn?.emergent;
  if (emergent?.newStory) {
    notes.push({ text: `新故事生根：${emergent.newStory}`, kind: "growth" });
  }
  for (const name of emergent?.newCharacters ?? []) {
    notes.push({ text: `新人物入场：${name}`, kind: "growth" });
  }
  return notes.slice(0, 8);
}

export function epitaphLines(ending, pcName) {
  const lines = [];
  if (ending?.type === "death") {
    lines.push(`${ending.name ?? pcName ?? "无名者"}，殁于${ending.cause ?? "命数"}。`);
    lines.push(`历 ${ending.turns ?? "?"} 手而终。`);
    if (ending.legacy?.fact) lines.push(ending.legacy.fact);
    const ventures = ending.legacy?.ventures ?? [];
    if (ventures.length) lines.push(`已成气候：${ventures.join("、")}。`);
    const companions = ending.legacy?.companions ?? [];
    if (companions.length) lines.push(`同行过的人：${companions.join("、")}。`);
  } else {
    lines.push("这一阶段的选择结出了结果。");
    lines.push("未竟之事，仍在世界里生长。");
  }
  return lines;
}
