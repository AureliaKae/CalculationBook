import { useCallback, useEffect, useRef, useState } from "react";

import { PLOT_SECTIONS } from "../../../src/plotting.js";
import { PLOT_FLAVORS } from "../../../src/plot-prompt.js";
import { GENRES } from "../../../src/genre.js";
import { api } from "../lib/bridge.js";
import { mapTerms } from "../lib/terms.js";
import WinCtl from "./WinCtl.jsx";
import ConfirmDialog from "./ConfirmDialog.jsx";
import { useModalDialog } from "./modal.js";
import PlotSection from "./PlotSection.jsx";

/* 谋篇 · 作家构思工作台：与游玩解耦的独立面。左栏项目列表（多部并行），
   右案面六节卡片（立意 → 世界观 → 文风 → 人物 → 大纲 → 样章）逐节生成、
   可编辑可重掷；整档可导出 Markdown。文风三通道与参考作品搜索的数据
   都经主进程（plot:*）走。 */

const SECTIONS = PLOT_SECTIONS.map((section) => ({
  ...section,
  requiresLabels: section.requires
    .map((key) => PLOT_SECTIONS.find((item) => item.key === key)?.label ?? key)
    .join("、"),
}));

/* 创新度杠杆：成熟 ⟷ 创新，五档。拖动只改本地草稿，抬手/松键才提交
   （onCommit），避免拖一路发一路保存。bare 变体用在弹窗里（无卡底）。 */
function FlavorLever({ value, onCommit, bare = false }) {
  const [draft, setDraft] = useState(value);
  useEffect(() => setDraft(value), [value]);
  const commit = () => {
    if (draft !== value) onCommit(draft);
  };
  return (
    <div className={"plot-flavor" + (bare ? " bare" : "")}>
      <span className="plot-flavor-l">创新度</span>
      <span className="plot-flavor-end">成熟</span>
      <input
        type="range"
        min="1"
        max={String(PLOT_FLAVORS.length)}
        step="1"
        value={draft}
        onChange={(event) => setDraft(Number(event.target.value))}
        onPointerUp={commit}
        onKeyUp={commit}
        onBlur={commit}
        aria-label="创新度（左端成熟，右端创新）"
      />
      <span className="plot-flavor-end">创新</span>
      <span className="plot-flavor-cur">{PLOT_FLAVORS[draft - 1] ?? "均衡"}</span>
    </div>
  );
}

export default function Plotting({ settings, onDesk, onStudio, onNote }) {
  const [projects, setProjects] = useState([]);
  const [currentId, setCurrentId] = useState(null);
  const [project, setProject] = useState(null);
  const [busySection, setBusySection] = useState(null);
  const [savingSection, setSavingSection] = useState(null);
  const [streamText, setStreamText] = useState("");
  const [libraryStyles, setLibraryStyles] = useState([]);
  const [creating, setCreating] = useState(false);
  const [renaming, setRenaming] = useState(null);
  const [renameValue, setRenameValue] = useState("");
  const [removing, setRemoving] = useState(null);
  // 点子行内编辑
  const [ideaEditing, setIdeaEditing] = useState(false);
  const [ideaDraft, setIdeaDraft] = useState("");

  const ready = Boolean(settings?.ready);
  const readyRef = useRef(ready);
  readyRef.current = ready;

  const refreshList = useCallback(async () => {
    try {
      const list = await api.plot.list();
      setProjects(list);
      return list;
    } catch (error) {
      onNote(mapTerms(error.message));
      return [];
    }
  }, [onNote]);

  const openProject = useCallback(
    async (id) => {
      setCurrentId(id);
      setIdeaEditing(false);
      try {
        const full = await api.plot.get(id);
        setProject(full);
      } catch (error) {
        onNote(mapTerms(error.message));
        setProject(null);
      }
    },
    [onNote],
  );

  /* 启动：项目列表 + 案头文风档案（文风三通道之一的数据源） */
  useEffect(() => {
    (async () => {
      const list = await refreshList();
      if (list.length) {
        setCurrentId(list[0].id);
        openProject(list[0].id);
      }
    })();
    api.plot.libraryStyles().then(setLibraryStyles).catch(() => {});
  }, [refreshList, openProject]);

  /* 样章流式：只留尾部窗口（照 inkDraft 的 1200 字尾窗纪律） */
  useEffect(
    () =>
      api.plot.onChunk((text) =>
        setStreamText((current) => (current + text).slice(-1200)),
      ),
    [],
  );

  const generate = useCallback(
    async (section, payload = {}) => {
      if (!readyRef.current) {
        onNote("还没有可用的模型——先去文房配一把密钥。");
        return;
      }
      if (busySection) return;
      if (section === "sample") setStreamText("");
      setBusySection(section);
      try {
        const next = await api.plot.generate({ projectId: currentId, section, ...payload });
        setProject(next);
        onNote("这一节已成。");
        refreshList().catch(() => {});
      } catch (error) {
        if (error?.name === "AbortError" || /aborted|AbortError/i.test(String(error.message))) {
          onNote("已停笔——样章未写入。");
        } else {
          onNote(mapTerms(error.message));
        }
      } finally {
        setBusySection(null);
        setStreamText("");
      }
    },
    [busySection, currentId, onNote, refreshList],
  );

  const saveSection = useCallback(
    async (section, value) => {
      setSavingSection(section);
      try {
        const next = await api.plot.saveSection({ projectId: currentId, section, value });
        setProject(next);
        onNote("已保存。");
        refreshList().catch(() => {});
      } catch (error) {
        onNote(mapTerms(error.message));
      } finally {
        setSavingSection(null);
      }
    },
    [currentId, onNote, refreshList],
  );

  const cancelSample = useCallback(async () => {
    try {
      await api.plot.cancelSample();
    } catch (error) {
      onNote(mapTerms(error.message));
    }
  }, [onNote]);

  const exportProject = useCallback(async () => {
    try {
      const result = await api.plot.exportProject(currentId);
      if (result?.ok) onNote(`已导出：${result.path}`);
      else if (result?.canceled) onNote("已取消导出。");
    } catch (error) {
      onNote(mapTerms(error.message));
    }
  }, [currentId, onNote]);

  const removeProject = useCallback(async () => {
    if (!removing) return;
    try {
      await api.plot.remove(removing.id);
      setRemoving(null);
      onNote("已删去这部谋篇。");
      const list = await refreshList();
      if (currentId === removing.id) {
        setProject(null);
        setCurrentId(null);
        if (list.length) {
          setCurrentId(list[0].id);
          openProject(list[0].id);
        }
      }
    } catch (error) {
      onNote(mapTerms(error.message));
    }
  }, [removing, currentId, onNote, refreshList, openProject]);

  const doneCount = (summary) =>
    Object.values(summary?.done ?? {}).filter(Boolean).length;

  return (
    <div className="app plot">
      <header className="topbar">
        <div>
          <span className="book">谋篇</span>
          <span className="chapter">作家构思台</span>
        </div>
        <div className="right">
          <button type="button" className="navbit" onClick={onDesk}>
            回案头
          </button>
          <WinCtl />
        </div>
      </header>

      {!ready && (
        <p className="studio-locknote">
          还没有可用的模型——浏览与编辑不受影响，生成需要先去文房配一把密钥。
          <button type="button" className="ghost-btn plot-locknote-btn" onClick={onStudio}>
            去文房
          </button>
        </p>
      )}

      <main className="plot-body">
        <nav className="plot-catalog" aria-label="谋篇项目">
          <button type="button" className="plot-new" onClick={() => setCreating(true)}>
            <span className="plot-new-plus">＋</span>
            <span className="plot-new-label">谋一篇新小说</span>
          </button>
          {projects.map((summary) => (
            <button
              key={summary.id}
              type="button"
              className={"plot-item" + (summary.id === currentId ? " cur" : "")}
              onClick={() => openProject(summary.id)}
            >
              <span className="plot-item-title">{summary.title}</span>
              <span className="plot-item-note">
                {summary.genre ? `${summary.genre} · ` : ""}
                {doneCount(summary)}/6 节
              </span>
            </button>
          ))}
          {!projects.length && <p className="plot-catalog-empty">还没有谋篇项目。</p>}
        </nav>

        <section className="plot-panel">
          {!project ? (
            <div className="plot-empty">
              <p className="plot-empty-main">谋一篇新小说</p>
              <p className="plot-empty-sub">
                一句话点子起步，逐节生成立意、世界观、文风、人物、大纲与开篇样章——
                每一节都可以重掷、可以手改。
              </p>
              <button type="button" className="pen-submit" onClick={() => setCreating(true)}>
                ＋ 开始谋篇
              </button>
            </div>
          ) : (
            <>
              <header className="plot-head">
                <div>
                  <h2 className="plot-title">{project.title}</h2>
                  <p className="plot-seeds">
                    {project.seeds.genre ? `${project.seeds.genre} · ` : ""}
                    {project.seeds.reference?.name ? `参考《${project.seeds.reference.name}》 · ` : ""}
                    {project.seeds.idea}
                  </p>
                </div>
                <div className="plot-head-acts">
                  <button type="button" className="ghost-btn" onClick={exportProject}>
                    导出
                  </button>
                  <button
                    type="button"
                    className="ghost-btn"
                    onClick={() => {
                      setRenaming(project);
                      setRenameValue(project.title);
                    }}
                  >
                    改名
                  </button>
                  <button
                    type="button"
                    className="ghost-btn"
                    onClick={() => setRemoving({ id: project.id, title: project.title })}
                  >
                    删去
                  </button>
                </div>
              </header>

              <FlavorLever
                value={project.seeds.flavor ?? 3}
                onCommit={(flavor) => {
                  saveSection("seeds", { flavor });
                  onNote("创新度已记——之后各节按此生成。");
                }}
              />

              {ideaEditing ? (
                <div className="plot-idea-edit">
                  <textarea
                    className="pen-input plot-area"
                    rows={2}
                    value={ideaDraft}
                    onChange={(event) => setIdeaDraft(event.target.value)}
                    placeholder="点子，例：末班地铁司机每晚多看到一站不存在的站台"
                  />
                  <div className="plot-card-acts">
                    <button
                      type="button"
                      className="pen-submit"
                      disabled={busySection !== null}
                      onClick={async () => {
                        await saveSection("seeds", { idea: ideaDraft });
                        setIdeaEditing(false);
                      }}
                    >
                      保存
                    </button>
                    <button type="button" className="ghost-btn" onClick={() => setIdeaEditing(false)}>
                      取消
                    </button>
                  </div>
                </div>
              ) : (
                <button
                  type="button"
                  className="plot-idea"
                  title="点子是六节的根——点击可改写"
                  onClick={() => {
                    setIdeaDraft(project.seeds.idea);
                    setIdeaEditing(true);
                  }}
                >
                  <span className="plot-idea-l">点子</span>
                  <span className="plot-idea-v">{project.seeds.idea}</span>
                </button>
              )}

              {SECTIONS.map((meta) => (
                <PlotSection
                  key={meta.key}
                  meta={meta}
                  project={project}
                  busy={busySection === meta.key}
                  saving={savingSection === meta.key}
                  streamText={streamText}
                  libraryStyles={libraryStyles}
                  onGenerate={generate}
                  onSave={saveSection}
                  onCancelSample={cancelSample}
                />
              ))}
            </>
          )}
        </section>
      </main>

      <NewPlotDialog
        open={creating}
        ready={ready}
        onClose={() => setCreating(false)}
        onCreated={(created) => {
          setCreating(false);
          refreshList().catch(() => {});
          setCurrentId(created.id);
          setProject(created);
        }}
        onNote={onNote}
      />

      <RenameDialog
        state={renaming}
        value={renameValue}
        onValue={setRenameValue}
        onClose={() => setRenaming(null)}
        onConfirm={async () => {
          try {
            const next = await api.plot.rename(renaming.id, renameValue);
            setProject((current) => (current?.id === next.id ? next : current));
            setRenaming(null);
            refreshList().catch(() => {});
          } catch (error) {
            onNote(mapTerms(error.message));
          }
        }}
      />

      <ConfirmDialog
        state={
          removing
            ? {
                title: `删去「${removing.title}」？`,
                detail: "六节档案与用量账目一并清除，不可恢复。",
                confirmLabel: "删去",
                onConfirm: removeProject,
              }
            : null
        }
        onClose={() => setRemoving(null)}
      />
    </div>
  );
}

/* 新建谋篇（两步）：先选路径——「我有点子」（自己写）或「帮我想」（软件出
   一批六张灵感卡，选中回填表单可微调）。表单本身两条路径共用。 */
function NewPlotDialog({ open, ready, onClose, onCreated, onNote }) {
  const ref = useModalDialog(open);
  const [step, setStep] = useState(0); // 0 选路径 · 1 表单 · 2 帮我想
  const [title, setTitle] = useState("");
  const [idea, setIdea] = useState("");
  const [genre, setGenre] = useState("");
  const [refName, setRefName] = useState("");
  const [reference, setReference] = useState(null);
  const [searching, setSearching] = useState(false);
  const [busy, setBusy] = useState(false);
  // 帮我想分支：圈定题材（空＝全题材）、当前一批卡、发牌中
  const [scope, setScope] = useState([]);
  const [cards, setCards] = useState([]);
  const [dealing, setDealing] = useState(false);
  // 创新度杠杆：默认均衡，记忆上次位置（cp-idea-flavor），随建项写进项目。
  const [flavor, setFlavor] = useState(3);

  useEffect(() => {
    if (open) {
      setStep(0);
      setTitle("");
      setIdea("");
      setGenre("");
      setRefName("");
      setReference(null);
      setBusy(false);
      setScope([]);
      setCards([]);
      setDealing(false);
      const saved = Number(localStorage.getItem("cp-idea-flavor"));
      setFlavor(Number.isInteger(saved) && saved >= 1 && saved <= PLOT_FLAVORS.length ? saved : 3);
    }
  }, [open]);

  function changeFlavor(next) {
    setFlavor(next);
    localStorage.setItem("cp-idea-flavor", String(next));
  }

  async function searchReference() {
    const name = refName.trim();
    if (!name) return;
    setSearching(true);
    try {
      const result = await api.plot.searchReference({ name });
      setReference(result);
      if (!result.found) onNote("没搜到公开资料——不影响谋篇，可直接开始。");
    } catch (error) {
      onNote(mapTerms(error.message));
    } finally {
      setSearching(false);
    }
  }

  async function dealCards(redeal = false) {
    if (!ready) {
      onNote("还没有可用的模型——先去文房配一把密钥。");
      return;
    }
    setDealing(true);
    try {
      // 换一批＝把上一批点子作为 avoid，逼模型换世界观与人物动力。
      const avoid = redeal ? cards.map((card) => card.idea) : [];
      const result = await api.plot.ideaCards({ genres: scope, avoid, flavor });
      setCards(result?.cards ?? []);
      if (!result?.cards?.length) onNote("这一批空了——再试一次。");
    } catch (error) {
      onNote(mapTerms(error.message));
    } finally {
      setDealing(false);
    }
  }

  // 选中灵感卡：回填表单（题材一并带出），回 step1 让作家微调。
  function pickCard(card) {
    setIdea(card.idea);
    setGenre(card.genre && card.genre !== "其他" ? card.genre : "");
    setStep(1);
  }

  async function create() {
    if (!idea.trim()) {
      onNote("先写下一句话点子。");
      return;
    }
    setBusy(true);
    try {
      const created = await api.plot.create({
        title: title.trim(),
        idea: idea.trim(),
        genre,
        reference: reference?.found ? { name: reference.name, digest: reference.digest } : null,
        flavor,
      });
      onCreated(created);
    } catch (error) {
      onNote(mapTerms(error.message));
      setBusy(false);
    }
  }

  const toggleScope = (item) =>
    setScope((current) =>
      current.includes(item) ? current.filter((entry) => entry !== item) : [...current, item],
    );

  return (
    <dialog
      ref={ref}
      className="imp-dialog plot-new-dialog"
      onCancel={(event) => {
        event.preventDefault();
        if (!busy && !dealing) onClose();
      }}
    >
      <div className="imp-frame">
        {step === 0 && (
          <>
            <p className="imp-head">谋一篇新小说</p>
            <div className="plot-paths">
              <button type="button" className="plot-path" onClick={() => setStep(1)}>
                <span className="plot-path-title">我有点子</span>
                <span className="plot-path-sub">一句话点子起步</span>
              </button>
              <button type="button" className="plot-path" onClick={() => setStep(2)}>
                <span className="plot-path-title">帮我想</span>
                <span className="plot-path-sub">先看一批灵感</span>
              </button>
            </div>
            <div className="imp-acts">
              <button type="button" className="ghost-btn" onClick={onClose}>
                算了
              </button>
            </div>
          </>
        )}

        {step === 1 && (
          <>
            <p className="imp-head">谋一篇新小说</p>
            <p className="plot-wizard-note">点子：一个画面或一个「如果……」，一句话就够。</p>
            <FlavorLever value={flavor} onCommit={changeFlavor} bare />
            <input
              className="pen-input"
              type="text"
              placeholder="书名（可空，之后能改）"
              value={title}
              onChange={(event) => setTitle(event.target.value)}
            />
            <textarea
              className="pen-input plot-area"
              rows={3}
              placeholder="例：外卖骑手发现每次超时的订单，都来自同一栋不存在的大楼"
              value={idea}
              onChange={(event) => setIdea(event.target.value)}
            />
            <div className="plot-chips" role="radiogroup" aria-label="题材">
              <button
                type="button"
                className={"bf-chip" + (genre === "" ? " on" : "")}
                aria-pressed={genre === ""}
                onClick={() => setGenre("")}
              >
                让 AI 定
              </button>
              {GENRES.filter((item) => item !== "其他").map((item) => (
                <button
                  key={item}
                  type="button"
                  className={"bf-chip" + (genre === item ? " on" : "")}
                  aria-pressed={genre === item}
                  onClick={() => setGenre(item)}
                >
                  {item}
                </button>
              ))}
            </div>
            <div className="plot-ref-row">
              <input
                className="pen-input"
                type="text"
                placeholder="参考作品（选填，搜公开资料辅助构思）"
                value={refName}
                onChange={(event) => {
                  setRefName(event.target.value);
                  setReference(null);
                }}
                onKeyDown={(event) => {
                  if (event.key === "Enter") searchReference();
                }}
              />
              <button type="button" className="ghost-btn" disabled={searching || !refName.trim()} onClick={searchReference}>
                {searching ? "搜寻中…" : "搜一下"}
              </button>
            </div>
            {reference?.found && (
              <p className="plot-ref-digest">
                《{reference.name}》：{String(reference.digest).slice(0, 120)}…
              </p>
            )}
            <div className="imp-acts">
              <button type="button" className="pen-submit" disabled={busy || !idea.trim()} onClick={create}>
                {busy ? "立卷中…" : "开始谋篇"}
              </button>
              <button type="button" className="ghost-btn" disabled={busy} onClick={() => setStep(0)}>
                上一步
              </button>
            </div>
          </>
        )}

        {step === 2 && (
          <>
            <p className="imp-head">帮我想</p>
            <p className="plot-wizard-note">先圈题材（不圈＝全题材混出），出一批六张灵感卡，选中一张接着谋。</p>
            <FlavorLever value={flavor} onCommit={changeFlavor} bare />
            <div className="plot-chips" role="group" aria-label="题材范围">
              {GENRES.filter((item) => item !== "其他").map((item) => (
                <button
                  key={item}
                  type="button"
                  className={"bf-chip" + (scope.includes(item) ? " on" : "")}
                  aria-pressed={scope.includes(item)}
                  onClick={() => toggleScope(item)}
                >
                  {item}
                </button>
              ))}
            </div>
            {cards.length > 0 && (
              <div className="plot-cards">
                {cards.map((card, index) => (
                  <button key={index} type="button" className="plot-idea-card" onClick={() => pickCard(card)}>
                    <span className="plot-idea-genre">{card.genre}</span>
                    <span className="plot-idea-text">{card.idea}</span>
                    {card.hook && <span className="plot-idea-hook">{card.hook}</span>}
                  </button>
                ))}
              </div>
            )}
            <div className="imp-acts">
              <button
                type="button"
                className="pen-submit"
                disabled={dealing}
                onClick={() => dealCards(cards.length > 0)}
              >
                {dealing ? "发牌中…" : cards.length > 0 ? "换一批" : "出一批灵感"}
              </button>
              <button type="button" className="ghost-btn" disabled={dealing} onClick={() => setStep(0)}>
                上一步
              </button>
            </div>
          </>
        )}
      </div>
    </dialog>
  );
}

function RenameDialog({ state, value, onValue, onClose, onConfirm }) {
  const ref = useModalDialog(Boolean(state));
  return (
    <dialog
      ref={ref}
      className="imp-dialog plot-rename-dialog"
      onCancel={(event) => {
        event.preventDefault();
        onClose();
      }}
    >
      {state && (
        <div className="imp-frame">
          <p className="imp-head">改个名字</p>
          <input
            className="pen-input"
            type="text"
            value={value}
            autoFocus
            onChange={(event) => onValue(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter" && value.trim()) onConfirm();
            }}
          />
          <div className="imp-acts">
            <button type="button" className="pen-submit" disabled={!value.trim()} onClick={onConfirm}>
              改名
            </button>
            <button type="button" className="ghost-btn" onClick={onClose}>
              算了
            </button>
          </div>
        </div>
      )}
    </dialog>
  );
}
