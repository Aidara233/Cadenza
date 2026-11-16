// Cadenza · audio — 提示音的合成与音量。viz 只决定「什么时候响」，这里决定「多响」。
//
// 增益是两级的：tone 的包络 → 每音增益（per-cue）→ 主增益（master）→ 限幅 → 输出。
// 主增益走一个 GainNode，所以调节对**正在响的音**也生效（setTargetAtTime，不爆音）。
// 每音增益在合成时乘进包络：同一类音用自己的比例，互不牵连。
//
// 存储：`cadenza.staffSound`。⚠️ 老版本是一个布尔（只有开关），读的时候迁移，
// 不丢用户已经做过的那个决定。
import { store } from "./util.js";

const KEY = "staffSound";
export const CUE_NAMES = ["step", "done", "ask", "answered", "error", "retry", "compact"];
export const CUE_LABEL = { step: "起步", done: "完成", ask: "等你", answered: "应答", error: "出错", retry: "重试", compact: "压缩" };

const clamp = (v, lo, hi, def) => (typeof v === "number" && isFinite(v) ? Math.min(hi, Math.max(lo, v)) : def);

let levels = load();
const subs = new Set();
let actx = null, master = null, limiter = null;
const lastAt = new Map();
let lastAny = -1e9;
// ⚠️ **AudioContext 只能在用户手势里创建**。`play()` 是 viz 收到提示事件时调的——那时候页面
// 可能一次点击都还没有，于是 `new AudioContext()` 会把控制台刷成「The AudioContext was not
// allowed to start」，而且建出来的那个还挂在 suspended 上（要等手势才肯出声）。
// 所以这里先等一次手势：手势之前**根本不建**这个对象（反正也出不了声），手势之后建 + resume，
// 之后每次手势都顺手续一次——标签页被切走、音频设备变了之后，它自己会回到 suspended。
let gestureDone = false;

function armGesture() {
  if (typeof document === "undefined") return;
  const opts = { capture: true, passive: true };
  const first = () => {
    gestureDone = true;
    for (const t of ["pointerdown", "keydown", "touchend"]) document.removeEventListener(t, first, opts);
    // 用户本来就开着声音（上一次的偏好）：这一刻把上下文建起来，它落在手势里，允许出声。
    if (levels.on) context();
  };
  for (const t of ["pointerdown", "keydown", "touchend"]) document.addEventListener(t, first, opts);
  // 之后每次手势都续一次：`resume()` 也只在手势里才肯成功。
  const keep = () => { if (actx && actx.state === "suspended") actx.resume().catch(() => { }); };
  for (const t of ["pointerdown", "keydown"]) document.addEventListener(t, keep, opts);
}
armGesture();

function load() {
  const raw = store.get(KEY, false);
  if (typeof raw === "boolean") return { on: raw, master: 1, per: {} };   // 旧值：只有开关
  if (raw && typeof raw === "object") {
    const per = {};
    for (const n of CUE_NAMES) {
      const v = raw.per && raw.per[n];
      if (typeof v === "number") per[n] = clamp(v, 0, 2, 1);
    }
    return { on: raw.on === true, master: clamp(raw.master, 0, 3, 1), per };
  }
  return { on: false, master: 1, per: {} };
}

function save() { store.set(KEY, levels); }

/** 快照（给面板画初值用）。per 里缺省 = 1。 */
export function audioLevels() {
  return { on: levels.on, master: levels.master, per: { ...levels.per } };
}

export const levelOf = (name) => levels.per[name] ?? 1;

export function onAudioChange(fn) {
  subs.add(fn);
  return () => subs.delete(fn);
}

function notify() {
  for (const fn of subs) { try { fn(audioLevels()); } catch (e) { console.error(e); } }
}

/** 改开关 / 主音量 / 每音音量。⚠️ 打开声音必须在用户手势里调用（浏览器要手势才肯出声）。 */
export function patchAudio(patch = {}) {
  if (typeof patch.on === "boolean") levels.on = patch.on;
  if (patch.master != null) levels.master = clamp(patch.master, 0, 3, 1);
  if (patch.per) {
    for (const [n, v] of Object.entries(patch.per)) {
      if (CUE_NAMES.includes(n)) levels.per[n] = clamp(v, 0, 2, 1);
    }
  }
  save();
  applyMaster();
  notify();
  return audioLevels();
}

function context() {
  if (!actx) {
    // 手势之前不建：建了也是 suspended，还会在控制台留一条警告。见文件上面 `armGesture()`。
    if (!gestureDone) return null;
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return null;
    try { actx = new AC(); } catch { return null; }
    master = actx.createGain();
    master.gain.value = levels.master;
    // 只兜底削波，不压动态：300% 叠加时也不至于爆掉。
    limiter = actx.createDynamicsCompressor();
    limiter.threshold.value = -6;
    limiter.knee.value = 8;
    limiter.ratio.value = 8;
    limiter.attack.value = 0.003;
    limiter.release.value = 0.12;
    master.connect(limiter);
    limiter.connect(actx.destination);
  }
  if (actx.state === "suspended") actx.resume().catch(() => { });
  return actx;
}

function applyMaster() {
  if (!master || !actx) return;
  const t = actx.currentTime;
  master.gain.cancelScheduledValues(t);
  master.gain.setTargetAtTime(levels.master, t, 0.02);
}

/** 一个音。gain 是**基准**（不含主/每音增益），k 是每音增益。 */
function tone(at, freq, dur, { type = "sine", gain = 0.05, glide = 0 } = {}, k = 1) {
  const ac = actx;
  if (!ac) return;
  const o = ac.createOscillator(), g = ac.createGain();
  o.type = type;
  o.frequency.setValueAtTime(freq, at);
  if (glide) o.frequency.exponentialRampToValueAtTime(Math.max(40, freq * glide), at + dur);
  const peak = Math.max(0.0001, gain * k);
  g.gain.setValueAtTime(0.0001, at);
  // 起音 5ms：比原来更陡，瞬态更容易从音乐里钻出来（时值不变，所以不吵）。
  g.gain.exponentialRampToValueAtTime(peak, at + Math.min(0.005, dur / 3));
  g.gain.exponentialRampToValueAtTime(0.0001, at + dur);
  o.connect(g).connect(master || ac.destination);
  o.start(at);
  o.stop(at + dur + 0.03);
}

// 频率整体上移一档（2–3kHz 是人耳最敏感区，同响度下更容易被听见）：
// 结构音（完成 / 应答 / 压缩）抬高，语义是"闷"的（出错 / 重试）保持低频。
const CUE = {
  step: (t, k) => tone(t, 587, 0.055, { type: "triangle", gain: 0.016 }, k),
  done: (t, k) => {
    tone(t, 880, 0.16, { type: "triangle", gain: 0.05 }, k);
    tone(t + 0.11, 1320, 0.3, { type: "triangle", gain: 0.045 }, k);
  },
  ask: (t, k) => {
    tone(t, 1320, 0.2, { type: "triangle", gain: 0.06 }, k);
    tone(t + 0.14, 1760, 0.55, { type: "triangle", gain: 0.04 }, k);
  },
  answered: (t, k) => {
    tone(t, 988, 0.12, { gain: 0.045 }, k);
    tone(t + 0.1, 1480, 0.22, { gain: 0.035 }, k);
  },
  error: (t, k) => {
    tone(t, 214, 0.3, { gain: 0.04, glide: 0.94 }, k);
    tone(t, 226, 0.3, { gain: 0.035 }, k);
  },
  retry: (t, k) => {
    tone(t, 330, 0.09, { gain: 0.035 }, k);
    tone(t + 0.12, 330, 0.09, { gain: 0.035 }, k);
  },
  compact: (t, k) => tone(t, 1320, 0.35, { gain: 0.03, glide: 0.5 }, k),
};

/**
 * 响一个提示音。返回是否真的响了（调用方不必关心）。
 * force=true 绕过节流——给面板的「试听」用。
 */
export function play(name, force = false) {
  if (!levels.on) return false;
  const now = performance.now();
  if (!force) {
    if (now - (lastAt.get(name) || 0) < 600) return false;   // 同一种音别叠成一团
    if (now - lastAny < 90) return false;                    // 也别和一秒内的另一种挤在一起
  }
  const ac = context();
  if (!ac || !CUE[name]) return false;
  lastAt.set(name, now);
  lastAny = now;
  CUE[name](ac.currentTime + 0.01, levelOf(name));
  return true;
}

/** 解锁 AudioContext（用户手势里调一次，确认浏览器肯出声）。 */
export function unlock() {
  gestureDone = true;                       // 调用点都在手势里（面板上的按钮）
  const ac = context();
  if (ac && ac.state === "suspended") ac.resume().catch(() => { });
  return !!ac;
}
