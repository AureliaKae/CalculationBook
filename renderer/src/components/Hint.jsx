import { useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

const GAP = 9; // 问号与卡片的间距（px）
const MARGIN = 12; // 视口安全边距（px）

/* 术语问号（拍板 2026-08-21）：非交互的行话标签旁挂一枚小问号，悬停或键盘
   聚焦浮出说明卡。只解释「这是什么」；按钮的点击效果仍归 title，两种提示
   各守一边。视觉照 DESIGN.md「白卡描边」浮层拍板；交互色只用石墨系（四色
   纪律：朱红不作交互色）。
   卡片经 portal 挂到 body——若问号在原生 <dialog> 内则挂进 dialog 本身，
   才能留在 top layer。fixed 定位 + 视口感知翻转：侧栏等滚动容器裁不住它，
   相邻卡片的层叠上下文也压不住它，长文只换行不溢出。 */
export default function Hint({ text, side = "down" }) {
  const id = useId();
  const markRef = useRef(null);
  const cardRef = useRef(null);
  const [host, setHost] = useState(null);
  const [open, setOpen] = useState(false);
  const [visible, setVisible] = useState(false);
  const [pos, setPos] = useState(null);

  useLayoutEffect(() => {
    if (!open) return;
    const mark = markRef.current;
    const card = cardRef.current;
    if (!mark || !card) return;

    const place = () => {
      const m = mark.getBoundingClientRect();
      const c = card.getBoundingClientRect();
      if (!m.width || !c.width) return;
      const vw = window.innerWidth;
      const vh = window.innerHeight;

      // 水平：默认以问号居中；side=left 右对齐（问号常在屏幕左缘），再钳进视口。
      let left = side === "left" ? m.right - c.width : m.left + (m.width - c.width) / 2;
      left = Math.min(Math.max(left, MARGIN), Math.max(vw - c.width - MARGIN, MARGIN));

      // 垂直：默认向下展开，side=up 向上；一侧放不下就翻到另一侧。
      const below = m.bottom + GAP;
      const above = m.top - c.height - GAP;
      const fitsBelow = below + c.height <= vh - MARGIN;
      const fitsAbove = above >= MARGIN;
      let top;
      if (side === "up") top = fitsAbove ? above : below;
      else top = fitsBelow ? below : above;
      // 两侧都放不下（卡片高于视口）时钳回安全边距内。
      top = Math.max(Math.min(top, vh - MARGIN - c.height), MARGIN);
      setPos({ left, top });
    };

    place();
    const raf = requestAnimationFrame(() => setVisible(true));
    window.addEventListener("resize", place);
    window.addEventListener("scroll", place, true); // capture：接住嵌套滚动容器
    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener("resize", place);
      window.removeEventListener("scroll", place, true);
    };
  }, [open, side, host, text]);

  useEffect(() => {
    if (!open) return;
    const onKey = (event) => {
      if (event.key === "Escape") setOpen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open]);

  function enter() {
    setHost(markRef.current?.closest("dialog") ?? document.body);
    setOpen(true);
  }

  function leave() {
    setOpen(false);
    setVisible(false);
  }

  return (
    <span className="tip" onMouseEnter={enter} onMouseLeave={leave}>
      <button
        type="button"
        ref={markRef}
        className="tip-mark"
        aria-describedby={id}
        aria-label="这是什么"
        onFocus={(event) => {
          if (event.target.matches(":focus-visible")) enter();
        }}
        onBlur={leave}
      >
        ？
      </button>
      {open && host
        ? createPortal(
            <span
              ref={cardRef}
              className={"tip-card" + (visible ? " is-open" : "")}
              role="tooltip"
              id={id}
              style={pos ? { left: pos.left, top: pos.top } : undefined}
            >
              {text}
            </span>,
            host,
          )
        : null}
    </span>
  );
}
