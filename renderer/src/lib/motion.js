/* 全站减动效判定（原 components/Derive.jsx 的常量，组件本体已随原型迭代
   删除多年——清理轮 2026-08-21 正名挪到 lib/）：用户系统开了
   「减少动态效果」时，各处动效退为直切/淡入。 */
export const REDUCED =
  typeof window !== "undefined" &&
  window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
