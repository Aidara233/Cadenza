// Cadenza · beat — 节目单那条波浪的节拍。
//
// 它只有一个值：`bob` 动画的周期（毫秒）。存 localStorage、同步到 CSS 变量 `--bob`，
// 顺带提供相位对齐用的负延迟——重建行元素时动画从「当前节拍位置」继续，而不是从 0% 重跳。
import { store } from "./util.js";

const KEY = "bobMs";
export const BOB_MIN = 600;
export const BOB_MAX = 2000;
export const BOB_STEP = 100;
export const BOB_DEFAULT = 1100;

const clamp = (v) => {
  const n = Number(v);
  if (!isFinite(n)) return BOB_DEFAULT;
  return Math.min(BOB_MAX, Math.max(BOB_MIN, Math.round(n / BOB_STEP) * BOB_STEP));
};

let ms = clamp(store.get(KEY, BOB_DEFAULT));
const subs = new Set();

export const bobMs = () => ms;
export const bobDelay = () => `${-(Date.now() % ms)}ms`;

export function setBob(v) {
  const next = clamp(v);
  if (next === ms) return ms;
  ms = next;
  store.set(KEY, ms);
  applyBob();
  for (const fn of subs) { try { fn(ms); } catch (e) { console.error(e); } }
  return ms;
}

export function onBob(fn) {
  subs.add(fn);
  return () => subs.delete(fn);
}

/** 把当前节拍写进 CSS 变量（`--bob`，stage.css 拿它当 animation-duration）。 */
export function applyBob() {
  document.documentElement.style.setProperty("--bob", ms + "ms");
}
