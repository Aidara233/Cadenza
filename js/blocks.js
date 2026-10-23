// Cadenza · blocks — render Block[] (text / reasoning / toolUse / image / store).
import { h, prettyJson, highlightJson, esc } from "./util.js";
import { md } from "./md.js";

const TOOL_GLYPH = {
  read: "◎", ls: "☰", search: "⌕", write: "✎", update: "✎", delete: "✕", mkdir: "▣", path: "⌖",
  fetch: "⇣", git_read: "⑂", git_write: "⑂", dotnet_build: "⚙", dotnet_test: "✓",
  ask: "?", release: "⌇", system_info: "ⓘ",
  web_search: "☁", web_fetch: "↗", finish_goal: "⚑", shell: "❯",
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
export function toolUseBlock(b) {
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
  const card = h("details.toolcall", { dataset: { callId: b.callId, tool: b.name, name: b.name } },
    h("summary",
      h("span.tc-glyph", { "aria-hidden": "true" }, toolGlyph(b.name)),
      h("span.tc-name", b.name),
      summary ? h("span.tc-sum", summary) : null,
      h("span.tc-state", { "aria-label": "状态" }, "…")),
    body, slot);
  return card;
}

export function attachResult(card, result) {
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
    resultView(result.blocks, text));
}

function resultView(blocks, text) {
  const nonText = (blocks || []).filter((b) => b.kind !== "text");
  const wrap = h("div.tc-out");
  if (text) wrap.append(h("pre.out", text));
  for (const b of nonText) wrap.append(renderBlock(b));
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
