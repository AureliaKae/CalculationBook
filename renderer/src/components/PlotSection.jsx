import { useState } from "react";

import Hint from "./Hint.jsx";

/* 谋篇分节卡：每节三态（未生成 / 生成中 / 已生成），已生成可编辑（受控
   表单 → plot:save-section 归一落库）与重掷（可附一句意见）。文风卡独有
   三通道（AI 提议 / 贴范文 / 选案头书）；样章节流式渐显 + 可停。 */

const linesToList = (text) =>
  String(text ?? "")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
const listToLines = (list) => (list ?? []).join("\n");
// 展示层兜底：归一后的档案应是数组，但 mock/手改数据可能给字符串——
// 视图层不该因一个 .join 就整页崩掉。
const toList = (value) =>
  Array.isArray(value) ? value : typeof value === "string" && value.trim() ? [value] : [];

function Field({ label, hint, children }) {
  return (
    <label className="plot-field">
      <span className="plot-field-l">
        {label}
        {hint ? <Hint text={hint} /> : null}
      </span>
      {children}
    </label>
  );
}

/* 已生成态的字段展示 */
function Show({ label, children }) {
  if (children == null || children === "") return null;
  return (
    <div className="plot-show">
      <span className="plot-show-l">{label}</span>
      <p className="plot-show-v">{children}</p>
    </div>
  );
}

/* 重掷附言（可空）：所有节共用 */
function RerollBar({ onReroll, busy, disabled, label = "重掷" }) {
  const [note, setNote] = useState("");
  return (
    <span className="plot-reroll">
      <input
        className="pen-input plot-note-input"
        type="text"
        placeholder="重掷意见（可空）"
        value={note}
        onChange={(event) => setNote(event.target.value)}
      />
      <button
        type="button"
        className="ghost-btn"
        disabled={busy || disabled}
        onClick={() => {
          onReroll({ note });
          setNote("");
        }}
      >
        {label}
      </button>
    </span>
  );
}

function EditBar({ onSave, onCancel, saving, busy }) {
  return (
    <span className="plot-edit-acts">
      <button type="button" className="pen-submit" disabled={saving || busy} onClick={onSave}>
        {saving ? "保存中…" : "保存"}
      </button>
      <button type="button" className="ghost-btn" disabled={saving || busy} onClick={onCancel}>
        取消
      </button>
    </span>
  );
}

/* 卡片外壳：标题 + 依赖说明 + 状态角标 */
function Card({ meta, data, busy, locked, lockReason, children }) {
  return (
    <section className={"plot-card" + (data ? " done" : "")} id={`plot-card-${meta.key}`}>
      <header className="plot-card-head">
        <span className="plot-card-title">{meta.label}</span>
        {meta.requires.length > 0 && (
          <span className="plot-card-dep">先有{meta.requiresLabels}</span>
        )}
        {busy ? <span className="plot-card-state">生成中…</span> : data ? <span className="plot-card-state ok">已定</span> : null}
      </header>
      {locked && !data ? (
        <p className="plot-card-lock">{lockReason}</p>
      ) : (
        children
      )}
    </section>
  );
}

/* ---------- 立意 ---------- */
function PremiseCard({ meta, data, busy, saving, locked, lockReason, onGenerate, onSave }) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(null);
  return (
    <Card meta={meta} data={data} busy={busy} locked={locked} lockReason={lockReason}>
      {!data && !editing && (
        <button type="button" className="pen-submit" disabled={busy || locked} onClick={() => onGenerate({})}>
          {busy ? "构思中…" : "从点子起意"}
        </button>
      )}
      {data && !editing && (
        <>
          <Show label="立意">{data.logline}</Show>
          <Show label="主题">{data.theme}</Show>
          <Show label="开篇钩子">{data.hook}</Show>
          <Show label="备选书名">{toList(data.titles).join(" / ")}</Show>
          {toList(data.notes).length > 0 && (
            <ul className="plot-notes">
              {toList(data.notes).map((note, index) => (
                <li key={index}>{note}</li>
              ))}
            </ul>
          )}
          <footer className="plot-card-acts">
            <RerollBar onReroll={onGenerate} busy={busy} disabled={false} />
            <button
              type="button"
              className="ghost-btn"
              disabled={busy}
              onClick={() => {
                setDraft({
                  logline: data.logline,
                  theme: data.theme,
                  hook: data.hook,
                  titles: listToLines(data.titles),
                  notes: listToLines(data.notes),
                });
                setEditing(true);
              }}
            >
              编辑
            </button>
          </footer>
        </>
      )}
      {editing && draft && (
        <div className="plot-edit">
          <Field label="立意">
            <input className="pen-input" value={draft.logline} onChange={(e) => setDraft({ ...draft, logline: e.target.value })} />
          </Field>
          <Field label="主题">
            <textarea className="pen-input plot-area" rows={2} value={draft.theme} onChange={(e) => setDraft({ ...draft, theme: e.target.value })} />
          </Field>
          <Field label="开篇钩子">
            <textarea className="pen-input plot-area" rows={2} value={draft.hook} onChange={(e) => setDraft({ ...draft, hook: e.target.value })} />
          </Field>
          <Field label="备选书名" hint="一行一个。">
            <textarea className="pen-input plot-area" rows={3} value={draft.titles} onChange={(e) => setDraft({ ...draft, titles: e.target.value })} />
          </Field>
          <Field label="思路要点" hint="一行一条。">
            <textarea className="pen-input plot-area" rows={4} value={draft.notes} onChange={(e) => setDraft({ ...draft, notes: e.target.value })} />
          </Field>
          <footer className="plot-card-acts">
            <EditBar
              saving={saving}
              busy={busy}
              onSave={async () => {
                await onSave({
                  logline: draft.logline,
                  theme: draft.theme,
                  hook: draft.hook,
                  titles: linesToList(draft.titles),
                  notes: linesToList(draft.notes),
                });
                setEditing(false);
              }}
              onCancel={() => setEditing(false)}
            />
          </footer>
        </div>
      )}
    </Card>
  );
}

/* ---------- 世界观 ---------- */
function WorldviewCard({ meta, data, busy, saving, locked, lockReason, onGenerate, onSave }) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(null);
  return (
    <Card meta={meta} data={data} busy={busy} locked={locked} lockReason={lockReason}>
      {!data && !editing && (
        <button type="button" className="pen-submit" disabled={busy || locked} onClick={() => onGenerate({})}>
          {busy ? "搭建中…" : "依立意搭世界观"}
        </button>
      )}
      {data && !editing && (
        <>
          <p className="plot-prose">{data.summary}</p>
          {toList(data.highlights).length > 0 && (
            <ul className="plot-notes">
              {toList(data.highlights).map((item, index) => (
                <li key={index}>{item}</li>
              ))}
            </ul>
          )}
          {toList(data.conflicts).length > 0 && (
            <div className="plot-show">
              <span className="plot-show-l">核心矛盾</span>
              <ul className="plot-notes plain">
                {toList(data.conflicts).map((item, index) => (
                  <li key={index}>{item}</li>
                ))}
              </ul>
            </div>
          )}
          <footer className="plot-card-acts">
            <RerollBar onReroll={onGenerate} busy={busy} disabled={false} />
            <button
              type="button"
              className="ghost-btn"
              disabled={busy}
              onClick={() => {
                setDraft({
                  summary: data.summary,
                  highlights: listToLines(data.highlights),
                  conflicts: listToLines(data.conflicts),
                });
                setEditing(true);
              }}
            >
              编辑
            </button>
          </footer>
        </>
      )}
      {editing && draft && (
        <div className="plot-edit">
          <Field label="总述">
            <textarea className="pen-input plot-area" rows={5} value={draft.summary} onChange={(e) => setDraft({ ...draft, summary: e.target.value })} />
          </Field>
          <Field label="设定要点" hint="一行一条。">
            <textarea className="pen-input plot-area" rows={5} value={draft.highlights} onChange={(e) => setDraft({ ...draft, highlights: e.target.value })} />
          </Field>
          <Field label="核心矛盾" hint="一行一条。">
            <textarea className="pen-input plot-area" rows={3} value={draft.conflicts} onChange={(e) => setDraft({ ...draft, conflicts: e.target.value })} />
          </Field>
          <footer className="plot-card-acts">
            <EditBar
              saving={saving}
              busy={busy}
              onSave={async () => {
                await onSave({
                  summary: draft.summary,
                  highlights: linesToList(draft.highlights),
                  conflicts: linesToList(draft.conflicts),
                });
                setEditing(false);
              }}
              onCancel={() => setEditing(false)}
            />
          </footer>
        </div>
      )}
    </Card>
  );
}

/* ---------- 文风（三通道） ---------- */
const STYLE_FIELDS = [
  ["narration", "人称与视角"],
  ["tense", "时态"],
  ["sentence", "句长与节奏"],
  ["punctuation", "标点习惯"],
  ["chapterForm", "章节体例"],
];

function StyleCard({ meta, data, busy, saving, locked, lockReason, onGenerate, onSave, libraryStyles }) {
  const [channel, setChannel] = useState("ai");
  const [sampleText, setSampleText] = useState("");
  const [bookId, setBookId] = useState("");
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(null);

  const channels = [
    { key: "ai", label: "AI 提议", hint: "按题材与立意提议一张文风卡。" },
    { key: "sample", label: "贴范文", hint: "贴一段自己喜欢的文字（至少 200 字），按同一套七维分析出卡。" },
    { key: "library", label: "选案头书", hint: "直接采用案头某本已起稿小说的现成文风档案。" },
  ];

  return (
    <Card meta={meta} data={data} busy={busy} locked={locked} lockReason={lockReason}>
      <div className="plot-chips" role="radiogroup" aria-label="文风来源">
        {channels.map((item) => (
          <button
            key={item.key}
            type="button"
            className={"bf-chip" + (channel === item.key ? " on" : "")}
            aria-pressed={channel === item.key}
            disabled={busy}
            onClick={() => setChannel(item.key)}
          >
            {item.label}
          </button>
        ))}
      </div>
      <p className="plot-card-hint">{channels.find((item) => item.key === channel)?.hint}</p>

      {channel === "sample" && (
        <Field label="范文">
          <textarea
            className="pen-input plot-area"
            rows={5}
            placeholder="贴入一段你喜欢的文字——想学谁，就贴谁。"
            value={sampleText}
            onChange={(event) => setSampleText(event.target.value)}
          />
        </Field>
      )}
      {channel === "library" && (
        <Field label="案头的书" hint="只列出已完成起稿（有文风档案）的书。">
          {libraryStyles.length ? (
            <select className="mono brush-select" value={bookId} onChange={(event) => setBookId(event.target.value)}>
              <option value="">（选一本）</option>
              {libraryStyles.map((book) => (
                <option key={book.id} value={book.id}>
                  《{book.title}》
                </option>
              ))}
            </select>
          ) : (
            <span className="plot-card-hint">案头还没有带文风档案的书——先起稿一部小说，或改用其他来源。</span>
          )}
        </Field>
      )}

      {!editing && (
        <footer className="plot-card-acts">
          <button
            type="button"
            className="pen-submit"
            disabled={busy || locked || (channel === "sample" && sampleText.trim().length < 200) || (channel === "library" && (!bookId || !libraryStyles.length))}
            onClick={() =>
              onGenerate({ channel, ...(channel === "sample" ? { sampleText } : {}), ...(channel === "library" ? { bookId } : {}) })
            }
          >
            {busy ? "分析中…" : data ? (channel === "ai" ? "重新提议" : channel === "sample" ? "按范文出卡" : "采用此书文风") : channel === "ai" ? "提议文风卡" : channel === "sample" ? "分析范文" : "采用此书文风"}
          </button>
        </footer>
      )}

      {data && !editing && (
        <div className="plot-style-view">
          {data.source?.label && <p className="plot-source">来源：{data.source.label}</p>}
          {STYLE_FIELDS.filter(([key]) => data[key]).map(([key, label]) => (
            <Show key={key} label={label}>
              {data[key]}
            </Show>
          ))}
          {toList(data.imagery).length > 0 && <Show label="常见意象">{toList(data.imagery).join("、")}</Show>}
          {toList(data.diction).length > 0 && <Show label="词汇层">{toList(data.diction).join("、")}</Show>}
          {toList(data.avoid).length > 0 && <Show label="避免写法">{toList(data.avoid).join("；")}</Show>}
          <footer className="plot-card-acts">
            <button
              type="button"
              className="ghost-btn"
              disabled={busy}
              onClick={() => {
                setDraft({
                  ...data,
                  imagery: listToLines(data.imagery),
                  diction: listToLines(data.diction),
                  avoid: listToLines(data.avoid),
                });
                setEditing(true);
              }}
            >
              编辑
            </button>
          </footer>
        </div>
      )}

      {editing && draft && (
        <div className="plot-edit">
          {STYLE_FIELDS.map(([key, label]) => (
            <Field key={key} label={label}>
              <input className="pen-input" value={draft[key] ?? ""} onChange={(e) => setDraft({ ...draft, [key]: e.target.value })} />
            </Field>
          ))}
          <Field label="常见意象" hint="一行一个。">
            <textarea className="pen-input plot-area" rows={3} value={draft.imagery} onChange={(e) => setDraft({ ...draft, imagery: e.target.value })} />
          </Field>
          <Field label="词汇层" hint="一行一个。">
            <textarea className="pen-input plot-area" rows={3} value={draft.diction} onChange={(e) => setDraft({ ...draft, diction: e.target.value })} />
          </Field>
          <Field label="避免写法" hint="一行一条。">
            <textarea className="pen-input plot-area" rows={3} value={draft.avoid} onChange={(e) => setDraft({ ...draft, avoid: e.target.value })} />
          </Field>
          <footer className="plot-card-acts">
            <EditBar
              saving={saving}
              busy={busy}
              onSave={async () => {
                await onSave({
                  ...draft,
                  imagery: linesToList(draft.imagery),
                  diction: linesToList(draft.diction),
                  avoid: linesToList(draft.avoid),
                });
                setEditing(false);
              }}
              onCancel={() => setEditing(false)}
            />
          </footer>
        </div>
      )}
    </Card>
  );
}

/* ---------- 人物 ---------- */
const blankCharacter = () => ({
  name: "",
  role: "",
  summary: "",
  persona: { temperament: "", motives: "", bottomLines: "", manner: "" },
  arc: "",
});
const characterToDraft = (character) => ({
  ...character,
  persona: {
    temperament: character.persona?.temperament ?? "",
    motives: listToLines(character.persona?.motives),
    bottomLines: listToLines(character.persona?.bottomLines),
    manner: character.persona?.manner ?? "",
  },
});
const draftToCharacter = (draft) => ({
  name: draft.name,
  role: draft.role,
  summary: draft.summary,
  persona: {
    temperament: draft.persona.temperament,
    motives: linesToList(draft.persona.motives),
    bottomLines: linesToList(draft.persona.bottomLines),
    manner: draft.persona.manner,
  },
  arc: draft.arc,
});

function CharactersCard({ meta, data, busy, saving, locked, lockReason, onGenerate, onSave }) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState([]);
  return (
    <Card meta={meta} data={data} busy={busy} locked={locked} lockReason={lockReason}>
      {!data && !editing && (
        <button type="button" className="pen-submit" disabled={busy || locked} onClick={() => onGenerate({})}>
          {busy ? "设计中…" : "设计核心阵容"}
        </button>
      )}
      {data && !editing && (
        <>
          {data.map((character, index) => (
            <div className="plot-person" key={index}>
              <p className="plot-person-name">
                {character.name}
                <span className="plot-person-role">{character.role}</span>
              </p>
              {character.summary && <p className="plot-prose">{character.summary}</p>}
              <Show label="性格">{character.persona?.temperament}</Show>
              <Show label="动机">{toList(character.persona?.motives).join("；")}</Show>
              <Show label="底线">{toList(character.persona?.bottomLines).join("；")}</Show>
              <Show label="说话方式">{character.persona?.manner}</Show>
              <Show label="弧线">{character.arc}</Show>
            </div>
          ))}
          <footer className="plot-card-acts">
            <RerollBar onReroll={onGenerate} busy={busy} disabled={false} />
            <button
              type="button"
              className="ghost-btn"
              disabled={busy}
              onClick={() => {
                setDraft(data.map(characterToDraft));
                setEditing(true);
              }}
            >
              编辑
            </button>
          </footer>
        </>
      )}
      {editing && (
        <div className="plot-edit">
          {draft.map((character, index) => (
            <div className="plot-person edit" key={index}>
              <div className="plot-person-head">
                <input className="pen-input plot-name-input" placeholder="姓名" value={character.name} onChange={(e) => setDraft(draft.map((c, i) => (i === index ? { ...c, name: e.target.value } : c)))} />
                <input className="pen-input" placeholder="身份一句话" value={character.role} onChange={(e) => setDraft(draft.map((c, i) => (i === index ? { ...c, role: e.target.value } : c)))} />
                <button type="button" className="ghost-btn" onClick={() => setDraft(draft.filter((_, i) => i !== index))}>
                  删
                </button>
              </div>
              <textarea className="pen-input plot-area" rows={2} placeholder="处境与来历" value={character.summary} onChange={(e) => setDraft(draft.map((c, i) => (i === index ? { ...c, summary: e.target.value } : c)))} />
              <input className="pen-input" placeholder="性格（行为倾向）" value={character.persona.temperament} onChange={(e) => setDraft(draft.map((c, i) => (i === index ? { ...c, persona: { ...c.persona, temperament: e.target.value } } : c)))} />
              <textarea className="pen-input plot-area" rows={2} placeholder="动机（一行一条）" value={character.persona.motives} onChange={(e) => setDraft(draft.map((c, i) => (i === index ? { ...c, persona: { ...c.persona, motives: e.target.value } } : c)))} />
              <textarea className="pen-input plot-area" rows={2} placeholder="底线（一行一条）" value={character.persona.bottomLines} onChange={(e) => setDraft(draft.map((c, i) => (i === index ? { ...c, persona: { ...c.persona, bottomLines: e.target.value } } : c)))} />
              <input className="pen-input" placeholder="说话方式" value={character.persona.manner} onChange={(e) => setDraft(draft.map((c, i) => (i === index ? { ...c, persona: { ...c.persona, manner: e.target.value } } : c)))} />
              <input className="pen-input" placeholder="人物弧线（一句话）" value={character.arc} onChange={(e) => setDraft(draft.map((c, i) => (i === index ? { ...c, arc: e.target.value } : c)))} />
            </div>
          ))}
          <button type="button" className="ghost-btn" onClick={() => setDraft([...draft, blankCharacter()])}>
            ＋ 增一位
          </button>
          <footer className="plot-card-acts">
            <EditBar
              saving={saving}
              busy={busy}
              onSave={async () => {
                await onSave(draft.filter((character) => character.name.trim()).map(draftToCharacter));
                setEditing(false);
              }}
              onCancel={() => setEditing(false)}
            />
          </footer>
        </div>
      )}
    </Card>
  );
}

/* ---------- 大纲 ---------- */
const blankVolume = () => ({ title: "", summary: "", beats: [{ title: "", note: "" }] });
const volumeToDraft = (volume) => ({ ...volume, beats: (volume.beats ?? []).map((beat) => ({ ...beat })) });

function OutlineCard({ meta, data, busy, saving, locked, lockReason, onGenerate, onSave }) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState({ logline: "", volumes: [] });
  return (
    <Card meta={meta} data={data} busy={busy} locked={locked} lockReason={lockReason}>
      {!data && !editing && (
        <button type="button" className="pen-submit" disabled={busy || locked} onClick={() => onGenerate({})}>
          {busy ? "排布中…" : "依人物排大纲"}
        </button>
      )}
      {data && !editing && (
        <>
          <Show label="总纲">{data.logline}</Show>
          {data.volumes.map((volume, index) => (
            <div className="plot-volume" key={index}>
              <p className="plot-volume-title">第{index + 1}卷 · {volume.title}</p>
              {volume.summary && <p className="plot-prose">{volume.summary}</p>}
              <ul className="plot-notes">
                {toList(volume.beats).map((beat, beatIndex) => (
                  <li key={beatIndex}>
                    {beat.title}
                    {beat.note ? <span className="plot-beat-note">——{beat.note}</span> : null}
                  </li>
                ))}
              </ul>
            </div>
          ))}
          <footer className="plot-card-acts">
            <RerollBar onReroll={onGenerate} busy={busy} disabled={false} />
            <button
              type="button"
              className="ghost-btn"
              disabled={busy}
              onClick={() => {
                setDraft({ logline: data.logline ?? "", volumes: data.volumes.map(volumeToDraft) });
                setEditing(true);
              }}
            >
              编辑
            </button>
          </footer>
        </>
      )}
      {editing && (
        <div className="plot-edit">
          <Field label="总纲">
            <input className="pen-input" value={draft.logline} onChange={(e) => setDraft({ ...draft, logline: e.target.value })} />
          </Field>
          {draft.volumes.map((volume, index) => (
            <div className="plot-volume edit" key={index}>
              <div className="plot-person-head">
                <input className="pen-input plot-name-input" placeholder={`第${index + 1}卷卷名`} value={volume.title} onChange={(e) => setDraft({ ...draft, volumes: draft.volumes.map((v, i) => (i === index ? { ...v, title: e.target.value } : v)) })} />
                <button type="button" className="ghost-btn" onClick={() => setDraft({ ...draft, volumes: draft.volumes.filter((_, i) => i !== index) })}>
                  删卷
                </button>
              </div>
              <textarea className="pen-input plot-area" rows={3} placeholder="本卷概要" value={volume.summary} onChange={(e) => setDraft({ ...draft, volumes: draft.volumes.map((v, i) => (i === index ? { ...v, summary: e.target.value } : v)) })} />
              {toList(volume.beats).map((beat, beatIndex) => (
                <div className="plot-beat-row" key={beatIndex}>
                  <input className="pen-input" placeholder="拍点（局面变化）" value={beat.title} onChange={(e) => setDraft({ ...draft, volumes: draft.volumes.map((v, i) => (i === index ? { ...v, beats: v.beats.map((b, bi) => (bi === beatIndex ? { ...b, title: e.target.value } : b)) } : v)) })} />
                  <input className="pen-input" placeholder="说明（可空）" value={beat.note} onChange={(e) => setDraft({ ...draft, volumes: draft.volumes.map((v, i) => (i === index ? { ...v, beats: v.beats.map((b, bi) => (bi === beatIndex ? { ...b, note: e.target.value } : b)) } : v)) })} />
                  <button type="button" className="ghost-btn" onClick={() => setDraft({ ...draft, volumes: draft.volumes.map((v, i) => (i === index ? { ...v, beats: v.beats.filter((_, bi) => bi !== beatIndex) } : v)) })}>
                    删
                  </button>
                </div>
              ))}
              <button type="button" className="ghost-btn" onClick={() => setDraft({ ...draft, volumes: draft.volumes.map((v, i) => (i === index ? { ...v, beats: [...v.beats, { title: "", note: "" }] } : v)) })}>
                ＋ 增一拍
              </button>
            </div>
          ))}
          <button type="button" className="ghost-btn" onClick={() => setDraft({ ...draft, volumes: [...draft.volumes, blankVolume()] })}>
            ＋ 增一卷
          </button>
          <footer className="plot-card-acts">
            <EditBar
              saving={saving}
              busy={busy}
              onSave={async () => {
                await onSave({
                  logline: draft.logline,
                  volumes: draft.volumes
                    .filter((volume) => volume.title.trim())
                    .map((volume) => ({ ...volume, beats: toList(volume.beats).filter((beat) => beat.title.trim()) })),
                });
                setEditing(false);
              }}
              onCancel={() => setEditing(false)}
            />
          </footer>
        </div>
      )}
    </Card>
  );
}

/* ---------- 样章（流式） ---------- */
function SampleCard({ meta, data, busy, saving, locked, lockReason, onGenerate, onSave, streamText, onCancel }) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  return (
    <Card meta={meta} data={data} busy={busy} locked={locked} lockReason={lockReason}>
      {busy && (
        <div className="plot-sample-live">
          <p className="plot-stream" aria-live="polite">{streamText || "蘸墨中…"}</p>
          <button type="button" className="ghost-btn" onClick={onCancel}>
            停笔
          </button>
        </div>
      )}
      {!busy && !data && !editing && (
        <button type="button" className="pen-submit" disabled={locked} onClick={() => onGenerate({})}>
          按文风与大纲试写开篇
        </button>
      )}
      {data && !editing && !busy && (
        <>
          <div className="prose plot-sample-text">
            {data.text.split(/\n{2,}/).map((paragraph, index) => (
              <p key={index}>{paragraph}</p>
            ))}
          </div>
          <footer className="plot-card-acts">
            <RerollBar onReroll={onGenerate} busy={busy} disabled={false} label="重写" />
            <button
              type="button"
              className="ghost-btn"
              onClick={() => {
                setDraft(data.text);
                setEditing(true);
              }}
            >
              编辑
            </button>
          </footer>
        </>
      )}
      {editing && (
        <div className="plot-edit">
          <textarea className="pen-input plot-area" rows={12} value={draft} onChange={(event) => setDraft(event.target.value)} />
          <footer className="plot-card-acts">
            <EditBar
              saving={saving}
              busy={busy}
              onSave={async () => {
                await onSave({ text: draft });
                setEditing(false);
              }}
              onCancel={() => setEditing(false)}
            />
          </footer>
        </div>
      )}
    </Card>
  );
}

/* 分发器：按节渲染对应的卡 */
export default function PlotSection({ meta, project, busy, saving, streamText, libraryStyles, onGenerate, onSave, onCancelSample }) {
  const data = project?.[meta.key] ?? null;
  const missing = meta.requires.filter((key) => !project?.[key]);
  const labels = meta.requiresLabels ?? meta.requires.join("、");
  const locked = missing.length > 0;
  const lockReason = `先完成「${labels}」，这一节才有据可依。`;
  const shared = { meta, data, busy, saving, locked, lockReason, onGenerate: (payload) => onGenerate(meta.key, payload), onSave: (value) => onSave(meta.key, value) };
  if (meta.key === "premise") return <PremiseCard {...shared} />;
  if (meta.key === "worldview") return <WorldviewCard {...shared} />;
  if (meta.key === "style") return <StyleCard {...shared} libraryStyles={libraryStyles} />;
  if (meta.key === "characters") return <CharactersCard {...shared} />;
  if (meta.key === "outline") return <OutlineCard {...shared} />;
  if (meta.key === "sample")
    return <SampleCard {...shared} streamText={streamText} onCancel={onCancelSample} />;
  return null;
}
