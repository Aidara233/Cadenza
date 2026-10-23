// Cadenza · util — DOM helpers, formatting, toast, dialogs, storage.

export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

/** h("div.cls#id", {attrs}, ...children). Strings are text nodes (never HTML). */
export function h(tag, attrs, ...children) {
  const m = /^([a-z0-9-]+)?((?:[.#][\w-]+)*)$/i.exec(tag) || [];
  const el = document.createElement(m[1] || "div");
  (m[2] || "").replace(/([.#])([\w-]+)/g, (_, t, v) => {
    if (t === ".") el.classList.add(v); else el.id = v;
  });
  if (attrs && (typeof attrs !== "object" || attrs instanceof Node || Array.isArray(attrs))) {
    children.unshift(attrs);
    attrs = null;
  }
  if (attrs) {
    for (const [k, v] of Object.entries(attrs)) {
      if (v == null || v === false) continue;
      if (k === "class") el.className += (el.className ? " " : "") + v;
      else if (k === "style" && typeof v === "object") Object.assign(el.style, v);
      else if (k === "dataset") Object.assign(el.dataset, v);
      else if (k.startsWith("on") && typeof v === "function") el.addEventListener(k.slice(2), v);
      else if (k === "html") el.innerHTML = v;
      else if (k in el && k !== "list" && k !== "form" && typeof v !== "string") el[k] = v;
      else el.setAttribute(k, v === true ? "" : v);
    }
  }
  append(el, children);
  return el;
}

function append(el, kids) {
  for (const c of kids) {
    if (c == null || c === false) continue;
    if (Array.isArray(c)) append(el, c);
    else el.appendChild(c instanceof Node ? c : document.createTextNode(String(c)));
  }
}

export function clear(el) { while (el.firstChild) el.removeChild(el.firstChild); return el; }
export function swap(el, ...kids) { clear(el); append(el, kids); return el; }

export const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) =>
  ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

export const uid = (p = "c") => p + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);

// ---------- formatting ----------
export function fmtNum(n) {
  if (n == null) return "—";
  return Number(n).toLocaleString("en-US");
}
export function fmtTokens(n) {
  if (n == null) return "—";
  const a = Math.abs(n);
  if (a >= 1e6) return (n / 1e6).toFixed(a >= 1e7 ? 1 : 2).replace(/\.0+$/, "") + "M";
  if (a >= 1e3) return (n / 1e3).toFixed(a >= 1e4 ? 1 : 2).replace(/\.0+$/, "") + "k";
  return String(n);
}
export function fmtTime(iso, withDate = false) {
  if (!iso) return "—";
  const d = new Date(iso);
  if (isNaN(d)) return String(iso);
  const t = d.toLocaleTimeString("zh-CN", { hour12: false });
  if (!withDate) return t;
  return `${d.getMonth() + 1}/${d.getDate()} ${t}`;
}
export function fmtAgo(iso) {
  if (!iso) return "";
  const s = (Date.now() - new Date(iso).getTime()) / 1000;
  if (s < 0) return "刚刚";
  if (s < 60) return `${Math.floor(s)} 秒前`;
  if (s < 3600) return `${Math.floor(s / 60)} 分钟前`;
  if (s < 86400) return `${Math.floor(s / 3600)} 小时前`;
  return `${Math.floor(s / 86400)} 天前`;
}
export function fmtDur(ms) {
  if (ms == null || isNaN(ms)) return "—";
  if (ms < 1000) return `${Math.round(ms)}ms`;
  if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
  const m = Math.floor(ms / 60000);
  return `${m}m${Math.round((ms % 60000) / 1000)}s`;
}
export function fmtCountdown(iso) {
  const ms = new Date(iso).getTime() - Date.now();
  if (ms <= 0) return "已到期";
  const s = Math.floor(ms / 1000);
  const hh = Math.floor(s / 3600), mm = Math.floor((s % 3600) / 60), ss = s % 60;
  return (hh ? hh + ":" : "") + String(mm).padStart(2, "0") + ":" + String(ss).padStart(2, "0");
}
export const baseName = (p) => (p || "").replace(/[\\/]+$/, "").split(/[\\/]/).pop() || p || "";

// ---------- events ----------
export class Emitter {
  constructor() { this._h = new Map(); }
  on(evt, fn) {
    if (!this._h.has(evt)) this._h.set(evt, new Set());
    this._h.get(evt).add(fn);
    return () => this._h.get(evt)?.delete(fn);
  }
  emit(evt, ...args) {
    for (const fn of this._h.get(evt) || []) {
      try { fn(...args); } catch (e) { console.error(`[${evt}]`, e); }
    }
  }
}

export function debounce(fn, ms) {
  let t = 0;
  return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); };
}

// ---------- storage (never throws) ----------
export const store = {
  get(k, def) {
    try { const v = localStorage.getItem("cadenza." + k); return v == null ? def : JSON.parse(v); }
    catch { return def; }
  },
  set(k, v) {
    try { localStorage.setItem("cadenza." + k, JSON.stringify(v)); } catch { /* quota / private */ }
  },
  del(k) { try { localStorage.removeItem("cadenza." + k); } catch { } },
};

// ---------- toast ----------
export function toast(msg, tone = "info", ms = 3600) {
  let host = $("#toasts");
  if (!host) host = document.body.appendChild(h("div#toasts", { "aria-live": "polite", role: "status" }));
  const el = h(`div.toast.t-${tone}`, h("span.toast-dot"), h("span.toast-msg", msg));
  host.appendChild(el);
  requestAnimationFrame(() => el.classList.add("in"));
  setTimeout(() => { el.classList.remove("in"); setTimeout(() => el.remove(), 400); }, ms);
}

// ---------- dialogs ----------
/** Modal confirm. Resolves true/false. danger:true => red primary + typed confirmation if `typed`. */
export function confirmDlg({ title, body, ok = "确定", cancel = "取消", danger = false, typed = null }) {
  return new Promise((resolve) => {
    const input = typed ? h("input.inp", { placeholder: typed, "aria-label": `输入 ${typed} 以确认` }) : null;
    const okBtn = h(`button.btn${danger ? ".btn-danger" : ".btn-primary"}`, { type: "submit" }, ok);
    if (typed) okBtn.disabled = true;
    input?.addEventListener("input", () => { okBtn.disabled = input.value.trim() !== typed; });
    const form = h("form.dlg-body", { method: "dialog" },
      h("h2.dlg-title", title),
      typeof body === "string" ? h("p.dlg-text", body) : body,
      typed ? h("label.dlg-typed", h("span", "输入 ", h("code", typed), " 以确认"), input) : null,
      h("div.dlg-actions",
        h("button.btn.btn-ghost", { type: "button", onclick: () => done(false) }, cancel),
        okBtn));
    const dlg = h("dialog.dlg", form);
    let settled = false;
    const done = (v) => { if (settled) return; settled = true; dlg.close(); dlg.remove(); resolve(v); };
    form.addEventListener("submit", (e) => { e.preventDefault(); if (!okBtn.disabled) done(true); });
    dlg.addEventListener("cancel", (e) => { e.preventDefault(); done(false); });
    document.body.appendChild(dlg);
    dlg.showModal();
    (input || okBtn).focus();
  });
}

/** Modal with arbitrary content; returns { close, el }. */
export function modal(title, content, { wide = false, onClose } = {}) {
  const closeBtn = h("button.icon-btn.dlg-x", { type: "button", "aria-label": "关闭", onclick: () => close() }, "✕");
  const dlg = h(`dialog.dlg${wide ? ".dlg-wide" : ""}`,
    h("div.dlg-body", h("div.dlg-head", h("h2.dlg-title", title), closeBtn), content));
  const close = () => { if (!dlg.open) return; dlg.close(); dlg.remove(); onClose?.(); };
  dlg.addEventListener("cancel", (e) => { e.preventDefault(); close(); });
  dlg.addEventListener("click", (e) => { if (e.target === dlg) close(); });
  document.body.appendChild(dlg);
  dlg.showModal();
  return { close, el: dlg };
}

// ---------- JSON pretty / highlight ----------
export function prettyJson(raw) {
  if (typeof raw !== "string") return JSON.stringify(raw, null, 2);
  try { return JSON.stringify(JSON.parse(raw), null, 2); } catch { return raw; }
}
export function highlightJson(text) {
  return esc(text).replace(
    /(&quot;(?:\\.|(?!&quot;).)*&quot;)(\s*:)?|\b(true|false|null)\b|(-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)/g,
    (m, str, colon, kw, num) => {
      if (str) return colon ? `<span class="j-key">${str}</span>${colon}` : `<span class="j-str">${str}</span>`;
      if (kw) return `<span class="j-kw">${kw}</span>`;
      if (num) return `<span class="j-num">${num}</span>`;
      return m;
    });
}
export function jsonBlock(obj, cls = "") {
  return h(`pre.json${cls ? "." + cls : ""}`, { html: highlightJson(prettyJson(obj)) });
}

export async function copy(text) {
  try { await navigator.clipboard.writeText(text); toast("已复制", "ok"); }
  catch { toast("复制失败（浏览器拒绝了剪贴板）", "warn"); }
}
