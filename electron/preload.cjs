const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("calculationpaper", {
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
});
