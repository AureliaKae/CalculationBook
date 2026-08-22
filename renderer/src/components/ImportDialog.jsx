import { useEffect, useState } from "react";
import { api } from "../lib/bridge.js";
import { mapTerms } from "../lib/terms.js";
import { estimateBakeInputTokens } from "../../../src/client.js";
import Hint from "./Hint.jsx";
import { useModalDialog } from "./modal.js";

/* 采样粗读档位（字符数）：全本之外只在大部头出现，选小预算省的是
   九成开销所在的粗读；漏掉的批次以后可在案头「补读」增量补全。 */
const COARSE_TIERS = [
  { label: "全本", value: null },
  { label: "约 200 万字", value: 2_000_000 },
  { label: "约 100 万字", value: 1_000_000 },
  { label: "约 50 万字", value: 500_000 },
];
const TIER_MIN_CHARS = 500_000; // 小于 50 万字的书不值得采样，不显示档位。
const LONG_BOOK_CHARS = 1_000_000; // 超过 100 万字给一句「可以采样」的提示。

/* 导入弹窗：两步——择书（真桥走系统文件对话框）→ 画样卡 → 开始起稿 */
export default function ImportDialog({ open, onClose, onBakeStarted, onNote }) {
  const ref = useModalDialog(open);
  const [step, setStep] = useState(0);
  const [info, setInfo] = useState(null);
  const [busy, setBusy] = useState(false);
  const [budget, setBudget] = useState(null);

  useEffect(() => {
    if (open) {
      setStep(0);
      setInfo(null);
      setBusy(false);
      setBudget(null);
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
      const job = await api.novel.bake({
        focusChapter: 1,
        openAll: true,
        ...(budget ? { coarseBudgetChars: budget } : {}),
      });
      onBakeStarted(job);
    } catch (error) {
      onNote(mapTerms(error.message));
      setBusy(false);
    }
  }

  const showTiers = info && info.characters > TIER_MIN_CHARS;
  const sampled = Boolean(budget && info && budget < info.characters);
  // 预估随档位联动：采样只算被读部分的粗读，固定项（五片/精读等）照旧。
  const estimated = info
    ? estimateBakeInputTokens(sampled ? Math.min(budget, info.characters) : info.characters)
    : 0;

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
                  {sampled ? "（采样）" : ""}
                  <Hint text="粗读＝起稿的第一步，通读全书记要点，占起稿开销的大头。token 是计费单位，约 1 token ≈ 0.6 个汉字。采样只通读所选预算内的批次（保首尾与切入章节附近，中间等距抽取），漏掉的批次以后可在案头书卡「补读」增量补全。" />
                </dt>
                <dd className="mono">{(estimated / 10000).toFixed(0)} 万 tokens</dd>
              </div>
            </dl>
            {showTiers ? (
              <div className="imp-chips" role="radiogroup" aria-label="粗读范围">
                {COARSE_TIERS.map((tier) => (
                  <button
                    type="button"
                    key={tier.label}
                    className={"bf-chip" + (budget === tier.value ? " on" : "")}
                    aria-pressed={budget === tier.value}
                    onClick={() => setBudget(tier.value)}
                  >
                    {tier.label}
                  </button>
                ))}
              </div>
            ) : null}
            {showTiers && info.characters > LONG_BOOK_CHARS && !sampled ? (
              <p className="studio-note">大部头全本粗读花费可观——可改选「约 100 万字」等采样档位先省一截，漏读的批次以后在案头补读。</p>
            ) : null}
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
