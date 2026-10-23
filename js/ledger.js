// Cadenza · ledger — token usage. null is NOT zero: unreported usage is shown as "—" and counted separately.
import { h, swap, fmtTokens, fmtNum, fmtTime, fmtDur, jsonBlock, modal, esc } from "./util.js";
import { app, titleOf, setCurrent } from "./model.js";

const L = { root: null, calls: [], total: 0, summary: null, loading: false, sel: null };
const PAGE = 1000;

export function mountLedger(root) {
  L.root = root;
  root.classList.add("ledger");
  swap(root, h("div.ledger-in", h("div.dim", "翻账簿中…")));
}

export async function ledgerShown() {
  if (L.loading) return;
  L.loading = true;
  try {
    const summary = await app.core.get("/usage/summary");
    const first = await app.core.get(`/usage/calls?skip=0&limit=${PAGE}`);
    let calls = first.calls;
    // Pull the tail if there are more than one page (keep the most recent PAGE*3).
    if (first.total > PAGE) {
      const skip = Math.max(0, first.total - PAGE * 3);
      calls = [];
      for (let s = skip; s < first.total; s += PAGE) calls.push(...(await app.core.get(`/usage/calls?skip=${s}&limit=${PAGE}`)).calls);
    }
    L.summary = summary; L.calls = calls; L.total = first.total;
    render();
  } catch (e) {
    swap(L.root, h("div.ledger-in", h("div.empty", h("div.glyph", "𝄪"), "读不到账本：" + e.message)));
  } finally { L.loading = false; }
}

function render() {
  const s = L.summary || {};
  const known = L.calls.filter((c) => c.usage);
  const failed = L.calls.filter((c) => c.status === "failed").length;
  // inputTokens is uncached input only (core d1c0895); full prompt = input + cacheRead.
  // Prefer the core's own hit rate: its denominator only counts calls that reported cache.
  const cacheRatio = s.cacheHitRate ?? (s.promptTokens ? (s.cacheHitTokens ?? 0) / s.promptTokens : null);
  const retried = L.calls.filter((c) => (c.attempt ?? 1) > 1).length;
  const durs = L.calls.filter((c) => c.endedAt).map((c) => new Date(c.endedAt) - new Date(c.startedAt)).filter((x) => x >= 0).sort((a, b) => a - b);
  const p50 = durs.length ? durs[Math.floor(durs.length / 2)] : null;

  swap(L.root, h("div.ledger-in",
    h("header.lg-h",
      h("div", h("div.eyebrow", "Ledger"), h("h2", "账簿")),
      h("span.sp"),
      h("span.dim", "token 账本 · 费用不在核心"),
      h("button.btn.btn-sm", { type: "button", onclick: () => ledgerShown() }, "↻ 重算")),
    h("div.lg-stats",
      stat("调用", fmtNum(s.calls), `${fmtNum(s.callsWithUnknownUsage ?? 0)} 次未报用量 · ${failed} 次失败${retried ? ` · ${retried} 次是重试` : ""}`),
      stat("未命中输入", fmtTokens(s.inputTokens), `${fmtNum(s.callsWithKnownInput ?? 0)} 次报了输入 · 全部输入 ${fmtTokens(s.promptTokens)}`, "brass"),
      stat("输出", fmtTokens(s.outputTokens), `推理 ${fmtTokens(s.reasoningTokens)}`, "sky"),
      stat("缓存命中", cacheRatio != null ? (cacheRatio * 100).toFixed(1) + "%" : "—", cacheRatio != null ? `读 ${fmtTokens(s.cacheReadTokens)} · ${fmtNum(s.callsWithKnownCache ?? 0)} 次报了缓存` : "没有一次报了缓存（不是 0%）", "green", cacheRatio),
      stat("中位耗时", p50 != null ? fmtDur(p50) : "—", `${durs.length} 次有结束时间`)),
    h("section.card.lg-chart", h("div.card-h", h("h3", "乐句 · 每次调用"), h("span.dim", `最近 ${Math.min(L.calls.length, 120)} 次 · 柱高 = 全部输入（绿 = 命中缓存），点 = 输出`), h("span.sp"), legend()), callsChart(L.calls.slice(-120))),
    h("div.lg-grid",
      h("section.card", h("div.card-h", h("h3", "日历"), h("span.dim", "按天堆叠：输入 / 缓存读 / 输出")), dailyChart(L.calls)),
      h("section.card", h("div.card-h", h("h3", "声部"), h("span.dim", "按模型")), breakdown(s.byModel || []), h("div.card-h.mt", h("h3", "乐团"), h("span.dim", "按提供商")), breakdown(s.byProvider || []))),
    h("section.card", h("div.card-h", h("h3", "明细"), h("span.dim", `共 ${fmtNum(L.total)} 条 · 显示最近 200`)), table(L.calls.slice(-200).reverse()))));
}

function stat(label, value, sub, tone = "", frac = null) {
  return h(`div.lg-stat${tone ? ".t-" + tone : ""}`,
    h("div.eyebrow", label),
    h("div.lg-v.num", value),
    h("div.lg-sub.dim", sub),
    frac != null ? h("div.lg-bar", h("i", { style: { width: Math.min(100, frac * 100) + "%" } })) : null);
}

function legend() {
  return h("div.legend", h("span.lg-k.in", "输入"), h("span.lg-k.cache", "缓存读"), h("span.lg-k.out", "输出"), h("span.lg-k.unk", "未报"));
}

const NS = "http://www.w3.org/2000/svg";
function svg(w, hgt, cls) {
  const s = document.createElementNS(NS, "svg");
  s.setAttribute("viewBox", `0 0 ${w} ${hgt}`);
  s.setAttribute("preserveAspectRatio", "none");
  s.setAttribute("class", cls);
  s.setAttribute("role", "img");
  return s;
}
function el(name, attrs, title) {
  const e = document.createElementNS(NS, name);
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v);
  if (title) { const t = document.createElementNS(NS, "title"); t.textContent = title; e.append(t); }
  return e;
}

function callsChart(calls) {
  const wrap = h("div.chart-wrap");
  if (!calls.length) return h("div.empty", "还没有调用");
  const W = 1000, H = 220, pad = 18;
  // Full prompt = uncached input + cache read (disjoint since core d1c0895).
  const prompt = (u) => (u.inputTokens ?? 0) + (u.cacheReadTokens ?? 0);
  const maxIn = Math.max(1, ...calls.map((c) => (c.usage ? prompt(c.usage) : 0)));
  const maxOut = Math.max(1, ...calls.map((c) => c.usage?.outputTokens ?? 0));
  const s = svg(W, H, "chart");
  s.setAttribute("aria-label", `${calls.length} 次调用的输入/输出 token`);
  for (let i = 1; i <= 4; i++) s.append(el("line", { x1: 0, x2: W, y1: pad + (H - pad * 2) * i / 4, y2: pad + (H - pad * 2) * i / 4, class: "grid" }));
  const bw = W / calls.length;
  const pts = [];
  calls.forEach((c, i) => {
    const x = i * bw;
    const u = c.usage;
    const title = `${fmtTime(c.startedAt, true)} · ${c.modelId} · ${c.purpose}${(c.attempt ?? 1) > 1 ? ` · 第 ${c.attempt} 次尝试` : ""}\n未命中 ${fmtNum(u?.inputTokens)} · 缓存读 ${fmtNum(u?.cacheReadTokens)} · 出 ${fmtNum(u?.outputTokens)}${c.status === "failed" ? "\n失败" + (c.error ? "：" + c.error : "") : ""}`;
    if (!u || u.inputTokens == null) {
      s.append(el("rect", { x: x + bw * .2, y: H - pad - 6, width: Math.max(1, bw * .6), height: 6, class: "b-unk" }, title));
      return;
    }
    const hIn = (H - pad * 2) * (prompt(u) / maxIn);
    const hCache = (H - pad * 2) * ((u.cacheReadTokens ?? 0) / maxIn);
    const g = el("g", { class: "bar" + (c.status === "failed" ? " failed" : "") });
    g.append(el("rect", { x: x + bw * .15, y: H - pad - hIn, width: Math.max(1, bw * .7), height: hIn, class: "b-in", rx: Math.min(3, bw * .2) }, title));
    if (hCache > 0) g.append(el("rect", { x: x + bw * .15, y: H - pad - hCache, width: Math.max(1, bw * .7), height: hCache, class: "b-cache" }));
    s.append(g);
    if (u.outputTokens != null) pts.push([x + bw / 2, H - pad - (H - pad * 2) * (u.outputTokens / maxOut) * .9]);
  });
  if (pts.length > 1) s.append(el("polyline", { points: pts.map((p) => p.join(",")).join(" "), class: "l-out" }));
  for (const [x, y] of pts) s.append(el("circle", { cx: x, cy: y, r: 2.6, class: "d-out" }));
  wrap.append(s, h("div.chart-axis", h("span", fmtTime(calls[0].startedAt, true)), h("span", "峰值输入 " + fmtTokens(maxIn) + " · 峰值输出 " + fmtTokens(maxOut)), h("span", fmtTime(calls[calls.length - 1].startedAt, true))));
  return wrap;
}

function dailyChart(calls) {
  const days = new Map();
  for (const c of calls) {
    const d = (c.startedAt || "").slice(0, 10);
    if (!d) continue;
    const x = days.get(d) || { d, in: 0, cache: 0, out: 0, n: 0, unk: 0 };
    x.n++;
    if (c.usage) { x.in += c.usage.inputTokens ?? 0; x.cache += c.usage.cacheReadTokens ?? 0; x.out += c.usage.outputTokens ?? 0; } else x.unk++;
    days.set(d, x);
  }
  const list = [...days.values()].sort((a, b) => a.d.localeCompare(b.d)).slice(-21);
  if (!list.length) return h("div.empty", "还没有调用");
  const max = Math.max(1, ...list.map((x) => x.in + x.cache + x.out));
  return h("div.days", ...list.map((x) => {
    const t = x.in + x.cache + x.out;
    const bar = h("div.day-bar", { title: `${x.d}\n${x.n} 次调用${x.unk ? `（${x.unk} 次未报）` : ""}\n未命中 ${fmtNum(x.in)} · 缓存读 ${fmtNum(x.cache)} · 出 ${fmtNum(x.out)}` },
      h("i.d-out", { style: { height: (x.out / max) * 100 + "%" } }),
      h("i.d-in", { style: { height: (x.in / max) * 100 + "%" } }),
      h("i.d-cache", { style: { height: (x.cache / max) * 100 + "%" } }));
    return h("div.day", bar, h("span.day-l.num", x.d.slice(5)), h("span.day-n.num.dim", fmtTokens(t)));
  }));
}

function breakdown(rows) {
  if (!rows.length) return h("div.dim", "—");
  const max = Math.max(1, ...rows.map((r) => (r.inputTokens ?? 0) + (r.outputTokens ?? 0)));
  return h("ul.bd", ...rows.map((r) => {
    const tot = (r.inputTokens ?? 0) + (r.outputTokens ?? 0);
    return h("li",
      h("div.bd-h", h("code", r.key), h("span.sp"), h("span.num", fmtTokens(r.inputTokens)), h("span.dim", " / "), h("span.num", fmtTokens(r.outputTokens)), h("span.dim.num", ` · ×${r.calls}`)),
      h("div.bd-bar", h("i.in", { style: { width: ((r.inputTokens ?? 0) / max) * 100 + "%" } }), h("i.out", { style: { width: ((r.outputTokens ?? 0) / max) * 100 + "%" } })),
      r.callsWithUnknownUsage ? h("div.dim.bd-unk", `${r.callsWithUnknownUsage} 次未报用量`) : null);
  }));
}

function table(calls) {
  if (!calls.length) return h("div.empty", "还没有调用");
  const tb = h("tbody");
  for (const c of calls) {
    const u = c.usage;
    const d = c.endedAt ? new Date(c.endedAt) - new Date(c.startedAt) : null;
    tb.append(h("tr" + (c.status === "failed" ? ".failed" : ""), { tabindex: 0, title: c.error || "", onclick: () => modal("调用 " + c.callId, jsonBlock(c), { wide: true }), onkeydown: (e) => { if (e.key === "Enter") e.currentTarget.click(); } },
      h("td.num", fmtTime(c.startedAt, true)),
      h("td", c.sessionId ? h("button.link", { type: "button", onclick: (e) => { e.stopPropagation(); setCurrent(c.sessionId); app.bus.emit("goto", "stage"); } }, titleOf(c.sessionId)) : h("span.dim", "—")),
      h("td", h(`span.chip${c.purpose === "session" ? "" : c.purpose === "compaction" ? ".plum" : ".sky"}`, c.purpose)),
      h("td.mono", c.modelId),
      h("td.num.r", u ? fmtNum(u.inputTokens) : h("span.dim", "—")),
      h("td.num.r", u ? fmtNum(u.cacheReadTokens) : h("span.dim", "—")),
      h("td.num.r", u ? fmtNum(u.outputTokens) : h("span.dim", "—")),
      h("td.num.r", d != null ? fmtDur(d) : h("span.dim", "—")),
      h("td", c.status === "failed" ? h("span.chip.red", "失败") : h("span.chip.green", "完成"),
        (c.attempt ?? 1) > 1 ? h("span.chip.brass.num", { title: "同一次调用的第几次真实请求" }, " 第" + c.attempt + "次") : null)));
  }
  return h("div.tbl-wrap", h("table.tbl",
    h("thead", h("tr", ...["时间", "会话", "用途", "模型", "未命中输入", "缓存读", "输出", "耗时", "状态"].map((t, i) => h("th" + (i >= 4 && i <= 7 ? ".r" : ""), t)))),
    tb));
}
