// Cadenza · palette — Ctrl+K. Fuzzy over sessions, views and actions.
import { h, swap, esc } from "./util.js";
import { openTuning } from "./tuning.js";
import { app, titleOf, projectLabel, setCurrent, cmd, phaseOf } from "./model.js";

let dlg = null;

function items() {
  const out = [];
  const go = (v) => () => app.bus.emit("goto", v);
  out.push(
    { g: "视图", icon: "I", label: "舞台 · 会话", hint: "Alt+1", run: go("stage") },
    { g: "视图", icon: "II", label: "总谱 · 线路与命令台", hint: "Alt+2", run: go("score") },
    { g: "视图", icon: "III", label: "账簿 · 用量", hint: "Alt+3", run: go("ledger") },
    { g: "视图", icon: "IV", label: "后台 · 提供商 / 预设 / 系统", hint: "Alt+4", run: go("greenroom") },
    { g: "动作", icon: "+", label: "新乐章（新建会话）", hint: "Alt+N", run: () => app.bus.emit("new-session") },
    { g: "动作", icon: "♪", label: "提示音音量…", hint: "主音量 + 每个音", run: () => openTuning() });
  if (app.current) {
    const id = app.current;
    out.push(
      { g: "当前会话", icon: "▶", label: "推进一步 · session.start", run: () => cmd({ kind: "session.start", sessionId: id }) },
      { g: "当前会话", icon: "■", label: "中断 · session.interrupt", run: () => cmd({ kind: "session.interrupt", sessionId: id }) },
      { g: "当前会话", icon: "𝄒", label: "开回收窗口 · session.gc", run: () => cmd({ kind: "session.gc", sessionId: id }) },
      { g: "当前会话", icon: "✎", label: "聚焦输入框", hint: "/", run: () => app.bus.emit("focus-composer") });
  }
  for (const a of app.approvals.values()) out.push({ g: "在等你", icon: "𝄐", label: `${titleOf(a.sessionId)} · ${a.askKind === "permission" ? "授权 " + (a.toolName || "") : "提问"}`, run: () => { setCurrent(a.sessionId); app.bus.emit("goto", "stage"); } });
  for (const r of app.sessions.values()) out.push({ g: "会话", icon: { generating: "♩", tools: "𝄀", waiting: "𝄐" }[phaseOf(r.sessionId)] || "𝄽", label: (r.title || "无题 " + r.sessionId.slice(0, 6)), hint: projectLabel(r.projectKey) + " · " + ({ generating: "模型生成", tools: "工具处理", waiting: "等你", idle: "闲置" })[phaseOf(r.sessionId)], extra: r.sessionId, run: () => { setCurrent(r.sessionId); app.bus.emit("goto", "stage"); } });
  return out;
}

function score(q, s) {
  if (!q) return 1;
  s = s.toLowerCase();
  let i = 0, sc = 0, run = 0;
  for (const ch of s) {
    if (ch === q[i]) { i++; run++; sc += run * 2; } else run = 0;
    if (i === q.length) return sc + (s.startsWith(q) ? 20 : 0) + (s.includes(q) ? 10 : 0);
  }
  return 0;
}

function hl(label, q) {
  if (!q) return esc(label);
  const idx = label.toLowerCase().indexOf(q);
  if (idx >= 0) return esc(label.slice(0, idx)) + "<mark>" + esc(label.slice(idx, idx + q.length)) + "</mark>" + esc(label.slice(idx + q.length));
  return esc(label);
}

export function openPalette() {
  if (dlg?.open) { dlg.querySelector("input").focus(); return; }
  const inp = h("input.pal-inp", { placeholder: "跳到会话、视图或动作…", "aria-label": "搜索", role: "combobox", "aria-expanded": "true", "aria-controls": "pal-list", autocomplete: "off" });
  const list = h("ul.pal-list#pal-list", { role: "listbox" });
  dlg = h("dialog.palette", { "aria-label": "命令面板" },
    h("div.pal-inp-wrap", h("span.glyph", { "aria-hidden": "true" }, "𝄞"), inp, h("kbd", "Esc")),
    list,
    h("div.pal-foot", h("span", h("kbd", "↑"), h("kbd", "↓"), " 选择"), h("span", h("kbd", "Enter"), " 执行"), h("span", h("kbd", "Esc"), " 关闭")));
  const all = items();
  let shown = [], sel = 0;
  const draw = () => {
    const q = inp.value.trim().toLowerCase();
    shown = all.map((it) => ({ it, s: Math.max(score(q, it.label), score(q, it.g + " " + (it.hint || "")) * .6, it.extra ? score(q, it.extra) : 0) }))
      .filter((x) => x.s > 0).sort((a, b) => (q ? b.s - a.s : 0)).slice(0, 40).map((x) => x.it);
    sel = Math.min(sel, Math.max(0, shown.length - 1));
    const frag = [];
    let g = null;
    shown.forEach((it, i) => {
      if (it.g !== g && !q) { g = it.g; frag.push(h("li.pal-group", { role: "presentation" }, g)); }
      frag.push(h("li.pal-item", { role: "option", id: "pi-" + i, "aria-selected": String(i === sel), onclick: () => run(i), onmousemove: () => { if (sel !== i) { sel = i; mark(); } } },
        h("span.pi-icon", it.icon), h("span.pi-label", { html: hl(it.label, q) }), it.hint ? h("span.pi-hint", it.hint) : null));
    });
    if (!shown.length) frag.push(h("li.pal-group", "没有匹配"));
    swap(list, ...frag);
    inp.setAttribute("aria-activedescendant", "pi-" + sel);
  };
  const mark = () => {
    for (const el of list.querySelectorAll(".pal-item")) el.setAttribute("aria-selected", String(el.id === "pi-" + sel));
    list.querySelector(`#pi-${sel}`)?.scrollIntoView({ block: "nearest" });
    inp.setAttribute("aria-activedescendant", "pi-" + sel);
  };
  const close = () => { dlg.close(); dlg.remove(); dlg = null; };
  const run = (i) => { const it = shown[i]; close(); it?.run(); };
  inp.addEventListener("input", () => { sel = 0; draw(); });
  inp.addEventListener("keydown", (e) => {
    if (e.key === "ArrowDown") { e.preventDefault(); sel = (sel + 1) % Math.max(1, shown.length); mark(); }
    else if (e.key === "ArrowUp") { e.preventDefault(); sel = (sel - 1 + shown.length) % Math.max(1, shown.length); mark(); }
    else if (e.key === "Enter") { e.preventDefault(); run(sel); }
  });
  dlg.addEventListener("cancel", (e) => { e.preventDefault(); close(); });
  dlg.addEventListener("click", (e) => { if (e.target === dlg) close(); });
  document.body.append(dlg);
  dlg.showModal();
  draw();
  inp.focus();
}
