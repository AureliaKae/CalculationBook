import { useEffect, useMemo, useState } from "react";
import { REDUCED } from "../lib/motion.js";
import { phaseCopy } from "../lib/engine-display.js";

/* 演算条：等待期演算的是 AI 底层的真实数学——线性代数的矩阵乘法与
   概率论的条件概率（贝叶斯）。所有数字都由代码真实计算：矩阵每一格
   逐项乘加、概率每一步按恒等式推导，非装饰性图案。
   mode: simple=意图演算，deep=回合推演（45 秒后给「停一下」）。 */

const STEP_MS = 700;
// 一轮：矩阵乘法 4 格 ×（3 项累加 + 1 步落定），条件概率 3 步推导 + 2 步停留。
const MATRIX_STEPS = 16;
const PROB_STEPS = 5;
const TOTAL_STEPS = MATRIX_STEPS + PROB_STEPS;

const CELL_ORDER = [
  [0, 0],
  [0, 1],
  [1, 0],
  [1, 1],
];
const CELL_SUB = ["₁₁", "₁₂", "₂₁", "₂₂"];

// 小整数矩阵（−3..4）：乘积与求和一眼可验，负数在算式里加括号。
function randomCell() {
  return Math.floor(Math.random() * 8) - 3;
}
function makeMatrixRound() {
  const a = Array.from({ length: 2 }, () => Array.from({ length: 3 }, randomCell));
  const b = Array.from({ length: 3 }, () => Array.from({ length: 2 }, randomCell));
  const c = Array.from({ length: 2 }, (_, i) =>
    Array.from({ length: 2 }, (_, j) => a[i][0] * b[0][j] + a[i][1] * b[1][j] + a[i][2] * b[2][j]),
  );
  return { a, b, c };
}

// 条件概率的一组自洂数值：P(A)、P(B|A)、P(B|¬A)，其余全由恒等式推出。
function makeProbRound() {
  const step = (min, max) => Math.round((min + Math.random() * (max - min)) * 20) / 20;
  const pa = step(0.2, 0.7);
  const pbGivenA = step(0.4, 0.9);
  const pbGivenNotA = step(0.1, 0.5);
  const pAB = pa * pbGivenA; // P(A∩B)
  const pNotAB = (1 - pa) * pbGivenNotA; // P(¬A∩B)
  const pb = pAB + pNotAB; // P(B) 全概率
  const paGivenB = pAB / pb; // P(A|B) 贝叶斯
  return { pa, pbGivenA, pbGivenNotA, pAB, pNotAB, pb, paGivenB };
}

const fmt = (value) => value.toFixed(2);
const term = (x, y) => `${x}·${y < 0 ? `(${y})` : y}`;

function MatrixGrid({ values, highlight }) {
  // highlight: Set("i,j")——正在参与运算的行/列。
  return (
    <div className="ms-grid" style={{ gridTemplateColumns: `repeat(${values[0].length}, auto)` }}>
      {values.flatMap((row, i) =>
        row.map((value, j) => (
          <span key={`${i}-${j}`} className={"ms-cell" + (highlight.has(`${i}-${j}`) ? " hl" : "")}>
            {value}
          </span>
        )),
      )}
    </div>
  );
}

/* 矩阵乘法画布：A(2×3)·B(3×2)=C(2×2)，逐格逐项乘加。 */
function MatrixCanvas({ data, step }) {
  const cellIndex = Math.min(Math.floor(step / 4), CELL_ORDER.length - 1);
  const phase = step % 4; // 0-2 累加第 k 项，3 落定
  const [i, j] = CELL_ORDER[cellIndex];
  const highlightA = useMemo(() => new Set([0, 1, 2].map((k) => `${i}-${k}`)), [i]);
  const highlightB = useMemo(() => new Set([0, 1, 2].map((k) => `${k}-${j}`)), [j]);
  const cDone = new Set(
    CELL_ORDER.slice(0, cellIndex).map(([ci, cj]) => `${ci}-${cj}`),
  );
  const cAcc = new Set(phase === 3 ? [] : [`${i}-${j}`]);
  const cState = (ci, cj) =>
    cDone.has(`${ci}-${cj}`) ? " done" : cAcc.has(`${ci}-${cj}`) ? " acc" : "";

  const terms = [0, 1, 2].map((k) => term(data.a[i][k], data.b[k][j]));
  const upto = phase === 3 ? 2 : phase;
  const partial = [0, 1, 2].slice(0, upto + 1).reduce((sum, k) => sum + data.a[i][k] * data.b[k][j], 0);

  return (
    <>
      <div className="ms-canvas">
        <MatrixGrid values={data.a} highlight={highlightA} />
        <span className="ms-op">×</span>
        <MatrixGrid values={data.b} highlight={highlightB} />
        <span className="ms-op">=</span>
        <div className="ms-grid" style={{ gridTemplateColumns: "repeat(2, auto)" }}>
          {data.c.flatMap((row, ci) =>
            row.map((value, cj) => (
              <span key={`${ci}-${cj}`} className={"ms-cell" + cState(ci, cj)}>
                {cDone.has(`${ci}-${cj}`) || cAcc.has(`${ci}-${cj}`) ? data.c[ci][cj] : "·"}
              </span>
            )),
          )}
        </div>
      </div>
      <div className="ms-steps">
        <p className="ms-step on">
          c{CELL_SUB[cellIndex]} = {terms.slice(0, upto + 1).join(" + ")} = <b>{partial}</b>
        </p>
        <p className="ms-step">C = A·B，cᵢⱼ = Σₖ aᵢₖ·bₖⱼ</p>
      </div>
    </>
  );
}

/* 条件概率画布：全概率 + 贝叶斯逐步推导，构成条按真实概率分宽。 */
function ProbCanvas({ data, step }) {
  // probStep 0-2 逐行揭示，3-4 停留在结论上。
  const probStep = Math.max(0, step - MATRIX_STEPS);
  const done = probStep >= 2;
  return (
    <>
      <div className="ms-canvas">
        <div className="ms-steps">
          <p className={"ms-step" + (probStep >= 0 ? " on" : "")}>
            P(A∩B) = P(A)·P(B|A) = {fmt(data.pa)}×{fmt(data.pbGivenA)} = <b>{fmt(data.pAB)}</b>
          </p>
          <p className={"ms-step" + (probStep >= 1 ? " on" : "")}>
            P(B) = {fmt(data.pAB)} + {fmt(1 - data.pa)}×{fmt(data.pbGivenNotA)} = <b>{fmt(data.pb)}</b>
          </p>
          <p className={"ms-step" + (done ? " on" : "")}>
            P(A|B) = P(A∩B) / P(B) = {fmt(data.pAB)} / {fmt(data.pb)} = <b>{fmt(data.paGivenB)}</b>
          </p>
        </div>
      </div>
      <div className="ms-bar" aria-hidden="true">
        <span className="seg-a" style={{ width: `${data.pAB * 100}%` }} />
        <span className="seg-b" style={{ width: `${data.pNotAB * 100}%` }} />
      </div>
      <div className="ms-steps">
        <p className={"ms-step" + (done ? " on" : "")}>
          P(B) 的构成：A∩B <b>{fmt(data.pAB)}</b> · ¬A∩B <b>{fmt(data.pNotAB)}</b>
        </p>
      </div>
    </>
  );
}

export default function DeriveStrip({ mode = "simple", phases = [], inkedChars = 0, onStop }) {
  const [round, setRound] = useState(0);
  const [step, setStep] = useState(0);
  const [over45s, setOver45s] = useState(false);
  // 可见进度（拍板 2026-08-21 二轮打磨：等待感）：用时秒表 + 累计落墨字数
  // ——「有东西在长」的最诚实证据，秒表属信息呈现，减动效下照常走。
  const [elapsed, setElapsed] = useState(0);

  // round 作为依赖触发每轮重造数据（工厂不读它，传参只为依赖可校）。
  const matrixData = useMemo(() => makeMatrixRound(round), [round]);
  const probData = useMemo(() => makeProbRound(round), [round]);

  useEffect(() => {
    if (REDUCED) return;
    const timer = setInterval(() => {
      setStep((current) => {
        if (current + 1 >= TOTAL_STEPS) {
          setRound((r) => r + 1);
          return 0;
        }
        return current + 1;
      });
    }, STEP_MS);
    return () => clearInterval(timer);
  }, []);

  useEffect(() => {
    const timer = setInterval(() => setElapsed((seconds) => seconds + 1), 1_000);
    return () => clearInterval(timer);
  }, []);

  /* 深演算：45 秒后给「停一下」 */
  useEffect(() => {
    if (mode !== "deep" || REDUCED) return;
    const timer = setTimeout(() => setOver45s(true), 45_000);
    return () => clearTimeout(timer);
  }, [mode]);

  // 减弱动画：静态呈现一轮算完的终帧（矩阵全落定 + 贝叶斯全式）。
  const shownStep = REDUCED ? TOTAL_STEPS - 1 : step;
  // 关键回合是回合属性而非阶段：相位流里出现过就一直亮着，不随后续阶段被顶掉。
  const isKeyTurn = phases.includes("key-turn");

  return (
    <div className="derive-strip">
      {shownStep < MATRIX_STEPS ? (
        <MatrixCanvas data={matrixData} step={shownStep} />
      ) : (
        <ProbCanvas data={probData} step={shownStep} />
      )}
      <p className="ds-status" aria-live="polite">
        {isKeyTurn && <span className="ds-key">关键回合 · </span>}
        {phaseCopy(phases[phases.length - 1])}
        <span className="dots"> …</span>
        <span className="ds-progress mono">
          {elapsed}s{inkedChars > 0 ? ` · 已落墨 ${inkedChars} 字` : ""}
        </span>
        {mode === "deep" && over45s && onStop && (
          <button type="button" className="ghost-btn ds-stop" onClick={onStop}>
            停一下
          </button>
        )}
      </p>
    </div>
  );
}
