// Cadenza · app — boot, routing, connection, global streams, keyboard.
import { $, $$, h, swap, store, toast, fmtNum } from "./util.js";
import { Core, resolveCoreBase } from "./core.js";
import { app, loadRegistries, refreshSessions, refreshPresets, onGlobalEvent, setCurrent, scheduleRefresh, resetSubscriptions } from "./model.js";
import { mountStage, newSessionDialog, focusComposer } from "./stage.js";
import { mountScore, scoreShown } from "./score.js";
import { mountLedger, ledgerShown } from "./ledger.js";
import { mountGreenRoom, greenRoomShown } from "./greenroom.js";
import { mountViz } from "./viz.js";
import { openPalette } from "./palette.js";

const VIEWS = ["stage", "score", "ledger", "greenroom"];
const ON_SHOW = { score: scoreShown, ledger: ledgerShown, greenroom: greenRoomShown };

async function boot() {
  const base = await resolveCoreBase();
  app.core = new Core(base);
  window.cadenza = app; // for console poking; not an API

  mountStage($("#view-stage"));
  mountScore($("#view-score"));
  mountLedger($("#view-ledger"));
  mountGreenRoom($("#view-greenroom"));
  mountViz($("#staff"), $("#tempo"));

  for (const b of $$(".view-tab")) b.addEventListener("click", () => go(b.dataset.view));
  $("#palette-btn").addEventListener("click", openPalette);
  $("#cue-btn").addEventListener("click", jumpToCue);
  app.bus.on("goto", go);
  app.bus.on("palette", openPalette);
  app.bus.on("new-session", () => { go("stage"); newSessionDialog(); });
  app.bus.on("focus-composer", () => { go("stage"); focusComposer(); });
  app.bus.on("approvals", renderCueBtn);
  app.bus.on("sessions", renderStatus);
  app.bus.on("registries", renderStatus);

  app.core.on("status", onStatus);
  app.core.on("event", onGlobalEvent);
  // The open session re-snapshots itself (stage); every other stream just resubscribes and re-reads /sessions.
  app.core.on("resync", (topic) => {
    const bg = topic === "approvals" || topic.startsWith("project:") || (topic.startsWith("session:") && topic.slice(8) !== app.current);
    if (bg) { app.core.subscribe(topic); scheduleRefresh(); }
  });
  app.core.on("reconnected", async () => { await loadRegistries(); scheduleRefresh(10); });
  app.core.on("badframe", (f) => toast("核心说帧形状不对：" + f.reason, "err"));

  const initial = VIEWS.includes(location.hash.slice(1)) ? location.hash.slice(1) : store.get("view", "stage");
  go(initial, true);
  addEventListener("hashchange", () => { const v = location.hash.slice(1); if (VIEWS.includes(v)) go(v); });
  keyboard();

  const info = await app.core.probe();
  if (!info) showBanner("down");
  app.core.subscribe("approvals");
  app.core.connect();
  await loadRegistries();
  await refreshSessions();
  const last = new URLSearchParams(location.search).get("session") || store.get("lastSession");
  if (last && app.sessions.has(last)) setCurrent(last);
  // Light polling as a safety net: /sessions never activates anything, so it is cheap and side-effect free.
  setInterval(() => { if (app.core.state === "open" && !document.hidden) refreshSessions(); }, 15000);
  setInterval(renderStatus, 5000);
  renderStatus();
}

function go(view, initial = false) {
  if (!VIEWS.includes(view)) return;
  const changed = app.view !== view;
  app.view = view;
  store.set("view", view);
  if (location.hash.slice(1) !== view) history.replaceState(null, "", location.pathname + location.search + "#" + view);
  for (const b of $$(".view-tab")) b.setAttribute("aria-current", b.dataset.view === view ? "page" : "false");
  for (const s of $$(".view")) {
    const on = s.dataset.view === view;
    s.hidden = !on;
    if (on && changed && !initial) { s.classList.remove("entering"); void s.offsetWidth; s.classList.add("entering"); }
  }
  ON_SHOW[view]?.();
}

function onStatus(s) {
  const el = $("#conn");
  el.dataset.state = s;
  el.querySelector(".conn-text").textContent = { open: "已连接", connecting: "连接中", closed: "已断开", origin: "被拒握手" }[s] || s;
  el.title = app.core.wsUrl;
  if (s === "open") { hideBanner(); }
  else if (s === "origin") showBanner("origin");
  else if (s === "closed") showBanner(app.core.info ? "ws" : "down");
  if (s === "closed" || s === "origin") resetSubscriptions();
  renderStatus();
}

function showBanner(kind) {
  const b = $("#banner");
  const i = app.core.info;
  if (kind === "origin") {
    swap(b, h("b", "核心拒绝了本页的 WS 握手。"),
      h("span", " 它只放行 ", h("code", i.allowedOrigin), "，本页是 ", h("code", location.origin), "。"),
      h("span.sp"),
      h("a", { href: i.allowedOrigin + location.pathname + location.hash }, "换到那个地址打开"),
      h("span.dim", "  或设 LILARA_ALLOWED_ORIGIN 后重启核心"));
  } else if (kind === "down") {
    swap(b, h("b", "核心没应答。"), h("span", " 正在重连 ", h("code", app.core.base), "……先把核心起起来（", h("code", "dotnet run"), "）。"), h("span.sp"), h("button.btn.btn-sm", { type: "button", onclick: () => go("greenroom") }, "换核心地址"));
  } else {
    swap(b, h("b", "WS 断了。"), h("span", " HTTP 还通，正在重连……"));
  }
  b.hidden = false;
}
function hideBanner() { $("#banner").hidden = true; }

function renderCueBtn() {
  const n = app.approvals.size;
  const b = $("#cue-btn");
  b.hidden = n === 0;
  $("#cue-count").textContent = n;
  document.title = (n ? `(${n}) ` : "") + "Cadenza · Lilara";
}

function jumpToCue() {
  const first = [...app.approvals.values()][0];
  if (!first) return;
  go("stage");
  setCurrent(first.sessionId);
}

function renderStatus() {
  const sb = $("#statusbar");
  const rows = [...app.sessions.values()];
  const running = rows.filter((r) => r.status === "Running").length;
  const active = rows.filter((r) => r.active).length;
  const i = app.core?.info;
  swap(sb,
    h("span.sb-item", "核心 ", h("b", app.core?.base || "—")),
    i ? h("span.sb-item", "v", h("b", i.coreVersion)) : null,
    h("span.sb-item", "会话 ", h("b", fmtNum(rows.length)), " · 在内存 ", h("b", fmtNum(active)), " · 演奏中 ", h("b", fmtNum(running))),
    h("span.sb-item", "提供商 ", h("b", fmtNum(app.providers.length))),
    h("span.sp"),
    i?.workingDirectory ? h("span.sb-item", { title: "核心的工作目录" }, "⌂ ", h("b", i.workingDirectory)) : null,
    h("span.sb-item", "帧 ↓", h("b", fmtNum(app.core?.stats.in)), " ↑", h("b", fmtNum(app.core?.stats.out))));
}

function keyboard() {
  addEventListener("keydown", (e) => {
    const typing = /^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName) || e.target.isContentEditable;
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "k") { e.preventDefault(); openPalette(); return; }
    if (e.altKey && /^[1-4]$/.test(e.key)) { e.preventDefault(); go(VIEWS[+e.key - 1]); return; }
    if (e.altKey && e.key.toLowerCase() === "n") { e.preventDefault(); go("stage"); newSessionDialog(); return; }
    if (!typing && e.key === "/" && app.view === "stage") { e.preventDefault(); focusComposer(); }
  });
}

boot().catch((e) => { console.error(e); toast("启动失败：" + e.message, "err", 10000); });
