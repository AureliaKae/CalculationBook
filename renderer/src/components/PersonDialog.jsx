import { useEffect, useRef } from "react";

import { PROTAGONIST_STATUS } from "../lib/protagonist.js";
import { useModalDialog } from "./modal.js";

/* 人物卡（拍板 2026-08-19：关系簿点击展开）：原著人物的一面——身份/行踪/
   生死、与玩家的关系定性（不显数值）、persona 四卡（性格/动机/底线/说话
   方式，烧制产物）、精读明细（若已精读）。数据随视图一次带全，无需再拉。 */
export default function PersonDialog({ open, person, onClose }) {
  const ref = useModalDialog(open);
  const closeRef = useRef(null);

  useEffect(() => {
    if (open) requestAnimationFrame(() => closeRef.current?.focus());
  }, [open]);

  if (!person) return null;

  return (
    <dialog
      ref={ref}
      className="imp-dialog char-dialog person-dialog"
      onCancel={(event) => {
        event.preventDefault();
        onClose();
      }}
    >
      {open ? (
        <div className="imp-frame">
          <p className="imp-head">
            {person.name || "无名之人"}
            {PROTAGONIST_STATUS[person.status] ? (
              <span className="proto-status">{PROTAGONIST_STATUS[person.status]}</span>
            ) : null}
          </p>
          <dl className="imp-facts">
            {person.role ? (
              <div>
                <dt>身份</dt>
                <dd>{person.role}</dd>
              </div>
            ) : null}
            <div>
              <dt>关系</dt>
              <dd>
                <span className={"rel-stance tone-" + (person.stance?.tone ?? "cool")}>
                  {person.stance?.label ?? "一面之缘"}
                </span>
              </dd>
            </div>
            <div>
              <dt>行踪</dt>
              <dd>{person.locationName ?? "不明"}</dd>
            </div>
          </dl>

          {person.persona ? (
            <div className="char-sec">
              <p className="ms-mark">其 人</p>
              <dl className="imp-facts">
                {person.persona.temperament ? (
                  <div>
                    <dt>性情</dt>
                    <dd>{person.persona.temperament}</dd>
                  </div>
                ) : null}
                {person.persona.motives ? (
                  <div>
                    <dt>所图</dt>
                    <dd>{person.persona.motives}</dd>
                  </div>
                ) : null}
                {person.persona.bottomLines ? (
                  <div>
                    <dt>底线</dt>
                    <dd>{person.persona.bottomLines}</dd>
                  </div>
                ) : null}
                {person.persona.manner ? (
                  <div>
                    <dt>做派</dt>
                    <dd>{person.persona.manner}</dd>
                  </div>
                ) : null}
              </dl>
            </div>
          ) : null}

          {person.summary ? (
            <div className="char-sec">
              <p className="ms-mark">来 历</p>
              <p className="person-summary">{person.summary}</p>
            </div>
          ) : null}

          {person.detail && (person.detail.motives.length || person.detail.habits.length) ? (
            <div className="char-sec">
              <p className="ms-mark">细 节</p>
              <ul className="char-list">
                {person.detail.motives.map((text, index) => (
                  <li key={`m-${index}`}>
                    <span className="char-tag char-tag-journal">所图</span>
                    {text}
                  </li>
                ))}
                {person.detail.habits.map((text, index) => (
                  <li key={`h-${index}`}>
                    <span className="char-tag char-tag-journal">习气</span>
                    {text}
                  </li>
                ))}
              </ul>
            </div>
          ) : null}

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
