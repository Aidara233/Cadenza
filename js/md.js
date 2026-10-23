// Cadenza · md — small, safe markdown → HTML. Everything is escaped first; only our own tags are emitted.
import { esc } from "./util.js";

function inline(s) {
  // s is already escaped. Protect code spans first.
  const codes = [];
  s = s.replace(/`([^`\n]+)`/g, (_, c) => { codes.push(c); return `${codes.length - 1}`; });
  s = s.replace(/\[([^\]\n]+)\]\((https?:\/\/[^\s)]+)\)/g,
    (_, t, u) => `<a href="${u}" target="_blank" rel="noopener noreferrer">${t}</a>`);
  s = s.replace(/(^|[\s(])(https?:\/\/[^\s<)]+)/g,
    (_, p, u) => `${p}<a href="${u}" target="_blank" rel="noopener noreferrer">${u}</a>`);
  s = s.replace(/\*\*([^*\n]+)\*\*/g, "<strong>$1</strong>");
  s = s.replace(/(^|[^*])\*([^*\n]+)\*/g, "$1<em>$2</em>");
  s = s.replace(/~~([^~\n]+)~~/g, "<del>$1</del>");
  return s.replace(/(\d+)/g, (_, i) => `<code>${codes[+i]}</code>`);
}

// A delimiter row must contain a pipe — otherwise `-----` (a setext/ruler line) under a
// pipe-looking prose line is mistaken for a table separator and the header is left alone.
const isSep = (l) => l.includes("|") && /^\s*\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)*\|?\s*$/.test(l);

// Edge pipes are optional (GFM), and both the separator check and row collection use this —
// mixing two notions of "row" is what let a header-only table through.
function cellsOf(r) {
  let s = String(r ?? "").trim();
  if (s.startsWith("|")) s = s.slice(1);
  if (s.endsWith("|")) s = s.slice(0, -1);
  return s.split("|").map((c) => c.trim());
}

function table(rows) {
  const cells = cellsOf;
  const head = cells(rows[0]);
  const aligns = rows[1] ? cells(rows[1]).map((c) => (/^:-+:$/.test(c) ? "center" : /-+:$/.test(c) ? "right" : "")) : [];
  const td = (tag, c, i) => `<${tag}${aligns[i] ? ` style="text-align:${aligns[i]}"` : ""}>${inline(c)}</${tag}>`;
  let out = "<div class=\"md-table\"><table><thead><tr>" + head.map((c, i) => td("th", c, i)).join("") + "</tr></thead><tbody>";
  for (const r of rows.slice(2)) out += "<tr>" + cells(r).map((c, i) => td("td", c, i)).join("") + "</tr>";
  return out + "</tbody></table></div>";
}

function list(lines) {
  // lines: [{indent, ordered, text}] — build nested lists by indent.
  let html = "";
  const stack = [];
  for (const it of lines) {
    while (stack.length && it.indent < stack[stack.length - 1].indent) html += `</li></${stack.pop().tag}>`;
    const top = stack[stack.length - 1];
    if (!top || it.indent > top.indent) {
      const tag = it.ordered ? "ol" : "ul";
      stack.push({ indent: it.indent, tag });
      html += `<${tag}>`;
    } else html += "</li>";
    const task = /^\[( |x|X)\]\s+/.exec(it.text);
    html += task
      ? `<li class="task"><span class="tick${task[1] !== " " ? " on" : ""}" aria-hidden="true"></span>${inline(it.text.slice(task[0].length))}`
      : `<li>${inline(it.text)}`;
  }
  while (stack.length) html += `</li></${stack.pop().tag}>`;
  return html;
}

export function md(src) {
  const lines = esc(src ?? "").replace(/\r\n?/g, "\n").split("\n");
  let out = "";
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    const fence = /^\s*(`{3,}|~{3,})\s*([\w+#.-]*)\s*$/.exec(line);
    if (fence) {
      const buf = [];
      i++;
      while (i < lines.length && !lines[i].trim().startsWith(fence[1])) buf.push(lines[i++]);
      i++;
      const lang = fence[2] || "";
      out += `<figure class="code"><figcaption><span>${lang || "text"}</span><button type="button" class="code-copy" aria-label="复制代码">复制</button></figcaption><pre><code>${buf.join("\n")}</code></pre></figure>`;
      continue;
    }
    if (!line.trim()) { i++; continue; }
    const hd = /^(#{1,6})\s+(.*)$/.exec(line);
    if (hd) { const n = Math.min(hd[1].length + 2, 6); out += `<h${n}>${inline(hd[2])}</h${n}>`; i++; continue; }
    if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(line)) { out += "<hr>"; i++; continue; }
    if (line.includes("|") && i + 1 < lines.length && isSep(lines[i + 1]) && cellsOf(line).length === cellsOf(lines[i + 1]).length) {
      const rows = [lines[i++], lines[i++]];
      while (i < lines.length && lines[i].trim() && lines[i].includes("|")) rows.push(lines[i++]);
      out += table(rows);
      continue;
    }
    if (/^\s*&gt;\s?/.test(line)) {
      const buf = [];
      while (i < lines.length && /^\s*&gt;\s?/.test(lines[i])) buf.push(lines[i++].replace(/^\s*&gt;\s?/, ""));
      out += `<blockquote>${md(unesc(buf.join("\n")))}</blockquote>`;
      continue;
    }
    const li = /^(\s*)([-*+]|\d+[.)])\s+(.*)$/;
    if (li.test(line)) {
      const items = [];
      while (i < lines.length && (li.test(lines[i]) || (/^\s{2,}\S/.test(lines[i]) && items.length))) {
        const m = li.exec(lines[i]);
        if (m) items.push({ indent: m[1].length, ordered: /\d/.test(m[2]), text: m[3] });
        else items[items.length - 1].text += " " + lines[i].trim();
        i++;
      }
      out += list(items);
      continue;
    }
    const buf = [];
    while (i < lines.length && lines[i].trim() && !/^(#{1,6}\s|\s*(`{3,}|~{3,})|\s*&gt;|\s*([-*+]|\d+[.)])\s)/.test(lines[i])) buf.push(lines[i++]);
    if (!buf.length) buf.push(lines[i++]);
    out += `<p>${buf.map(inline).join("<br>")}</p>`;
  }
  return out;
}

// blockquote recursion re-escapes; undo our own escaping first.
function unesc(s) {
  return s.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, "&");
}

/** Wire up copy buttons inside rendered markdown (event delegation on a root). */
export function bindCodeCopy(root, copyFn) {
  root.addEventListener("click", (e) => {
    const b = e.target.closest?.(".code-copy");
    if (!b) return;
    const code = b.closest("figure")?.querySelector("code");
    if (code) copyFn(code.textContent);
  });
}
