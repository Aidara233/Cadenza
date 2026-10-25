// Cadenza · model — global store over the core: sessions, projects, approvals, registries.
import { Emitter, store, toast } from "./util.js";
import { projectKeyOf } from "./core.js";

export const app = {
  core: null,
  bus: new Emitter(),
  info: null,
  health: null,
  axes: null,                 // GET /axes
  providers: [],
  schema: null,
  network: null,              // GET /network-config（核心没有这个端点时为 null）
  shell: null,                // GET /shell-config（核心没有这个端点时为 null）
  presets: [],                // parsed from preset.list note
  sessions: new Map(),        // sessionId -> row from GET /sessions (+ local hints)
  projects: new Map(),        // pk -> { pk, dir }
  approvals: new Map(),       // askId -> { sessionId, askId, askKind, items, remember, deadlineAt, toolName, partial }
  current: null,              // open sessionId
  view: "stage",
};

const dirs = store.get("projectDirs", {});
export function rememberDir(pk, dir) {
  if (!pk || !dir || dirs[pk] === dir) return;
  dirs[pk] = dir;
  store.set("projectDirs", dirs);
  const p = app.projects.get(pk);
  if (p) { p.dir = dir; app.bus.emit("sessions"); }
}
export const dirOf = (pk) => app.projects.get(pk)?.dir || dirs[pk] || null;

let subscribedProjects = new Set();

export async function loadRegistries() {
  const c = app.core;
  const [info, health, axes, providers, schema, network, shell] = await Promise.allSettled([
    c.get("/info"), c.get("/health"), c.get("/axes"), c.get("/providers"), c.get("/provider-schema"),
    c.get("/network-config"), c.get("/shell-config"),
  ]);
  if (info.value) {
    app.info = info.value;
    const pk = await projectKeyOf(info.value.workingDirectory);
    rememberDir(pk, info.value.workingDirectory);
    app.homePk = pk;
  }
  if (health.value) app.health = health.value;
  if (axes.value) app.axes = axes.value;
  if (providers.value) app.providers = providers.value;
  if (schema.value) app.schema = schema.value;
  // Older cores have no /network-config — null means "this core can't do web tools".
  if (network.value) app.network = network.value;
  // Same for /shell-config — null means "this core has no shell tool".
  if (shell.value) app.shell = shell.value;
  app.bus.emit("registries");
}

export async function refreshNetwork() {
  try { app.network = await app.core.get("/network-config"); app.bus.emit("network"); }
  catch { app.network = null; app.bus.emit("network"); }
  return app.network;
}

export async function refreshShell() {
  try { app.shell = await app.core.get("/shell-config"); app.bus.emit("shell"); }
  catch { app.shell = null; app.bus.emit("shell"); }
  return app.shell;
}

export async function refreshProviders() {
  try { app.providers = await app.core.get("/providers"); app.bus.emit("providers"); } catch { }
}

export async function refreshPresets() {
  const ack = await app.core.command({ kind: "preset.list" });
  if (!ack.accepted) return app.presets;
  const note = ack.note || "";
  app.presets = /还没有预设/.test(note) ? [] : note.split(" / ").map((s) => s.trim()).filter(Boolean);
  app.bus.emit("presets");
  return app.presets;
}

/** GET /sessions — no side effects, safe to poll. Live events newer than the fetch win over it. */
export async function refreshSessions() {
  const started = Date.now();
  let rows, pks;
  try { [rows, pks] = await Promise.all([app.core.get("/sessions"), app.core.get("/projects")]); }
  catch { return; }
  const seen = new Set();
  for (const r of rows) {
    seen.add(r.sessionId);
    const prev = app.sessions.get(r.sessionId);
    const next = { ...prev, ...r, title: r.title, ask: r.ask?.askId ? r.ask : null };
    if (prev?.liveAt > started) {
      // An event arrived while this snapshot was in flight: the snapshot is older than what we know.
      next.status = prev.status; next.turn = prev.turn; next.ask = prev.ask;
    } else if (next.status !== "Running") {
      next.retry = null; next.stepAt = null;
    }
    app.sessions.set(r.sessionId, next);
  }
  for (const id of [...app.sessions.keys()]) if (!seen.has(id)) app.sessions.delete(id);
  for (const pk of pks) if (!app.projects.has(pk)) app.projects.set(pk, { pk, dir: dirs[pk] || null });
  for (const pk of [...app.projects.keys()]) if (!pks.includes(pk)) app.projects.delete(pk);

  // Asks seen in the list but not via events (e.g. after a core restart): keep a partial entry.
  for (const r of app.sessions.values()) {
    if (r.ask && !app.approvals.has(r.ask.askId)) {
      app.approvals.set(r.ask.askId, {
        sessionId: r.sessionId, askId: r.ask.askId, askKind: r.ask.kind, toolName: r.ask.toolName,
        deadlineAt: r.ask.deadlineAt, items: null, remember: [], partial: true,
      });
    }
  }
  for (const [askId, a] of app.approvals) {
    const r = app.sessions.get(a.sessionId);
    if (!r || r.ask?.askId !== askId) app.approvals.delete(askId);
  }
  syncSubscriptions();
  app.bus.emit("sessions");
  app.bus.emit("approvals");
}

// ---------------- subscriptions ----------------
// project:* for list changes; session:* for every session that is in memory (only those can run)
// plus the open one. Status events (state / step / error / retry) are published ONLY on the
// session stream, so a row whose stream we do not hear can never leave "Running" on its own.
let subscribedSessions = new Set();

function syncSubscriptions() {
  const want = new Set([...app.projects.keys()].map((pk) => "project:" + pk));
  for (const t of want) if (!subscribedProjects.has(t)) app.core.subscribe(t);
  for (const t of subscribedProjects) if (!want.has(t)) app.core.unsubscribe(t);
  subscribedProjects = want;

  const ws = new Set();
  for (const r of app.sessions.values()) if (r.active || r.status !== "Idle" || r.sessionId === app.current) ws.add(r.sessionId);
  for (const id of ws) if (!subscribedSessions.has(id) && id !== app.current) app.core.subscribe("session:" + id);
  for (const id of subscribedSessions) if (!ws.has(id) && id !== app.current) app.core.unsubscribe("session:" + id);
  subscribedSessions = ws;
}

/** The open session subscribes with its snapshot's highWater; model keeps it afterwards if it is active. */
export function watchSession(id, since) {
  app.core.subscribe("session:" + id, since);
  subscribedSessions.add(id);
}
export function unwatchSession(id) {
  const r = app.sessions.get(id);
  if (r && (r.active || r.status !== "Idle")) return; // still worth hearing
  app.core.unsubscribe("session:" + id);
  subscribedSessions.delete(id);
}

export function resetSubscriptions() { subscribedProjects = new Set(); subscribedSessions = new Set(); }

// ---------------- the one reducer ----------------
/**
 * Every event that changes "is it running / waiting / failed" goes through here, whichever stream it came on.
 * Views never keep their own copy; they read app.sessions and listen to bus "sessions".
 * Row fields: status · phase · turn · ask · stepAt (step start, ms) · retry {attempt,max,reason,until} · lastError {message,at}
 *
 * status 是协议原话（Running / WaitingForInput / Idle），phase 是**核心报的活动相位**：
 * 核心发 `session.phase`（Generating / Tools / Waiting / Idle，见 `Kernel/SessionPhase`），
 * 头**只显示、不派生**——模型调用与工具执行的边界只有核心知道，这里推出来的东西
 * 在核心改判据那天会静默分叉。旧核心不发这条时，才退回按 status 猜一个。
 */
export function onGlobalEvent(p, topic) {
  const id = p.sessionId;
  const r = id ? app.sessions.get(id) : null;
  const touch = () => { if (r) r.liveAt = Date.now(); };
  let rows = false, asks = false;
  switch (p.kind) {
    case "session.created":
    case "session.deleted":
    case "session.archived":
    case "session.deactivated":
      if (topic.startsWith("project:")) scheduleRefresh();
      break;
    case "session.step.begin":
      if (r) { touch(); r.status = "Running"; r.stepAt = Date.parse(p.at) || Date.now(); r.retry = null; r.lastError = null; r.active = true; rows = true; }
      break;
    case "session.step.end":
      if (r) { touch(); r.stepAt = null; r.retry = null; rows = true; }
      break;
    case "message.appended":
    case "tool.result.appended":
      // 只记账（liveAt 挡快照回写）：相位由核心的 `session.phase` 报，这里不推。
      if (r) { touch(); rows = true; }
      break;
    case "session.phase": {
      // 四态由核心判（Kernel/SessionPhase）。头只把字符串落成小写键，不派生。
      if (r) {
        const prev = r.phase;
        touch();
        if (typeof p.phase === "string") r.phase = p.phase;
        if (typeof p.turn === "number") r.turn = p.turn;
        // 「跑完了、你还没看过」：从有活计落回 Idle，而且不是当前开着的那一场。
        // ⚠️ 只由「打开会话」清掉（见 stage.js 的 open）——那是「检查过进度」这个动作本身，
        //    不是时间到了自动消失：没看过的会话不该自己变暗。
        if (p.phase === "Idle" && (prev === "Generating" || prev === "Tools") && r.sessionId !== app.current) {
          r.doneAt = Date.now();
        }
        rows = true;
      }
      break;
    }
    case "session.state":
      if (r) {
        touch();
        r.status = p.status; r.turn = p.turn;
        if (p.status !== "Running") { r.stepAt = null; r.retry = null; }
        if (p.status !== "WaitingForInput" && r.ask) dropAsk(r.ask.askId);
        rows = true;
      }
      break;
    case "retry.attempt":
      if (r) { touch(); r.status = "Running"; r.retry = { attempt: p.attempt, max: p.maxAttempts, reason: p.reason, until: Date.now() + (p.delayMs || 0) }; rows = true; }
      break;
    case "axis.changed":
      // Only initiative changes what a row shows, and it matters for background sessions too:
      // finish_goal flips the axis from inside the step, so no /sessions refresh is guaranteed.
      if (r && p.axis === "initiative") { touch(); r.goal = { active: p.value === "goal" }; rows = true; }
      break;
    case "error":
      // The core rolls its own status back to the persisted one but publishes only `error`
      // (no session.state). A failed step never leaves the session waiting, so it is idle now;
      // the follow-up refresh confirms against the core.
      if (r) {
        touch();
        r.lastError = { message: p.message, at: Date.now() };
        if (r.status === "Running") r.status = "Idle";
        r.stepAt = null; r.retry = null; rows = true;
        scheduleRefresh(400);
      }
      if (topic.startsWith("session:") && id !== app.current) toast(`「${titleOf(id)}」出错了：${p.message}`, "err", 6000);
      break;
    case "approval.requested":
      app.approvals.set(p.askId, {
        sessionId: id, askId: p.askId, askKind: p.askKind, items: p.items,
        remember: p.remember || [], deadlineAt: p.deadlineAt, toolName: toolNameOf(p), partial: false,
      });
      if (r) { touch(); r.status = "WaitingForInput"; r.ask = { askId: p.askId, kind: p.askKind, deadlineAt: p.deadlineAt }; r.stepAt = null; r.retry = null; rows = true; }
      if (topic === "approvals" && id !== app.current) toast(`会话「${titleOf(id)}」在等你回答`, "warn");
      asks = true;
      break;
    case "approval.resolved":
      // Arrives on two streams; idempotent. The local cue may already have dropped the entry —
      // the row must still leave "waiting" (that was the stuck-𝄐 bug).
      dropAsk(p.askId);
      if (r && r.ask?.askId === p.askId) {
        touch(); r.ask = null;
        // No session.state follows a cancel / supersede; an answer is followed by step.begin.
        if (r.status === "WaitingForInput") r.status = "Idle";
        rows = true;
      }
      asks = true;
      break;
  }
  if (rows) { if (p.kind === "session.state" || p.kind === "session.step.begin") syncSubscriptions(); app.bus.emit("sessions"); }
  if (asks) app.bus.emit("approvals");
}

function dropAsk(askId) { app.approvals.delete(askId); }

/** Local optimistic transitions (cue answered / interrupt sent) go through the same row. */
export function markLocal(id, patch) {
  const r = app.sessions.get(id);
  if (!r) return;
  Object.assign(r, patch, { liveAt: Date.now() });
  app.bus.emit("sessions");
}

export const isRunning = (id) => app.sessions.get(id)?.status === "Running";
export const statusOf = (id) => { const r = app.sessions.get(id); return !r ? "Idle" : r.ask ? "WaitingForInput" : r.status || "Idle"; };
/** 给眼睛看的四态：idle 闲置 · waiting 等你 · generating 模型生成 · tools 工具处理 */
export const phaseOf = (id) => {
  const r = id ? app.sessions.get(id) : null;
  if (!r) return "idle";
  if (r.ask) return "waiting";
  // 核心报的是 PascalCase（SessionPhase 常量）；这里只落成界面用的键。
  const ph = r.phase;
  if (ph === "Generating") return "generating";
  if (ph === "Tools") return "tools";
  if (ph === "Waiting") return "waiting";
  if (ph === "Idle") return "idle";
  // 旧核心不发 session.phase：退回按 status 猜（不是常态，别在这里长逻辑）。
  return r.status === "Running" ? "generating" : "idle";
};

function toolNameOf(p) {
  if (p.askKind !== "permission") return "ask";
  const q = p.items?.[0]?.question || "";
  return /`([^`]+)`/.exec(q)?.[1] || null;
}

let refreshT = 0;
export function scheduleRefresh(ms = 120) {
  clearTimeout(refreshT);
  refreshT = setTimeout(refreshSessions, ms);
}

export function titleOf(id) {
  const r = app.sessions.get(id);
  return r?.title || (id ? "会话 " + id.slice(0, 6) : "");
}

export function projectLabel(pk) {
  const d = dirOf(pk);
  if (d) return d.replace(/[\\/]+$/, "").split(/[\\/]/).pop() || d;
  return "项目 " + pk.slice(0, 8);
}

export function setCurrent(id) {
  if (app.current === id) return;
  app.current = id;
  if (id) store.set("lastSession", id); else store.del("lastSession");
  app.bus.emit("current", id);
}

/** Thin wrapper: send, toast on reject, return ack. */
export async function cmd(payload, { quiet = false, ok } = {}) {
  const ack = await app.core.command(payload);
  if (!ack.accepted) toast(ack.reason || "命令被拒绝", "err", 5200);
  else if (!quiet) toast(ok || ack.note || "已受理", "ok");
  return ack;
}
