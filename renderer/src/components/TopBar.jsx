import ThemeToggle from "./ThemeToggle.jsx";
import WinCtl from "./WinCtl.jsx";
import Hint from "./Hint.jsx";
import { FxNum, pad2 } from "./fx.jsx";

/* 顶条：书名（返回）/ 设置 / 回(景)次 / 主题。
   回合数走累积数字（FxNum）：数值变化逐位趋近落定。
   时钟（拍板 2026-08-19）：故事内时间「第 N 日 · 时段」常驻计数旁——
   闭关赶路后玩家不失时间感。 */
export default function TopBar({ book, no, total, mode = "scene", clock = "", theme, onTheme, onDesk, onStudio, onExport }) {
  const counter =
    mode === "hand" ? (
      <FxNum value={no} format={(v) => `回合 ${pad2(v)}`} />
    ) : (
      `景 ${pad2(no)} / ${pad2(total)}`
    );
  return (
    <header className="topbar">
      <div>
        <button type="button" className="book book-link" onClick={onDesk} title="返回">
          《{book.title}》
        </button>
        {book.chapter ? <span className="chapter">{book.chapter}</span> : null}
      </div>
      <div className="right">
        <button type="button" className="navbit" onClick={onStudio}>
          设置
        </button>
        {onExport ? (
          <button type="button" className="navbit" onClick={onExport}>
            导出
          </button>
        ) : null}
        <span className="scene-no">
          {counter}
          <Hint
            side="left"
            text="回合＝一次行动与判定；景＝当前场景 / 全书场景数。"
          />
        </span>
        {clock ? (
          <span className="scene-no topbar-clock">
            {clock}
            <Hint
              side="left"
              text="故事时钟：故事内的日子与时段，赶路闭关都会走字——与你现实中的阅读时间无关。"
            />
          </span>
        ) : null}
        <ThemeToggle theme={theme} onTheme={onTheme} />
        <WinCtl />
      </div>
    </header>
  );
}
