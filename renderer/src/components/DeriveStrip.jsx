import { useEffect, useState } from "react";
import { phaseCopy } from "../lib/engine-display.js";

/* 推演条（拍板 2026-08-22 简约版）：不铺算式不铺卦，文字直接落在稿面
   上——相位文案＋跳点＋秒表＋已落墨字数，等待感交给真实增长的数字。
   mode: simple=意图推演，deep=回合推演（45 秒后给「停一下」）。 */
export default function DeriveStrip({ mode = "simple", phases = [], inkedChars = 0, onStop }) {
  const [elapsed, setElapsed] = useState(0);
  const [over45s, setOver45s] = useState(false);

  // 秒表属信息呈现，减动效下照常走。
  useEffect(() => {
    const timer = setInterval(() => setElapsed((seconds) => seconds + 1), 1_000);
    return () => clearInterval(timer);
  }, []);

  /* 深推演：45 秒后给「停一下」 */
  useEffect(() => {
    if (mode !== "deep") return;
    const timer = setTimeout(() => setOver45s(true), 45_000);
    return () => clearTimeout(timer);
  }, [mode]);

  // 关键回合是回合属性而非阶段：相位流里出现过就一直亮着，不随后续阶段被顶掉。
  const isKeyTurn = phases.includes("key-turn");

  return (
    <p className="derive-strip ds-status" aria-live="polite">
      {isKeyTurn && <span className="ds-key">关键回合 · </span>}
      {phaseCopy(phases[phases.length - 1])}
      <span className="dots"> …</span>
      <span className="ds-progress mono">
        {elapsed}s{inkedChars > 0 ? ` · 已落墨 ${inkedChars} 字` : ""}
      </span>
      {mode === "deep" && over45s && onStop && (
        <button type="button" className="ghost-btn ds-stop" onClick={onStop}>
          停一下
        </button>
      )}
    </p>
  );
}
