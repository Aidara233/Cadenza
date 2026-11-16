# CADENZA — 页面宿主 + 控制面反代（Windows）。
#
# **页面不直连核心了：连核心的是这个进程。** 浏览器只打开本脚本服务的那一个源，
# 页面把 `/core/*` 发回本进程，本进程再转发给核心（HTTP 与 WebSocket 两条都转）。
#
# 为什么值得这么绕（这是用户 2026-11-14 的裁定，见 README「谁在连核心」）：
#   · **token 不进浏览器**：本进程握着核心的 token（-Token / LILARA_CORE_TOKEN），
#     页面一条请求都不带它，localStorage 里也不存；
#   · **一个源**：页面与 API 同源 ⇒ 没有 CORS、没有混合内容（https 页面打 http 核心）、
#     没有「本页 origin 不在核心白名单里」那类握手被静默拒绝的事故；
#   · **WS 白名单不再拦人**：核心只在握手**带了 Origin** 时才较真，而本进程不是浏览器、
#     不发 Origin（核心 `OriginMatcher` 的前提就是这个）。于是换设备、换地址、走隧道、上
#     https 都不用再去改 `LILARA_ALLOWED_ORIGIN`。
#
# ⚠️ **与 serve.sh / serve.py 是同一份契约的三个实现**（用户裁定 2026-10-23：只做跨平台脚本，
#    不另起一个 exe 宿主）。参数名、默认值、启动自检、`/core` 前缀、报错措辞要对齐——
#    这一对**曾经漂过**：改这里时**必须**同时改 serve.sh / serve.py，反之亦然。
#
# 用法：
#   powershell -NoProfile -ExecutionPolicy Bypass -File Cadenza\serve.ps1
#   powershell ... -Port 17990 -Core http://127.0.0.1:17988
#   powershell ... -Bind 127.0.0.1      (收回仅本机；默认 0.0.0.0，Windows 需要 URL ACL，见下)
#   powershell ... -Token <核心的访问 token>   (核心开了 LILARA_AUTH=1 时；也可用 LILARA_CORE_TOKEN)
#
# 停止：Ctrl+C（或杀掉进程）。

param(
    [int]$Port = 17990,
    # **上游**：本进程替页面连的那个核心。与页面里的 `?core=` 是两件事——那个是「页面自己直连」。
    [string]$Core = "http://127.0.0.1:17988",
    [string]$Root = $PSScriptRoot,
    # 监听地址。**默认对局域网开放（0.0.0.0）**——与核心 2026-11-05 那个裁定一致：
    # 同一网络里的手机/平板直接打开页面，而不是默认不可用。真要收回本机：-Bind 127.0.0.1。
    # ⚠️ Windows 上有一道额外的坎：`HttpListener` 绑回环之外的前缀需要一条 URL ACL，
    # 没有它 Start() 报「拒绝访问」。那种情况下本脚本**不会就地死掉**——它会印出那条
    # netsh 命令，然后**退回仅本机**接着服务（页面在本机能用，手机连不上，横幅里说清楚）。
    # ⚠️ **加了那条 `+` 的保留之后，`-Bind 127.0.0.1` 会反而绑不上**（本机实测）：http.sys
    # 让 `http://+:端口/` 可用，却拒绝同一端口上更具体的 `http://127.0.0.1:端口/`。
    # 要回环就把那条保留删掉（netsh http delete urlacl），别两个都要。
    [string]$Bind = "0.0.0.0",
    # 核心的访问 token（`LILARA_AUTH=1` 才需要）。**这是本脚本替页面交的那一份**：
    # 配了它，页面就一条凭据都不带（也不该带——见 README「访问 token」）。
    # 不配的话，页面自己经 `/core` 转过来的 `Authorization` 会被原样转给核心（旧形态仍然能用）。
    [string]$Token = "",
    # 2026-10-23：与 serve.sh 的 --no-check / --no-open 对齐。默认会自检并打开浏览器；
    # 自动化（e2e、脚本拉起）用这两个开关关掉。
    [switch]$NoCheck,
    [switch]$NoOpen
)

$ErrorActionPreference = "Stop"
try { [Console]::OutputEncoding = [System.Text.Encoding]::UTF8 } catch { }

# 环境变量是默认值的来源（与 serve.sh / 核心自己的头同名），命令行参数优先。
if (-not $PSBoundParameters.ContainsKey("Bind") -and $env:LILARA_HEAD_BIND) { $Bind = $env:LILARA_HEAD_BIND }
if (-not $PSBoundParameters.ContainsKey("Port") -and $env:LILARA_HEAD_PORT) {
    $p = 0; if ([int]::TryParse($env:LILARA_HEAD_PORT, [ref]$p) -and $p -gt 0) { $Port = $p }
}
if (-not $PSBoundParameters.ContainsKey("Core") -and $env:LILARA_CORE) { $Core = $env:LILARA_CORE }
if (-not $PSBoundParameters.ContainsKey("Token") -and $env:LILARA_CORE_TOKEN) { $Token = $env:LILARA_CORE_TOKEN }
$Core = $Core.TrimEnd("/")
$Token = "$Token".Trim()

# 控制面在页面这一侧的前缀。**三个实现必须逐字相同**：页面从 `/config.json` 读到它，
# 再把每个核心路径拼在它后面（`js/core.js` 的 `coreUrl`）。
$corePrefix = "/core"

# 回环之外的任何写法都落到 `+`（HttpListener 只认通配或具体字面量，两者都要 ACL；
# `+` 与 `*` 在这里是同一个意思）。
$isLoopback = $Bind -in @("127.0.0.1", "localhost", "::1", "[::1]")
$bindHost = if ($isLoopback) { "127.0.0.1" } else { "+" }
$prefix = "http://${bindHost}:$Port/"
$listener = [System.Net.HttpListener]::new()
$listener.Prefixes.Add($prefix)

# 绑不上时的那句话——回环与非回环、有没有 URL 保留，**修法完全不同**，
# 所以这句措辞得跟着原因走，不能一律说成「端口被占」。
# ⚠️ 异常文本要**传进来**：函数里的 `$_` 不是 catch 的那个 `$_`。
function Show-BindFailure($message, $trouble) {
    Write-Host "✗ Cadenza 起不来（$prefix）：$message" -ForegroundColor Red
    if ($trouble) {
        Write-Host "  $trouble" -ForegroundColor Yellow
        if ($trouble -match 'URL 保留') {
            Write-Host "  要么就绑 +（不加 -Bind 就是它）；要么删掉那条保留再绑 127.0.0.1（管理员）：" -ForegroundColor Yellow
            Write-Host "      netsh http delete urlacl url=http://+:$Port/" -ForegroundColor Cyan
            Write-Host "  注意：删掉之后默认值（0.0.0.0 / +）反而需要一条 ACL 才能绑。"
        }
        return
    }
    if ($isLoopback) {
        Write-Host "  端口被占或落在 Windows 保留段。换个端口：-Port 17991，并设 LILARA_HEAD_PORT=17991 后重启核心。"
    } else {
        Write-Host "  绑回环之外的地址需要一个管理员身份或一条 URL ACL。要真的对局域网开放，先跑一次（管理员）："
        Write-Host "      netsh http add urlacl url=http://+:$Port/ user=$env:USERNAME" -ForegroundColor Cyan
    }
}

# 这个端口上到底出了什么事——**必须查清才说话**。
#
# ⚠️ Windows 上有个反直觉的事实（本机实测，2026-11-05）：一旦有人给某个端口加了
# `http://+:端口/` 的 URL 保留，`http://127.0.0.1:端口/` 就**绑不上**了（拒绝访问），
# 只有 `+` 能绑。于是「绑不上」至少有三种完全不同的原因，修法也完全不同：
#   · 没有保留 + 没人在听 ⇒ 就是缺 ACL（加一条，或者退回本机）；
#   · 有保留 ⇒ `+` 能用、loopback 不能；要 loopback 必须**删掉**那条保留；
#   · 已经有一个实例在跑 ⇒ 关掉它。
# 一律说成「端口被占」会把人推去改端口，而真正该做的是上面第二/第三条。
function Get-PortTrouble($p) {
    $acl = ""
    try { $acl = (netsh http show urlacl url=http://+:${p}/ 2>$null) -join "`n" } catch { }
    if ($acl -match 'http://\+:') {
        $who = ""
        if ($acl -match 'User:\s*(.+)') { $who = $Matches[1].Trim() }
        $detail = if ($who) { "（属于 $who）" } else { "" }
        return "端口 $p 上有一条 URL 保留 http://+:${p}/${detail}：它允许绑 +，但会让 http://127.0.0.1:${p}/ 被拒绝（Windows 的规矩）。"
    }
    try {
        $conn = @(Get-NetTCPConnection -State Listen -LocalPort $p -ErrorAction SilentlyContinue)
        if ($conn.Count -gt 0) {
            return "端口 $p 上已经有人在监听（PID $($conn[0].OwningProcess)）——大概是一个还在跑的 Cadenza，先把它关掉。"
        }
    } catch { }
    return $null
}

$listeningOn = $Bind
$aclBlocked = $false
$bindError = $null
try {
    $listener.Start()
} catch {
    # ⚠️ 取 InnerException：外层那句「使用“0”个参数调用“Start”时发生异常」只是壳，
    # 真正要印给用户看的是里面那句「拒绝访问。」/「端口已被占用」。
    $bindError = if ($_.Exception.InnerException) { $_.Exception.InnerException.Message } else { $_.Exception.Message }
    $trouble = Get-PortTrouble $Port

    # ⚠️ **只在「单纯缺 ACL」时退回本机**：有 URL 保留时 loopback 一定被拒（见上面 Get-PortTrouble），
    # 硬退回去只会把一条清楚的诊断变成两句一样的「拒绝访问」。
    if (-not $isLoopback -and -not $trouble) {
        # 默认值不该把「能用」变成「起不来」；手机连不上这件事由横幅说清楚，
        # 别让人对着一行「拒绝访问」自己猜是端口还是权限。
        $listener = [System.Net.HttpListener]::new()
        $listener.Prefixes.Add("http://127.0.0.1:$Port/")
        $prefix = "http://127.0.0.1:$Port/"
        $isLoopback = $true
        $listeningOn = "127.0.0.1"
        try {
            $listener.Start()
            $aclBlocked = $true
        } catch {
            $inner = if ($_.Exception.InnerException) { $_.Exception.InnerException.Message } else { $_.Exception.Message }
            Show-BindFailure $inner $null
            Write-Host "      （想绑 $Bind 也没成：$bindError——多半就是缺那条 URL ACL）" -ForegroundColor DarkYellow
            exit 1
        }
    } else {
        Show-BindFailure $bindError $trouble
        exit 1
    }
}

$types = @{
    ".html" = "text/html; charset=utf-8"
    ".js"   = "text/javascript; charset=utf-8"
    ".css"  = "text/css; charset=utf-8"
    ".json" = "application/json; charset=utf-8"
    ".svg"  = "image/svg+xml"
    ".png"  = "image/png"
    ".ico"  = "image/x-icon"
    ".woff2" = "font/woff2"
}

# `/config.json`：页面拿它决定「这次怎么连」。**这一份是本脚本与页面之间的契约**：
#   proxy     —— 控制面前缀（页面把核心路径拼在它后面）
#   upstream  —— 仅供显示与排错，页面**不该**拿它去连
#   auth      —— 谁交 token：head = 本进程（页面一条都不带）；page = 页面自己带（旧形态）
#   wsProtocol—— 头要求页面带上的 WS 子协议（HttpListener 的 `AcceptWebSocketAsync` 只接受
#                客户端**确实请求过**的那一个；核心不需要它，所以直连模式下没有这一格）
$authOwner = if ($Token) { "head" } else { "page" }
$configJson = '{"proxy":"' + $corePrefix + '","upstream":"' + $Core + '","auth":"' + $authOwner + '","wsProtocol":"cadenza"}'

Write-Host "CADENZA — http://127.0.0.1:$Port"
Write-Host "  页面 经由本进程连核心：$corePrefix/* → $Core（HTTP 与 WS 都转）"
Write-Host "  token $(if ($Token) { "由本进程持有（-Token / LILARA_CORE_TOKEN）——页面不带凭据" } else { "未配置：页面经 $corePrefix 转过来的 Authorization 会被原样转给核心" })"
Write-Host "  根目录 $Root"
Write-Host "  监听 $listeningOn$(if ($aclBlocked) { "（退回：$Bind 被 Windows 拒绝）" } elseif ($isLoopback) { "（只在本机；要对局域网开放：-Bind 0.0.0.0）" } else { "（对局域网开放）" })"
Write-Host ""

# ACL 没加时的退回：一定要说出来，否则「手机打不开」会被当成前端或核心的毛病。
if ($aclBlocked) {
    Write-Host "  ⚠️ 想绑 $Bind 但 Windows 拒了（URL ACL）——已退回仅本机（$bindError）。" -ForegroundColor Yellow
    Write-Host "     要对局域网开放，先跑一次（管理员），再重启本脚本："
    Write-Host "       netsh http add urlacl url=http://+:$Port/ user=$env:USERNAME" -ForegroundColor Cyan
    Write-Host "     在那之前，手机/平板打不开这个页面（核心那边没问题）。"
    Write-Host ""
}

# 对局域网开放时把可达地址列出来（别的设备照着输）。
# ⚠️ 页面已经不只是静态文件了：`/core/*` 这条反代把核心也带了出去，所以「这个网段里谁能
#    打开页面」现在等于「谁能驱动核心」。要拦人：本脚本 -Token（核心开了鉴权时）+ 核心的
#    LILARA_AUTH=1，或者 -Bind 127.0.0.1 只留本机。
if (-not $isLoopback) {
    Write-Host "  ⚠️ 对局域网开放：同一网络里的设备都能打开页面，**并且能经 $corePrefix 驱动核心**。" -ForegroundColor Yellow
    Write-Host "     核心自己绑哪里已经不重要了（是这台在转发）；要收回本机：-Bind 127.0.0.1。"
    Write-Host "     要拦人：核心设 LILARA_AUTH=1，再把 token 交给本进程（-Token）。"
    try {
        [System.Net.Dns]::GetHostAddresses([System.Net.Dns]::GetHostName()) |
            Where-Object { $_.AddressFamily -eq [System.Net.Sockets.AddressFamily]::InterNetwork -and
                           -not [System.Net.IPAddress]::IsLoopback($_) } |
            ForEach-Object { Write-Host "     可达地址 http://$($_):$Port" }
    } catch { }
    Write-Host ""
}

# 启动自检：把「致命但安静」的那一件事说出来。
# ⚠️ 这里查的是**本进程到上游**那条路（页面到本进程是通的——页面就是在这里发出来的）。
# ⚠️ **不再**检查 WS 白名单吻合与否：握手是本进程发的、不带 Origin，核心一律放行
#    （以前那句「设 LILARA_HEAD_PORT=$Port 后重启核心」在代理模式下已经无从谈起）。
if (-not $NoCheck) {
    try {
        $info = Invoke-RestMethod -Uri "$Core/info" -TimeoutSec 2 -ErrorAction Stop
        Write-Host "  ✓ 上游在：$Core（版本 $($info.coreVersion)）" -ForegroundColor Green
        if ($info.authRequired -eq $true) {
            if ($Token) {
                Write-Host "  ✓ 核心开了鉴权（LILARA_AUTH=1），token 由本进程持有" -ForegroundColor Green
            } else {
                Write-Host "  ⚠️ 核心开了鉴权（LILARA_AUTH=1），而本进程没配 token。" -ForegroundColor Yellow
                Write-Host "     token 在核心的控制台启动横幅里（访问 token … 那一行）。两条路："
                Write-Host "       · 交给本进程（推荐，页面就不带凭据了）：-Token <token> 或设 LILARA_CORE_TOKEN"
                Write-Host "       · 或者让页面自己填：页面第一次连会弹 token 闸，经 $corePrefix 转过去的核心照样认"
            }
        }
    } catch {
        Write-Host "  ⚠️ 上游没应答（$Core）：$($_.Exception.Message)" -ForegroundColor Yellow
        Write-Host "     页面会显示「Cadenza 进程连不上核心」。先把核心起起来（核心在别的机器上就给它 -Core）。"
    }
}
Write-Host ""

# ⚠️ **监听已经发生（上面 `$listener.Start()`）之后才打开浏览器**：反过来的话
# 浏览器会抢在监听之前请求，看到的是「连接被拒绝」，而它不会自动重试首屏资源（模块加载失败就是白屏）。
if (-not $NoOpen) {
    try { Start-Process "http://127.0.0.1:$Port/" | Out-Null } catch { }
}

# ---------------------------------------------------------------------------
# 请求处理（一个请求一个 runspace）
#
# ⚠️ **必须并发**：一次 WS 中继是**长连接**（页面开着就一直占着），而 HttpListener 的
#    `GetContext()` 是单线程的——把中继写在主循环里，页面加载完就再也请求不动任何东西
#    （看起来像「头死了」，实际是它正卡在一条 WS 里）。所以主循环只收连接，
#    工作（静态文件 / HTTP 反代 / WS 中继）全部扔进 runspace pool。
# ⚠️ 工作脚本用 `AddScript` 传**源码文本**：新 runspace 里没有本脚本的任何函数与变量，
#    所以它必须自足（下面的 `$worker` 里没有任何外部引用，只有 `$cfg`）。
# ---------------------------------------------------------------------------

$worker = {
    param($ctx, $cfg)

    $req = $ctx.Request
    $res = $ctx.Response
    $prefix = $cfg.Prefix
    $token = "$($cfg.Token)".Trim()

    function Write-Body($status, $ctype, [byte[]]$bytes) {
        $res.StatusCode = $status
        $res.ContentType = $ctype
        # 与静态文件同一条规矩：不许缓存（页面 + 几十个模块，看到旧副本时毫无提示）。
        $res.Headers["Cache-Control"] = "no-store"
        $res.ContentLength64 = $bytes.Length
        if ($req.HttpMethod -ne "HEAD") { $res.OutputStream.Write($bytes, 0, $bytes.Length) }
    }
    function Write-Text($status, $text) {
        Write-Body $status "text/plain; charset=utf-8" ([System.Text.Encoding]::UTF8.GetBytes($text))
    }
    function Write-Json($status, $json) {
        Write-Body $status "application/json; charset=utf-8" ([System.Text.Encoding]::UTF8.GetBytes($json))
    }
    function Fail-Upstream($what, $why) {
        # 上游不通时说清「是谁不通」：这一句会原样出现在页面的横幅里，含糊的话人会去改错的参数。
        Write-Json 502 ('{"error":"Cadenza 进程连不上核心（' + $cfg.Core + '）：' + $what + '"}')
        Write-Host "  ! 上游 $what：$cfg.Core" -ForegroundColor DarkYellow
    }

    # ---- WS 中继 ----
    #
    # 两边都是 WebSocket 对象，中间**不解析帧**：一条消息进来就整条转出去。
    # ⚠️ 上游握手**不带 Origin**（ClientWebSocket 默认不发）——这正是核心放行的前提：
    #    `OriginMatcher` 只在带了这个头时才较真。所以本进程不需要知道核心的白名单是什么。
    # ⚠️ 本进程这一侧必须挑一个页面请求过的子协议（`AcceptWebSocketAsync` 的硬约束），
    #    契约里那个名字是 `cadenza`（页面从 `/config.json` 的 `wsProtocol` 拿）。
    function Relay-Ws($upPathAndQuery) {
        $wanted = "cadenza"
        $offered = [string]$req.Headers["Sec-WebSocket-Protocol"]
        $found = $false
        foreach ($p in ($offered -split ",")) { if ($p.Trim() -eq $wanted) { $found = $true } }
        if (-not $found) {
            Write-Text 400 "本头只接受子协议 $wanted（页面里是 new WebSocket(url, '$wanted')）"
            return
        }

        try {
            $acc = $ctx.AcceptWebSocketAsync($wanted)
            $acc.Wait()
        } catch {
            Write-Host "  ! 页面侧 WS 握手失败：$($_.Exception.GetBaseException().Message)" -ForegroundColor DarkYellow
            return
        }
        $ws = $acc.Result.WebSocket

        $upUrl = ($cfg.Core -replace '^http', 'ws') + $upPathAndQuery
        $cli = [System.Net.WebSockets.ClientWebSocket]::new()
        $cli.Options.Proxy = $null
        if ($token) { $cli.Options.SetRequestHeader("Authorization", "Bearer $token") }
        elseif ($req.Headers["Authorization"]) { $cli.Options.SetRequestHeader("Authorization", [string]$req.Headers["Authorization"]) }
        try {
            $cli.ConnectAsync([System.Uri]$upUrl, [System.Threading.CancellationToken]::None).Wait()
        } catch {
            $why = $_.Exception.GetBaseException().Message
            # ⚠️ 这里**没法**把原因交给页面（浏览器的 WS 拿不到失败响应体），所以必须打在控制台上。
            Write-Host "  ! 上游 WS 连不上：$upUrl（$why）" -ForegroundColor DarkYellow
            try { $ws.Dispose() } catch { }
            try { $cli.Dispose() } catch { }
            return
        }

        $ct = [System.Threading.CancellationToken]::None
        $bufA = New-Object byte[] 65536
        $bufB = New-Object byte[] 65536
        $msA = New-Object System.IO.MemoryStream
        $msB = New-Object System.IO.MemoryStream
        $rA = $ws.ReceiveAsync([System.ArraySegment[byte]]::new($bufA), $ct)
        $rB = $cli.ReceiveAsync([System.ArraySegment[byte]]::new($bufB), $ct)
        while ($true) {
            [System.Threading.Tasks.Task]::WhenAny($rA, $rB).Wait()
            if ($rA.IsCompleted) {
                if ($rA.IsFaulted -or $rA.IsCanceled) { break }
                $r = $rA.Result
                if ($r.MessageType -eq [System.Net.WebSockets.WebSocketMessageType]::Close) {
                    try { $cli.CloseOutputAsync($r.CloseStatus, $r.CloseStatusDescription, $ct).Wait(3000) } catch { }
                    break
                }
                if ($r.Count -gt 0) { $msA.Write($bufA, 0, $r.Count) }
                if ($r.EndOfMessage) {
                    $bytes = $msA.ToArray()
                    $msA.SetLength(0) | Out-Null
                    try { $cli.SendAsync([System.ArraySegment[byte]]::new($bytes), $r.MessageType, $true, $ct).Wait() } catch { break }
                }
                $rA = $ws.ReceiveAsync([System.ArraySegment[byte]]::new($bufA), $ct)
            } else {
                if ($rB.IsFaulted -or $rB.IsCanceled) { break }
                $r = $rB.Result
                if ($r.MessageType -eq [System.Net.WebSockets.WebSocketMessageType]::Close) {
                    try { $ws.CloseOutputAsync($r.CloseStatus, $r.CloseStatusDescription, $ct).Wait(3000) } catch { }
                    break
                }
                if ($r.Count -gt 0) { $msB.Write($bufB, 0, $r.Count) }
                if ($r.EndOfMessage) {
                    $bytes = $msB.ToArray()
                    $msB.SetLength(0) | Out-Null
                    try { $ws.SendAsync([System.ArraySegment[byte]]::new($bytes), $r.MessageType, $true, $ct).Wait() } catch { break }
                }
                $rB = $cli.ReceiveAsync([System.ArraySegment[byte]]::new($bufB), $ct)
            }
        }

        try { $ws.Dispose() } catch { }
        try { $cli.Dispose() } catch { }
    }

    # ---- HTTP 反代 ----
    #
    # ⚠️ 上游 **4xx/5xx 也要把体和状态原样交回去**：页面的 token 闸、`HttpError` 上的
    #    `body.error`（核心的人话理由）全靠这一条。`GetResponse()` 会为它们抛 WebException，
    #    而 `Exception.Response` 就是那份响应——丢掉它，页面上所有错误都会变成一句「服务器出错」。
    function Proxy-Http($upPathAndQuery) {
        $up = [System.Net.HttpWebRequest]::Create($cfg.Core + $upPathAndQuery)
        $up.Method = $req.HttpMethod
        $up.Proxy = $null
        $up.AllowAutoRedirect = $false
        $up.Timeout = 30000
        $up.ReadWriteTimeout = 120000
        $up.KeepAlive = $false
        $ctype = [string]$req.Headers["Content-Type"]
        if ($ctype) { $up.ContentType = $ctype }
        $accept = [string]$req.Headers["Accept"]
        if ($accept) { $up.Accept = $accept }
        if ($token) { $up.Headers["Authorization"] = "Bearer $token" }
        elseif ($req.Headers["Authorization"]) { $up.Headers["Authorization"] = [string]$req.Headers["Authorization"] }

        $upRes = $null
        try {
            $len = $req.ContentLength64
            if ($len -gt 0) {
                $up.ContentLength = $len
                $dst = $up.GetRequestStream()
                $buf = New-Object byte[] 65536
                $left = $len
                while ($left -gt 0) {
                    $n = $req.InputStream.Read($buf, 0, [int][Math]::Min($buf.Length, $left))
                    if ($n -le 0) { break }
                    $dst.Write($buf, 0, $n)
                    $left -= $n
                }
                $dst.Close()
            }

            try {
                $upRes = $up.GetResponse()
            } catch [System.Net.WebException] {
                # ⚠️ PowerShell 里这条 catch 抓到的 `$_` 是 ErrorRecord，而 `.Exception` 往往还是
                # 一层 **MethodInvocationException**——`$_.Exception.Response` 直接取是 null，
                # 于是上游的 401/404/400 会被当成「没应答」（页面所有错误都变成一句「连不上核心」）。
                # 真正的 WebException 得从 `GetBaseException()`（或 InnerException）里拿。
                $we = $_.Exception
                while ($we -and -not ($we -is [System.Net.WebException]) -and $we.InnerException) { $we = $we.InnerException }
                $upRes = $we.Response
                if ($null -eq $upRes) { Fail-Upstream "没应答" $we.Message; return }
            }

            $status = [int]$upRes.StatusCode
            $outType = [string]$upRes.ContentType
            if (-not $outType) { $outType = "application/octet-stream" }
            $ms = New-Object System.IO.MemoryStream
            $src = $upRes.GetResponseStream()
            if ($null -ne $src) { $src.CopyTo($ms) }
            Write-Body $status $outType $ms.ToArray()
        } catch {
            Fail-Upstream "转发失败" $_.Exception.Message
        } finally {
            if ($null -ne $upRes) { try { $upRes.Close() } catch { } }
        }
    }

    try {
        $path = $req.Url.AbsolutePath
        $query = $req.Url.Query          # "?a=1" 或空串

        # 1) 控制面：WS 与 HTTP 两条都走这里
        if ($path -eq $prefix -or $path.StartsWith("$prefix/")) {
            $rest = $path.Substring($prefix.Length)
            if ([string]::IsNullOrEmpty($rest)) { $rest = "/" }
            $upPathAndQuery = $rest + $query
            if ($rest -eq "/ws" -and ([string]$req.Headers["Upgrade"]) -match '(?i)websocket') {
                Relay-Ws $upPathAndQuery
                return
            }
            Proxy-Http $upPathAndQuery
            return
        }

        # 2) 页面启动时读的那一格
        if ($path -eq "/config.json") {
            Write-Json 200 $cfg.Config
            return
        }

        # 3) 静态文件
        if ($path -eq "/" -or $path -eq "") { $path = "/index.html" }
        $rel = $path.TrimStart("/").Replace("/", [System.IO.Path]::DirectorySeparatorChar)
        $rootFull = $cfg.Root

        # ⚠️ `GetFullPath` 会为坏形状（`..` 一路吃穿、Windows 非法字符）抛异常，
        # 而外层唯一的 catch 会把它报成 **500「服务器出错」**——一次本该是 403/404 的
        # 请求看起来像服务端故障。这里自己落 400，让 500 只表示真的出了意外。
        $full = $null
        try {
            $full = [System.IO.Path]::GetFullPath((Join-Path $rootFull $rel))
        } catch {
            Write-Text 400 "bad path: $path"
            return
        }

        # ⚠️ 判据是「在根 + 分隔符之下」，**不是** `StartsWith($rootFull)`：
        # 后者会把 `…\Cadenza-evil` 判成在 `…\Cadenza` 之下（与核心
        # `SessionToolContext.ResolvePath` 同一条边界）。
        $sep = [System.IO.Path]::DirectorySeparatorChar
        $insideRoot = ($full -eq $rootFull) -or $full.StartsWith($rootFull.TrimEnd($sep) + $sep, [System.StringComparison]::OrdinalIgnoreCase)
        if (-not $insideRoot) {
            Write-Text 403 "forbidden"
            return
        }
        if (-not (Test-Path -LiteralPath $full -PathType Leaf)) {
            Write-Text 404 "not found: $path"
            return
        }

        $ext = [System.IO.Path]::GetExtension($full).ToLowerInvariant()
        $outType = if ($cfg.Types.ContainsKey($ext)) { $cfg.Types[$ext] } else { "application/octet-stream" }
        Write-Body 200 $outType ([System.IO.File]::ReadAllBytes($full))
    } catch {
        Write-Host "  ! $($req.Url.AbsolutePath)：$($_.Exception.Message)" -ForegroundColor DarkYellow
        try { $res.StatusCode = 500 } catch { }
    } finally {
        if ($null -ne $res) { try { $res.Close() } catch { } }
    }
}

$rootFull = [System.IO.Path]::GetFullPath($Root)
$cfg = @{
    Root   = $rootFull
    Core   = $Core
    Token  = $Token
    Prefix = $corePrefix
    Types  = $types
    Config = $configJson
}

$pool = [runspacefactory]::CreateRunspacePool(1, 16)
$pool.Open()
$workerText = $worker.ToString()
$running = New-Object System.Collections.ArrayList

try {
    while ($listener.IsListening) {
        $ctx = $listener.GetContext()

        $ps = [powershell]::Create()
        $ps.RunspacePool = $pool
        $null = $ps.AddScript($workerText).AddArgument($ctx).AddArgument($cfg)
        $null = $running.Add([pscustomobject]@{ PS = $ps; H = $ps.BeginInvoke() })

        # 收割：结束的那些（WS 中继会一直占着，直到页面关掉或核心断开）。
        for ($i = $running.Count - 1; $i -ge 0; $i--) {
            if ($running[$i].H.IsCompleted) {
                try { $null = $running[$i].PS.EndInvoke($running[$i].H) } catch { }
                try { $running[$i].PS.Dispose() } catch { }
                $running.RemoveAt($i)
            }
        }
    }
} finally {
    try { $listener.Stop(); $listener.Close() } catch { }
    foreach ($j in $running) { try { $j.PS.Stop(); $j.PS.Dispose() } catch { } }
    try { $pool.Close(); $pool.Dispose() } catch { }
}
