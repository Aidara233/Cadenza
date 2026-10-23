// Cadenza · timeline — one session's history (paged) merged with live events, idempotent.
import { h, fmtTime, fmtAgo, copy } from "./util.js";
import { renderBlock, attachResult, toolUseBlock } from "./blocks.js";
import { bindCodeCopy } from "./md.js";

/**
 * Keys:  message -> "m:"+historyId     toolResult -> "r:"+id     release -> "l:"+id
 * Live messages without historyId cannot be deduped; they are rendered once and never replayed.
 */
export class Timeline {
  constructor(sessionId, core, root) {
    this.id = sessionId;
    this.core = core;
    this.root = root;
    this.seen = new Set();
    this.cards = new Map();        // callId -> toolcall <details>
    this.orphans = new Map();      // callId -> result waiting for its call (older page)
    this.cursor = null;
    this.hasMore = false;
    this.loading = false;
    this.count = 0;
    this.list = h("ol.tl-list", { role: "list" });
    this.top = h("li.tl-top", h("button.btn.btn-ghost.btn-sm", { type: "button", onclick: () => this.older() }, "更早的乐章"));
    this.top.hidden = true;
    this.list.append(this.top);
    root.replaceChildren(this.list);
    bindCodeCopy(root, copy);
    this.io = new IntersectionObserver((es) => {
      if (es.some((e) => e.isIntersecting) && this.hasMore && !this.loading) this.older();
    }, { root, rootMargin: "300px 0px 0px 0px" });
    this.io.observe(this.top);
  }

  dispose() { this.io.disconnect(); }

  async first() {
    this.loading = true;
    try {
      const page = await this.core.get(`/sessions/${encodeURIComponent(this.id)}/history?limit=50`);
      const frag = document.createDocumentFragment();
      for (const it of page.rendered) this._item(it, frag);
      this.list.append(frag);
      this._page(page);
      this.scrollEnd(true);
      return page;
    } finally { this.loading = false; }
  }

  async older() {
    if (!this.hasMore || this.loading) return;
    this.loading = true;
    this.top.classList.add("loading");
    try {
      const page = await this.core.get(`/sessions/${encodeURIComponent(this.id)}/history?limit=50&before=${encodeURIComponent(this.cursor)}`);
      const before = this.root.scrollHeight - this.root.scrollTop;
      const frag = document.createDocumentFragment();
      for (const it of page.rendered) this._item(it, frag);
      this.top.after(frag);
      this.root.scrollTop = this.root.scrollHeight - before;
      this._page(page);
    } catch (e) {
      this.top.querySelector("button").textContent = "加载失败，点此重试";
    } finally {
      this.loading = false;
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
    const body = h("div.msg-body");
    for (const b of blocks || []) {
      try {
        if (b.kind === "toolUse") {
          const card = toolUseBlock(b);
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
          h("button.icon-btn.msg-copy", { type: "button", "aria-label": "复制这条", onclick: () => copy(plain(blocks)) }, "⧉")),
        body));
    this._put(li, into);
    return li;
  }

  _result(r, into = this.list) {
    const key = r.id && "r:" + r.id;
    if (key) { if (this.seen.has(key)) return; this.seen.add(key); }
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

  atEnd() { const r = this.root; return r.scrollHeight - r.scrollTop - r.clientHeight < 80; }
  scrollEnd(instant = false) {
    requestAnimationFrame(() => this.root.scrollTo({ top: this.root.scrollHeight, behavior: instant ? "auto" : "smooth" }));
  }
}

function plain(blocks) {
  return (blocks || []).map((b) => b.kind === "text" ? b.text : b.kind === "toolUse" ? `[${b.name} ${b.arguments}]` : "").filter(Boolean).join("\n\n");
}
