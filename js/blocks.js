// Cadenza · blocks — render Block[] (text / reasoning / toolUse / image / store).
import { h, prettyJson, highlightJson, esc } from "./util.js";
import { md } from "./md.js";
import { coreToken, coreUrl, coreAuthOwner, TOKEN_PARAM } from "./core.js";

const TOOL_GLYPH = {
  read: "◎", ls: "☰", search: "⌕", write: "✎", update: "✎", delete: "✕", mkdir: "▣", path: "⌖",
  fetch: "⇣", git_read: "⑂", git_write: "⑂", dotnet_build: "⚙", dotnet_test: "✓",
  ask: "?", release: "⌇", system_info: "ⓘ",
  web_search: "☁", web_fetch: "↗", finish_goal: "⚑", shell: "❯",
  // 后台任务一族（核心 2026-10-24 那批）：`jobs` 盘点多、`job_output` 读日志、`job_kill` 停进程。
  // ⚠️ 三个必须彼此可辨，也**不能与 `shell` 的 ❯ 混**：那一族是「这条命令跑完了」，
  // 这一族是「有个东西还在我背后跑」。`wait` 是等它，字形用一个钟面。
  jobs: "☷", job_output: "▤", job_kill: "◼", wait: "◷",
  // 上下文与计划：浮动槽/压缩/计划树不是「干活」，是「模型能看见什么」——字形也按这个分组。
  floating_context: "≈", compact: "𝄐", plan: "≡", advance_plan: "→", switch_plan_mode: "◑",
  // 子 agent 一族（核心 BuiltInTools 的四个机制入口）：派生 / 对下说 / 对上说 / 回流。
  // ⚠️ 四个必须彼此可辨、也**不能与 git 的 ⑂ 混**：那一族是「记录在哪」，这一族是「谁在说」。
  spawn: "⎇", tell_child: "⇥", tell_parent: "⇤", subagent_report: "↩",
};
export const toolGlyph = (name) => TOOL_GLYPH[name] || "◆";

// 一条正文里**排版**多少字。超出的部分按原文放进 `<pre class="out">`（滚动框、原文照列、
// `Ctrl+F` 与「复制这条」都还是全文）——只省掉「给几 MB 跑 markdown + 铺成几 MB 的文字流」。
// ⚠️ 实测：`md()` 2.5 MB 要 675ms，而一条几十 MB 的消息在真会话里是有的（模型把整个文件吐出来）。
const MD_MAX = 128 * 1024;

/** 正文 → 节点。长文分两段：前 128 KB 排版，其余原文照列（再长就只画前 `RAW_MAX`）。 */
function textNodes(text) {
  const s = String(text ?? "");
  if (s.length <= MD_MAX) return [h("div.md", { html: md(s) })];
  let cut = s.lastIndexOf("\n", MD_MAX);
  if (cut < MD_MAX * 0.5) cut = MD_MAX;
  const rest = s.slice(cut);
  // ⚠️ 剩下的那一段**也必须有上限**：它是一个文本节点，进了视口就要按字数付布局的钱。
  // 2026-11-15 的记录里有一次 25 秒的停摆，DOM 只有 5959 个节点、堆 9 MB —— 数量解释不了，
  // 能解释的就是「某一个节点特别大」。全文仍在消息块里（「复制这条」拿的是全文）。
  const shown = rest.length > RAW_MAX ? rest.slice(0, RAW_MAX) : rest;
  return [
    h("div.md", { html: md(s.slice(0, cut)) }),
    h("div.md-more.dim", `还有 ${Math.round(rest.length / 1024)} KB · 下面按原文列出，不排版（复制与查找仍是全文）`),
    h("pre.out.md-rest", shown),
    rest.length > RAW_MAX ? moreNote(rest.length, RAW_MAX, "落盘的消息里是全文") : null,
  ];
}

export function textBlock(text) {
  return h("div", ...textNodes(text));
}

export function reasoningBlock(b) {
  if (b.reasoningKind === "redacted") {
    return h("div.reasoning.redacted", h("span.r-label", "思考 · 已加密"), h("span.dim", "上游给的是加密载荷，不显示"));
  }
  const len = (b.text || "").length;
  const d = h("details.reasoning",
    h("summary", h("span.r-label", "思考"), h("span.r-meta", `${len} 字`)),
    h("div.r-body", ...textNodes(b.text || "")));
  return d;
}

/** Parse tool args leniently for display only. The raw value remains the source of truth.
 *  The core normally sends a verbatim JSON string, but histories written by other builds carry objects. */
export function argsOf(raw) {
  if (raw && typeof raw === "object") return raw;
  try { const v = JSON.parse(raw); return v && typeof v === "object" ? v : null; } catch { return null; }
}

function argSummary(name, a) {
  if (!a) return "";
  if (name === "web_search" && a.query != null) return String(a.query);
  if (name === "finish_goal") return "结束目标";
  // 子 agent 一族：`task` / `text` 往往多行，摘要只取一行——全文在卡片里，别在这里吃掉它。
  if (name === "spawn") {
    if (a.title) return String(a.title);
    const task = String(a.task ?? "").replace(/\s+/g, " ").trim();
    return task ? task.slice(0, 60) : "派生子会话";
  }
  if (name === "tell_child") return a.child ? "→ " + String(a.child) : "给子会话补话";
  if (name === "tell_parent") {
    const text = String(a.text ?? "").replace(/\s+/g, " ").trim();
    return text ? text.slice(0, 60) : "对父会话说";
  }
  if (name === "subagent_report") return "子会话回报";
  // 后台任务一族：摘要里给的是**任务 id**（那是唯一能对上别处的键），不是命令原文——
  // 命令原文在 `shell` 卡上已经有了，这里再来一遍只会把 id 挤出视野。
  if (name === "jobs") return "本会话的任务表";
  if (name === "job_output") return a.job ? `${a.job}${a.offset ? ` @${a.offset}` : " · 从头"}` : "读任务输出";
  if (name === "job_kill") return a.job ? String(a.job) : "停一个任务";
  if (name === "wait") {
    const task = a.task ? String(a.task) : "?";
    return a.timeoutSeconds ? `等 ${task} · 最多 ${a.timeoutSeconds} 秒` : `等 ${task} 到结束`;
  }
  // A shell script can be many lines; the summary shows the first one and the card keeps the original.
  if (name === "shell" && a.command != null) return String(a.command).split("\n")[0].slice(0, 100);
  if (name === "search" && a.pattern != null) {
    const mode = a.mode === "filename" ? "文件名" : "内容";
    return `${mode} · ${String(a.pattern)}${a.path ? ` @ ${String(a.path)}` : ""}`;
  }
  if (a.path != null) return String(a.path);
  if (a.url) return String(a.url);
  if (a.command) return String(a.command);
  if (name === "ask" && Array.isArray(a.questions)) return `${a.questions.length} 个问题`;
  const k = Object.keys(a)[0];
  return k ? `${k}: ${String(typeof a[k] === "object" ? JSON.stringify(a[k]) : a[k]).slice(0, 60)}` : "";
}

/** A tool call card. Result slot is filled later by attachResult(). */
export function toolUseBlock(b, opts = {}) {  const a = argsOf(b.arguments);
  const summary = argSummary(b.name, a);
  const body = h("div.tc-body");
  if (b.name === "write" && a && typeof a.content === "string") {
    body.append(h("div.tc-label", "将写入内容"), codeView(a.content, a.path));
    const rest = { ...a }; delete rest.content;
    if (Object.keys(rest).length > 1) body.append(h("div.tc-label", "参数"), jsonPre(JSON.stringify(rest)));
  } else {
    body.append(h("div.tc-label", "参数（原文）"), jsonPre(b.arguments));
  }
  // ⚠️ 文案由调用方给：同一张卡在两种时候出现——「已经落盘、等结果」（等结果…）与
  // 「正在跑、还没有记录」（执行中…，见 timeline.startToolCall）。用同一句话会把「还没落盘」
  // 说成「已落盘」，而这两件事对用户是两件事（前者可以去翻历史，后者翻了也没有）。
  const slot = h("div.tc-result", h("div.tc-pending", h("span.tc-spin", { "aria-hidden": "true" }), opts.pendingText || "等结果…"));
  // ⚠️ `data-tool` 必须带上：E2E 与样式都按工具名选卡片，少一个应用它的人就得改选择器。
  const childId = b.name === "subagent_report" && a && typeof a.child === "string" ? a.child : null;
  const card = h("details.toolcall", { dataset: { callId: b.callId, tool: b.name, name: b.name } },
    h("summary",
      h("span.tc-glyph", { "aria-hidden": "true" }, toolGlyph(b.name)),
      h("span.tc-name", b.name),
      summary ? h("span.tc-sum", summary) : null,
      h("span.tc-state", { "aria-label": "状态" }, "…")),
    childId ? h("div.tc-child-link", h("button.btn.btn-ghost.btn-sm.tc-child", { type: "button", onclick: () => opts.openSession?.(childId) }, "打开子会话 ↗"), h("code", childId)) : null,
    body, slot);
  return card;
}

export function attachResult(card, result, opts = {}) {
  const slot = card.querySelector(".tc-result");
  if (!slot) return;
  const text = blocksToText(result.blocks);
  const lines = text.split("\n").length;
  const looksBad = /^(错误|失败|拒绝|被拒|✗|Error|error:)|权限.*拒绝|档位不允许|用户拒绝|没有批准|未批准/.test(text.trim());
  card.classList.toggle("bad", looksBad);
  card.classList.add("done");
  card.querySelector(".tc-state").textContent = looksBad ? "被拒 / 失败" : `${lines} 行`;
  slot.replaceChildren(
    h("div.tc-label", "结果"),
    resultView(result.blocks, text, opts, card));
}

// 一张卡里**画**多少字的上限。⚠️ 不是为了好看：几 MB 的文本节点会让每次布局都变贵，而
// 时间线里 `.tl-list > li` 的 `content-visibility` 只救得了**滚出视口**的那些——
// 刚来的这一条正在视口里。超出的部分明说「没画出来」，全文仍在消息块里（「复制这条」拿的是全文）。
const OUT_MAX = 256 * 1024;
const JSON_MAX = 128 * 1024;
const CODE_MAX = 128 * 1024;
const RAW_MAX = 256 * 1024;

function moreNote(total, shown, what) {
  return h("div.tc-more.dim",
    `还有 ${Math.round((total - shown) / 1024)} KB 没画出来（${what}）`);
}

/**
 * 后台任务的结果里带 `job-…` 时，给一条**就地跳过去**的路。
 * ⚠️ 只认结果文本里那个 id，不猜「这张卡是不是关于任务的」：`shell` 前台的结果里也可能
 * 出现这个词（比如 `echo job-abc`），那时多一个按钮只是多一条无用的路，不会说谎；
 * 反过来按工具名白名单猜，会让「以后某个工具也起后台任务」时这张卡悄悄没有入口。
 */
const JOB_ID_RE = /\bjob-[0-9a-f]{6,}\b/;

function resultView(blocks, text, opts = {}, card = null) {
  const nonText = (blocks || []).filter((b) => b.kind !== "text");
  const wrap = h("div.tc-out");
  if (text) {
    if (text.length > OUT_MAX) {
      wrap.append(h("pre.out", text.slice(0, OUT_MAX)), moreNote(text.length, OUT_MAX, "「复制这条」与历史里都是全文"));
    } else wrap.append(h("pre.out", text));
  }
  for (const b of nonText) wrap.append(renderBlock(b));
  const jobId = opts.onJob ? JOB_ID_RE.exec(text)?.[0] : null;
  if (jobId) {
    wrap.append(h("div.tc-joblink",
      h("button.btn.btn-sm.btn-ghost.tc-job", { type: "button", title: "跳到调音台 · 任务，并打开它的输出", onclick: () => opts.onJob(jobId) },
        "⏳ 在任务面板里打开 ", h("code", jobId))));
    if (card) card.dataset.job = jobId;
  }
  return wrap;
}

export function blocksToText(blocks) {
  return (blocks || []).filter((b) => b.kind === "text").map((b) => b.text).join("\n");
}

function jsonPre(raw) {
  // ⚠️ `tool.call.started` 那条路上的 `arguments` 是**对象**（核心那边已经解过一次），
  // 只有落盘消息里的是原文字符串。两种都要能画——`String(对象)` 会得到 `[object Object]`。
  const s = typeof raw === "string" ? raw
    : (() => { try { return JSON.stringify(raw, null, 2); } catch { return String(raw ?? ""); } })();
  if (s.length <= JSON_MAX) return h("pre.json", { html: highlightJson(prettyJson(s)) });
  // 截断的 JSON 一定 parse 不了 ⇒ `prettyJson` 原样返回；照样高亮，省掉的是排版那一遍。
  return h("div",
    h("pre.json", { html: highlightJson(s.slice(0, JSON_MAX)) }),
    moreNote(s.length, JSON_MAX, "参数原文只在「批准 / 改写参数」那张卡里给全文"));
}

function codeView(content, path) {
  const ext = /\.([\w]+)$/.exec(path || "")?.[1] || "text";
  const s = String(content ?? "");
  const pre = s.length > CODE_MAX
    ? h("pre", h("code", s.slice(0, CODE_MAX)))
    : h("pre", h("code", s));
  return h("figure.code", h("figcaption", h("span", ext)), pre,
    s.length > CODE_MAX ? moreNote(s.length, CODE_MAX, "落盘的内容是完整的") : null);
}

// ---- 库的两个端点（核心 2026-10-29 那批） ----
//
// ⚠️ 图片块的记录里**只有地址**（`ImageBlock(sha256, mediaType)`），字节住核心的库里，
// 要按 `GET /store/{sha256}` 去取（`03` §9.4）。⇒ 这里必须知道核心在哪。
// ⚠️ 地址的拼法**不在这里**：`core.js` 的 `coreUrl()` 是唯一的出口（代理模式下它是同源的
// `/core/store/…`，直连模式下是核心的绝对地址）。写死 `base + path` 的那一处，会在代理模式里
// 把请求打到头自己身上（404），而症状看起来像「图片被回收了」。
//
// ⚠️ **图片与库链接只能走查询参数带 token**：`<img src>` / `<a href>` 都没法自定义请求头
//（核心的 `IsAuthorized` 两种交法都认，就是为了这一格）。⇒ 这里读的是**当下**那份 token，
// 不是 boot 时那一份——后台里换过 token 之后重新渲染出来的图，才该是能取回的。
// ⚠️ 头自己带 token 时（`coreAuthOwner() === "head"`）**一个参数都不加**：凭据不进浏览器。
const storeUrl = (sha) => {
  const t = coreAuthOwner() === "page" ? coreToken() : "";
  return coreUrl(`/store/${encodeURIComponent(sha || "")}`)
    + (t ? `?${TOKEN_PARAM}=${encodeURIComponent(t)}` : "");
};

export function storeBlock(b) {
  // ⚠️ **图片显示的是那张图本身**：核心的 `GET /store/{sha256}` 就是为这一格开的
  // （2026-10-29 之前这里写的是「核心还没有 /store 端点」）。
  if (b.kind === "image") {
    const img = h("img.obj-img", { src: storeUrl(b.sha256), alt: "图片", loading: "lazy", decoding: "async" });
    const box = h("figure.obj-imgbox",
      img,
      h("figcaption.dim.mono", `${b.mediaType || "?"} · ${(b.sha256 || "").slice(0, 12)}…`));

    // ⚠️ **取不回来必须说出来**：库对象会随 GC 消失（`Reclaim`），那时 `<img>` 只会是
    // 一个空框——而空框看起来像「这张图本来就是空的」，不像「它没了」。
    img.addEventListener("error", () => {
      box.replaceChildren(h("div.objref",
        h("span.or-glyph", { "aria-hidden": "true" }, "▧"),
        h("div",
          h("div", "图片取不回来"),
          h("div.dim.mono", (b.sha256 || "").slice(0, 24) + "…"),
          h("div.dim", "核心的库里没有这串字节（被回收了，或者换了 dataRoot）"))));
    });

    return box;
  }

  // `store`：块数组 / 原始文本那种库对象——头**不解引用**（那是核心渲染期的事），
  // 只给一条能自己去看的路。
  // ⚠️ 以前这里读一个**不存在的** `coreBase`：每一块 store 都在这里抛 ReferenceError，
  // 被时间线接住画成「这一块渲染不了」。判据换成地址本身（拼法只在 `coreUrl()` 一处）。
  return h("div.objref",
    h("span.or-glyph", { "aria-hidden": "true" }, "▤"),
    h("div",
      h("div", "库对象", " · ", h("code", b.mediaType || "?")),
      h("div.dim.mono", (b.sha256 || "").slice(0, 24) + "…"),
      h("div.dim", h("a", { href: storeUrl(b.sha256), target: "_blank", rel: "noreferrer" }, "在核心的库里打开 ↗"))));
}

export function renderBlock(b) {
  switch (b.kind) {
    case "text": return textBlock(b.text);
    case "reasoning": return reasoningBlock(b);
    case "toolUse": return toolUseBlock(b);
    case "image":
    case "store": return storeBlock(b);
    default: return h("div.dim", "未知块 ", h("code", esc(b.kind)));
  }
}

export function plainOf(blocks) {
  return (blocks || []).map((b) => b.kind === "text" ? b.text : b.kind === "toolUse" ? `[${b.name}]` : "").join(" ").trim();
}
