// Cadenza · mixer — the inspector. Axes as faders, model, context gauge, slots, claims.
import { h, swap, clear, fmtTokens, fmtNum, fmtTime, fmtAgo, toast, confirmDlg, store, copy } from "./util.js";
import { app, cmd } from "./model.js";
import { renderBlock } from "./blocks.js";

const M = { root: null, id: null, snap: null, tab: store.get("mixTab", "axes"), usage: null, context: null, claims: [], body: null };

const AXIS_ICON = { initiative: "♩", permission: "⚿", safety: "⚠", verify: "✓", effort: "✦", temperature: "≈", network: "⌁" };
// Permission ladder colour bands follow the core's semantics (order is the contract).
const PERM_TONE = { off: "deny", readonly: "deny", investigate: "low", standard: "ask", authorized: "hot", trusted: "max" };

export const mixer = {
  mount(root) {
    M.root = root;
    // The "axis is on but the core isn't configured" hint depends on app.network.
    app.bus.on("network", () => { if (M.id && M.tab === "axes") render(); });
  },
  show(id, snap) {
    M.id = id; M.snap = snap || null; M.usage = null; M.context = null;
    if (!M.root) return;
    if (!id) { swap(M.root, h("div.mix-idle", h("div.eyebrow", "Mixer"), h("p.dim", "打开一个会话，这里是它的调音台：行为轴、模型、上下文、提示词槽位。"))); return; }
    render();
    loadSide();
  },
  axis(name, value) { if (M.snap) { M.snap.axes = { ...M.snap.axes, [name]: value }; if (M.tab === "axes") render(); } },
  usage(p) {
    if (M.id !== p.sessionId) return;
    const calls = [...(M.usage?.calls || [])];
    if (p.call) calls.push(p.call);
    M.usage = { ...(M.usage || {}), summary: p.summary, calls };
    loadContext();
  },
  async refresh() {
    if (!M.id) return;
    try { M.snap = await app.core.get(`/sessions/${encodeURIComponent(M.id)}/state`); } catch { }
    render(); loadSide();
  },
};

async function loadSide() {
  const id = M.id;
  const [u, c, cl] = await Promise.allSettled([
    app.core.get(`/sessions/${encodeURIComponent(id)}/usage`),
    app.core.get(`/sessions/${encodeURIComponent(id)}/context`),
    app.core.get("/claims"),
  ]);
  if (id !== M.id) return;
  if (u.value) M.usage = u.value;
  if (c.value) M.context = c.value;
  if (cl.value) M.claims = cl.value;
  renderGauge();
  if (M.tab !== "axes") render();
}
async function loadContext() {
  const id = M.id;
  try { const c = await app.core.get(`/sessions/${encodeURIComponent(id)}/context`); if (id === M.id) { M.context = c; renderGauge(); } } catch { }
}

function render() {
  if (!M.root || !M.snap) return;
  const tabs = [["axes", "行为"], ["model", "模型"], ["slots", "槽位"], ["claims", "声明"]];
  const nav = h("div.mix-tabs", { role: "tablist" }, ...tabs.map(([k, l]) => h("button.mix-tab", {
    type: "button", role: "tab", "aria-selected": String(M.tab === k),
    onclick: () => { M.tab = k; store.set("mixTab", k); render(); },
  }, l)));
  M.body = h("div.mix-body", { role: "tabpanel" });
  swap(M.root, h("div.mix-gauge-slot"), nav, M.body);
  renderGauge();
  ({ axes, model, slots, claims })[M.tab]?.(M.body);
}

// ---------------- context gauge (always visible) ----------------
function renderGauge() {
  const slot = M.root?.querySelector(".mix-gauge-slot");
  if (!slot) return;
  const latest = M.context?.latest;
  const sum = M.usage?.summary;
  // /context.latest.inputTokens is uncached input only (core d1c0895). The context length is the
  // full prompt = uncached + cache read; take cacheRead from the same call in the usage calls.
  const call = [...(M.usage?.calls || [])].reverse().find((c) => (latest ? c.callId === latest.callId : c.usage?.inputTokens != null) && c.usage?.inputTokens != null);
  const input = call ? call.usage.inputTokens + (call.usage.cacheReadTokens ?? 0) : latest?.inputTokens;
  const hit = call?.usage?.cacheReadTokens;
  const budget = guessWindow();
  const frac = input != null && budget ? Math.min(1, input / budget) : 0;
  const R = 46, C = 2 * Math.PI * R, arc = 0.75;
  const ring = `<svg viewBox="0 0 120 120" class="gauge-svg" aria-hidden="true">
    <circle cx="60" cy="60" r="${R}" class="g-track" stroke-dasharray="${C * arc} ${C}" transform="rotate(135 60 60)"/>
    <circle cx="60" cy="60" r="${R}" class="g-val${frac > .8 ? " hot" : ""}" stroke-dasharray="${C * arc * frac} ${C}" transform="rotate(135 60 60)"/>
    ${Array.from({ length: 11 }, (_, i) => { const a = (135 + i * 27) * Math.PI / 180; const r1 = 54, r2 = i % 5 === 0 ? 59 : 57; return `<line x1="${60 + r1 * Math.cos(a)}" y1="${60 + r1 * Math.sin(a)}" x2="${60 + r2 * Math.cos(a)}" y2="${60 + r2 * Math.sin(a)}" class="g-tick"/>`; }).join("")}
  </svg>`;
  swap(slot, h("div.gauge",
    h("div.gauge-dial", { html: ring },),
    h("div.gauge-read",
      h("div.eyebrow", "上下文"),
      h("div.gauge-num.num", input != null ? fmtTokens(input) : "—"),
      h("div.gauge-sub.dim", input != null ? `最近一次请求的全部输入${hit ? ` · 其中命中 ${fmtTokens(hit)}` : ""}` : "还没有报了用量的调用"),
      h("div.gauge-row",
        h("span", { title: "本会话累计未命中输入" }, "入 ", h("b.num", fmtTokens(sum?.inputTokens))),
        h("span", { title: "本会话累计输出" }, "出 ", h("b.num", fmtTokens(sum?.outputTokens))),
        h("span", { title: "本会话缓存命中率（只算报了缓存的调用）" }, "命中 ", h("b.num", sum?.cacheHitRate != null ? (sum.cacheHitRate * 100).toFixed(0) + "%" : "—")),
        h("span", { title: "调用次数" }, "×", h("b.num", fmtNum(sum?.calls)))))));
  const dial = slot.querySelector(".gauge-dial");
  if (dial && budget) dial.title = `按 ${fmtTokens(budget)} 窗口估算（核心不报窗口大小，这只是刻度）`;
}

function guessWindow() {
  // Display scale only; the core does not report context window sizes. The head is tuned for
  // a 1M-token window, so the dial is a share of that. The readout itself is always exact.
  return 1000000;
}

// ---------------- axes ----------------
function axes(root) {
  const defs = M.snap.axisDefinitions || app.axes?.axes || [];
  const vals = M.snap.axes || {};
  const alert = crossAlert(vals, defs);
  if (alert) root.append(h("div.mix-alert", { role: "alert" }, h("b", "跨轴告警"), " 安全＝生产，且权限 ≥ 授权。模型在生产环境里能直接写。"));
  for (const d of defs) root.append(axisRow(d, vals[d.name]));
  (webHints(vals, defs) || []).forEach((text) => root.append(h("div.mix-alert", text)));
  if ((M.snap.pluginProblems || []).length) root.append(h("div.mix-problems", h("div.eyebrow", "插件问题"), ...M.snap.pluginProblems.map((p) => h("div", p))));
}

/** The browser can see a session that says "web is on" while the core is not configured to do it. */
function webHints(vals, defs) {
  if (!vals.network || vals.network === "off") return [];
  const out = [];
  if (app.network == null) out.push("核心没有 /network-config——这个版本不支持联网工具。");
  else if (!app.network.enabled) out.push("联网轴已开，但核心的联网能力未启用：去后厅 · 联网 打开。");
  const perm = defs.find((d) => d.name === "permission");
  const pi = perm ? perm.values.indexOf(vals.permission) : -1;
  if (pi >= 0 && pi < perm.values.indexOf("investigate"))
    out.push("联网轴已开，但当前权限档位不允许消耗型工具（需要 investigate 及以上）。");
  return out;
}

function crossAlert(vals, defs) {
  const sf = app.axes?.alertSafety || "prod", af = app.axes?.alertFrom || "authorized";
  const perm = defs.find((d) => d.name === "permission");
  if (!perm || vals.safety !== sf) return false;
  return perm.values.indexOf(vals.permission) >= perm.values.indexOf(af);
}

function axisRow(d, cur) {
  const unavailable = d.available === false;
  const label = h("div.ax-h",
    h("span.ax-icon", { "aria-hidden": "true" }, AXIS_ICON[d.name] || "◇"),
    h("span.ax-label", d.label || d.name),
    d.pluginId ? h("span.chip.plum", d.pluginId) : null,
    !d.inContext ? h("span.chip", { title: "不进模型上下文（只影响请求参数）" }, "参数") : null,
    h("span.sp"),
    h("code.ax-val", cur ?? "—"));
  const row = h(`div.ax.ax-${d.name.replace(/\W/g, "_")}`, label);
  if (unavailable) { row.append(h("div.dim", d.problem || "插件不可用")); return row; }

  if (d.range) {
    const r = d.range;
    const v = parseFloat(cur ?? r.min);
    const slider = h("input.fader", { type: "range", min: r.min, max: r.max, step: r.step, value: isNaN(v) ? r.min : v, "aria-label": d.label });
    const out = row.querySelector(".ax-val");
    slider.addEventListener("input", () => { out.textContent = Number(slider.value).toFixed(1); });
    slider.addEventListener("change", () => setAxis(d.name, Number(slider.value).toFixed(1)));
    row.append(h("div.fader-wrap", slider, h("div.fader-scale", h("span", r.min), h("span", ((r.max + r.min) / 2).toFixed(1)), h("span", r.max))));
    return row;
  }
  const isPerm = d.name === "permission";
  const idx = d.values.indexOf(cur);
  // More than five steps do not fit one row in a 300px panel — wrap into rows of three.
  const rows = d.values.length > 5 ? ".seg-rows" : "";
  const seg = h(`div.seg${isPerm ? ".seg-ladder" : ""}${rows}`, { role: "radiogroup", "aria-label": d.label });
  d.values.forEach((v, i) => {
    const on = v === cur;
    const tone = isPerm ? PERM_TONE[v] || "" : d.name === "safety" && v === "prod" ? "max" : "";
    const b = h(`button.seg-b${on ? ".on" : ""}${i <= idx ? ".lit" : ""}${tone ? ".t-" + tone : ""}`, {
      type: "button", role: "radio", "aria-checked": String(on), title: v,
      onclick: () => { if (!on) setAxis(d.name, v); },
    }, h("span", v));
    seg.append(b);
  });
  row.append(seg);
  return row;
}

async function setAxis(axis, value) {
  if (axis === "permission" && value === "trusted") {
    const ok = await confirmDlg({ title: "全放行？", body: "trusted 档允许所有工具类别，包括不可逆的高危操作（删除、以及能跑任意命令的 shell），不再询问。", ok: "我确定", danger: true });
    if (!ok) { render(); return; }
  }
  const ack = await cmd({ kind: "session.setAxis", sessionId: M.id, axis, value }, { quiet: true });
  if (!ack.accepted) render();
}
// ---------------- model ----------------
function model(root) {
  const spec = M.snap.spec || {};
  const m = spec.model || {};
  const prov = h("select.sel", { "aria-label": "提供商" }, ...app.providers.map((p) => h("option", { value: p.id, selected: p.id === m.providerId }, p.id)));
  if (!app.providers.some((p) => p.id === m.providerId)) prov.prepend(h("option", { value: m.providerId, selected: true }, m.providerId + "（已不存在）"));
  const modelBox = h("div");
  const fillModels = () => {
    const p = app.providers.find((x) => x.id === prov.value);
    const keep = prov.value === m.providerId ? m.modelId : p?.defaultModel || "";
    if (p?.models?.length) {
      const sel = h("select.sel.mx-model", { "aria-label": "模型" }, ...p.models.map((x) => h("option", { value: x, selected: x === keep }, x)));
      if (!p.models.includes(keep) && keep) sel.prepend(h("option", { value: keep, selected: true }, keep));
      swap(modelBox, sel);
    } else swap(modelBox, h("input.inp.mono.mx-model", { value: keep, "aria-label": "模型", placeholder: "模型 id" }));
  };
  prov.addEventListener("change", fillModels);
  fillModels();
  const tmo = h("input.inp.num", { type: "number", min: 1, placeholder: spec.askTimeout ? "" : "不超时", value: timeoutMinutes(spec.askTimeout) ?? "", "aria-label": "询问超时（分钟）" });
  const apply = h("button.btn.btn-primary.btn-sm", { type: "button" }, "换调");
  apply.addEventListener("click", async () => {
    const payload = { kind: "session.configure", sessionId: M.id };
    const mid = modelBox.querySelector(".mx-model").value.trim();
    if (prov.value !== m.providerId) payload.providerId = prov.value;
    if (mid && mid !== m.modelId) payload.modelId = mid;
    const t = parseInt(tmo.value, 10);
    if (t > 0 && t !== timeoutMinutes(spec.askTimeout)) payload.askTimeoutMinutes = t;
    if (Object.keys(payload).length === 2) { toast("什么都没变", "info"); return; }
    const ack = await cmd(payload);
    if (ack.accepted) mixer.refresh();
  });
  root.append(
    h("div.kv",
      kv("协议", h("code", m.protocol)),
      kv("思考强度", h("code", m.effort ?? "—")),
      kv("最大输出", h("span.num", fmtNum(m.maxTokens))),
      kv("创建于", fmtTime(spec.createdAt, true)),
      kv("预设", spec.systemPromptPreset ? h("code", spec.systemPromptPreset) : h("span.dim", "内置模板")),
      kv("询问超时", spec.askTimeout ? h("code", spec.askTimeout) : h("span.dim", "不超时"))),
    h("div.mix-sec", h("div.eyebrow", "换调 · session.configure"),
      h("label.field", h("span", "提供商"), prov),
      h("label.field", h("span", "模型"), modelBox),
      h("label.field", h("span", "询问超时（分钟）"), tmo, h("span.hint", "只能设成正数；核心没有「取消超时」的入口")),
      h("div.row-end", apply)),
    (spec.plugins || []).length ? h("div.mix-sec", h("div.eyebrow", "插件"), ...spec.plugins.map((p) => h("div.kv-line", h("code", p.id), h("span.dim", " v" + p.version)))) : null);
}

function timeoutMinutes(ts) {
  if (!ts) return null;
  const m = /^(?:(\d+)\.)?(\d+):(\d+):(\d+)/.exec(ts);
  if (!m) return null;
  return (+(m[1] || 0)) * 1440 + (+m[2]) * 60 + (+m[3]);
}

const kv = (k, v) => h("div.kv-row", h("span.kv-k", k), h("span.kv-v", v));

// ---------------- slots ----------------
function slots(root) {
  const s = M.snap.slots || {};
  if (s.problem) root.append(h("div.mix-alert", "槽位收集出错：", s.problem));
  const sec = (name, label, blocks, hint) => {
    const n = (blocks || []).length;
    const d = h("details.slot", { open: name === "floating" },
      h("summary", h("span.slot-name", label), h("code.dim", name), h("span.sp"), h("span.chip.num", n ? `${n} 块` : "空")),
      h("p.hint.dim", hint),
      n ? h("div.slot-body", ...blocks.map(renderBlock)) : h("div.slot-empty", "（空）——这个会话没配这一块"));
    root.append(d);
  };
  root.append(h("p.dim.mix-note", "与发给模型的请求同一来源。这里是「此刻」；请求在步开始时冻结。"));
  sec("system", "系统", s.system, "系统提示词（预设文件 presets/<id>.md）");
  sec("premier", "首要", s.premier, "首要块（premiers/<id>.md）");
  sec("floating", "浮动", s.floating, "此刻的浮动上下文（核心每步现算，不在历史里）");
}

// ---------------- claims ----------------
function claims(root) {
  const mine = M.claims.filter((c) => c.sessionId === M.id);
  const others = M.claims.filter((c) => c.sessionId !== M.id && c.projectKey === M.snap.spec?.projectKey);
  const row = (c, own) => h("li.claim" + (c.stale ? ".stale" : ""),
    h("code", c.path),
    h("span.dim", fmtAgo(c.at)),
    c.stale ? h("span.chip.red", "主人已不在") : null,
    h("span.sp"),
    h("button.btn.btn-ghost.btn-sm", { type: "button", title: "强制释放（不检查占用者）", onclick: async () => {
      const ok = own || await confirmDlg({ title: "强制释放别人的声明？", body: "不检查占用者是不是自己。", ok: "释放" });
      if (!ok) return;
      const ack = await cmd({ kind: "claim.release", sessionId: c.sessionId, scope: [c.path] });
      if (ack.accepted) loadSide();
    } }, "释放"));
  root.append(
    h("div.mix-sec", h("div.eyebrow", "本会话占着"), mine.length ? h("ul.claims", ...mine.map((c) => row(c, true))) : h("div.dim", "没有")),
    h("div.mix-sec", h("div.eyebrow", "同项目的其他会话"), others.length ? h("ul.claims", ...others.map((c) => row(c, false))) : h("div.dim", "没有")),
    h("div.row-end", h("button.btn.btn-sm.btn-ghost", { type: "button", onclick: () => loadSide() }, "刷新")));
}
