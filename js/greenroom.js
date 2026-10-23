// Cadenza · green room — providers, presets, system self-check.
import { h, swap, clear, toast, confirmDlg, modal, jsonBlock, store, copy, fmtNum } from "./util.js";
import { app, cmd, refreshProviders, refreshPresets, refreshNetwork, refreshShell, loadRegistries } from "./model.js";

const G = { root: null, tab: store.get("grTab", "providers"), body: null };

export function mountGreenRoom(root) {
  G.root = root;
  root.classList.add("greenroom");
  app.bus.on("providers", () => { if (G.tab === "providers" && isShown()) render(); });
  app.bus.on("network", () => { if (G.tab === "network" && isShown()) render(); });
  app.bus.on("shell", () => { if (G.tab === "shell" && isShown()) render(); });
}
const isShown = () => G.root && !G.root.hidden;

export function greenRoomShown() { render(); }

function render() {
  const tabs = [["providers", "乐团 · 提供商"], ["presets", "乐谱 · 预设"], ["network", "后厅 · 联网"], ["shell", "调音 · Shell"], ["system", "调音 · 系统"]];
  G.body = h("div.gr-body");
  swap(G.root, h("div.gr-in",
    h("header.lg-h", h("div", h("div.eyebrow", "Green room"), h("h2", "后台")), h("span.sp"),
      h("div.seg", { role: "tablist" }, ...tabs.map(([k, l]) => h(`button.seg-b${G.tab === k ? ".on" : ""}`, { type: "button", role: "tab", "aria-selected": String(G.tab === k), onclick: () => { G.tab = k; store.set("grTab", k); render(); } }, h("span", l))))),
    G.body));
  ({ providers, presets, network, shell, system })[G.tab](G.body);
}

// ---------------- providers ----------------
function providers(root) {
  const list = h("div.prov-grid");
  for (const p of app.providers) list.append(provCard(p));
  list.append(h("button.prov-card.prov-new", { type: "button", onclick: () => provForm(null) }, h("span.glyph", "+"), h("b", "加一位乐手"), h("small.dim", "新提供商")));
  root.append(
    !app.providers.length ? h("div.gr-hint", "核心还没有提供商——没有它就建不了会话。先加一个。") : null,
    list);
}

function provCard(p) {
  const result = h("div.prov-test");
  return h("article.prov-card",
    h("header.pc-h", h("span.pc-glyph", { "aria-hidden": "true" }, "♬"), h("h3", p.id), h("span.sp"),
      p.hasApiKey ? h("span.chip.green", "有 key") : h("span.chip.red", "没 key")),
    h("div.kv",
      kvr("协议", h("code", p.protocol)),
      kvr("默认模型", h("code", p.defaultModel)),
      kvr("端点", p.endpoint ? h("code", p.endpoint) : h("span.dim", "官方地址")),
      kvr("认证", p.authScheme ? h("code", p.authScheme) : h("span.dim", "协议默认")),
      kvr("模态", h("code", p.modality || "—")),
      kvr("可选模型", p.models?.length ? h("span", p.models.join(" · ")) : h("span.dim", "未声明（会话里退回文本框）"))),
    result,
    h("footer.pc-f",
      h("button.btn.btn-sm", { type: "button", onclick: async (e) => {
        const b = e.currentTarget; b.disabled = true; b.textContent = "试音中…";
        swap(result, h("div.dim", "发一次最小请求，最多 10 秒…"));
        const ack = await app.core.command({ kind: "provider.test", id: p.id });
        b.disabled = false; b.textContent = "试音";
        const ok = ack.accepted && /^✓/.test(ack.note || "");
        swap(result, h(`div.pt-r.${ok ? "ok" : "bad"}`, ack.note || ack.reason || "没有回音"));
      } }, "试音"),
      h("button.btn.btn-sm.btn-ghost", { type: "button", onclick: () => provForm(p) }, "编辑"),
      h("span.sp"),
      h("button.btn.btn-sm.btn-ghost.danger-t", { type: "button", onclick: async () => {
        const ok = await confirmDlg({ title: `删除提供商 ${p.id}？`, body: "核心不会阻止删除被会话引用的提供商——引用它的会话之后会推进失败。", ok: "删除", danger: true, typed: p.id });
        if (!ok) return;
        const ack = await cmd({ kind: "provider.delete", id: p.id }, { ok: "已删除" });
        if (ack.accepted) refreshProviders();
      } }, "删除")));
}
const kvr = (k, v) => h("div.kv-row", h("span.kv-k", k), h("span.kv-v", v));

function provForm(p) {
  const isNew = !p;
  const sc = app.schema || { protocols: ["claude-messages", "openai-chat", "openai-responses"], authSchemes: ["api-key", "bearer"] };
  const id = h("input.inp.mono", { value: p?.id || "", disabled: !isNew, "aria-label": "id" });
  const proto = h("select.sel", ...sc.protocols.map((x) => h("option", { value: x, selected: x === (p?.protocol || sc.protocols[0]) }, x)));
  const auth = h("select.sel", h("option", { value: "" }, isNew ? `（协议默认）` : "（保留）"), ...sc.authSchemes.map((x) => h("option", { value: x, selected: x === p?.authScheme }, x)));
  const key = h("input.inp.mono", { type: "password", autocomplete: "off", placeholder: isNew ? "必填" : "留空 = 保留现有 key", "aria-label": "API key" });
  const model = h("input.inp.mono", { value: p?.defaultModel || "", "aria-label": "默认模型" });
  const endpoint = h("input.inp.mono", { value: p?.endpoint || "", placeholder: "留空 = 官方地址", "aria-label": "端点" });
  const models = h("input.inp.mono", { value: (p?.models || []).join(", "), placeholder: "逗号分隔，可空", "aria-label": "可选模型" });
  const err = h("div.form-err", { role: "alert" });
  const form = h("form",
    h("label.field", h("span", h("b", "id")), id, isNew && sc.providerIdRule ? h("span.hint", sc.providerIdRule) : null),
    h("div.grid2", h("label.field", h("span", "协议"), proto), h("label.field", h("span", "认证方式"), auth)),
    h("label.field", h("span", h("b", "API key"), " · 永远不会回显"), key),
    h("div.grid2", h("label.field", h("span", "默认模型"), model), h("label.field", h("span", "端点"), endpoint)),
    h("label.field", h("span", "可选模型"), models),
    err,
    h("div.dlg-actions", h("button.btn.btn-ghost", { type: "button", onclick: () => m.close() }, "取消"), h("button.btn.btn-primary", { type: "submit" }, isNew ? "加入乐团" : "保存")));
  const m = modal(isNew ? "新提供商" : "编辑 " + p.id, form);
  (isNew ? id : key).focus();
  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const payload = { kind: "provider.upsert", id: id.value.trim() };
    if (key.value) payload.apiKey = key.value;
    if (model.value.trim()) payload.model = model.value.trim();
    if (isNew || proto.value !== p.protocol) payload.protocol = proto.value;
    if (auth.value) payload.auth = auth.value;
    if (isNew ? endpoint.value.trim() : endpoint.value.trim() !== (p.endpoint || "")) payload.endpoint = endpoint.value.trim();
    const ml = models.value.split(",").map((s) => s.trim()).filter(Boolean);
    if (isNew ? ml.length : ml.join(",") !== (p.models || []).join(",")) payload.models = ml;
    const ack = await app.core.command(payload);
    if (!ack.accepted) { err.textContent = ack.reason; return; }
    m.close();
    toast(`${payload.id} · 协议 ${ack.note}`, "ok");
    refreshProviders();
  });
}

// ---------------- presets ----------------
function presets(root) {
  const list = h("ul.preset-list", h("li.dim", "读取中…"));
  const editId = h("input.inp.mono", { placeholder: "预设 id，比如 task", "aria-label": "预设 id" });
  const content = h("textarea.txt.preset-ta", { rows: 14, placeholder: "你是……\n\n（空串合法 = 纯聊天）", "aria-label": "预设内容" });
  const save = h("button.btn.btn-primary", { type: "button", onclick: async () => {
    if (!editId.value.trim()) { toast("先写个 id", "warn"); return; }
    const ack = await cmd({ kind: "preset.set", id: editId.value.trim(), content: content.value });
    if (ack.accepted) load();
  } }, "写入（覆盖）");
  root.append(h("div.preset-grid",
    h("section.card", h("div.card-h", h("h3", "曲目"), h("span.sp"), h("button.btn.btn-sm.btn-ghost", { type: "button", onclick: () => load() }, "↻")), list),
    h("section.card", h("div.card-h", h("h3", "写一份"), h("span.dim", "核心没有读预设内容的端点 · 只能覆盖写")),
      h("label.field", h("span", "id"), editId), h("label.field", h("span", "内容"), content), h("div.row-end", save))));
  async function load() {
    const ps = await refreshPresets();
    swap(list, ...(ps.length ? ps.map((p) => h("li.preset",
      h("span.pr-glyph", "𝄞"), h("code", p), h("span.sp"),
      h("button.btn.btn-sm.btn-ghost", { type: "button", onclick: () => { editId.value = p; content.focus(); toast("内容取不回来——写入会整份覆盖", "info"); } }, "覆盖写"),
      h("button.btn.btn-sm.btn-ghost.danger-t", { type: "button", onclick: async () => {
        if (!(await confirmDlg({ title: `删除预设 ${p}？`, body: "引用它的会话会回落到内置模板。", ok: "删除", danger: true }))) return;
        const ack = await cmd({ kind: "preset.delete", id: p });
        if (ack.accepted) load();
      } }, "删除"))) : [h("li.dim", "还没有预设。")]));
  }
  load();
}

// ---------------- network ----------------
// Device-level credentials/endpoints. Per-session "may I go online" lives on the network axis,
// not here — two different lifetimes, two different places.
async function network(root) {
  if (app.network === undefined || app.network === null) await refreshNetwork();

  if (app.network == null) {
    root.append(h("div.gr-hint",
      "这个核心没有 /network-config——它不支持联网工具。升级核心后这里会出现配置项。"));
    return;
  }

  const n = app.network;
  const enabled = h("input.net-enabled", { type: "checkbox", checked: !!n.enabled, "aria-label": "启用联网" });
  const key = h("input.inp.mono.net-key", {
    type: "password",
    placeholder: n.hasApiKey ? "已配置 · 留空 = 保留" : "Tavily API key",
    "aria-label": "Tavily API key",
  });
  const endpoint = h("input.inp.mono.net-endpoint", { value: n.search?.endpoint || "", "aria-label": "搜索端点" });
  const maxResults = h("input.inp.num.net-results", { type: "number", min: 1, max: 10, value: n.search?.maxResults ?? 5, "aria-label": "结果条数" });
  const timeout = h("input.inp.num.net-timeout", { type: "number", min: 1, max: 120, value: n.search?.timeoutSeconds ?? 20, "aria-label": "超时秒数" });
  const maxMb = h("input.inp.num.net-bytes", { type: "number", min: 0.1, step: 0.5,
    value: Math.round(((n.fetch?.maxBytes ?? 2097152) / 1048576) * 10) / 10, "aria-label": "抓取上限（MB）" });
  const allow = h("input.inp.mono.net-allow", {
    value: (n.fetch?.allowDomains || []).join(", "),
    placeholder: "空 = 只许公网；显式写进名单的域名可以指向本机 / 内网",
    "aria-label": "抓取域名白名单",
  });
  const err = h("div.form-err", { role: "alert" });
  const result = h("div.prov-test.net-result");
  const clearKey = h("button.btn.btn-sm.btn-ghost.net-clear-key", { type: "button", onclick: async () => {
    if (!(await confirmDlg({ title: "清除搜索 key？", body: "之后 web_search 会一直回「还没配置 key」，直到重新填写。", ok: "清除", danger: true }))) return;
    const ack = await app.core.command({ kind: "network.configure", apiKey: "" });
    if (ack.accepted) { toast("key 已清除", "ok"); await refreshNetwork(); }
  } }, "清除 key");

  const save = h("button.btn.btn-primary.net-save", { type: "button" }, "保存");
  save.addEventListener("click", async () => {
    save.disabled = true;
    const payload = {
      kind: "network.configure",
      enabled: enabled.checked,
      endpoint: endpoint.value.trim(),
      maxResults: parseInt(maxResults.value, 10),
      timeoutSeconds: parseInt(timeout.value, 10),
      maxBytes: Math.round(parseFloat(maxMb.value) * 1048576),
      allowDomains: allow.value.split(/[,\n]/).map((s) => s.trim()).filter(Boolean),
    };
    // ⚠️ key is write-only: only send it when the user typed one (empty = keep).
    if (key.value) payload.apiKey = key.value;

    const ack = await app.core.command(payload);
    save.disabled = false;
    if (!ack.accepted) { err.textContent = ack.reason; return; }
    err.textContent = "";
    key.value = "";
    toast(ack.note || "已保存", "ok");
    await refreshNetwork();
  });

  const test = h("button.btn.btn-sm.btn-ghost.net-test", { type: "button" }, "试搜");
  test.addEventListener("click", async () => {
    test.disabled = true; test.textContent = "试搜中…";
    swap(result, h("div.dim", "发一次最小搜索，最多 10 秒…"));
    const ack = await app.core.command({ kind: "network.test" });
    test.disabled = false; test.textContent = "试搜";
    const ok = ack.accepted && /^✓/.test(ack.note || "");
    swap(result, h(`div.pt-r.${ok ? "ok" : "bad"}`, ack.note || ack.reason || "没有回音"));
  });

  root.append(
    h("p.dim.mix-note",
      "这里是设备级的凭据与端点。每个会话还要把调音台的「联网」轴拨到 search / fetch / all；新会话默认 off。"),
    h("div.sys-grid",
      h("section.card",
        h("div.card-h", h("h3", "开关"), h("span.sp"),
          n.enabled ? h("span.chip.green", "已启用") : h("span.chip.red", "未启用")),
        h("label.check", enabled, "允许联网工具出网"),
        h("p.dim.mt", "关闭时 web_search / web_fetch 仍出现在工具表里（保前缀稳定），但只回一句「未启用」。")),
      h("section.card",
        h("div.card-h", h("h3", "搜索 · Tavily"), h("span.sp"),
          n.hasApiKey ? h("span.chip.green", "有 key") : h("span.chip.red", "没 key")),
        h("label.field", h("span", "API key · 永不回显"), h("div.row", key, clearKey)),
        h("label.field", h("span", "端点"), endpoint),
        h("div.grid2",
          h("label.field", h("span", "最多几条"), maxResults),
          h("label.field", h("span", "超时（秒）"), timeout)))),
    h("section.card",
      h("div.card-h", h("h3", "抓取 · web_fetch")),
      h("div.grid2",
        h("label.field", h("span", "单页上限（MB）"), maxMb),
        h("label.field", h("span", "域名白名单"), allow)),
      h("p.dim.mt", "白名单为空时只许公网；本机 / 内网地址一律拒绝。非白名单域名只允许 80 / 443。"),
      h("div.row-end", test, save, h("span.sp"), err)),
    result);
}

// ---------------- shell ----------------
// Device-level: which sh, how long, whether at all. "May this session run commands" is the
// permission axis (shell is Destructive — only `trusted` runs it without asking), not here.
async function shell(root) {
  if (app.shell === undefined || app.shell === null) await refreshShell();

  if (app.shell == null) {
    root.append(h("div.gr-hint",
      "这个核心没有 /shell-config——它不支持 shell 工具。升级核心后这里会出现配置项。"));
    return;
  }

  const c = app.shell;
  const shOk = !!c.sh?.found;
  const enabled = h("input.shell-enabled", { type: "checkbox", checked: !!c.enabled, "aria-label": "启用 shell" });
  const executable = h("input.inp.mono.shell-exe", {
    value: c.executable || "",
    placeholder: shOk ? `自动探测：${c.sh.path}` : "自动探测（没找到——填一个 sh.exe 的路径）",
    "aria-label": "sh 路径",
  });
  const timeout = h("input.inp.num.shell-timeout", {
    type: "number", min: 1, max: 600, value: c.timeoutSeconds ?? 120, "aria-label": "超时秒数",
  });
  const err = h("div.form-err", { role: "alert" });
  const result = h("div.prov-test.shell-result");
  const auto = h("button.btn.btn-sm.btn-ghost.shell-auto", { type: "button", onclick: async () => {
    // ⚠️ "" is a meaningful value: clear the path and go back to auto-detection (not "keep").
    const ack = await app.core.command({ kind: "shell.configure", executable: "" });
    if (ack.accepted) { toast(ack.note || "已回到自动探测", "ok"); await refreshShell(); }
  } }, "自动探测");

  const save = h("button.btn.btn-primary.shell-save", { type: "button" }, "保存");
  save.addEventListener("click", async () => {
    save.disabled = true;
    swap(result, h("div.dim", "保存中…"));
    const payload = {
      kind: "shell.configure",
      enabled: enabled.checked,
      timeoutSeconds: parseInt(timeout.value, 10),
    };
    // Only send when it changed — an untouched/empty box means "keep what the core has".
    const typed = executable.value.trim();
    if (typed !== (c.executable || "")) payload.executable = typed;
    const ack = await app.core.command(payload);
    save.disabled = false;
    if (!ack.accepted) { err.textContent = ack.reason; swap(result, h("div.pt-r.bad", ack.reason)); return; }
    err.textContent = "";
    toast(ack.note || "已保存", "ok");
    await refreshShell();
  });

  const test = h("button.btn.btn-sm.btn-ghost.shell-test", { type: "button" }, "试一下");
  test.addEventListener("click", async () => {
    test.disabled = true; test.textContent = "运行中…";
    swap(result, h("div.dim", "起一个 sh 跑一次 echo…"));
    const ack = await app.core.command({ kind: "shell.test" });
    test.disabled = false; test.textContent = "试一下";
    const ok = ack.accepted && /^✓/.test(ack.note || "");
    swap(result, h(`div.pt-r.${ok ? "ok" : "bad"}`, ack.note || ack.reason || "没有回音"));
  });

  root.append(
    h("p.dim.mix-note",
      "这里是设备级配置：用哪个 sh、能跑多久。每个会话还要把权限轴拨到 authorized（问一句）或 trusted（直接放行）——"
      + "shell 与 delete 同级，是唯一能执行任意命令的工具。"),
    h("div.sys-grid",
      h("section.card",
        h("div.card-h", h("h3", "开关"), h("span.sp"),
          c.enabled ? h("span.chip.green", "已启用") : h("span.chip.red", "未启用")),
        h("label.check", enabled, "允许 shell 工具起进程"),
        h("p.dim.mt", "关闭时 shell 仍出现在工具表里（保前缀稳定），但只回一句「已关闭」。")),
      h("section.card",
        h("div.card-h", h("h3", "解释器"), h("span.sp"),
          shOk ? h("span.chip.green", "找到了") : h("span.chip.red", "没找到")),
        h("label.field", h("span", "sh 路径 · 留空 = 自动探测"), h("div.row", executable, auto)),
        h("p.dim.mt", shOk
          ? h("span", "此刻解析到 ", h("code", c.sh.path))
          : h("span", c.sh?.reason || "找不到 sh。")),
        h("p.dim.mt", "只有一种 shell：POSIX sh（Unix 自带；Windows 来自 Git for Windows）。"
          + "模型写出来的命令因此在所有机器上是同一套语法。"))),
    h("section.card",
      h("div.card-h", h("h3", "边界")),
      h("div.grid2", h("label.field", h("span", "超时（秒，1–600）"), timeout)),
      h("p.dim.mt", "超时会杀掉整棵进程树并如实报告；输出超过 4 MiB 时只保留开头。"
        + "工作目录是会话的工作目录，但命令可以故意走出去——这正是它与 dotnet_build / dotnet_test 的分界。"),
      h("div.row-end", test, save, h("span.sp"), err)),
    result);
}

// ---------------- system ----------------
async function system(root) {
  await loadRegistries();
  const i = app.info || {}, hl = app.health || {};
  const originOk = !i.allowedOrigin || i.allowedOrigin === location.origin;
  const coreInp = h("input.inp.mono", { value: app.core.base, "aria-label": "核心地址" });
  root.append(h("div.sys-grid",
    h("section.card",
      h("div.card-h", h("h3", "核心"), h("span.sp"), hl.ok ? h("span.chip.green", "健康") : h("span.chip.red", "没应答")),
      h("div.kv",
        kvr("版本", h("code", i.coreVersion || "—")),
        kvr("数据根", h("code", i.dataRoot || "—")),
        kvr("工作目录", h("code", i.workingDirectory || "—")),
        kvr("内存里的会话", h("span.num", fmtNum(hl.sessions))),
        kvr("HTTP", h("code", i.endpoints?.http || app.core.base)),
        kvr("WS", h("code", i.endpoints?.ws || app.core.wsUrl)),
        kvr("帧统计", h("span.num", `收 ${app.core.stats.in} · 发 ${app.core.stats.out}`)))),
    h("section.card" + (originOk ? "" : ".card-bad"),
      h("div.card-h", h("h3", "WS 白名单"), h("span.sp"), originOk ? h("span.chip.green", "吻合") : h("span.chip.red", "不吻合")),
      h("div.kv", kvr("核心放行", h("code", i.allowedOrigin || "—")), kvr("本页 origin", h("code", location.origin))),
      originOk ? h("p.dim.mt", "浏览器握手会被核心接受。") : h("div.mt",
        h("p", "核心会静默拒绝本页的 WS 握手（浏览器拿不到 403 的原因）。两条路："),
        h("ol",
          h("li", "用 ", h("code", i.allowedOrigin), " 打开本页（注意 localhost ≠ 127.0.0.1）"),
          h("li", "或让核心放行本页：设 ", h("code", "LILARA_ALLOWED_ORIGIN=" + location.origin), " 后重启核心")))),
    h("section.card",
      h("div.card-h", h("h3", "核心地址")),
      h("p.dim", "页面直连核心，不代理。也可以用 ", h("code", "?core=http://…"), " 打开。"),
      h("div.row", coreInp, h("button.btn.btn-sm", { type: "button", onclick: () => { store.set("core", coreInp.value.trim().replace(/\/+$/, "")); location.reload(); } }, "换并重连")),
      h("button.btn.btn-sm.btn-ghost.mt", { type: "button", onclick: () => { store.del("core"); location.reload(); } }, "恢复默认")),
    h("section.card",
      h("div.card-h", h("h3", "行为轴注册表"), h("span.dim", "/axes")),
      h("div.axes-reg", ...(app.axes?.axes || []).map((a) => h("div.ar", h("b", a.label), h("code.dim", a.name), h("div.ar-v", ...a.values.slice(0, 8).map((v) => h("span.chip.mono", v)), a.values.length > 8 ? h("span.dim", ` … 共 ${a.values.length} 档`) : null)))),
      h("p.dim.mt", "跨轴告警：安全 = ", h("code", app.axes?.alertSafety), " 且权限 ≥ ", h("code", app.axes?.alertFrom))),
    h("section.card",
      h("div.card-h", h("h3", "原始数据")),
      h("div.row-wrap",
        ...["/info", "/health", "/axes", "/providers", "/provider-schema", "/claims", "/projects", "/sessions", "/usage/summary"].map((p) =>
          h("button.btn.btn-sm.btn-ghost", { type: "button", onclick: async () => { try { modal("GET " + p, jsonBlock(await app.core.get(p)), { wide: true }); } catch (e) { toast(e.message, "err"); } } }, h("code", p)))))));
}
