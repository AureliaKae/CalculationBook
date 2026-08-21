/* 明暗主题切换（各面头部共用） */
export default function ThemeToggle({ theme, onTheme }) {
  return (
    <div className="theme-toggle" role="group" aria-label="明暗主题">
      <button type="button" aria-pressed={theme === "paper"} onClick={() => onTheme("paper")}>
        米纸
      </button>
      <button type="button" aria-pressed={theme === "night"} onClick={() => onTheme("night")}>
        夜稿
      </button>
    </div>
  );
}
