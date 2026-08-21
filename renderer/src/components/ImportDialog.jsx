import { useEffect, useState } from "react";
import { api } from "../lib/bridge.js";
import { mapTerms } from "../lib/terms.js";
import Hint from "./Hint.jsx";
import { useModalDialog } from "./modal.js";

/* 导入弹窗：两步——择书（真桥走系统文件对话框）→ 画样卡 → 开始起稿 */
export default function ImportDialog({ open, onClose, onBakeStarted, onNote }) {
  const ref = useModalDialog(open);
  const [step, setStep] = useState(0);
  const [info, setInfo] = useState(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (open) {
      setStep(0);
      setInfo(null);
      setBusy(false);
    }
  }, [open]);

  async function choose() {
    setBusy(true);
    try {
      const preview = await api.novel.choose();
      if (!preview) {
        setBusy(false);
        return;
      }
      setInfo(preview);
      setStep(1);
    } catch (error) {
      onNote(mapTerms(error.message));
    } finally {
      setBusy(false);
    }
  }

  async function bake() {
    setBusy(true);
    try {
      const job = await api.novel.bake({ focusChapter: 1, openAll: true });
      onBakeStarted(job);
    } catch (error) {
      onNote(mapTerms(error.message));
      setBusy(false);
    }
  }

  return (
    <dialog
      ref={ref}
      className="imp-dialog"
      onCancel={(e) => {
        e.preventDefault();
        if (!busy) onClose();
      }}
    >
      <div className="imp-frame">
        <p className="imp-head">起稿一部小说</p>
        {step === 0 ? (
          <>
            <button type="button" className="imp-drop" onClick={choose} disabled={busy}>
              <span className="imp-drop-main">{busy ? "正在读文件…" : "择一部书稿"}</span>
              <span className="imp-drop-sub">.txt 或 .epub · 起稿需通读全书</span>
            </button>
            <div className="imp-acts">
              <button type="button" className="ghost-btn" onClick={onClose} disabled={busy}>
                先回案头
              </button>
            </div>
          </>
        ) : (
          <>
            <dl className="imp-facts">
              <div>
                <dt>书名</dt>
                <dd>《{info.title}》</dd>
              </div>
              <div>
                <dt>章数</dt>
                <dd className="mono">{info.chapterCount}</dd>
              </div>
              <div>
                <dt>体量</dt>
                <dd className="mono">{(info.characters / 10000).toFixed(0)} 万字</dd>
              </div>
              <div>
                <dt>
                  粗读预估
                  <Hint text="粗读＝起稿的第一步，通读全书记要点，占起稿开销的大头。token 是计费单位，约 1 token ≈ 0.6 个汉字。" />
                </dt>
                <dd className="mono">{(info.estimatedInputTokens / 10000).toFixed(0)} 万 tokens</dd>
              </div>
            </dl>
            {info.cachedBake ? (
              <p className="studio-note">这部书有起稿到一半的断点，会接着上次的进度继续。</p>
            ) : null}
            <div className="imp-acts">
              <button type="button" className="pen-submit" onClick={bake} disabled={busy}>
                {busy ? "起稿中…" : "开始起稿"}
              </button>
              <button type="button" className="ghost-btn" onClick={() => setStep(0)} disabled={busy}>
                再选一部
              </button>
            </div>
          </>
        )}
      </div>
    </dialog>
  );
}
