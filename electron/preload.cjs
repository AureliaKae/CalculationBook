const { contextBridge, ipcRenderer, webFrame } = require("electron");

contextBridge.exposeInMainWorld("calculationpaper", {
  // 界面缩放（2026-08-24）：Ctrl+滚轮 / Ctrl+=、-、0 由渲染层驱动，
  // 系数经 localStorage 记忆（cp-zoom），下次启动恢复。
  zoom: {
    set: (factor) => webFrame.setZoomFactor(Number(factor) || 1),
    get: () => webFrame.getZoomFactor(),
  },
  window: {
    minimize: () => ipcRenderer.send("window:minimize"),
    toggle: () => ipcRenderer.send("window:toggle"),
    close: () => ipcRenderer.send("window:close"),
    isMaximized: () => ipcRenderer.invoke("window:state"),
    onState: (callback) => {
      const handler = (_event, value) => callback(value);
      ipcRenderer.on("window:state", handler);
      return () => ipcRenderer.off("window:state", handler);
    },
  },
  settings: {
    get: () => ipcRenderer.invoke("settings:get"),
    save: (value) => ipcRenderer.invoke("settings:save", value),
    models: (value) => ipcRenderer.invoke("settings:models", value),
    usage: () => ipcRenderer.invoke("usage:get"),
  },
  library: {
    list: () => ipcRenderer.invoke("library:list"),
    remove: (id) => ipcRenderer.invoke("library:remove", id),
    rebake: (bookId) => ipcRenderer.invoke("library:rebake", { bookId }),
    topupCoarse: (bookId) => ipcRenderer.invoke("library:coarse-topup", { bookId }),
    chronicle: (bookId) => ipcRenderer.invoke("library:chronicle", bookId),
    exportWorld: (bookId, withSource) =>
      ipcRenderer.invoke("library:export-world", { bookId, withSource }),
    importWorld: () => ipcRenderer.invoke("library:import-world"),
    importWorldConfirm: (value) => ipcRenderer.invoke("library:import-world-confirm", value),
    attachSource: (bookId) => ipcRenderer.invoke("library:attach-source", { bookId }),
    attachSourceConfirm: (value) => ipcRenderer.invoke("library:attach-source-confirm", value),
  },
  novel: {
    choose: () => ipcRenderer.invoke("novel:choose"),
    bake: (value) => ipcRenderer.invoke("novel:bake", value),
    cancel: (jobId) => ipcRenderer.invoke("novel:bake-cancel", { jobId }),
    retry: (jobId) => ipcRenderer.invoke("novel:bake-retry", { jobId }),
    onProgress: (callback) => {
      const handler = (_event, value) => callback(value);
      ipcRenderer.on("bake:progress", handler);
      return () => ipcRenderer.off("bake:progress", handler);
    },
    onDone: (callback) => {
      const handler = (_event, value) => callback(value);
      ipcRenderer.on("bake:done", handler);
      return () => ipcRenderer.off("bake:done", handler);
    },
    onError: (callback) => {
      const handler = (_event, value) => callback(value);
      ipcRenderer.on("bake:error", handler);
      return () => ipcRenderer.off("bake:error", handler);
    },
  },
  story: {
    start: (value) => ipcRenderer.invoke("story:new", value),
    createCharacter: (value) => ipcRenderer.invoke("story:create-character", value),
    continueStage: () => ipcRenderer.invoke("story:continue-stage"),
    createSuccessor: () => ipcRenderer.invoke("story:create-successor"),
    resolveTransition: (value) => ipcRenderer.invoke("story:resolve-transition", value),
    reselectRole: (value) => ipcRenderer.invoke("story:reselect-role", value),
    play: (id) => ipcRenderer.invoke("game:play", id),
    intentOptions: (value) => ipcRenderer.invoke("game:intent-options", value),
    setGoal: (value) => ipcRenderer.invoke("game:set-goal", value),
    setScheme: (value) => ipcRenderer.invoke("game:set-scheme", value),
    cancel: () => ipcRenderer.invoke("story:cancel"),
    exportLife: () => ipcRenderer.invoke("story:export"),

    onChunk: (callback) => {
      const handler = (_event, text) => callback(text);
      ipcRenderer.on("story:chunk", handler);
      return () => ipcRenderer.off("story:chunk", handler);
    },
    onPhase: (callback) => {
      const handler = (_event, phase) => callback(phase);
      ipcRenderer.on("story:phase", handler);
      return () => ipcRenderer.off("story:phase", handler);
    },
    onDiscard: (callback) => {
      const handler = () => callback();
      ipcRenderer.on("story:discard", handler);
      return () => ipcRenderer.off("story:discard", handler);
    },
  },
  progress: {
    resume: (bookId) => ipcRenderer.invoke("progress:resume", bookId),
  },
  world: {
    draftEntity: (value) => ipcRenderer.invoke("world:draft-entity", value),
    createEntity: (value) => ipcRenderer.invoke("world:create-entity", value),
  },
  plot: {
    list: () => ipcRenderer.invoke("plot:list"),
    create: (value) => ipcRenderer.invoke("plot:create", value),
    get: (projectId) => ipcRenderer.invoke("plot:get", { projectId }),
    rename: (projectId, title) => ipcRenderer.invoke("plot:rename", { projectId, title }),
    remove: (projectId) => ipcRenderer.invoke("plot:remove", { projectId }),
    saveSection: (value) => ipcRenderer.invoke("plot:save-section", value),
    generate: (value) => ipcRenderer.invoke("plot:generate", value),
    ideaCards: (value) => ipcRenderer.invoke("plot:idea-cards", value),
    cancelSample: () => ipcRenderer.invoke("plot:sample-cancel"),
    searchReference: (value) => ipcRenderer.invoke("plot:search-reference", value),
    libraryStyles: () => ipcRenderer.invoke("plot:library-styles"),
    exportProject: (projectId) => ipcRenderer.invoke("plot:export", { projectId }),
    onChunk: (callback) => {
      const handler = (_event, text) => callback(text);
      ipcRenderer.on("plot:chunk", handler);
      return () => ipcRenderer.off("plot:chunk", handler);
    },
  },
});
