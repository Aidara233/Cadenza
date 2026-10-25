// Cadenza · stage — the session view: programme (sidebar) · score (timeline) · mixer (inspector).
import { h, $, swap, clear, fmtTime, fmtAgo, fmtTokens, fmtNum, fmtDur, store, toast, confirmDlg, modal, debounce, copy, jsonBlock, baseName } from "./util.js";
import { app, cmd, titleOf, projectLabel, dirOf, rememberDir, setCurrent, refreshSessions, refreshPresets, refreshProviders, scheduleRefresh, watchSession, unwatchSession, markLocal, isRunning, phaseOf } from "./model.js";
import { Timeline } from "./timeline.js";
import { cueCard, hydrate } from "./approvals.js";
import { renderBlock } from "./blocks.js";
import { projectKeyOf } from "./core.js";
import { mixer } from "./mixer.js";

const S = {
  root: null,
  side: null, list: null, filter: "", showArchived: store.get("showArchived", false),
  head: null, tlRoot: null, cues: null, composer: null, input: null, perf: null,
  mixRoot: null,
  tl: null, snap: null, topic: null, perfTimer: 0, retryNote: null,
  archived: new Set(store.get("archived", [])),
  collapsed: new Set(store.get("collapsedProjects", [])),
};

export function mountStage(root) {
  S.root = root;
  root.classList.add("stage");
  S.list = h("div.prog-list", { role: "tree", "aria-label": "会话" });
  const search = h("input.inp.prog-search", { type: "search", placeholder: "筛选会话…", "aria-label": "筛选会话" });
  search.addEventListener("input", debounce(() => { S.filter = search.value.trim().toLowerCase(); renderList(); }, 80));
  const arch = h("label.check.prog-arch", h("input", { type: "checkbox", checked: S.showArchived, onchange: (e) => { S.showArchived = e.target.checked; store.set("showArchived", S.showArchived); renderList(); } }), "显示已归档");
  S.side = h("aside.programme", { "aria-label": "节目单" },
    h("div.prog-h",
      h("div", h("div.eyebrow", "Programme"), h("h2", "节目单")),
      h("button.btn.btn-primary.btn-sm", { type: "button", onclick: () => newSessionDialog(), "aria-keyshortcuts": "Alt+N" }, "+ 新乐章")),
    search, S.list, h("div.prog-f", arch));

  S.head = h("header.score-h");
  S.tlRoot = h("div.score-scroll", { tabindex: "-1" });
  S.cues = h("div.cues", { "aria-live": "polite" });
  S.perf = h("div.perf", { hidden: true, role: "status" });
  S.input = h("textarea.composer-inp", { rows: 1, placeholder: "写下下一句…  Enter 发送 · Shift+Enter 换行", "aria-label": "消息" });
  S.input.addEventListener("input", () => { autosize(); saveDraft(); });
  S.input.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey && !e.isComposing) { e.preventDefault(); send(); }
  });
  S.sendBtn = h("button.btn.btn-primary.composer-send", { type: "button", onclick: () => send(), "aria-label": "发送" }, "发送 ↵");
  S.stopBtn = h("button.btn.btn-danger.composer-stop", { type: "button", onclick: () => interrupt(), hidden: true, "aria-label": "中断" }, "■ 中断");
  S.qInfo = h("span.composer-q.dim");
  S.composer = h("div.composer",
    h("div.composer-box", S.input, h("div.composer-actions", S.qInfo, h("span.sp"), S.stopBtn, S.sendBtn)));

  const center = h("section.score", { "aria-label": "总谱" }, S.head, S.tlRoot, S.perf, S.cues, S.composer);
  S.mixRoot = h("aside.mixer", { "aria-label": "调音台" });
  root.replaceChildren(S.side, center, S.mixRoot);
  mixer.mount(S.mixRoot);

  // One source: every status-bearing piece of the stage redraws from the shared row.
  app.bus.on("sessions", onRows);
  app.bus.on("approvals", () => { renderList(); renderCues(); if (!app.current) renderIdle(); });
  app.bus.on("current", (id) => open(id));
  app.core.on("event", onEvent);
  app.core.on("resync", (topic) => { if (topic === S.topic) reopen(); });
  app.core.on("reconnected", () => { if (app.current) reopen(); });
  renderList();
  renderIdle();
}

// ---------------- programme (sidebar) ----------------
// phase（model.js 派生的四态）而不是协议 status：每步之间核心会落回 Idle，照着画会一跳一跳。
const STATUS = {
  generating: { cls: "gen", label: "模型生成", glyph: "♩" },
  tools: { cls: "tool", label: "工具处理", glyph: "𝄀" },
  waiting: { cls: "wait", label: "等你", glyph: "𝄐" },
  idle: { cls: "idle", label: "闲置", glyph: "𝄽" },
};

function renderList() {
  if (!S.list) return;
  const groups = new Map();
  for (const pk of app.projects.keys()) groups.set(pk, []);
  for (const r of app.sessions.values()) {
    if (!groups.has(r.projectKey)) groups.set(r.projectKey, []);
    groups.get(r.projectKey).push(r);
  }
  const f = S.filter;
  const frag = document.createDocumentFragment();
  let shown = 0;
  let groupsShown = 0;
  const pks = [...groups.keys()].sort((a, b) => (a === app.homePk ? -1 : b === app.homePk ? 1 : projectLabel(a).localeCompare(projectLabel(b))));
  for (const pk of pks) {
    let rows = groups.get(pk);
    if (!S.showArchived) rows = rows.filter((r) => !S.archived.has(r.sessionId) || r.sessionId === app.current);
    if (f) rows = rows.filter((r) => (r.title || "").toLowerCase().includes(f) || r.sessionId.includes(f) || projectLabel(pk).toLowerCase().includes(f));
    // Nothing left to show means no header either: a workspace whose sessions are all archived
    // (and whose archived session is not the one currently open) disappears with its rows.
    if (!rows.length) continue;
    const open = !S.collapsed.has(pk) || f;
    const waits = rows.filter((r) => r.ask).length;
    const runs = rows.filter((r) => { const ph = phaseOf(r.sessionId); return ph === "generating" || ph === "tools"; }).length;
    const head = h("button.prog-proj", {
      type: "button", "aria-expanded": String(!!open), title: dirOf(pk) || pk,
      onclick: () => { S.collapsed.has(pk) ? S.collapsed.delete(pk) : S.collapsed.add(pk); store.set("collapsedProjects", [...S.collapsed]); renderList(); },
    },
      h("span.pp-caret", { "aria-hidden": "true" }, "›"),
      h("span.pp-name", projectLabel(pk)),
      pk === app.homePk ? h("span.chip.pp-home", "核心目录") : null,
      runs ? h("span.pp-badge.run", { title: `${runs} 个在跑` }, "♪" + runs) : null,
      waits ? h("span.pp-badge.wait", { title: `${waits} 个在等你` }, "𝄐" + waits) : null,
      h("span.pp-count.num", rows.length));
    const ul = h("ul.prog-sessions", { role: "group" });
    if (open) for (const r of rows) { ul.append(sessionRow(r)); shown++; }
    frag.append(h("div.prog-group", head, open ? ul : null));
    groupsShown++;
  }
  if (!app.sessions.size) {
    frag.append(h("div.empty.prog-empty", h("div.glyph", "𝄞"), h("div", "还没有会话"), h("button.btn.btn-sm", { type: "button", onclick: () => newSessionDialog() }, "开始第一首")));
  } else if (!groupsShown && f) frag.append(h("div.dim.prog-none", "没有匹配「" + f + "」的会话"));
  else if (!groupsShown) frag.append(h("div.dim.prog-none", "所有会话都已归档 · 勾选下方「显示已归档」查看"));
  swap(S.list, frag);
}

export function markArchived(id, on) {
  if (on) S.archived.add(id); else S.archived.delete(id);
  store.set("archived", [...S.archived]);
}
export const isArchived = (id) => S.archived.has(id);

function sessionRow(r) {
  const st = STATUS[phaseOf(r.sessionId)] || STATUS.idle;
  const cur = r.sessionId === app.current;
  const label = r.retry ? `重奏 ${r.retry.attempt}/${r.retry.max}` : st.label;
  const err = !r.retry && st.cls === "idle" && r.lastError;
  // 刚跑完、还没打开看过（doneAt 由 model 在 phase 落回 Idle 时打，打开会话时清）
  const done = !!r.doneAt && !cur && st.cls === "idle";
  return h("li", { role: "treeitem", "aria-selected": String(cur) },
    h(`button.prog-row.st-${st.cls}${r.retry ? ".retrying" : ""}${err ? ".errored" : ""}${done ? ".finished" : ""}${r.goal?.active ? ".goal" : ""}${cur ? ".current" : ""}${S.archived.has(r.sessionId) ? ".archived" : ""}${r.active ? "" : ".asleep"}`, {
      type: "button", onclick: () => setCurrent(r.sessionId),
      title: `${r.sessionId} · ${label}${done ? " · 刚跑完，还没打开看过" : ""}${r.goal?.active ? " · 目标进行中" : ""}${r.retry ? " · " + r.retry.reason : ""}${err ? " · 上一步失败：" + r.lastError.message : ""}${r.active ? "" : " · 未载入内存"}`,
    },
      h("span.pr-glyph", { "aria-hidden": "true" }, st.glyph),
      h("span.pr-main",
        h("span.pr-title", r.title || h("i.dim", "无题 " + r.sessionId.slice(0, 6))),
        h("span.pr-meta",
          h("span", err ? "失败 · 休止" : label),
          h("span.num", `第 ${r.turn} 小节`),
          r.goal?.active ? h("span.pr-goal", { title: "主动性轴 = goal：模型停回合会自动续跑" }, "⚑ 目标") : null,
          S.archived.has(r.sessionId) ? h("span", "已归档") : null)),
      r.active ? h("span.pr-live", { "aria-label": "已载入", title: "已载入内存" }) : null));
}

// ---------------- open a session ----------------
let openSeq = 0;

async function open(id) {
  const my = ++openSeq;
  // 打开 = 检查过进度：这一场的「待查看」高亮到此为止（model 不会再替它打回来）
  const doneRow = id ? app.sessions.get(id) : null;
  if (doneRow?.doneAt) doneRow.doneAt = 0;
  if (S.topic) { unwatchSession(S.topic.slice(8)); S.topic = null; }
  S.tl?.dispose();
  S.tl = null; S.snap = null;
  renderList();
  if (!id) { renderIdle(); return; }
  if (!app.sessions.has(id)) await refreshSessions();
  if (my !== openSeq) return;
  if (!app.sessions.has(id)) { setCurrent(null); return; }

  S.root.classList.add("has-session");
  swap(S.head, headSkeleton(id));
  swap(S.tlRoot, h("div.tl-loading", h("div.tll-bars", h("i"), h("i"), h("i"), h("i")), h("span", "调音中…")));
  clear(S.cues);
  S.composer.hidden = false;
  S.input.value = store.get("draft." + id, "");
  autosize();

  try {
    // Snapshot first: highWater closes the gap between snapshot and subscription.
    const snap = await app.core.get(`/sessions/${encodeURIComponent(id)}/state`);
    if (my !== openSeq) return;
    S.snap = snap;
    if (snap.spec?.workingDirectory) rememberDir(snap.spec.projectKey, snap.spec.workingDirectory);
    markArchived(id, !!snap.spec?.archivedAt);
    S.topic = "session:" + id;
    // The snapshot is the freshest truth we have at highWater; seed the shared row from it.
    markLocal(id, { status: snap.state?.status || "Idle", turn: snap.state?.turn ?? 0, ask: snap.ask?.askId ? { askId: snap.ask.askId, kind: snap.ask.kind, deadlineAt: snap.ask.deadlineAt } : null });
    watchSession(id, snap.highWater);
    S.tl = new Timeline(id, app.core, S.tlRoot);
    await S.tl.first();
    if (my !== openSeq) return;
    if (snap.ask?.askId) seedAskFromState(id, snap.ask);
    renderHead();
    renderCues();
    renderPerf();
    mixer.show(id, snap);
    S.input.focus({ preventScroll: true });
  } catch (e) {
    if (my !== openSeq) return;
    const tooNew = e.status >= 500;
    swap(S.tlRoot, h("div.empty.tl-err",
      h("div.glyph", "𝄪"),
      h("div", tooNew ? "这个核心读不了这个会话（可能是更新的核心写的）。别删它——用写它的那个核心打开。" : e.status === 404 ? "会话不存在了。" : "打不开：" + e.message),
      h("button.btn.btn-sm", { type: "button", onclick: () => reopen() }, "重试")));
  }
}

function reopen() { const id = app.current; app.current = null; setCurrent(id); }

function seedAskFromState(id, ask) {
  const prev = app.approvals.get(ask.askId);
  if (prev && prev.items?.length) return;
  app.approvals.set(ask.askId, {
    sessionId: id, askId: ask.askId, askKind: ask.kind, toolName: ask.toolName,
    deadlineAt: ask.deadlineAt, items: ask.items || [], remember: ask.remember || [], partial: false,
  });
  app.bus.emit("approvals");
}

function renderIdle() {
  S.root.classList.remove("has-session");
  const waiting = [...app.approvals.values()];
  const recent = [...app.sessions.values()].slice(0, 6);
  swap(S.head);
  S.composer.hidden = true;
  clear(S.cues);
  S.perf.hidden = true;
  swap(S.tlRoot, h("div.foyer",
    h("div.foyer-staff", { "aria-hidden": "true" }, h("i"), h("i"), h("i"), h("i"), h("i"), h("span.foyer-clef", "𝄞")),
    h("h1.foyer-title", "Cadenza"),
    h("p.foyer-sub", "华彩乐段：乐队停下，独奏者即兴。", h("br"), "这里是 Lilara 的舞台——你指挥，它演奏。"),
    h("div.foyer-actions",
      h("button.btn.btn-primary", { type: "button", onclick: () => newSessionDialog() }, "+ 新乐章"),
      h("button.btn", { type: "button", onclick: () => app.bus.emit("palette") }, "搜索与命令 ", h("kbd", "Ctrl"), h("kbd", "K"))),
    waiting.length ? h("div.foyer-sec", h("div.eyebrow", "在等你"), h("div.foyer-cards", ...waiting.map((a) => h("button.foyer-card.wait", { type: "button", onclick: () => setCurrent(a.sessionId) }, h("span", "𝄐"), h("b", titleOf(a.sessionId)), h("small", a.askKind === "permission" ? "授权 · " + (a.toolName || "") : "提问"))))) : null,
    recent.length ? h("div.foyer-sec", h("div.eyebrow", "最近的乐章"), h("div.foyer-cards", ...recent.map((r) => h("button.foyer-card", { type: "button", onclick: () => setCurrent(r.sessionId) }, h("span", (STATUS[phaseOf(r.sessionId)] || STATUS.idle).glyph), h("b", r.title || "无题 " + r.sessionId.slice(0, 6)), h("small", projectLabel(r.projectKey) + " · 第 " + r.turn + " 小节"))))) : null));
  mixer.show(null);
}

// ---------------- head ----------------
function headSkeleton(id) {
  return h("div.sh-main", h("div.eyebrow", "Movement"), h("h1.sh-title", titleOf(id)));
}

function renderHead() {
  const id = app.current;
  const snap = S.snap;
  if (!id || !snap) return;
  const row = app.sessions.get(id) || {};
  const spec = snap.spec || {};
  const status = phaseOf(id);
  const st = STATUS[status] || STATUS.idle;
  const archived = !!spec.archivedAt;
  swap(S.head,
    h("div.sh-main",
      h("div.sh-eyebrow",
        h("span.eyebrow", projectLabel(spec.projectKey || row.projectKey)),
        h("span.dim", "·"),
        h("span.eyebrow.mono", id)),
      h("h1.sh-title", spec.title || h("i.dim", "无题")),
      h("div.sh-meta",
        h(`span.sh-status.st-${st.cls}`, h("span.sh-dot"), st.label),
        h("span.chip.mono", { title: "提供商 / 模型" }, (spec.model?.providerId || "?") + " / " + (spec.model?.modelId || "?")),
        h("span.chip.num", { title: "回合" }, `第 ${snap.state?.turn ?? row.turn ?? 0} 小节`),
        (snap.goal?.active || row.goal?.active)
          ? h("span.chip.goal", { title: "主动性轴 = goal：模型停回合会自动续跑，直到调用 finish_goal" }, "⚑ 目标进行中")
          : null,
        spec.systemPromptPreset ? h("span.chip", { title: "系统提示词预设" }, "预设 " + spec.systemPromptPreset) : null,
        archived ? h("span.chip.plum", "已归档 " + fmtAgo(spec.archivedAt)) : null,
        row.active === false ? h("span.chip", { title: "未载入内存" }, "沉睡") : null,
        spec.workingDirectory ? h("button.chip.sh-cwd", { type: "button", title: "复制工作目录 " + spec.workingDirectory, onclick: () => copy(spec.workingDirectory) }, "⌂ " + baseName(spec.workingDirectory)) : null)),
    h("div.sh-actions",
      h("button.btn.btn-sm", { type: "button", title: "推进一步（队列空也推，崩在步中后收回会话用）", onclick: () => cmd({ kind: "session.start", sessionId: id }) }, "▶ 推进"),
      h("button.btn.btn-sm", { type: "button", title: "把此前的上下文压成摘要检查点", onclick: () => compact() }, "𝄐 压缩"),
      h("button.btn.btn-sm.btn-ghost", { type: "button", title: "开一次回收窗口", onclick: () => cmd({ kind: "session.gc", sessionId: id }) }, "𝄒 回收"),
      h("button.icon-btn", { type: "button", "aria-label": "更多操作", title: "更多", onclick: (e) => moreMenu(e.currentTarget) }, "⋯")));
}

async function compact() {
  const ok = await confirmDlg({ title: "压缩上下文？", body: "此前的中段会被一条摘要替代。这会破坏提示词缓存前缀——这是它唯一的目的，也是它的代价。", ok: "压缩" });
  if (ok) cmd({ kind: "session.compact", sessionId: app.current });
}
function moreMenu(anchor) {
  const id = app.current;
  const spec = S.snap?.spec || {};
  const archived = !!spec.archivedAt;
  const row = app.sessions.get(id) || {};
  const close = () => menu.remove();
  const item = (label, fn, cls = "") => h(`button.menu-item${cls}`, { type: "button", role: "menuitem", onclick: () => { close(); fn(); } }, label);
  const menu = h("div.menu", { role: "menu" },
    item(archived ? "取消归档" : "归档", async () => {
      const ack = await cmd({ kind: "session.archive", sessionId: id, archived: !archived });
      if (ack.accepted) { markArchived(id, !archived); reopen(); }
    }),
    item("从内存摘出", () => cmd({ kind: "session.deactivate", sessionId: id }).then(() => scheduleRefresh())),
    row.active === false ? item("载入内存", () => cmd({ kind: "session.activate", sessionId: id }).then(() => scheduleRefresh())) : null,
    item("复制会话 id", () => copy(id)),
    item("查看原始快照", () => modal("会话快照 · /state", jsonBlock(S.snap), { wide: true })),
    h("hr"),
    item("删除会话…", () => del(id), ".danger"));
  document.body.append(menu);
  const r = anchor.getBoundingClientRect();
  menu.style.top = r.bottom + 6 + "px";
  menu.style.right = Math.max(8, innerWidth - r.right) + "px";
  menu.querySelector("button")?.focus();
  setTimeout(() => {
    const off = (e) => { if (!menu.contains(e.target)) { close(); document.removeEventListener("pointerdown", off, true); } };
    document.addEventListener("pointerdown", off, true);
    menu.addEventListener("keydown", (e) => { if (e.key === "Escape") { close(); anchor.focus(); } });
  });
}

async function del(id) {
  const ok = await confirmDlg({
    title: "删除这个会话？", danger: true, ok: "永久删除", typed: id.slice(0, 6),
    body: "目录、记录、状态一起没了，不可逆。它的文件声明也会一并释放。",
  });
  if (!ok) return;
  const ack = await cmd({ kind: "session.delete", sessionId: id }, { ok: "已删除" });
  if (ack.accepted) { setCurrent(null); scheduleRefresh(50); }
}
// ---------------- live events ----------------
function onEvent(p, topic) {
  if (!S.topic || topic !== S.topic || p.sessionId !== app.current) return;
  const tl = S.tl;
  if (!tl) return;
  switch (p.kind) {
    case "message.appended":
    case "tool.result.appended":
    case "release.recorded":
      tl.apply(p);
      break;
    // Status itself is folded by model.onGlobalEvent (runs right after this) and redrawn in onRows.
    case "session.step.begin":
      S.retryNote = null;
      break;
    case "session.step.end":
      S.retryNote = null;
      if (p.refused) tl.note("error", ["模型拒答了这一步", p.stopReason ? h("code", p.stopReason) : null]);
      break;
    case "session.state":
      if (S.snap?.state) { S.snap.state.status = p.status; S.snap.state.turn = p.turn; }
      if (p.status !== "Running") S.retryNote = null;
      break;
    case "retry.attempt": {
      // One note per failing call, rewritten on each attempt — ten retries are not ten lines.
      // 单次上限来自 /providers 的缓存（会话的 providerId 在 /state 的 spec.model.providerId）：
      // 这一步会连着失败十来次，唯一能解释「为什么每次都卡在同一个时间点」的就是它。
      // ⚠️ 没配就不显示——缺键 = 协议默认，头不替核心编一个 100。
      const cap = providerTimeoutOf();
      const body = ["重奏 ", h("b.num", `${p.attempt} / ${p.maxAttempts}`), " · ", p.reason,
        h("span.dim", ` · ${(p.delayMs / 1000).toFixed(1)} 秒后再试`),
        cap ? h("span.dim", ` · 单次上限 ${cap} 秒`) : null];
      const nodes = body.filter((x) => x != null).map((x) => typeof x === "string" ? document.createTextNode(x) : x);
      if (S.retryNote?.isConnected) S.retryNote.querySelector("div").replaceChildren(...nodes);
      else S.retryNote = tl.note("retry", nodes);
      break;
    }
    case "axis.changed":
      if (S.snap) {
        S.snap.axes = { ...S.snap.axes, [p.axis]: p.value };
        // goal is derived from initiative; keep the header chip in sync without a refresh.
        if (p.axis === "initiative") S.snap.goal = { active: p.value === "goal" };
      }
      tl.note("axis", ["力度记号 · ", h("b", labelOfAxis(p.axis)), " → ", h("code", p.value)]);
      mixer.axis(p.axis, p.value);
      if (p.axis === "initiative") renderHead();
      break;
    case "spec.changed":
      if (S.snap?.spec) S.snap.spec.model = { ...S.snap.spec.model, ...p.model };
      tl.note("spec", ["换调 · ", h("code", (p.model?.providerId || "") + " / " + (p.model?.modelId || ""))]);
      renderHead(); mixer.refresh();
      break;
    case "error": {
      if (S.retryNote?.isConnected) S.retryNote.classList.add("spent");
      S.retryNote = null;
      const content = [h("b", "不和谐音 · "), p.message];
      // 认得出「模型调用超时（N 秒）」时，给一条就地改大的路。判据用稳定片段 + 解析数字，
      // 不做整句匹配：核心改措辞时这里自然失效（只退化成普通红字），不会乱出按钮。
      const secs = timeoutOfMessage(p.message);
      if (secs) content.push(providerTimeoutFix(secs));
      tl.note("error", content);
      break;
    }
    case "session.compaction.completed":
      tl.note("compact", ["延长记号 · 上下文已压缩至 ", h("code", p.coveredThroughEventId), p.summaryTokens != null ? `（摘要 ${fmtTokens(p.summaryTokens)} tokens）` : ""]);
      mixer.refresh();
      break;
    case "session.reclaimed":
      tl.note("reclaim", ["回收 · ", p.reason]);
      break;
    case "approval.requested":
      tl.note("ask", [p.askKind === "permission" ? "等你授权" : "等你回答", "——见下方提示卡"]);
      break;
    case "approval.resolved":
      tl.note("ask", ["询问已了结 · ", h("code", p.outcome)]);
      break;
    case "usage.updated":
      mixer.usage(p);
      break;
    case "session.archived":
      if (S.snap?.spec) { if (p.archivedAt) S.snap.spec.archivedAt = p.archivedAt; else delete S.snap.spec.archivedAt; }
      markArchived(p.sessionId, !!p.archivedAt);
      renderHead(); renderList();
      break;
    case "session.deactivated":
      scheduleRefresh();
      break;
  }
}

function labelOfAxis(name) {
  return S.snap?.axisDefinitions?.find((d) => d.name === name)?.label || app.axes?.axes?.find((d) => d.name === name)?.label || name;
}

/** 本会话提供商的「调用超时」配置（null = 没配，由协议自己的默认值管）。 */
function providerTimeoutOf() {
  const pid = S.snap?.spec?.model?.providerId;
  const p = pid ? app.providers?.find((x) => x.id === pid) : null;
  return p?.timeoutSeconds || null;
}

/** 「模型调用超时（600 秒）」→ 600。只认这个稳定片段，认不出就返回 null。 */
function timeoutOfMessage(message) {
  const m = /模型调用超时[（(]\s*(\d+)\s*秒/.exec(String(message || ""));
  return m ? Number(m[1]) : null;
}

/** 超时失败的就地改大：把该提供商调到两倍（下一次调用生效，不用重建会话）。 */
function providerTimeoutFix(seconds) {
  const pid = S.snap?.spec?.model?.providerId;
  if (!pid) return null;
  const next = seconds * 2; // 越界（> 1800）时核心会拒，理由照它的 reason 显示——头不手抄区间
  const btn = h("button.btn.btn-sm.btn-ghost", { type: "button" }, `把「${pid}」的调用超时调到 ${next} 秒`);
  btn.addEventListener("click", async () => {
    btn.disabled = true;
    const ack = await cmd({ kind: "provider.upsert", id: pid, timeoutSeconds: next },
      { ok: `已把「${pid}」调到 ${next} 秒 · 下一次调用生效` });
    if (ack.accepted) refreshProviders(); else btn.disabled = false;
  });
  return h("div.mt", btn);
}

/** Everything on the stage that shows "running / waiting / retrying" redraws from the shared row here. */
function onRows() {
  renderList();
  if (!app.current) { renderIdle(); return; }
  if (S.snap) { renderHead(); renderPerf(); }
}

// ---------------- performance indicator ----------------
let perfKey = "";
function renderPerf() {
  syncComposer();
  const r = app.sessions.get(app.current) || {};
  if (!isRunning(app.current)) { clearInterval(S.perfTimer); perfKey = ""; S.perf.hidden = true; return; }
  // Rebuild only when the shape changes, so the timer text does not flicker on every row event.
  const key = r.retry ? `retry:${r.retry.attempt}` : "run";
  S.perf.hidden = false;
  S.perf.classList.toggle("retrying", !!r.retry);
  if (key === perfKey) return;
  perfKey = key;
  clearInterval(S.perfTimer);
  const t = h("span.perf-t.num");
  swap(S.perf,
    h("span.perf-eq", { "aria-hidden": "true" }, h("i"), h("i"), h("i"), h("i"), h("i")),
    h("span.perf-l", r.retry ? `重奏 ${r.retry.attempt}/${r.retry.max}` : "演奏中"),
    r.retry ? h("span.perf-why", { title: r.retry.reason }, r.retry.reason) : null,
    t,
    h("span.sp"),
    h("button.btn.btn-sm.btn-ghost", { type: "button", onclick: () => interrupt() }, "■ 中断"));
  const tick = () => {
    const row = app.sessions.get(app.current) || {};
    if (row.retry) {
      const left = row.retry.until - Date.now();
      t.textContent = left > 0 ? `${(left / 1000).toFixed(1)}s 后再试` : "再试中…";
    } else t.textContent = row.stepAt ? fmtDur(Date.now() - row.stepAt) : "";
  };
  tick();
  S.perfTimer = setInterval(tick, 200);
}
// ---------------- composer ----------------
function autosize() {
  const t = S.input;
  t.style.height = "auto";
  t.style.height = Math.min(t.scrollHeight, 260) + "px";
}
const saveDraft = debounce(() => {
  if (!app.current) return;
  const v = S.input.value;
  if (v) store.set("draft." + app.current, v); else store.del("draft." + app.current);
}, 250);

function syncComposer() {
  const run = isRunning(app.current);
  S.stopBtn.hidden = !run;
  S.qInfo.textContent = run ? "演奏中发送 = 排进队列，下一步推进" : "";
}

async function send() {
  const text = S.input.value.trim();
  const id = app.current;
  if (!text || !id) return;
  const waiting = [...app.approvals.values()].find((a) => a.sessionId === id);
  if (waiting) {
    const ok = await confirmDlg({ title: "顶替这次询问？", body: "它还在等你回答。直接发新消息会把那次询问作废（模型会看到「用户没回答，说了别的」）。", ok: "照发" });
    if (!ok) return;
  }
  S.sendBtn.disabled = true;
  const ack = await cmd({ kind: "session.send", sessionId: id, blocks: [{ kind: "text", text }] }, { quiet: true });
  S.sendBtn.disabled = false;
  if (ack.accepted) {
    S.input.value = "";
    store.del("draft." + id);
    autosize();
    S.tl?.scrollEnd();
  }
}

async function interrupt() {
  if (!app.current) return;
  const ack = await cmd({ kind: "session.interrupt", sessionId: app.current }, { ok: "已中断" });
  if (ack.accepted) S.tl?.note("interrupt", "休止 · 你让它停下了");
}

export function focusComposer() { if (!S.composer.hidden) S.input.focus(); }

// ---------------- cues (pending approvals for this session) ----------------
let cueSeq = 0;
async function renderCues() {
  if (!S.cues) return;
  const my = ++cueSeq;
  const id = app.current;
  const mine = [...app.approvals.values()].filter((a) => a.sessionId === id);
  for (const c of [...S.cues.children]) if (!mine.some((a) => a.askId === c.dataset.askId)) c.remove();
  for (const a of mine) {
    if (S.cues.querySelector(`[data-ask-id="${a.askId}"]`)) continue;
    await hydrate(a);
    if (my !== cueSeq || app.current !== id || S.cues.querySelector(`[data-ask-id="${a.askId}"]`)) continue;
    const card = cueCard(a, { onDone: () => setTimeout(() => card.remove(), 400) });
    S.cues.append(card);
    card.querySelector("input,textarea,button.btn-ok,button.btn-primary")?.focus({ preventScroll: true });
  }
  S.root.classList.toggle("has-cue", mine.length > 0);
  if (S.snap) renderHead();
}
// ---------------- new session ----------------
export async function newSessionDialog(presetDir) {
  if (!app.providers.length) {
    const go = await confirmDlg({ title: "先配一个提供商", body: "核心没有提供商时不能建会话。去后台配一个？", ok: "去后台" });
    if (go) app.bus.emit("goto", "greenroom");
    return;
  }
  const dir = presetDir || dirOf(app.current && app.sessions.get(app.current)?.projectKey) || app.info?.workingDirectory || "";
  const title = h("input.inp", { placeholder: "比如：重构登录流程", "aria-label": "标题" });
  const cwd = h("input.inp.mono", { value: dir, "aria-label": "工作目录", spellcheck: false });
  const preset = h("select.sel", { "aria-label": "预设" }, h("option", { value: "" }, "（不指定 · 内置模板）"));
  const timeout = h("input.inp.num", { type: "number", min: 1, placeholder: "不超时", "aria-label": "询问超时（分钟）" });
  const browser = h("div.dirb");
  const err = h("div.form-err", { role: "alert" });
  refreshPresets().then((list) => { for (const p of list) preset.append(h("option", { value: p }, p)); });

  const form = h("form.newsess",
    h("p.dim", "标题只能在这里起一次——核心此后没有改名命令。"),
    h("label.field", h("span", h("b", "标题")), title),
    h("label.field", h("span", h("b", "工作目录"), " · 决定会话属于哪个项目（核心所在设备上的路径）"), h("div.row", cwd, h("button.btn.btn-sm", { type: "button", onclick: () => browse(cwd.value) }, "浏览…"))),
    browser,
    h("div.grid2",
      h("label.field", h("span", "系统提示词预设"), preset),
      h("label.field", h("span", "询问超时（分钟）"), timeout)),
    err,
    h("div.dlg-actions",
      h("button.btn.btn-ghost", { type: "button", onclick: () => m.close() }, "取消"),
      h("button.btn.btn-primary", { type: "submit" }, "开始演奏")));
  const m = modal("新乐章", form);
  title.focus();

  async function browse(path) {
    browser.classList.add("open");
    swap(browser, h("div.dim", "读取中…"));
    try {
      const q = path ? "?path=" + encodeURIComponent(path) : "";
      const d = await app.core.get("/directories" + q);
      const items = d.directories || [];
      swap(browser,
        h("div.dirb-h",
          d.parent != null || d.current ? h("button.btn.btn-ghost.btn-sm", { type: "button", onclick: () => browse(d.parent || "") }, "↑ 上一级") : null,
          h("code.dirb-cur", d.current || "盘符"),
          h("span.sp"),
          d.current ? h("button.btn.btn-sm.btn-ok", { type: "button", onclick: () => { cwd.value = d.current; browser.classList.remove("open"); clear(browser); } }, "选这里") : null),
        d.error ? h("div.form-err", d.error) : null,
        h("ul.dirb-list", ...items.map((x) => h("li", h("button", { type: "button", onclick: () => browse(x.path), ondblclick: () => { cwd.value = x.path; } }, "▸ ", x.name)))),
        !items.length && !d.error ? h("div.dim", "（没有子目录）") : null);
    } catch (e) {
      swap(browser, h("div.form-err", e.message), h("button.btn.btn-sm", { type: "button", onclick: () => browse("") }, "从盘符开始"));
    }
  }

  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    err.textContent = "";
    const payload = { kind: "session.create" };
    if (title.value.trim()) payload.title = title.value.trim();
    if (cwd.value.trim()) payload.cwd = cwd.value.trim();
    if (preset.value) payload.preset = preset.value;
    const t = parseInt(timeout.value, 10);
    if (t > 0) payload.askTimeoutMinutes = t;
    const ack = await app.core.command(payload);
    if (!ack.accepted) { err.textContent = ack.reason || "被拒绝了"; return; }
    if (ack.note && payload.cwd) rememberDir(ack.note, payload.cwd);
    else if (payload.cwd) projectKeyOf(payload.cwd).then((pk) => rememberDir(pk, payload.cwd));
    m.close();
    toast("新乐章已就位", "ok");
    await refreshSessions();
    setCurrent(ack.sessionId);
  });
}
