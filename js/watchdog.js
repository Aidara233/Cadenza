// Cadenza · watchdog — 主线程停摆的现场记录（诊断用，为「莫名其妙卡死」而存在）。
//
// 为什么非要一条 Worker：真正的「页面卡死」是**主线程停了**——CSS 动画（合成器那一路）照旧在动，
// 画布（`js/viz.js` 的 rAF）与所有点击全停。这种停摆主线程自己报不出来：它一个字都执行不了。
// 所以判据来自另一条线程：内联 Worker 每秒看一次「主线程最后一次心跳是多久以前」，
// 超过 `STALL_MS` 就把手里最后一份现场（`tag` + 计数）写进 IndexedDB；页面下次打开时读出来，
// 横幅上写明「上次停了多少秒、当时在干什么」。否则用户只能说「又卡了」，我们只能猜。
//
// 两路证据，缺一不可：
//   · **停摆记录**（Worker 看主线程沉默多久）+ `selfDriftMs`（**Worker 自己的节拍也晚了多久**）：
//     自漂移和停摆同样长 ⇒ 饿死的是整个进程 / 整台机器；自漂移很小而主线程沉默 ⇒ 沉默只发生在
//     主线程里。（2026-11-15 用户实测：只有这个标签页卡、别的程序都正常 ⇒ 后者。）
//   · **两路心跳**（`last.at` 定时器 / `lastFrame` rAF）：只看一路分不开下面这些情况，
//     而它们的修法毫无共同点：
//       - 帧和定时器**一起**停 ⇒ 主线程被一整段原生代码 / 没结束的任务占住；
//       - 帧**先**停、定时器后停 ⇒ 渲染那一路先没了（样式/布局/绘制/合成）；
//       - 当时页面 `hidden` ⇒ 浏览器本来就停掉了隐藏页的渲染与定时器——**这段沉默不是卡死**。
//     ⚠️ 2026-11-16 08:37 那条 102.6 秒的记录就是第三种：心跳原来带 `if (!document.hidden)`，
//     一隐藏就自己停发，于是「切走两分钟」被记成了「卡死两分钟」，判读还错写成「页面在算」。
//   · **慢帧归因**（主线程的 `long-animation-frame`）：一次 ≥1 秒的长帧，Chrome 会给出它的分解
//     ——脚本多少、样式+布局多少、绘制多少，以及各自属于哪个脚本 / 函数。这才是能定位到具体
//     代码的东西（`md` / `renderList` / 强制同步布局都会在这里点名）。
//
// ⚠️ **不联网、不上报**：记录只落在本机 IndexedDB，看不看、贴不贴由用户自己决定。
// ⚠️ 开销：心跳 1.5 秒一次、`mark()` 最快 250ms 一次，都是一条 `postMessage`；慢帧记录只在
// ≥1 秒的长帧之后写一次。闲着的标签页里这些定时器本来就会被浏览器降频。
// ⚠️ **这里不 import `model.js`**：`model.js` 自己要调 `mark()`，反向 import 就成了环。
// 会话 / 相位 / 帧数这些只有 model 知道的格子，由 `app.js` 通过 `mountWatchdog(() => ({…}))` 交进来。
import { h, copy } from "./util.js";

const DB = "cadenza-diag";
const STORE = "stalls";
const STALL_MS = 3000;      // 超过这么久没有心跳 = 主线程沉默了（正常一帧 16ms，重活也就几百 ms）
const LAP_MS = 1000;        // ≥1 秒的长帧才记归因（再小的天天有，记下来反而是噪音）
const KEEP_MS = 6 * 3600e3; // 只在那之后 6 小时内提醒：上个月的记录没有诊断价值

// Worker 源码作为字符串：一个文件、不额外发请求（`new Worker(URL.createObjectURL(blob))`）。
const SRC = `
let last = { at: Date.now(), snap: null };  // 心跳：定时器那一路
let lastFrame = Date.now();                 // 心跳：rAF 那一路（「浏览器还在给我画」）
let stall = null, keptAt = 0;
let selfMax = 0, lastTick = Date.now();
let lastTag = "";
const DB = ${JSON.stringify(DB)}, STORE = ${JSON.stringify(STORE)};
function db() {
  return new Promise((res, rej) => {
    const r = indexedDB.open(DB, 1);
    r.onupgradeneeded = () => { try { r.result.createObjectStore(STORE, { autoIncrement: true }); } catch (e) { } };
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  });
}
async function keep(rec) {
  try { const d = await db(); d.transaction(STORE, "readwrite").objectStore(STORE).put(rec); } catch (e) { /* 私有模式 / 配额 */ }
}
/** 最近的 n 条（**跨刷新**只有 IndexedDB 这条路：新的 Worker 内存是空的）。 */
async function recent(kind, n) {
  try {
    const d = await db();
    return await new Promise((res) => {
      const out = [];
      const rq = d.transaction(STORE, "readonly").objectStore(STORE).openCursor(null, "prev");
      rq.onsuccess = () => {
        const c = rq.result;
        if (c) { if (c.value && c.value.kind === kind && out.length < n) out.push(c.value); if (out.length < n) c.continue(); else res(out); }
        else res(out);
      };
      rq.onerror = () => res(out);
    });
  } catch (e) { return []; }
}
function judge() {
  const now = Date.now();
  const gap = now - last.at;
  if (!last.snap || gap < ${STALL_MS}) return;
  // 停摆还在继续：时长每秒都在长，所以要一直刷新这条（最新的一份才带得回「停到多久」）。
  stall = {
    kind: "stall", gapMs: gap, at: last.at, selfDriftMs: selfMax,
    // 最后一格心跳到达时，帧已经停了多久。>0 = **帧先停**（渲染那一路先没的）；
    // ≈0 = 两边同一时刻停（主线程被一整段原生代码整体占住）。见文件头。
    frameGapMs: Math.max(0, last.at - lastFrame),
    snap: Object.assign({}, last.snap, lastTag ? { tag: lastTag } : {}),
  };
  // ⚠️ 这里原来是「gap 比上次大就写」——等于**停摆期间每秒灌一条** IndexedDB 记录
  // （102 秒的停摆灌 102 条），既白占库，也让恢复后的页面多干一堆活。10 秒一条足够。
  if (now - keptAt < 10000) return;
  keptAt = now;
  keep(stall);
}
// ⚠️ **这条计时是判据的另一半**：如果 Worker 自己的 1 秒节拍也被拖到二十几秒，那说明被饿死的是
// **整个进程 / 整台机器**（CPU 抢不到、内存换页、核心在跑重活）。节拍准时而主线程沉默只说明
// **沉默发生在主线程里**——它到底是被占住了、渲染先停了、还是页面被藏起来了，要看现场里
// 的 hidden / frameGapMs 那两格（见文件头「两路心跳」）。
// ⚠️ 这段源码整体是一个模板字符串：**里面不能出现反引号**（连注释里也不行），否则会把模板提前结束。
setInterval(() => {
  const now = Date.now();
  const late = now - lastTick - 1000;
  if (late > 300) selfMax = Math.max(selfMax, late);
  lastTick = now;
  judge();
}, 1000);
onmessage = async (e) => {
  const d = e.data || {};
  if (d.ask === "last") {
    judge();
    postMessage({ stall: stall || (await recent("stall", 1))[0] || null, laps: await recent("lap", 3) });
    return;
  }
  if (d.lap) { keep(d.lap); return; }
  // ⚠️ **面包屑不动时钟**：它只更新「此刻在哪」，心跳才更新「主线程还活着」。
  // 否则一个死循环会一直发面包屑，把停摆的判据自己喂饱（gap 永远长不大，反而记不下来）。
  if (d.tag) { lastTag = d.tag; if (last.snap) last.snap.tag = d.tag; return; }
  // 帧心跳：只更新「最后一次画过」，既不动停摆判据，也不采现场。
  if (d.frame) { lastFrame = Date.now(); return; }
  if (d.snap) {
    const now = Date.now();
    // 心跳回来了 = 这次沉默结束：把最终时长补进最后那条记录（10 秒节流可能漏掉尾巴），再清内存。
    if (stall && now - last.at > stall.gapMs) { stall.gapMs = now - last.at; keep(stall); }
    stall = null;
    last = { at: now, snap: d.snap };
    if (d.snap.tag) lastTag = d.snap.tag;
    return;
  }
};
`;

let worker = null;
let lastMark = 0;
let lastSpin = 0;
let lastFrameAt = 0;   // 主线程自己记的「最后一次画过」（`snapshot()` 的 `frameAgeMs` 用）
let provide = null;
// 主线程自己的长任务（>200ms）滚动 60 秒：停摆那一刻它多半还没结束（不会有记录），但**之前**
// 那些「一步比一步慢」的痕迹很有用——它说明是主线程在算，还是外面在抢资源。
const lt = { at: [], max: 0 };

function watchLongTasks() {
  try {
    new PerformanceObserver((list) => {
      const now = Date.now();
      for (const e of list.getEntries()) { lt.at.push({ at: now, ms: e.duration }); lt.max = Math.max(lt.max, Math.round(e.duration)); }
      lt.at = lt.at.filter((x) => now - x.at < 60000);
    }).observe({ entryTypes: ["longtask"] });
  } catch { /* 老浏览器没有 longtask */ }
}

/** 慢帧归因：`long-animation-frame` 给出脚本 / 样式+布局 / 绘制的分解与所属脚本。 */
function watchSlowFrames() {
  let po = null;
  try {
    po = new PerformanceObserver((list) => {
      for (const e of list.getEntries()) {
        if (e.duration < LAP_MS) continue;
        const scripts = (e.scripts || []).map((s) => ({
          ms: Math.round(s.duration),
          forced: Math.round(s.forcedStyleAndLayoutDuration || 0),
          fn: s.sourceFunctionName || "",
          url: String(s.sourceURL || "").replace(location.origin, ""),
          line: s.sourceCharPosition ?? null,
          invoker: (s.invokerType || "") + (s.invoker ? ":" + String(s.invoker).slice(0, 60) : ""),
        })).sort((a, b) => b.ms - a.ms).slice(0, 5);
        const rec = {
          kind: "lap",
          at: Date.now(),
          dur: Math.round(e.duration),
          block: Math.round(e.blockingDuration || 0),
          scriptMs: Math.round(Math.max(0, (e.renderStart || e.startTime) - e.startTime)),
          styleMs: Math.round(Math.max(0, (e.styleAndLayoutStart || e.startTime) - (e.renderStart || e.startTime))),
          restMs: Math.round(Math.max(0, e.startTime + e.duration - (e.styleAndLayoutStart || e.startTime))),
          scripts,
        };
        worker?.postMessage({ lap: rec });
      }
    });
    po.observe({ type: "long-animation-frame", buffered: true });
  } catch { /* 没有 LoAF（Chrome < 123）：慢帧归因就不记，停摆记录照旧 */ }
}

let geomAt = 0;
let geomNow = {};
/**
 * 版面与画布的**绝对尺寸**：图层/画布大到离谱时（一次尺寸算错就能到几万像素），卡死的是光栅化与
 * 合成，JS 与长任务列表里一点痕迹都没有——这两格是给那种情况留的。
 * ⚠️ `scrollWidth` / `getBoundingClientRect()` 都会**强制一次布局**，而 `mark()` 站在热路径上
 * （250ms 一次），所以这里最多 5 秒采一次、其余时候给缓存：采现场不能自己变成开销。
 */
function geometry() {
  const now = performance.now();
  if (now - geomAt < 5000) return geomNow;
  geomAt = now;
  const cv = document.querySelector("#staff canvas");
  const r = cv ? cv.getBoundingClientRect() : null;
  geomNow = {
    htmlW: document.documentElement.scrollWidth,
    htmlH: document.documentElement.scrollHeight,
    cv: cv ? cv.width + "×" + cv.height : "",
    cvCss: r ? Math.round(r.width) + "×" + Math.round(r.height) : "",
  };
  return geomNow;
}

/** 屏幕上的「现在」——停摆时最有用的那几格：在哪个视图、DOM 多大、内存多少。 */
function snapshot(extra) {
  const tl = document.querySelector(".tl-list");
  let own = {};
  try { own = (provide && provide()) || {}; } catch { /* 采现场本身不该抛 */ }
  return Object.assign({
    view: own.view || "",
    screen: document.getElementById("view-stage")?.dataset.screen || "",
    tab: document.querySelector(".mix-tab[aria-selected='true']")?.textContent || "",
    sessions: own.sessions ?? null,
    approvals: own.approvals ?? null,
    cur: own.cur || "",
    phase: own.phase || "",
    framesIn: own.framesIn ?? null,
    framesOut: own.framesOut ?? null,
    rows: document.querySelectorAll(".prog-row").length,
    // ⚠️ 用 `getElementsByTagName("*").length`（活集合，长度便宜）而不是 `querySelectorAll("*")`：
    // 后者每次都遍历整份文档并建一个数组——这一格本来是为了留线索，不能自己变成负担。
    nodes: document.getElementsByTagName("*").length,
    tl: tl ? tl.children.length : 0,
    tlNodes: tl ? tl.getElementsByTagName("*").length : 0,
    heapMB: Math.round((performance.memory?.usedJSHeapSize || 0) / 1048576),
    // 最近 60 秒里主线程自己的长任务：次数 / 合计 / 最长。
    lt60: lt.at.length,
    lt60ms: Math.round(lt.at.reduce((a, x) => a + x.ms, 0)),
    ltMax: lt.max,
    // 可见性：`hidden` 是**最重要的那一格**——隐藏页的渲染与定时器本来就会被浏览器停掉，
    // 那段「沉默」不是卡死。没有它，一次切后台就长得和一次真卡死一模一样。
    hidden: document.hidden,
    vis: document.visibilityState,
    focus: document.hasFocus(),
    // 上一帧到现在多久（只在心跳那一刻算，所以 ≈0 表示「此刻帧是活的」）。
    frameAgeMs: lastFrameAt ? Math.round(performance.now() - lastFrameAt) : null,
    dpr: Math.round((window.devicePixelRatio || 0) * 100) / 100,
    // 版面与画布的**绝对尺寸**：图层/画布大到离谱时（一次尺寸算错就能到几万像素），卡死的是
    // 光栅化与合成，JS 与长任务列表里一点痕迹都没有。这两格是给那种情况留的（见 `geometry()`）。
    ...geometry(),
  }, extra || {});
}

/**
 * 热路径上的「我正在干什么」。**只标里程碑**，别在每帧里叫它——节流到 250ms，
 * 而停摆时留下的是**最后一条**：粒度就是「卡住之前最后启动的那件事」。
 * ⚠️ `postMessage` 的数据在调用时就拷走了，所以**即使主线程之后立刻被卡住**，这条也会送达 Worker。
 */
export function mark(tag) {
  if (!worker) return;
  const now = performance.now();
  if (now - lastMark < 250) return;
  lastMark = now;
  worker.postMessage({ snap: snapshot({ tag }) });
}

/**
 * 轻量面包屑：只报「此刻在哪」，**不动心跳时钟**（不采 DOM、不更新 `last.at`）。
 * 扇出里每一步都留一条，卡死时最后那条就是「进得去、出不来」的那一步。
 */
export function tag(label) {
  if (!worker) return;
  worker.postMessage({ tag: label });
}

/**
 * 循环体内的面包屑：带迭代次数，节流到 150ms（一个死循环一秒也只发六条，而且它**不会**把
 * 停摆判据自己喂饱——见 worker 里那条注释）。`label#48213` 就是死循环的证据与位置。
 */
export function spin(label, n) {
  if (!worker) return;
  const now = performance.now();
  if (now - lastSpin < 150) return;
  lastSpin = now;
  worker.postMessage({ tag: label + "#" + n });
}

/** `provide` 交回只有 model 知道的那几格（会话数 / 相位 / 帧数）——见文件头的注释。 */
export function mountWatchdog(provideState) {
  provide = provideState || null;
  try {
    const url = URL.createObjectURL(new Blob([SRC], { type: "text/javascript" }));
    worker = new Worker(url);
  } catch { return; }                    // 没有 Worker（老浏览器 / 被 CSP 拦）就静默退出
  watchLongTasks();
  watchSlowFrames();
  worker.onmessage = (e) => { if (e.data) report(e.data); };
  // ⚠️ **隐藏时也要发**（原来这里是 `if (!document.hidden) …`）：浏览器本来就会停掉隐藏页的渲染、
  // 把定时器降频，于是「切走两分钟」和「主线程卡死两分钟」在这里长得一模一样——
  // 2026-11-16 那条 102.6 秒的记录正是这么来的。现在照样发心跳，把 `hidden` 记进现场，
  // 由 `report()` 分开措辞。顺带：间隔 1.5 秒已经比隐藏页的降频门槛（1 秒）宽，不会因此变密。
  setInterval(() => worker?.postMessage({ snap: snapshot() }), 1500);
  // 帧那一路的心跳 —— 只有 rAF 才知道「浏览器还在给我画」。它必须和上面那条定时器心跳**分开**：
  // 两边一起停 = 主线程真被占住；帧先停 = 渲染那一路先没的。每帧一个空回调，500ms 最多一条消息。
  let beatAt = 0;
  const beats = () => {
    lastFrameAt = performance.now();
    if (lastFrameAt - beatAt >= 500) { beatAt = lastFrameAt; worker?.postMessage({ frame: 1 }); }
    requestAnimationFrame(beats);
  };
  requestAnimationFrame(beats);
  // 可见性自己变了也留一条：切走 / 被完全盖住时有据可查（`vis:hidden` / `vis:visible`）。
  document.addEventListener("visibilitychange", () => {
    tag("vis:" + document.visibilityState);
    worker?.postMessage({ snap: snapshot({ reason: "vis" }) });
  });
  // 上一次运行留下的记录：等首屏渲染完再问，别和启动抢主线程。
  setTimeout(() => worker?.postMessage({ ask: "last" }), 2500);
}

function lapLine(l) {
  const who = (l.scripts || []).map((s) => `${s.fn || "匿名"}${s.url ? "@" + s.url + ":" + s.line : ""} ${s.ms}ms${s.forced ? `（其中强制布局 ${s.forced}ms）` : ""} [${s.invoker}]`).join(" ; ");
  return `长帧 ${l.dur}ms：脚本 ${l.scriptMs}ms · 样式+布局 ${l.styleMs}ms · 其余 ${l.restMs}ms`
    + (who ? `\n  · ${who}` : "");
}

function report(data) {
  const stall = data.stall || null;
  const laps = (data.laps || []).filter((l) => l && Date.now() - l.at <= KEEP_MS);
  if (!stall && !laps.length) return;
  if (stall && Date.now() - stall.at > KEEP_MS) return;

  const s = (stall && stall.snap) || {};
  const secs = stall ? Math.round(stall.gapMs / 100) / 10 : 0;
  const when = new Date((stall ? stall.at : laps[0].at)).toLocaleString("zh-CN", { hour12: false });
  // 判据：Worker 自己的节拍被拖了多久。拖到同一个量级 ⇒ 饿死的是**进程 / 整机**。
  const drift = Math.round((stall && stall.selfDriftMs) || 0);
  const starved = stall ? drift >= stall.gapMs * 0.5 : false;
  // ⚠️ 四格现场 → 四种完全不同的结论，**别再把它们混成一句「页面在算」**：
  //   · Worker 节拍也迟到 ⇒ 整机 / 进程被饿死；
  //   · 当时页面 hidden ⇒ 浏览器停掉了隐藏页的渲染与定时器，这段沉默**不是卡死**（最常见）；
  //   · 帧比心跳早停一截 ⇒ 渲染那一路先没的：样式 / 布局 / 绘制 / 合成；
  //   · 帧和心跳同一时刻停 ⇒ 主线程被一整段原生代码（或一个没结束的任务）占住。
  const wasHidden = !!(stall && s.hidden);
  const frameGap = Math.round((stall && stall.frameGapMs) || 0);
  // ⚠️ **「没记」不等于「可见」**：旧版记录里没有这两格，`undefined` 一旦被当成 false，
  // 屏幕上就会写出「可见 · 帧停在心跳之前 0 ms」——那是瞎话（08:55 那条就是这么显示出来的）。
  const hasVis = !!(stall && typeof s.hidden === "boolean");
  const hasFrame = !!(stall && typeof stall.frameGapMs === "number");
  const verdict = starved
    ? `整机 / 进程被饿死（Worker 自己的节拍也晚了 ${drift} ms）——往「核心在跑重活、CPU 或内存被抢光」查`
    : !hasVis
      ? `旧版记录（还没有可见性那一格）：只能确认沉默期间主线程什么都没跑，分不清「页面被藏起来」还是「真的卡住」——下一次会是新版`
      : wasHidden
        ? `当时这一页是**隐藏**的（切到后台 / 被别的窗口完全盖住）：浏览器会停掉隐藏页的渲染与定时器心跳，这段沉默不是卡死`
        : hasFrame && frameGap >= 1500
          ? `帧先停、心跳后停（帧比心跳早停 ${Math.round(frameGap / 100) / 10} 秒）——JS 已经退栈，卡在样式 / 布局 / 绘制 / 合成那一路`
          : `帧与心跳一起停——主线程被一整段原生代码（或一个没结束的任务）占住，JS 已经退栈`;
  const verdictShort = starved ? "机器被抢光" : !hasVis ? "旧版记录" : wasHidden ? "当时页面是隐藏的" : hasFrame && frameGap >= 1500 ? "渲染先停" : "主线程被占住";

  const line = [
    stall ? `停摆 ${secs} 秒 · ${when}` : `没有停摆记录，但有慢帧 · ${when}`,
    stall ? `判读：${verdict}` : null,
    stall ? `当时：${s.tag || "（没有标记）"}` : null,
    stall ? `视图 ${s.view || "?"}${s.screen ? "/" + s.screen : ""} · 调音台页签 ${s.tab || "-"}` : null,
    stall ? `会话 ${s.sessions ?? "?"} 场（打开 ${s.cur || "无"}${s.phase ? " · " + s.phase : ""}）· 询问 ${s.approvals ?? "?"} 条` : null,
    stall ? `DOM ${s.nodes ?? "?"} 节点（节目单 ${s.rows ?? "?"} 行 · 时间线 ${s.tl ?? "?"} 条 / ${s.tlNodes ?? "?"} 节点）· 堆 ${s.heapMB ?? "?"} MB` : null,
    stall ? (hasVis
      ? `可见性 ${wasHidden ? "隐藏（" + (s.vis || "hidden") + "）" : "可见"}${s.focus === false ? " · 窗口无焦点" : ""} · 帧停在心跳之前 ${hasFrame ? frameGap + " ms" : "未记录"}`
      : `可见性 未记录（这一条来自还没加两路心跳的那一版）`) : null,
    stall ? (typeof s.htmlW === "number"
      ? `版面 ${s.htmlW}×${s.htmlH} · 画布 ${s.cv || "-"}（CSS ${s.cvCss || "-"}）· dpr ${s.dpr}`
      : `版面 未记录（同上）`) : null,
    stall ? `停摆前 60 秒主线程的长任务：${s.lt60 ?? "?"} 次 / 合计 ${s.lt60ms ?? "?"} ms / 最长 ${s.ltMax ?? "?"} ms` : null,
    // ⚠️ 这两格是 **WebSocket 帧**（核心那一路），不是 rAF 的帧——原来写成「帧 收 / 发」，误导过判读。
    stall ? `WS 帧 收 ${s.framesIn ?? "?"} / 发 ${s.framesOut ?? "?"}` : null,
    laps.length ? "慢帧归因（最近的几条）：" : null,
    ...laps.map((l) => "  " + lapLine(l)),
  ].filter(Boolean).join("\n");

  const bar = h("div.wd-bar", { role: "status" },
    // ⚠️ 隐藏期间的那段沉默**不许叫「停摆」**：一旦这么叫，用户每次切后台回来都会以为又卡了一次。
    h("b", stall
      ? (wasHidden ? "上次运行里有 " + secs + " 秒页面在后台（那不是卡死）" : "上次运行里主线程停过 " + secs + " 秒")
      : "上次运行里有 " + laps.length + " 次超长帧"),
    h("span.wd-when", " · " + (stall ? verdictShort : "看详情") + " · 当时在 " + (s.tag || laps[0]?.scripts?.[0]?.fn || "?")),
    h("span.sp"),
    h("button.btn.btn-sm.btn-ghost", { type: "button", onclick: () => copy(line) }, "复制详情"),
    h("button.icon-btn", { type: "button", "aria-label": "关掉", onclick: () => bar.remove() }, "✕"));
  bar.title = line;
  document.body.appendChild(bar);
  console.warn("[cadenza] 上一次运行的主线程记录：\n" + line);
}
