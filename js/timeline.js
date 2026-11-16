// Cadenza · timeline — one session's history (paged) merged with live events, idempotent.
import { h, fmtTime, fmtAgo, copy } from "./util.js";
import { renderBlock, attachResult, toolUseBlock } from "./blocks.js";
import { bindCodeCopy } from "./md.js";
import { mark, tag, spin } from "./watchdog.js";

/** 浮动上下文不是「干活」，是模型这一步能看见什么：核心每步合成一对调用 + 结果。
 *  时间线上一律不画（否则每步都多一张 ≈ 卡片，真正的工具调用被埋掉）；调音台 · 槽位仍有它的全文。
 *  两个判据：工具名，以及核心给合成调用用的 `floating-` 前缀——结果块里只有 callId，没有工具名。 */
const isFloating = (callId, name) => name === "floating_context" || String(callId ?? "").startsWith("floating-");

/** 页面上最多留多少条（`_trim`）。⚠️ 这是**渲染色天花板**，不是审美：停摆记录里只有这个数一直在长。 */
const MAX_ITEMS = 400;

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
    // 工具结果里带 `job-…` 时那条「在任务面板里打开」的按钮走这里（舞台把它接到调音台）。
    this.onJob = null;
    this.resultOpts = { onJob: (jobId) => { if (typeof this.onJob === "function") this.onJob(jobId); } };
    this.seen = new Set();
    // 藏掉浮动上下文的 callId（见 isFloating）：它的结果晚些到、或落在别的分页上时，也照样不画。
    this.floating = new Set();
    this.cards = new Map();        // callId -> toolcall <details>
    this.orphans = new Map();      // callId -> result waiting for its call (older page)
    // 实时路径上「结果先到、调用还没落盘」（核心 2026-11-05 起：跑完一条报一条，而模型消息
    // 在**步末**才落盘）⇒ 这两张表必须分开：上面那张等的是**更早那页**（它永远不会来），
    // 这张等的是**下一步末**（马上就来）。合成一张就没法在步末分辨「该画成孤儿了吗」。
    this.parked = new Map();       // callId -> result（等它那条模型消息）
    this.running = null;           // 「执行中」那一行（tool.call.started）：{ turn, el, body, cards, stick }
    this.cursor = null;
    this.hasMore = false;
    this.loading = false;
    this.count = 0;
    // 缓存用：这条会话已经画到哪个 WS seq（history 的 highWater / 事件的 seq）。
    // 切回来时从它之后补发，才不会漏掉离开期间的事件；null = 未知，退回快照 highWater。
    this.lastSeq = null;
    this.savedScrollTop = null;
    this.savedAtEnd = true;
    // 流式增量的临时气泡（`term.delta`，核心 2026-11）。**它不是事实**，见 applyDelta。
    this.live = null;
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
    // 增量只在「正看着」时有意义；缓存着的那一份不该带着一段半截正文（切回来时
    // 权威事实是 `message.appended` / 历史，而不是这半个气泡）。
    this.clearLive();
    // 同理：「执行中」那行也是**眼下**的形态。缓存里的会话不该钉着一张「执行中」的卡
    // ——切回来时那张卡要么早就配上了结果（模型消息里），要么那条调用压根没落盘。
    this.clearRunning();
    this.savedAtEnd = this.atEnd();
    this.savedScrollTop = this.root.scrollTop;
    this.list.remove();
    this.root = null;
  }

  dispose() {
    this.clearLive();
    this.clearRunning();
    this.list.remove();
    this.root = null;
  }

  async first() {
    this.loading = true;
    // 重新拉历史会把时间线整个换掉 ⇒ 临时气泡的引用也必须清（否则后续增量会往一个
    // **已经不在树上**的节点里写，页面上看起来就是「流式没了」，而它其实还在往内存里堆）。
    this.clearLive();
    this.clearRunning();
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
    if (it.kind === "message") return this._message({ from: it.from, blocks: it.blocks, at: it.at, key: it.id && "m:" + it.id }, into);    if (it.kind === "toolResult") return this._result({ id: it.id, callId: it.callId, blocks: it.blocks, at: it.at }, into);
    if (it.kind === "release") return this._release(it, into);
  }

  _message({ from, blocks, at, key }, into = this.list) {
    // ⚠️ 最终消息到了 ⇒ 临时气泡作废（同一段话的两种形态，留着就是屏幕上两遍）。
    // 只对**模型**消息、且只对实时那条路（`into === this.list`）生效：历史分页里没有流式这回事。
    if (from !== "user" && into === this.list) { this.clearLive(); this.clearRunning(); }
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
        this.parked.delete(b.callId);
        hid = true;
        continue;
      }
      shown.push(b);
    }
    if (hid && !shown.length) return;
    const body = h("div.msg-body");
    for (let bi = 0; bi < shown.length; bi++) {
      const b = shown[bi];
      try {
        spin("tl:block", bi);
        if (b.kind === "toolUse") {
          const card = toolUseBlock(b, { openSession: this.openSession });
          this.cards.set(b.callId, card);
          // 结果可能**已经**到了：实时那条路（`parked`，结果早于模型消息）或更早那页（`orphans`）。
          // ⚠️ 两处都要看——只看一处，另一处的输出就永远贴不上来（卡片停在「等结果…」）。
          const early = this.parked.get(b.callId) || this.orphans.get(b.callId);
          this.parked.delete(b.callId);
          this.orphans.delete(b.callId);
          if (early) attachResult(card, early, this.resultOpts);
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
    if (card) { attachResult(card, r, this.resultOpts); return; }
    // Result whose call is on an older page — park it (that page is never coming back through
    // paging, but the call may still show up in a re-fetch; keeping it is honest, drawing it is not).
    if (into !== this.list) { this.orphans.set(r.callId, r); return; }
    // ⚠️ **运行中，结果常常比它那条模型消息先到**（核心 2026-11-05 起：跑完一条报一条，
    // 而 `tool_use` 所在的模型消息在**步末**才落盘）。这时绝不能就地画一张「调用不在视野内」：
    // 它会被追加在**上一条消息**后面，看起来就像「这次调用的结果属于上一条消息」——
    // 而真正那张卡还在新消息里转着「等结果…」。
    // ⇒ 停在 `parked`，先贴到「执行中」的临时卡上（让人先看见输出），等模型消息到了再贴到正经卡上。
    const running = this.running?.cards.get(r.callId);
    if (running) attachResult(running, r, this.resultOpts);
    this.parked.set(r.callId, r);
  }

  /** 步收尾：临时「执行中」那行作废；停在 `parked` 里、到这一步结束仍没等到调用的结果，
   *  就地画出来——那说明那条 `tool_use` 压根没落盘（跑到一半被打断就是这条），
   *  「调用不在视野内」正是事实。⚠️ 只在步边界叫它：早叫会把还在路上的模型消息判成孤儿。 */
  settleRunning() {
    this.clearRunning();
    if (!this.parked.size) return;
    const rest = [...this.parked];
    this.parked.clear();
    for (const [callId, r] of rest) {
      const stray = toolUseBlock({ callId, name: "（调用不在视野内）", arguments: "{}" });
      attachResult(stray, r, this.resultOpts);
      this._put(h("li.msg.from-tool", h("div.msg-gutter"), h("div.msg-main", stray)), this.list);
    }
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
      this._trim();
      if (stick) this.scrollEnd();
    } else { into.append(li); this.count++; }
  }

  /**
   * 页面上最多留 `MAX_ITEMS` 条，更早的从 DOM 里摘掉。
   *
   * ⚠️ 为什么要有这一条（2026-11-15）：每次停摆记录里**唯一一直在长大的数字**就是它——
   * 时间线 36 → 72 → 119 → 160 条，节点 1850 → 3223 → 7405 → 9799。而停摆的形态是
   * 「JS 已经退栈（`Z:task` 打过了），主线程却再没回来」，也就是**渲染步骤**里出不来。
   * 渲染的代价只跟 DOM 有多大有关，所以这里给它一个天花板：`content-visibility` 能跳过看不见的，
   * 但滚动容器的**高度账**（`scrollHeight` / 锚定 / 布局失效）仍然按整棵树算。
   *
   * 摘掉的条目的去重键一起删掉：这样「加载更早的消息」翻回去时，它们还能重新出现
   * （不给答案撒谎：事实在核心那边，删的只是这一页的 DOM）。
   */
  _trim() {
    if (!this.trimNote) {
      this.trimNote = h("li.tl-trim.dim");
      this.trimNote.hidden = true;
      this.top.after(this.trimNote);
    }
    let n = this.list.children.length - 2;   // 减去 `.tl-top` 与这条提示
    let dropped = 0;
    // ⚠️ 从**提示条之后**开始摘，不能从 `.tl-top.nextElementSibling` 开始——那正好是提示条自己，
    // 第一轮就会 `break`（第一版就是这么写的，探针里 900 条一条没摘掉）。
    const firstContent = () => {
      const from = this.trimNote?.parentElement === this.list ? this.trimNote : this.top;
      return from.nextElementSibling;
    };
    while (n > MAX_ITEMS) {
      const victim = firstContent();
      if (!victim || victim === this.top) break;
      if (victim.dataset?.key) this.seen.delete(victim.dataset.key);
      victim.remove();
      n--; dropped++;
    }
    if (!dropped) return;
    this.trimDropped = (this.trimDropped || 0) + dropped;
    // 卡片表里那些已经不在树上的条目一并清掉（否则结果还会往一个看不见的节点里贴）。
    for (const [callId, el] of this.cards) if (!el.isConnected) this.cards.delete(callId);
    for (const callId of [...this.orphans.keys()]) if (!this.cards.has(callId)) this.orphans.delete(callId);
    this.trimNote.hidden = false;
    this.trimNote.textContent = `更早的 ${this.trimDropped} 条不在页面上（页面只留最近 ${MAX_ITEMS} 条）；要往回看用上面的「加载更早的消息」`;
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

  // ---------- 流式增量（`term.delta`，核心 2026-11）----------
  //
  // ⚠️ **临时气泡不是事实**：核心在步末仍会发 `message.appended`，那一条才是权威；这里画的
  // 只是「模型正在说」的样子，见到最终消息就**整块丢掉**。所以少画一段、多画一段都不影响
  // 记录——这些帧核心也**不保留、不补发**（`Publish(retained:false)`），断线重连拿不到它们。
  // ⚠️ 因此它**不进 `seen`**（去重键是 historyId，临时气泡没有身份）、也**不碰 `count`**
  // （那一个是「有没有内容」的判据，临时气泡不该把它永久抬高）。
  applyDelta(p) {
    // 没挂在舞台上（缓存着的会话）：不画。切回来时以最终消息 / 历史为准。
    if (!this.root) return;

    if (!this.live || this.live.turn !== p.turn) {
      this.clearLive();
      this.list.querySelector(".tl-empty")?.remove();
      const body = h("div.msg-body");
      const li = h("li.msg.from-model.live", { dataset: { live: "1" } },
        h("div.msg-gutter", { "aria-hidden": "true" }, h("span.msg-clef", "𝄢")),
        h("div.msg-main",
          h("div.msg-meta", h("span.msg-who", "Lilara"), h("span.dim.live-now", "正在说…")),
          body));
      const stick = this.atEnd();
      this.list.append(li);
      this.live = { turn: p.turn, el: li, body, parts: new Map(), stick, flush: 0 };
    }

    const kind = p.deltaKind === "reasoning" ? "reasoning" : "text";
    const key = `${p.blockIndex ?? 0}:${kind}`;
    let part = this.live.parts.get(key);
    if (!part) {
      // 一块一个 `<div>`：思考与正文分开（与最终气泡里「先想、再说」的次序一致）。
      part = h(`div.msg-text${kind === "reasoning" ? ".reasoning" : ""}`);
      this.live.body.append(part);
      this.live.parts.set(key, part);
    }
    part.__buf = (part.__buf || "") + (p.text || "");
    // ⚠️ **攒到下一帧只写一次 DOM、只读一次 `scrollHeight`**（2026-11-15 实测）：
    // 增量一秒几十条时，每条都 `textContent +=` 再读一次 `scrollHeight`（`atEnd()`）
    // 就是每条都逼一次整份布局，而**正在说的这一条恰好是唯一不会被 `content-visibility`
    // 跳过的**（它在视口里）。实测每次追加的代价随长度超线性上涨：
    //   200 KB 0.1ms · 1 MB 174ms · 3 MB 595ms · 6 MB 1472ms
    // 20 条/秒 ⇒ 主线程满负荷且永不结束（用户的体感是「模型一说话整个页面就死，刷新都没用」）。
    if (!this.live.flush) {
      this.live.flush = requestAnimationFrame(() => {
        const live = this.live;
        if (!live) return;                       // 气泡已被最终消息 / 步边界收走
        live.flush = 0;
        tag("R:live");
        for (const pt of live.parts.values()) if (pt.__buf != null) commitLiveText(pt);
        if (live.stick && this.atEnd()) this.scrollEnd(true);
      });
    }
  }

  // ---------- 「执行中」那一行（`tool.call.started`，核心 2026-11-05）----------
  //
  // ⚠️ 与 `live`（`term.delta`）**同一套纪律**：核心 `Publish(retained:false)`、重连不补发，
  // 而且它**没有对应的记录**（记录里那条 `tool_use` 在步末才随模型消息落盘）⇒ 只供显示：
  // 不进 `seen`、不碰 `count`，**步末的模型消息一到就整块丢掉**（那时才有事实）。
  // 它存在的唯一理由：一次跑五分钟的 `shell` 期间，时间线上不能一个字都没有。
  startToolCall(p) {
    // 没挂在舞台上（缓存着的会话）：不画。切回来时以模型消息 / 历史为准（同 applyDelta）。
    if (!this.root) return;
    if (isFloating(p.callId, p.name)) return;
    if (!this.running || this.running.turn !== p.turn) {
      this.clearRunning();
      this.list.querySelector(".tl-empty")?.remove();
      const body = h("div.msg-body");
      const li = h("li.msg.from-model.live.tools",
        h("div.msg-gutter", { "aria-hidden": "true" }, h("span.msg-clef", "𝄢")),
        h("div.msg-main",
          h("div.msg-meta", h("span.msg-who", "Lilara"), h("span.dim.live-now", "调用中…")),
          body));
      this.list.append(li);
      this.running = { turn: p.turn, el: li, body, cards: new Map(), stick: this.atEnd() };
    }
    const card = toolUseBlock({ callId: p.callId, name: p.name, arguments: p.arguments },
      { pendingText: "执行中…" });
    card.classList.add("running");
    this.running.body.append(card);
    this.running.cards.set(p.callId, card);
    // 结果若比调用先到（不该发生，但别把它藏起来）：先贴上，**同时留在 `parked`**——
    // 正经那张卡还得再贴一次，所以这里不能把它从表里摘掉。
    const early = this.parked.get(p.callId);
    if (early) attachResult(card, early, this.resultOpts);
    if (this.running.stick && this.atEnd()) this.scrollEnd(true);
  }

  /** 「执行中」那一行到此为止（模型消息 / 步起止 / 切走都会叫它）。 */
  clearRunning() {
    if (!this.running) return;
    this.running.el.remove();
    this.running = null;
    this._emptyState();
  }

  /** 这一段「正在说」到此为止（最终消息 / 步起止 / 出错 / 切走都会叫它）。 */
  clearLive() {
    if (!this.live) return;
    if (this.live.flush) { cancelAnimationFrame(this.live.flush); this.live.flush = 0; }
    this.live.el.remove();
    this.live = null;
  }

  // ---------- live events ----------
  apply(p) {
    mark("tl:" + p.kind);
    switch (p.kind) {
      case "message.appended":
        this._message({ from: p.from, blocks: p.blocks, at: p.at, key: p.historyId && "m:" + p.historyId });
        break;
      case "term.delta":
        this.applyDelta(p);
        break;
      // 「一条调用开始跑了」（核心 2026-11-05）：只供显示的临时卡，见 startToolCall。
      case "tool.call.started":
        this.startToolCall(p);
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
    // ⚠️ 这里**不再用 `behavior: "smooth"`**（2026-11-15）：内容还在长、列表又用了
    // `content-visibility: auto` 时，滚动动画每帧重读 `scrollHeight`、而高度又随渲染变化——
    // 那是又一条反馈回路。代价是贴底不能再靠动画兜住一次迟到的布局（实测会差 200 多 px），
    // 所以改成**两帧各钉一次**：第一帧钉到当下的底，下一帧把这一帧里长出来的部分补上。
    // `instant` 参数保留是为了不惊动调用点（现在两种都是瞬时）。
    const pin = () => { const r = this.root; if (r) r.scrollTop = r.scrollHeight; };
    requestAnimationFrame(() => {
      tag("R:scroll");
      pin();
      requestAnimationFrame(pin);
    });
  }
}

function plain(blocks) {
  return (blocks || []).map((b) => b.kind === "text" ? b.text : b.kind === "toolUse" ? `[${b.name} ${b.arguments}]` : "").filter(Boolean).join("\n\n");
}

// 「正在说」那一格最多留多少字。⚠️ 这不是审美：`textContent +=` 的代价随长度**超线性**涨
// （实测 200 KB 0.1ms/次，6 MB 1472ms/次），20 条/秒就能把主线程焊死。临时气泡本来就不是事实
// （步末 `message.appended` 整块换掉），所以这里只留**尾巴**——正在说的是尾巴，全文在落盘那条上。
const LIVE_MAX = 128 * 1024;

/** 把攒下的增量写进 DOM（一帧一次），超过上限就从头上丢，并留一句说明。 */
function commitLiveText(part) {
  let s = part.__buf || "";
  if (s.length > LIVE_MAX) {
    let cut = s.length - LIVE_MAX;
    const nl = s.indexOf("\n", cut);
    if (nl >= 0 && nl - cut < 4096) cut = nl + 1;     // 尽量从行首切，别把一行劈两半
    s = s.slice(cut);
    part.__buf = s;
    if (!part.__trimmed) {
      part.__trimmed = true;
      part.before(h("div.live-trim.dim", `前面已经有 ${Math.round(cut / 1024)}+ KB 了：这一格只跟着显示最后 128 KB（落盘后那条消息里是全文）。`));
    }
  }
  if (part.textContent !== s) part.textContent = s;
}
