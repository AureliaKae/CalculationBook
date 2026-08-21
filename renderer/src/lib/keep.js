// 与 electron/settings-store.js 的哨兵同值：改设置时不回传明文 Key，
// 用它表示「这条凭证的 Key 保持不变」。渲染层拿不到已存密钥。
export const KEEP_KEY = "__KEEP__";
