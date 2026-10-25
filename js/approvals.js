// Cadenza · approvals — the "cue card": permission and question asks, all four item shapes.
import { h, fmtCountdown, prettyJson, toast } from "./util.js";
import { app, cmd, titleOf, markLocal, scheduleRefresh } from "./model.js";
import { md } from "./md.js";

/** Make sure we have the question text; after a restart only /state can give it back. */
export async function hydrate(a) {
  if (a.items && a.items.length) return a;
  try {
    const st = await app.core.get(`/sessions/${encodeURIComponent(a.sessionId)}/state`);
    if (st.ask && st.ask.askId === a.askId) {
      a.items = st.ask.items || [];
      a.remember = st.ask.remember || a.remember || [];
      a.toolName = st.ask.toolName || a.toolName;
      a.deadlineAt = st.ask.deadlineAt ?? a.deadlineAt;
      a.askKind = st.ask.kind || a.askKind;
      a.partial = false;
    }
  } catch { /* leave partial */ }
  return a;
}

/**
 * Build a cue card. opts.compact = list mode (Stage sidebar); opts.onDone after resolved.
 */
export function cueCard(a, opts = {}) {
  const isPerm = a.askKind === "permission";
  const state = { answers: {}, remember: "", edited: null };
  const card = h(`form.cue${isPerm ? ".cue-perm" : ".cue-q"}`, { dataset: { askId: a.askId }, "aria-label": isPerm ? "授权请求" : "提问" });
  const timer = a.deadlineAt ? h("span.cue-timer.num", { title: "到期后答案不再被采用" }, fmtCountdown(a.deadlineAt)) : null;
  let tick = 0;
  if (timer) {
    tick = setInterval(() => {
      if (!card.isConnected) { clearInterval(tick); return; }
      timer.textContent = fmtCountdown(a.deadlineAt);
      timer.classList.toggle("late", new Date(a.deadlineAt) - Date.now() < 60000);
    }, 1000);
  }

  card.append(h("header.cue-h",
    h("span.cue-mark", { "aria-hidden": "true" }, isPerm ? "𝄐" : "?"),
    h("div.cue-title",
      h("div.eyebrow", isPerm ? "等你的手势 · 授权" : "等你的回答 · 提问"),
      h("div.cue-who", opts.showSession ? titleOf(a.sessionId) + " · " : "", isPerm ? h("code", a.toolName || "工具调用") : `${(a.items || []).length || "?"} 个问题`)),
    timer));

  const body = h("div.cue-body");
  card.append(body);

  // 过期询问：核心在「重启 / 上一步被杀」之后不会主动补一条答复 —— 只有**下一次推进**
  // 才会收尾（`Recovery.BeforeStep`）。不催的话，这张卡会一直挂着，看起来像会话卡在「等你」。
  if (a.deadlineAt && new Date(a.deadlineAt) <= new Date()) {
    card.append(h("div.cue-expired",
      h("span", "这条询问已经过期（答案不再被采用）：多半是核心重启或上一步被杀留下的。"),
      h("button.btn.btn-sm", {
        type: "button",
        onclick: () => cmd({ kind: "session.start", sessionId: a.sessionId }, { ok: "已推进：核心会先收掉上一次的尾巴" }),
      }, "推进恢复")));
  }

  if (!a.items || !a.items.length) {
    body.append(h("p.cue-lost", "问题原文取不回来（核心重启过，或模型给的参数解不出）。不编一个问题出来——作废它，让模型重新问。"));
    card.append(h("footer.cue-f",
      h("span.sp"),
      h("button.btn.btn-danger.btn-sm", { type: "button", onclick: () => send("cancel") }, "作废这次询问")));
    return card;
  }

  for (const it of a.items) body.append(itemView(it, state, isPerm));

  if (isPerm) {
    const rem = (a.remember || []).map((r) => String(r).toLowerCase());
    if (rem.length) {
      const group = h("fieldset.cue-remember", h("legend", "记住这个决定"));
      const opt = (v, label, hint) => h("label.radio",
        h("input", { type: "radio", name: "rem-" + a.askId, value: v, checked: v === "", onchange: () => { state.remember = v; } }),
        h("span", h("b", label), hint ? h("small", hint) : null));
      group.append(opt("", "只这一次"));
      if (rem.includes("args")) group.append(opt("args", "同样的参数不再问", "参数逐字相同时放行"));
      if (rem.includes("tool")) group.append(opt("tool", "本会话内不再问任何 " + (a.toolName || "此工具") + " 调用", "粗档：任何参数都放行"));
      body.append(group);
    }
    const reason = h("input.inp.cue-reason", { placeholder: "拒绝理由（可选，模型会看到）", "aria-label": "拒绝理由" });
    body.append(reason);
    card.append(h("footer.cue-f",
      h("button.btn.btn-ghost.btn-sm", { type: "button", title: "作废这次询问，落拒绝结果，不续跑", onclick: () => send("cancel") }, "作废"),
      h("button.btn.btn-ghost.btn-sm.cue-modify", { type: "button", hidden: true, title: "只告诉模型参数被改了，但不批准、不续跑", onclick: () => send("modify") }, "改了但不批"),
      h("span.sp"),
      h("button.btn.btn-danger.btn-sm", { type: "button", onclick: () => send("submit", "deny", reason.value) }, "拒绝"),
      h("button.btn.btn-ok", { type: "submit" }, h("span", { "aria-hidden": "true" }, "▶"), state.edited != null ? "批准改写后的参数" : "批准执行")));
  } else {
    card.append(h("footer.cue-f",
      h("button.btn.btn-ghost.btn-sm", { type: "button", onclick: () => send("cancel") }, "不回答，作废"),
      h("span.sp"),
      h("button.btn.btn-primary", { type: "submit" }, "交出答案")));
  }

  card.addEventListener("submit", (e) => { e.preventDefault(); send("submit", isPerm ? "allow" : null); });
  card.addEventListener("cadenza:edited", () => {
    const m = card.querySelector(".cue-modify");
    if (m) m.hidden = state.edited == null;
    const ok = card.querySelector(".btn-ok");
    if (ok) ok.lastChild.textContent = state.edited != null ? "批准改写后的参数" : "批准执行";
  });

  let busy = false;
  async function send(outcome, decision, reason) {
    if (busy) return;
    busy = true;
    card.classList.add("sending");
    const answers = { ...state.answers };
    if (isPerm) {
      if (decision) answers.decision = decision;
      if (state.edited != null) answers.arguments = state.edited;
      if (reason) answers.reason = reason;
    }
    const payload = { kind: "approval.respond", sessionId: a.sessionId, askId: a.askId, outcome };
    if (Object.keys(answers).length) payload.answers = answers;
    if (isPerm && outcome === "submit" && decision === "allow" && state.remember) payload.remember = state.remember;
    const label = outcome === "cancel" ? "已作废" : outcome === "modify" ? "已告知改动（未批准）" : isPerm ? (decision === "allow" ? "已批准" : "已拒绝") : "答案已交出";
    const ack = await cmd(payload, { ok: label });
    busy = false;
    card.classList.remove("sending");
    if (ack.accepted) {
      clearInterval(tick);
      card.classList.add("resolved");
      app.approvals.delete(a.askId);
      // Same shared row as everyone else: not waiting any more. If the answer resumes the model,
      // step.begin flips it to Running; the refresh catches the case where nothing follows.
      const r = app.sessions.get(a.sessionId);
      if (r?.ask?.askId === a.askId) markLocal(a.sessionId, { ask: null, status: r.status === "WaitingForInput" ? "Idle" : r.status });
      scheduleRefresh(800);
      app.bus.emit("approvals");
      opts.onDone?.(outcome);
    }
  }

  return card;
}

function itemView(it, state, isPerm) {
  const q = h("div.cue-q-text.md", { html: md(it.question || "") });
  const wrap = h("div.cue-item", { dataset: { shape: it.shape } }, q);
  const set = (v) => { state.answers[it.id] = v; };

  if (it.shape === "choice") {
    const opts = it.options || [];
    const box = h("div.cue-opts", { role: it.multi ? "group" : "radiogroup", "aria-label": it.question });
    const picked = new Set();
    for (const o of opts) {
      const inp = h("input", { type: it.multi ? "checkbox" : "radio", name: "q-" + it.id, value: o.value });
      inp.addEventListener("change", () => {
        if (it.multi) { inp.checked ? picked.add(o.label || o.value) : picked.delete(o.label || o.value); set([...picked].join("、")); }
        else set(o.label || o.value);
      });
      box.append(h("label.opt", inp, h("span", o.label || o.value)));
    }
    wrap.append(box);
    if (it.multi) wrap.append(h("div.hint.dim", "可多选"));
  } else if (it.shape === "text") {
    const t = h("textarea.txt.cue-text", { rows: 2, placeholder: "写下回答…", "aria-label": it.question });
    if (it.value) { t.value = it.value; set(it.value); }
    t.addEventListener("input", () => set(t.value));
    wrap.append(t);
  } else if (it.shape === "form") {
    const vals = {};
    const sync = () => set((it.fields || []).map((f) => `${f.label || f.name}: ${vals[f.name] ?? ""}`).join("\n"));
    const grid = h("div.cue-form");
    for (const f of it.fields || []) {
      vals[f.name] = f.value ?? "";
      const inp = h("input.inp", { value: f.value ?? "", "aria-label": f.label || f.name });
      inp.addEventListener("input", () => { vals[f.name] = inp.value; sync(); });
      grid.append(h("label.field", h("span", f.label || f.name), inp));
    }
    sync();
    wrap.append(grid);
  } else if (it.shape === "verbatim") {
    const f = (it.fields || [])[0] || { name: "arguments", value: "" };
    const original = f.value ?? "";
    const ta = h("textarea.txt.cue-verbatim", { rows: Math.min(14, Math.max(3, prettyJson(original).split("\n").length)), spellcheck: false, "aria-label": "参数原文（可改写）" });
    ta.value = original;
    const status = h("span.vb-status.dim", "参数原文 · 改写后会逐字成为执行参数");
    const reset = h("button.btn.btn-ghost.btn-sm", { type: "button", hidden: true, onclick: () => { ta.value = original; upd(); } }, "还原");
    const fmt = h("button.btn.btn-ghost.btn-sm", { type: "button", onclick: () => { try { ta.value = JSON.stringify(JSON.parse(ta.value), null, 2); upd(); } catch { toast("不是合法 JSON，没法格式化", "warn"); } } }, "格式化看看");
    const upd = () => {
      const changed = ta.value !== original;
      let valid = true;
      try { JSON.parse(ta.value); } catch { valid = false; }
      // Pure reformatting of the same JSON is not an edit worth sending.
      const same = valid && (() => { try { return JSON.stringify(JSON.parse(ta.value)) === JSON.stringify(JSON.parse(original)); } catch { return false; } })();
      state.edited = changed && !same ? ta.value : null;
      reset.hidden = !changed;
      ta.classList.toggle("invalid", !valid);
      status.textContent = !valid ? "⚠ 不是合法 JSON——照样会逐字发出" : state.edited != null ? "已改写 · 批准将用改写后的参数执行" : "参数原文 · 改写后会逐字成为执行参数";
      status.className = "vb-status " + (!valid ? "warn" : state.edited != null ? "brass" : "dim");
      ta.closest("form")?.dispatchEvent(new CustomEvent("cadenza:edited"));
    };
    ta.addEventListener("input", upd);
    wrap.append(ta, h("div.vb-bar", status, h("span.sp"), fmt, reset));
    if (isPerm) { /* decision lives on the card buttons */ }
  }
  return wrap;
}
