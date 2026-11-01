// Cadenza · core — HTTP snapshots + one WebSocket. No business logic here.
import { Emitter, uid, store } from "./util.js";

export class HttpError extends Error {
  constructor(status, body, path) {
    super(body?.error || `HTTP ${status} · ${path}`);
    this.status = status; this.body = body; this.path = path;
  }
}

// ---- 访问 token（核心 `LILARA_AUTH=1` 时才要；默认不校验）----
//
// ⚠️ 存在本机存储里而不是只放内存：刷新一次就要重新粘一遍 token，用户会很快把鉴权关回去。
// ⚠️ **交法是核心定死的，两条都得有**：HTTP 走 `Authorization: Bearer`，WebSocket 只能走查询参数
// ——浏览器的 `WebSocket` 构造函数**不能自定义请求头**，这不是我们的选择。
// ⚠️ token 是**明文**过局域网的（控制面就是明文 HTTP）：它拦的是「随手连上来的人」，
// 挡不住同一网段里的嗅探者。README 里那句代价要一直留着，别说成「上了鉴权就安全了」。
const TOKEN_KEY = "token";

/** ⚠️ 必须与核心 `ControlAuth.QueryParam` **逐字相同**——名字写错 = 握手被拒，而浏览器不会告诉你为什么。 */
export const TOKEN_PARAM = "token";

/** 本机存着的那份 token（没有就是空串）。 */
export function coreToken() {
  const v = store.get(TOKEN_KEY, "");
  return typeof v === "string" ? v.trim() : "";
}

/** 存/清 token（`""` = 清掉）。返回真正落下去的那个值。 */
export function setCoreToken(value) {
  const v = String(value ?? "").trim();
  if (v) store.set(TOKEN_KEY, v); else store.del(TOKEN_KEY);
  return v;
}

// ---- WS 白名单的判据 ----
//
// ⚠️ 这是核心 `OriginMatcher` 的**最小镜像**，不是第二份权威：核心 `2026-11-05` 起默认放行的是
// **模式** `http://*:<头端口>`（任意主机名/地址，端口钉死）。逐字相等在这里不是「保守」，
// 而是**错**——它会把一个完全正确的配置判成错配，于是每次断开都把状态落到「被拒握手」。
//
// ⚠️ 镜像只用来**说话**（横幅、后台的白名单卡），绝不参与「要不要发请求」这类决定：
// 真正的守卫在核心那边，这里判错最多是一句提示说错，不会把请求放过去。

/** 把 `scheme://host[:port]` 拆开；拆不出来返回 null。没有端口时按 scheme 的默认端口算。 */
function splitOrigin(value) {
  const sep = value.indexOf("://");
  if (sep <= 0) return null;

  const scheme = value.slice(0, sep).toLowerCase();
  let rest = value.slice(sep + 3);
  // origin 不带路径，但宽容一点：遇到 '/' 就截断（多接的那段不参与判据）。
  const slash = rest.indexOf("/");
  if (slash >= 0) rest = rest.slice(0, slash);
  if (!rest) return null;

  let host, portText;
  if (rest[0] === "[") {
    const close = rest.indexOf("]");
    if (close < 0) return null;
    host = rest.slice(1, close);
    const tail = rest.slice(close + 1);
    if (!tail) portText = "";
    else if (tail[0] === ":") portText = tail.slice(1);
    else return null;
  } else {
    const colon = rest.lastIndexOf(":");
    // 不带方括号又有多于一个 ':' ⇒ 是 IPv6 字面量，不猜。
    if (colon >= 0 && rest.indexOf(":") !== colon) return null;
    host = colon < 0 ? rest : rest.slice(0, colon);
    portText = colon < 0 ? "" : rest.slice(colon + 1);
  }
  if (!host) return null;

  let port;
  if (!portText) {
    port = scheme === "http" ? 80 : scheme === "https" ? 443 : -1;
    if (port < 0) return null;
  } else {
    if (!/^\d+$/.test(portText)) return null;
    port = Number(portText);
    if (!(port > 0 && port <= 65535)) return null;
  }
  return { scheme, host: host.toLowerCase(), port };
}

/**
 * 这个 origin 是否被这个模式接受。
 * ⚠️ 拆不出来时回落到**逐字相等**（大小写不敏感）——解析失败不许变成「放行」。
 */
export function originMatches(pattern, origin) {
  const p = String(pattern ?? "").trim();
  if (!p) return false;
  if (p === "*") return true;

  const o = String(origin ?? "").trim();
  if (!o) return false;

  const a = splitOrigin(p), b = splitOrigin(o);
  if (!a || !b) return p.toLowerCase() === o.toLowerCase();
  return a.scheme === b.scheme && a.port === b.port && (a.host === "*" || a.host === b.host);
}

/** 把模式说成人话（横幅要印它）——星号不解释就等于没印。 */
export function describeOrigin(pattern) {
  const p = String(pattern ?? "").trim();
  if (p === "*") return "任意 origin（调试用）";
  const a = splitOrigin(p);
  if (a && a.host === "*") return `任意主机，端口 ${a.port}（${a.scheme}）`;
  return `只认 ${p}`;
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
 *  status(state, detail)        "connecting" | "open" | "closed" | "origin" | "auth"
 *  frame(dir, frame, at)        every WS frame in/out (for the Score view)
 *  event(payload, topic, seq)   kind=event frames, unwrapped
 *  resync(topic)                subscription went deaf — caller must re-snapshot and resubscribe
 *  reconnected()                socket came back after a drop
 *  auth({ hadToken, path, reason })  核心要 token 而这次没带对（一轮只喊一次）
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
    this.token = coreToken();
    this.authRequired = false;   // 核心自己说的（`/info.authRequired`）——没开鉴权时它也是 false
    this._authAsked = false;     // 一轮只弹一次闸：一次刷新会打出七八条并发请求，条条 401
  }

  /**
   * ⚠️ token 只能走查询参数：浏览器的 `WebSocket` 构造函数**不能自定义请求头**
   * （这是 WebSocket API 的限制，不是我们的选择）。核心两种交法都认。
   */
  get wsUrl() {
    return this.base.replace(/^http/, "ws") + "/ws"
      + (this.token ? `?${TOKEN_PARAM}=${encodeURIComponent(this.token)}` : "");
  }

  /** 存下（或清掉）token。清掉之后下一次 401 会重新弹闸。 */
  setToken(value) {
    this.token = setCoreToken(value);
    this._authAsked = false;
    return this.token;
  }

  /** 发往核心的请求头。没有 token 时**什么都不加**——默认的核心不校验，别把空头递过去。 */
  _headers(extra) {
    const hd = { ...(extra || {}) };
    if (this.token) hd.authorization = `Bearer ${this.token}`;
    return hd;
  }

  /**
   * 401 ⇒ 存着的那份 token 不对（或者核心重启换了一个）。
   *
   * ⚠️ **先清掉再喊**：留着一个用不了的 token，闸上会显示「已填过」，而用户完全不知道
   * 该把它换掉——核心每次启动都会重新生成，昨天存的那份今天必然失效。
   */
  _noteAuth(path) {
    const had = !!this.token;
    this.token = setCoreToken("");
    if (this._authAsked) return;
    this._authAsked = true;
    this.emit("auth", {
      hadToken: had,
      path,
      reason: had
        ? "token 不对（核心每次启动都会换一个新的）"
        : "核心开了鉴权（LILARA_AUTH=1），这个页面还没有 token",
    });
  }

  /**
   * 所有 HTTP 都从这里出去：一处带上 token、一处认 401、一处把核心的 `error` 交成人话。
   *
   * ⚠️ 下面四个方法只是它的四种姿势。**新增端点时不要绕过它**：绕过的那一条必然是
   * 「平时不走」的分支（上传、计划写回），而 401 在那条路上是**静默**的——页面只会看到
   * 一句说不清原因的失败。
   */
  async _req(path, { method = "GET", body, mediaType } = {}) {
    let r;
    try {
      r = await fetch(this.base + path, {
        method, cache: "no-store",
        headers: this._headers(mediaType ? { "content-type": mediaType } : {}),
        body,
      });
    } catch (e) { throw new HttpError(0, { error: "核心没应答：" + e.message }, path); }

    let data = null;
    const text = await r.text();
    if (text) { try { data = JSON.parse(text); } catch { data = { error: text }; } }

    // ⚠️ 在 throw **之前**认 401：调用点拿到的仍是一条 HttpError（它们不用各自认一遍），
    // 而闸只在这里被叫醒一次。
    if (r.status === 401) this._noteAuth(path);
    if (!r.ok) throw new HttpError(r.status, data, path);
    return data;
  }

  async get(path) { return this._req(path); }

  /** PUT a JSON body. Non-2xx throws HttpError; body.error is the core's human-readable reason. */
  async put(path, body) {
    return this._req(path, { method: "PUT", mediaType: "application/json", body: JSON.stringify(body) });
  }

  /** DELETE without a body. Non-2xx throws HttpError carrying the core's `error`. */
  async del(path) { return this._req(path, { method: "DELETE" }); }

  /**
   * POST **原始字节**（`/files`）。⚠️ 不是 JSON 那条 `put`：上传的 body 就是文件本身，
   * `Content-Type` 就是它的媒体类型——核心按 magic 认类型、把字节存进库，回执是
   * `{ ref, mediaType, bytes }`，而 `ref` 正是 `ImageBlock.sha256` 那一格。
   *
   * ⚠️ 上传**不走命令通道**（`03` §9.1）：大字节不该进可重放的命令流。
   */
  async postBytes(path, bytes, mediaType) {
    return this._req(path, { method: "POST", mediaType, body: bytes });
  }

  async probe() {
    try {
      this.info = await this.get("/info");
      // ⚠️ 开了鉴权而它还没被填对时，`/info` **照样回 200**——只是那几格本机路径没了、
      // `authRequired` 变成 true（核心的 `MapSnapshots` 那一段）。所以「要不要 token」只能问
      // 这个字段，不能靠「/info 是不是失败」去猜。
      this.authRequired = !!(this.info && this.info.authRequired);
      return this.info;
    } catch { this.info = null; return null; }
  }

  /**
   * 白名单对不上本页 origin ⇒ 握手会被核心静默拒绝。
   * ⚠️ 判据是**模式匹配**（核心默认 `http://*:<头端口>`），逐字相等会把正确配置判成错配
   * ——那会让每次断开都显示「被拒握手」，反而掩盖真正的原因（核心没起来）。
   */
  originMismatch() {
    return !!this.info?.allowedOrigin && !originMatches(this.info.allowedOrigin, location.origin);
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
      // ⚠️ 「要 token」排在「断了」前面说：两者的现象一样（握手被拒 / 连不上），原因完全不同，
      // 而其中只有一种能由页面自己修好（填 token）。
      const needAuth = this.authRequired && !this.token;
      this._setState(this.originMismatch() ? "origin" : needAuth ? "auth" : "closed");
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
