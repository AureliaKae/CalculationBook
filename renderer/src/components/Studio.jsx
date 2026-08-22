import { useRef, useState } from "react";
import { useGSAP } from "@gsap/react";
import gsap from "gsap";
import { PROVIDER_PRESETS as VENDOR_SHOPS, recommendedModelsFor } from "../../../src/client.js";
import { api } from "../lib/bridge.js";
import { KEEP_KEY } from "../lib/keep.js";
import { mapTerms } from "../lib/terms.js";
import WinCtl from "./WinCtl.jsx";
import Hint from "./Hint.jsx";
import UsagePanel from "./UsagePanel.jsx";
import ConfirmDialog from "./ConfirmDialog.jsx";
import { useModalDialog } from "./modal.js";
import { REDUCED } from "../lib/motion.js";

const PANELS = [
  { id: "ink", label: "墨水坊", note: "API 密钥" },
  { id: "brush", label: "草稿笔 · 定稿笔", note: "模型分配" },
  { id: "bake", label: "起稿台", note: "并发与思考" },
  { id: "usage", label: "账目", note: "用量" },
];

// 添加墨行的厂商预设：与主进程保存侧白名单（assertSecureEndpoint/
// assertKnownEndpoint）同源（src/providers.js 注册表），http 只放行本机调试。
const PROVIDER_PRESETS = [
  ...VENDOR_SHOPS.map((shop) => ({ id: shop.id, label: shop.label, short: shop.short, baseUrl: shop.baseUrl })),
  { id: "local", label: "本机调试地址", short: "本机调试", baseUrl: "" },
];

// 新墨行 id 沿用 settings-schema 的 cred-N 避让约定（缺省 id 生成时避开
// 已占用），否则「cred-1」与已有同名凭证撞 id，保存归并时互相覆盖。
function nextCredentialId(credentials) {
  const used = new Set(credentials.map((c) => c?.id).filter(Boolean));
  let suffix = 1;
  while (used.has(`cred-${suffix}`)) suffix += 1;
  return `cred-${suffix}`;
}

/* 文房：左目录右案面。真桥读写 settings（密钥经主进程加密）；
   首启未就绪时锁定（拦收起），出路只有配钥。 */
export default function Studio({ locked = false, settings, onSettingsSaved, onBack, onNote }) {
  const [panel, setPanel] = useState("ink");
  const [draft, setDraft] = useState(() => ({
    credentials: settings?.credentials ?? [],
    fast: settings?.fast ?? { credentialId: "", model: "" },
    strong: settings?.strong ?? { credentialId: "", model: "" },
    thinkingStrong: settings?.thinkingStrong ?? true,
    bakeConcurrency: settings?.bakeConcurrency ?? "",
  }));
  const [keyEdits, setKeyEdits] = useState({});
  const [testing, setTesting] = useState(null);
  const [models, setModels] = useState({});
  const [saving, setSaving] = useState(false);
  const [adding, setAdding] = useState(false);
  const [picked, setPicked] = useState("deepseek");
  const [localUrl, setLocalUrl] = useState("");
  const [addError, setAddError] = useState("");
  const [removing, setRemoving] = useState(null);
  const panelRef = useRef(null);
  const addRef = useModalDialog(Boolean(adding));

  useGSAP(
    () => {
      if (REDUCED) return;
      gsap.fromTo(
        panelRef.current.children,
        { opacity: 0, y: 10, scale: 0.97 },
        { opacity: 1, y: 0, scale: 1, duration: 0.4, ease: "back.out(1.5)", stagger: 0.05, clearProps: "transform" },
      );
    },
    { scope: panelRef, dependencies: [panel] },
  );

  function patch(next) {
    setDraft((d) => ({ ...d, ...next }));
  }

  function patchCredential(id, next) {
    patch({
      credentials: draft.credentials.map((c) => (c.id === id ? { ...c, ...next } : c)),
    });
  }

  /* 试墨成功后代配空槽：快/强槽未指向任何墨行时连墨行一起指向该凭证并填
     推荐笔杆；已指向该墨行但笔杆空着的只补笔杆名；其余（指向别家、笔杆
     已选）一律不动。 */
  function autofillSlots(credential) {
    const recommended = recommendedModelsFor(credential.baseUrl);
    if (!recommended) return false;
    let touched = false;
    const next = {};
    for (const slot of ["fast", "strong"]) {
      const current = draft[slot] ?? {};
      if (!current.credentialId) {
        next[slot] = { ...current, credentialId: credential.id, model: recommended[slot] };
        touched = true;
      } else if (current.credentialId === credential.id && !current.model) {
        next[slot] = { ...current, model: recommended[slot] };
        touched = true;
      } else {
        next[slot] = current;
      }
    }
    if (touched) patch(next);
    return touched;
  }

  async function testInk(credential) {
    setTesting(credential.id);
    try {
      const result = await api.settings.models({
        credentialId: credential.id,
        baseUrl: credential.baseUrl,
        apiKey: keyEdits[credential.id] || undefined,
      });
      if (result?.models) {
        setModels((m) => ({ ...m, [credential.id]: result.models }));
        const autofilled = autofillSlots(credential);
        onNote(autofilled ? "墨色已验。笔杆已代配，可随时改。" : "墨色已验。");
      } else {
        onNote(result?.error ? mapTerms(result.error) : "试墨未成。");
      }
    } catch (error) {
      onNote(mapTerms(error.message));
    } finally {
      setTesting(null);
    }
  }

  function closeAdd() {
    setAdding(false);
    setPicked("deepseek");
    setLocalUrl("");
    setAddError("");
  }

  /* 添加墨行：预设两家直接落地址；本机调试地址在客户端先按主进程同款规则
     校验（http 且仅 localhost/127.0.0.1/::1），错误尽早拦在存稿之前。 */
  function addCredential() {
    const preset = PROVIDER_PRESETS.find((p) => p.id === picked) ?? PROVIDER_PRESETS[0];
    let baseUrl = preset.baseUrl;
    if (preset.id === "local") {
      const raw = localUrl.trim();
      let url;
      try {
        url = new URL(raw);
      } catch {
        setAddError("地址不是合法 URL。");
        return;
      }
      const host = url.hostname.replace(/^\[|\]$/g, "");
      if (url.protocol !== "http:" || !["localhost", "127.0.0.1", "::1"].includes(host)) {
        setAddError("本机调试地址用 http://localhost（或 127.0.0.1、[::1]）；公网地址请选上面两行预设。");
        return;
      }
      baseUrl = raw;
    }
    const id = nextCredentialId(draft.credentials);
    const label = preset.id === "local" ? new URL(baseUrl).host : preset.label;
    patch({
      credentials: [...draft.credentials, { id, label, baseUrl }],
    });
    closeAdd();
    onNote("墨行已添，贴入 API Key 后试墨。");
  }

  /* 下架墨行：草稿笔/定稿笔指着它的一并清空指向（保存侧 normalizeSlot
     也会兜底清空，这里同步改草稿让界面立即如实）。 */
  function removeCredential(credential) {
    const clearIfPointed = (slot) =>
      draft[slot]?.credentialId === credential.id
        ? { ...draft[slot], credentialId: "", model: "" }
        : draft[slot];
    setKeyEdits((edits) => {
      const next = { ...edits };
      delete next[credential.id];
      return next;
    });
    setModels((known) => {
      const next = { ...known };
      delete next[credential.id];
      return next;
    });
    patch({
      credentials: draft.credentials.filter((c) => c.id !== credential.id),
      fast: clearIfPointed("fast"),
      strong: clearIfPointed("strong"),
    });
    setRemoving(null);
    onNote("墨行已下架，存稿后生效。");
  }

  async function save(extra = {}) {
    // 设置未加载完成前禁止存稿（C8）：draft 的兜底值会把空凭证表整表写下去，
    // 一键抹掉已存的全部 Key。settings===null 说明读取还没回来（或失败）。
    if (!settings) {
      onNote("账目还没翻开——稍候再存稿。");
      return null;
    }
    setSaving(true);
    try {
      const payload = {
        ...draft,
        ...extra,
        credentials: draft.credentials.map((c) => ({
          ...c,
          apiKey: keyEdits[c.id] ?? (c.hasApiKey ? KEEP_KEY : ""),
        })),
        thinkingStrong: extra.thinkingStrong ?? draft.thinkingStrong,
      };
      const saved = await api.settings.save(payload);
      onSettingsSaved(saved);
      onNote("已存稿。");
      return saved;
    } catch (error) {
      onNote(mapTerms(error.message));
      return null;
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="app studio">
      <header className="topbar">
        <div>
          <span className="book">文房</span>
          <span className="chapter">{locked ? "先配墨" : "墨水与笔"}</span>
        </div>
        <div className="right">
          {!locked && (
            <button type="button" className="navbit" onClick={onBack}>
              收起
            </button>
          )}
          <WinCtl />
        </div>
      </header>

      {locked && (
        <p className="studio-locknote">
          没有可用的墨（API 密钥）之前，起稿与入题都用不了真模型。配一把钥匙即可开始。
        </p>
      )}

      <main className="studio-body">
        <nav className="studio-catalog" aria-label="文房目录">
          {PANELS.map((it) => (
            <button
              key={it.id}
              type="button"
              className={"cat-item" + (panel === it.id ? " cur" : "")}
              onClick={() => setPanel(it.id)}
            >
              <span className="cat-label">{it.label}</span>
              <span className="cat-note">{it.note}</span>
            </button>
          ))}
        </nav>

        <section className="studio-panel" ref={panelRef} key={panel}>
          {panel === "ink" && (
            <>
              {settings?.decryptFailed > 0 && (
                <p className="studio-note ink-warn">
                  系统密钥库变了——原 Key 已无法解密，请把各墨行的 Key 重新填一遍。
                </p>
              )}
              {settings && settings.secureStorage === false && (
                <p className="studio-note ink-warn">
                  本机没有可用的系统密钥环，Key 只能做弱混淆保存，注意保管好设备。
                </p>
              )}
              {draft.credentials.length === 0 && (
                <p className="studio-note ink-empty">
                  还没有墨行。点下方「＋ 添加墨行」选一家，贴入 API Key 试墨即可开始。
                </p>
              )}
              {draft.credentials.map((c) => (
                <div key={c.id} className="ink-card" data-id={c.id}>
                  <div className="ink-head">
                    <span className={"dot " + (c.hasApiKey || keyEdits[c.id] ? "ok" : "")} />
                    <span className="ink-name">{c.label || c.baseUrl}</span>
                    <span className="ink-status">
                      {keyEdits[c.id] ? "新墨待验" : c.hasApiKey ? "有墨" : "未配墨"}
                    </span>
                  </div>
                  <div className="ink-key mono">
                    {keyEdits[c.id]
                      ? keyEdits[c.id].slice(0, 4) + "****（新填）"
                      : c.hasApiKey
                        ? "sk-****************************（留存）"
                        : "—— 未配墨 ——"}
                  </div>
                  <div className="ink-acts">
                    <input
                      className="pen-input ink-input"
                      type="password"
                      placeholder={c.hasApiKey ? "换一把墨（留空则不变）" : "填入 API Key"}
                      aria-label={`${c.label} 的 API Key`}
                      value={keyEdits[c.id] ?? ""}
                      onChange={(e) =>
                        setKeyEdits((k) => ({ ...k, [c.id]: e.target.value.trim() }))
                      }
                    />
                    <button
                      type="button"
                      className="ghost-btn"
                      disabled={testing === c.id}
                      onClick={() => testInk(c)}
                    >
                      {testing === c.id ? "试墨中…" : "试墨"}
                    </button>
                    <button
                      type="button"
                      className="ghost-btn"
                      onClick={() => setRemoving(c)}
                    >
                      下架
                    </button>
                  </div>
                  {models[c.id]?.length > 0 && (
                    <p className="studio-note mono">可选笔杆：{models[c.id].length} 支</p>
                  )}
                </div>
              ))}
              <div className="ink-add-row">
                <button type="button" className="ghost-btn" onClick={() => setAdding(true)}>
                  ＋ 添加墨行
                </button>
              </div>
              <p className="studio-note">密钥经系统凭据加密，永不出主进程。</p>
            </>
          )}

          {panel === "brush" && (
            <>
              {[
                { key: "fast", badge: "草", label: "草稿笔 · 快", hint: "快笔：起稿与摘要。价廉，量大。" },
                { key: "strong", badge: "定", label: "定稿笔 · 强", hint: "强笔：叙事回合。价高，字精。" },
              ].map((slot) => {
                const current = draft[slot.key] ?? {};
                const credential = draft.credentials.find((c) => c.id === current.credentialId);
                const options = credential ? models[credential.id] ?? [] : [];
                return (
                  <div key={slot.key} className="brush-card">
                    <div className="brush-head">
                      <span className="mini-badge">{slot.badge}</span>
                      <span>
                        {slot.label}
                        <Hint text="墨行＝用哪一条 API 密钥；笔杆＝用哪个模型。" />
                      </span>
                    </div>
                    <label className="brush-row">
                      <span className="brush-l">墨行</span>
                      <select
                        className="mono brush-select"
                        value={current.credentialId ?? ""}
                        onChange={(e) => patch({ [slot.key]: { ...current, credentialId: e.target.value } })}
                      >
                        <option value="">（未配）</option>
                        {draft.credentials.map((c) => (
                          <option key={c.id} value={c.id}>{c.label || c.baseUrl}</option>
                        ))}
                      </select>
                    </label>
                    <label className="brush-row">
                      <span className="brush-l">笔杆</span>
                      <input
                        className="mono brush-select brush-free"
                        type="text"
                        list={`models-${slot.key}`}
                        value={current.model ?? ""}
                        placeholder="模型名（试墨后可选）"
                        onChange={(e) => patch({ [slot.key]: { ...current, model: e.target.value.trim() } })}
                      />
                      <datalist id={`models-${slot.key}`}>
                        {options.map((m) => (
                          <option key={m} value={m} />
                        ))}
                      </datalist>
                    </label>
                    {slot.key === "strong" && (
                      <div className="brush-row">
                        <span className="brush-l">
                          腹稿（思考链）
                          <Hint text="定稿笔在下笔前先打腹稿：开则慢而深思，叙事更稳；关则快而便宜。" />
                        </span>
                        <button
                          type="button"
                          className={"toggle" + (draft.thinkingStrong ? " on" : "")}
                          role="switch"
                          aria-checked={draft.thinkingStrong}
                          onClick={() => patch({ thinkingStrong: !draft.thinkingStrong })}
                        >
                          <span className="toggle-knob" />
                          <span className="toggle-l">{draft.thinkingStrong ? "开" : "关"}</span>
                        </button>
                      </div>
                    )}
                    <p className="studio-note">{slot.hint}</p>
                  </div>
                );
              })}
            </>
          )}

          {panel === "bake" && (
            <>
              <div className="bake-row">
                <span className="brush-l">
                  起稿并发
                  <Hint text="起稿时同时跑几路请求。路宽起得快，但更容易撞墨行的限流。" />
                </span>
                <span className="studio-note">留空=按墨行官方建议（DeepSeek 4，其余 3）</span>
                <input
                  className="mono brush-select bake-conc"
                  type="text"
                  value={draft.bakeConcurrency ?? ""}
                  placeholder="自动"
                  onChange={(e) => patch({ bakeConcurrency: e.target.value.replace(/[^\d]/g, "").slice(0, 2) })}
                />
              </div>
              <p className="studio-note">存稿后生效。</p>
            </>
          )}

          {panel === "usage" && <UsagePanel />}
        </section>
      </main>

      <footer className="studio-foot">
        <span className="save-note" aria-live="polite">{locked ? "配墨后即可离开" : ""}</span>
        <button type="button" className="pen-submit" onClick={() => save()} disabled={saving}>
          {saving ? "存稿中…" : "存稿"}
        </button>
        {!locked ? null : (
          <button type="button" className="ghost-btn" onClick={onBack}>
            先随便看看
          </button>
        )}
      </footer>

      <dialog
        ref={addRef}
        className="imp-dialog ink-add-dialog"
        onCancel={(event) => {
          event.preventDefault();
          closeAdd();
        }}
      >
        {adding && (
          <div className="imp-frame">
            <p className="imp-head">添加墨行</p>
            <div className="ink-add-opts">
              {PROVIDER_PRESETS.map((preset) => (
                <button
                  key={preset.id}
                  type="button"
                  className={"ink-add-opt" + (picked === preset.id ? " cur" : "")}
                  onClick={() => {
                    setPicked(preset.id);
                    setAddError("");
                  }}
                >
                  <span className="ink-add-name">{preset.short ?? preset.label}</span>
                </button>
              ))}
            </div>
            <p className="ink-add-hint">
              {PROVIDER_PRESETS.find((preset) => preset.id === picked)?.baseUrl ||
                "http://localhost…（仅限本机 http 调试地址）"}
            </p>
            {picked === "local" && (
              <input
                className="pen-input mono ink-add-url"
                type="text"
                value={localUrl}
                placeholder="http://localhost:11434/v1"
                aria-label="本机调试地址"
                onChange={(event) => {
                  setLocalUrl(event.target.value);
                  setAddError("");
                }}
                onKeyDown={(event) => {
                  if (event.key === "Enter") addCredential();
                }}
              />
            )}
            {addError ? <p className="studio-note">{addError}</p> : null}
            <div className="imp-acts">
              <button type="button" className="ghost-btn" onClick={closeAdd}>
                算了
              </button>
              <button type="button" className="pen-submit" onClick={addCredential}>
                添加
              </button>
            </div>
          </div>
        )}
      </dialog>

      <ConfirmDialog
        state={
          removing
            ? {
                title: `下架「${removing.label || removing.baseUrl}」？`,
                detail: "草稿笔/定稿笔若指着这条墨行，指向会一并清空。下架后记得存稿。",
                confirmLabel: "下架",
                onConfirm: () => removeCredential(removing),
              }
            : null
        }
        onClose={() => setRemoving(null)}
      />
    </div>
  );
}
