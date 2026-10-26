// Cadenza · tuning — 提示音的小面板（主音量 + 每个音各一条）。
//
// 它不是页面：8 个数值、低频调整，而且调的时候要能一边听一边改 —— 跳走再回来会打断听觉上下文。
// 所以挂成顶栏 ♪ 上的一块 popover；命令面板里也有同一个入口（窄屏顶栏整条谱是隐藏的，
// 那时 ♪ 不存在，不能把唯一入口挂在它身上）。
import { h } from "./util.js";
import { CUE_NAMES, CUE_LABEL, audioLevels, patchAudio, onAudioChange, play, unlock } from "./audio.js";
import { bobMs, setBob, BOB_MIN, BOB_MAX, BOB_STEP } from "./beat.js";

let panel = null;
let unsub = null;

const pct = (v) => Math.round(v * 100) + "%";

function row(label, value, { min, max, step, onInput, onDone }) {
  const num = h("span.tune-num", pct(value));
  const input = h("input.slider", {
    type: "range", min: String(min), max: String(max), step: String(step),
    value: String(Math.round(value * 100)), "aria-label": label,
    oninput: (e) => {
      const v = Number(e.target.value) / 100;
      num.textContent = pct(v);
      onInput(v);
    },
    onchange: (e) => onDone?.(Number(e.target.value) / 100),
  });
  return { el: h("label.tune-row", h("span.tune-name", label), input, num), input };
}

export function openTuning(anchor = null) {
  if (panel) { closeTuning(); return; }

  const cur = audioLevels();
  const state = { on: cur.on, master: cur.master, per: { ...cur.per } };
  const onBtn = h("button.btn.btn-sm.tune-on", { type: "button", "aria-pressed": String(state.on) },
    state.on ? "开" : "关");

  const paint = () => {
    onBtn.textContent = state.on ? "开" : "关";
    onBtn.setAttribute("aria-pressed", String(state.on));
    onBtn.classList.toggle("is-off", !state.on);
  };

  onBtn.addEventListener("click", () => {
    state.on = !state.on;
    if (state.on) unlock();          // 手势里解锁 AudioContext
    patchAudio({ on: state.on });
    paint();
    if (state.on) play("answered", true);
  });

  const master = row("全部", state.master, {
    min: 0, max: 300, step: 5,
    onInput: (v) => { state.master = v; patchAudio({ master: v }); },
    onDone: () => play("ask", true),
  });

  const rows = CUE_NAMES.map((name) => row(CUE_LABEL[name] || name, state.per[name] ?? 1, {
    min: 0, max: 200, step: 5,
    onInput: (v) => { state.per[name] = v; patchAudio({ per: { [name]: v } }); },
    onDone: () => play(name, true),
  }));

  // 节拍：节目单那条波浪的周期（bob），0.6–2.0 秒
  const beatNum = h("span.tune-num", (bobMs() / 1000).toFixed(1) + "s");
  const beatRow = h("label.tune-row",
    h("span.tune-name", "节拍"),
    h("input.slider", {
      type: "range", min: String(BOB_MIN), max: String(BOB_MAX), step: String(BOB_STEP),
      value: String(bobMs()), "aria-label": "节拍（毫秒）",
      oninput: (e) => {
        const v = Number(e.target.value);
        beatNum.textContent = (v / 1000).toFixed(1) + "s";
        setBob(v);
      },
    }),
    beatNum);

  panel = h("div.tune-panel", { role: "dialog", "aria-label": "提示音音量", "aria-modal": "false" },
    h("div.tune-head",
      h("b", "提示音 · 节拍"),
      onBtn,
      h("button.icon-btn.tune-x", { type: "button", "aria-label": "关闭", onclick: () => closeTuning() }, "✕")),
    h("div.tune-rows", master.el, beatRow, h("div.tune-sep"), ...rows.map((r) => r.el)),
    h("div.tune-foot",
      h("span.dim", "拖动时即时生效；松手试听 · 点外面或 Esc 关闭"),
      h("button.btn.btn-sm.btn-ghost", { type: "button", onclick: () => play("ask", true) }, "试听")));

  document.body.append(panel);
  place(panel, anchor);
  paint();

  // 外部改动（命令面板 / 另一个标签页）同步回来
  unsub = onAudioChange((lv) => {
    state.on = lv.on;
    state.master = lv.master;
    state.per = { ...lv.per };
    master.input.value = String(Math.round(lv.master * 100));
    master.el.querySelector(".tune-num").textContent = pct(lv.master);
    rows.forEach((r, i) => {
      const name = CUE_NAMES[i];
      const v = lv.per[name] ?? 1;
      r.el.querySelector(".tune-num").textContent = pct(v);
      r.input.value = String(Math.round(v * 100));
    });
    paint();
  });

  setTimeout(() => {
    document.addEventListener("pointerdown", outside, true);
    document.addEventListener("keydown", esc, true);
    onBtn.focus();
  });
  return panel;
}

export function closeTuning() {
  if (!panel) return;
  panel.remove();
  panel = null;
  unsub?.();
  unsub = null;
  document.removeEventListener("pointerdown", outside, true);
  document.removeEventListener("keydown", esc, true);
}

function outside(e) {
  if (panel && !panel.contains(e.target) && !e.target.closest?.(".staff-snd")) closeTuning();
}

function esc(e) {
  if (e.key === "Escape") { e.preventDefault(); closeTuning(); }
}

function place(el, anchor) {
  if (anchor && anchor.getBoundingClientRect) {
    const r = anchor.getBoundingClientRect();
    el.style.top = Math.round(Math.min(innerHeight - 12, r.bottom + 6)) + "px";
    el.style.right = Math.max(8, Math.round(innerWidth - r.right)) + "px";
  } else {
    el.style.top = "58px";
    el.style.right = "16px";
  }
}
