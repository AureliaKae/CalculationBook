import { useRef } from "react";
import { useGSAP } from "@gsap/react";
import gsap from "gsap";

import { mapTerms } from "../lib/terms.js";
import { FxNum } from "./fx.jsx";
import { REDUCED } from "../lib/motion.js";

/* 起稿多任务行（拍板 2026-08-21：左下角、无卡片、纯百分比）：一行一本，
   同时最多三本。进行中《书名》 N% 行尾可取消；成卷「入画」；未成留「重试」。
   用户取消从不出行（C9）。无卡片拍板：不铺纸底不框不影，文字直接落在稿面上。
   新行浮现入场（同一词汇）；状态换树（成卷/未成）随 key 稳定不重放。 */
export default function BakeHud({ jobs, onCancel, onEnter, onRetry, onDismiss }) {
  const listRef = useRef(null);
  const knownKeys = useRef("");
  const keys = [...jobs.keys()].join(",");

  useGSAP(
    () => {
      if (REDUCED) return;
      // 只对新增的行做入场，已有的行不重放（换状态时内容换树但 key 不变）。
      const previous = knownKeys.current ? knownKeys.current.split(",") : [];
      const fresh = [...listRef.current?.children ?? []].filter(
        (child) => !previous.includes(child.dataset.jobId),
      );
      knownKeys.current = keys;
      if (!fresh.length) return;
      gsap.fromTo(
        fresh,
        { autoAlpha: 0, y: 10, scale: 0.9 },
        { autoAlpha: 1, y: 0, scale: 1, duration: 0.36, ease: "back.out(1.8)", stagger: 0.06, clearProps: "transform" },
      );
    },
    { dependencies: [keys] },
  );

  const lines = [...jobs.entries()];
  if (!lines.length) {
    knownKeys.current = "";
    return null;
  }
  return (
    <div className="bake-hud" aria-label="起稿进度" ref={listRef}>
      {lines.map(([jobId, job]) => (
        <p
          key={jobId}
          data-job-id={jobId}
          className={"bake-line " + job.status}
          role={job.status === "error" ? "alert" : "status"}
        >
          {job.status === "running" ? (
            <>
              <span className="bake-title">《{job.bookTitle}》</span>
              <span className="bake-percent mono">
                <FxNum value={Math.round(job.percent ?? 0)} format={(v) => `${Math.round(v)}%`} />
              </span>
              <button
                type="button"
                className="bake-x"
                title="取消起稿"
                aria-label={`取消《${job.bookTitle}》的起稿`}
                onClick={() => onCancel(jobId)}
              >
                ✕
              </button>
            </>
          ) : job.status === "done" ? (
            <>
              <button
                type="button"
                className="bake-done-link"
                title={job.degraded ? "档案有降级标记，可照常入卷" : "进入这本书"}
                onClick={() => onEnter(job.bookId, jobId)}
              >
                《{job.bookTitle}》成卷 · 入画
              </button>
              <button
                type="button"
                className="bake-x"
                title="收起这行"
                aria-label={`收起《${job.bookTitle}》的成卷提示`}
                onClick={() => onDismiss(jobId)}
              >
                ✕
              </button>
            </>
          ) : (
            <>
              <span className="bake-title err" title={job.message ? mapTerms(job.message) : "未知错误"}>
                《{job.bookTitle}》未成
              </span>
              {job.retryable ? (
                <button type="button" className="bake-done-link" onClick={() => onRetry(jobId)}>
                  重试
                </button>
              ) : null}
              <button
                type="button"
                className="bake-x"
                title="知道了"
                aria-label={`收起《${job.bookTitle}》的失败提示`}
                onClick={() => onDismiss(jobId)}
              >
                ✕
              </button>
            </>
          )}
        </p>
      ))}
    </div>
  );
}
