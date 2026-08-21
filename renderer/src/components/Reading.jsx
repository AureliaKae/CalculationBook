import { useEffect, useMemo, useRef, useState } from "react";
import { useGSAP } from "@gsap/react";
import gsap from "gsap";
import TopBar from "./TopBar.jsx";
import Hint from "./Hint.jsx";
import FadeIn from "./FadeIn.jsx";
import Prose from "./Prose.jsx";
import PenBar from "./PenBar.jsx";
import Options from "./Options.jsx";
import Epitaph from "./Epitaph.jsx";
import DeriveStrip from "./DeriveStrip.jsx";
import { TransitionCard, ReselectCard } from "./TransitionCards.jsx";
import IntentPanel from "./IntentPanel.jsx";
import TypewriterNote from "./TypewriterNote.jsx";
import CharDialog from "./CharDialog.jsx";
import PersonDialog from "./PersonDialog.jsx";
import { REDUCED } from "../lib/motion.js";
import { narrativeParagraphs, notesFromTurn, epitaphLines } from "../lib/view.js";

/* 推演台：视图驱动（真桥/mock 桥同形）。白纸大卡——开局楔子 + 逐手叙事，
   落笔→演算→解法→判定→留痕循环，殁则判词、卷终则收卷。
   演算动画在正文下方：落笔→选项用简单公式，选解→回合用相位驱动的深推演。 */
export default function Reading({
  pc,
  view,
  phase, // read | deriving | options | resolving | resolved
  storyPhase,
  inkDraft,
  inkTotal = 0,
  chosenId,
  intents, // 本手内的落笔痕迹（按序，改主意追加不替换）
  intentHistory = [], // 会话级意图历史（最近落笔，PenBar 快捷重发）
  active = true,
  theme,
  onTheme,
  onDesk,
  onMap,
  onExport,
  onStudio,
  onIntent,
  onChoose,
  onRestart,
  onContinueStage,
  onResolveTransition,
  onReselectRole,
  onSetGoal,
  onSetScheme,
  onStopPlay,
}) {
  const wrapRef = useRef(null);
  const sheetRef = useRef(null);
  const [deepPhases, setDeepPhases] = useState([]);
  // 角色卡弹窗（拍板 2026-08-19：边注「此身」摘要点击展开详情）。
  const [charOpen, setCharOpen] = useState(false);
  // 人物卡弹窗（拍板 2026-08-19：关系簿点击展开原著人物的一面）。
  const [personOpenId, setPersonOpenId] = useState(null);
  // 空数组兜底走 useMemo：裸 `?? []` 每次渲染都是新引用，会抖动依赖它的效果。
  const turns = useMemo(() => view?.turns ?? [], [view?.turns]);
  const lastTurn = turns.at(-1) ?? null;
  const ending = view?.ending ?? null;
  const pad = (n) => String(n).padStart(2, "0");
  const turnCount = turns.length;

  /* 新一手落墨完成后，自动回到这段正文的开头供从头读 */
  /* 重进直达最新（2026-08-19）：挂载（续读/回案头再进）时立即定位到最后一手，
     不再等落墨延时——那是「看新一手写完再滚过去」的节奏，旧稿不该陪跑。 */
  const scrollRanFor = useRef(false);
  useEffect(() => {
    if (turnCount === 0 || !sheetRef.current) return;
    const hands = sheetRef.current.querySelectorAll(".hand");
    const latest = hands[hands.length - 1];
    if (!latest) return;
    const isMount = !scrollRanFor.current;
    scrollRanFor.current = true;
    const text = turns.at(-1)?.narrative ?? "";
    const inkMs = REDUCED
      ? 0
      : isMount
        ? 700 /* 只等稿面入场动画收尾，随定位即达 */
        : Math.min(3500, Math.max(800, [...text].length * 11 + 600));
    const timer = setTimeout(() => {
      const top = latest.getBoundingClientRect().top + window.scrollY - 64;
      window.scrollTo({ top: Math.max(0, top), behavior: REDUCED || isMount ? "auto" : "smooth" });
    }, inkMs);
    return () => clearTimeout(timer);
    // turns 与 turnCount 同源同变（新一手）；依赖 turns 让规则可校，
    // 行为与原先只看条数完全一致。
  }, [turns, turnCount]);

  /* 深演算：进入 resolving 清零，引擎相位逐个入稿 */
  useEffect(() => {
    if (phase !== "resolving") setDeepPhases([]);
  }, [phase]);

  useEffect(() => {
    if (phase !== "resolving" || !storyPhase) return;
    setDeepPhases((list) => (list[list.length - 1] === storyPhase ? list : [...list, storyPhase]));
  }, [storyPhase, phase]);

  /* 数字键直选（仅当面可见且解法在场） */
  useEffect(() => {
    if (phase !== "options" || !active) return;
    const onKey = (e) => {
      if (e.target instanceof HTMLElement && /^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName)) return;
      const options = view?.options ?? [];
      const n = Number(e.key);
      if (Number.isInteger(n) && n >= 1 && n <= options.length) onChoose(options[n - 1]);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [phase, view, onChoose, active]);

  useGSAP(
    () => {
      if (REDUCED) return;
      // 稿面入场：弹性放大浮现（Fiction 版——去手稿轻旋，改绘本弹入）。
      gsap.fromTo(
        wrapRef.current,
        { yPercent: 3, scale: 0.99, autoAlpha: 0 },
        { yPercent: 0, scale: 1, autoAlpha: 1, duration: 0.55, ease: "back.out(1.2)", clearProps: "transform" },
      );
    },
    { scope: wrapRef, dependencies: [view?.bookId] },
  );

  // 关键回合（强模型全笔）在状态行说明：读屏与速览都能知道这一手为何更慢。
  const isKeyTurn = deepPhases.includes("key-turn");
  const phaseLabel = {
    read: view?.nextKeyTurn ? "关键回合在即——落笔需慎" : "",
    deriving: "演算中",
    options: view?.nextKeyTurn ? "关键回合——演算既毕，有解如左，落子需慎" : "演算既毕，有解如左",
    resolving: isKeyTurn ? "关键回合推演中——用强笔细写，需多等片刻" : "回合推演中",
    resolved: ending ? "此稿结案" : "后果已落定",
  }[phase];
  const notes = lastTurn ? notesFromTurn(lastTurn, view) : [];

  return (
    <div className="app app-reading">
      <p className="sr-status" aria-live="polite">{phaseLabel}</p>
      <TopBar
        book={{ title: view?.title ?? "", chapter: "" }}
        no={turnCount}
        total={turnCount}
        mode="hand"
        clock={view?.clock ?? ""}
        theme={theme}
        onTheme={onTheme}
        onDesk={onDesk}
        onMap={onMap}
        onStudio={onStudio}
        onExport={onExport}
      />

      <main className="stage">
        <div className="sheet-wrap" ref={wrapRef}>
          <article className="sheet" ref={sheetRef}>
            <div className="sheet-main">
                <header className="scene-head">
                  <h1 className="scene-title">{view?.title}</h1>
                  <span className="scene-no">手 {pad(turnCount)}</span>
                </header>
                <hr className="scene-rule" />

                {view?.opening && (
                  <section className="prologue">
                    <p className="prologue-mark">楔</p>
                    <Prose paragraphs={narrativeParagraphs(view.opening)} animate={turnCount === 0} />
                  </section>
                )}

                {turns.map((turn, index) => (
                  <section className="hand" key={turn.number}>
                    <p className="hand-mark mono" aria-label={`第 ${turn.number} 手`}>
                      {pad(turn.number)}
                    </p>
                    <Prose
                      paragraphs={narrativeParagraphs(turn.narrative)}
                      animate={index >= turns.length - 1}
                    />
                  </section>
                ))}

                {/* 身份转变卡/重选卡(A1/A2):挂起的转变与目录失配在此给出稿面
                    出口——有卡时替代落笔/解法流,处理完才回到回合循环。 */}
                {view?.roleTransition ? (
                  <TransitionCard data={view.roleTransition} onResolve={onResolveTransition} />
                ) : view?.roleReselect ? (
                  <ReselectCard world={view.roleWorld} onReselect={onReselectRole} />
                ) : ending?.type === "death" ? (
                  <Epitaph
                    seal="结"
                    kicker="判词 · 此稿归档"
                    lines={epitaphLines(ending, pc?.name)}
                    onRestart={onRestart}
                    onDesk={onDesk}
                  />
                ) : ending?.type === "stage" ? (
                  <Epitaph
                    seal="卷"
                    kicker="收卷 · 此卷归档"
                    lines={epitaphLines(ending, pc?.name)}
                    onRestart={onRestart}
                    restartLabel="另起一稿"
                    onContinue={onContinueStage}
                    continueLabel="续写新阶段"
                    onDesk={onDesk}
                  />
                ) : (
                  <>
                    {/* 演算条：AI 底层的真实数学逐行演算（矩阵乘法/条件概率），
                        正文下方；resolving 期间稿面只留演算——其余隐去。 */}
                    {phase === "deriving" && (
                      <FadeIn>
                        <DeriveStrip mode="simple" />
                      </FadeIn>
                    )}
                    {phase === "resolving" && (
                      <>
                        <FadeIn>
                          <DeriveStrip
                            mode="deep"
                            phases={deepPhases.length ? deepPhases : ["directing"]}
                            inkedChars={inkTotal}
                            onStop={onStopPlay}
                          />
                        </FadeIn>
                        {/* 流式叙事（拍板 2026-08-19）：未定稿正文渐显——
                            onDiscard 清空重来，落定后由正式叙事取代。 */}
                        {inkDraft ? (
                          <FadeIn as="section" className="ink-draft" aria-hidden="true">
                            <p className="ink-draft-label">
                              正在落墨 · 未定稿<span title="界面只留末尾约千字防涨内存；整回正文以落定稿为准">（只显末段）</span>
                            </p>
                            <p className="ink-draft-text">
                              {inkDraft}
                              <span className="ink-caret" />
                            </p>
                          </FadeIn>
                        ) : null}
                      </>
                    )}

                    {(phase === "read" || phase === "options") && view?.nextKeyTurn && (
                      /* 关键回合预判：玩家落笔/看解法时就亮出（朱红），落子前
                         即知这一手分量重——不等推演开始才交代。 */
                      <FadeIn as="p" className="key-turn-note">
                        <b className="ds-key">关键回合</b>
                        ——这一手关系重大：落子需慎，推演用强笔细写，需多等片刻。
                      </FadeIn>
                    )}

                    {(phase === "options") && (
                      <>
                        {(intents ?? []).map((text, i) => (
                          <FadeIn as="p" className="echo" key={i}>
                            落笔 · 「{text}」
                          </FadeIn>
                        ))}
                        <Options
                          options={view?.options ?? []}
                          chosenId={chosenId}
                          onChoose={onChoose}
                        />
                      </>
                    )}

                    {(phase === "read" || phase === "options" || phase === "resolved") && (
                    <PenBar
                      prompt={
                        phase === "options"
                          ? "另写一笔，解法随之重来——不耗手数"
                          : turnCount === 0
                            ? "第一手想做什么？"
                            : "此刻想做什么？"
                      }
                      history={intentHistory}
                      onSubmit={onIntent}
                    />
                    )}
                  </>
                )}
              </div>
          </article>
        </div>

        {/* 便签栏（Fiction 版骨架重构）：从稿纸内拆出，与书页卡并立的双栏 */}
        <aside className="margin-col" aria-label="边注">
                {/* 意图面板：三层意图中「志向/谋算」两层的界面出口 */}
                <IntentPanel
                  goal={view?.goal}
                  scheme={view?.scheme}
                  onSetGoal={onSetGoal}
                  onSetScheme={onSetScheme}
                />
                {/* 行迹：最近的选择与判定成败（倒序） */}
                {view?.footsteps?.length ? (
                  <section className="margin-sec" aria-label="行迹">
                    <p className="ms-mark">
                      行 迹
                      <Hint text="最近几手的行动与成败，倒序。写了什么、成没成，都在这里。" />
                    </p>
                    <ul className="foot-list">
                      {view.footsteps.slice(0, 8).map((step) => (
                        <li
                          key={step.number}
                          className={
                            "foot-item" +
                            (step.result === "failure" || step.result === "critical_failure"
                              ? " bad"
                              : step.result === "success" || step.result === "critical_success"
                                ? " ok"
                                : "")
                          }
                        >
                          <span className="foot-no">{pad(step.number)}</span>
                          <span className="foot-text">{step.choice || "—"}</span>
                        </li>
                      ))}
                    </ul>
                  </section>
                ) : null}
                {/* 原著主线区块已下线（2026-08-21 用户拍板）：POV 现状卡的
                    summary 硬截 30 字、大事归属按「事件文本含主角名」匹配，
                    刺客类他人主语事件误挂主角卡，内容不可信——整段移除。 */}
                {/* 关系簿（拍板 2026-08-19）：已遇人物定性档，点击开人物卡。 */}
                {view?.relations ? (
                  <section className="margin-sec" aria-label="关系簿">
                    <p className="ms-mark">
                      关 系 簿
                      <Hint text="遇过的人与交情深浅，点击开人物卡。「一面之缘」是还没打熟的生分。" />
                    </p>
                    <ul className="rel-list">
                      {view.relations.entries.map((entry) => (
                        <li key={entry.id}>
                          <button
                            type="button"
                            className="rel-item"
                            onClick={() => setPersonOpenId(entry.id)}
                          >
                            <span className="rel-name">{entry.name}</span>
                            <span className={"rel-stance tone-" + (entry.stance?.tone ?? "cool")}>
                              {entry.stance?.label ?? "一面之缘"}
                            </span>
                            {entry.summary ? <span className="rel-note">{entry.summary}</span> : null}
                          </button>
                        </li>
                      ))}
                    </ul>
                    {view.relations.more > 0 ? (
                      <p className="rel-more">等 {view.relations.more} 人</p>
                    ) : null}
                  </section>
                ) : null}
                {/* 此身摘要（拍板 2026-08-19）：点击开角色卡详情。 */}
                {view?.playerSheet ? (
                  <section className="margin-sec" aria-label="此身">
                    <p className="ms-mark">
                      此 身
                      <Hint text="你的角色卡：境界、技能、行囊。点击展开细看。" />
                    </p>
                    <button type="button" className="proto-self" onClick={() => setCharOpen(true)}>
                      <span className="proto-self-realm">{view.playerSheet.realm.current ?? "无境界之身"}</span>
                      <span className="proto-self-counts">
                        技能{view.playerSheet.abilities.length} · 行囊{view.playerSheet.inventory.length}
                      </span>
                    </button>
                  </section>
                ) : null}
                {notes.length > 0 && (
                  <ul className="notes">
                    {notes.map((n, i) => (
                      <TypewriterNote key={`${turnCount}-${i}`} text={n.text} kind={n.kind} order={i} />
                    ))}
                  </ul>
                )}
        </aside>
      </main>
      <CharDialog
        open={charOpen}
        sheet={view?.playerSheet}
        journal={view?.journal ?? []}
        onClose={() => setCharOpen(false)}
      />
      <PersonDialog
        open={Boolean(personOpenId)}
        person={(view?.relations?.entries ?? []).find((entry) => entry.id === personOpenId) ?? null}
        onClose={() => setPersonOpenId(null)}
      />
    </div>
  );
}
