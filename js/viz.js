// Cadenza · viz — the live staff in the topbar. One track.
//
// 只有一条谱：音符 = 会话真的做了什么（起步 / 等你 / 完成 / 出错 / 重试 / 压缩 / 目标切换）。
// 网络帧不再占一条轨，退成谱面后面的底纹 —— 同族在 MERGE_MS 内连发合并成一道淡竖线，
// 帧越密竖线越亮越粗。它只当"管道忙不忙"的环境信息，不跟音符抢位置。
//
// 音高（越靠上越需要你看一眼，小步最轻、结束最重）：
//   8 顶线 等你 𝄐   ·  7 上方间 出错 ✕  ·  6 第四线 完成（真的停下来了）
//   5 间 应答 / 收工   ·  4 中线 压缩 / 开席 / 定目标   ·  3 间 重试
//   0 底线 起步（一个小点，没有字、不发声）
//
// 提示音默认关闭（浏览器要手势解锁），点右下角 ♪ 打开；只给大事件配音，底纹永远静音。
import { app, phaseOf } from "./model.js";
import { play, audioLevels, onAudioChange } from "./audio.js";
import { openTuning } from "./tuning.js";

const SPEED = 36;       // px/s
const HEAD_PAD = 40;    // 播放头离右边缘
const MERGE_MS = 260;   // 同族帧的合并窗口
const STACK_MS = 260;   // 同音高挤在一起时，左右错开的时间窗
const MAX_NOTES = 240;
const MAX_TICKS = 900;

const INK = {
  brass: "#e0ad4f", amber: "#f3cd85", paper: "#efe6d6", teal: "#6fc2a8",
  red: "#ef6a4c", violet: "#b48ce0", muted: "#93877a", dim: "#6f6457", blue: "#7fb3e8",
};

const TITLE = "会话行为谱：起步（小点）/ 完成（停下来才算）/ 等你 𝄐 / 出错 ✕ / 应答 / 重试 / 压缩 · 背后淡竖线是网络帧 · 点 ♪ 调音量";

// ---------------------------------------------------------------- 音符
// p = 五线谱位置（0 = 最下线，8 = 最上线，单数在间里）。label 只给高信号事件。
function behavior(p) {
  switch (p.kind) {
    // 小步：最轻的一个点，不出字。step.end / Running 干脆不画。
    case "session.step.begin": return { label: "", p: 0, ink: INK.dim, size: 0.5, cue: "step" };
    case "session.step.end": return null;
    // 工具结果：起步上面一格的小点，让「生成 → 工具 → 生成」的节奏看得见
    case "tool.result.appended": return { label: "", p: 1, ink: INK.dim, size: 0.46, cue: null };
    case "session.state": return null;   // 四态由 phase 统一处理，见 watchPhases()
    case "approval.requested": return { label: "等你", p: 8, ink: INK.amber, size: 1.3, cue: "ask", fermata: true, tail: p.askKind };
    case "error": return { label: "出错", p: 7, ink: INK.red, size: 1.25, cue: "error", tail: p.message };
    case "approval.resolved": return { label: "应答", p: 5, ink: INK.brass, size: 1, cue: "answered" };
    case "release.recorded": return { label: "收工", p: 5, ink: INK.brass, size: 0.85, cue: null };
    case "session.compaction.completed": return { label: "压缩", p: 4, ink: INK.teal, size: 0.9, cue: "compact" };
    case "session.created": return { label: "开席", p: 4, ink: INK.paper, size: 0.9, cue: null };
    case "axis.changed":
      if (p.axis !== "initiative") return null;
      return { label: p.value === "goal" ? "定目标" : "回常态", p: 4, ink: INK.violet, size: 0.85, cue: null };
    case "retry.attempt": return { label: "重试", p: 3, ink: INK.violet, size: 0.8, cue: "retry", tail: p.reason };
    case "session.reclaimed": return null;
    case "spec.changed": return null;
    default: return null;   // message / tool.result / usage 之流只当底纹
  }
}

/** 真的停下来才算「完成」：phase 从有活计落回 idle 时才落这个音。 */
function doneNote(p) {
  return { label: "完成", p: 6, ink: INK.teal, size: 1.25, cue: "done", tail: p.turn > 0 ? "turn " + p.turn : "" };
}

// ---------------------------------------------------------------- 底纹：网络帧
const FRAME_INK = {
  "message.appended": INK.paper, "tool.result.appended": INK.teal,
  "session.step.begin": INK.violet, "session.state": INK.muted, "session.step.end": INK.dim,
  "usage.updated": INK.violet, "error": INK.red, "approval.requested": INK.amber,
  "approval.resolved": INK.brass, "release.recorded": INK.brass,
};
const frameInk = (dir, f) => dir === "out" ? INK.blue
  : f.kind === "ack" ? INK.muted
    : f.kind === "event" ? (FRAME_INK[f.payload?.kind] || INK.dim)
      : INK.dim;

/** 合并键：方向 + 帧种类（event 再带 payload.kind，这样一根竖线还能说明是什么在流）。 */
function familyOf(dir, f) {
  if (f.kind === "event") return dir + " · " + (f.payload?.kind || "event");
  return dir + " · " + (f.kind || "?");
}

// ---------------------------------------------------------------- 状态
const V = {
  cv: null, ctx: null, wrap: null, tempoEl: null, sndBtn: null,
  w: 0, h: 0, dpr: 1, raf: 0, timer: 0,
  notes: [], ticks: [], fam: new Map(), slot: new Map(), errAt: new Map(),
  times: [], frameTimes: [], last: null,
  reduced: false,
};

export function mountViz(canvas, tempoEl) {
  V.cv = canvas; V.ctx = canvas.getContext("2d"); V.tempoEl = tempoEl;
  V.wrap = canvas.parentElement;
  V.wrap.title = TITLE;
  V.reduced = matchMedia("(prefers-reduced-motion: reduce)").matches;
  new ResizeObserver(resize).observe(canvas);
  resize();
  soundButton();
  onAudioChange(paintSound);
  hover();

  app.core.on("frame", (dir, f) => frame(dir, f));
  app.core.on("event", (p) => {
    if (!p || typeof p.kind !== "string") return;
    // 同一事件会同时落在 session: 和 approvals: 两条流上 —— 只让第一个进场。
    if (dupe(p)) return;
    const m = behavior(p);
    if (m) note(m, p);
  });
  watchPhases();

  setInterval(tempo, 1000);
  tempo();
  kick();
}

function resize() {
  const r = V.cv.getBoundingClientRect();
  V.dpr = Math.min(2, devicePixelRatio || 1);
  V.w = r.width; V.h = r.height;
  V.cv.width = Math.max(1, r.width * V.dpr);
  V.cv.height = Math.max(1, r.height * V.dpr);
  kick();
}

function kick() {
  if (V.raf || V.timer) return;
  V.raf = requestAnimationFrame(draw);
}

function tempo() {
  const now = Date.now();
  V.times = V.times.filter((t) => now - t < 60000);
  V.frameTimes = V.frameTimes.filter((t) => now - t < 60000);
  if (!V.tempoEl) return;
  V.tempoEl.textContent = "♩ = " + V.times.length;
  V.tempoEl.title = `最近 60 秒：行为 ${V.times.length} 次 · 网络帧 ${V.frameTimes.length} 帧`
    + (V.last ? ` · 上一次「${V.last.label}」${new Date(V.last.at).toLocaleTimeString("zh-CN", { hour12: false })}` : "");
}

// ---------------------------------------------------------------- 入账
const seen = new Map();

/** 同一条事件从两条流上各来一次（session: / approvals:），400ms 内只算一次。 */
function dupe(p) {
  const now = Date.now();
  const fp = p.kind + "|" + (p.sessionId || "") + "|" + (p.askId || p.at || p.status || p.attempt || "");
  const last = seen.get(fp);
  seen.set(fp, now);
  if (seen.size > 200) for (const [k, t] of seen) if (now - t > 5000) seen.delete(k);
  return last != null && now - last < 400;
}

// phase 从「有活计」落回闲置，才算这一轮真的停了 —— 每步之间核心也会发 Idle，
// 那一层已经在 model.js 里被 phase 抹平了，这里只看相位变化。
const seenPhase = new Map();

function watchPhases() {
  for (const r of app.sessions.values()) seenPhase.set(r.sessionId, phaseOf(r.sessionId));
  app.bus.on("sessions", () => {
    for (const r of app.sessions.values()) {
      const ph = phaseOf(r.sessionId);
      const prev = seenPhase.get(r.sessionId);
      seenPhase.set(r.sessionId, ph);
      if (prev == null || prev === ph) continue;
      if (ph === "idle" && (prev === "generating" || prev === "tools")) {
        // 出错也会把相位打回 idle，但那不是「完成」：出错自己已经有一个音了
        if (r.lastError && Date.now() - r.lastError.at < 900) continue;
        note(doneNote({ turn: r.turn }), { sessionId: r.sessionId, kind: "phase.idle" });
      }
    }
  });
}

/** 同音高的音符几乎同时落下来时，左右错开一点，别叠成一坨。 */
function nudge(pitch, t) {
  const s = V.slot.get(pitch);
  if (!s || t - s.at > STACK_MS) { V.slot.set(pitch, { at: t, n: 0 }); return 0; }
  s.at = t; s.n++;
  const k = Math.ceil(s.n / 2);
  return (s.n % 2 ? 1 : -1) * Math.min(16, 8 * k);
}

function note(m, p) {
  const t = performance.now();
  V.notes.push({ t, at: Date.now(), sid: p.sessionId, kind: p.kind, dx: nudge(m.p, t), ...m });
  if (V.notes.length > MAX_NOTES) V.notes.splice(0, V.notes.length - MAX_NOTES);
  V.times.push(Date.now());
  V.last = { label: m.label || p.kind, kind: p.kind, at: Date.now() };
  if (m.cue) play(m.cue);
  kick();
}

function frame(dir, f) {
  const now = performance.now();
  const key = familyOf(dir, f);
  V.frameTimes.push(Date.now());
  const prev = V.fam.get(key);
  if (prev && now - prev.at < MERGE_MS) {
    // 同族连发：不新起一根竖线，只把它继续钉在播放头并累加计数。
    prev.at = now;
    prev.tick.t = now;
    prev.tick.n++;
    kick();
    return;
  }
  const tick = { t: now, n: 1, key, ink: frameInk(dir, f) };
  V.fam.set(key, { at: now, tick });
  V.ticks.push(tick);
  if (V.ticks.length > MAX_TICKS) V.ticks.splice(0, V.ticks.length - MAX_TICKS);
  kick();
}

// ---------------------------------------------------------------- 控件
function soundButton() {
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "staff-snd";
  // 点它打开调音面板（不是切换开关）；aria-pressed 仍表示「声音开着没有」，画面上是一道斜杠
  btn.setAttribute("aria-haspopup", "dialog");
  btn.setAttribute("aria-label", "提示音音量");
  btn.addEventListener("click", (e) => { e.stopPropagation(); openTuning(btn); });
  V.wrap.appendChild(btn);
  V.sndBtn = btn;
  paintSound();
}

function paintSound() {
  const on = audioLevels().on;
  V.sndBtn.setAttribute("aria-pressed", on ? "true" : "false");
  V.sndBtn.textContent = "266a";
  V.sndBtn.title = "提示音：点开调音量（主音量 + 每个音）";
}

function hover() {
  const describe = (hit) => {
    const when = new Date(hit.at).toLocaleTimeString("zh-CN", { hour12: false });
    if (hit.key) return `网络帧 · ${hit.key}${hit.n > 1 ? " ×" + hit.n + "（已合并）" : ""} · ${when}`;
    const name = hit.label || hit.kind;
    return `会话行为 · ${name} · ${when}` + (hit.sid ? " · 会话 " + hit.sid.slice(0, 6) : "") + (hit.tail ? " · " + String(hit.tail).slice(0, 70) : "");
  };
  V.wrap.addEventListener("mousemove", (e) => {
    const r = V.cv.getBoundingClientRect();
    const x = e.clientX - r.left;
    const head = r.width - HEAD_PAD;
    const now = performance.now();
    let best = null, far = 9;
    for (const n of V.notes) {                     // 音符优先：它是前台
      const d = Math.abs(head - ((now - n.t) / 1000) * SPEED + (n.dx || 0) - x);
      if (d < far) { far = d; best = n; }
    }
    if (!best) {
      far = 6;
      for (const k of V.ticks) {
        const d = Math.abs(head - ((now - k.t) / 1000) * SPEED - x);
        if (d < far) { far = d; best = k; }
      }
    }
    const want = best ? describe(best) : TITLE;
    if (V.wrap.title !== want) V.wrap.title = want;
  });
  V.wrap.addEventListener("mouseleave", () => { V.wrap.title = TITLE; });
}

// ---------------------------------------------------------------- 绘制
function fermata(ctx, x, y, r, ink, alpha) {
  ctx.save();
  ctx.globalAlpha = Math.max(0, Math.min(0.95, alpha + 0.25));
  ctx.strokeStyle = ink; ctx.fillStyle = ink; ctx.lineWidth = 1.1;
  ctx.beginPath(); ctx.arc(x, y, r, Math.PI, Math.PI * 2); ctx.stroke();   // 上半弧
  ctx.beginPath(); ctx.arc(x, y - 0.3, 1, 0, Math.PI * 2); ctx.fill();     // 中间那一点
  ctx.restore();
}

function draw() {
  V.raf = 0;
  const { ctx, w, h, dpr } = V;
  if (!ctx || !w) { V.timer = 0; return; }
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, w, h);

  const now = performance.now();
  const head = w - HEAD_PAD;
  // 上下都留出位置：顶上要放 fermata 和「等你」，底下要放下线音符的符干
  const staffTop = Math.max(8, h * 0.2);
  const staffH = Math.max(16, h - staffTop - Math.max(7, h * 0.15));
  const gap = staffH / 4;
  const staffBot = staffTop + staffH;
  const yOf = (p) => staffTop + (8 - p) * gap / 2;

  // --- 底纹：网络帧（先画，永远在音符后面） ---
  for (const k of V.ticks) {
    const age = (now - k.t) / 1000;
    const x = head - age * SPEED;
    if (x < -6) continue;
    const mag = Math.min(1, Math.log2(k.n + 1) / 3);
    ctx.globalAlpha = 0.045 + 0.15 * mag;
    ctx.strokeStyle = k.ink;
    ctx.lineWidth = 1 + mag * 1.1;
    ctx.beginPath();
    ctx.moveTo(Math.round(x) + 0.5, staffTop - 1);
    ctx.lineTo(Math.round(x) + 0.5, staffBot + 1);
    ctx.stroke();
  }
  ctx.globalAlpha = 1;

  // --- 五线 ---
  ctx.lineWidth = 1;
  ctx.strokeStyle = "rgba(224,173,79,0.15)";
  for (let i = 0; i < 5; i++) {
    const y = Math.round(staffTop + i * gap) + 0.5;
    ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(w, y); ctx.stroke();
  }
  // 播放头
  const grd = ctx.createLinearGradient(head - 26, 0, head + 2, 0);
  grd.addColorStop(0, "rgba(224,173,79,0)");
  grd.addColorStop(1, "rgba(224,173,79,0.20)");
  ctx.fillStyle = grd; ctx.fillRect(head - 26, staffTop, 28, staffH);

  // --- 音符 ---
  let live = false;
  const rx0 = Math.max(2.8, gap * 0.62), ry0 = Math.max(2.2, gap * 0.4);
  for (const n of V.notes) {
    const age = (now - n.t) / 1000;
    const x = head - age * SPEED + (n.dx || 0);
    if (x < -18) continue;
    live = true;
    const rx = rx0 * n.size, ry = ry0 * n.size;
    const yy = yOf(n.p);
    const fresh = Math.max(0, 1 - age * 1.5);
    // 别的会话干的：淡一些，别和正在看的这一场抢戏
    const dim = n.sid && app.current && n.sid !== app.current ? 0.45 : 1;

    ctx.save();
    ctx.translate(x, yy);
    ctx.rotate(-0.32);
    ctx.beginPath();
    ctx.ellipse(0, 0, rx, ry, 0, 0, Math.PI * 2);
    if (fresh > 0) { ctx.shadowColor = n.ink; ctx.shadowBlur = 14 * fresh; }
    ctx.globalAlpha = dim;
    ctx.fillStyle = n.ink;
    ctx.fill();
    ctx.restore();

    // 小步只给一个点，不画符干，免得碎成一地
    if (n.size >= 0.6) {
      const up = n.p < 4;
      const sx = x + (up ? rx - 0.5 : -rx + 0.5);
      ctx.strokeStyle = n.ink; ctx.globalAlpha = 0.7 * dim;
      ctx.beginPath();
      ctx.moveTo(sx, yy);
      ctx.lineTo(sx, yy + (up ? -gap * 1.5 : gap * 1.5));
      ctx.stroke();
      ctx.globalAlpha = 1;
    }

    if (n.fermata) fermata(ctx, x, Math.max(3.5, yy - ry - 2.5), Math.max(3, rx * 0.9), n.ink, dim * (1 - age / 26));
    if (n.kind === "error") {
      const d = Math.max(2, gap * 0.32);
      const cy = Math.max(3, yy - ry - 3 - d);
      ctx.strokeStyle = n.ink; ctx.globalAlpha = 0.9 * dim;
      ctx.beginPath();
      ctx.moveTo(x - d, cy - d); ctx.lineTo(x + d, cy + d);
      ctx.moveTo(x + d, cy - d); ctx.lineTo(x - d, cy + d);
      ctx.stroke();
      ctx.globalAlpha = 1;
    }
    if (n.label) {
      // 顶上的音符把字放在下面，免得被画布边缘切掉
      const below = yy - gap * 0.9 < 9;
      ctx.globalAlpha = 0.85 * dim * Math.max(0, Math.min(1, 1 - age / 10));
      ctx.fillStyle = n.ink;
      ctx.font = `italic ${Math.max(9, gap * 1) }px Georgia, "Times New Roman", serif`;
      ctx.textAlign = "left";
      ctx.fillText(n.label, x + rx + 5, below ? yy + gap * 1.15 : yy - gap * 0.6);
      ctx.globalAlpha = 1;
    }
  }

  // --- 播放头旁边挂一个 fermata：现在有东西在等你 ---
  if (app.approvals.size) {
    const pulse = 0.45 + 0.3 * (0.5 + 0.5 * Math.sin(now / 420));
    fermata(ctx, head + 13, staffTop + 3, 4.2, INK.amber, pulse);
    live = true;
  }

  // 滚出左边界就丢掉
  let cut = 0;
  while (cut < V.notes.length && head - ((now - V.notes[cut].t) / 1000) * SPEED < -20) cut++;
  if (cut) V.notes.splice(0, cut);
  cut = 0;
  while (cut < V.ticks.length && head - ((now - V.ticks[cut].t) / 1000) * SPEED < -8) cut++;
  if (cut) V.ticks.splice(0, cut);

  // 有东西在动才继续画；减少动效或标签页在后台时降成 2 次/秒，只补帧不逐帧
  if (!live) { V.timer = 0; return; }
  if (V.reduced || document.hidden) {
    V.timer = setTimeout(() => { V.timer = 0; kick(); }, 400);
  } else {
    V.raf = requestAnimationFrame(draw);
  }
}
