// Cadenza · app — boot, routing, connection, global streams, keyboard.
import { $, $$, h, swap, store, toast, fmtNum } from "./util.js";
import { Core, resolveCoreBase } from "./core.js";
import { app, loadRegistries, refreshSessions, refreshPresets, onGlobalEvent, setCurrent, scheduleRefresh, resetSubscriptions } from "./model.js";
import { mountStage, newSessionDialog, focusComposer, setStageScreen } from "./stage.js";
import { mountScore, scoreShown } from "./score.js";
import { mountLedger, ledgerShown } from "./ledger.js";
import { mountGreenRoom, greenRoomShown } from "./greenroom.js";
import { mountViz } from "./viz.js";
import { mountRunState } from "./runstate.js";
import { openPalette } from "./palette.js";
import { setCoreBase } from "./blocks.js";

const VIEWS = ["stage", "score", "ledger", "greenroom"];
const VERSION = "1.0.0";
const ON_SHOW = { score: scoreShown, ledger: ledgerShown, greenroom: greenRoomShown };

async function boot() {
  const base = await resolveCoreBase();
  // 图片的字节按 `GET /store/{sha256}` 去取，而 `blocks.js` 不能 import 这里（循环）。
  setCoreBase(base);
  app.core = new Core(base);
  window.cadenza = app; // for console poking; not an API

  mountStage($("#view-stage"));
  mountScore($("#view-score"));
  mountLedger($("#view-ledger"));
  mountGreenRoom($("#view-greenroom"));
  mountViz($("#staff"), $("#tempo"));
  // 顶栏那几格运行状态：切到哪个视图都在（舞台的头部与演奏条只管舞台）。
  mountRunState($("#runstate"));

  for (const b of $$(".view-tab")) b.addEventListener("click", () => go(b.dataset.view));
  // 手机底部主导航（≤760 才显示，桌面 `display:none`）：同一份 `app.view`。
  mountTabbar();
  $("#topbar-back").addEventListener("click", () => applyStageScreen("session", { push: false }));
  // 舞台自己的两颗按钮（☰ 节目单 / 调音台 / ⋯ 概览）不直接改 hash：由这里统一写，
  // 一个写者——两处各写一半，返回键的栈迟早会乱。
  app.bus.on("screen", (spec) => applyStageScreen(typeof spec === "string" ? spec : spec?.name, { push: spec?.push !== false }));
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
  // 核心要 token 而这次没带对（或缺）⇒ 铺一层闸。`hadToken` 只影响闸上那句原因的说法。
  app.core.on("auth", (d) => openTokenGate(d.reason));

  const initial = parseHash();
  go(VIEWS.includes(initial.view) ? initial.view : "stage", true);
  mountTabbar();
  // 舞台的 `data-screen` 一开始就得有值：否则第一帧里「哪一屏」是空的，
  // 而 CSS 只在 `[data-screen=…]` 上才切屏（空值什么都看不到）。
  // ⚠️ 但**别在别的视图上写 hash**：见 `applyStageScreen` 的注释（那会让人刷新一次就退回舞台）。
  const onStage = initial.view === "stage" || !initial.view;
  applyStageScreen(onStage ? initial.sub || "session" : "session", { push: false, hash: onStage });
  // 手机上的二级屏用 pushState 进栈：浏览器 / Android 的返回键要能一层层退回来。
  addEventListener("hashchange", () => {
    const r = parseHash();
    if (!VIEWS.includes(r.view)) return;
    if (r.view !== app.view) go(r.view);
    if (r.view === "stage") applyStageScreen(r.sub || "session", { push: false });
  });
  keyboard();

  const info = await app.core.probe();
  if (!info) showBanner("down");
  // 开了鉴权而页面还没带对 token ⇒ 立刻铺闸，别让人对着一张「已断开」的空页面猜。
  // ⚠️ 判据是 `/info.authRequired`（未授权时它**照样回 200**，只是少了本机路径那几格）。
  if (app.core.authRequired && !app.core.token) {
    openTokenGate("核心开了鉴权（LILARA_AUTH=1），这个页面还没有 token");
  }
  app.core.subscribe("approvals");
  app.core.connect();
  await loadRegistries();
  await refreshSessions();
  const last = new URLSearchParams(location.search).get("session") || store.get("lastSession");
  // ⚠️ 不再要求它出现在列表里：归档会话在新契约里不在 `/sessions` 里，而「上次开着的那一场」
  // 还是该开回来。行由 `open()` 用 `/state` 快照补；真没了的会话它会退回门厅。
  // 核心没应答时不试（`app.info` 为空）：那会把门厅换成一张「打不开」的错页，而横幅已经在说这件事了。
  if (last && app.info) setCurrent(last);
  // Light polling as a safety net: /sessions never activates anything, so it is cheap and side-effect free.
  setInterval(() => { if (app.core.state === "open" && !document.hidden) refreshSessions(); }, 15000);
  setInterval(renderStatus, 5000);
  renderStatus();
}

/**
 * `#view` 或 `#stage/mixer` 这种小路由：**只有舞台有二级屏**（节目单 / 调音台 / 概览）。
 * 桌面宽度下这些屏不成立（两个栏本来就在），所以子路径在桌面上不会带来任何视觉副作用。
 */
function parseHash() {
  const [view = "", sub = ""] = location.hash.slice(1).split("/");
  return { view, sub };
}

const SCREEN_LABEL = { list: "节目单", mixer: "调音台", about: "概览" };

/**
 * 二级屏：写进 hash（手机返回键能退）+ 让舞台切屏 + 更新顶栏那颗返回键与屏名。
 *
 * ⚠️ `hash:false` 是给**启动**用的：这里写的 hash 一律是 `#stage…`，而在后台 / 总谱 / 账簿 上
 * 调它等于把地址改回舞台——刷新一次就退回舞台，`#greenroom` 那样的一级视图**一次都不渲染**
 * （`2-flow` 的 reset 就是一次 `location.reload()`，翻车在「回来后要在后台页上找 `.prov-new`」）。
 * ⇒ 只有启动时 hash 本来就是舞台（或者根本没有 hash），才许它写。
 */
function applyStageScreen(name, { push = true, hash = true } = {}) {
  const sub = name && name !== "session" ? name : "";
  const want = "#stage" + (sub ? "/" + sub : "");
  if (hash && location.hash !== want) {
    const url = location.pathname + location.search + want;
    if (push) history.pushState(null, "", url);
    else history.replaceState(null, "", url);
  }
  setStageScreen(sub || "session");
  const back = $("#topbar-back");
  back.hidden = !sub;
  back.title = sub ? `回到会话（现在是${SCREEN_LABEL[sub] || sub}）` : "";
  const crumb = $("#topbar-title");
  crumb.textContent = sub ? SCREEN_LABEL[sub] || "" : "";
  crumb.hidden = !sub;
  // 二级屏时顶栏用「屏名」代替品牌标记（手机上那块宽度只够说一件事）。
  $(".topbar").classList.toggle("sub", !!sub);
}

function go(view, initial = false) {
  if (!VIEWS.includes(view)) return;
  const changed = app.view !== view;
  app.view = view;
  store.set("view", view);
  // 换视图时保留舞台的子路径（`#stage/mixer` → 切到账簿再回来还在调音台）。
  const sub = view === "stage" ? parseHash().sub : "";
  const hash = "#" + view + (sub ? "/" + sub : "");
  if (location.hash !== hash) history.replaceState(null, "", location.pathname + location.search + hash);
  for (const b of $$(".view-tab, .tab-btn")) b.setAttribute("aria-current", b.dataset.view === view ? "page" : "false");
  for (const s of $$(".view")) {
    const on = s.dataset.view === view;
    s.hidden = !on;
    if (on && changed && !initial) { s.classList.remove("entering"); void s.offsetWidth; s.classList.add("entering"); }
  }
  ON_SHOW[view]?.();
}

/** 手机底部那条主导航：四个视图，与顶栏页签同一份 `app.view`。 */
function mountTabbar() {
  const names = { stage: "舞台", score: "总谱", ledger: "账簿", greenroom: "后台" };
  swap($("#tabbar"), VIEWS.map((v) => h("button.tab-btn", {
    type: "button", "data-view": v, "aria-current": app.view === v ? "page" : "false",
    // 点已经亮着的那个 tab = 回到它自己的根屏（在调音台屏点「舞台」应当回会话，而不是原地不动）。
    onclick: () => { if (v === "stage" && app.view === "stage") applyStageScreen("session", { push: false }); else go(v); },
  }, h("span.tab-label", names[v]))));
}

function onStatus(s) {
  const el = $("#conn");
  el.dataset.state = s;
  el.querySelector(".conn-text").textContent = { open: "已连接", connecting: "连接中", closed: "已断开", origin: "被拒握手", auth: "要 token" }[s] || s;
  el.title = app.core.wsUrl.replace(/\?token=.*$/, "?token=…");
  if (s === "open") { hideBanner(); }
  else if (s === "origin") showBanner("origin");
  else if (s === "auth") showBanner("auth");
  else if (s === "closed") showBanner(app.core.info ? "ws" : "down");
  if (s === "closed" || s === "origin" || s === "auth") resetSubscriptions();
  renderStatus();
}

function showBanner(kind) {
  const b = $("#banner");
  const i = app.core.info;
  if (kind === "origin") {
    const pat = i?.allowedOrigin || "?";
    // ⚠️ 白名单现在是**模式**（核心默认 `http://*:<头端口>`）：通配主机时「换到那个地址打开」
    // 是个不存在的地址，说了等于没说。那时唯一的判据是**端口**。
    const wild = pat.includes("*") && pat !== "*";
    const wantPort = wild ? pat.split(":").pop() : "";
    const myPort = location.port || (location.protocol === "https:" ? "443" : "80");
    swap(b, h("b", "核心拒绝了本页的 WS 握手。"),
      wild
        ? h("span", " 它只放行端口 ", h("code", wantPort), " 的页面，本页端口是 ", h("code", myPort), "。")
        : h("span", " 它只放行 ", h("code", pat), "，本页是 ", h("code", location.origin), "。"),
      h("span.sp"),
      wild
        ? h("span.dim", "换个端口打开本页")
        : h("a", { href: pat + location.pathname + location.hash }, "换到那个地址打开"),
      h("span.dim", "  或设 LILARA_ALLOWED_ORIGIN 后重启核心"));
  } else if (kind === "auth") {
    swap(b, h("b", "核心要求访问 token。"),
      h("span", " 它开了鉴权（", h("code", "LILARA_AUTH=1"), "）：token 在核心的控制台启动横幅里（", h("code", "访问 token …"), " 那一行）。"),
      h("span.sp"),
      h("button.btn.btn-sm", { type: "button", onclick: () => openTokenGate("") }, "填 token"));
  } else if (kind === "down") {
    swap(b, h("b", "核心没应答。"), h("span", " 正在重连 ", h("code", app.core.base), "……先把核心起起来（", h("code", "dotnet run"), "）。"), h("span.sp"), h("button.btn.btn-sm", { type: "button", onclick: () => go("greenroom") }, "换核心地址"));
  } else {
    swap(b, h("b", "WS 断了。"), h("span", " HTTP 还通，正在重连……"));
  }
  b.hidden = false;
}
function hideBanner() { $("#banner").hidden = true; }

// ---- 访问 token 闸（核心 `LILARA_AUTH=1` 时才出现）----
//
// ⚠️ 铺满整屏而不是一个小框：这一刻**没有任何数据可信**（快照、订阅、历史分页全被拒），
// 底下那些按钮点下去只会再弹一次闸。
// ⚠️ 存下之后**整页重载**：此刻所有快照与订阅都按「未授权」拿过一遍，逐条补一遍比不上
// 重新引导一次可靠（核心自己那个页面也是这么做的）。
// ⚠️ 留一个「先不填」：没 token 的人也有权去后台看看 `/info` 说了什么、换个核心地址，
// 或者清掉一份存错的 token——把唯一的出口焊死，只会让人去清 localStorage。
function openTokenGate(detail) {
  if ($("#token-gate")) return;

  const input = h("input.inp.mono", {
    type: "text", autocomplete: "off", spellcheck: "false",
    placeholder: "粘在这里", "aria-label": "访问 token",
  });
  const close = () => $("#token-gate")?.remove();
  const form = h("form.gate-card", {
    onsubmit: (e) => {
      e.preventDefault();
      app.core.setToken(input.value.trim());
      close();
      location.reload();
    },
  },
    h("h2.gate-title", "核心要求访问 token"),
    h("p.gate-text", "核心启动时把它打印在控制台里（", h("code", "访问 token …"), " 那一行）。"),
    h("p.gate-note", "开了鉴权（", h("code", "LILARA_AUTH=1"), "）才会要它；留空保存 = 清掉已存的那份。"),
    input,
    // 原因是**上次为什么被拒**，不是一句通用的提示：token 错与没 token 得分开说。
    detail ? h("p.gate-bad", detail) : null,
    h("div.gate-actions",
      h("button.btn.btn-ghost", { type: "button", onclick: close }, "先不填"),
      h("button.btn.btn-primary", { type: "submit" }, "保存并重连")));

  document.body.appendChild(h("div.token-gate#token-gate", form));
  input.focus();
}

function renderCueBtn() {
  const n = app.approvals.size;
  const b = $("#cue-btn");
  b.hidden = n === 0;
  $("#cue-count").textContent = n;
  // ⚠️ 标签题（`document.title`）不在这里写：它有每秒一次的 tick 与任务数，归 `js/runstate.js`
  // 的 `paintTitle` 一个写者管。两处各写一半会互相盖掉。
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
    h("span.sb-item.sb-brand", "Cadenza ", h("b", VERSION)),
    h("span.sb-item.sb-core", "核心 ", h("b", app.core?.base || "—")),
    i ? h("span.sb-item.sb-ver", "v", h("b", i.coreVersion)) : null,
    // 只在核心说「要 token」时才占一格——默认不校验的核心上多一格就是噪音。
    i?.authRequired ? h("span.sb-item", "鉴权 ", h("b", app.core.token ? "已带" : "要 token")) : null,
    h("span.sb-item", "会话 ", h("b", fmtNum(rows.length)), " · 在内存 ", h("b", fmtNum(active)), " · 演奏中 ", h("b", fmtNum(running))),
    h("span.sb-item", "提供商 ", h("b", fmtNum(app.providers.length))),
    h("span.sp"),
    i?.workingDirectory ? h("span.sb-item.sb-cwd", { title: "核心的工作目录" }, "⌂ ", h("b", i.workingDirectory)) : null,
    h("span.sb-item.sb-frames", "帧 ↓", h("b", fmtNum(app.core?.stats.in)), " ↑", h("b", fmtNum(app.core?.stats.out))));
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
