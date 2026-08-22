import { useEffect, useRef, useState } from "react";
import { useGSAP } from "@gsap/react";
import gsap from "gsap";
import ThemeToggle from "./ThemeToggle.jsx";
import ImportDialog from "./ImportDialog.jsx";
import WinCtl from "./WinCtl.jsx";
import { FxBar, pad2 } from "./fx.jsx";
import { REDUCED } from "../lib/motion.js";

/* 案头 · 绘本书架（Fiction 版骨架重构）：黄油题名块 + 白色书卡网格 +
   浮动工具坞。书卡=徽章编号顶行 + 大字书名 + 悬停浮现的操作行；
   起稿中的卡以构成条表达「已烧/未烧」。 */
export default function Desk({
  books,
  opening,
  baking,
  onOpenBook,
  onRestartBook,
  onRebakeBook,
  onChronicle,
  onRemoveBook,
  onExportBook,
  onImportWorld,
  onStudio,
  theme,
  onTheme,
  note,
  onNote,
}) {
  const [importOpen, setImportOpen] = useState(false);
  const listRef = useRef(null);

  /* 入场 = 绘本弹跳：书卡逐张弹入，白卷卡最后落定 */
  useGSAP(
    () => {
      if (REDUCED) return;
      gsap.fromTo(
        listRef.current.children,
        { opacity: 0, y: 16, scale: 0.94 },
        { opacity: 1, y: 0, scale: 1, duration: 0.46, ease: "back.out(1.6)", stagger: 0.07, clearProps: "transform" },
      );
    },
    { scope: listRef, dependencies: [books.length] },
  );

  function metaOf(book) {
    const chapters = book.chapterCount ? `${book.chapterCount} 章` : "";
    const turn = book.turn
      ? `第 ${book.turn} 手`
      : book.resumable
        ? "已入卷"
        : "未起卷";
    return [chapters, turn].filter(Boolean).join(" · ");
  }

  return (
    <div className="app">
      <header className="desk-head">
        <div className="desk-hero">
          <h1 className="desk-title">推演书</h1>
          <p className="desk-sub">入书为客，落笔成命</p>
        </div>
        <span className="desk-corner">
          <ThemeToggle theme={theme} onTheme={onTheme} />
          <WinCtl />
        </span>
      </header>

      <main className="desk-stage">
        <div className="fx-list" ref={listRef}>
          {books.map((b, index) => {
            const bakingThis =
              baking?.find((item) => item.title === b.title) ?? null;
            const openingThis = opening === b.id;
            return (
              <div
                key={b.id}
                className={
                  "fx-row" +
                  (openingThis ? " opening" : "") +
                  (bakingThis ? " baking" : "")
                }
              >
                <div className="fx-card-top">
                  <span className="fx-no">{pad2(index + 1)}</span>
                  <span className="fx-meta">
                    {bakingThis
                      ? `起稿中 ${Math.round(bakingThis.percent)}%`
                      : openingThis
                        ? "展卷中"
                        : metaOf(b)}
                  </span>
                </div>
                <button
                  type="button"
                  className="fx-main"
                  disabled={Boolean(opening)}
                  onClick={() => onOpenBook(b)}
                >
                  <span className="fx-name">《{b.title}》</span>
                </button>
                {b.degraded || b.sourceless ? (
                  <div className="fx-flags">
                    {b.degraded ? (
                      <span
                        className="fx-flag"
                        title="起稿时模型没交齐作业，引擎补了最小可玩骨架。世界偏薄，建议换强模型重新起稿"
                      >
                        档案降级
                      </span>
                    ) : null}
                    {b.sourceless ? (
                      <span
                        className="fx-flag"
                        title="导入的世界文件未带原文：文风与「原著此刻」自动降级，不支持重起稿"
                      >
                        无原文
                      </span>
                    ) : null}
                  </div>
                ) : null}
                {bakingThis ? (
                  <FxBar
                    className="hot"
                    a={Math.max(bakingThis.percent, 0.5)}
                    b={Math.max(100 - bakingThis.percent, 0.5)}
                  />
                ) : (
                  <div className="fx-acts">
                    <button
                      type="button"
                      className="fx-act"
                      title="重新开始一世（当前进度与存稿作废）"
                      disabled={Boolean(opening)}
                      onClick={() => onRestartBook(b)}
                    >
                      重开
                    </button>
                    {b.sourceless ? null : (
                      <button
                        type="button"
                        className="fx-act"
                        title="清空起稿缓存，从头重新起稿"
                        disabled={Boolean(opening)}
                        onClick={() => onRebakeBook(b)}
                      >
                        重起稿
                      </button>
                    )}
                    <button
                      type="button"
                      className="fx-act"
                      title="跨世编年史：历世生死、改命、大事与基业"
                      disabled={Boolean(opening)}
                      onClick={() => onChronicle(b)}
                    >
                      编年
                    </button>
                    <button
                      type="button"
                      className="fx-act"
                      title="导出世界文件（.cpworld），分享或备份"
                      disabled={Boolean(opening)}
                      onClick={() => onExportBook(b)}
                    >
                      分享
                    </button>
                    <button
                      type="button"
                      className="fx-act danger"
                      title="从案头移除这本书：对局、进度与存稿一并清除，起稿缓存保留"
                      disabled={Boolean(opening)}
                      onClick={() => onRemoveBook(b)}
                    >
                      下架
                    </button>
                  </div>
                )}
              </div>
            );
          })}
          <button type="button" className="fx-new" onClick={() => setImportOpen(true)}>
            <span className="fx-plus">＋</span>
            <span className="fx-name">起稿一部小说</span>
            <span className="fx-sub">择一部 .txt / .epub，起稿成卷</span>
          </button>
        </div>
      </main>

      <footer className="desk-toolbar">
        <p className="desk-note" aria-live="polite">{note}</p>
        <div className="desk-tools">
          <button type="button" className="navbit" onClick={onImportWorld}>
            导入世界
          </button>
          <button type="button" className="navbit" onClick={onStudio}>
            文房
          </button>
        </div>
      </footer>

      <ImportDialog
        open={importOpen}
        onClose={() => setImportOpen(false)}
        onBakeStarted={(job) => {
          setImportOpen(false);
          onNote(`《${job.bookTitle}》起稿中…`);
        }}
        onNote={onNote}
      />
    </div>
  );
}
