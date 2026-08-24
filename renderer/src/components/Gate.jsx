import { useRef } from "react";
import { useGSAP } from "@gsap/react";
import gsap from "gsap";

import ThemeToggle from "./ThemeToggle.jsx";
import WinCtl from "./WinCtl.jsx";
import { REDUCED } from "../lib/motion.js";

/* 开门 · 模式选择（拍板 2026-08-24）：启动先落在这一页，居中两张模式卡
   ——入书游玩（案头/推演台）与谋篇创作（作家构思台）。选完即入各门；
   之后可随时互通（案头工具条「谋篇」、谋篇面「回案头」），开门只在
   每次启动时呈现，不记忆上次选择。 */

const MODES = [
  {
    key: "play",
    badge: "壹",
    title: "入书游玩",
    lines: ["选一部读过的小说，起稿成可玩的世界", "造一个原著没有的人，住进去活一回"],
    hint: "入书为客，落笔成命",
  },
  {
    key: "plot",
    badge: "贰",
    title: "谋篇创作",
    lines: ["一句话点子起步，逐节谋立意与世界观", "文风、人物、大纲，直到写出开篇样章"],
    hint: "谋定而后动，起笔成书",
  },
];

export default function Gate({ theme, onTheme, onPlay, onPlot }) {
  const cardsRef = useRef(null);

  /* 入场 = 绘本弹跳：两张模式卡先后落定（与案头书卡同一套节拍） */
  useGSAP(
    () => {
      if (REDUCED) return;
      gsap.fromTo(
        cardsRef.current.children,
        { opacity: 0, y: 18, scale: 0.95 },
        { opacity: 1, y: 0, scale: 1, duration: 0.46, ease: "back.out(1.6)", stagger: 0.09, clearProps: "transform" },
      );
    },
    { scope: cardsRef },
  );

  const enter = { play: onPlay, plot: onPlot };

  return (
    <div className="app gate">
      <header className="desk-head">
        <div className="desk-hero">
          <h1 className="desk-title">推演书</h1>
          <p className="desk-sub">入书为客，落笔成命</p>
        </div>
        <span className="desk-corner">
          <ThemeToggle theme={theme} onTheme={onTheme} />
          <WinCtl />
        </span>
      </header>

      <main className="gate-body">
        <p className="gate-ask">今天想做什么？</p>
        <div className="gate-cards" ref={cardsRef}>
          {MODES.map((mode) => (
            <button
              key={mode.key}
              type="button"
              className="gate-card"
              onClick={enter[mode.key]}
            >
              <span className="gate-card-badge">{mode.badge}</span>
              <span className="gate-card-title">{mode.title}</span>
              {mode.lines.map((line) => (
                <span key={line} className="gate-card-line">
                  {line}
                </span>
              ))}
              <span className="gate-card-hint">{mode.hint}</span>
            </button>
          ))}
        </div>
      </main>
    </div>
  );
}
