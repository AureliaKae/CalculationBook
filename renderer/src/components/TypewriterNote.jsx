import { useRef } from "react";
import { useGSAP } from "@gsap/react";
import gsap from "gsap";
import { REDUCED } from "../lib/motion.js";

/* 打字机批注：整条轻浮 + 逐字闪现（字距回归 2026-08-21：.ch 内联只动
   opacity）；reduced-motion 直接显示。
   只在挂载时演一遍（一手一卡，新手数整卡重打）。手记文本掺着引擎分笔
   推送的世界见闻，若跟着 text 重演，同一张卡会被反复重打——观感是整卡
   抽搐、忽明忽暗；文本就地修订，不再重演。 */
export default function TypewriterNote({ text, kind = "world", order = 0 }) {
  const ref = useRef(null);

  useGSAP(
    () => {
      if (REDUCED) return;
      gsap.fromTo(
        ref.current,
        { scale: 0.97 },
        { scale: 1, duration: 0.3, ease: "power2.out", delay: order * 0.35, clearProps: "scale" },
      );
      const chars = ref.current.querySelectorAll(".ch");
      gsap.fromTo(
        chars,
        { opacity: 0 },
        {
          opacity: 1,
          duration: 0.12,
          ease: "none",
          stagger: 0.045,
          delay: order * 0.35,
        },
      );
    },
    { scope: ref },
  );

  return (
    <li className={"note note-type " + kind} ref={ref}>
      <span className="note-dash" aria-hidden="true" />
      <span>
        {[...String(text ?? "")].map((c, i) => (
          <span className="ch" key={i}>
            {c}
          </span>
        ))}
      </span>
    </li>
  );
}
