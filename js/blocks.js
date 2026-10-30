// Cadenza · blocks — render Block[] (text / reasoning / toolUse / image / store).
import { h, prettyJson, highlightJson, esc } from "./util.js";
import { md } from "./md.js";

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

export function textBlock(text) {
  return h("div.md", { html: md(text) });
}

export function reasoningBlock(b) {
  if (b.reasoningKind === "redacted") {
    return h("div.reasoning.redacted", h("span.r-label", "思考 · 已加密"), h("span.dim", "上游给的是加密载荷，不显示"));
  }
  const len = (b.text || "").length;
  const d = h("details.reasoning",
    h("summary", h("span.r-label", "思考"), h("span.r-meta", `${len} 字`)),
    h("div.r-body.md", { html: md(b.text || "") }));
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
export function toolUseBlock(b, opts = {}) {
  const a = argsOf(b.arguments);
  const summary = argSummary(b.name, a);
  const body = h("div.tc-body");
  if (b.name === "write" && a && typeof a.content === "string") {
    body.append(h("div.tc-label", "将写入内容"), codeView(a.content, a.path));
    const rest = { ...a }; delete rest.content;
    if (Object.keys(rest).length > 1) body.append(h("div.tc-label", "参数"), jsonPre(JSON.stringify(rest)));
  } else {
    body.append(h("div.tc-label", "参数（原文）"), jsonPre(b.arguments));
  }
  const slot = h("div.tc-result", h("div.tc-pending", h("span.tc-spin", { "aria-hidden": "true" }), "等结果…"));
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
  if (text) wrap.append(h("pre.out", text));
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
  return h("pre.json", { html: highlightJson(prettyJson(raw)) });
}

function codeView(content, path) {
  const ext = /\.([\w]+)$/.exec(path || "")?.[1] || "text";
  return h("figure.code", h("figcaption", h("span", ext)), h("pre", h("code", content)));
}

export function storeBlock(b) {
  return h("div.objref",
    h("span.or-glyph", { "aria-hidden": "true" }, b.kind === "image" ? "▧" : "▤"),
    h("div",
      h("div", b.kind === "image" ? "图片" : "库对象", " · ", h("code", b.mediaType || "?")),
      h("div.dim.mono", (b.sha256 || "").slice(0, 24) + "…"),
      h("div.dim", "核心还没有 /store 端点，取不到内容")));
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
