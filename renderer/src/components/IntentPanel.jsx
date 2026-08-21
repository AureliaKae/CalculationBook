import { useEffect, useRef, useState } from "react";

import Hint from "./Hint.jsx";
import FadeIn from "./FadeIn.jsx";

/* 意图面板（三层意图的界面出口，拍板 2026-08-19）：
   第一层「此刻意图」是稿面上的落笔回声，不在此重复；这里编辑另两层——
   此世之志（改写作废当前弧线，导演下回合围绕新志向重新谋篇）与
   当前谋算（只调叙事与解法的取势，弧线在节拍间隙自然吸收）。 */
export default function IntentPanel({ goal, scheme, onSetGoal, onSetScheme }) {
  const [editing, setEditing] = useState(null); // "goal" | "scheme" | null
  const [draft, setDraft] = useState("");
  const inputRef = useRef(null);

  useEffect(() => {
    if (editing) inputRef.current?.focus();
  }, [editing]);

  function begin(which, current) {
    setEditing(which);
    setDraft(current ?? "");
  }

  async function commit() {
    const which = editing;
    const text = draft.trim();
    setEditing(null);
    if (!text && which === "goal") return;
    // 谋算允许清空（引擎对空串本就存空）：写了的盘算随时可以收掉，
    // 占位文案回得来；此世之志保持必填。
    await (which === "goal" ? onSetGoal?.(text) : onSetScheme?.(text));
  }

  if (editing) {
    const isGoal = editing === "goal";
    return (
      <FadeIn
        as="section"
        className="intent-panel editing"
        aria-label={isGoal ? "改写此世之志" : "改写当前谋算"}
      >
        <p className="ip-label">{isGoal ? "此世之志" : "当前谋算"}</p>
        <input
          ref={inputRef}
          className="ip-input"
          type="text"
          value={draft}
          maxLength={isGoal ? 60 : 40}
          placeholder={isGoal ? "这一世想成什么事" : "中期的盘算"}
          aria-label={isGoal ? "此世之志" : "当前谋算"}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              void commit();
            }
            if (e.key === "Escape") setEditing(null);
          }}
        />
        <div className="ip-acts">
          <button type="button" className="fx-act" onClick={() => setEditing(null)}>
            作罢
          </button>
          <button type="button" className="fx-act" onClick={() => void commit()}>
            落定
          </button>
        </div>
      </FadeIn>
    );
  }

  return (
    <section className="intent-panel" aria-label="意图面板">
      <p className="ip-mark">
        意 图
        <Hint text="此世之志＝长线志向：改写作废当前这一卷的谋篇，引擎重新起卷。当前谋算＝近处盘算：改写只调眼下的取势，卷不废、弧线照走。" />
      </p>
      <button type="button" className="ip-row" onClick={() => begin("goal", goal)} title="改写此世之志">
        <span className="ip-name">此世之志</span>
        <span className="ip-value">{goal || "未定——点此写下这一世想成的事"}</span>
      </button>
      <button type="button" className="ip-row" onClick={() => begin("scheme", scheme)} title="改写当前谋算">
        <span className="ip-name">当前谋算</span>
        <span className="ip-value">{scheme || "未设——点此写下中期的盘算"}</span>
      </button>
    </section>
  );
}
