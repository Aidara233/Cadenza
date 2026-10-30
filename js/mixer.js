// Cadenza · mixer — the inspector. Axes as faders, model, context gauge, slots, claims.
import { h, swap, clear, fmtTokens, fmtNum, fmtTime, fmtAgo, toast, confirmDlg, modal, store, copy } from "./util.js";
import { app, cmd } from "./model.js";
import { renderBlock } from "./blocks.js";

const M = { root: null, id: null, snap: null, tab: store.get("mixTab", "axes"), usage: null, context: null, claims: [], body: null, planSel: new Set(), planErr: "", planAt: null };

/**
 * 后台任务面板的状态（2026-10-28 接 `GET /sessions/{id}/jobs` + `jobs.list` / `job.output` / `job.kill`）。
 *
 * ⚠️ **它是头里唯一「自己轮询」的块**，而判据是：核心没有任务事件——`job` 的终态
 * 只会以**一对合成调用**（`job_output` 的自动回报）出现在会话流上。那条流能让时间线
 * 立刻画出「它跑完了」，却不会告诉我们「还有几个在跑」。所以列表只能拉。
 *
 * ⚠️ 轮询的三条闸（少一条就会白烧请求）：**有在跑的任务**、**或者正看着这个页签**、
 * **且页面没被隐藏**。会话切走 / 面板关掉时定时器必须停——不然每个开过的会话
 * 都在后台按 2 秒一次的节奏拉一份清单。
 */
const J = {
  sessionId: null, list: [], at: 0, err: "", open: null, sig: "", read: null,
  timer: 0, soon: 0, ui: null, rows: new Map(), panel: null, pre: null,
  outHead: null, outErr: null, outActs: null,
};

/** 任务状态 → 人能念的短词。⚠️ 判据是核心那四个常量（`BackgroundJobState`），不另拼字面量。 */
const JOB_STATE = {
  Running: { label: "在跑", cls: "running", glyph: "⏳" },
  Exited: { label: "已退出", cls: "exited", glyph: "✓" },
  Killed: { label: "已停止", cls: "killed", glyph: "■" },
  Lost: { label: "结局未知", cls: "lost", glyph: "?" },
};
const jobState = (s) => JOB_STATE[s] || { label: s || "?", cls: "other", glyph: "·" };

const AXIS_ICON = { initiative: "♩", permission: "⚿", safety: "⚠", verify: "✓", effort: "✦", temperature: "≈", network: "⌁" };
// Permission ladder colour bands follow the core's semantics (order is the contract).
const PERM_TONE = { off: "deny", readonly: "deny", investigate: "low", standard: "ask", authorized: "hot", trusted: "max" };

export const mixer = {
  mount(root) {
    M.root = root;
    // The "axis is on but the core isn't configured" hint depends on app.network.
    app.bus.on("network", () => { if (M.id && M.tab === "axes") render(); });
    // 页面从后台切回来时补一次：浏览器会把隐藏标签页的定时器冻住，回来时不能等下一轮。
    document.addEventListener("visibilitychange", () => {
      if (!document.hidden) { if (M.tab === "jobs") loadJobs(); else if (hasRunning()) scheduleJobs(); }
    });
  },
  show(id, snap) {
    if (M.id !== id) { M.planSel.clear(); M.planErr = ""; M.planAt = null; }
    M.id = id; M.snap = snap || null; M.usage = null; M.context = null;
    if (J.sessionId !== id) resetJobs(id);
    if (!M.root) return;
    if (!id) {
      clearTimeout(J.timer); clearTimeout(J.soon);
      swap(M.root, h("div.mix-idle", h("div.eyebrow", "Mixer"), h("p.dim", "打开一个会话，这里是它的调音台：行为轴、模型、上下文、提示词槽位。")));
      return;
    }
    render();
    loadSide();
    // ⚠️ 打开会话就拉一次任务表（一个请求）：标题栏那个「⏳ N 在跑」的 chip 全靠它。
    // 不开轮询——`take` 那一侧会按「有在跑」或「正看着页签」自己决定。
    loadJobs();
  },
  axis(name, value) { if (M.snap) { M.snap.axes = { ...M.snap.axes, [name]: value }; if (M.tab === "axes") render(); } },
  /** plan.updated 带的是与 /state.plan 逐字相同的摘要：照着重画，不合并、不推导。 */
  plan(summary) {
    if (!M.snap || !M.id) return;
    M.snap.plan = summary;
    M.planAt = null;
    M.planErr = "";
    prunePlanSelection(summary);
    if (M.tab === "plan") render();
  },
  usage(p) {
    if (M.id !== p.sessionId) return;
    const calls = [...(M.usage?.calls || [])];
    if (p.call) calls.push(p.call);
    M.usage = { ...(M.usage || {}), summary: p.summary, calls };
    loadContext();
  },
  async refresh() {
    if (!M.id) return;
    try { M.snap = await app.core.get(`/sessions/${encodeURIComponent(M.id)}/state`); } catch { }
    render(); loadSide();
    loadJobs();
  },

  /** 标题栏那个 chip 读它。`null` = 这个会话的任务表还没拉过（不显示，别编一个 0）。 */
  jobsSummary(id) {
    if (!id || J.sessionId !== id || !J.at) return null;
    const running = J.list.filter((j) => j.state === "Running").length;
    return { total: J.list.length, running };
  },
  /** 跳到「任务」页签；给了 jobId 就顺手把那段输出打开。 */
  openJobs(jobId) {
    if (!M.id || !M.root) return;
    if (M.tab !== "jobs") { M.tab = "jobs"; store.set("mixTab", "jobs"); render(); }
    if (jobId) openJob(jobId);
  },
  /**
   * 会话流上有动静时叫一声，别等下一轮轮询。
   * ⚠️ **不按「现在有没有任务在跑」筛**：那个判断读的是**上一次**拉回来的清单——
   * 打开会话时拉的那一次通常是空的（任务还没起），于是「刚起了第一个任务」这件事
   * 永远叫不动一次重拉，chip 与列表就停在「没有任务」。去抖 400ms 已经限流了；
   * 隐藏的页面不拉（浏览器本来也会冻住它）。
   */
  refreshJobsSoon() {
    if (!M.id || document.hidden) return;
    clearTimeout(J.soon);
    J.soon = setTimeout(() => { if (M.id && !document.hidden) loadJobs(); }, 400);
  },
};

async function loadSide() {
  const id = M.id;
  const [u, c, cl] = await Promise.allSettled([
    app.core.get(`/sessions/${encodeURIComponent(id)}/usage`),
    app.core.get(`/sessions/${encodeURIComponent(id)}/context`),
    app.core.get("/claims"),
  ]);
  if (id !== M.id) return;
  if (u.value) M.usage = u.value;
  if (c.value) M.context = c.value;
  if (cl.value) M.claims = cl.value;
  renderGauge();
  if (M.tab !== "axes") render();
}
async function loadContext() {
  const id = M.id;
  try { const c = await app.core.get(`/sessions/${encodeURIComponent(id)}/context`); if (id === M.id) { M.context = c; renderGauge(); } } catch { }
}

// ---------------- background jobs ----------------
// 数据只有一份：`GET /sessions/{id}/jobs`。用户侧的命令（`jobs.list` / `job.output` / `job.kill`）
// 与它同源，但前者把结果塞在回执的 note 里——那是**给人念的一句话**，形状不该被头依赖。
// ⇒ 读走 HTTP（结构化），停走命令（有回执、有拒绝理由）。

function resetJobs(id) {
  clearTimeout(J.timer); clearTimeout(J.soon);
  J.sessionId = id; J.list = []; J.at = 0; J.err = ""; J.open = null; J.sig = ""; J.read = null;
  J.ui = null; J.rows.clear();
  if (J.panel) J.panel.remove();
}

const hasRunning = () => J.list.some((j) => j.state === "Running");

async function loadJobs() {
  const id = M.id;
  if (!id) return;
  clearTimeout(J.timer);
  try {
    const r = await app.core.get(`/sessions/${encodeURIComponent(id)}/jobs`);
    if (id !== M.id || J.sessionId !== id) return;
    J.list = r.jobs || [];
    J.err = "";
    J.at = Date.now();
  } catch (e) {
    if (id !== M.id || J.sessionId !== id) return;
    J.list = []; J.at = 0;
    // ⚠️ 旧核心没有这个端点：说清是「核心不认这条路」，别画成「没有任务」——
    // 后者是**一条事实**，前者是「我看不到」，两者混起来会让人以为任务凭空消失了。
    J.err = e.status === 404
      ? "这个核心没有 GET /sessions/{id}/jobs（需要包含后台任务那一批的核心）。"
      : "拉任务表失败：" + (e.body?.error || e.message);
  }
  paintJobs();
  followOpen();
  scheduleJobs();
  app.bus.emit("jobs");   // 标题栏那个 chip 由舞台重画
}

/**
 * 让展开的那段输出**跟着长**。
 *
 * ⚠️ 这一段是实测逼出来的（2026-10-28 的 `14-jobs`）：面板只在打开时读一次，而「刚起的任务」
 * 那一次几乎总是读到 0 字节——于是列表在刷、输出窗口永远空白，人要自己去点「接着读」。
 * 要看的正是「它跑到哪了」，那就必须跟。
 *
 * ⚠️ 判据是**已读到的 nextOffset 与任务表说的大小**，不是「上次读之后过了多久」：
 * 没新字节就不发请求（否则每个轮询周期都白读一次 64 KiB）。
 * 已经到末尾就停；任务刚结束时若还差最后一段，会被补读一次（那是尾巴，值得看一眼）。
 */
function followOpen() {
  const r = J.read;
  const job = J.list.find((j) => j.id === J.open);
  if (!J.open || !r || !job || r.busy || r.error) return;
  // ⚠️ 判据要取**两个来源里大的那个**：`r.totalBytes` 是「上次读的那一刻」看到的长度，
  // 而任务刚起来时那一次读几乎必然是 0 字节（`echo` 还没落盘）。只信它 ⇒ `0 >= 0` 永远成立，
  // 于是「跟随」在第一次空读之后就再也不动了——面板会一直停在「它刚起来」。
  const known = Math.max(r.totalBytes ?? 0, job.outputBytes ?? 0);
  if (r.nextOffset >= known) return;
  readOutput(J.open, r.nextOffset, true);
}

/** 下一次多久之后再拉。⚠️ 三条闸都在这里，别在别处再排一个定时器。 */
function scheduleJobs() {
  clearTimeout(J.timer);
  if (!M.id || !M.root) return;
  if (document.hidden) return;                       // 后台标签页：浏览器也会冻住它，不如自己停
  if (!hasRunning() && M.tab !== "jobs") return;      // 都结束了、也没人在看 ⇒ 停
  J.timer = setTimeout(loadJobs, hasRunning() ? 2000 : 5000);
}

function jobsPanel(root) {
  if (!J.ui || J.ui.root !== root) J.ui = null;
  if (!J.ui) {
    const head = h("div.jobs-head");
    const err = h("div.mix-alert");
    err.hidden = true;
    const list = h("div.jobs");
    J.ui = { root, head, err, list };
    root.append(h("div.mix-sec",
      h("div.eyebrow", "后台任务 · jobs"),
      head, err, list,
      h("p.hint.dim", "清单来自 GET /sessions/{id}/jobs；「停止」发 job.kill。"
        + "用户这一侧不受模型权限轴管——模型拨到 off 之后，这里照样能停。")));
  }
  paintJobs();
}

function paintJobs() {
  const ui = J.ui;
  if (!ui || !ui.list.isConnected) return;
  const jobs = J.list || [];
  const running = jobs.filter((j) => j.state === "Running").length;

  swap(ui.head,
    h("b", jobs.length ? `${jobs.length} 个任务` : "没有任务"),
    running ? h("span.chip.green", `${running} 在跑`) : null,
    h("span.sp"),
    J.at ? h("span.dim.num", { title: "最后一次拉到清单的时刻" }, "刷新于 " + fmtTime(new Date(J.at).toISOString())) : null,
    h("button.btn.btn-sm.btn-ghost", { type: "button", title: "立刻重拉任务表", onclick: () => loadJobs() }, "↻"));
  ui.err.hidden = !J.err;
  if (J.err) ui.err.textContent = J.err;

  const want = new Set(jobs.map((j) => j.id));
  for (const [id, row] of J.rows) if (!want.has(id)) { row.li.remove(); J.rows.delete(id); }
  for (const job of jobs) {
    let row = J.rows.get(job.id);
    if (!row) { row = makeJobRow(); J.rows.set(job.id, row); }
    fillJobRow(row, job);
  }

  if (!jobs.length && !J.err) {
    swap(ui.list, h("div.jobs-empty.dim",
      "本会话没有后台任务。让模型用 ",
      h("code", "shell"), " / ", h("code", "dotnet_build"), " / ", h("code", "dotnet_test"), " 的 ",
      h("code", "background: true"), " 起一个；它们结束时会在时间线上留下一对自动回报。"));
  } else {
    const sig = jobs.map((j) => j.id).join(",");
    if (sig !== J.sig) {
      J.sig = sig;
      ui.list.replaceChildren(...jobs.map((j) => J.rows.get(j.id).li));
    } else if (!ui.list.querySelector(".job-row")) {
      ui.list.replaceChildren(...jobs.map((j) => J.rows.get(j.id).li));
    }
  }

  // 展开的那一段跟着它所属的行走（节点持久 ⇒ 已读到的文本与滚动位置都还在）。
  if (J.open && J.rows.has(J.open) && J.panel) {
    const row = J.rows.get(J.open);
    if (J.panel.parentElement !== row.li) row.li.append(J.panel);
    J.panel.hidden = false;
    paintOutput();
  } else {
    J.open = null;
    if (J.panel) J.panel.hidden = true;
  }
}

function makeJobRow() {
  const state = h("span.job-state");
  const kind = h("code.job-kind");
  const id = h("code.job-id");
  const acts = h("div.job-acts");
  const label = h("div.job-label");
  const meta = h("div.job-meta");
  const li = h("div.job-row", h("div.job-h", state, kind, id, h("span.sp"), acts), label, meta);
  return { li, state, kind, id, acts, label, meta };
}

function fillJobRow(row, job) {
  const st = jobState(job.state);
  row.li.dataset.job = job.id;
  row.li.dataset.state = job.state || "";
  row.state.className = "job-state st-" + st.cls;
  row.state.textContent = st.glyph + " " + st.label;
  row.kind.textContent = job.kind || "?";
  row.id.textContent = job.id;
  row.label.textContent = job.label || "（进程没有标签）";
  row.label.title = job.workingDirectory ? `工作目录 ${job.workingDirectory}` : "";
  swap(row.meta,
    h("span", { title: "已保留的输出字节数（上限 4 MiB，超出部分仍排空管道但不保存）" }, "输出 ", h("b.num", fmtNum(job.outputBytes ?? 0)), " 字节"),
    job.exitCode != null ? h("span", " · 退出码 ", h("b.num", String(job.exitCode))) : null,
    job.timeoutSeconds ? h("span", " · 时限 ", h("b.num", String(job.timeoutSeconds)), " 秒") : null,
    job.processId ? h("span.dim", " · pid " + job.processId) : null,
    h("span.dim", " · 起于 " + fmtTime(job.startedAt, true)),
    job.endedAt ? h("span.dim", " · 结束于 " + fmtTime(job.endedAt, true)) : null,
    job.reason ? h("div.job-reason", job.reason) : null);

  const open = J.open === job.id;
  swap(row.acts,
    h("button.btn.btn-sm.btn-ghost", {
      type: "button", "aria-expanded": String(open),
      onclick: () => (open ? closeJob() : openJob(job.id)),
    }, open ? "收起" : "输出"),
    h("button.btn.btn-sm.btn-ghost.danger-t", {
      type: "button", disabled: job.state !== "Running",
      title: job.state === "Running" ? "停掉整棵进程树；已写下的输出仍然读得到" : "它已经结束了，没有需要停止的东西",
      onclick: () => killJob(job.id),
    }, "停止"));
}

function closeJob() {
  J.open = null;
  J.read = null;
  if (J.panel) { J.panel.hidden = true; J.panel.remove(); }
  paintJobs();
}

/**
 * 打开某个任务的输出窗口。
 * ⚠️ 先确认它**在清单里**：从工具卡那条「在任务面板里打开」过来时，清单可能还没拉过
 * （或刚起、慢一拍）。直接画一个不存在的行会让 `J.open` 被 paintJobs 清掉，
 * 而表现是「点了没反应」——最坏的一类静默。
 */
async function openJob(jobId) {
  if (!J.list.some((j) => j.id === jobId)) await loadJobs();
  if (!J.list.some((j) => j.id === jobId)) {
    toast(`任务表里还没有 ${jobId}——它可能刚起，稍等一下再点`, "warn", 5200);
    return;
  }
  J.open = jobId;
  J.read = null;
  ensurePanel();
  paintJobs();
  readOutput(jobId, 0, false);
}

function ensurePanel() {
  if (J.panel) return J.panel;
  J.outHead = h("div.job-out-h");
  J.outErr = h("div.form-err");
  J.outActs = h("div.job-acts");
  J.pre = h("pre.job-pre");
  J.panel = h("div.job-out", J.outHead, J.outErr, J.pre, J.outActs);
  return J.panel;
}

function paintOutput() {
  const r = J.read;
  if (!J.panel) return;
  const job = J.list.find((j) => j.id === J.open);
  if (!r) {
    if (J.outHead) J.outHead.textContent = "正在读…";
    if (J.outActs) J.outActs.replaceChildren();
    if (J.pre) J.pre.textContent = "";
    return;
  }
  const read = r.chunks.reduce((n, c) => n + c.text.length, 0);
  // 头部那个总数同样取大的那个：`r.totalBytes` 可能还是空读时那一刻的 0（见 followOpen 的注释）。
  const total = Math.max(r.totalBytes ?? 0, job?.outputBytes ?? 0);
  swap(J.outHead,
    h("b", r.chunks.length ? `第 ${r.from}–${r.nextOffset} 字节` : "输出"),
    total ? h("span.dim", ` · 共 ${fmtNum(total)} 字节`) : null,
    r.running ? h("span.chip.green", "还在跑，输出会继续增长") : null,
    r.truncated ? h("span.chip.brass", { title: "超过核心的 4 MiB 保存上限，更早之后的部分没有保存" }, "已截断") : null,
    r.dropped ? h("span.dim", " · 更早的几段已折叠") : null);
  J.outErr.textContent = r.error || "";
  const text = r.chunks.map((c) => c.text).join("");
  J.pre.textContent = text || (r.busy ? "读取中…"
    : r.running ? "（还没有输出——它刚起来，等它写第一行）"
      : "（这个任务没有输出）");
  // 跟着长的时候要贴在底部，否则「它跑到哪了」还得自己滚。只在追加时贴。
  if (text) J.pre.scrollTop = J.pre.scrollHeight;
  swap(J.outActs,
    h("button.btn.btn-sm", {
      type: "button", disabled: r.busy || !(r.nextOffset < r.totalBytes),
      title: r.nextOffset < r.totalBytes ? "读下一段（一次最多 64 KiB）" : "已经读到末尾了",
      onclick: () => readOutput(J.open, r.nextOffset, true),
    }, "接着读"),
    h("button.btn.btn-sm.btn-ghost", {
      type: "button", disabled: r.busy, onclick: () => readOutput(J.open, 0, false),
    }, "从头"),
    h("span.sp"),
    h("button.btn.btn-sm.btn-ghost", {
      type: "button", disabled: !read, onclick: () => copy(J.pre.textContent),
    }, "复制"),
    job && job.state === "Running"
      ? h("button.btn.btn-sm.btn-ghost.danger-t", { type: "button", onclick: () => killJob(job.id) }, "停止")
      : null);
}

/**
 * 读一段输出。
 * ⚠️ **累积显示**而不是「后一段覆盖前一段」：`job_output` 是字节窗口，
 * 覆盖式显示会让人把中段当成开头（模型那边也是同一个坑，所以核心在结果第一行写明窗口）。
 * 段数有上限（8 段 ≈ 512 KiB）——一个几 MB 的日志全塞进 DOM 对浏览器不是免费的。
 */
async function readOutput(jobId, offset, append) {
  const id = M.id;
  if (!id || J.open !== jobId) return;
  if (!append || !J.read || J.read.jobId !== jobId) {
    J.read = { jobId, chunks: [], from: offset, nextOffset: offset, totalBytes: null, running: false, truncated: false, error: "", busy: false, dropped: false };
  }
  const r = J.read;
  r.busy = true;
  paintOutput();
  try {
    const res = await app.core.get(`/sessions/${encodeURIComponent(id)}/jobs/${encodeURIComponent(jobId)}/output?offset=${offset}`);
    if (J.read !== r || J.open !== jobId) return;
    if (res.text) r.chunks.push({ offset: res.offset, text: res.text });
    while (r.chunks.length > 8) { r.chunks.shift(); r.dropped = true; r.from = r.chunks[0].offset; }
    r.nextOffset = res.nextOffset ?? r.nextOffset;
    r.totalBytes = res.totalBytes ?? r.totalBytes;
    r.running = !!res.running;
    r.truncated = !!res.truncated;
    r.error = "";
  } catch (e) {
    if (J.read !== r) return;
    r.error = "读输出失败：" + (e.body?.error || e.message);
  } finally {
    if (J.read === r) { r.busy = false; paintOutput(); }
  }
}

/** 停一个任务：**有回执、有拒绝理由**，所以走命令而不是 HTTP（那条路没有 DELETE）。 */
async function killJob(jobId) {
  const job = J.list.find((j) => j.id === jobId);
  const ok = await confirmDlg({
    title: "停掉这个后台任务？", danger: true, ok: "停止",
    body: `${jobId}（${job?.kind || "?"}）连同整棵进程树会被杀掉。已经写下的输出仍然读得到；这一步不受模型权限轴管。`,
  });
  if (!ok) return;
  const ack = await cmd({ kind: "job.kill", sessionId: M.id, jobId }, { quiet: true });
  if (!ack.accepted) { toast(ack.reason || "停止被拒", "err", 6000); return; }
  toast(ack.note || "已停止", "ok", 5000);
  loadJobs();
  // 读着的那一段不会自己变——任务刚被我们杀掉，把窗口重读一次才对得上「已停止」。
  if (J.open === jobId) readOutput(jobId, 0, false);
}


function render() {
  if (!M.root || !M.snap) return;
  const tabs = [["axes", "行为"], ["plan", "计划"], ["jobs", "任务"], ["model", "模型"], ["slots", "槽位"], ["claims", "声明"]];
  const nav = h("div.mix-tabs", { role: "tablist" }, ...tabs.map(([k, l]) => h("button.mix-tab", {
    type: "button", role: "tab", "aria-selected": String(M.tab === k),
    onclick: () => { M.tab = k; store.set("mixTab", k); render(); if (k === "jobs") { loadJobs(); scheduleJobs(); } },
  }, l, k === "jobs" && J.list.some((j) => j.state === "Running")
    ? h("span.mix-tab-badge.num", String(J.list.filter((j) => j.state === "Running").length))
    : null)));
  // 页签切走后停轮询：没有人在看那个面板，继续拉只是白烧请求。
  if (M.tab !== "jobs") clearTimeout(J.timer);
  M.body = h("div.mix-body", { role: "tabpanel" });
  swap(M.root, h("div.mix-gauge-slot"), nav, M.body);
  renderGauge();
  ({ axes, plan, jobs: jobsPanel, model, slots, claims })[M.tab]?.(M.body);
  if (M.tab === "jobs") scheduleJobs();
}

// ---------------- context gauge (always visible) ----------------
function renderGauge() {
  const slot = M.root?.querySelector(".mix-gauge-slot");
  if (!slot) return;
  const latest = M.context?.latest;
  const sum = M.usage?.summary;
  // /context.latest.inputTokens is uncached input only (core d1c0895). The context length is the
  // full prompt = uncached + cache read; take cacheRead from the same call in the usage calls.
  const call = [...(M.usage?.calls || [])].reverse().find((c) => (latest ? c.callId === latest.callId : c.usage?.inputTokens != null) && c.usage?.inputTokens != null);
  const input = call ? call.usage.inputTokens + (call.usage.cacheReadTokens ?? 0) : latest?.inputTokens;
  const hit = call?.usage?.cacheReadTokens;
  const budget = guessWindow();
  const frac = input != null && budget ? Math.min(1, input / budget) : 0;
  const R = 46, C = 2 * Math.PI * R, arc = 0.75;
  const ring = `<svg viewBox="0 0 120 120" class="gauge-svg" aria-hidden="true">
    <circle cx="60" cy="60" r="${R}" class="g-track" stroke-dasharray="${C * arc} ${C}" transform="rotate(135 60 60)"/>
    <circle cx="60" cy="60" r="${R}" class="g-val${frac > .8 ? " hot" : ""}" stroke-dasharray="${C * arc * frac} ${C}" transform="rotate(135 60 60)"/>
    ${Array.from({ length: 11 }, (_, i) => { const a = (135 + i * 27) * Math.PI / 180; const r1 = 54, r2 = i % 5 === 0 ? 59 : 57; return `<line x1="${60 + r1 * Math.cos(a)}" y1="${60 + r1 * Math.sin(a)}" x2="${60 + r2 * Math.cos(a)}" y2="${60 + r2 * Math.sin(a)}" class="g-tick"/>`; }).join("")}
  </svg>`;
  swap(slot, h("div.gauge",
    h("div.gauge-dial", { html: ring },),
    h("div.gauge-read",
      h("div.eyebrow", "上下文"),
      h("div.gauge-num.num", input != null ? fmtTokens(input) : "—"),
      h("div.gauge-sub.dim", input != null ? `最近一次请求的全部输入${hit ? ` · 其中命中 ${fmtTokens(hit)}` : ""}` : "还没有报了用量的调用"),
      h("div.gauge-row",
        h("span", { title: "本会话累计未命中输入" }, "入 ", h("b.num", fmtTokens(sum?.inputTokens))),
        h("span", { title: "本会话累计输出" }, "出 ", h("b.num", fmtTokens(sum?.outputTokens))),
        h("span", { title: "本会话缓存命中率（只算报了缓存的调用）" }, "命中 ", h("b.num", sum?.cacheHitRate != null ? (sum.cacheHitRate * 100).toFixed(0) + "%" : "—")),
        h("span", { title: "调用次数" }, "×", h("b.num", fmtNum(sum?.calls)))))));
  const dial = slot.querySelector(".gauge-dial");
  if (dial && budget) dial.title = `按 ${fmtTokens(budget)} 窗口估算（核心不报窗口大小，这只是刻度）`;
}

function guessWindow() {
  // Display scale only; the core does not report context window sizes. The head is tuned for
  // a 1M-token window, so the dial is a share of that. The readout itself is always exact.
  return 1000000;
}

// ---------------- axes ----------------
function axes(root) {
  const defs = M.snap.axisDefinitions || app.axes?.axes || [];
  const vals = M.snap.axes || {};
  const alert = crossAlert(vals, defs);
  if (alert) root.append(h("div.mix-alert", { role: "alert" }, h("b", "跨轴告警"), " 安全＝生产，且权限 ≥ 授权。模型在生产环境里能直接写。"));
  for (const d of defs) root.append(axisRow(d, vals[d.name]));
  (webHints(vals, defs) || []).forEach((text) => root.append(h("div.mix-alert", text)));
  if ((M.snap.pluginProblems || []).length) root.append(h("div.mix-problems", h("div.eyebrow", "插件问题"), ...M.snap.pluginProblems.map((p) => h("div", p))));
}

/** The browser can see a session that says "web is on" while the core is not configured to do it. */
function webHints(vals, defs) {
  if (!vals.network || vals.network === "off") return [];
  const out = [];
  if (app.network == null) out.push("核心没有 /network-config——这个版本不支持联网工具。");
  else if (!app.network.enabled) out.push("联网轴已开，但核心的联网能力未启用：去后厅 · 联网 打开。");
  const perm = defs.find((d) => d.name === "permission");
  const pi = perm ? perm.values.indexOf(vals.permission) : -1;
  if (pi >= 0 && pi < perm.values.indexOf("investigate"))
    out.push("联网轴已开，但当前权限档位不允许消耗型工具（需要 investigate 及以上）。");
  return out;
}

function crossAlert(vals, defs) {
  const sf = app.axes?.alertSafety || "prod", af = app.axes?.alertFrom || "authorized";
  const perm = defs.find((d) => d.name === "permission");
  if (!perm || vals.safety !== sf) return false;
  return perm.values.indexOf(vals.permission) >= perm.values.indexOf(af);
}

function axisRow(d, cur) {
  const unavailable = d.available === false;
  const label = h("div.ax-h",
    h("span.ax-icon", { "aria-hidden": "true" }, AXIS_ICON[d.name] || "◇"),
    h("span.ax-label", d.label || d.name),
    d.pluginId ? h("span.chip.plum", d.pluginId) : null,
    !d.inContext ? h("span.chip", { title: "不进模型上下文（只影响请求参数）" }, "参数") : null,
    h("span.sp"),
    h("code.ax-val", cur ?? "—"));
  const row = h(`div.ax.ax-${d.name.replace(/\W/g, "_")}`, label);
  if (unavailable) { row.append(h("div.dim", d.problem || "插件不可用")); return row; }

  if (d.range) {
    const r = d.range;
    const v = parseFloat(cur ?? r.min);
    const slider = h("input.fader", { type: "range", min: r.min, max: r.max, step: r.step, value: isNaN(v) ? r.min : v, "aria-label": d.label });
    const out = row.querySelector(".ax-val");
    slider.addEventListener("input", () => { out.textContent = Number(slider.value).toFixed(1); });
    slider.addEventListener("change", () => setAxis(d.name, Number(slider.value).toFixed(1)));
    row.append(h("div.fader-wrap", slider, h("div.fader-scale", h("span", r.min), h("span", ((r.max + r.min) / 2).toFixed(1)), h("span", r.max))));
    return row;
  }
  const isPerm = d.name === "permission";
  const idx = d.values.indexOf(cur);
  // More than five steps do not fit one row in a 300px panel — wrap into rows of three.
  const rows = d.values.length > 5 ? ".seg-rows" : "";
  const seg = h(`div.seg${isPerm ? ".seg-ladder" : ""}${rows}`, { role: "radiogroup", "aria-label": d.label });
  d.values.forEach((v, i) => {
    const on = v === cur;
    const tone = isPerm ? PERM_TONE[v] || "" : d.name === "safety" && v === "prod" ? "max" : "";
    const b = h(`button.seg-b${on ? ".on" : ""}${i <= idx ? ".lit" : ""}${tone ? ".t-" + tone : ""}`, {
      type: "button", role: "radio", "aria-checked": String(on), title: v,
      onclick: () => { if (!on) setAxis(d.name, v); },
    }, h("span", v));
    seg.append(b);
  });
  row.append(seg);
  return row;
}

async function setAxis(axis, value) {
  if (axis === "permission" && value === "trusted") {
    const ok = await confirmDlg({ title: "全放行？", body: "trusted 档允许所有工具类别，包括不可逆的高危操作（删除、以及能跑任意命令的 shell），不再询问。", ok: "我确定", danger: true });
    if (!ok) { render(); return; }
  }
  const ack = await cmd({ kind: "session.setAxis", sessionId: M.id, axis, value }, { quiet: true });
  if (!ack.accepted) render();
}
// ---------------- plan ----------------
// 计划只存「还剩什么」：没有完成态、没有百分比；推进一格就是把它删掉。
// 三个入口（/state.plan、GET /plan、plan.updated）的 plan 逐字同形，所以只有一个渲染函数。
function planIds(tree, out = new Set()) {
  for (const n of tree || []) { out.add(n.id); planIds(n.children, out); }
  return out;
}

function prunePlanSelection(summary) {
  const ids = planIds(summary?.tree);
  for (const id of [...M.planSel]) if (!ids.has(id)) M.planSel.delete(id);
}

async function submitPlan(payload, errEl) {
  // ⚠️ 走 WS 命令而不是 `PUT /sessions/{id}/plan`：核心的 CORS 只放行 GET/POST/OPTIONS，
  // 浏览器对 PUT + JSON 的预检会被拒，fetch 只能报 “Failed to fetch”。
  // `session.plan` 与那条 PUT 共用 PlanJson.ParseEdit，拒绝理由也一样是给人看的一句话。
  const ack = await app.core.command({ kind: "session.plan", sessionId: M.id, ...payload });
  if (!ack.accepted) {
    const msg = ack.reason || "计划编辑被拒绝";
    M.planErr = msg;
    if (errEl) errEl.textContent = msg;
    return false;
  }
  M.planErr = "";
  return true;
}

function plan(root) {
  const summary = M.snap.plan || { active: false, remaining: 0 };
  const tree = summary.tree;              // ⚠️ 缺失 = 普通计划为空（不是空数组）
  const t0 = summary.t0;                  // ⚠️ 独立于 tree：只有 T0 时 tree 仍缺失
  const err = h("div.plan-err", { role: "alert" });
  err.textContent = M.planErr || "";
  const removeBtn = h("button.btn.btn-sm.btn-ghost.danger-t", { type: "button" }, "删除选中");
  const syncRemove = () => {
    removeBtn.disabled = M.planSel.size === 0;
    removeBtn.textContent = M.planSel.size ? `删除选中 (${M.planSel.size})` : "删除选中";
  };
  syncRemove();
  removeBtn.addEventListener("click", async () => {
    const ids = [...M.planSel];
    if (!ids.length) return;
    const ok = await confirmDlg({
      title: `删除 ${ids.length} 个节点？`, danger: true, ok: "删除",
      body: "连同子树一起删掉。删掉最后一个孩子的分支会自己消失，所以它的 id 也会从树里不见了。",
    });
    if (!ok) return;
    if (await submitPlan({ operation: "remove", ids }, err)) {
      M.planSel.clear(); syncRemove();
      toast("已提交给核心，等 plan.updated 回来", "ok");
    }
  });

  const refresh = h("button.btn.btn-sm.btn-ghost", { type: "button", title: "只刷新计划（GET /sessions/{id}/plan）", onclick: async () => {
    try {
      const r = await app.core.get(`/sessions/${encodeURIComponent(M.id)}/plan`);
      M.snap.plan = r.plan; M.planAt = r.updatedAt || null; M.planErr = "";
      prunePlanSelection(r.plan);
    } catch (e) { M.planErr = e.body?.error || e.message; }
    render();
  } }, "↻");

  root.append(
    h("div.mix-sec",
      h("div.eyebrow", "剩余计划 · plan"),
      h("div.plan-head",
        h("b.plan-now", summary.currentTitle || (tree ? "（当前叶子没有标题）" : t0 ? "只有固定 T0" : "没有计划")),
        h("span.sp"),
        h("span.chip.num", `${summary.remaining ?? 0} 个节点`),
        t0 ? h("span.chip.plum", { title: "固定长期任务；不计入剩余节点" }, "T0") : null,
        M.planAt ? h("span.dim.plan-at", fmtAgo(M.planAt)) : null,
        refresh),
      t0 ? renderT0(t0) : null,
      tree ? renderPlanTree(tree, summary, syncRemove) : h("div.dim", t0 ? "普通计划为空——固定 T0 仍在。" : "没有计划——用下面的「追加叶子」建第一步。"),
      h("p.hint.dim", "▶ 是当前叶子（第一个叶子），▸ 分支，○ 其余叶子。推进即删除，所以没有「已完成」。")),
    h("div.mix-sec",
      h("div.eyebrow", "编辑 · session.plan（与 PUT /plan 同语义）"),
      h("div.plan-actions",
        h("button.btn.btn-sm.btn-ghost", { type: "button", onclick: () => overwriteForm(tree) }, "整份覆盖"),
        h("button.btn.btn-sm.btn-ghost", { type: "button", onclick: () => appendForm(tree) }, "追加叶子"),
        !t0 ? h("button.btn.btn-sm.btn-ghost", { type: "button", onclick: () => t0Form(null) }, "设置 T0") : null,
        removeBtn),
      err,
      h("p.hint.dim", "提交后不在本地先改：等核心的 plan.updated 回来再画。结构判据全在核心，头只把写的东西原样交上去。")));
}

/** T0：用户设定的固定长期任务。它不在普通树里，模型不能删；头只通过 PUT /plan/t0 写。 */
function renderT0(t0) {
  return h("div.plan-t0",
    h("div.plan-t0-h",
      h("span.plan-t0-mark", { "aria-hidden": "true" }, "▣"),
      h("div.plan-t0-titles",
        h("div.eyebrow", "T0 · 固定长期任务"),
        h("b.plan-t0-title", t0.title)),
      h("span.sp"),
      h("button.btn.btn-sm.btn-ghost", { type: "button", onclick: () => t0Form(t0) }, "编辑"),
      h("button.btn.btn-sm.btn-ghost.danger-t", { type: "button", onclick: () => removeT0() }, "移除")),
    h("div.plan-t0-body", t0.body),
    h("div.plan-t0-note", "模型能读，但不能通过 plan / advance_plan 修改或删除。"));
}

async function removeT0() {
  const ok = await confirmDlg({
    title: "移除固定 T0？", danger: true, ok: "移除",
    body: "只清长期任务；普通剩余计划不受影响。移除后模型不再看到这条 T0。",
  });
  if (!ok) return;
  try {
    await app.core.del(`/sessions/${encodeURIComponent(M.id)}/plan/t0`);
    M.planErr = "";
    toast("已提交给核心，等 plan.updated 回来", "ok");
  } catch (ex) {
    M.planErr = ex.body?.error || ex.message;
    if (M.tab === "plan") render();
  }
}

function t0Form(t0) {
  const title = h("input.inp", { maxlength: "160", value: t0?.title || "", placeholder: "长期任务的标题（1..160）", "aria-label": "T0 标题" });
  const body = h("textarea.txt", { rows: 5, maxlength: "2000", placeholder: "长期任务的正文（1..2000），会原样进提示词", "aria-label": "T0 正文" });
  body.value = t0?.body || "";
  const err = h("div.plan-err", { role: "alert" });
  const form = h("form", { novalidate: true },
    h("p.hint.dim", "T0 是固定长期任务，与可推进的剩余树分开：它不计入节点数，模型不能删除。写入口是 PUT /sessions/{id}/plan/t0；核心需已重启到支持该端点的版本。"),
    h("label.field", h("span", "标题"), title),
    h("label.field", h("span", "正文"), body),
    err,
    h("div.dlg-actions",
      h("button.btn.btn-ghost", { type: "button", onclick: () => m.close() }, "取消"),
      h("button.btn.btn-primary", { type: "submit" }, t0 ? "保存 T0" : "设置 T0")));
  const m = modal(t0 ? "编辑 T0" : "设置 T0", form, { wide: true });
  (t0 ? body : title).focus();
  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    err.textContent = "";
    try {
      // HTTP PUT：这条没有等价的 WS 命令。失败时把核心的 error 原样显示。
      await app.core.put(`/sessions/${encodeURIComponent(M.id)}/plan/t0`, { title: title.value, body: body.value });
      m.close();
      toast("已提交给核心，等 plan.updated 回来", "ok");
    } catch (ex) {
      const msg = ex.body?.error || ex.message;
      err.textContent = ex.status === 0 ? `${msg}（若核心是刚更新的，先重启它）` : msg;
    }
  });
}

function renderPlanTree(nodes, summary, syncRemove) {
  const ul = h("ul.plan-tree");
  for (const n of nodes || []) {
    const kids = Array.isArray(n.children) ? n.children : [];
    const branch = kids.length > 0;
    const current = !branch && n.id === summary.currentId;
    const pick = h("input.plan-pick", { type: "checkbox", "aria-label": "选中 " + (n.title || n.id), checked: M.planSel.has(n.id) });
    pick.addEventListener("change", () => {
      pick.checked ? M.planSel.add(n.id) : M.planSel.delete(n.id);
      syncRemove();
    });
    const li = h(`li.plan-node${branch ? ".branch" : ".leaf"}${current ? ".current" : ""}`,
      h("div.plan-row",
        pick,
        h("span.plan-glyph", { "aria-hidden": "true" }, branch ? "▸" : current ? "▶" : "○"),
        h("div.plan-main",
          h("div.plan-line",
            h("span.plan-title", n.title || h("i.dim", "（无标题）")),
            current ? h("span.chip.plan-cur", "当前") : null),
          !branch && !n.body ? h("div.plan-nobody", "叶子没有正文：核心的合法树不会出现，执行前补上") : n.body ? h("div.plan-body", n.body) : null,
          h("code.plan-id", n.id))));
    if (branch) li.append(renderPlanTree(kids, summary, syncRemove));
    ul.append(li);
  }
  return ul;
}

function branchesOf(tree, depth = 0, out = []) {
  for (const n of tree || []) {
    const kids = Array.isArray(n.children) ? n.children : [];
    if (kids.length) { out.push({ id: n.id, label: "· ".repeat(depth) + (n.title || n.id) }); branchesOf(kids, depth + 1, out); }
  }
  return out;
}

function appendForm(tree) {
  const title = h("input.inp", { maxlength: "160", placeholder: "标题（1..160 字）", "aria-label": "节点标题" });
  const body = h("textarea.txt", { rows: 4, placeholder: "这一步要做什么（叶子必填，会原样进提示词）", "aria-label": "节点正文" });
  const parent = h("select.sel", h("option", { value: "" }, "（根）"), ...branchesOf(tree).map((b) => h("option", { value: b.id }, b.label)));
  const index = h("input.inp.num", { type: "number", min: "0", placeholder: "省略 = 追加", "aria-label": "插入位置" });
  const err = h("div.plan-err", { role: "alert" });
  const form = h("form", { novalidate: true },
    h("label.field", h("span", "标题"), title),
    h("label.field", h("span", "正文"), body),
    h("div.grid2", h("label.field", h("span", "挂到哪个分支"), parent), h("label.field", h("span", "位置"), index)),
    err,
    h("div.dlg-actions",
      h("button.btn.btn-ghost", { type: "button", onclick: () => m.close() }, "取消"),
      h("button.btn.btn-primary", { type: "submit" }, "插入")));
  const m = modal("追加一个叶子", form);
  title.focus();
  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const payload = { operation: "insert", nodes: [{ title: title.value, body: body.value }] };
    if (parent.value) payload.parentId = parent.value;
    if (index.value.trim() !== "") payload.index = Number(index.value);
    if (await submitPlan(payload, err)) { m.close(); toast("已提交给核心，等 plan.updated 回来", "ok"); }
  });
}

function overwriteForm(tree) {
  const ta = h("textarea.txt.plan-json", { rows: 16, spellcheck: false, "aria-label": "计划节点 JSON" });
  ta.value = JSON.stringify(tree || [], null, 2);
  const err = h("div.plan-err", { role: "alert" });
  const form = h("form", { novalidate: true },
    h("p.hint.dim", "整份替换。空数组 [] = 清空计划；id 可以省（核心会生成），全树必须唯一。"),
    ta, err,
    h("div.dlg-actions",
      h("button.btn.btn-ghost", { type: "button", onclick: () => m.close() }, "取消"),
      h("button.btn.btn-primary", { type: "submit" }, "覆盖")));
  const m = modal("整份覆盖计划", form, { wide: true });
  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    let nodes;
    try { nodes = JSON.parse(ta.value); }
    catch (ex) { err.textContent = "JSON 解析失败：" + ex.message; return; }
    if (await submitPlan({ operation: "overwrite", nodes }, err)) { m.close(); toast("已提交给核心，等 plan.updated 回来", "ok"); }
  });
}

// ---------------- model ----------------
function model(root) {
  const spec = M.snap.spec || {};
  const m = spec.model || {};
  const prov = h("select.sel", { "aria-label": "提供商" }, ...app.providers.map((p) => h("option", { value: p.id, selected: p.id === m.providerId }, p.id)));
  if (!app.providers.some((p) => p.id === m.providerId)) prov.prepend(h("option", { value: m.providerId, selected: true }, m.providerId + "（已不存在）"));
  const modelBox = h("div");
  let discoveredModels = null;
  const fillModels = () => {
    const p = app.providers.find((x) => x.id === prov.value);
    const keep = prov.value === m.providerId ? m.modelId : p?.defaultModel || "";
    const choices = discoveredModels || p?.models || [];
    if (choices.length) {
      const sel = h("select.sel.mx-model", { "aria-label": "模型" }, ...choices.map((x) => h("option", { value: x, selected: x === keep }, x)));
      if (!choices.includes(keep) && keep) sel.prepend(h("option", { value: keep, selected: true }, keep));
      swap(modelBox, sel);
    } else swap(modelBox, h("input.inp.mono.mx-model", { value: keep, "aria-label": "模型", placeholder: "模型 id" }));
  };
  prov.addEventListener("change", () => { discoveredModels = null; fillModels(); });
  fillModels();
  const refreshModels = h("button.btn.btn-sm.btn-ghost", { type: "button", onclick: async (e) => {
    const b = e.currentTarget; b.disabled = true; b.textContent = "查询中…";
    try {
      const ack = await app.core.command({ kind: "provider.models", id: prov.value });
      const ids = ack.data?.models || ack.data?.Models || [];
      if (!ack.accepted || !ids.length || /^查询模型列表失败/.test(ack.note || "")) { toast(ack.note || ack.reason || "没有返回模型", "err", 5000); return; }
      discoveredModels = ids; fillModels();
      toast(`已从核心获取 ${ids.length} 个模型`, "ok");
    } finally { b.disabled = false; b.textContent = "刷新列表"; }
  } }, "刷新列表");
  const tmo = h("input.inp.num", { type: "number", min: 1, placeholder: spec.askTimeout ? "" : "不超时", value: timeoutMinutes(spec.askTimeout) ?? "", "aria-label": "询问超时（分钟）" });
  const apply = h("button.btn.btn-primary.btn-sm", { type: "button" }, "换调");
  apply.addEventListener("click", async () => {
    const payload = { kind: "session.configure", sessionId: M.id };
    const mid = modelBox.querySelector(".mx-model").value.trim();
    if (prov.value !== m.providerId) payload.providerId = prov.value;
    if (mid && mid !== m.modelId) payload.modelId = mid;
    const t = parseInt(tmo.value, 10);
    if (t > 0 && t !== timeoutMinutes(spec.askTimeout)) payload.askTimeoutMinutes = t;
    if (Object.keys(payload).length === 2) { toast("什么都没变", "info"); return; }
    const ack = await cmd(payload);
    if (ack.accepted) mixer.refresh();
  });
  root.append(
    h("div.kv",
      kv("协议", h("code", m.protocol)),
      kv("思考强度", h("code", m.effort ?? "—")),
      kv("最大输出", h("span.num", fmtNum(m.maxTokens))),
      kv("创建于", fmtTime(spec.createdAt, true)),
      kv("预设", spec.systemPromptPreset ? h("code", spec.systemPromptPreset) : h("span.dim", "内置模板")),
      kv("询问超时", spec.askTimeout ? h("code", spec.askTimeout) : h("span.dim", "不超时"))),
    h("div.mix-sec", h("div.eyebrow", "换调 · session.configure"),
      h("label.field", h("span", "提供商"), prov),
      h("label.field", h("span", "模型"), h("div.row", modelBox, refreshModels)),
      h("label.field", h("span", "询问超时（分钟）"), tmo, h("span.hint", "只能设成正数；核心没有「取消超时」的入口")),
      h("div.row-end", apply)));
  // ⚠️ 这里必须分开 append：`root` 是真实 DOM 节点，原生 append 会把 null 变成文本 "null"，
  // 而项目里的 h() 才会跳过空孩子。没有插件时页底一直挂着一行 null，就是这么来的。
  if ((spec.plugins || []).length) {
    root.append(h("div.mix-sec", h("div.eyebrow", "插件"), ...spec.plugins.map((p) => h("div.kv-line", h("code", p.id), h("span.dim", " v" + p.version)))));
  }
}

function timeoutMinutes(ts) {
  if (!ts) return null;
  const m = /^(?:(\d+)\.)?(\d+):(\d+):(\d+)/.exec(ts);
  if (!m) return null;
  return (+(m[1] || 0)) * 1440 + (+m[2]) * 60 + (+m[3]);
}

const kv = (k, v) => h("div.kv-row", h("span.kv-k", k), h("span.kv-v", v));

// ---------------- slots ----------------
function slots(root) {
  const s = M.snap.slots || {};
  if (s.problem) root.append(h("div.mix-alert", "槽位收集出错：", s.problem));
  const sec = (name, label, blocks, hint) => {
    const n = (blocks || []).length;
    const d = h("details.slot", { open: name === "floating" },
      h("summary", h("span.slot-name", label), h("code.dim", name), h("span.sp"), h("span.chip.num", n ? `${n} 块` : "空")),
      h("p.hint.dim", hint),
      n ? h("div.slot-body", ...blocks.map(renderBlock)) : h("div.slot-empty", "（空）——这个会话没配这一块"));
    root.append(d);
  };
  root.append(h("p.dim.mix-note", "与发给模型的请求同一来源。这里是「此刻」；请求在步开始时冻结。"));
  sec("system", "系统", s.system, "系统提示词（预设文件 presets/<id>.md）");
  sec("premier", "首要", s.premier, "首要块（premiers/<id>.md）");
  sec("floating", "浮动", s.floating, "此刻的浮动上下文（核心每步现算，不在历史里）");
}

// ---------------- claims ----------------
function claims(root) {
  const mine = M.claims.filter((c) => c.sessionId === M.id);
  const others = M.claims.filter((c) => c.sessionId !== M.id && c.projectKey === M.snap.spec?.projectKey);
  const row = (c, own) => h("li.claim" + (c.stale ? ".stale" : ""),
    h("code", c.path),
    h("span.dim", fmtAgo(c.at)),
    c.stale ? h("span.chip.red", "主人已不在") : null,
    h("span.sp"),
    h("button.btn.btn-ghost.btn-sm", { type: "button", title: "强制释放（不检查占用者）", onclick: async () => {
      const ok = own || await confirmDlg({ title: "强制释放别人的声明？", body: "不检查占用者是不是自己。", ok: "释放" });
      if (!ok) return;
      const ack = await cmd({ kind: "claim.release", sessionId: c.sessionId, scope: [c.path] });
      if (ack.accepted) loadSide();
    } }, "释放"));
  root.append(
    h("div.mix-sec", h("div.eyebrow", "本会话占着"), mine.length ? h("ul.claims", ...mine.map((c) => row(c, true))) : h("div.dim", "没有")),
    h("div.mix-sec", h("div.eyebrow", "同项目的其他会话"), others.length ? h("ul.claims", ...others.map((c) => row(c, false))) : h("div.dim", "没有")),
    h("div.row-end", h("button.btn.btn-sm.btn-ghost", { type: "button", onclick: () => loadSide() }, "刷新")));
}
