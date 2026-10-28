# CADENZA · Lilara 的舞台

> 版本 1.0.0 · 华彩乐段：乐队停下，独奏者即兴。你指挥，它演奏。

Cadenza 是 Lilara 核心（`AgentLilaraCode`）的浏览器前端，照 `../09-控制面API参考.md` 实现。
页面直连核心的 HTTP 快照与一条 WebSocket，不代理、不缓存、不理解业务。

零依赖、零构建：`index.html` + 原生 ES 模块 + 四份 CSS。没有 npm，没有 CDN，没有联网资源。

## 启动

```bash
# 1. 起核心（默认 127.0.0.1:17988，WS 默认只放行 http://127.0.0.1:17990）
#    发布的单文件版（见 AgentLilaraCode/publish）或从源码 dotnet run 都行
cd E:\Workspace\AgentLilaraCode\src\Lilara.Core && dotnet run -c Debug

# 2. 起 Cadenza（静态宿主，默认 17990，正好是核心白名单）
#    Windows：
powershell -NoProfile -ExecutionPolicy Bypass -File Cadenza\serve.ps1
#    macOS / Linux / WSL / Git Bash：
./Cadenza/serve.sh
```

两个脚本是**同一份契约的两个实现**（参数名、默认值、启动自检、报错措辞对齐；改一个必须改另一个）：

| 参数 | `serve.ps1` | `serve.sh` |
|---|---|---|
| 端口 | `-Port 17991`（或 `LILARA_HEAD_PORT`） | `--port 17991`（或 `LILARA_HEAD_PORT`） |
| 核心地址 | `-Core http://…`（或 `LILARA_CORE`） | `--core http://…`（或 `LILARA_CORE`） |
| 根目录 | `-Root …` | `--root …` |
| 跳过自检 / 不打开浏览器 | `-NoCheck` / `-NoOpen` | `--no-check` / `--no-open` |
| 只开浏览器 | — | `--open-only` |

两个脚本都会**自动打开浏览器**（`--no-open` / `-NoOpen` 关掉）；自动化（e2e）就是靠这个开关
避免在跑测试时弹出窗口。

`serve.sh` **不内置** HTTP 服务器——它按顺序挑这台机器上现成的：
`php -S`（最推荐，配 `serve-router.php` 关掉缓存）→ `python3`（配 `serve.py`，同样 no-store）
→ `busybox httpd`（⚠️ 不关缓存）。三个都没有时它会明确说明装哪一个，而不是静默降级。

> ⚠️ 发布的核心单文件**不含前端**：`Cadenza/` 目录要跟着一起分发（它本来就是零构建的静态文件）。
> 头也可以指到别处的核心（`--core` / 页面 `?core=`），跨机器时注意核心的 WS 白名单只放行
> `http://127.0.0.1:<头端口>`（`LILARA_ALLOWED_ORIGIN` 可改）。

打开 **`http://127.0.0.1:17990`**（不是 `localhost`——那是另一个 origin，核心会静默拒绝握手；
页面会拉 `/info.allowedOrigin` 比对，并在顶部横幅说清原因）。

和 Aquarius 用同一个默认端口，两个头同时开要给其中一个换端口。

## 四个视图

| | 视图 | 内容 |
|---|---|---|
| I | **舞台** | 节目单（按项目分组的会话，演奏中 ♪ / 等你 𝄐 / 休止 𝄽）· 总谱（历史分页 + 实时合流，工具调用与结果按 `callId` 配对，系统事件画成谱面记号）· 提示卡（授权 / 提问，四种形状全支持）· 调音台（上下文仪表、行为轴推子与权限阶梯、**剩余计划树 + 固定 T0**、换调、三个提示词槽位、文件声明） |
| II | **总谱** | WS 每一帧（过滤 / 方向 / 暂停 / 原始 JSON）+ 命令台：23 条命令全覆盖（含计划编辑与模型目录查询），表单或原始 JSON |
| III | **账簿** | token 账本：五个总数、逐次调用的堆叠柱图（缓存读 / 输入 / 输出同柱，自下而上）、按天堆叠、按模型 / 提供商拆分、明细（点开看原始记录），历史载入条数可填 |
| IV | **后台** | 提供商增删改 + 试音（含每个提供商单独的**调用超时**），系统提示词预设，**联网配置**（启用 / Tavily key / 端点 / 上限 / 域名白名单 / 试搜），**Shell 配置**（总开关 / `sh` 路径或自动探测 / 超时 / 试一下），系统自检（版本 / 数据根 / WS 白名单吻合与否 / 原始端点） |

顶栏那条谱**只有一条**：音符 = 会话真的做了什么（起步 / 等你 𝄐 / 完成 / 出错 ✕ / 重试 / 压缩 / 目标切换），
越靠上越需要你看一眼（顶线＝等你或出错的邻居，底线＝跑完一轮），♩ = 每分钟行为数；
网络帧退成谱面后的淡竖线，同一族 260ms 内连发合并成一根，越密越亮越粗。悬停可看详情；右下角 ♪ 打开音量面板（默认关闭，主音量 + 每个音各自一段，命令面板里也有同一入口）。

节目单里「刚跑完、还没打开看过」的会话会一直亮着（行尾一行「待查看」）：点开它就熄灭——
打开就是「检查过进度」这个动作，不按时间自动消失。

快捷键：`Ctrl+K` 命令面板 · `Alt+1..4` 切视图 · `Alt+N` 新会话 · `/` 聚焦输入框 · `Enter` 发送 / `Shift+Enter` 换行。草稿按会话存本机。

## 协议上的取舍

- 打开会话：先 `GET /state` 拿 `highWater` → `subscribe(session:id, since)` → 拉历史。中间落下的事件靠补发，重复的靠幂等键去掉（`message.appended` 按 `historyId`，`tool.result.appended` 按 `id`）。
- `resync_required` 或断线重连 ⇒ 重新拉快照、重新订阅，不做部分合并。
- `accepted:true` 只代表受理；业务失败看 `error` 事件，画成「不和谐音」记号。
- 授权批准发 `answers.decision:"allow"`；改写过参数才带 `answers.arguments`（只换排版的 JSON 不算改写）；`remember` 只发 `"args"` / `"tool"`。
- 有询问在等时直接发消息会先确认——核心会把那次询问顶替掉（`superseded`）。
- `GET /sessions` 的 `ask` 判 `ask?.askId`；`title` 缺省；用量里的 `null` 显示 `—`，不当 0 加。
- **会话状态只有一份**：`model.js` 的 `onGlobalEvent` 是唯一的折叠口，节目单、标题栏、演奏条、
  中断键、等你按钮、状态栏、命令面板都从同一行读。`session.state` / `step.*` / `error` / `retry.attempt`
  只发在会话流上，所以**所有在内存里的会话**都订阅它的会话流，不只是打开的那个。
- 核心在 `error` 之后、在询问被作废 / 顶替之后**都不发** `session.state`——头据此自己落回休止，
  再拉一次 `/sessions` 对账；对账时比事件旧的快照不覆盖事件。
- `retry.attempt`：演奏条变成「重奏 N/10」+ 原因 + 倒计时（用核心给的 `delayMs`，不自己算曲线）；
  同一次调用的重试在时间线上合成一条记号，用尽后由 `error` 接手。
- 用量口径（核心 `d1c0895`）：`inputTokens` 是**未命中输入**，全部输入 = `inputTokens + cacheReadTokens`；
  命中率用核心给的 `cacheHitRate`（分母只算报了缓存的调用）。上下文仪表读的是全部输入。
- 上下文仪表的满刻度固定按 1M 窗口（核心不报窗口大小），只是刻度。
- **联网是两道闸**：调音台的 `network` 轴（`off|search|fetch|all`，每会话）决定这个会话能碰哪类联网工具；
  后台「联网」页是设备级的凭据 / 端点 / 上限。轴开着但后台未启用（或权限档位不允许消耗型工具）时，
  工具卡会说明是哪一道闸。
- **shell 与 `delete` 同级**（高危 / `Destructive`）：`standard` 及以下**硬拒**、`authorized` 问一句、
  `trusted` 才直接放行。后台「Shell」页只管设备级的三件事（总开关 / `sh` 路径 / 超时），
  「这个会话能不能跑命令」永远在调音台的权限轴上。工具卡上是 `❯ shell <第一行命令>`，完整脚本在展开后的参数原文里。
  调音台会直接写出原因，不让人对着「拨了没反应」猜。`web_search` / `web_fetch` 的请求与结果都走普通工具卡。
- **goal 模式**：主动性轴拨到 `goal` 后，模型停回合而目标未收时核心会自动续跑；会话行与标题栏出现
  「⚑ 目标」chip。结束靠模型调 `finish_goal`——它只把轴拨回 `standard`，拨回后还会多跑一步让模型收尾。
  用户点停止是真停（目标仍在，下次发话或「推进」才继续）；不设步数上限。
- 「归档」状态只在打开过的会话上知道（`/sessions` 不带 `archivedAt`），节目单靠本机记的一份来隐藏。

## 验证

`e2e/` 是一套无依赖的端到端测试：隔离的核心（独立数据根、端口 17989）+ 模拟 OpenAI-chat 上游 +
无头 Chrome（CDP，dotnet 单文件脚本驱动）。不碰 `~/.lilara`。

⚠️ **`e2e/run.ps1` 仍在 Windows 上跑**（它拉核心 exe、无头 Chrome 与 `serve.ps1` 都用
`Start-Process` / `taskkill`）。`serve.sh` 的启动路径在 Linux 上**还没有自动化覆盖**——
它自己的自检 / 参数 / 缺服务器提示是手测的（见下面「已知边界」）。

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File e2e\run.ps1
```

覆盖：配提供商与试音、目录浏览建会话、markdown / 推理 / 代码块渲染、只读工具自动执行、写工具
授权（改写参数后批准，落盘内容是改写后的）、choice + text + form 提问、轴切换与跨轴告警、温度推子、
换模型、槽位、上游失败、中断、刷新后历史重放、账簿 / 总谱 / 后台、命令面板、窄屏布局、
调音台不溢出（`6-mixer-fit`）、状态同步（`7-sync`：瞬态失败重试、重试中中断、非瞬态失败、
作废询问、后台会话的运行 / 出错 / 重试 / 等你都不刷新就跟上）、本地搜索（`8-search`）、
联网（`9-network`：后台开启 → 调音台拨轴 → 搜索工具往返 → 拨回 off 后拒绝理由）、
goal 模式（`10-goal`：无用户输入自动续跑、`finish_goal` 拨回 standard 且多跑一步收尾、中断真停）、
shell（`11-shell`：后台自检 → `standard` 档被拒且进程没起 → `trusted` 档真跑出输出 → 中断长命令）、
提供商超时（`12-provider-timeout`：卡片没配显示「(默认)」→ 填 600 落盘 → 非整数在前端被拦 →
清空不发这个键 → `0` 由核心拒 → 调到 2 秒后慢上游真的被掐断、重试附注带上「单次上限 2 秒」→
重试中中断不留下「超时」那句）。
⚠️ shell 的中断用例**盘上是物证**：跑完 `e2e\run.ps1` 后，`%TEMP%\cadenza-e2e\proj\shell-started.txt` 应当在、
而 `shell-finished.txt` **不该**在（命令在 `sleep` 期间被杀掉了）；浏览器看不到文件系统，所以这一步没有自动断言。
模拟上游带一个 Tavily 形状的 `/search` 端点，联网工具的可配置端点就指过去——**不连真网**。
核心从 `AgentLilaraCode` 的工作区现编（`src/Lilara.Cli`）。
`5-reconnect.txt` 要在它等待时手动杀掉再起核心（验证断线横幅、自动重连、去重）。

## 目录

```
Cadenza/
├─ index.html          外壳：顶栏（视图 / 事件谱 / 等你 / 面板 / 连接）、横幅、四个视图、状态栏
├─ serve.ps1           静态宿主 · Windows（127.0.0.1，no-store，启动时自检 WS 白名单）
├─ serve.sh            静态宿主 · macOS / Linux / WSL（同一份契约；挑现成的 php / python3 / busybox）
├─ serve.py            serve.sh 的 python3 落点（no-store + /config.json）
├─ serve-router.php    serve.sh 的 php -S 路由（只补 no-store 与 /config.json）
├─ css/  base · shell · stage · views
├─ js/
│  ├─ util.js          DOM / 格式化 / toast / 对话框 / JSON 高亮 / 本机存储
│  ├─ md.js            安全的小 markdown（先转义，只产出自己的标签）
│  ├─ core.js          HTTP + WS：订阅游标、命令回执、重连、projectKey 计算
│  ├─ model.js         全局状态：会话、项目、待审批、注册表
│  ├─ blocks.js        块渲染（text / reasoning / toolUse / image / store）
│  ├─ timeline.js      一个会话的历史 + 实时合流（幂等、配对、分页）
│  ├─ approvals.js     提示卡（choice / text / form / verbatim、remember、倒计时）
│  ├─ stage.js         舞台：节目单、总谱、输入框、新会话
│  ├─ mixer.js         调音台
│  ├─ score.js         总谱视图：帧流 + 命令台
│  ├─ ledger.js        账簿（SVG 图表）
│  ├─ greenroom.js     后台
│  ├─ viz.js           顶栏事件谱（canvas）
│  ├─ palette.js       Ctrl+K
│  └─ app.js           启动、路由、连接、键盘
└─ e2e/                cdp.cs · mock.cs · run.ps1 · 1..12 步骤脚本
```

## 已知边界

- 图片 / 库对象只能显示地址：核心没有 `GET /store/{sha256}`。附件上传（`POST /files`）也没有，页面不给假入口。
- 预设只能覆盖写：核心没有读预设内容的端点。
- 核心没有改名命令，标题只在建会话时起一次。
- 「工具结果是不是失败」是按结果文本里的关键字猜的（核心不给结构化状态），只影响颜色。
- 没有鉴权（核心「本机即可信」的设计）；核心只绑 127.0.0.1，静态宿主也只绑 127.0.0.1。
- **`serve.sh` 只在 Git Bash 上测过**它的分支逻辑（参数、自检、缺服务器提示）；它选中的三个服务器
  里，`serve.py` 与 `serve-router.php` **没有在 macOS / Linux 上真正跑过一次**（本机两者都没装）。
  首次在 Linux 上跑时请先看那两行「服务器：…」的输出对不对。
