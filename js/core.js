// Cadenza · core — HTTP snapshots + one WebSocket. No business logic here.
import { Emitter, uid, store } from "./util.js";
import { tag } from "./watchdog.js";

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

// ---- 「谁在连核心」：页面自己，还是 Cadenza 的进程 ----
//
// 默认（`config.json` 里带 `proxy`）**页面不直连核心**：它跟一个源（头的源）说话，
// 头再把 `/core/*` 转给上游。好处全在「谁握着凭据、谁露在浏览器里」这一边：
//   · 页面只认一个源 ⇒ 不再有 CORS / 混合内容 / `Origin` 白名单这些「同源以外」的坑；
//   · token 住在头里（`-Token` / `LILARA_CORE_TOKEN`），浏览器与 localStorage 都不经手；
//   · 换一台设备、换一个地址打开页面（局域网 IP、隧道、https）都不用再动核心的白名单。
// ⚠️ 直连**没有被删掉**：`?core=http://…`（以及没有 `/config.json` 的静态宿主）仍然走它，
// 这是排错时唯一的对照面，也是 php / busybox 那两条退路的形态。
//
// ⚠️ WS 的一处**必须**知道的细节：HttpListener 的 `AcceptWebSocketAsync` 只接受「客户端
// 确实请求过的子协议」，所以头在代理模式下会要求页面带 `cadenza` 这个子协议（`wsProtocol`）。
// 核心（Kestrel）不需要它 ⇒ 直连模式一个子协议都不带。两边形状不同不是疏漏，是各自的约束。

/** 连接描述：`{ base, prefix, via, auth, upstream, wsProtocol }`。app.js 只在这一处拿它。 */
const ACTIVE = { base: "", prefix: "", auth: "page" };

/** `app.js` 在 boot 时调一次：图片 / 库链接（`blocks.js`）也跟着这份走。 */
export function setActiveCore(conn) {
  ACTIVE.base = String(conn?.base || "").replace(/\/+$/, "");
  ACTIVE.prefix = String(conn?.prefix || "").replace(/\/+$/, "");
  ACTIVE.auth = conn?.auth === "head" ? "head" : "page";
}

/** 核心侧的路径 → 真正要打出去的地址（代理模式是 `/core/…`，同源；直连模式是核心的绝对地址）。 */
export function coreUrl(path) { return ACTIVE.base + ACTIVE.prefix + path; }

/** 这份 token 归谁交：`head` = 头自己带（页面一条都不带），`page` = 页面带（旧形态）。 */
export function coreAuthOwner() { return ACTIVE.auth; }

/** 把模式说成人话（横幅要印它）——星号不解释就等于没印。 */
export function describeOrigin(pattern) {
  const p = String(pattern ?? "").trim();
  if (p === "*") return "任意 origin（调试用）";
  const a = splitOrigin(p);
  if (a && a.host === "*") return `任意主机，端口 ${a.port}（${a.scheme}）`;
  return `只认 ${p}`;
}

const stripSlashes = (v) => String(v ?? "").trim().replace(/\/+$/, "");

/**
 * 这次页面该怎么连：问 `config.json`，而 `?core=` 与存着的那份**永远优先**（直连）。
 *
 * 三种来源、两种形态：
 *   · `?core=http://…` / 存着的 `core` → **直连**（排错与旧行为）；
 *   · `config.json` 交 `{ proxy: "/core", upstream, auth, wsProtocol }` → **经由头**（默认）；
 *   · `config.json` 只有 `{ core: "http://…" }`（php / busybox 那两条退路）→ 直连；
 *   · 没有 `config.json`（随便一个静态服务器）→ 直连默认地址，与以前逐字相同。
 * ⚠️ 代理模式下 `base` 是**空串**（同源），真正的前缀在 `prefix` 里：所有拼接都必须走
 * `coreUrl()`，写死 `base + path` 的那一处会在代理模式里变成 `…/info` 打在头自己身上。
 */
export async function resolveCore() {
  const q = new URLSearchParams(location.search).get("core");
  if (q) { store.set("core", q); return { base: stripSlashes(q), prefix: "", via: "direct", auth: "page" }; }
  const saved = store.get("core");
  if (saved) return { base: stripSlashes(saved), prefix: "", via: "direct", auth: "page" };
  try {
    const r = await fetch("config.json", { cache: "no-store" });
    if (r.ok) {
      const j = await r.json();
      if (j && j.proxy) {
        return {
          base: "", prefix: stripSlashes(j.proxy) || "/core", via: "head",
          // ⚠️ `auth` 说的是「token 归谁交」，不是「核心要不要 token」：头配了自己的那份之后，
          // 页面就不该再带一条（带了也不生效，只会让人以为填的那份是对的）。
          auth: j.auth === "head" ? "head" : "page",
          upstream: stripSlashes(j.upstream), wsProtocol: j.wsProtocol || null,
        };
      }
      if (j && j.core) return { base: stripSlashes(j.core), prefix: "", via: "direct", auth: "page" };
    }
  } catch { /* static host without config.json */ }
  return { base: "http://127.0.0.1:17988", prefix: "", via: "direct", auth: "page" };
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
  /** @param conn 连接描述（`resolveCore()` 的产物）；也接受一个裸的 base 字符串（旧写法）。 */
  constructor(conn) {
    super();
    const c = typeof conn === "string" ? { base: conn } : (conn || {});
    this.base = String(c.base || "").replace(/\/+$/, "");
    this.prefix = String(c.prefix || "").replace(/\/+$/, "");
    this.via = c.via === "head" ? "head" : "direct";
    this.authOwner = c.auth === "head" ? "head" : "page";
    this.upstream = String(c.upstream || "").replace(/\/+$/, "");
    // ⚠️ 只有头的 HttpListener 要它（`AcceptWebSocketAsync` 只认客户端请求过的子协议）；
    // 核心不需要 ⇒ 直连时这里是 null，`new WebSocket(url)` 一个子协议都不带。
    this.wsProtocol = c.wsProtocol || null;
    this.ws = null;
    this.state = "closed";
    this.info = null;
    this.lastError = null;
    this.topics = new Map();    // topic -> { seq: number|null }
    this.pending = new Map();   // command id -> { resolve, timer, payload }
    this.backoff = 600;
    this.everOpened = false;
    this.stats = { in: 0, out: 0 };
    this.token = coreToken();
    this.authRequired = false;   // 核心自己说的（`/info.authRequired`）——没开鉴权时它也是 false
    this._authAsked = false;     // 一轮只弹一次闸：一次刷新会打出七八条并发请求，条条 401
  }

  /** 页面实际在打的地址（代理模式是「头的源 + /core」，直连模式是核心地址）。 */
  get displayUrl() {
    if (this.base) return this.base + this.prefix;
    return (location.origin || "") + this.prefix;
  }

  /** 头替页面连的那个上游（直连模式下就是核心自己）。横幅与后台要印它。 */
  get upstreamUrl() { return this.upstream || this.base || "—"; }

  /**
   * ⚠️ token 只能走查询参数：浏览器的 `WebSocket` 构造函数**不能自定义请求头**
   * （这是 WebSocket API 的限制，不是我们的选择）。核心两种交法都认。
   * ⚠️ 头自己带 token 时（`authOwner === "head"`）这里**一个参数都不加**：那份凭据不进浏览器。
   */
  get wsUrl() {
    const t = this.authOwner === "page" && this.token ? `?${TOKEN_PARAM}=${encodeURIComponent(this.token)}` : "";
    if (this.base) return this.base.replace(/^http/, "ws") + this.prefix + "/ws" + t;
    const proto = location.protocol === "https:" ? "wss:" : "ws:";
    return `${proto}//${location.host}${this.prefix}/ws${t}`;
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
    // 头自己带 token 时页面一条都不加：多带一条要么没用，要么让「谁在交凭据」变得说不清。
    if (this.authOwner === "page" && this.token) hd.authorization = `Bearer ${this.token}`;
    return hd;
  }

  /**
   * 401 ⇒ 存着的那份 token 不对（或者核心重启换了一个）。
   *
   * ⚠️ **先清掉再喊**：留着一个用不了的 token，闸上会显示「已填过」，而用户完全不知道
   * 该把它换掉——核心每次启动都会重新生成，昨天存的那份今天必然失效。
   * ⚠️ 代理模式下 401 有两种完全不同的来路，页面能做的也只有两种：头没配 token（那是页面该填的，
   * 弹闸），头配了 token 而它错了（页面填什么都没用——换 `-Token` 要重启头）。后者**不弹闸**。
   */
  _noteAuth(path) {
    const owner = this.authOwner;
    const had = !!this.token;
    if (owner !== "head") this.token = setCoreToken("");
    if (this._authAsked) return;
    this._authAsked = true;
    this.emit("auth", {
      hadToken: had,
      path,
      owner,
      reason: owner === "head"
        ? "Cadenza 进程带去的 token 被核心拒了（核心每次启动都会换一个新的）"
        : had
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
  async _req(path, { method = "GET", body, mediaType, timeoutMs } = {}) {
    // ⚠️ **每个请求都有上限**。核心卡在一步里（长工具、压缩、大历史、上游不吐字）时，
    // 没有超时的 `fetch` 会让界面永远停在「调音中…/加载中…」——看起来就是**页面卡死**，
    // 而真相是「它在等一个不会来的答复」。有上限之后，同一件事会变成一条看得见的错误 +
    // 一个重试按钮（`open()` 的 catch 早就在等这条错误）。
    // 上传（`postBytes`）给得宽：那是字节，不是快照，大图过慢链路要时间。
    const ms = timeoutMs ?? (body ? 120000 : 30000);
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), ms);
    let r, text, data = null;
    try {
      try {
        r = await fetch(coreUrl(path), {
          method, cache: "no-store", signal: ac.signal,
          headers: this._headers(mediaType ? { "content-type": mediaType } : {}),
          body,
        });
      } catch (e) {
        throw new HttpError(0, {
          error: e?.name === "AbortError"
            ? `${Math.round(ms / 1000)} 秒没应答（${path}）：核心那一步还没结束，或者它已经不理这条路了`
            : "核心没应答：" + e.message,
        }, path);
      }
      text = await r.text();
    } finally { clearTimeout(timer); }

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

  async probe({ timeoutMs = 8000 } = {}) {
    try {
      // ⚠️ 健康检查要有自己的、更短的上限：`onclose` 里 `await probe()` 之后才排重连，
      // 探测卡住 = **永远不再重连**（页面停在「已断开」，看起来就是卡死）。
      this.info = await this._req("/info", { timeoutMs });
      this.lastError = null;
      // ⚠️ 开了鉴权而它还没被填对时，`/info` **照样回 200**——只是那几格本机路径没了、
      // `authRequired` 变成 true（核心的 `MapSnapshots` 那一段）。所以「要不要 token」只能问
      // 这个字段，不能靠「/info 是不是失败」去猜。
      this.authRequired = !!(this.info && this.info.authRequired);
      return this.info;
    } catch (e) {
      // ⚠️ 错误留着：横幅要说的是**这一次**为什么不通（头连不上上游 / 上游 502 / 鉴权），
      // 而不是一句「核心没应答」——代理模式下那两种原因的修法完全不同。
      this.info = null; this.lastError = e; return null;
    }
  }

  /**
   * 白名单对不上本页 origin ⇒ 握手会被核心静默拒绝。
   * ⚠️ 判据是**模式匹配**（核心默认 `http://*:<头端口>`），逐字相等会把正确配置判成错配
   * ——那会让每次断开都显示「被拒握手」，反而掩盖真正的原因（核心没起来）。
   * ⚠️ 代理模式下**这个判据整个不成立**：握手是头发的，不带 `Origin`（核心对无 Origin 的
   * 客户端一律放行），页面的 origin 根本到不了核心。
   */
  originMismatch() {
    if (this.via === "head") return false;
    return !!this.info?.allowedOrigin && !originMatches(this.info.allowedOrigin, location.origin);
  }

  connect() {
    clearTimeout(this._retry);
    if (this.ws && this.ws.readyState <= 1) return;
    this._setState("connecting");
    let ws;
    try {
      // ⚠️ 代理模式下必须带子协议：头的 `HttpListener.AcceptWebSocketAsync` 只接受
      // 「客户端确实请求过的」那一个。直连时一个都不带（核心不需要，浏览器也不会因此失败）。
      ws = this.wsProtocol ? new WebSocket(this.wsUrl, this.wsProtocol) : new WebSocket(this.wsUrl);
    } catch (e) { this._scheduleRetry(); return; }
    this.ws = ws;
    // ⚠️ **握手也要有上限**：TCP 连上了而对面不说话（头那台进程死了但端口还开着、代理挂住、
    // 核心卡在启动）时，既不 open 也不 close —— 状态停在「连接中」，`_scheduleRetry` 永远轮不到，
    // 页面就再也不重连了。10 秒后自己关掉它，`onclose` 那条路会把探测与重连接回来。
    const handshake = setTimeout(() => {
      if (this.ws === ws && ws.readyState === 0) { try { ws.close(); } catch { /* 已经死了 */ } }
    }, 10000);
    ws.onopen = () => {
      clearTimeout(handshake);
      const again = this.everOpened;
      this.everOpened = true;
      this.backoff = 600;
      this._setState("open");
      for (const [topic, t] of this.topics) this._sendSub(topic, t.seq);
      if (again) this.emit("reconnected");
    };
    ws.onmessage = (m) => this._onMessage(m.data);
    ws.onerror = () => { clearTimeout(handshake); };
    ws.onclose = async () => {
      clearTimeout(handshake);
      if (this.ws !== ws) return;
      this.ws = null;
      for (const [, p] of this.pending) { clearTimeout(p.timer); p.resolve({ accepted: false, reason: "连接断了，回执没回来（命令可能已执行）", lost: true }); }
      this.pending.clear();
      // 断线后的探测取短上限：它只决定横幅说什么，不该把「多久之后重连」也一起拖住。
      await this.probe({ timeoutMs: 3000 });
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
    // ⚠️ **判据的分水岭**：微任务在这一帧的 JS 退栈之后、样式/布局之前跑；紧接着是 rAF 回调，
    // 再往后才是样式 / 布局 / 绘制。（**不节流**，每条只是一次 postMessage。）
    //   · 停在 `Z:task`       ⇒ 卡在「微任务之后、下一次 rAF 之前」——这一段里跑的是浏览器的渲染步骤；
    //   · 停在 `R:frame`      ⇒ 这一帧的 rAF 开跑了，而**这一帧没走到底**（渲染步骤没回来）；
    //   · 停在 `R:frame:out`  ⇒ 这一帧连渲染步骤都回来了，卡在它之后（别的任务 / 微任务）里。
    // ⚠️ `R:frame:out` 用 `setTimeout(0)` 而不是第二个 rAF：定时器排在**这一帧的渲染步骤之后**，
    // 所以中间那条真能把「渲染步骤里」和「之后的任何地方」分开。早先版本用第二个 rAF，它只说明
    // 「下一帧没来」——2026-11-16 08:55 那条记录读到 `R:frame`，却分不清是回调还是布局。
    // 头两版用节流的 `spin("R:viz")` 当判据，结果它会被节流吞掉——「没有 R:*」根本不能当作结论。
    queueMicrotask(() => {
      tag("Z:task");
      requestAnimationFrame(() => {
        tag("R:frame");
        setTimeout(() => tag("R:frame:out"), 0);
      });
    });
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
