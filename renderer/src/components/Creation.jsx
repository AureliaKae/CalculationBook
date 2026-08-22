import { useMemo, useRef, useState } from "react";
import { useGSAP } from "@gsap/react";
import gsap from "gsap";
import { REDUCED } from "../lib/motion.js";
import DeriveStrip from "./DeriveStrip.jsx";
import Hint from "./Hint.jsx";
import FadeIn from "./FadeIn.jsx";
import WinCtl from "./WinCtl.jsx";
import { realmTraitsOf } from "../lib/engine-display.js";

const BIG_FIVE_LABELS = {
  openness: "开放性",
  conscientiousness: "尽责性",
  extraversion: "外向性",
  agreeableness: "宜人性",
  neuroticism: "情绪稳定性",
};
const BIG_FIVE_ORDER = Object.keys(BIG_FIVE_LABELS);

/* 开题（拍板 2026-08-20 R14：退回最初形态）：单页五控件——性别两键、姓名
   底线输入、落点选单、境界选单（无阶梯书隐藏）、入世之志底线输入（可空，
   空则书目录默认兜底）+「落笔入卷」。身份由引擎静默自动配平朴来路（UI 不问
   不显，角色卡可见），背景不写——玩家是无背景新来者，开场按新来者约束走。
   建角零模型调用（只剩开场一次）。successor 模式同一页，预填前世性别/落点/
   境界，前世五维只读展示。 */
export default function Creation({ world, successor = false, prefill, storyPhase = "", onDone, onCancel }) {
  const [gender, setGender] = useState(prefill?.gender ?? null);
  const [name, setName] = useState("");
  const [motivation, setMotivation] = useState("");
  const [locationId, setLocationId] = useState(prefill?.locationId ?? "");
  const [realmTraitId, setRealmTraitId] = useState(
    prefill?.realmTraitId && String(prefill.realmTraitId).trim() ? prefill.realmTraitId : "",
  );
  // 词旁选单（落点/境界）：点当前值红字弹出本书目录。
  const [chooser, setChooser] = useState(null); // { slot: "location" | "realm", left, top, width }
  const [err, setErr] = useState("");
  // 定约后的入卷等待：开场由模型逐字写下（数十秒），必须给出活的反馈。
  const [busy, setBusy] = useState(false);
  const bodyRef = useRef(null);

  const locations = world?.locations ?? [];
  const realms = useMemo(
    () => (world?.realmTraits?.length ? world.realmTraits : realmTraitsOf(world)),
    [world],
  );
  // 原著人名清单（客户端实时提示用；落笔的最终守卫在引擎）。
  const canonNames = useMemo(
    () =>
      (world?.characters ?? [])
        .map((c) => String(c?.name ?? "").trim())
        .filter((n) => n.length >= 2),
    [world],
  );
  const hitsCanon = (text) => canonNames.some((n) => text.includes(n));

  // 转世继承的五维档位（只读展示）：≥70 偏高、≤30 偏低、其余均衡。
  const inheritedBigFive = useMemo(() => {
    const values = successor ? prefill?.bigFive : null;
    if (!values || typeof values !== "object") return null;
    return Object.fromEntries(
      BIG_FIVE_ORDER.map((dim) => {
        const score = Number(values[dim]);
        const level = !Number.isFinite(score)
          ? "均衡"
          : score >= 70
            ? "偏高"
            : score <= 30
              ? "偏低"
              : "均衡";
        return [dim, level];
      }),
    );
  }, [successor, prefill]);

  useGSAP(
    () => {
      if (REDUCED) return;
      gsap.fromTo(
        bodyRef.current.children,
        { opacity: 0, y: 12, scale: 0.97 },
        { opacity: 1, y: 0, scale: 1, duration: 0.44, ease: "back.out(1.5)", stagger: 0.06, clearProps: "transform" },
      );
    },
    { scope: bodyRef },
  );

  function openChooser(slot, element) {
    const rect = element.getBoundingClientRect();
    setChooser({ slot, left: rect.left, top: rect.bottom, width: rect.width });
  }
  const closeChooser = () => setChooser(null);

  const nameHint = (() => {
    const trimmed = name.trim();
    if (!trimmed) return "";
    if ([...trimmed].length > 20) return "名字至多二十字。";
    if (hitsCanon(trimmed)) return "这个名字属于原著中的人——请另起。";
    return "";
  })();

  async function confirm() {
    if (busy) return;
    const trimmed = name.trim();
    if (!trimmed) {
      setErr("还没写名字。");
      return;
    }
    if (nameHint) {
      setErr(nameHint);
      return;
    }
    if (!gender) {
      setErr("性别未定。");
      return;
    }
    if (!locationId || !locations.some((item) => item.id === locationId)) {
      setErr("落点未定——选一处首次登场的地方。");
      return;
    }
    setErr("");
    setBusy(true);
    try {
      // onDone（建角→开场叙事）内部自吞错误：无论成败都要收起忙态。
      // 身份静默自动配、背景不传（无背景新来者）；底色不随建角提交
      // （中庸起步拍板），转世继承分值由主进程侧落档。
      await onDone({
        name: trimmed,
        gender,
        locationId,
        realmTraitId: realmTraitId || undefined,
        motivation: motivation.trim(),
        successor,
      });
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="app creation">
      <header className="cre-head">
        <button type="button" className="ghost-btn" disabled={busy} onClick={onCancel}>
          {successor ? "回终局" : "返回"}
        </button>
        <span className="cre-title">{successor ? "开启新一世" : "建立角色"}</span>
        <WinCtl />
      </header>

      <main className="cre-stage">
        <div className="cre-sheet" ref={bodyRef}>
          {busy ? (
            <div className="cre-wait" aria-live="polite">
              <h2 className="cre-q">{successor ? "正在开启新一世" : "正在开始游戏"}</h2>
              <p className="cre-hint">
                依你的选择写下开场——这一段要生成片刻，且看它写成什么。
              </p>
              <DeriveStrip mode="simple" phases={[storyPhase || "opening"]} />
            </div>
          ) : (
            <>
              <h2 className="cre-q">{successor ? "开启新一世" : "建立角色"}</h2>
              <p className="cre-hint">
                {successor
                  ? "新的一世重新开始——此问只定起点，不定命数。"
                  : "此问只定起点，不定命数——性子由故事养出来，身份由引擎配来路。"}
              </p>

              <div className="cre-field">
                <span className="cre-label">性别</span>
                <div className="cre-gender">
                  <button
                    type="button"
                    className={"cre-g" + (gender === "male" ? " on" : "")}
                    onClick={() => setGender("male")}
                  >
                    男
                  </button>
                  <button
                    type="button"
                    className={"cre-g" + (gender === "female" ? " on" : "")}
                    onClick={() => setGender("female")}
                  >
                    女
                  </button>
                </div>
              </div>

              <div className="cre-field">
                <span className="cre-label">姓名</span>
                <input
                  className="cre-wish-input"
                  type="text"
                  value={name}
                  maxLength={20}
                  placeholder="题个名字（1-20 字）"
                  aria-label="角色姓名"
                  onChange={(e) => setName(e.target.value)}
                />
              </div>

              <div className="cre-field">
                <span className="cre-label">
                  落点
                  <Hint text="新角色首次登场的地方。从哪里进书，先遇见谁，都由它定。" />
                </span>
                <button
                  type="button"
                  className="cre-pick"
                  aria-label="选落点"
                  onClick={(e) => openChooser("location", e.currentTarget)}
                >
                  {locations.find((l) => l.id === locationId)?.name ?? "——选一处"}
                </button>
              </div>

              {realms.length > 0 && (
                <div className="cre-field">
                  <span className="cre-label">
                    境界
                    <Hint text="起步的高低，只决定入场姿态；之后靠此身在故事里突破。「不谙」是白身入书。" />
                  </span>
                  <button
                    type="button"
                    className="cre-pick"
                    aria-label="选境界"
                    onClick={(e) => openChooser("realm", e.currentTarget)}
                  >
                    {realms.find((t) => t.id === realmTraitId)?.name ?? "不谙"}
                  </button>
                </div>
              )}

              <div className="cre-field">
                <span className="cre-label">
                  这一世的目标
                  <Hint text="这一世的长线目标。引擎据此安排故事走向；空着也行，先跟着书里的默认走。" />
                </span>
                <input
                  className="cre-wish-input"
                  type="text"
                  value={motivation}
                  maxLength={120}
                  placeholder="这一世想成什么事（可空——空则依书里的默认）"
                  aria-label="这一世的目标"
                  onChange={(e) => setMotivation(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") {
                      e.preventDefault();
                      confirm();
                    }
                  }}
                />
              </div>

              {successor && inheritedBigFive ? (
                <>
                  <p className="cre-base-note">
                    习性难改——上一世养成的性子随你转世，写不清意图时它仍会替你拿主意，此后每一步继续重塑它。
                    <Hint text="心性五维：开放性、尽责性、外向性、宜人性、情绪稳定性。转世时全额带走。" />
                  </p>
                  <div className="bf-options">
                    {BIG_FIVE_ORDER.map((dim) => {
                      const level = inheritedBigFive[dim];
                      return (
                        <span key={dim} className={"bf-chip" + (level !== "均衡" ? " tilt" : "")}>
                          {BIG_FIVE_LABELS[dim]}
                          {level !== "均衡" ? ` · ${level}` : ""}
                        </span>
                      );
                    })}
                  </div>
                </>
              ) : null}

              {nameHint && <p className="cre-err">{nameHint}</p>}
              {err && <p className="cre-err">{err}</p>}

              <div className="imp-acts">
                <button type="button" className="pen-submit" onClick={confirm}>
                  {successor ? "开启新一世" : "开始游戏"}
                </button>
              </div>

              {/* 词旁选单：贴着被点的值浮出，只列本书目录（原文固定的靠选）。 */}
              {chooser && (
                <>
                  <div className="cre-drop-veil" onClick={closeChooser} aria-hidden="true" />
                  <FadeIn
                    className="cre-drop"
                    style={{
                      left: Math.min(chooser.left, Math.max(0, window.innerWidth - 260)),
                      top: chooser.top + 6,
                      minWidth: Math.max(chooser.width, 176),
                    }}
                  >
                    {chooser.slot === "location" &&
                      locations.map((loc) => (
                        <button
                          key={loc.id}
                          type="button"
                          className="cand"
                          onClick={() => {
                            setLocationId(loc.id);
                            closeChooser();
                          }}
                        >
                          <span className="tick" aria-hidden="true" />
                          <span className="cand-v">{loc.name}</span>
                          {loc.note ? <span className="cand-note">{loc.note}</span> : null}
                        </button>
                      ))}
                    {chooser.slot === "realm" && (
                      <>
                        <button
                          type="button"
                          className="cand"
                          onClick={() => {
                            setRealmTraitId("");
                            closeChooser();
                          }}
                        >
                          <span className="tick" aria-hidden="true" />
                          <span className="cand-v">不谙</span>
                          <span className="cand-note">依来路定</span>
                        </button>
                        {realms.map((trait) => (
                          <button
                            key={trait.id}
                            type="button"
                            className="cand"
                            onClick={() => {
                              setRealmTraitId(trait.id);
                              closeChooser();
                            }}
                          >
                            <span className="tick" aria-hidden="true" />
                            <span className="cand-v">{trait.name}</span>
                            {trait.description ? (
                              <span className="cand-note">
                                {String(trait.description).slice(0, 26)}
                              </span>
                            ) : null}
                          </button>
                        ))}
                      </>
                    )}
                  </FadeIn>
                </>
              )}
            </>
          )}
        </div>
      </main>
    </div>
  );
}
