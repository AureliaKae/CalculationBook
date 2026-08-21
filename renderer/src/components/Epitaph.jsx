import { useRef } from "react";
import { useGSAP } from "@gsap/react";
import gsap from "gsap";
import { REDUCED } from "../lib/motion.js";

/* 判词卡：终章仪式——朱红双圈印章弹落 + 楷判词逐行落定（Fiction 版：
   印章 back.out 带微旋弹入，替代旧描线生长）。
   death=「结」（另起一稿转世）；stage=「卷」（续写新阶段）。 */
export default function Epitaph({ seal = "结", kicker = "判词 · 此稿归档", lines, onRestart, restartLabel = "另起一稿", onContinue, continueLabel, onDesk }) {
  const ref = useRef(null);

  useGSAP(
    () => {
      if (REDUCED) return;
      gsap.fromTo(
        ref.current.querySelector(".grade"),
        { scale: 0, rotation: -14 },
        { scale: 1, rotation: 0, duration: 0.5, ease: "back.out(2.2)", delay: 0.25, clearProps: "scale,rotation" },
      );
      gsap.fromTo(
        ref.current.querySelectorAll(".ep-line"),
        { opacity: 0.1, y: 6 },
        { opacity: 1, y: 0, duration: 0.45, stagger: 0.3, delay: 0.85, ease: "back.out(1.4)", clearProps: "transform" },
      );
      gsap.fromTo(
        ref.current.querySelector(".ep-acts"),
        { opacity: 0, y: 10, scale: 0.95 },
        { opacity: 1, y: 0, scale: 1, duration: 0.45, delay: 0.85 + 0.3 * lines.length, ease: "back.out(1.6)", clearProps: "transform" },
      );
    },
    { scope: ref },
  );

  return (
    <div className="epitaph" ref={ref}>
      <div className="ep-frame">
        <div className="ep-head">
          <span className="grade">
            <svg viewBox="0 0 40 40" aria-hidden="true">
              <circle cx="20" cy="20" r="16" />
              <circle cx="20" cy="20" r="16" className="echo" transform="rotate(84 20 20)" />
            </svg>
            <span className="grade-char">{seal}</span>
          </span>
          <span className="verdict-text">{kicker}</span>
        </div>
        {lines.map((l, i) => (
          <p className="ep-line" key={i}>
            {l}
          </p>
        ))}
        <div className="ep-acts">
          {onRestart && (
            <button type="button" className="pen-submit" onClick={onRestart}>
              {restartLabel}
            </button>
          )}
          {onContinue && (
            <button type="button" className="ghost-btn" onClick={onContinue}>
              {continueLabel}
            </button>
          )}
          {onDesk && (
            <button type="button" className="ghost-btn" onClick={onDesk}>
              搁笔回案头
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
