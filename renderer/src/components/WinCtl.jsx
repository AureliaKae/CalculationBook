import { useEffect, useState } from "react";
import { api } from "../lib/bridge.js";

/* 无边框窗口控制：最小化 ─ / 最大化 □ / 关闭 ✕，各页头部右端。
   主进程通道（window:minimize/toggle/close）自 Electron 壳恢复起就在，
   这里补上它的按钮；最大化态经 window:state 推送同步字形（□/❐）。
   关闭悬停转朱红——四色纪律里红承担警示。 */
export default function WinCtl() {
  const [maximized, setMaximized] = useState(false);

  useEffect(() => {
    let alive = true;
    api.window
      .isMaximized()
      .then((value) => {
        if (alive) setMaximized(Boolean(value));
      })
      .catch(() => {});
    const off = api.window.onState((value) => setMaximized(Boolean(value)));
    return () => {
      alive = false;
      off();
    };
  }, []);

  return (
    <span className="win-ctl" aria-label="窗口控制">
      <button
        type="button"
        className="win-btn"
        title="最小化"
        aria-label="最小化"
        onClick={() => api.window.minimize()}
      >
        ─
      </button>
      <button
        type="button"
        className="win-btn"
        title={maximized ? "还原" : "最大化"}
        aria-label={maximized ? "还原" : "最大化"}
        onClick={() => api.window.toggle()}
      >
        {maximized ? "❐" : "□"}
      </button>
      <button
        type="button"
        className="win-btn win-close"
        title="关闭"
        aria-label="关闭"
        onClick={() => api.window.close()}
      >
        ✕
      </button>
    </span>
  );
}
