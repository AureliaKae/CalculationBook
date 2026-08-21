// 人物状态追踪（拍板 2026-08-20：连贯性修复——人物状态追踪）。
// 世界档案里的人物卡是静态正典，游玩几十回合后人物的处境、动向与关系早已
// 漂移，而模型只看得到静态卡 + 行踪表——「人物漂移」由此而来。本模块让快模型
// 周期性把「静态人物卡 + 近期演出（叙事与结构结算）」压缩成每人一条此刻状态
// 笔记，写进独立动态状态账（state.entityStateNotes），注入人物条目的
// currentState。只记动态、不回写世界档案：正典不动，漂移有账。

import { submitEntityStatesTool } from "./structured-tools.js";

// 每次记账覆盖的人物上限：只记「此刻相关」的人（在场 + 近期互动对象），
// 全量人物记账既贵又稀释注意力。
const MAX_TRACKED = 8;
const NOTE_MAX_CHARS = 60;

function cleanNote(value) {
  return String(value ?? "")
    .replace(/[\u0000-\u001f\u007f]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, NOTE_MAX_CHARS);
}

export class EntityStateTracker {
  constructor({ completeJson, interval = 5 } = {}) {
    if (typeof completeJson !== "function") {
      throw new Error("EntityStateTracker 需要 completeJson（快模型结构化调用）");
    }
    this.completeJson = completeJson;
    this.interval = Math.max(1, Number(interval) || 5);
  }

  // 候选人物：在场（entityStates 行踪与玩家同地）优先，其次是最近两回合
  // 行动指向的人物——状态漂移伤害最大的是「正在戏里」的人。
  candidates(world, state, history = []) {
    const present = [];
    const targeted = new Set();
    for (const turn of history.slice(-2)) {
      if (turn.choice?.target?.type === "character" && turn.choice.target.id) {
        targeted.add(turn.choice.target.id);
      }
    }
    const ranked = [];
    for (const character of world.characters ?? []) {
      const entity = state.entityStates?.[character.id];
      if (entity?.status === "dead" && !targeted.has(character.id)) continue;
      const onScreen = entity?.locationId === state.locationId;
      if (onScreen || targeted.has(character.id)) ranked.push({ character, onScreen });
    }
    ranked.sort((left, right) => Number(right.onScreen) - Number(left.onScreen));
    return ranked.slice(0, MAX_TRACKED).map((item) => item.character);
  }

  // 返回 { notes: { [characterId]: { note, turn } } }；无候选或模型失败由
  // 调用方兜底（引擎侧 catch 静默，下个周期再记）。
  async update({ world, state, history = [] }) {
    const candidates = this.candidates(world, state, history);
    if (!candidates.length) return { notes: {} };
    const priorNotes = state.entityStateNotes ?? {};
    const payload = candidates.map((character) => {
      const entity = state.entityStates?.[character.id] ?? {};
      const locationName =
        (world.locations ?? []).find((location) => location.id === entity.locationId)?.name ?? null;
      const persona = character.persona && typeof character.persona === "object"
        ? {
            temperament: cleanNote(character.persona.temperament ?? "") || undefined,
            manner: cleanNote(character.persona.manner ?? "") || undefined,
          }
        : undefined;
      return {
        characterId: character.id,
        name: character.name,
        summary: cleanNote(character.summary).slice(0, 80),
        ...(persona && (persona.temperament || persona.manner) ? { persona } : {}),
        status: entity.status ?? "active",
        locationName,
        priorNote: cleanNote(priorNotes[character.id]?.note ?? ""),
      };
    });
    const recent = history.slice(-this.interval).map((turn) => ({
      number: turn.number,
      choice: cleanNote(turn.choice?.text).slice(0, 60),
      narrative: String(turn.narrative ?? "").replace(/\s+/g, " ").slice(0, 160),
    }));
    const result = await this.completeJson(
      [
        {
          role: "system",
          content:
            "你是文字生存小说的人物状态记账员。根据人物档案与最近回合的演出，为清单里每个人物写一条「此刻状态笔记」：处境、动向、与玩家相关的最近变化（信任、敌意、约定、伤势之类）。只返回 JSON。规则：只依据输入里的事实，不得编造档案与演出之外的事；没有新变化时沿用 priorNote 的要点；笔记 ≤50 字、一句连贯中文。",
        },
        { role: "user", content: JSON.stringify({ characters: payload, recentTurns: recent }) },
      ],
      { tool: submitEntityStatesTool() },
    );
    const notes = {};
    const known = new Set(payload.map((item) => item.characterId));
    for (const item of Array.isArray(result?.states) ? result.states : []) {
      if (!item || typeof item !== "object") continue;
      const characterId = String(item.characterId ?? "");
      if (!known.has(characterId)) continue;
      const note = cleanNote(item.note);
      if (note.length < 4) continue;
      notes[characterId] = { note, turn: state.turn };
    }
    return { notes };
  }
}
