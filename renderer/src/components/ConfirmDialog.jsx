import { useEffect, useRef } from "react";

import { useModalDialog } from "./modal.js";

/* 应用内确认框：替代 window.confirm。Electron 无边框窗口里同步对话框
   （confirm/alert）会吞掉其后的键盘事件——点完确认就打不了字，必须
   切换窗口焦点才能恢复。原生 <dialog> 无此问题，且自带焦点圈定与 ESC。 */
export default function ConfirmDialog({ state, onClose }) {
  const ref = useModalDialog(Boolean(state));
  const cancelRef = useRef(null);

  useEffect(() => {
    // 默认焦点给安全侧（再想想）：误按回车只会关掉确认框，不至毁档。
    if (state) requestAnimationFrame(() => cancelRef.current?.focus());
  }, [state]);

  return (
    <dialog
      ref={ref}
      className="imp-dialog cf-dialog"
      onCancel={(event) => {
        event.preventDefault();
        onClose();
      }}
    >
      {state ? (
        <div className="imp-frame">
          <p className="imp-head">{state.title}</p>
          {state.detail ? <p className="cf-detail">{state.detail}</p> : null}
          <div className="imp-acts">
            <button type="button" className="ghost-btn" ref={cancelRef} onClick={onClose}>
              再想想
            </button>
            <button
              type="button"
              className="pen-submit"
              onClick={() => {
                onClose();
                state.onConfirm?.();
              }}
            >
              {state.confirmLabel ?? "确定"}
            </button>
          </div>
        </div>
      ) : null}
    </dialog>
  );
}
