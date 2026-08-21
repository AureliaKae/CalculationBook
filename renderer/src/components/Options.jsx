import { useRef } from "react";
import { useGSAP } from "@gsap/react";
import gsap from "gsap";

import { REDUCED } from "../lib/motion.js";

/* 解法列表：白色行卡 + 描边圆号；引擎选项 {id, text, stakes}；选中行锁定。
   入场 = 绘本弹跳（Fiction 版 2026-08-21）：行卡弹性浮入，圆号徽章随后
   逐个 back.out(2) 弹出；phase 切换重挂载自然重放。 */
export default function Options({ options, chosenId, onChoose, disabled }) {
  const listRef = useRef(null);

  useGSAP(
    () => {
      if (REDUCED) return;
      gsap.fromTo(
        listRef.current.children,
        { autoAlpha: 0, y: 12, scale: 0.96 },
        { autoAlpha: 1, y: 0, scale: 1, duration: 0.4, ease: "back.out(1.5)", stagger: 0.06, clearProps: "transform" },
      );
      gsap.fromTo(
        listRef.current.querySelectorAll(".badge"),
        { scale: 0 },
        { scale: 1, duration: 0.34, ease: "back.out(2.2)", stagger: 0.06, delay: 0.12, clearProps: "scale" },
      );
    },
    { scope: listRef, dependencies: [] },
  );

  return (
    <div className="options" ref={listRef}>
      <p className="options-head">演算既毕 · 有解如左</p>
      {options.map((o, i) => {
        const chosen = chosenId === o.id;
        const faded = chosenId != null && !chosen;
        return (
          <button
            key={o.id}
            type="button"
            className={"opt" + (chosen ? " chosen" : "") + (faded ? " faded" : "")}
            onClick={() => (disabled ? undefined : onChoose(o))}
            aria-disabled={disabled ? true : undefined}
          >
            <span className="tick" aria-hidden="true" />
            <span className="badge">
              <svg viewBox="0 0 26 26" aria-hidden="true">
                <circle cx="13" cy="13" r="10.5" pathLength={1} />
              </svg>
              <span className="no">{i + 1}</span>
            </span>
            <span className="text">{o.text}</span>
            {o.stakes ? <span className="cand-note">{o.stakes}</span> : null}
            <span className="hint">按 {i + 1} 选取</span>
          </button>
        );
      })}
    </div>
  );
}
