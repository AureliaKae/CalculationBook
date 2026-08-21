import { useEffect, useRef, useState } from "react";
import { REDUCED } from "../lib/motion.js";

/* 数学语汇小组件：全站共用的数字与构成条原语。
   FxNum——累积数字：数值变化弹性趋近（easeOutBack 轻过冲再落定，
   绘本版「跳一下再站稳」），减动效直取终值。
   FxBar——概率构成条：两段条表达构成/进度（与公式演算条同一形态）。 */

export function FxNum({ value, className = "", format }) {
  const target = Number(value) || 0;
  const [shown, setShown] = useState(target);
  const fromRef = useRef(target);

  useEffect(() => {
    if (REDUCED) {
      fromRef.current = target;
      setShown(target);
      return;
    }
    const from = fromRef.current;
    if (from === target) return;
    const startedAt = performance.now();
    const duration = Math.min(900, 240 + Math.abs(target - from) * 24);
    // easeOutBack：末段略过冲再回弹（c1 过冲量，GSAP back.out 同族公式）。
    const c1 = 1.70158;
    const c3 = c1 + 1;
    let raf = 0;
    const tick = (now) => {
      const t = Math.min(1, (now - startedAt) / duration);
      const eased = 1 + c3 * Math.pow(t - 1, 3) + c1 * Math.pow(t - 1, 2);
      const next = from + (target - from) * eased;
      setShown(t >= 1 ? target : next);
      if (t < 1) raf = requestAnimationFrame(tick);
      else fromRef.current = target;
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [target]);

  const text = format ? format(shown) : String(Math.round(shown));
  return <span className={"fx-num " + className}>{text}</span>;
}

export function FxBar({ a, b = 0, className = "" }) {
  // a/b 为两段宽度（同一量纲）；总宽归一化到 100%。
  const total = Math.max(a + b, 1e-9);
  return (
    <span className={"fx-bar " + className} aria-hidden="true">
      <span className="seg-a" style={{ width: `${(a / total) * 100}%` }} />
      <span className="seg-b" style={{ width: `${(b / total) * 100}%` }} />
    </span>
  );
}

export const pad2 = (n) => String(n).padStart(2, "0");
