import { useRef } from "react";
import { useGSAP } from "@gsap/react";
import gsap from "gsap";

import { REDUCED } from "../lib/motion.js";

/* 一次性入场（Fiction 版全站动效词汇统一件）：弹入——缩放 .92→1 + 淡入 +
   小位移（back.out(1.7) 弹性过冲 · 0.42s），与 Desk/Studio/Chronicle 的
   stagger 入场同族。REDUCED 直通不动画；deps 变化时重放（默认只在挂载时
   播一次）。 */
export default function FadeIn({ as: Tag = "div", deps = [], children, ...rest }) {
  const ref = useRef(null);
  useGSAP(
    () => {
      if (REDUCED) return;
      gsap.fromTo(
        ref.current,
        { autoAlpha: 0, y: 10, scale: 0.92 },
        { autoAlpha: 1, y: 0, scale: 1, duration: 0.42, ease: "back.out(1.7)", overwrite: "auto", clearProps: "transform" },
      );
    },
    { dependencies: deps },
  );
  return (
    <Tag ref={ref} {...rest}>
      {children}
    </Tag>
  );
}
