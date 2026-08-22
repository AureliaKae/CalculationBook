// 渲染层专用的引擎叶子出口：只放不依赖 Node 内置模块、能安全进浏览器
// bundle 的东西。引擎的完整接口面在 src/index.js，那是主进程的入口。
export { classifyBakeError, classifyTurnError } from "./bake-error.js";
export { estimateBakeInputTokens } from "./bake-progress.js";
export { PROVIDER_PRESETS, recommendedModelsFor } from "./providers.js";
