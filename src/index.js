// 引擎公共入口：桌面壳只从这里取引擎能力——主进程（electron/）用本文件，
// 渲染层（renderer/）用浏览器安全的叶子出口 src/client.js（本文件会拉入
// 依赖 Node 内置模块的引擎代码，进浏览器 bundle 会炸）。
// 这个文件就是「引擎接口面」——往这里加导出是对外的承诺，不是内部抽屉；
// 未来若出现另一套引擎（如付费高级引擎），实现同样的出口即可与壳层无缝换装。
export { NovelBaker, batches, loadSummaries, novelCachePrefix } from "./baker.js";
export { estimateBakeInputTokens, estimateCoarseEtaSeconds } from "./bake-progress.js";
export { BIG_FIVE_DIMENSIONS, BIG_FIVE_LABELS, bigFiveLevel, createPlayerState, defaultMotivationOf, normalizeWorld, realmTraitsOf } from "./evolution.js";
export { characterNamesOf, isCharacterBoundName } from "./identity-guard.js";
export { applyRoleTransition, createSuccessorState, buildCharacterJournal, pastLifeFact, playerDeathState, divergenceWorldFacts, fateSeedsView, divergenceThreshold, fateTierOf } from "./gameplay-systems.js";
export { applyRoleIdentity } from "./role-identity.js";
export { createEntity, seedCreatedCharacter, validateCreation, CREATABLE_KINDS } from "./world-creation.js";
export { applyCatalogCoherence, CATALOG_COHERENCE_PROMPT, sanitizeEventFactChanges, sanitizeRoleCapabilities } from "./world-repair.js";
export { playerClashCondition, stanceLabel, CLASH_CONDITIONS } from "./clash.js";
export { arcBeatView } from "./director.js";
export { footstepsView, worldHappeningsView, atlasView, storyStart, storyClockView, protagonistView, povLinesView } from "./timeline.js";
export { relationsView } from "./relations.js";
export { emergentStoriesView } from "./story-emergence.js";
export { CharacterDetailCache } from "./character-detail-cache.js";
export { buildCanonLedger } from "./canon-ledger.js";
export { EntityStateTracker } from "./entity-state-tracker.js";
export { StoryEngine, worldviewForCheck, divergenceTargetLabel } from "./engine.js";
export { parseNovel } from "./novel-import.js";
export { matchSourceToIndex, normalizeChapterTitle } from "./source-match.js";
export { BakeLimiter } from "./bake-limiter.js";
export { WORLD_BUNDLE_EXTENSION, buildWorldBundle, parseWorldBundle } from "./world-bundle.js";
export { OpenAiCompatibleClient, fetchModels } from "./openai-client.js";
export { ProgressStore, restoreEngine, serializeEngine, resumeEnding } from "./save-store.js";
export { LayeredMemory } from "./memory.js";
export { KeyedSingleFlight } from "./keyed-single-flight.js";
export { clientConfig, publicSettings, resolveBakeConcurrency } from "./settings-schema.js";
export { isKnownProviderBaseUrl } from "./providers.js";
export { searchBookReference } from "./web-search.js";
export { genreSearchKeywords, genreVocabulary, guessGenreByKeywords } from "./genre.js";
export {
  PLOT_SECTIONS,
  PLOT_SECTION_KEYS,
  newPlotProject,
  normalizeProject,
  normalizeSection,
  generatePremise,
  generateWorldview,
  proposeStyle,
  analyzeStyleSample,
  styleFromLibrary,
  generateCharacters,
  generateOutline,
  generateSample,
  generateIdeaCards,
  normalizeIdeaCards,
  normalizeFlavor,
  projectToMarkdown,
} from "./plotting.js";
export { enterInteractive, exitInteractive, waitForInteractiveIdle } from "./request-priority.js";
export { submitCatalogCoherenceTool, submitDigestMergeTool, submitRoleAbilitiesTool, submitSummaryMergeTool, submitSummaryVerifyTool, submitTimelineFactsTool, submitUpgradeWorldTool } from "./structured-tools.js";
