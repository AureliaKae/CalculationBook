import { useEffect, useState } from "react";

import { api } from "../lib/bridge.js";
import { mapTerms } from "../lib/terms.js";
import { useModalDialog } from "./modal.js";

/* 世界分享对话框（拍板 2026-08-21：.cpworld 世界文件）。
   导出选档位：轻装档默认不带原文（分享），全档含原文与粗读摘要（自用备份）。
   导入处理书位冲突：bookId 按书名+格式确定性派生，同名必撞——覆盖/跳过/改名
   三条路由主进程挂起态收口，这里只呈现状与转达决定。
   开关动画走共享的 useModalDialog（入场 CSS 只淡入 + 退场淡出）。 */

export function WorldExportDialog({ state, onClose, onNote }) {
  const ref = useModalDialog(Boolean(state));
  const [busy, setBusy] = useState(false);

  async function run(withSource) {
    if (!state?.book || busy) return;
    setBusy(true);
    try {
      const result = await api.library.exportWorld(state.book.id, withSource);
      if (result?.ok) {
        onNote(
          `《${state.book.title}》已导出${withSource ? "（全档）" : "（轻装档）"}：${result.path}`,
        );
      }
      onClose();
    } catch (error) {
      onNote(mapTerms(error.message));
      onClose();
    } finally {
      setBusy(false);
    }
  }

  return (
    <dialog
      ref={ref}
      className="imp-dialog"
      onCancel={(event) => {
        event.preventDefault();
        onClose();
      }}
    >
      {state ? (
        <div className="imp-frame">
          <p className="imp-head">导出《{state.book.title}》的世界</p>
          <p className="cf-detail">
            导出书库当前状态（跨世痕迹与涌现实体一并随行）。只分享你有权分享的内容。
          </p>
          <button type="button" className="imp-drop" disabled={busy} onClick={() => run(false)}>
            <span className="imp-drop-main">轻装档 · 分享</span>
            <span className="imp-drop-sub">不带原文 · 通常几百 KB · 导入即可开卷</span>
          </button>
          {state.book.sourceless ? null : (
            <button type="button" className="imp-drop" disabled={busy} onClick={() => run(true)}>
              <span className="imp-drop-main">全档 · 自用备份</span>
              <span className="imp-drop-sub">含原文与粗读摘要 · 跨机器迁移后文风与账本照常</span>
            </button>
          )}
          <div className="imp-acts">
            <button type="button" className="ghost-btn" disabled={busy} onClick={onClose}>
              再想想
            </button>
          </div>
        </div>
      ) : null}
    </dialog>
  );
}

export function WorldImportDialog({ open, onClose, onDone, onNote }) {
  const ref = useModalDialog(open);
  const [busy, setBusy] = useState(false);
  const [conflict, setConflict] = useState(null);
  const [rename, setRename] = useState("");

  useEffect(() => {
    if (open) {
      setBusy(false);
      setConflict(null);
      setRename("");
    }
  }, [open]);

  async function pick() {
    setBusy(true);
    try {
      const result = await api.library.importWorld();
      if (result?.status === "canceled") return;
      if (result?.status === "conflict") {
        setConflict(result);
        setRename(`${result.title}·分享`);
        return;
      }
      onDone(result);
    } catch (error) {
      onNote(mapTerms(error.message));
    } finally {
      setBusy(false);
    }
  }

  async function confirm(action) {
    setBusy(true);
    try {
      const result = await api.library.importWorldConfirm({ action, newTitle: rename });
      onDone(result);
    } catch (error) {
      // 改名撞名等情况：主进程挂起态还在，换名再试即可。
      onNote(mapTerms(error.message));
    } finally {
      setBusy(false);
    }
  }

  return (
    <dialog
      ref={ref}
      className="imp-dialog"
      onCancel={(event) => {
        event.preventDefault();
        onClose();
      }}
    >
      {open ? (
        <div className="imp-frame">
          <p className="imp-head">导入一个世界</p>
          {conflict ? (
            <>
              <p className="cf-detail">
                书架上已有《{conflict.title}》的同名同格式书位。覆盖会清掉旧书的对局、进度与存档；
                跳过则什么都不动；改名会落一个新书位。
              </p>
              <input
                className="ip-input"
                type="text"
                value={rename}
                maxLength={60}
                placeholder="新书名（改名导入用）"
                aria-label="新书名"
                onChange={(event) => setRename(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter" && rename.trim() && !busy) {
                    event.preventDefault();
                    void confirm("rename");
                  }
                }}
              />
              <div className="imp-acts">
                <button type="button" className="ghost-btn" disabled={busy} onClick={() => confirm("skip")}>
                  跳过
                </button>
                <button
                  type="button"
                  className="ghost-btn"
                  disabled={busy}
                  onClick={() => confirm("overwrite")}
                >
                  覆盖旧书
                </button>
                <button
                  type="button"
                  className="pen-submit"
                  disabled={busy || !rename.trim()}
                  onClick={() => confirm("rename")}
                >
                  改名导入
                </button>
              </div>
            </>
          ) : (
            <>
              <p className="cf-detail">
                .cpworld 世界文件：导入即上架，免去起稿的等待与开销。无原文的轻装档
                可正常游玩，文风与「原著此刻」自动降级。
              </p>
              <button type="button" className="imp-drop" disabled={busy} onClick={pick}>
                <span className="imp-drop-main">{busy ? "正在读世界…" : "择一个世界文件"}</span>
                <span className="imp-drop-sub">.cpworld · 来自书友的分享或你自己的备份</span>
              </button>
              <div className="imp-acts">
                <button type="button" className="ghost-btn" disabled={busy} onClick={onClose}>
                  再想想
                </button>
              </div>
            </>
          )}
        </div>
      ) : null}
    </dialog>
  );
}
