import { useEffect, useRef } from "react";

import { useModalDialog } from "./modal.js";

/* 角色卡（拍板 2026-08-19）：边注摘要+弹窗详情）：此身详情——境界阶梯（标
   当前位）、技能（身份带/习得两源）、行囊明细、近况（characterJournal：
   心中所向/承诺与债务/职责/身体与险境——引擎一直组装却从未上界面，此处接通）、
   履历（身份变化+境界突破）。
   大五不进卡（全隐性拍板：性子只在叙事里透出）；来历进卡（拍板 2026-08-20：
   意图即人设——定约写定的白描是既定事实，其余履历仍是玩出来的）。 */
export default function CharDialog({ open, sheet, journal = [], onClose }) {
  const ref = useModalDialog(open);
  const closeRef = useRef(null);

  useEffect(() => {
    if (open) requestAnimationFrame(() => closeRef.current?.focus());
  }, [open]);

  const identity = (sheet?.abilities ?? []).filter((item) => item.source === "identity");
  const learned = (sheet?.abilities ?? []).filter((item) => item.source === "learned");
  const history = [
    ...(sheet?.roleHistory ?? []).map((entry) => ({
      turn: entry.sinceTurn ?? 0,
      text: `${entry.reason ? `${entry.reason} · ` : ""}以「${entry.roleName}」立身`,
    })),
    ...(sheet?.realmHistory ?? []).map((entry) => ({
      turn: entry.turn ?? 0,
      text: `境界突破 · 跻身「${entry.name}」${entry.note ? `（${entry.note}）` : ""}`,
    })),
  ].sort((left, right) => left.turn - right.turn);
  // 近况只收活着的挂心事：身份履历节与下方履历区重复，滤掉。
  const current = (journal ?? []).filter(
    (entry) => entry && entry.text && entry.section !== "身份履历",
  );

  return (
    <dialog
      ref={ref}
      className="imp-dialog char-dialog"
      onCancel={(event) => {
        event.preventDefault();
        onClose();
      }}
    >
      {open && sheet ? (
        <div className="imp-frame">
          <p className="imp-head">此身 · {sheet.name || "无名"}</p>
          <dl className="imp-facts">
            <div>
              <dt>身份</dt>
              <dd>{sheet.roleName || "—"}</dd>
            </div>
            <div>
              <dt>世数</dt>
              <dd>第 {sheet.lifeIndex} 世</dd>
            </div>
            <div>
              <dt>此刻</dt>
              <dd>{sheet.location || "—"}</dd>
            </div>
            {sheet.motivation ? (
              <div>
                <dt>所求</dt>
                <dd>{sheet.motivation}</dd>
              </div>
            ) : null}
          </dl>

          {sheet.background ? (
            <div className="char-sec">
              <p className="ms-mark">来 历</p>
              <p className="char-prose">{sheet.background}</p>
            </div>
          ) : null}

          {sheet.realm?.ladder?.length ? (
            <div className="char-sec">
              <p className="ms-mark">境 界</p>
              <div className="bf-options char-ladder">
                {sheet.realm.ladder.map((rung) => (
                  <span key={rung.id} className={"bf-chip" + (rung.current ? " on" : "")}>
                    {rung.name}
                  </span>
                ))}
              </div>
            </div>
          ) : null}

          <div className="char-sec">
            <p className="ms-mark">技 能</p>
            {identity.length || learned.length ? (
              <ul className="char-list">
                {identity.map((item, index) => (
                  <li key={`i-${index}`}>
                    <span className="char-tag">身份</span>
                    {item.text}
                  </li>
                ))}
                {learned.map((item, index) => (
                  <li key={`l-${index}`}>
                    <span className="char-tag char-tag-learned">习得</span>
                    {item.text}
                  </li>
                ))}
              </ul>
            ) : (
              <p className="char-empty">这一身还没有拿得出手的本事。</p>
            )}
          </div>

          <div className="char-sec">
            <p className="ms-mark">行 囊</p>
            {sheet.inventory?.length ? (
              <ul className="char-list">
                {sheet.inventory.map((item, index) => (
                  <li key={index}>
                    <span className="char-tag char-tag-item">物</span>
                    {item.note ? `${item.name}——${item.note}` : item.name}
                  </li>
                ))}
              </ul>
            ) : (
              <p className="char-empty">行囊空空。</p>
            )}
          </div>

          {current.length ? (
            <div className="char-sec">
              <p className="ms-mark">近 况</p>
              <ul className="char-list">
                {current.map((entry, index) => (
                  <li key={entry.id ?? index}>
                    <span className="char-tag char-tag-journal">{entry.section}</span>
                    {entry.text}
                  </li>
                ))}
              </ul>
            </div>
          ) : null}

          <div className="char-sec">
            <p className="ms-mark">履 历</p>
            {history.length ? (
              <ul className="char-history">
                {history.map((entry, index) => (
                  <li key={index}>
                    <span className="char-turn">第 {entry.turn} 手</span>
                    {entry.text}
                  </li>
                ))}
              </ul>
            ) : (
              <p className="char-empty">刚落笔，履历还空着。</p>
            )}
          </div>

          <div className="imp-acts">
            <button ref={closeRef} type="button" className="ghost-btn" onClick={onClose}>
              合上
            </button>
          </div>
        </div>
      ) : null}
    </dialog>
  );
}
