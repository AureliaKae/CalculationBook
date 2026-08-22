import { useEffect, useRef, useState } from "react";
import { useGSAP } from "@gsap/react";
import gsap from "gsap";

import Hint from "./Hint.jsx";
import { REDUCED } from "../lib/motion.js";

/* 落笔：稿末一条横线，写此刻想做什么（≤40 字）。
   意图历史浮层已随拍板移除（2026-08-22）：不展示已落过的旧笔。 */
export default function PenBar({ prompt, onSubmit }) {
  const [text, setText] = useState("");
  const [len, setLen] = useState(0);
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
  }

  return (
    <form className="pen" onSubmit={submit} ref={formRef}>
      <p className="pen-label">
        行动 · {prompt}
        <Hint text="写下这一刻想做的事，四十字以内。引擎围绕它给出几条可行做法，选一条后自动判定结果。" />
      </p>
      <div className="pen-row">
        <input
          ref={inputRef}
          className="pen-input"
          type="text"
          value={text}
          onChange={change}
          onKeyDown={onKeyDown}
          placeholder="此刻想做什么……"
          aria-label="行动：写下此刻意图"
          autoComplete="off"
        />
        <span className={"pen-count" + (len >= 40 ? " full" : "")}>{len}/40</span>
        <button type="submit" className="pen-submit" disabled={!text.trim()}>
          发送
        </button>
      </div>
    </form>
  );
}
