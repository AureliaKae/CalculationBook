import { useRef } from "react";
import { useGSAP } from "@gsap/react";
import gsap from "gsap";

import Hint from "./Hint.jsx";
import { REDUCED } from "../lib/motion.js";

/* 身份转变卡与身份重选卡（A1/A2，拍板 2026-08-19）：
   引擎会挂起 pendingRoleTransition（身份进阶的常规事件）、续读会标记
   roleDangling（目录失配）——此前两者都只有拦截没有出口，卡死对局。
   这两张卡是它们的稿面出口：转变卡=接纳/拒绝；重选卡=从本书目录重选身份。
   入场是仪式串场（拍板 2026-08-21）：改题印→标题→正文→操作区逐级落定，
   与判词（Epitaph）同一套 delay 算式词汇。 */

export function TransitionCard({ data, onResolve }) {
  const ref = useRef(null);

  useGSAP(
    () => {
      if (REDUCED || !ref.current) return;
      gsap
        .timeline()
        .fromTo(
          ref.current.querySelector(".role-mark"),
          { autoAlpha: 0, y: 8, scale: 0.9 },
          { autoAlpha: 1, y: 0, scale: 1, duration: 0.4, ease: "back.out(1.8)" },
        )
        .fromTo(
          ref.current.querySelector(".role-title"),
          { autoAlpha: 0, y: 10, scale: 0.96 },
          { autoAlpha: 1, y: 0, scale: 1, duration: 0.45, ease: "back.out(1.6)" },
          "-=0.15",
        )
        .fromTo(
          ref.current.querySelectorAll(".role-desc, .role-reason, .role-mods"),
          { autoAlpha: 0 },
          { autoAlpha: 1, duration: 0.5, ease: "none", stagger: 0.18 },
          "-=0.1",
        )
        .fromTo(
          ref.current.querySelector(".imp-acts"),
          { autoAlpha: 0, y: 10, scale: 0.95 },
          { autoAlpha: 1, y: 0, scale: 1, duration: 0.45, ease: "back.out(1.6)" },
          "-=0.15",
        );
    },
    { dependencies: [] },
  );

  if (!data) return null;
  return (
    <section className="role-card" aria-label="身份转变" ref={ref}>
      <p className="role-mark">
        改 题
        <Hint text="身份进阶的关口：跨过它，换一张身份卡，属性随之增减。也可以拒绝，继续走旧路。" />
      </p>
      <h3 className="role-title">
        {data.fromRoleName} → {data.toRole?.name ?? "新的身份"}
      </h3>
      {data.toRole?.description ? <p className="role-desc">{data.toRole.description}</p> : null}
      {data.reason ? <p className="role-reason">缘由 · {data.reason}</p> : null}
      {data.modifiers?.length ? (
        <p className="role-mods">
          {data.modifiers.map((m, i) => (
            <span key={i}>
              {m.name}
              {m.delta > 0 ? `＋${m.delta}` : m.delta < 0 ? m.delta : ""}
            </span>
          ))}
        </p>
      ) : null}
      <div className="imp-acts">
        <button type="button" className="ghost-btn" onClick={() => onResolve(false)}>
          拒绝此路
        </button>
        <button type="button" className="pen-submit" onClick={() => onResolve(true)}>
          接纳新身份
        </button>
      </div>
    </section>
  );
}

export function ReselectCard({ world, onReselect }) {
  const ref = useRef(null);

  useGSAP(
    () => {
      if (REDUCED || !ref.current) return;
      gsap.fromTo(
        ref.current.children,
        { autoAlpha: 0, y: 10, scale: 0.96 },
        { autoAlpha: 1, y: 0, scale: 1, duration: 0.42, ease: "back.out(1.6)", stagger: 0.07, clearProps: "transform" },
      );
    },
    { dependencies: [] },
  );

  const roles = world?.roleTemplates ?? [];
  return (
    <section className="role-card" aria-label="重选身份" ref={ref}>
      <p className="role-mark">
        改 题
        <Hint text="换机器或沿用旧档时偶发：书里的身份目录对不上档里的当前身份。" />
      </p>
      <h3 className="role-title">当前身份已不在本书目录</h3>
      <p className="role-desc">从本书的身份目录里重选一个来路——心性与所求原样保留。</p>
      {roles.length ? (
        <div className="role-list">
          {roles.map((role) => (
            <button
              key={role.id}
              type="button"
              className="cand role-pick"
              onClick={() => onReselect(role.id)}
            >
              <span className="cand-v">{role.name}</span>
              {role.description ? (
                <span className="cand-note">{String(role.description).slice(0, 26)}</span>
              ) : null}
            </button>
          ))}
        </div>
      ) : (
        <p className="role-desc">这本书的身份目录暂无可选来路——返回后重新起稿这一本。</p>
      )}
    </section>
  );
}
