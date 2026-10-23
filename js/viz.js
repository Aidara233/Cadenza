// Cadenza · viz — the live staff in the topbar. Every WS frame becomes a note; pitch = event family.
import { app } from "./model.js";

// Staff position (0 = bottom line, 8 = top line; half-steps are spaces).
const PITCH = {
  "message.appended": 6, "tool.result.appended": 4, "session.step.begin": 2, "session.step.end": 1,
  "session.state": 3, "usage.updated": 0, "approval.requested": 8, "approval.resolved": 7,
  "axis.changed": 5, "spec.changed": 5, "error": 8, "release.recorded": 4,
  "session.created": 7, "session.compaction.completed": 6, "session.reclaimed": 2,
};
const TONE = { error: "#ef6a4c", "approval.requested": "#f3cd85", "approval.resolved": "#e0ad4f", "tool.result.appended": "#6fc2a8", "message.appended": "#efe6d6", out: "#7fb3e8", ack: "#93877a", "usage.updated": "#b48ce0" };

const V = { cv: null, ctx: null, notes: [], w: 0, h: 0, dpr: 1, raf: 0, tempoEl: null, times: [], reduced: false };
const SPEED = 38; // px per second

export function mountViz(canvas, tempoEl) {
  V.cv = canvas; V.ctx = canvas.getContext("2d"); V.tempoEl = tempoEl;
  V.reduced = matchMedia("(prefers-reduced-motion: reduce)").matches;
  const ro = new ResizeObserver(resize);
  ro.observe(canvas);
  resize();
  app.core.on("frame", (dir, f) => {
    let kind = f.kind === "event" ? f.payload?.kind : f.kind;
    if (f.kind === "subscribe" || f.kind === "unsubscribe") return;
    const isOut = dir === "out";
    const p = isOut ? 5 + (Math.random() * 2 | 0) : PITCH[kind] ?? 3;
    V.notes.push({ t: performance.now(), p, c: isOut ? TONE.out : TONE[kind] || (f.kind === "ack" ? TONE.ack : "#cbbfa9"), hollow: isOut || f.kind === "ack", accent: kind === "error" || kind === "approval.requested" });
    V.times.push(Date.now());
    if (V.notes.length > 400) V.notes.splice(0, V.notes.length - 400);
    kick();
  });
  setInterval(tempo, 1000);
  kick();
}

function resize() {
  const r = V.cv.getBoundingClientRect();
  V.dpr = Math.min(2, devicePixelRatio || 1);
  V.w = r.width; V.h = r.height;
  V.cv.width = r.width * V.dpr; V.cv.height = r.height * V.dpr;
  kick();
}

function tempo() {
  const now = Date.now();
  V.times = V.times.filter((t) => now - t < 60000);
  if (V.tempoEl) V.tempoEl.textContent = "♩ = " + V.times.length;
}

function kick() { if (!V.raf) V.raf = requestAnimationFrame(draw); }

function draw() {
  V.raf = 0;
  const { ctx, w, h, dpr } = V;
  if (!ctx || !w) return;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, w, h);
  const top = 6, gap = (h - 12) / 4;
  const y = (p) => top + (8 - p) * gap / 2;
  // staff
  ctx.strokeStyle = "rgba(224,173,79,0.16)";
  ctx.lineWidth = 1;
  for (let i = 0; i < 5; i++) { ctx.beginPath(); ctx.moveTo(0, Math.round(top + i * gap) + .5); ctx.lineTo(w, Math.round(top + i * gap) + .5); ctx.stroke(); }
  // bar lines every 4s
  const now = performance.now();
  ctx.strokeStyle = "rgba(224,173,79,0.10)";
  const off = ((now / 1000) * SPEED) % (SPEED * 4);
  for (let x = w - 40 - off + SPEED * 4; x > 0; x -= SPEED * 4) { ctx.beginPath(); ctx.moveTo(Math.round(x) + .5, top); ctx.lineTo(Math.round(x) + .5, top + gap * 4); ctx.stroke(); }
  // playhead
  const head = w - 40;
  const grd = ctx.createLinearGradient(head - 30, 0, head + 4, 0);
  grd.addColorStop(0, "rgba(224,173,79,0)"); grd.addColorStop(1, "rgba(224,173,79,0.22)");
  ctx.fillStyle = grd; ctx.fillRect(head - 30, top, 34, gap * 4);
  let alive = false;
  const rx = Math.max(3, gap * 0.62), ry = Math.max(2.2, gap * 0.44);
  for (const n of V.notes) {
    const age = (now - n.t) / 1000;
    const x = head - age * SPEED;
    if (x < -10) continue;
    alive = true;
    const yy = y(n.p);
    const fresh = Math.max(0, 1 - age * 1.6);
    ctx.save();
    ctx.translate(x, yy);
    ctx.rotate(-0.35);
    ctx.beginPath();
    ctx.ellipse(0, 0, rx, ry, 0, 0, Math.PI * 2);
    if (fresh > 0) { ctx.shadowColor = n.c; ctx.shadowBlur = 12 * fresh; }
    if (n.hollow) { ctx.strokeStyle = n.c; ctx.lineWidth = 1.3; ctx.stroke(); }
    else { ctx.fillStyle = n.c; ctx.fill(); }
    ctx.restore();
    // stem
    ctx.strokeStyle = n.c; ctx.globalAlpha = .75; ctx.lineWidth = 1;
    ctx.beginPath();
    const up = n.p < 4;
    ctx.moveTo(x + (up ? rx - 1 : -rx + 1), yy);
    ctx.lineTo(x + (up ? rx - 1 : -rx + 1), yy + (up ? -gap * 1.7 : gap * 1.7));
    ctx.stroke();
    ctx.globalAlpha = 1;
    if (n.accent) { ctx.fillStyle = n.c; ctx.font = `${gap * 1.4}px serif`; ctx.fillText(">", x - 4, top - 1 + (n.p > 6 ? gap * 4.9 : 0)); }
  }
  // trim off-screen
  const cut = V.notes.findIndex((n) => head - ((now - n.t) / 1000) * SPEED >= -10);
  if (cut > 0) V.notes.splice(0, cut);
  if (alive && !V.reduced && !document.hidden) V.raf = requestAnimationFrame(draw);
  else if (alive) setTimeout(kick, 500);
}
