import { useEffect, useRef, useState } from "react";
import { useGSAP } from "@gsap/react";
import gsap from "gsap";

import { api } from "../lib/bridge.js";
import { mapTerms } from "../lib/terms.js";
import WinCtl from "./WinCtl.jsx";
import Hint from "./Hint.jsx";
import { REDUCED } from "../lib/motion.js";

/* 跨世编年史（拍板 2026-08-19）：世界跨世延续的可读呈现。
   四段——历世生死（past-life 事实）、改命记录（player_divergence）、
   大事记（世界时间线按「第 N 日」）、当前世基业（emergentStories venture）。
   数据到位后四段逐段浮现（拍板 2026-08-21），不等加载时干切铺开。 */
export default function Chronicle({ bookId, onBack }) {
  const [data, setData] = useState(null);
  const [error, setError] = useState("");
  const [attempt, setAttempt] = useState(0);
  const bodyRef = useRef(null);

  useGSAP(
    () => {
      if (REDUCED || !data || !bodyRef.current) return;
      gsap.fromTo(
        bodyRef.current.children,
        { autoAlpha: 0, y: 12, scale: 0.97 },
        { autoAlpha: 1, y: 0, scale: 1, duration: 0.44, ease: "back.out(1.5)", stagger: 0.07, clearProps: "transform" },
      );
    },
    { dependencies: [data] },
  );

  useEffect(() => {
    let alive = true;
    setError("");
    api.library
      .chronicle(bookId)
      .then((result) => alive && setData(result))
      .catch((e) => alive && setError(mapTerms(e?.message ?? "编年史翻开失败")));
    return () => {
      alive = false;
    };
  }, [bookId, attempt]);

  return (
    <div className="app chronicle">
      <header className="topbar">
        <div>
          <span className="book">编年史</span>
          <span className="chapter">{data?.title ?? (error ? "翻开失败" : "正在翻阅…")}</span>
        </div>
        <div className="right">
          <button type="button" className="navbit" onClick={onBack}>
            收起
          </button>
          <WinCtl />
        </div>
      </header>

      <main className="map-stage">
        {error ? (
          <div className="map-empty">
            <p className="derive-status">{error}</p>
            <button
              type="button"
              className="ghost-btn"
              onClick={() => setAttempt((count) => count + 1)}
            >
              重试
            </button>
          </div>
        ) : null}
        {!error && !data ? <p className="map-empty derive-status">编年史翻开中…</p> : null}
        {data ? (
          <div className="chron-body" ref={bodyRef}>
            <section className="chron-sec">
              <p className="ms-mark">
                历 世
                <Hint text="这个世界里活过的每一世：出身、历程、生死。世界记得所有死过的人。" />
              </p>
              {data.lives.length ? (
                <ul className="chron-list">
                  {data.lives.map((life, i) => (
                    <li key={i} className="chron-item kai">{life.text}</li>
                  ))}
                </ul>
              ) : (
                <p className="chron-empty">尚无前世——这一世是这个世界见到的第一个人。</p>
              )}
            </section>
            <section className="chron-sec">
              <p className="ms-mark">
                改 命
                <Hint text="被你的手挪动过的原著大事：改写成了什么、与原文差在哪里。" />
              </p>
              {data.divergences.length ? (
                <ul className="chron-list">
                  {data.divergences.map((item, i) => (
                    <li key={i} className="chron-item kai red">{item.text}</li>
                  ))}
                </ul>
              ) : (
                <p className="chron-empty">原著的命数尚未被谁改动过。</p>
              )}
            </section>
            <section className="chron-sec">
              <p className="ms-mark">
                大 事 记
                <Hint text="世界时间线上的大事件，按故事内的日子排：既有原著的，也有被玩出来的。" />
              </p>
              {data.events.length ? (
                <ul className="chron-list">
                  {data.events.map((item, i) => (
                    <li key={i} className="chron-item">
                      <span className="chron-day">第 {item.day} 日</span>
                      <span className={item.source === "emergent" ? "emergent" : ""}>{item.text}</span>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="chron-empty">世界时间线上还没有落下大事。</p>
              )}
            </section>
            <section className="chron-sec">
              <p className="ms-mark">
                基 业
                <Hint text="当前世里亲手立起的门派、商号、势力——从「原创一笔」里长出来的家底。" />
              </p>
              {data.ventures.length ? (
                <ul className="chron-list">
                  {data.ventures.map((item, i) => (
                    <li key={i} className="chron-item kai growth">
                      {item.title}
                      {item.erupted ? " · 已成气候" : " · 生长中"}
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="chron-empty">这一世还没有经营起什么营生。</p>
              )}
            </section>
          </div>
        ) : null}
      </main>
    </div>
  );
}
