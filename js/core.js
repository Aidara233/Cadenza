// Cadenza · core — HTTP snapshots + one WebSocket. No business logic here.
import { Emitter, uid, store } from "./util.js";

export class HttpError extends Error {
  constructor(status, body, path) {
    super(body?.error || `HTTP ${status} · ${path}`);
    this.status = status; this.body = body; this.path = path;
  }
}

/** Resolve the core base URL: ?core= > saved > /config.json > default. */
export async function resolveCoreBase() {
  const q = new URLSearchParams(location.search).get("core");
  if (q) { store.set("core", q); return q.replace(/\/+$/, ""); }
  const saved = store.get("core");
  if (saved) return saved;
  try {
    const r = await fetch("config.json", { cache: "no-store" });
    if (r.ok) { const j = await r.json(); if (j.core) return j.core.replace(/\/+$/, ""); }
  } catch { /* static host without config.json */ }
  return "http://127.0.0.1:17988";
}

/**
 * Events emitted:
 *  status(state, detail)        "connecting" | "open" | "closed" | "origin"
 *  frame(dir, frame, at)        every WS frame in/out (for the Score view)
 *  event(payload, topic, seq)   kind=event frames, unwrapped
 *  resync(topic)                subscription went deaf — caller must re-snapshot and resubscribe
 *  reconnected()                socket came back after a drop
 */
export class Core extends Emitter {
  constructor(base) {
    super();
    this.base = base;
    this.ws = null;
    this.state = "closed";
    this.info = null;
    this.topics = new Map();    // topic -> { seq: number|null }
    this.pending = new Map();   // command id -> { resolve, timer, payload }
    this.backoff = 600;
    this.everOpened = false;
    this.stats = { in: 0, out: 0 };
  }

  get wsUrl() { return this.base.replace(/^http/, "ws") + "/ws"; }

  async get(path) {
    let r;
    try { r = await fetch(this.base + path, { cache: "no-store" }); }
    catch (e) { throw new HttpError(0, { error: "核心没应答：" + e.message }, path); }
    let body = null;
    const text = await r.text();
    if (text) { try { body = JSON.parse(text); } catch { body = { error: text }; } }
    if (!r.ok) throw new HttpError(r.status, body, path);
    return body;
  }

  /** PUT a JSON body. Non-2xx throws HttpError; body.error is the core's human-readable reason. */
  async put(path, body) {
    let r;
    try {
      r = await fetch(this.base + path, {
        method: "PUT", cache: "no-store",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
    } catch (e) { throw new HttpError(0, { error: "核心没应答：" + e.message }, path); }
    let data = null;
    const text = await r.text();
    if (text) { try { data = JSON.parse(text); } catch { data = { error: text }; } }
    if (!r.ok) throw new HttpError(r.status, data, path);
    return data;
  }

  /** DELETE without a body. Non-2xx throws HttpError carrying the core's `error`. */
  async del(path) {
    let r;
    try { r = await fetch(this.base + path, { method: "DELETE", cache: "no-store" }); }
    catch (e) { throw new HttpError(0, { error: "核心没应答：" + e.message }, path); }
    let data = null;
    const text = await r.text();
    if (text) { try { data = JSON.parse(text); } catch { data = { error: text }; } }
    if (!r.ok) throw new HttpError(r.status, data, path);
    return data;
  }

  async probe() {
    try {
      this.info = await this.get("/info");
      return this.info;
    } catch { this.info = null; return null; }
  }

  originMismatch() {
    return this.info && this.info.allowedOrigin && this.info.allowedOrigin !== location.origin;
  }

  connect() {
    clearTimeout(this._retry);
    if (this.ws && this.ws.readyState <= 1) return;
    this._setState("connecting");
    let ws;
    try { ws = new WebSocket(this.wsUrl); } catch (e) { this._scheduleRetry(); return; }
    this.ws = ws;
    ws.onopen = () => {
      const again = this.everOpened;
      this.everOpened = true;
      this.backoff = 600;
      this._setState("open");
      for (const [topic, t] of this.topics) this._sendSub(topic, t.seq);
      if (again) this.emit("reconnected");
    };
    ws.onmessage = (m) => this._onMessage(m.data);
    ws.onclose = async () => {
      if (this.ws !== ws) return;
      this.ws = null;
      for (const [, p] of this.pending) { clearTimeout(p.timer); p.resolve({ accepted: false, reason: "连接断了，回执没回来（命令可能已执行）", lost: true }); }
      this.pending.clear();
      await this.probe();
      this._setState(this.originMismatch() ? "origin" : "closed");
      this._scheduleRetry();
    };
  }

  _scheduleRetry() {
    clearTimeout(this._retry);
    this._retry = setTimeout(() => this.connect(), this.backoff);
    this.backoff = Math.min(this.backoff * 1.7, 8000);
  }

  _setState(s) { this.state = s; this.emit("status", s); }

  _raw(frame) {
    if (!this.ws || this.ws.readyState !== 1) return false;
    this.ws.send(JSON.stringify(frame));
    this.stats.out++;
    this.emit("frame", "out", frame, Date.now());
    return true;
  }

  _onMessage(data) {
    let f;
    try { f = JSON.parse(data); } catch { return; }
    this.stats.in++;
    this.emit("frame", "in", f, Date.now());
    if (f.kind === "event") {
      const t = this.topics.get(f.topic);
      if (t && typeof f.seq === "number") t.seq = Math.max(t.seq ?? 0, f.seq);
      this.emit("event", f.payload, f.topic, f.seq);
    } else if (f.kind === "ack") {
      const p = this.pending.get(f.id);
      if (p) { clearTimeout(p.timer); this.pending.delete(f.id); p.resolve(f); }
      else if (f.id === "?") this.emit("badframe", f);
    } else if (f.kind === "resync_required") {
      const t = this.topics.get(f.topic);
      if (t) t.seq = null;
      this.emit("resync", f.topic);
    }
  }

  /** since: number = replay after that seq; undefined = from now on. Re-subscribing replaces. */
  subscribe(topic, since) {
    const seq = typeof since === "number" ? since : (this.topics.get(topic)?.seq ?? null);
    this.topics.set(topic, { seq });
    this._sendSub(topic, seq);
  }

  _sendSub(topic, seq) {
    const f = { kind: "subscribe", topic };
    if (typeof seq === "number") f.since = seq;
    this._raw(f);
  }

  unsubscribe(topic) {
    if (!this.topics.delete(topic)) return;
    this._raw({ kind: "unsubscribe", topic });
  }

  /** Send a command; resolves with the ack. accepted:true is NOT business success. */
  command(payload, timeoutMs) {
    const id = uid("c");
    return new Promise((resolve) => {
      if (!this._raw({ kind: "command", id, payload })) {
        resolve({ id, accepted: false, reason: "没连上核心，命令没发出去", lost: true });
        return;
      }
      const ms = timeoutMs ?? (payload.kind === "provider.test" || payload.kind === "network.test"
        || payload.kind === "shell.test" ? 25000 : 15000);
      const timer = setTimeout(() => {
        this.pending.delete(id);
        resolve({ id, accepted: false, reason: "回执超时（命令可能已执行）", lost: true });
      }, ms);
      this.pending.set(id, { resolve, timer, payload });
    });
  }

  /** Raw frame for the console (no ack bookkeeping beyond what the frame carries). */
  sendRaw(frame) { return this._raw(frame); }
}

/** ProjectKey.FromPath, reproduced: sha256(lowercase full path without trailing separators)[..16]. */
export async function projectKeyOf(dir) {
  if (!dir || !crypto?.subtle) return null;
  const norm = dir.replace(/[\\/]+$/, "").toLowerCase();
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(norm));
  return Array.from(new Uint8Array(buf)).map((b) => b.toString(16).padStart(2, "0")).join("").slice(0, 16);
}
