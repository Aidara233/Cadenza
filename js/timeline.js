// Cadenza · timeline — one session's history (paged) merged with live events, idempotent.
import { h, fmtTime, fmtAgo, copy } from "./util.js";
import { renderBlock, attachResult, toolUseBlock } from "./blocks.js";
import { bindCodeCopy } from "./md.js";

/** 浮动上下文不是「干活」，是模型这一步能看见什么：核心每步合成一对调用 + 结果。
 *  时间线上一律不画（否则每步都多一张 ≈ 卡片，真正的工具调用被埋掉）；调音台 · 槽位仍有它的全文。
 *  两个判据：工具名，以及核心给合成调用用的 `floating-` 前缀——结果块里只有 callId，没有工具名。 */
const isFloating = (callId, name) => name === "floating_context" || String(callId ?? "").startsWith("floating-");

// 同一个滚动容器会被多条缓存时间线反复 attach；复制按钮的委托只绑一次，避免监听器越积越多。
const codeCopyRoots = new WeakSet();
function bindCodeCopyOnce(root) {
  if (codeCopyRoots.has(root)) return;
  codeCopyRoots.add(root);
  bindCodeCopy(root, copy);
}

/**
 * Keys:  message -> "m:"+historyId     toolResult -> "r:"+id     release -> "l:"+id
 * Live messages without historyId cannot be deduped; they are rendered once and never replayed.
 */
export class Timeline {
  constructor(sessionId, core, root = null) {
    this.id = sessionId;
    this.core = core;
    this.root = null;
    this.openSession = (id) => { if (typeof this.onOpenSession === "function") this.onOpenSession(id); };
    this.seen = new Set();
    // 藏掉浮动上下文的 callId（见 isFloating）：它的结果晚些到、或落在别的分页上时，也照样不画。
    this.floating = new Set();
    this.cards = new Map();        // callId -> toolcall <details>
    this.orphans = new Map();      // callId -> result waiting for its call (older page)
    this.cursor = null;
    this.hasMore = false;
    this.loading = false;
    this.count = 0;
    // 缓存用：这条会话已经画到哪个 WS seq（history 的 highWater / 事件的 seq）。
    // 切回来时从它之后补发，才不会漏掉离开期间的事件；null = 未知，退回快照 highWater。
    this.lastSeq = null;
    this.savedScrollTop = null;
    this.savedAtEnd = true;
    this.list = h("ol.tl-list", { role: "list" });
    this.moreButton = h("button.btn.btn-ghost.btn-sm", { type: "button", onclick: () => this.older() }, "加载更早的消息");
    this.top = h("li.tl-top", this.moreButton);
    this.top.hidden = true;
    this.list.append(this.top);
    if (root) this.attach(root);
  }

  /** 把（可能是缓存的）时间线挂回舞台。DOM 节点原样复用，不重建。 */
  attach(root) {
    this.root = root;
    root.replaceChildren(this.list);
    bindCodeCopyOnce(root);
    if (this.savedAtEnd) this.scrollEnd(true);
    else if (this.savedScrollTop != null) root.scrollTop = this.savedScrollTop;
  }

  /** 从舞台摘下但**不销毁**：缓存切回时直接挂回，省掉重新拉历史与重建 DOM。 */
  detach() {
    if (!this.root) return;
    this.savedAtEnd = this.atEnd();
    this.savedScrollTop = this.root.scrollTop;
    this.list.remove();
    this.root = null;
  }

  dispose() {
    this.list.remove();
    this.root = null;
  }

  async first() {
    this.loading = true;
    try {
      const page = await this.core.get(`/sessions/${encodeURIComponent(this.id)}/history?limit=20`);
      const frag = document.createDocumentFragment();
      for (const it of page.rendered) this._item(it, frag);
      this.list.append(frag);
      this._page(page);
      // /history 与 /state 一样带 highWater；以它作为缓存游标，切回来只补这之后的事件。
      if (typeof page.highWater === "number") this.lastSeq = Math.max(this.lastSeq ?? 0, page.highWater);
      this.scrollEnd(true);
      return page;
    } finally { this.loading = false; }
  }

  async older() {
    if (!this.hasMore || this.loading) return;
    this.loading = true;
    this.moreButton.disabled = true;
    this.moreButton.textContent = "正在加载…";
    this.top.classList.add("loading");
    try {
      const page = await this.core.get(`/sessions/${encodeURIComponent(this.id)}/history?limit=20&before=${encodeURIComponent(this.cursor)}`);
      // 这一页在飞的时候可能已经切走（detach 后 root 为空）；仍然把内容收进 list，缓存切回时可用。
      const root = this.root;
      const before = root ? root.scrollHeight - root.scrollTop : 0;
      const frag = document.createDocumentFragment();
      for (const it of page.rendered) this._item(it, frag);
      this.top.after(frag);
      if (root) root.scrollTop = root.scrollHeight - before;
      this._page(page);
    } catch (e) {
      this.moreButton.textContent = "加载失败，点此重试";
    } finally {
      this.loading = false;
      this.moreButton.disabled = false;
      this.moreButton.textContent = this.hasMore ? "加载更早的消息" : "已到最早";
      this.top.classList.remove("loading");
    }
  }

  _page(page) {
    this.hasMore = !!page.hasMore && !!page.nextCursor;
    this.cursor = page.nextCursor || null;
    this.top.hidden = !this.hasMore;
    if (!this.hasMore && !this.list.querySelector(".tl-origin")) {
      this.top.after(h("li.tl-origin", h("span.tlo-clef", { "aria-hidden": "true" }, "𝄞"), h("span", "序曲 · 会话从这里开始")));
    }
    this._emptyState();
  }

  _emptyState() {
    const has = this.count > 0;
    let e = this.list.querySelector(".tl-empty");
    if (has) { e?.remove(); return; }
    if (!e) this.list.append(h("li.tl-empty",
      h("div.tle-staff", { "aria-hidden": "true" }, h("i"), h("i"), h("i"), h("i"), h("i")),
      h("p", "休止符。"), h("p.dim", "写下第一句，乐章就开始了。")));
  }

  // ---------- history items ----------
  _item(it, into) {
    if (it.kind === "message") return this._message({ from: it.from, blocks: it.blocks, at: it.at, key: it.id && "m:" + it.id }, into);
    if (it.kind === "toolResult") return this._result({ id: it.id, callId: it.callId, blocks: it.blocks, at: it.at }, into);
    if (it.kind === "release") return this._release(it, into);
  }

  _message({ from, blocks, at, key }, into = this.list) {
    if (key) { if (this.seen.has(key)) return; this.seen.add(key); }
    const isUser = from === "user";
    // 先摘掉浮动上下文：核心常常让它单独成一条消息，摘完就没内容了 —— 那种整条都不画，
    // 否则时间线上会留一串空气泡（有 meta、没正文）。
    let hid = false;
    const shown = [];
    for (const b of blocks || []) {
      if (b.kind === "toolUse" && isFloating(b.callId, b.name)) {
        this.floating.add(b.callId);
        this.orphans.delete(b.callId);   // 结果若先到并停在孤儿区，一起丢掉
        hid = true;
        continue;
      }
      shown.push(b);
    }
    if (hid && !shown.length) return;
    const body = h("div.msg-body");
    for (const b of shown) {
      try {
        if (b.kind === "toolUse") {
          const card = toolUseBlock(b, { openSession: this.openSession });
          this.cards.set(b.callId, card);
          const orphan = this.orphans.get(b.callId);
          if (orphan) { attachResult(card, orphan); this.orphans.delete(b.callId); }
          body.append(card);
        } else body.append(renderBlock(b));
      } catch (e) {
        // One unrenderable block must not take the whole session down — say so and keep the text.
        console.error("block render failed", b.kind, e);
        body.append(h("div.blk-err",
          h("div.eyebrow", "这一块渲染不了 · " + (b.kind || "?")),
          h("div", String(e?.message || e)),
          typeof b.text === "string" ? h("pre", b.text.slice(0, 2000)) : null,
          typeof b.arguments === "string" ? h("pre", b.arguments.slice(0, 2000)) : null));
      }
    }
    const li = h(`li.msg.${isUser ? "from-user" : "from-model"}`, { dataset: { key: key || "" } },
      h("div.msg-gutter", { "aria-hidden": "true" }, h("span.msg-clef", isUser ? "♩" : "𝄢")),
      h("div.msg-main",
        h("div.msg-meta",
          h("span.msg-who", isUser ? "你" : "Lilara"),
          h("time", { datetime: at || "", title: at ? fmtAgo(at) : "" }, fmtTime(at)),
          h("button.icon-btn.msg-copy", { type: "button", "aria-label": "复制这条", onclick: () => copy(plain(shown)) }, "⧉")),
        body));
    this._put(li, into);
    return li;
  }

  _result(r, into = this.list) {
    const key = r.id && "r:" + r.id;
    if (key) { if (this.seen.has(key)) return; this.seen.add(key); }
    // 浮动上下文的结果：调用已经被藏掉，或者这一页只拿到结果（callId 带 floating- 前缀）。
    // 不拦的话，前者会画成「调用不在视野内」的孤儿卡，后者也会凭空多一张。
    if (this.floating.has(r.callId) || isFloating(r.callId)) return;
    const card = this.cards.get(r.callId);
    if (card) { attachResult(card, r); return; }
    // Result whose call is on an older page (cannot happen with group paging, but be honest) — park it.
    if (into !== this.list) { this.orphans.set(r.callId, r); return; }
    const stray = toolUseBlock({ callId: r.callId, name: "（调用不在视野内）", arguments: "{}" });
    attachResult(stray, r);
    this._put(h("li.msg.from-tool", h("div.msg-gutter"), h("div.msg-main", stray)), into);
  }

  _release(it, into = this.list) {
    const key = "l:" + it.id;
    if (this.seen.has(key)) return;
    this.seen.add(key);
    this._put(h("li.note.note-release",
      h("span.note-glyph", { "aria-hidden": "true" }, "𝄂"),
      h("div",
        h("b", "双纵线 · 放下这一段"),
        it.summary ? h("div", it.summary) : null,
        (it.scope || []).length ? h("div.note-scope", ...(it.scope || []).map((s) => h("code", s))) : null),
      h("time", fmtTime(it.at))), into);
  }

  _put(li, into) {
    if (into === this.list) {
      const stick = this.atEnd();
      this.list.append(li);
      li.classList.add("fresh");
      this.count++;
      this._emptyState();
      if (stick) this.scrollEnd();
    } else { into.append(li); this.count++; }
  }

  /** System notation inline in the score (step markers, axis changes, errors…). */
  note(kind, content, at) {
    const glyph = { step: "𝄀", axis: "♮", spec: "♯", error: "𝄪", compact: "𝄐", reclaim: "𝄒", interrupt: "𝄽", ask: "𝄐", retry: "↻" }[kind] || "·";
    const li = h(`li.note.note-${kind}`,
      h("span.note-glyph", { "aria-hidden": "true" }, glyph),
      h("div", content),
      h("time", fmtTime(at || new Date().toISOString())));
    const stick = this.atEnd();
    this.list.append(li);
    li.classList.add("fresh");
    if (stick) this.scrollEnd();
    return li;
  }

  // ---------- live events ----------
  apply(p) {
    switch (p.kind) {
      case "message.appended":
        this._message({ from: p.from, blocks: p.blocks, at: p.at, key: p.historyId && "m:" + p.historyId });
        break;
      case "tool.result.appended":
        this._result({ id: p.id, callId: p.callId, blocks: p.blocks, at: p.at });
        break;
      case "release.recorded":
        this._release(p);
        break;
    }
  }

  atEnd() { const r = this.root; return !r || r.scrollHeight - r.scrollTop - r.clientHeight < 80; }
  scrollEnd(instant = false) {
    requestAnimationFrame(() => {
      const r = this.root;
      if (r) r.scrollTo({ top: r.scrollHeight, behavior: instant ? "auto" : "smooth" });
    });
  }
}

function plain(blocks) {
  return (blocks || []).map((b) => b.kind === "text" ? b.text : b.kind === "toolUse" ? `[${b.name} ${b.arguments}]` : "").filter(Boolean).join("\n\n");
}
