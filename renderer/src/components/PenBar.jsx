import { useEffect, useRef, useState } from "react";
import { useGSAP } from "@gsap/react";
import gsap from "gsap";

import Hint from "./Hint.jsx";
import FadeIn from "./FadeIn.jsx";
import { REDUCED } from "../lib/motion.js";

/* 落笔：稿末一条横线，写此刻想做什么（≤40 字）。
   意图历史（拍板 2026-08-19）：聚焦且未落字时浮层列最近几笔，点击填入——
   长局里常有反复起意的旧笔，不必逐字重写；开始打字即隐（不遮上方解法）。
   会话级，App 累积。 */
export default function PenBar({ prompt, history = [], onSubmit }) {
  const [text, setText] = useState("");
  const [len, setLen] = useState(0);
  const [showHistory, setShowHistory] = useState(false);
  const inputRef = useRef(null);
  const formRef = useRef(null);

  /* 挂载入场：落笔区随解法一起弹入（phase 切换重挂载时重放）。 */
  useGSAP(
    () => {
      if (REDUCED) return;
      gsap.fromTo(
        formRef.current,
        { autoAlpha: 0, y: 10, scale: 0.97 },
        { autoAlpha: 1, y: 0, scale: 1, duration: 0.4, ease: "back.out(1.6)", clearProps: "transform" },
      );
    },
    { dependencies: [] },
  );

  function change(e) {
    // 按码点截断（D13）：UTF-16 截断会把生僻字从代理对中间劈开，产出乱码。
    const v = [...e.target.value].slice(0, 40).join("");
    setText(v);
    setLen([...v].length);
  }

  function commit() {
    const trimmed = text.trim();
    if (!trimmed) return;
    onSubmit(trimmed);
    // 落笔已上稿面（回声行），输入条清空：下一次起意从新字开始
    setText("");
    setLen(0);
    setShowHistory(false);
  }

  function submit(e) {
    e.preventDefault();
    commit();
  }

  function onKeyDown(e) {
    if (e.key === "Enter") {
      e.preventDefault();
      commit();
    }
    if (e.key === "Escape") setShowHistory(false);
  }

  function pick(item) {
    setText(item);
    setLen([...item].length);
    setShowHistory(false);
    inputRef.current?.focus();
  }

  return (
    <form className="pen" onSubmit={submit} ref={formRef}>
      <p className="pen-label">
        落笔 · {prompt}
        <Hint text="写下这一刻想做的事，四十字以内。引擎围绕它给出几条可行解法，选一条暗骰落定。" />
      </p>
      <div className="pen-row">
        <input
          ref={inputRef}
          className="pen-input"
          type="text"
          value={text}
          onChange={change}
          onKeyDown={onKeyDown}
          onFocus={() => setShowHistory(true)}
          onBlur={() => setShowHistory(false)}
          placeholder="此刻想做什么……"
          aria-label="落笔：写下此刻意图"
          autoComplete="off"
        />
        <span className={"pen-count" + (len >= 40 ? " full" : "")}>{len}/40</span>
        <button type="submit" className="pen-submit" disabled={!text.trim()}>
          落笔
        </button>
      </div>
      {showHistory && !text.trim() && history.length ? (
        <FadeIn as="ul" className="pen-history" aria-label="最近落笔">
          {history.slice(0, 6).map((item, index) => (
            <li key={`${index}-${item}`}>
              <button type="button" onMouseDown={(e) => e.preventDefault()} onClick={() => pick(item)}>
                {item}
              </button>
            </li>
          ))}
        </FadeIn>
      ) : null}
    </form>
  );
}
