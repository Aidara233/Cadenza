// Cadenza · stage — the session view: programme (sidebar) · score (timeline) · mixer (inspector).
import { h, $, swap, clear, fmtTime, fmtAgo, fmtTokens, fmtNum, fmtDur, store, toast, confirmDlg, modal, debounce, copy, jsonBlock, baseName } from "./util.js";
import { app, cmd, titleOf, projectLabel, dirOf, rememberDir, setCurrent, refreshSessions, refreshPresets, refreshProviders, scheduleRefresh, watchSession, unwatchSession, markLocal, phaseOf } from "./model.js";
import { bobDelay, applyBob, onBob } from "./beat.js";
import { Timeline } from "./timeline.js";
import { cueCard, hydrate } from "./approvals.js";
import { renderBlock } from "./blocks.js";
import { projectKeyOf } from "./core.js";
import { mixer } from "./mixer.js";

const S = {
  root: null,
  side: null, list: null, filter: { terms: [], raw: "" }, showArchived: store.get("showArchived", false),
  runTimer: 0, runtimeNodes: new Map(),
  head: null, tlRoot: null, cues: null, composer: null, input: null, perf: null,
  mixRoot: null,
  tl: null, tlId: null, snap: null, topic: null, perfTimer: 0, retryNote: null,
  archived: new Set(store.get("archived", [])),
  collapsed: new Set(store.get("collapsedProjects", [])),
  // 子会话的折叠：按父 id 记（父子关系来自 /sessions 快照，本机记住「我收起了谁」）。
  collapsedParents: new Set(store.get("collapsedParents", [])),
  // 头部那个子会话面板：按会话记，纯内存——它是「此刻我在看谁的子树」，不是一条偏好。
  kidsOpen: new Set(),
};

export function mountStage(root) {
  S.root = root;
  root.classList.add("stage");
  S.list = h("div.prog-list", { role: "tree", "aria-label": "会话" });
  const search = h("input.inp.prog-search", { type: "search", placeholder: "筛选：title:… project:… status:waiting", "aria-label": "筛选会话", title: "支持 title:、id:、project:、status:（running/waiting/idle）；词之间按 AND 匹配，引号可包含空格" });
  search.addEventListener("input", debounce(() => { S.filter = parseSessionFilter(search.value); renderList(); }, 80));
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

  // 节拍：写进 CSS 变量，改的时候重画一次（负延迟会跟着新周期重新对齐）
  applyBob();
  onBob(() => renderList());
  S.runTimer = setInterval(tickRuntime, 1000);
  tickRuntime();
}

// ---------------- programme (sidebar) ----------------
function parseSessionFilter(value) {
  const tokens = String(value).match(/(?:[^\s"]+|"[^"]*")+/g) || [];
  const fields = new Set(["title", "id", "project", "status", "parent", "turn"]);
  const terms = [];
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    const colon = token.indexOf(":");
    const key = colon > 0 ? token.slice(0, colon).toLowerCase() : "";
    let raw = colon > 0 ? token.slice(colon + 1) : token;
    let val;
    if (raw.startsWith('"')) {
      raw = raw.slice(1);
      if (raw.endsWith('"')) raw = raw.slice(0, -1);
      else {
        const next = tokens[++i];
        if (next) raw += " " + next.replace(/"$/g, "");
      }
      val = raw;
    } else val = raw.replace(/"$/g, "");
    if (val) terms.push({ key: fields.has(key) ? key : "", val: val.toLowerCase() });
  }
  return { raw: String(value), terms };
}
function escapeFilterRegExp(value) { return value.replace(/[.*+?^${}()|[\\]\\\\]/g, "\\$&"); }

// phase（model.js 派生的四态）而不是协议 status：每步之间核心会落回 Idle，照着画会一跳一跳。
const STATUS = {
  generating: { cls: "gen", label: "谱曲", glyph: "♩" },
  tools: { cls: "tool", label: "排练", glyph: "♩" },
  waiting: { cls: "wait", label: "候场", glyph: "𝄐" },
  idle: { cls: "idle", label: "休止", glyph: "𝄽" },
};

// 节目单以稳定 key 协调 DOM；普通状态更新会保留行和行内按钮，避免 hover 目标被移除。
const rowSig = (r) => [
  phaseOf(r.sessionId), r.title, r.parentSessionId, app.sessions.get(r.parentSessionId)?.title, r.turn,
  r.retry ? r.retry.attempt + "/" + r.retry.max + "/" + r.retry.reason : "",
  r.doneAt || 0, r.lastError ? r.lastError.at : 0, r.active ? 1 : 0,
  r.goal && r.goal.active ? 1 : 0, S.archived.has(r.sessionId) ? 1 : 0,
  r.sessionId === app.current ? 1 : 0,
].join("|");

function rowNode(r, depth = 0, orphan = false, kids = { count: 0, drawable: 0, open: true, waiting: 0, running: 0 }) {
  const cache = S.rowNodes || (S.rowNodes = new Map());
  const sig = rowSig(r) + "|" + depth + "|" + (orphan ? 1 : 0) + "|" + kids.count + "|" + kids.drawable + "|" + (kids.open ? 1 : 0) + "|" + kids.waiting + "|" + kids.running + "|" + (S.filter.terms.length ? 1 : 0);
  let entry = cache.get(r.sessionId);
  if (!entry) {
    const li = sessionRow(r, depth, orphan, kids);
    entry = { li, sig };
    cache.set(r.sessionId, entry);
  } else if (entry.sig !== sig) {
    updateSessionRow(entry.li, r, depth, orphan, kids);
    entry.sig = sig;
  }
  return entry.li;
}

function syncChildren(parent, desired) {
  const keep = new Set(desired);
  for (const node of [...parent.children]) if (!keep.has(node)) node.remove();
  for (let i = 0; i < desired.length; i++) {
    const node = desired[i];
    const at = parent.children[i] || null;
    if (node !== at) parent.insertBefore(node, at);
  }
}

function renderList() {
  if (!S.list) return;
  const groups = new Map();
  for (const pk of app.projects.keys()) groups.set(pk, []);
  for (const r of app.sessions.values()) {
    if (!groups.has(r.projectKey)) groups.set(r.projectKey, []);
    groups.get(r.projectKey).push(r);
  }
  const f = S.filter;
  const filtering = f.terms.length > 0;
  const wantedGroups = [];
  let groupsShown = 0;
  const pks = [...groups.keys()].sort((a, b) => (a === app.homePk ? -1 : b === app.homePk ? 1 : projectLabel(a).localeCompare(projectLabel(b))));
  for (const pk of pks) {
    const allRows = groups.get(pk);
    const byId = new Map(allRows.map((r) => [r.sessionId, r]));
    const children = new Map();
    for (const r of allRows) {
      const parentId = r.parentSessionId && byId.has(r.parentSessionId) ? r.parentSessionId : null;
      const list = children.get(parentId) || [];
      list.push(r);
      children.set(parentId, list);
    }
    const matches = (r) => !f.terms.length || f.terms.every(({ key, val }) => {
      const ph = phaseOf(r.sessionId);
      const values = {
        title: r.title || "", id: r.sessionId, project: projectLabel(pk),
        status: ph === "waiting" ? "waiting ask" : ph === "generating" || ph === "tools" ? "running active" : "idle",
        parent: r.parentSessionId || "", turn: String(r.turn ?? ""),
      };
      const text = key ? String(values[key] ?? "").toLowerCase() : [r.title, r.sessionId, projectLabel(pk), r.parentSessionId, ph, r.turn].join(" ").toLowerCase();
      return val.includes("*") ? new RegExp("^" + val.split("*").map(escapeFilterRegExp).join(".*") + "$", "i").test(text) : text.includes(val);
    });
    const baseVisible = (r) => (S.showArchived || !S.archived.has(r.sessionId) || r.sessionId === app.current) && matches(r);
    const included = new Set(allRows.filter(baseVisible).map((r) => r.sessionId));
    const matching = new Set(allRows.filter(matches).map((r) => r.sessionId));
    // Search results keep their ancestor chain visible as context, including archived parents.
    if (filtering) for (const id of matching) {
      let parent = byId.get(id)?.parentSessionId;
      while (parent && byId.has(parent)) { included.add(parent); parent = byId.get(parent).parentSessionId; }
    }
    const ordered = [];
    const visited = new Set();
    // 折叠判据只有一处：筛选时一律展开（把搜到的行藏起来会让筛选看起来坏了），
    // 当前打开的那一条的祖先链也一律展开（否则打开子会话时它会从列表里凭空消失）。
    const openChain = new Set();
    if (app.current && byId.has(app.current)) {
      let p = byId.get(app.current).parentSessionId;
      while (p && byId.has(p) && !openChain.has(p)) { openChain.add(p); p = byId.get(p).parentSessionId; }
    }
    const expanded = (id) => filtering || openChain.has(id) || !S.collapsedParents.has(id);
    // 收起的父行：整棵子树不画，但**要标成已归位**——否则下面「孤儿/环」那一遍
    // 会把它们当成没画过、以顶层身份再冒出来一次。
    const skipSubtree = (r) => {
      if (visited.has(r.sessionId)) return;
      visited.add(r.sessionId);
      for (const child of children.get(r.sessionId) || []) skipSubtree(child);
    };
    // 收起时把子树里「在等你 / 在跑」的条数汇总到父行上：收起不等于失明，
    // 而那两件事正是收起之后最容易被漏掉的（核心的浮动行里也只有子会话状态）。
    const hiddenStats = (id) => {
      let waiting = 0, running = 0;
      const seen = new Set([id]);
      const stack = [...(children.get(id) || [])];
      while (stack.length) {
        const n = stack.pop();
        if (seen.has(n.sessionId)) continue;
        seen.add(n.sessionId);
        // 归档的不算：它们不会再跑、也不会再问（只可能留下一条过期的 ask）。
        if (S.archived.has(n.sessionId)) continue;
        if (n.ask) waiting++;
        const ph = phaseOf(n.sessionId);
        if (ph === "generating" || ph === "tools") running++;
        stack.push(...(children.get(n.sessionId) || []));
      }
      return { waiting, running };
    };
    const walk = (r, depth, orphan = false) => {
      if (visited.has(r.sessionId)) return;
      visited.add(r.sessionId);
      const show = included.has(r.sessionId);
      const kids = children.get(r.sessionId) || [];
      const open = expanded(r.sessionId);
      if (show) {
        const hidden = open ? { waiting: 0, running: 0 } : hiddenStats(r.sessionId);
        // 两个数不是一回事：`count` 是**未归档**的子会话数（用户要的那个数），
        // `drawable` 是「此刻会被画出来的行数」——勾着「显示已归档」时它更大。
        // 开关按 `drawable` 出现（有行可收才给开关），数字按 `count` 报（归档的不占名额）。
        ordered.push({
          row: r, depth, orphan,
          kids: {
            count: kids.filter((k) => !S.archived.has(k.sessionId)).length,
            drawable: kids.filter((k) => included.has(k.sessionId)).length,
            open, ...hidden,
          },
        });
      }
      if (!open) { for (const child of kids) skipSubtree(child); return; }
      for (const child of kids) walk(child, depth + (show ? 1 : 0));
    };
    for (const r of children.get(null) || []) walk(r, 0);
    // Orphans and malformed cycles remain directly openable as standalone rows.
    for (const r of allRows) if (!visited.has(r.sessionId)) walk(r, 0, true);
    for (const item of ordered) {
      const parentId = item.row.parentSessionId;
      if (parentId && (!byId.has(parentId) || !ordered.some((x) => x.row.sessionId === parentId))) {
        item.depth = 0;
        item.orphan = true;
      }
    }
    // 项目头那三个计数按「这个项目里可见的会话」算，不按「此刻画出来的行」算：
    // 收起一个父行不该让「♪ 2 个在跑」跟着掉成 0（那正是收起时最需要看见的信息）。
    const visible = allRows.filter((r) => included.has(r.sessionId));
    // Nothing left to show means no header either: a workspace whose sessions are all archived
    // (and whose archived session is not the one currently open) disappears with its rows.
    if (!visible.length) continue;
    const open = !S.collapsed.has(pk) || !!f;
    const waits = visible.filter((r) => r.ask).length;
    const runs = visible.filter((r) => { const ph = phaseOf(r.sessionId); return ph === "generating" || ph === "tools"; }).length;
    const state = S.groups || (S.groups = new Map());
    let group = state.get(pk);
    if (!group) {
      const head = h("button.prog-proj", { type: "button", onclick: () => {
        S.collapsed.has(pk) ? S.collapsed.delete(pk) : S.collapsed.add(pk);
        store.set("collapsedProjects", [...S.collapsed]); renderList();
      } }, h("span.pp-caret", { "aria-hidden": "true" }, "›"), h("span.pp-name"), h("span.chip.pp-home", "核心目录"), h("span.pp-badge.run"), h("span.pp-badge.wait"), h("span.pp-count.num"));
      const ul = h("ul.prog-sessions", { role: "group" });
      group = { el: h("div.prog-group", { dataset: { key: pk } }, head, ul), head, ul };
      state.set(pk, group);
    }
    group.head.setAttribute("aria-expanded", String(!!open));
    group.head.title = dirOf(pk) || pk;
    group.head.querySelector(".pp-name").textContent = projectLabel(pk);
    const home = group.head.querySelector(".pp-home");
    home.hidden = pk !== app.homePk;
    const runBadge = group.head.querySelector(".pp-badge.run");
    runBadge.hidden = !runs; runBadge.title = `${runs} 个在跑`; runBadge.textContent = runs ? "♪" + runs : "";
    const waitBadge = group.head.querySelector(".pp-badge.wait");
    waitBadge.hidden = !waits; waitBadge.title = `${waits} 个在等你`; waitBadge.textContent = waits ? "𝄐" + waits : "";
    group.head.querySelector(".pp-count").textContent = visible.length;
    group.ul.hidden = !open;
    if (open) {
      const desiredRows = ordered.map((item) => rowNode(item.row, item.depth, item.orphan, item.kids));
      syncChildren(group.ul, desiredRows);
    }
    wantedGroups.push(group.el);
    groupsShown++;
  }
  if (!app.sessions.size) {
    wantedGroups.push(h("div.empty.prog-empty", { dataset: { key: "empty" } }, h("div.glyph", "𝄞"), h("div", "还没有会话"), h("button.btn.btn-sm", { type: "button", onclick: () => newSessionDialog() }, "开始第一首")));
  } else if (!groupsShown && f) {
    wantedGroups.push(h("div.dim.prog-none", { dataset: { key: "none" } }, "没有匹配「" + f + "」的会话"));
  } else if (!groupsShown) {
    wantedGroups.push(h("div.dim.prog-none", { dataset: { key: "none" } }, "所有会话都已归档 · 勾选下方「显示已归档」查看"));
  }
  const liveProjects = new Set(pks);
  for (const [pk, group] of S.groups || []) if (!liveProjects.has(pk)) { group.el.remove(); S.groups.delete(pk); }
  for (const [id] of S.rowNodes || []) if (!app.sessions.has(id)) S.rowNodes.delete(id);
  pruneTimelineCache();
  syncChildren(S.list, wantedGroups);
}

export function markArchived(id, on) {
  if (on) S.archived.add(id); else S.archived.delete(id);
  store.set("archived", [...S.archived]);
}
export const isArchived = (id) => S.archived.has(id);

// bobDelay 现在住在 js/beat.js（节拍可调，相位对齐也在那里）

function sessionRow(r, depth = 0, orphan = false, kids = { count: 0, drawable: 0, open: true, waiting: 0, running: 0 }) {
  const st = STATUS[phaseOf(r.sessionId)] || STATUS.idle;
  const cur = r.sessionId === app.current;
  const label = r.retry ? `重奏 ${r.retry.attempt}/${r.retry.max}` : st.label;
  const err = !r.retry && st.cls === "idle" && r.lastError;
  // 刚跑完、还没打开看过（doneAt 由 model 在 phase 落回 Idle 时打，打开会话时清）
  const done = !!r.doneAt && !cur && st.cls === "idle";
  const runtime = h("span.pr-runtime.num", runtimeText(r));
  const parent = r.parentSessionId ? app.sessions.get(r.parentSessionId) : null;
  const relation = parent ? `子会话 · ${titleOf(parent.sessionId)}` : r.parentSessionId ? `父会话 ${r.parentSessionId} 已不在列表` : "顶层会话";
  orphan = orphan || (!!r.parentSessionId && !parent);
  // 开关按「有行可收」出现；数字只数**未归档**的（归档的不占名额）。
  const hasKids = kids.drawable > 0;
  const kidsWord = kids.count > 0
    ? `${kids.count} 个子会话`
    : "子会话都已归档";
  // 收起之后仍然要看得见的两件事（汇总自子树，判据在 renderList 的 hiddenStats）：
  const hiddenWait = !kids.open && kids.waiting > 0;
  const hiddenRun = !kids.open && kids.running > 0;
  // 折叠开关：它**不是**行按钮的一部分（按钮里再套按钮是非法的），
  // 所以它是 li 里的兄弟节点，占一格固定宽度（叶子行也留白，同一层的行才对得齐）。
  const toggle = h("span.pr-toggle", {
    role: hasKids ? "button" : null,
    tabindex: hasKids ? "0" : null,
    "aria-expanded": hasKids ? String(kids.open) : null,
    "aria-label": hasKids ? `${kids.open ? "收起" : "展开"} ${kidsWord}` : null,
    title: hasKids ? `${kids.open ? "收起" : "展开"} ${kidsWord}（已归档的不计）` : null,
    onclick: hasKids ? (e) => { e.stopPropagation(); toggleParent(r.sessionId, kids.open); } : null,
    onkeydown: hasKids ? (e) => {
      if (e.key === "Enter" || e.key === " " || e.key === "Spacebar") {
        e.preventDefault(); e.stopPropagation(); toggleParent(r.sessionId, kids.open);
      }
    } : null,
  },
    hasKids ? h("span.pr-caret", { "aria-hidden": "true" }, kids.open ? "▾" : "▸") : null,
    hasKids && kids.count > 0 ? h("span.pr-kids.num", { "aria-hidden": "true" }, String(kids.count)) : null);
  const li = h("li.prog-li", { role: "treeitem", "aria-selected": String(cur), "aria-level": depth + 1, style: depth ? { "--tree-depth": depth } : null },
    toggle,
    h(`button.prog-row.st-${st.cls}${depth ? ".child" : ""}${orphan ? ".orphan" : ""}${r.retry ? ".retrying" : ""}${err ? ".errored" : ""}${done ? ".finished" : ""}${r.goal?.active ? ".goal" : ""}${cur ? ".current" : ""}${S.archived.has(r.sessionId) ? ".archived" : ""}${r.active ? "" : ".asleep"}${hasKids && !kids.open ? ".collapsed" : ""}`, {
      type: "button", onclick: () => setCurrent(r.sessionId),
      title: `${r.sessionId} · ${relation}${parent ? " · 父 id " + parent.sessionId : ""} · ${label}${hasKids ? ` · ${kidsWord}${kids.open ? "" : `（已收起${kids.waiting ? ` · ${kids.waiting} 个在等你` : ""}${kids.running ? ` · ${kids.running} 个在跑` : ""}）`}` : ""}${done ? " · 刚跑完，还没打开看过" : ""}${r.goal?.active ? " · 目标进行中" : ""}${r.retry ? " · " + r.retry.reason : ""}${err ? " · 上一步失败：" + r.lastError.message : ""}${r.active ? "" : " · 未载入内存"}`,
    },
      depth ? h("span.pr-tree", { "aria-hidden": "true" }, "↳") : null,
      h("span.pr-glyph", { "aria-hidden": "true", style: { animationDelay: bobDelay() } }, st.glyph),
      h("span.pr-main",
        h("span.pr-title", r.title || h("i.dim", "无题 " + r.sessionId.slice(0, 6))),
        h("span.pr-meta",
          h("span", err ? "失败 · 休止" : label),
          runtime,
          h("span.num.pr-turn", { title: `第 ${r.turn} 小节` }, `第 ${r.turn} 小节`),
          r.goal?.active ? h("span.pr-goal", { title: "目标进行中", "aria-label": "目标进行中" }, "⚑") : null,
          hiddenWait ? h("span.pr-kidwait.num", { title: `收起着的子树里有 ${kids.waiting} 个在等你` }, "𝄐" + kids.waiting) : null,
          hiddenRun ? h("span.pr-kidrun.num", { title: `收起着的子树里有 ${kids.running} 个在跑` }, "♩" + kids.running) : null,
          S.archived.has(r.sessionId) ? h("span", "已归档") : null)),
      st.cls === "tool" ? h("span.pr-tool", { title: "工具调用中", "aria-hidden": "true" }, "𝄀") : null,
      r.active ? h("span.pr-live", { "aria-label": "已载入", title: "已载入内存" }) : null));
  (S.runtimeNodes || (S.runtimeNodes = new Map())).set(r.sessionId, runtime);
  return li;
}

/** 收起 / 展开一个父行。状态落 localStorage：这是「我习惯怎么看这棵树」，不是会话事实。 */
export function toggleParent(id, expanded) {
  if (expanded) S.collapsedParents.add(id); else S.collapsedParents.delete(id);
  store.set("collapsedParents", [...S.collapsedParents]);
  renderList();
}

function updateSessionRow(li, r, depth = 0, orphan = false, kids = { count: 0, drawable: 0, open: true, waiting: 0, running: 0 }) {
  const fresh = sessionRow(r, depth, orphan, kids);
  li.setAttribute("aria-selected", fresh.getAttribute("aria-selected"));
  li.setAttribute("aria-level", fresh.getAttribute("aria-level"));
  li.style.cssText = fresh.style.cssText;
  // 折叠开关整只换掉：它的 onclick 闭包捕获了当时的 open 值，改属性改不掉那个闭包。
  // 它不是 hover 目标（行按钮才是），换掉不会闪。
  const oldToggle = li.querySelector(".pr-toggle");
  const newToggle = fresh.querySelector(".pr-toggle");
  if (oldToggle && newToggle) oldToggle.replaceWith(newToggle);
  const oldButton = li.querySelector(".prog-row");
  const newButton = fresh.querySelector(".prog-row");
  oldButton.className = newButton.className;
  oldButton.title = newButton.title;
  oldButton.replaceChildren(...newButton.childNodes);
  S.runtimeNodes.set(r.sessionId, oldButton.querySelector(".pr-runtime"));
}

function runtimeText(r, now = Date.now()) {
  if (r.runSince) return fmtDur((r.runElapsedMs || 0) + Math.max(0, now - r.runSince));
  return r.runElapsedMs != null ? fmtDur(r.runElapsedMs) : "";
}

function tickRuntime() {
  const now = Date.now();
  for (const [id, node] of S.runtimeNodes || []) {
    const r = app.sessions.get(id);
    if (!r) { S.runtimeNodes.delete(id); continue; }
    const text = runtimeText(r, now);
    if (node.textContent !== text) node.textContent = text;
  }
}

// ---------------- timeline cache ----------------
// 切回最近看过的会话时直接复用已经渲染好的时间线：DOM、分页游标、seen 集合都还在。
// 只放内存、最多 4 条；不落盘（历史里可能有敏感内容，且缓存只对本次页面有意义）。
const tlCache = new Map();     // sessionId -> { tl, at }
// 条数和总消息数双上限：8 个短会话可以都留着；一个翻过很多页的长会话
// 也不会因为「只数会话数」把内存吃穿（超预算时仍按最久未用淘汰）。
const TL_CACHE_MAX = 8;
const TL_CACHE_MAX_ITEMS = 2000;

function cacheTimeline(id, tl) {
  if (!id || !tl) return;
  tlCache.delete(id);
  tlCache.set(id, { tl, at: Date.now() });
  while (true) {
    let size = 0, items = 0;
    for (const v of tlCache.values()) { size++; items += v.tl.count || 0; }
    if (size <= TL_CACHE_MAX && items <= TL_CACHE_MAX_ITEMS) break;
    let victim = null;
    for (const [k, v] of tlCache) {
      if (k === app.current) continue;
      if (!victim || v.at < victim[1].at) victim = [k, v];
    }
    if (!victim) break;
    victim[1].tl.dispose();
    tlCache.delete(victim[0]);
  }
}

function dropTimeline(id) {
  const hit = tlCache.get(id);
  if (!hit) return;
  hit.tl.dispose();
  tlCache.delete(id);
}

function pruneTimelineCache() {
  for (const id of [...tlCache.keys()]) if (!app.sessions.has(id)) dropTimeline(id);
}

// ---------------- open a session ----------------
let openSeq = 0;

async function open(id) {
  const my = ++openSeq;
  // 打开 = 检查过进度：这一场的「待查看」高亮到此为止（model 不会再替它打回来）
  const doneRow = id ? app.sessions.get(id) : null;
  if (doneRow?.doneAt) doneRow.doneAt = 0;
  if (S.topic) { unwatchSession(S.topic.slice(8)); S.topic = null; }
  // 摘下而非销毁：切回来的会话可直接挂回（缓存满了才真正 dispose）。
  if (S.tl) {
    S.tl.detach();
    cacheTimeline(S.tlId, S.tl);
  }
  S.tl = null; S.tlId = null; S.snap = null;
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
    // 缓存命中：挂回旧时间线，只补 lastSeq 之后的事件，不重拉 /history。
    // lastSeq 未知（旧核心没给 highWater）或比快照还新（核心重启、seq 重来）都不复用。
    let hit = tlCache.get(id);
    if (hit && (hit.tl.lastSeq == null || (typeof snap.highWater === "number" && snap.highWater < hit.tl.lastSeq))) {
      hit.tl.dispose();
      tlCache.delete(id);
      hit = null;
    }
    if (hit) {
      // 当前打开的时间线不再同时留在缓存里：它由 S.tl 持有，切走时才入缓存。
      tlCache.delete(id);
      S.tl = hit.tl; S.tlId = id;
      S.tl.onOpenSession = (childId) => setCurrent(childId);
      S.tl.attach(S.tlRoot);
      watchSession(id, S.tl.lastSeq);
    } else {
      S.tl = new Timeline(id, app.core, S.tlRoot);
      S.tlId = id;
      S.tl.onOpenSession = (childId) => setCurrent(childId);
      watchSession(id, snap.highWater);
      await S.tl.first();
    }
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

/** 强制重拉：resync / 断线重连 / 归档后重开都不能信任缓存。 */
function reopen() {
  const id = app.current;
  dropTimeline(id);
  if (S.tl) { S.tl.dispose(); S.tl = null; S.tlId = null; }
  app.current = null;
  setCurrent(id);
}

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
  // 派生关系（2026-10-26）：父 id 来自 spec（顶层会话这一格会省略），子会话来自 /sessions 快照。
  // ⚠️ 两格都只**显示**——能不能派生、深度够不够由核心判，这里绝不自己算。
  const parentId = spec.parentSessionId || "";
  const parentRow = parentId ? app.sessions.get(parentId) : null;
  const kids = childrenOf(id);
  // 头部这个数只数**未归档**的：归档是「这件事结束了」，不该继续占着「我有 N 个孩子在跑」。
  const liveKids = kids.filter((k) => !S.archived.has(k.sessionId));
  const kidsWord = liveKids.length > 0 ? `${liveKids.length} 个子会话` : "子会话都已归档";
  const kidsOpen = S.kidsOpen.has(id);
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
        parentId
          ? h("button.chip.sh-rel", {
              type: "button",
              title: parentRow ? `打开父会话 ${parentId}` : `父会话 ${parentId} 已不在列表（记录仍是它的子会话）`,
              onclick: parentRow ? () => setCurrent(parentId) : null,
            }, "↰ 子会话", h("span.dim", " · "), parentRow ? titleOf(parentId) : h("i.dim", "父会话已不在列表"),
            spec.depth != null ? h("span.dim", ` · 第 ${spec.depth} 层`) : null)
          : null,
        kids.length
          ? h("button.chip.sh-kids-toggle", {
              type: "button",
              "aria-expanded": String(kidsOpen),
              title: `${kidsOpen ? "收起" : "展开"}子会话列表 · ${kidsWord}${kids.length > liveKids.length ? ` · 另有 ${kids.length - liveKids.length} 个已归档` : ""}`,
              onclick: () => { kidsOpen ? S.kidsOpen.delete(id) : S.kidsOpen.add(id); renderHead(); },
            }, "⎇ ", kidsWord, h("span.sh-caret", { "aria-hidden": "true" }, kidsOpen ? "▾" : "▸"))
          : null,
        spec.systemPromptPreset ? h("span.chip", { title: "系统提示词预设" }, "预设 " + spec.systemPromptPreset) : null,
        archived ? h("span.chip.plum", "已归档 " + fmtAgo(spec.archivedAt)) : null,
        row.active === false ? h("span.chip", { title: "未载入内存" }, "沉睡") : null,
        spec.workingDirectory ? h("button.chip.sh-cwd", { type: "button", title: "复制工作目录 " + spec.workingDirectory, onclick: () => copy(spec.workingDirectory) }, "⌂ " + baseName(spec.workingDirectory)) : null),
      kidsOpen && kids.length ? kidsPanel(id, kids) : null),
    h("div.sh-actions",
      h("button.btn.btn-sm", { type: "button", title: "推进一步（队列空也推，崩在步中后收回会话用）", onclick: () => cmd({ kind: "session.start", sessionId: id }) }, "▶ 推进"),
      h("button.btn.btn-sm", { type: "button", title: "把此前的上下文压成摘要检查点", onclick: () => compact() }, "𝄐 压缩"),
      h("button.btn.btn-sm.btn-ghost", { type: "button", title: "开一次回收窗口", onclick: () => cmd({ kind: "session.gc", sessionId: id }) }, "𝄒 回收"),
      h("button.icon-btn", { type: "button", "aria-label": "更多操作", title: "更多", onclick: (e) => moreMenu(e.currentTarget) }, "⋯")));
}

/** 头部那个子会话面板：每行是**快照里的一个会话**，不是核心替我们算出来的摘要。 */
function kidsPanel(id, kids) {
  const live = kids.filter((k) => !S.archived.has(k.sessionId));
  return h("div.sh-kidpanel", { role: "group", "aria-label": `子会话（${kids.length}）` },
    h("div.sh-kidlist", kids.map((k) => kidRow(k))),
    h("div.sh-kidfoot",
      h("span.dim", live.length === kids.length ? `共 ${kids.length} 个` : `${live.length} 个未归档 · 共 ${kids.length} 个`),
      h("span.sp"),
      live.length
        ? h("button.btn.btn-sm", { type: "button", title: "把它们逐个归档（核心先级联停，记录保留）", onclick: () => archiveSubagents(id) }, `归档全部子会话（${live.length}）`)
        : h("span.dim", "都归档了")));
}

function kidRow(k) {
  const st = STATUS[phaseOf(k.sessionId)] || STATUS.idle;
  const archived = S.archived.has(k.sessionId);
  const cur = k.sessionId === app.current;
  return h(`div.sh-kid${cur ? ".current" : ""}${archived ? ".archived" : ""}${k.ask ? ".waiting" : ""}`,
    h("span.sh-kid-glyph", { title: st.label, "aria-hidden": "true" }, st.glyph),
    h("button.sh-kid-open", { type: "button", title: `打开 ${k.sessionId}`, onclick: () => setCurrent(k.sessionId) },
      h("b", k.title || "无题 " + k.sessionId.slice(0, 6)),
      h("code", k.sessionId)),
    h("span.sh-kid-meta", `${st.label} · 第 ${k.turn} 小节`, k.ask ? h("span.sh-kid-ask", " · 在等你") : null),
    h("span.sp"),
    archived
      ? h("span.chip.plum", "已归档")
      : h("button.btn.btn-ghost.btn-sm", { type: "button", title: `归档 ${k.sessionId}（记录保留）`, onclick: () => archiveOne(k) }, "归档"));
}

/** 快照里的直接子会话（序就是 `/sessions` 的返回序）。判据只有 parentSessionId 一处。 */
export function childrenOf(id) {
  const out = [];
  for (const r of app.sessions.values()) if (r.parentSessionId === id) out.push(r);
  return out;
}

/** id 的整棵子树（**不含 id 自己**）。环用 seen 挡；默认只有一层，多层也不用改这里。 */
function subtreeOf(id) {
  const out = [];
  const seen = new Set([id]);
  let frontier = [id];
  while (frontier.length) {
    const next = [];
    for (const r of app.sessions.values()) {
      if (seen.has(r.sessionId) || !frontier.includes(r.parentSessionId)) continue;
      seen.add(r.sessionId);
      out.push(r);
      next.push(r.sessionId);
    }
    frontier = next;
  }
  return out;
}

/**
 * 批量归档：**逐个**发 `session.archive`。
 * ⚠️ 不发明一条「批量命令」：核心没有它，而头里合成一条会让「哪些成了、哪些被拒」失去出处
 * ——核心对「正在跑的会话」是逐条拒的（`IsRunning`），逐条发才分得清是谁没归档。
 */
async function archiveRows(rows, title, body) {
  if (!rows.length) { toast("没有要归档的会话", "warn"); return; }
  if (!(await confirmDlg({ title, ok: "归档", body }))) return;
  let done = 0;
  const refused = [];
  for (const r of rows) {
    const ack = await app.core.command({ kind: "session.archive", sessionId: r.sessionId, archived: true });
    if (ack.accepted) { done++; markArchived(r.sessionId, true); }
    else refused.push(`${r.title || r.sessionId.slice(0, 8)}：${ack.reason || "被拒"}`);
  }
  scheduleRefresh(60);
  if (refused.length) toast(`已归档 ${done} 个，${refused.length} 个没归档 · ${refused[0]}`, "err", 7000);
  else toast(`已归档 ${done} 个`, "ok");
}

/** **一键归档这个会话的子 agent**：它的整棵子树（默认一层，多层也不用改）。 */
export async function archiveSubagents(id) {
  const rows = subtreeOf(id).filter((r) => !S.archived.has(r.sessionId));
  const names = rows.slice(0, 3).map((r) => titleOf(r.sessionId)).join("、");
  return archiveRows(rows,
    `归档 ${rows.length} 个子会话？`,
    `把 ${names}${rows.length > 3 ? ` 等 ${rows.length} 个` : ""} 标为已归档：核心会先级联停掉它们的推进，记录保留（勾上「显示已归档」还能打开）。`);
}

/** 归档一个会话本身（头部子会话列表里那一行）。 */
async function archiveOne(r) {
  return archiveRows([r], "归档这个子会话？",
    `把 ${titleOf(r.sessionId)} 标为已归档：核心会先级联停掉它的推进，记录保留。`);
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
  const kids = childrenOf(id);
  const liveKids = kids.filter((k) => !S.archived.has(k.sessionId));
  const menu = h("div.menu", { role: "menu" },
    item(archived ? "取消归档" : "归档", async () => {
      const ack = await cmd({ kind: "session.archive", sessionId: id, archived: !archived });
      if (ack.accepted) { markArchived(id, !archived); reopen(); }
    }),
    // 一键归档子 agent：入口与头部面板里的那颗按钮同一条路（`archiveSubagents`），
    // 没有子会话时**不出现**——一个点了没反应的菜单项比没有更糟。
    liveKids.length ? item(`归档 ${liveKids.length} 个子会话…`, () => archiveSubagents(id)) : null,
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
function onEvent(p, topic, seq) {
  // 缓存里的会话若还订阅着（active），事件也喂给它的时间线：切回时 DOM 已经是最新的。
  const cached = p.sessionId === app.current ? null : tlCache.get(p.sessionId)?.tl;
  if (cached) {
    if (typeof seq === "number") cached.lastSeq = Math.max(cached.lastSeq ?? 0, seq);
    cached.apply(p);
  }
  if (!S.topic || topic !== S.topic || p.sessionId !== app.current) return;
  const tl = S.tl;
  if (!tl) return;
  if (typeof seq === "number") tl.lastSeq = Math.max(tl.lastSeq ?? 0, seq);
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
    case "plan.updated":
      // 与 /state.plan、GET /plan 逐字同形；只交给 mixer 重画，不往历史里塞记号。
      if (p.sessionId === app.current) mixer.plan(p.plan);
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
  // ⚠️ 判据是相位，不是 status：核心每步结束都会发一条 session.state
  // （值取当时的 State.Status），照它判会让这条提示一步闪一次——那正是「演奏中偶尔消失」。
  const ph = phaseOf(app.current);
  const active = ph === "generating" || ph === "tools" || ph === "waiting";
  if (!active) { clearInterval(S.perfTimer); perfKey = ""; S.perf.hidden = true; return; }
  // Rebuild only when the shape changes, so the timer text does not flicker on every row event.
  const key = r.retry ? `retry:${r.retry.attempt}` : ph;
  S.perf.hidden = false;
  S.perf.classList.toggle("retrying", !!r.retry);
  S.perf.classList.toggle("tools", !r.retry && ph === "tools");
  if (key === perfKey) return;
  perfKey = key;
  clearInterval(S.perfTimer);
  const t = h("span.perf-t.num");
  const label = r.retry ? `重奏 ${r.retry.attempt}/${r.retry.max}`
    : ph === "tools" ? "排练"
      : ph === "waiting" ? "候场"
        : "谱曲";
  swap(S.perf,
    h("span.perf-eq", { "aria-hidden": "true" }, h("i"), h("i"), h("i"), h("i"), h("i")),
    h("span.perf-l", label),
    r.retry ? h("span.perf-why", { title: r.retry.reason }, r.retry.reason) : null,
    t,
    h("span.sp"),
    ph !== "waiting" ? h("button.btn.btn-sm.btn-ghost", { type: "button", onclick: () => interrupt() }, "■ 中断") : null);
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
  const ph = phaseOf(app.current);
  const run = ph === "generating" || ph === "tools";
  S.stopBtn.hidden = !run;
  S.qInfo.textContent = run
    ? (ph === "tools" ? "排练中；发送 = 排进队列" : "谱曲中发送 = 排进队列，下一步推进")
    : "";
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
