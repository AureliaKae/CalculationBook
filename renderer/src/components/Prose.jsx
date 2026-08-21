import { useRef } from "react";
import { useGSAP } from "@gsap/react";
import gsap from "gsap";
import { ScrollTrigger } from "gsap/ScrollTrigger";
import { REDUCED } from "../lib/motion.js";

function Chars({ text, split }) {
  // 静态段不逐字拆 span：长局 200 手 × 每手数百字曾把 DOM 撑到 6 万节点，
  // 一个文本节点渲染完全等价（.ch 只比文本节点多一个 display:inline）。
  if (!split) return text;
  return (
    <>
      {[...text].map((c, i) => (
        <span className="ch" key={i}>
          {c}
        </span>
      ))}
    </>
  );
}

/* 一段：animate 时进段先整段轻弹，再逐字闪现（字距回归 2026-08-21：
   .ch 保持内联，逐字只动 opacity——inline-block 会破坏 CJK 标点压缩）；
   静态段（回放旧稿）直接成品 */
function Paragraph({ text, mark, active, animate = true }) {
  const ref = useRef(null);
  const split = animate && !REDUCED;

  useGSAP(
    () => {
      if (!split) return;
      // 段落级弹出（<p> 是块级，transform 有效）。
      gsap.fromTo(
        ref.current,
        { scale: 0.985 },
        { scale: 1, duration: 0.4, ease: "back.out(1.6)", clearProps: "scale" },
      );
      const chars = ref.current.querySelectorAll(".ch");
      gsap.set(chars, { opacity: 0 });
      ScrollTrigger.create({
        trigger: ref.current,
        start: "top 94%",
        once: true,
        onEnter: () =>
          gsap.to(chars, {
            opacity: 1,
            duration: 0.16,
            ease: "none",
            stagger: 0.014,
            overwrite: true,
          }),
      });
    },
    { scope: ref },
  );

  let inner = <Chars text={text} split={split} />;
  if (mark) {
    const i = text.indexOf(mark.from);
    if (i >= 0) {
      inner = (
        <>
          <Chars text={text.slice(0, i)} split={split} />
          <span className={"marked" + (active ? " on" : "")}>
            <Chars text={mark.from} split={split} />
          </span>
          <Chars text={text.slice(i + mark.from.length)} split={split} />
        </>
      );
    }
  }

  return <p ref={ref}>{inner}</p>;
}

export default function Prose({ paragraphs, marks = [], marksOn = true, animate = true }) {
  const byPara = new Map();
  for (const m of marks) if (!byPara.has(m.para)) byPara.set(m.para, m);
  return (
    <div className="prose">
      {paragraphs.map((p, i) => (
        <Paragraph
          key={i}
          text={p}
          mark={byPara.get(i)}
          active={marksOn}
          animate={animate}
        />
      ))}
    </div>
  );
}
