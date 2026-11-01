# CADENZA · Lilara 的舞台

> 版本 1.0.0 · 华彩乐段：乐队停下，独奏者即兴。你指挥，它演奏。

Cadenza 是 Lilara 核心（`AgentLilaraCode`）的浏览器前端，照 `../09-控制面API参考.md` 实现。
页面直连核心的 HTTP 快照与一条 WebSocket，不代理、不缓存、不理解业务。

零依赖、零构建：`index.html` + 原生 ES 模块 + 四份 CSS。没有 npm，没有 CDN，没有联网资源。

## 启动

```bash
# 1. 起核心（端口 17988；默认监听 0.0.0.0，WS 白名单是**模式** http://*:17990，
#    并且每次启动都把访问 token 打印在横幅里——见下面「访问 token」）
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
> 头也可以指到别处的核心（`--core` / 页面 `?core=`）。跨机器时注意两件事：核心的 WS 白名单默认是
> **模式** `http://*:<头端口>`（任意主机、端口钉住 ⇒ 别的设备的局域网地址也进得来，`LILARA_ALLOWED_ORIGIN`
> 可把主机也钉死；设成 `*` 是放行任意 origin，只该调试时用）；以及核心开了鉴权时页面要填 token。

打开 **`http://127.0.0.1:17990`**（`localhost:17990` 也行——白名单按**端口**认，主机名不参与；
端口对不上时握手会被静默拒绝，页面会拉 `/info.allowedOrigin` 并在顶部横幅写清是哪个端口）。
万一连不上而横幅说是「被拒握手」，那句话来自同一份判据（见 `js/core.js` 的 `originMatches`）。

### 访问 token

核心（`LILARA_AUTH=1` 时）会校验一个**每次启动重新生成**的 token，并把它打印在自己控制台的启动横幅里
（`访问 token …` 那一行）。默认**不校验**——那时 token 照样打印，只是没人问。Cadenza 这一侧：

| | 怎么做 |
|---|---|
| HTTP | 每条请求都带 `Authorization: Bearer <token>`（`core.js` 的 `_req`，一处出口） |
| WebSocket | 只能走查询参数 `?token=<token>`——浏览器的 `WebSocket` 构造函数**不能自定义请求头** |
| 图片 / 库链接 | `<img src>` / `<a href>` 同样只能走查询参数（`blocks.js` 的 `storeUrl`） |
| 存在哪 | 本机存储 `cadenza.token`（刷新不用重填；清掉就是「没有 token」） |
| 怎么填 | 页面自己铺一层闸（`.token-gate`）：粘进去 → 保存 → 整页重载。后台「系统」页也有同一格，用于换 / 清 |
| 401 | 一律先**清掉**存着的那份再弹闸：核心每次启动都换 token，昨天那份今天必然失效 |
| 没有 `/info` 也一样 | `/info` 是唯一豁免鉴权的端点；未授权时它**照样回 200**，只是少了 `dataRoot` / `workingDirectory` 那几格，并多一个 `authRequired: true` |

⚠️ **代价说清楚**：控制面是明文 HTTP。token 拦得住「随手连上来的人」，挡不住同一网段里的嗅探者；
它是「谁都能用」与「谁都不能用」之间的一道闸，不是加密。要真的防嗅探，得上 TLS 或隧道。

和 Aquarius 用同一个默认端口，两个头同时开要给其中一个换端口。

## 四个视图

| | 视图 | 内容 |
|---|---|---|
| I | **舞台** | 节目单（按项目分组的会话，演奏中 ♪ / 等你 𝄐 / 休止 𝄽）· 总谱（历史分页 + 实时合流，工具调用与结果按 `callId` 配对，系统事件画成谱面记号）· 提示卡（授权 / 提问，四种形状全支持）· 调音台（上下文仪表、行为轴推子与权限阶梯、**剩余计划树 + 固定 T0**、**后台任务清单**、换调、三个提示词槽位、文件声明） |
| II | **总谱** | WS 每一帧（过滤 / 方向 / 暂停 / 原始 JSON）+ 命令台：25 条命令全覆盖（含计划编辑、模型目录查询与后台任务三条），表单或原始 JSON |
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
- **后台任务**（核心 2026-10-27）：`shell` / `dotnet_build` / `dotnet_test` 的 `background: true` 起的是
  **真进程**，立刻返回 `job-…`；`jobs` / `job_output` / `job_kill` 是模型侧的三个工具，`wait(task=…)` 是等它。
  头的这一侧：
  - 调音台的**任务**页签读 `GET /sessions/{id}/jobs`（结构化），**停止**发 `job.kill`（有回执、有拒绝理由）。
    输出按字节窗口读 `GET /sessions/{id}/jobs/{jobId}/output?offset=`，**累积显示**而不是「后一段盖掉前一段」
    ——`job_output` 是窗口，不是文件，覆盖式显示会让人把中段当成开头。
  - 轮询有三条闸：有任务在跑、或者正看着那个页签、并且页面没被隐藏；打开会话时只拉一次。
    标题栏的「⏳ N 在跑」chip 读同一份数据（`model.js` 不另存一份），点了跳过去。
  - **核心没有任务事件**：任务结束只表现为会话流上一对合成调用（`job_output` 的自动回报，callId 就是
    `job-…`）。所以时间线不需要新代码——它按普通工具卡配对画；头只在每次工具结果后叫一声，
    由任务面板自己决定要不要重拉（400ms 去抖）。
  - 工具结果里出现 `job-…` 时，卡上多一条「在任务面板里打开」——那是从「我刚起的任务」到「它现在怎么样」
    之间唯一不靠翻菜单的路。
  - ⚠️ 停止**不受模型权限轴管**（核心的裁定：撤回类动作放低门槛）：模型把权限拨到 `off` 之后，
    用户仍然停得掉自己机器上的进程。头如实照做，不额外加一道闸。
- **访问 token 只在核心开了鉴权时才有存在感**：默认（不校验）时页面一条请求都不多带、不弹闸，
  状态栏也因为 `authRequired:false` 不占那一格。开了之后 HTTP 走 `Authorization: Bearer`、
  WS 与图片走 `?token=`；401 一律先清掉本机存着的那份再弹闸——核心每次启动都换 token，
  留着旧的那份只会让人以为「已经填过」。判据是 `/info.authRequired`，**不是**「`/info` 是不是失败」：
  未授权时它照样回 200，只是不交本机路径那几格。
- **WS 白名单是模式，不是逐字相等**（核心 `2026-11-05` 起）：默认 `http://*:<头端口>`，主机名通配、
  端口钉死。于是 `localhost` 与 `127.0.0.1` 都能用，换一台设备用局域网地址打开也能用；
  而随便一个网页（端口对不上）照样进不来。头这边有一份**最小镜像**（`js/core.js` 的 `originMatches`，
  与核心 `OriginMatcher` 同一套判据），用途仅限「把话说对」——真正拦人的是核心。
- **归档会话的拉法是分开的**（核心 `b1d6df9` 起）：`GET /sessions` 只给**未归档**的那些，归档那份走
  `GET /sessions/archived`（行形状逐字相同，`archivedAt` 有值）。所以「一个端点拿全 + 本地过滤」的旧写法
  在新核心上会一条归档都画不出来：节目单默认**一条归档都不拉**，勾上「显示已归档」才多打一次那个端点；
  行的 `archivedAt` 会跟本机记的那一份对账（在别的窗口归档/取消归档过，这是唯一会对上的地方）。
  旧核心没有那个端点 ⇒ **404 按旧行为退回**（归档的仍混在 `/sessions` 里，靠行自带的 `archivedAt` 藏）。
  打开一条不在列表里的会话（归档的、或从时间线点进来的已归档子会话、或重开页面恢复上次那一场）时，
  行由 `GET /state` 快照补（`seedRowFromSnapshot`），不当成「会话不存在了」。

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
重试中中断不留下「超时」那句）、
后台任务（`14-jobs`：`shell background:true` 起真进程 → 工具卡上给出 `job-…` 与跳转 →
标题栏「⏳ 在跑」→ 任务页签里的状态 / 输出第一行 → 停止后变「已停止」而输出仍读得到 →
核心注入的自动回报成对出现 → 模型自己 `jobs` 盘点时列的是同一个 id → `wait(task=…)` 的卡片与配对）、
归档的拉法（`15-archive`：建一场会话 → 归档 → 新的 `/sessions` 里没有它 → 勾「显示已归档」才从
`/sessions/archived` 拉回来（带 `archivedAt`）→ 再取消勾选它又不在内存里 → 这时打开它仍然开得起来
（行由 `/state` 快照补）→ 删掉）、
访问 token（`17-auth`，**要单独跑**：`run.ps1 -Auth` 用 `LILARA_AUTH=1` 起核心、把 token 从启动横幅里抠出来、
替换步骤脚本里的 `@TOKEN@`，并先用 `/info` 验一遍那把 token——验不出就直接报错，不会伪装成前端坏了。
脚本本身：没 token → 闸自己出现（不是猜出来的）、错 token → 闸上说「token 不对」且存着的那份被清掉 →
粘对的走闸的输入框提交 → 连上、`/info` 交出 `dataRoot`、WS 的 URL 带 `?token=`、图片地址带 `?token=` →
后台系统页说「核心在校验 / 已带 token」、白名单认模式（`任意主机，端口 17994` 判「吻合」）→
点「清除」回到「要 token」）。
⚠️ `17-auth` **不在默认脚本列表里**：那个核心会 401 掉别的所有人。
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
│  ├─ core.js          HTTP + WS：订阅游标、命令回执、重连、projectKey 计算、**访问 token**、origin 模式判据
│  ├─ model.js         全局状态：会话、项目、待审批、注册表
│  ├─ blocks.js        块渲染（text / reasoning / toolUse / image / store）
│  ├─ timeline.js      一个会话的历史 + 实时合流（幂等、配对、分页）
│  ├─ approvals.js     提示卡（choice / text / form / verbatim、remember、倒计时）
│  ├─ stage.js         舞台：节目单、总谱、输入框、新会话
│  ├─ mixer.js         调音台（行为轴 / 计划 / 后台任务 / 模型 / 槽位 / 声明）
│  ├─ score.js         总谱视图：帧流 + 命令台
│  ├─ ledger.js        账簿（SVG 图表）
│  ├─ greenroom.js     后台
│  ├─ viz.js           顶栏事件谱（canvas）
│  ├─ palette.js       Ctrl+K
│  └─ app.js           启动、路由、连接、键盘
└─ e2e/                cdp.cs · mock.cs · run.ps1 · 1..17 步骤脚本（17 要 `-Auth` 单独跑）
```

## 已知边界

- 图片能看、也能发：核心 2026-10-29 那批给了 `POST /files` 与 `GET /store/{sha256}`，输入区因此有「＋ 图」/ 粘贴 / 拖放三个入口（先上传拿 `ref`、再 `session.send` 带 `image` 块），历史里的图按地址取字节显示。**仍未做**：附件按工作区落盘的 `path=` 形态、`workspace.file.added` 那类外部变更提示。
- 预设只能覆盖写：核心没有读预设内容的端点。
- 核心没有改名命令，标题只在建会话时起一次。
- 「工具结果是不是失败」是按结果文本里的关键字猜的（核心不给结构化状态），只影响颜色。
- **默认没有鉴权**：核心不设 `LILARA_AUTH=1` 时，任何能连到 17988 的人/程序都能驱动它（模型、工具、本机可读文件）。
  页面这一侧不再假装安全：核心一开鉴权，401 会立刻弹 token 闸（见上面「访问 token」）。
- **静态宿主仍只绑 127.0.0.1**（`serve.ps1` 的 `$prefix`、`serve.sh` 选中的服务器同理）：核心已经把白名单放开成
  按端口认，但头没有 `--bind`，所以今天还是只有本机能打开页面。要在手机/平板上用，得先给头加一个监听地址参数
  （核心自己的头已经默认 0.0.0.0，这件事在 Cadenza 这边还没做）。
- **`serve.sh` 只在 Git Bash 上测过**它的分支逻辑（参数、自检、缺服务器提示）；它选中的三个服务器
  里，`serve.py` 与 `serve-router.php` **没有在 macOS / Linux 上真正跑过一次**（本机两者都没装）。
  首次在 Linux 上跑时请先看那两行「服务器：…」的输出对不对。
