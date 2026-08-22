import { useEffect, useRef, useState } from "react";
import { useGSAP } from "@gsap/react";
import gsap from "gsap";

import { api } from "../lib/bridge.js";
import { mapTerms } from "../lib/terms.js";
import Hint from "./Hint.jsx";
import { REDUCED } from "../lib/motion.js";

// 文房「账目」面板：BYOK 成本感知——按书累计的输入/输出 token 与请求数。
// 定性字数换算（1 token ≈ 0.6 个汉字，只给量级不给价格）。
const wanzi = (tokens) => {
  const chars = tokens * 0.6;
  if (chars >= 10000) return `约 ${(chars / 10000).toFixed(1)} 万字`;
  return `约 ${Math.round(chars / 100) / 10} 千字`;
};

export default function UsagePanel() {
  const [data, setData] = useState(null);
  const [error, setError] = useState("");
  const [attempt, setAttempt] = useState(0);
  const listRef = useRef(null);

  // 账目行逐条弹出：异步数据回来时不再整块干切。
  useGSAP(
    () => {
      if (REDUCED || !listRef.current) return;
      gsap.fromTo(
        listRef.current.querySelectorAll("div"),
        { autoAlpha: 0, y: 8, scale: 0.97 },
        { autoAlpha: 1, y: 0, scale: 1, duration: 0.36, ease: "back.out(1.5)", stagger: 0.05, clearProps: "transform" },
      );
    },
    { dependencies: [data] },
  );

  useEffect(() => {
    let alive = true;
    setError("");
    api.settings
      .usage()
      .then((result) => alive && setData(result))
      .catch((e) => alive && setError(mapTerms(e?.message ?? "账目读取失败")));
    return () => {
      alive = false;
    };
  }, [attempt]);

  if (error) {
    return (
      <div className="usage-error">
        <p className="studio-note">{error}</p>
        <button
          type="button"
          className="ghost-btn"
          onClick={() => setAttempt((count) => count + 1)}
        >
          重试
        </button>
      </div>
    );
  }
  if (!data) return <p className="studio-note">账目翻开中…</p>;
  if (!data.books.length) {
    return <p className="studio-note">还没有用量——烧一本书、走一手，账就记上了。</p>;
  }
  return (
    <section className="brush-card">
      <div className="brush-head">
        用量账 · 全部书目
        <Hint text="入＝喂给模型的字，出＝模型写回的字，出通常比入贵。token 是计费单位，约 1 token ≈ 0.6 个汉字；费用按各家牌价自行换算。" />
      </div>
      <dl className="imp-facts" ref={listRef}>
        {data.books.map((book) => (
          <div key={book.id}>
            <dt>{book.title}</dt>
            <dd className="mono">
              入 {book.promptTokens.toLocaleString()} · 出 {book.completionTokens.toLocaleString()} ·{" "}
              {book.requests} 次
            </dd>
          </div>
        ))}
        <div>
          <dt>合计</dt>
          <dd className="mono">
            入 {data.total.promptTokens.toLocaleString()}（{wanzi(data.total.promptTokens)}）· 出{" "}
            {data.total.completionTokens.toLocaleString()} · {data.total.requests} 次
          </dd>
        </div>
      </dl>
    </section>
  );
}
