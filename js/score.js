// Cadenza · score — every WS frame as a bar of music, plus a console for all 19 commands.
import { h, swap, clear, fmtTime, jsonBlock, copy, toast, store, debounce, confirmDlg } from "./util.js";
import { app } from "./model.js";

const MAX = 2000;
const W = { root: null, frames: [], paused: false, filter: [], dir: "all", list: null, detail: null, sel: null, counts: null, pendingRender: false };
const FILTER_FIELDS = {
  kind: (x) => String(kindOf(x) || ""),
  topic: (x) => String(x.f.topic || ""),
  dir: (x) => x.dir === "in" ? "in recv 收" : "out send 发",
  id: (x) => String(x.f.id || ""),
  session: (x) => String(x.f.payload?.sessionId || x.f.sessionId || ""),
  seq: (x) => String(x.f.seq ?? ""),
};

// The 25 wire commands. req = required keys; fields drive the form. Key-name quirks are the core's, kept verbatim.
export const COMMANDS = [
  { kind: "session.create", group: "会话", fields: [["cwd", "s"], ["title", "s"], ["preset", "s"], ["askTimeoutMinutes", "n"]], note: "没有 projectKey 参数；note 回的是新会话的 projectKey" },
  { kind: "session.activate", group: "会话", req: ["sessionId"], fields: [["sessionId", "sid"]] },
  { kind: "session.deactivate", group: "会话", req: ["sessionId"], fields: [["sessionId", "sid"]], note: "在跑 ⇒ rejected" },
  { kind: "session.archive", group: "会话", req: ["sessionId"], fields: [["sessionId", "sid"], ["archived", "b"]], note: "archived 必须是真布尔；字符串 \"false\" 会被当成没给 ⇒ 归档" },
  { kind: "session.delete", group: "会话", req: ["sessionId"], fields: [["sessionId", "sid"]], note: "不可逆", danger: true },
  { kind: "session.start", group: "推进", req: ["sessionId"], fields: [["sessionId", "sid"]] },
  { kind: "session.send", group: "推进", req: ["sessionId", "blocks"], fields: [["sessionId", "sid"], ["text", "t"]], note: "表单把 text 包成 blocks:[{kind:\"text\"}]" },
  { kind: "session.interrupt", group: "推进", req: ["sessionId"], fields: [["sessionId", "sid"]] },
  { kind: "session.setAxis", group: "推进", req: ["sessionId", "axis", "value"], fields: [["sessionId", "sid"], ["axis", "axis"], ["value", "s"]] },
  { kind: "session.configure", group: "推进", req: ["sessionId"], fields: [["sessionId", "sid"], ["providerId", "s"], ["modelId", "s"], ["askTimeoutMinutes", "n"]], note: "模型键是 modelId（provider.upsert 那边叫 model，是另一个字段）" },
  { kind: "session.gc", group: "上下文", req: ["sessionId"], fields: [["sessionId", "sid"]] },
  { kind: "session.compact", group: "上下文", req: ["sessionId"], fields: [["sessionId", "sid"]] },
  { kind: "session.plan", group: "上下文", req: ["sessionId", "operation"], fields: [["sessionId", "sid"], ["operation", ["overwrite", "insert", "remove"]], ["nodes", "json"], ["parentId", "s"], ["index", "n"], ["ids", "list"]], note: "计划只存剩余：remove 即推进。与 PUT /sessions/{id}/plan 同一解析器；结构判据在核心，error 原样看note" },
  { kind: "claim.release", group: "上下文", req: ["sessionId", "scope"], fields: [["sessionId", "sid"], ["scope", "list"]] },
  // 后台任务（核心 2026-10-27 那批）。⚠️ 三条都只认**本会话**的任务：
  // 归属判据在核心的宿主里，头这一侧不自己比对 sessionId。
  { kind: "jobs.list", group: "后台任务", req: ["sessionId"], fields: [["sessionId", "sid"]], note: "结果是一句给人念的话（每行一个任务），在回执 note 里；结构化形状走 GET /sessions/{id}/jobs" },
  { kind: "job.output", group: "后台任务", req: ["sessionId", "jobId"], fields: [["sessionId", "sid"], ["jobId", "s"], ["offset", "n"]], note: "一次最多 64 KiB；省略 offset = 0。回执的 data 与 note 各一份（data 是 { text, offset, nextOffset, totalBytes, running, truncated }）" },
  { kind: "job.kill", group: "后台任务", req: ["sessionId", "jobId"], fields: [["sessionId", "sid"], ["jobId", "s"]], note: "整棵进程树；已结束的再停一次不算失败，也不会改写结局。不受模型权限轴管", danger: true },
  { kind: "approval.respond", group: "审批", req: ["sessionId", "askId", "outcome"], fields: [["sessionId", "sid"], ["askId", "s"], ["outcome", ["submit", "cancel", "modify"]], ["answers", "json"], ["remember", ["", "args", "tool"]]], note: "授权只看 answers.decision（\"allow\" 才批准）" },
  { kind: "preset.set", group: "预设", req: ["id", "content"], fields: [["id", "s"], ["content", "t"]], note: "content 必给；空串合法（= 纯聊天）" },
  { kind: "preset.list", group: "预设", fields: [] },
  { kind: "preset.delete", group: "预设", req: ["id"], fields: [["id", "s"]] },
  { kind: "provider.upsert", group: "提供商", req: ["id"], fields: [["id", "s"], ["apiKey", "s"], ["model", "s"], ["protocol", "s"], ["endpoint", "s"], ["auth", "s"], ["models", "list"]], note: "这里的 model 是 defaultModel" },
  { kind: "provider.delete", group: "提供商", req: ["id"], fields: [["id", "s"]], danger: true },
  { kind: "provider.test", group: "提供商", req: ["id"], fields: [["id", "s"]], note: "同步，最多 10 秒；结果在 note 里" },
  { kind: "provider.models", group: "提供商", req: ["id"], fields: [["id", "s"]], note: "临时从上游查询模型目录；结果在 ack.data.models，不写配置" },
];

export function mountScore(root) {
  W.root = root;
  root.classList.add("scoreview");
  const search = h("input.inp", { type: "search", placeholder: "过滤：kind:ack topic:session:* dir:in id:…", "aria-label": "过滤帧", title: "支持 kind:、topic:、dir:、id:、session:、seq:；词之间按 AND 匹配，引号可包含空格" });
  search.addEventListener("input", debounce(() => { W.filter = parseFilter(search.value); renderList(true); }, 100));
  const dirSel = h("div.seg.seg-sm", { role: "radiogroup", "aria-label": "方向" },
    ...[["all", "全部"], ["in", "收 ←"], ["out", "发 →"]].map(([v, l]) => h(`button.seg-b${v === W.dir ? ".on" : ""}`, { type: "button", role: "radio", "aria-checked": String(v === W.dir), onclick: (e) => { W.dir = v; for (const b of dirSel.children) { b.classList.toggle("on", b === e.currentTarget); b.setAttribute("aria-checked", String(b === e.currentTarget)); } renderList(true); } }, h("span", l))));
  const pause = h("button.btn.btn-sm", { type: "button", "aria-pressed": "false", onclick: () => { W.paused = !W.paused; pause.setAttribute("aria-pressed", String(W.paused)); pause.textContent = W.paused ? "▶ 继续" : "❚❚ 暂停"; if (!W.paused) renderList(true); } }, "❚❚ 暂停");
  W.counts = h("span.dim.num");
  W.list = h("ol.frames", { role: "list", "aria-label": "帧" });
  W.detail = h("div.frame-detail");
  const left = h("section.wire",
    h("div.wire-h", h("div", h("div.eyebrow", "Score · the wire"), h("h2", "总谱")), h("span.sp"), W.counts),
    h("div.wire-tools", search, dirSel, pause, h("button.btn.btn-sm.btn-ghost", { type: "button", onclick: () => { W.frames = []; W.sel = null; renderList(true); swap(W.detail); } }, "清空")),
    h("div.wire-body", W.list, W.detail));
  root.replaceChildren(left, consolePanel());
  app.core.on("frame", onFrame);
  renderList(true);
}

function onFrame(dir, f, at) {
  W.frames.push({ dir, f, at, n: W.frames.length ? W.frames[W.frames.length - 1].n + 1 : 1 });
  if (W.frames.length > MAX) W.frames.splice(0, W.frames.length - MAX);
  if (W.paused || !W.root || W.root.hidden || W.root.closest("[hidden]")) { updateCounts(); return; }
  if (!W.pendingRender) { W.pendingRender = true; requestAnimationFrame(() => { W.pendingRender = false; renderList(false); }); }
}

export function scoreShown() { renderList(true); }

function kindOf(f) { return f.kind === "event" ? f.payload?.kind : f.kind === "command" ? f.payload?.kind : f.kind; }
function parseFilter(value) {
  const tokens = String(value).match(/(?:[^\s"]+|"[^"]*")+/g) || [];
  const terms = [];
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    const colon = token.indexOf(":");
    const key = colon > 0 ? token.slice(0, colon).toLowerCase() : "";
    let raw = colon > 0 ? token.slice(colon + 1) : token;
    let val = "";
    if (raw.startsWith('"')) {
      raw = raw.slice(1);
      if (raw.endsWith('"')) raw = raw.slice(0, -1);
      else {
        const next = tokens[++i];
        if (next) raw += " " + next.replace(/"$/g, "");
      }
      val = raw;
    } else val = raw.replace(/"$/g, "");
    if (val) terms.push({ key: Object.prototype.hasOwnProperty.call(FILTER_FIELDS, key) ? key : "", val: val.toLowerCase() });
  }
  return terms;
}

function match(x) {
  if (W.dir !== "all" && x.dir !== W.dir) return false;
  if (!W.filter.length) return true;
  const haystack = JSON.stringify(x.f).toLowerCase();
  return W.filter.every(({ key, val }) => {
    const field = key ? FILTER_FIELDS[key](x).toLowerCase() : haystack;
    return val.includes("*") ? new RegExp("^" + val.split("*").map(escapeRegExp).join(".*") + "$", "i").test(field) : field.includes(val);
  });
}

function escapeRegExp(value) { return value.replace(/[.*+?^${}()|[\\]\\\\]/g, "\\$&"); }

function updateCounts() {
  if (W.counts) W.counts.textContent = `${W.frames.length} 帧 · 收 ${app.core.stats.in} · 发 ${app.core.stats.out}`;
}

function renderList(full) {
  if (!W.list) return;
  updateCounts();
  const stick = W.list.scrollHeight - W.list.scrollTop - W.list.clientHeight < 60;
  if (full) clear(W.list);
  const last = full ? 0 : +(W.list.lastElementChild?.dataset.n || 0);
  const frag = document.createDocumentFragment();
  for (const x of W.frames) if (x.n > last && match(x)) frag.append(row(x));
  W.list.append(frag);
  while (W.list.children.length > MAX) W.list.firstElementChild.remove();
  if (!W.list.children.length) W.list.append(h("li.frames-empty.dim", W.frames.length ? "没有匹配的帧" : "还没有帧。WS 上的每一条收发都会出现在这里。"));
  else W.list.querySelector(".frames-empty")?.remove();
  if (stick || full) W.list.scrollTop = W.list.scrollHeight;
}

function row(x) {
  const f = x.f;
  const k = kindOf(f) || "?";
  const tone = f.kind === "ack" ? (f.accepted ? "ok" : "bad") : f.kind === "resync_required" ? "bad" : k === "error" ? "bad" : f.kind === "command" ? "cmd" : f.kind === "subscribe" || f.kind === "unsubscribe" ? "sub" : "ev";
  const extra = f.kind === "event" ? h("span.fr-topic", f.topic, h("b.num", " #" + f.seq)) : f.kind === "ack" ? h("span.fr-topic", f.id, f.reason ? " · " + f.reason : f.note ? " · " + f.note : "") : f.kind === "command" ? h("span.fr-topic", f.id) : f.topic ? h("span.fr-topic", f.topic, f.since != null ? " since " + f.since : "") : null;
  const li = h(`li.fr.fr-${tone}`, { dataset: { n: x.n }, tabindex: 0, onclick: () => select(x, li), onkeydown: (e) => { if (e.key === "Enter") select(x, li); } },
    h("span.fr-n.num", x.n),
    h("span.fr-t.num", fmtTime(new Date(x.at).toISOString())),
    h("span.fr-dir", { "aria-label": x.dir === "in" ? "收" : "发" }, x.dir === "in" ? "←" : "→"),
    h("span.fr-k", k),
    extra);
  if (W.sel === x.n) li.classList.add("sel");
  return li;
}

function select(x, li) {
  W.sel = x.n;
  for (const e of W.list.querySelectorAll(".sel")) e.classList.remove("sel");
  li.classList.add("sel");
  swap(W.detail,
    h("div.fd-h", h("b", kindOf(x.f)), h("span.dim", x.dir === "in" ? "核心 → 头" : "头 → 核心"), h("span.sp"),
      h("button.btn.btn-sm.btn-ghost", { type: "button", onclick: () => copy(JSON.stringify(x.f, null, 2)) }, "复制"),
      x.dir === "out" && x.f.kind === "command" ? h("button.btn.btn-sm", { type: "button", onclick: () => loadRaw(x.f.payload) }, "放进命令台") : null,
      h("button.icon-btn", { type: "button", "aria-label": "关闭", onclick: () => { W.sel = null; li.classList.remove("sel"); clear(W.detail); } }, "✕")),
    jsonBlock(x.f));
}

// ---------------- console ----------------
let C = {};
function consolePanel() {
  const sel = h("select.sel", { "aria-label": "命令" });
  const groups = {};
  for (const c of COMMANDS) (groups[c.group] ||= []).push(c);
  for (const [g, cs] of Object.entries(groups)) sel.append(h("optgroup", { label: g }, ...cs.map((c) => h("option", { value: c.kind }, c.kind))));
  sel.value = store.get("consoleKind", "session.send");
  const form = h("div.cons-form");
  const raw = h("textarea.txt.cons-raw", { rows: 10, spellcheck: false, "aria-label": "原始 payload JSON" });
  const mode = h("div.seg.seg-sm", { role: "radiogroup" },
    h("button.seg-b.on", { type: "button", onclick: () => setMode("form") }, h("span", "表单")),
    h("button.seg-b", { type: "button", onclick: () => setMode("raw") }, h("span", "原始 JSON")));
  const out = h("div.cons-out");
  const sendBtn = h("button.btn.btn-primary", { type: "button", onclick: () => fire(), title: "Ctrl+Enter 发送" }, "发出 →");
  raw.addEventListener("keydown", (e) => { if ((e.ctrlKey || e.metaKey) && e.key === "Enter") { e.preventDefault(); fire(); } });
  C = { sel, form, raw, mode, out, m: "form" };
  sel.addEventListener("change", () => { store.set("consoleKind", sel.value); buildForm(); });
  buildForm();
  return h("aside.console",
    h("div.wire-h", h("div", h("div.eyebrow", "Conductor's desk"), h("h2", "命令台")), h("span.sp"), mode),
    h("label.field", h("span", "命令 · ", h("b", `${COMMANDS.length} 条`), " 全覆盖"), sel),
    form, raw, h("div.row-end", sendBtn), out);
}

function setMode(m) {
  C.m = m;
  const [a, b] = C.mode.children;
  a.classList.toggle("on", m === "form"); b.classList.toggle("on", m === "raw");
  if (m === "raw") C.raw.value = JSON.stringify(payloadFromForm(), null, 2);
  C.form.hidden = m === "raw"; C.raw.hidden = m !== "raw";
}

function buildForm() {
  const def = COMMANDS.find((c) => c.kind === C.sel.value);
  clear(C.form);
  C.inputs = {};
  if (def.note) C.form.append(h("p.cons-note", def.note));
  const presets = {
    "session.send": { sessionId: app.current || "" },
    "session.start": { sessionId: app.current || "" },
    "session.interrupt": { sessionId: app.current || "" },
    "session.gc": { sessionId: app.current || "" },
    "session.compact": { sessionId: app.current || "" },
    "session.plan": { sessionId: app.current || "" },
    "session.activate": { sessionId: app.current || "" },
    "session.deactivate": { sessionId: app.current || "" },
    "session.archive": { sessionId: app.current || "" },
    "session.delete": { sessionId: app.current || "" },
    "session.configure": { sessionId: app.current || "" },
    "session.setAxis": { sessionId: app.current || "" },
    "approval.respond": { sessionId: app.current || "" },
    "jobs.list": { sessionId: app.current || "" },
    "job.output": { sessionId: app.current || "" },
    "job.kill": { sessionId: app.current || "" },
  };
  const preset = presets[def.kind] || {};
  for (const [name, type] of def.fields) {
    let inp;
    const req = def.req?.includes(name) || (name === "text" && def.kind === "session.send");
    if (type === "sid") {
      const rows = [...app.sessions.values()];
      inp = h("select.sel", ...(rows.length ? rows.map((r) => h("option", { value: r.sessionId, selected: r.sessionId === (preset[name] || app.current) }, `${r.title || "无题"} · ${r.sessionId}`)) : [h("option", { value: "" }, "（暂无会话）")]));
    } else if (type === "axis") {
      inp = h("select.sel", ...(app.axes?.axes || []).map((a) => h("option", { value: a.name }, `${a.name} · ${a.label}`)));
    } else if (Array.isArray(type)) {
      inp = h("select.sel", ...type.map((v) => h("option", { value: v }, v || "（不给）")));
    } else if (type === "b") {
      inp = h("select.sel", h("option", { value: "" }, "（不给 ⇒ 归档）"), h("option", { value: "true" }, "true"), h("option", { value: "false" }, "false"));
    } else if (type === "t" || type === "json") {
      inp = h("textarea.txt", { rows: type === "json" ? 3 : 4, placeholder: type === "json" ? '{"decision":"allow"}' : "" });
    } else {
      inp = h("input.inp" + (type === "n" ? ".num" : ".mono"), { type: type === "n" ? "number" : "text", placeholder: type === "list" ? "逗号分隔" : "" });
    }
    if (Object.prototype.hasOwnProperty.call(preset, name) && preset[name] && inp.tagName !== "SELECT") inp.value = preset[name];
    C.inputs[name] = [inp, type];
    C.form.append(h("label.field", h("span", h("code", name), req ? h("b.req", " 必给") : h("span.dim", " 可省")), inp));
  }
  if (C.m === "raw") C.raw.value = JSON.stringify(payloadFromForm(), null, 2);
}

function payloadFromForm() {
  const def = COMMANDS.find((c) => c.kind === C.sel.value);
  const p = { kind: def.kind };
  for (const [name, [inp, type]] of Object.entries(C.inputs || {})) {
    const v = inp.value;
    if (v === "" || v == null) continue;
    if (name === "text" && def.kind === "session.send") { p.blocks = [{ kind: "text", text: v }]; continue; }
    if (type === "n") p[name] = Number(v);
    else if (type === "b") p[name] = v === "true";
    else if (type === "list") p[name] = v.split(",").map((s) => s.trim()).filter(Boolean);
    else if (type === "json") { try { p[name] = JSON.parse(v); } catch { p[name] = v; } }
    else p[name] = v;
  }
  return p;
}

function loadRaw(payload) {
  C.sel.value = payload.kind;
  buildForm();
  setMode("raw");
  C.raw.value = JSON.stringify(payload, null, 2);
}

async function fire() {
  let payload;
  if (C.m === "raw") {
    try { payload = JSON.parse(C.raw.value); } catch (e) { toast("JSON 解析失败：" + e.message, "err"); return; }
  } else payload = payloadFromForm();
  const def = COMMANDS.find((c) => c.kind === payload.kind);
  if (!def) { toast("未知命令：需要有效的 kind", "err"); return; }
  const missing = (def.req || []).filter((key) => payload[key] == null || payload[key] === "");
  if (missing.length) { toast("缺少必填字段：" + missing.join(", "), "err"); return; }
  if (def.danger && !(await confirmDlg({ title: payload.kind, body: "这条命令不可逆。确定发出？", ok: "发出", danger: true }))) return;
  const t0 = performance.now();
  const ack = await app.core.command(payload);
  const ms = Math.round(performance.now() - t0);
  C.out.prepend(h(`div.cons-ack.${ack.accepted ? "ok" : "bad"}`,
    h("div.ca-h", h("b", ack.accepted ? "accepted" : "rejected"), h("code", payload.kind), h("span.sp"), h("span.dim.num", ms + "ms")),
    ack.reason ? h("div", ack.reason) : null,
    ack.note ? h("div.ca-note", ack.note) : null,
    ack.sessionId ? h("div.dim", "sessionId ", h("code", ack.sessionId)) : null,
    ack.accepted ? h("div.dim.ca-hint", "受理 ≠ 成功：业务失败走 error 事件，去左边看。") : null));
  while (C.out.children.length > 12) C.out.lastElementChild.remove();
}
