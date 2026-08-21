import { useEffect, useRef } from "react";
import gsap from "gsap";

import { REDUCED } from "../lib/motion.js";

/* 弹窗开关的统一收口（Fiction 版 2026-08-21：绘本弹跳）：
   开——showModal()，入场由 CSS 的 imp-in 弹入承担（缩放 .92→1 + 弹性过冲）。
   快速关-开时先杀掉在途的退场补间并清内联样式，否则它会在 onComplete 里
   把刚重开的弹窗关掉。
   关——内容先 0.18s 缩回+淡出再 close()：原生 dialog 的 close 是即时摘除；
   REDUCED 直关。
   onCancel 仍由各弹窗自行 preventDefault + onClose()，走这条退场路径。 */
export function useModalDialog(open) {
  const ref = useRef(null);
  const closingTween = useRef(null);
  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    if (open) {
      closingTween.current?.kill();
      closingTween.current = null;
      gsap.set(dialog, { clearProps: "all" });
      // 淡出途中重开：kill 只停了补间，close() 不会发生，dialog 仍带 open
      // 属性——此时再 showModal() 按 WHATWG 规范抛 InvalidStateError，且全站
      // 无 ErrorBoundary 兜底会直接白屏。开着就保持开着。
      if (!dialog.open) dialog.showModal();
      return;
    }
    if (!dialog.open) return;
    if (REDUCED) {
      dialog.close();
      return;
    }
    closingTween.current = gsap.to(dialog, {
      autoAlpha: 0,
      scale: 0.94,
      duration: 0.18,
      ease: "power2.in",
      onComplete: () => {
        closingTween.current = null;
        gsap.set(dialog, { clearProps: "all" });
        dialog.close();
      },
    });
    // 卸载时杀掉在途补间：不杀的话它会多跑零点几秒才对已摘除的
    // dialog 调 close()（原生对游离节点安全，但 gsap 会多持有引用）。
    return () => closingTween.current?.kill();
  }, [open]);
  return ref;
}
