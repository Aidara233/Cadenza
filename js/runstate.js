// Cadenza · runstate — 顶栏那几格「现在到底在跑什么」：当前会话 / 出错 / 演奏中 / 后台任务 / 目标。
//
// 为什么在顶栏：切到总谱、账簿、后台时，舞台的头部与节目单都不在眼前，而「它还在跑吗、
// 有几个在等我看一眼」恰好是切视图时最常确认的一件事。顶栏是唯一跟着视图走的横条。
//
// ⚠️ **这里不存第二份状态**（与 `model.js` 同一条规矩）：相位读 `phaseOf(sessionId)`、
// 时长读行的 `runSince` / `runElapsedMs`（判据在 `model.js` 的 `runtimeText`，节目单用的是同一个）、
// 后台任务读 `mixer.jobsSummary(app.current)`——那张表只有调音台会拉。
// 于是「顶栏说在跑、节目单说休止」这种自相矛盾在结构上就不可能出现。
//
// ⚠️ 类名一律 `rs-`，**不复用 `.chip`**：舞台头部与 e2e 里的 `.chip.sh-jobs` / `.chip.goal`
// 指的是会话头部那一格，顶栏再放一个同形的类，等于给「这个选择器到底选中了谁」埋雷。
import { h, swap } from "./util.js";
import { app, phaseOf, runtimeText, setCurrent, titleOf, isArchived } from "./model.js";
import { STATUS } from "./stage.js";
import { mixer } from "./mixer.js";

/** 相位里「有活计」的那三个（与节目单的 ♪ 计数同一判据：`phaseOf` 的四态之一）。 */
const ACTIVE = new Set(["generating", "tools", "waiting"]);
/** 标签题里的「在跑」只算模型真在干活的两个：候场不是「在跑」，它的出口是那个 𝄐 的数。 */
const RUNNING = new Set(["generating", "tools"]);

const S = { root: null, sig: "", timer: 0 };

export function mountRunState(root) {
  S.root = root;
  // 四个信号源，都是既有事件，不另开轮询：会话行（相位 / 出错 / 目标 / 谁在跑）、任务表、
  // 换会话、询问（标签题前面那个 `(N)`）。标签题也在这里写下去——见 `paintTitle`。
  app.bus.on("sessions", render);
  app.bus.on("jobs", render);
  app.bus.on("current", render);
  app.bus.on("approvals", render);
  render();
  // 时长每 1000ms 走一格（chip 里那格 + 标签题）。⚠️ 只改那一个文本节点，不重建整块：
  // 24px 的 chip 每秒重画一次会抖。
  S.timer = setInterval(tick, 1000);
}

function render() {
  if (!S.root) return;
  const id = app.current;
  const row = id ? app.sessions.get(id) : null;
  const phase = id ? phaseOf(id) : "idle";
  const err = row?.lastError || null;
  const retry = row?.retry || null;
  const goal = !!row?.goal?.active;
  // 「别的会话在跑」：当前这一场自己有它那一格，再数进来就成了同一件事说两遍。
  const others = [...app.sessions.values()]
    .filter((r) => r.sessionId !== id && !isArchived(r.sessionId) && ACTIVE.has(phaseOf(r.sessionId)));
  // 出错是**行上的事实**（`lastError` 在下一步起步时由 model 清掉），不是时间窗口：
  // 一个「5 分钟前的错」自己消失，比一直挂着更容易骗人。
  // ⚠️ 也不数当前这一场（它自己那一格已经变红了，理由同上）。
  const errs = [...app.sessions.values()].filter((r) => r.sessionId !== id && r.lastError && !isArchived(r.sessionId));
  const jobs = mixer.jobsSummary(id);

  // 标签题独立于那几格：它比 chip 多读一个「等你」的数，也不跟着窄屏媒体查询收缩。
  paintTitle();

  // 只把「字会变的东西」拼进签名：签名没变就一个节点都不动（时长那格由 tick 管）。
  const sig = [
    id, row?.title, row?.turn, phase, err?.at, retry?.attempt, retry?.max, row?.runSince ? 1 : 0,
    others.map((r) => r.sessionId + (r.title || "")).join(","),
    errs.map((r) => r.sessionId + (r.lastError?.at || "")).join(","),
    jobs?.running, jobs?.total, goal,
  ].join("|");
  if (sig === S.sig) return;
  S.sig = sig;

  swap(S.root,
    row ? currentChip(row, phase, err, retry) : null,
    // 顺序：自己的那一场 → 最需要你看一眼的（出错） → 其余环境信息。
    errs.length ? errChip(errs, !!row) : null,
    others.length ? runsChip(others, !!row) : null,
    jobs?.running ? jobsChip(jobs) : null,
    goal ? goalChip() : null);
}

const goStage = () => app.bus.emit("goto", "stage");

/** 当前这一场：字形 + 标题 + 状态字 + 时长。点了回舞台（那是它的家）。 */
function currentChip(row, phase, err, retry) {
  const st = STATUS[phase] || STATUS.idle;
  const title = row.title || "无题";
  // ⚠️ 只在**真的在跑**时显示时长：停着的那一格若挂着上一段的 1m20s，会被读成「现在跑了这么久」。
  const time = row.runSince ? runtimeText(row) : "";
  return h("button.rs-chip.rs-sess", {
    type: "button",
    dataset: { state: err ? "error" : phase },
    title: [
      `当前会话 · ${title}`,
      `${row.sessionId} · 第 ${row.turn ?? 0} 小节`,
      err ? `上一步失败：${err.message}` : `相位：${st.label}`,
      "点一下回到舞台",
    ].join("\n"),
    onclick: goStage,
  },
    h("span.rs-glyph", { "aria-hidden": "true" }, err ? "✕" : st.glyph),
    h("span.rs-title", title),
    h("span.rs-state", err ? "出错" : retry ? `重奏 ${retry.attempt}/${retry.max}` : st.label),
    time ? h("span.rs-time.num", time) : null);
}

/** 有会话上一步失败了：红的那一格。点了跳到第一场（哪一场、为什么，写在 title 里）。 */
function errChip(errs, hasCurrent) {
  const lines = errs.slice(0, 4).map((r) => `· ${titleOf(r.sessionId)}：${r.lastError.message}`);
  if (errs.length > 4) lines.push(`· 还有 ${errs.length - 4} 个`);
  return h("button.rs-chip.rs-err", {
    type: "button",
    title: `${hasCurrent ? "另外 " : ""}${errs.length} 个会话的上一步失败了：\n${lines.join("\n")}\n点一下跳到第一场（它下次起步时这一格自己消失）`,
    onclick: () => { goStage(); setCurrent(errs[0].sessionId); },
  }, "✕ ", `${errs.length} 个出错`);
}

/** 别的会话还在跑：节目单之外的这条窄路，切了视图也看得见。 */
function runsChip(others, hasCurrent) {
  const lines = others.slice(0, 4).map((r) => `· ${titleOf(r.sessionId)} · ${(STATUS[phaseOf(r.sessionId)] || STATUS.idle).label}`);
  if (others.length > 4) lines.push(`· 还有 ${others.length - 4} 个`);
  return h("button.rs-chip.rs-run", {
    type: "button",
    title: `${hasCurrent ? `另外 ${others.length} 个会话在跑（当前这一场有自己的那一格）` : `${others.length} 个会话在跑`}：\n${lines.join("\n")}\n点一下去节目单`,
    onclick: goStage,
  }, h("span.rs-glyph", { "aria-hidden": "true" }, "♩"), `${others.length} 演奏中`);
}

/** 当前会话的后台任务：与舞台头部那格同源（`mixer` 拉到的同一张表），点了直接开任务面板。 */
function jobsChip(jobs) {
  return h("button.rs-chip.rs-jobs", {
    type: "button",
    title: `这个会话有 ${jobs.running} 个后台任务在跑（共 ${jobs.total} 个）。点开看输出 / 停止；它们不随 session.interrupt 停下。`,
    onclick: () => { goStage(); mixer.openJobs(); },
  }, "⏳ ", `${jobs.running} 在跑`, jobs.total > jobs.running ? h("span.rs-dim", ` / ${jobs.total}`) : null);
}

function goalChip() {
  return h("button.rs-chip.rs-goal", {
    type: "button",
    title: "主动性轴 = goal：模型停回合会自动续跑，直到调用 finish_goal。点一下去舞台。",
    onclick: goStage,
  }, h("span.rs-glyph", { "aria-hidden": "true" }, "⚑"), "目标");
}

/**
 * 浏览器标签题。**一个写者**（`app.js` 不碰它，两处各写一半会互相盖掉），而且**只报全局**：
 * 窗口最小化时它在替你数整个核心，而不是替你看某一场。
 *
 *   ✕N 出错  →  𝄐N 等你  →  ✓N 完成  →  ⏳N 任务  →  ♩N 在跑  · Cadenza
 *
 * 例：`✕1 出错 · 𝄐2 等你 · ♩1 在跑 · Cadenza`。
 * ⚠️ 顺序就是优先级，也正好是**截断时的保留顺序**（标签只露前十几个字）：
 * 出错 → 等你 → 完成 → 任务 → 在跑。各自只在 >0 时出现，全空时退回品牌全名
 * （`Cadenza · Lilara`，静止状态下与以前逐字相同）。
 *
 * 五个数各自的出处（都不新存一份状态）：
 *   ✕  `row.lastError`（行上的事实，下一步起步时由 model 清掉）
 *   𝄐  `app.approvals`（与「等你」那颗按钮同一个数）
 *   ✓  `row.doneAt`（跑完、还没打开看过；打开就清，见 stage.js 的 open）
 *   ⏳  当前会话的 `mixer.jobsSummary`（后台任务那张表只有调音台会拉，别处拿不到）
 *   ♩  `phaseOf` 落在 generating / tools 的会话数
 */
function paintTitle() {
  const rows = [...app.sessions.values()].filter((r) => !isArchived(r.sessionId));
  // ⚠️ 出错的那几场从「在跑 / 完成」里摘掉：出错后相位可能还停在 Generating（核心不发
  // session.state 也不补 phase），不摘的话同一场会在标签上被数两遍（又是一次「说两件事」）。
  const bad = rows.filter((r) => r.lastError).length;
  const done = rows.filter((r) => r.doneAt && !r.lastError).length;
  const running = rows.filter((r) => !r.lastError && RUNNING.has(phaseOf(r.sessionId))).length;
  // 后台任务只有**打开的那一场**有表（核心的任务清单是按会话的）：拿得到就报，拿不到就留白。
  const jobs = mixer.jobsSummary(app.current)?.running || 0;

  const marks = [];
  if (bad) marks.push(`✕${bad} 出错`);
  if (app.approvals.size) marks.push(`𝄐${app.approvals.size} 等你`);
  if (done) marks.push(`✓${done} 完成`);
  if (jobs) marks.push(`⏳${jobs} 任务`);
  if (running) marks.push(`♩${running} 在跑`);

  document.title = marks.length ? `${marks.join(" · ")} · Cadenza` : "Cadenza · Lilara";
}

/** 只动 chip 里时长那一个文本节点。停着的时候什么都不做（那些变化由 render 管）。 */
function tick() {
  const row = app.current ? app.sessions.get(app.current) : null;
  if (!row?.runSince) return;
  const node = S.root?.querySelector(".rs-time");
  const text = runtimeText(row);
  if (node && node.textContent !== text) node.textContent = text;
}
