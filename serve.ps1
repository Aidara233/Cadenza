# CADENZA — static head server.
#
# The Lilara core only accepts WebSocket handshakes whose Origin matches its
# whitelist (default: the PATTERN http://*:17990 - any host, that port). This
# listener serves the Cadenza folder, with no browser caching (a page + three
# dozen modules is the same trap the reference head documented three times).
#
# No dependencies: System.Net.HttpListener ships with Windows PowerShell.
#
#   powershell -NoProfile -ExecutionPolicy Bypass -File Cadenza\serve.ps1
#   powershell ... -Port 17990 -Core http://127.0.0.1:17988
#   powershell ... -Bind 127.0.0.1      (收回仅本机；默认 0.0.0.0，Windows 需要 URL ACL，见下)
#
# ⚠️ **与 serve.sh 是同一份契约的两个实现**（用户裁定 2026-10-23：只做跨平台脚本，
#    不另起一个 exe 宿主）。参数名、默认值、启动自检、报错措辞要对齐——这一对**曾经漂过**：
#    改这里时**必须**同时改 serve.sh，反之亦然。
#
# Stop with Ctrl+C (or kill the process).

param(
    [int]$Port = 17990,
    [string]$Core = "http://127.0.0.1:17988",
    [string]$Root = $PSScriptRoot,
    # 监听地址。**默认对局域网开放（0.0.0.0）**——与核心 2026-11-05 那个裁定一致：
    # 同一网络里的手机/平板直接打开页面，而不是默认不可用。真要收回本机：-Bind 127.0.0.1。
    # ⚠️ Windows 上有一道额外的坎：`HttpListener` 绑回环之外的前缀需要一条 URL ACL，
    # 没有它 Start() 报「拒绝访问」。那种情况下本脚本**不会就地死掉**——它会印出那条
    # netsh 命令，然后**退回仅本机**接着服务（页面在本机能用，手机连不上，横幅里说清楚）。
    # 核心自己的头不需要这一步：Kestrel 不经过 http.sys。
    # ⚠️ **加了那条 `+` 的保留之后，`-Bind 127.0.0.1` 会反而绑不上**（本机实测）：http.sys
    # 让 `http://+:端口/` 可用，却拒绝同一端口上更具体的 `http://127.0.0.1:端口/`。
    # 要回环就把那条保留删掉（netsh http delete urlacl），别两个都要。
    [string]$Bind = "0.0.0.0",
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

# 回环之外的任何写法都落到 `+`（HttpListener 只认通配或具体字面量，两者都要 ACL；
# `+` 与 `*` 在这里是同一个意思）。
$isLoopback = $Bind -in @("127.0.0.1", "localhost", "::1", "[::1]")
$bindHost = if ($isLoopback) { "127.0.0.1" } else { "+" }
$prefix = "http://${bindHost}:$Port/"
$listener = [System.Net.HttpListener]::new()
$listener.Prefixes.Add($prefix)

# ⚠️ 核心地址**要不要跟着请求走**：显式给了 -Core 就照抄（核心在别的机器上 / 走了隧道，
#    头不许改写它）；没给时用**这次请求的 Host** 拼（同一个地址 + 核心端口）——绑到局域网之后，
#    页面里的 `127.0.0.1` 指的是**手机自己**，写死它等于永远连不上，而症状与「核心没起来」一模一样。
$coreExplicit = $PSBoundParameters.ContainsKey("Core")
$corePort = 17988
try { $p = ([System.Uri]$Core).Port; if ($p -gt 0) { $corePort = $p } } catch { }

function Get-CoreForRequest($req) {
    if ($coreExplicit) { return $Core }
    $h = $req.Headers["Host"]
    if ([string]::IsNullOrWhiteSpace($h)) { return $Core }
    $h = $h.Trim()
    # Host 头可能是 `192.168.1.5:17990` 或 `[::1]:17990`：只取地址那一段。
    $hostPart = if ($h.StartsWith("[")) {
        $close = $h.IndexOf("]")
        if ($close -lt 0) { return $Core }
        $h.Substring(0, $close + 1)
    } else {
        ($h -split ":")[0]
    }
    if ([string]::IsNullOrWhiteSpace($hostPart)) { return $Core }
    return "http://${hostPart}:$corePort"
}

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

Write-Host "CADENZA — http://127.0.0.1:$Port"
Write-Host "  页面 origin 必须落在核心的白名单上（默认模式 http://*:$Port = 任意主机 + 这个端口）"
Write-Host "  核心 $(if ($coreExplicit) { $Core } else { "http://<打开页面的那台机器的地址>:$corePort（跟着请求的 Host 走；-Core 可钉死）" })"
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
# ⚠️ 头只发静态文件，**真正能被驱动的是核心**：所以「要不要拦人」那道闸在核心那边（LILARA_AUTH）。
if (-not $isLoopback) {
    Write-Host "  ⚠️ 头对局域网开放：同一网络里的设备都能打开这个页面。" -ForegroundColor Yellow
    Write-Host "     核心那边也得能被这个地址连上（LILARA_BIND 默认已是 0.0.0.0）。"
    Write-Host "     要收回本机：-Bind 127.0.0.1；要拦人：核心设 LILARA_AUTH=1。"
    try {
        [System.Net.Dns]::GetHostAddresses([System.Net.Dns]::GetHostName()) |
            Where-Object { $_.AddressFamily -eq [System.Net.Sockets.AddressFamily]::InterNetwork -and
                           -not [System.Net.IPAddress]::IsLoopback($_) } |
            ForEach-Object { Write-Host "     可达地址 http://$($_):$Port" }
    } catch { }
    Write-Host ""
}

# Startup check: say out loud what the fatal-but-silent failure is.
if (-not $NoCheck) {
    try {
        $info = Invoke-RestMethod -Uri "$Core/info" -TimeoutSec 2 -ErrorAction Stop
        $allowed = "$($info.allowedOrigin)"
        # ⚠️ 核心 2026-11-05 起默认白名单是**模式** `http://*:<头端口>`（任意主机，端口钉住）。
        # 逐字比较会把一次正确的配置报成「不吻合」，而那句警告会把人推去改一个本来对的设置。
        if ($allowed -eq "http://127.0.0.1:$Port" -or $allowed -eq "http://*:$Port" -or $allowed -eq "*") {
            Write-Host "  ✓ 核心在，WS 白名单 = $allowed" -ForegroundColor Green
        } else {
            Write-Host "  ⚠️ 核心在，但白名单是 $allowed —— 页面 origin 是 http://127.0.0.1:$Port" -ForegroundColor Yellow
            Write-Host "     浏览器不会把握手 403 交给页面 JS。设 LILARA_HEAD_PORT=$Port 后重启核心。"
        }
        # 开了鉴权而页面不知道 = 「页面一片空白，没人说得出为什么」。token 只在核心的控制台里
        # （头是独立进程，拿不到也不该去读），所以这里只指路、不复述。
        if ($info.authRequired -eq $true) {
            Write-Host "  ⚠️ 核心开了鉴权（LILARA_AUTH=1）：页面第一次连会要 token。" -ForegroundColor Yellow
            Write-Host "     token 在核心的控制台启动横幅里（访问 token … 那一行）。"
        }
    } catch {
        Write-Host "  ⚠️ 核心没应答（$Core）：$($_.Exception.Message)" -ForegroundColor Yellow
        Write-Host "     页面会显示「已断开 · 重连中」。先把核心起起来。"
    }
}
Write-Host ""

# ⚠️ **监听已经发生（上面 `$listener.Start()`）之后才打开浏览器**：反过来的话
# 浏览器会抢在监听之前请求，看到的是「连接被拒绝」，而它不会自动重试首屏资源（模块加载失败就是白屏）。
if (-not $NoOpen) {
    try { Start-Process "http://127.0.0.1:$Port/" | Out-Null } catch { }
}

try {
    while ($listener.IsListening) {
        $ctx = $listener.GetContext()
        $req = $ctx.Request
        $res = $ctx.Response
        try {
            $path = [System.Uri]::UnescapeDataString($req.Url.AbsolutePath)
            if ($path -eq "/" -or $path -eq "") { $path = "/index.html" }

            # Single-file responses are no-store by design (same reason as the
            # reference head): never wonder which copy you are looking at.
            $res.Headers["Cache-Control"] = "no-store"

            if ($path -eq "/config.json") {
                # ⚠️ 跟着**请求的 Host** 走，不是写死 —— 见上面 `Get-CoreForRequest` 的注释。
                $coreUrl = Get-CoreForRequest $req
                $body = [System.Text.Encoding]::UTF8.GetBytes("{`"core`":`"$coreUrl`"}")
                $res.ContentType = "application/json; charset=utf-8"
            } else {
                $rel = $path.TrimStart("/").Replace("/", [System.IO.Path]::DirectorySeparatorChar)
                $rootFull = [System.IO.Path]::GetFullPath($Root)

                # ⚠️ `GetFullPath` 会为坏形状（`..` 一路吃穿、Windows 非法字符）抛异常，
                # 而外层唯一的 catch 会把它报成 **500「服务器出错」**——一次本该是 403/404 的
                # 请求看起来像服务端故障。这里自己落 400，让 500 只表示真的出了意外。
                $full = $null
                try {
                    $full = [System.IO.Path]::GetFullPath((Join-Path $rootFull $rel))
                } catch {
                    $res.StatusCode = 400
                    $body = [System.Text.Encoding]::UTF8.GetBytes("bad path: $path")
                    $res.ContentType = "text/plain; charset=utf-8"
                }

                # ⚠️ 判据是「在根 + 分隔符之下」，**不是** `StartsWith($rootFull)`：
                # 后者会把 `…\Cadenza-evil` 判成在 `…\Cadenza` 之下（与核心
                # `SessionToolContext.ResolvePath` 同一条边界）。
                $sep = [System.IO.Path]::DirectorySeparatorChar
                $insideRoot = ($null -ne $full) -and ($full -eq $rootFull -or $full.StartsWith($rootFull.TrimEnd($sep) + $sep, [System.StringComparison]::OrdinalIgnoreCase))

                if ($null -eq $full) {
                    # 上面已经写好 400。
                } elseif (-not $insideRoot) {
                    $res.StatusCode = 403
                    $body = [System.Text.Encoding]::UTF8.GetBytes("forbidden")
                    $res.ContentType = "text/plain; charset=utf-8"
                } elseif (-not (Test-Path -LiteralPath $full -PathType Leaf)) {
                    $res.StatusCode = 404
                    $body = [System.Text.Encoding]::UTF8.GetBytes("not found: $path")
                    $res.ContentType = "text/plain; charset=utf-8"
                } else {
                    $ext = [System.IO.Path]::GetExtension($full).ToLowerInvariant()
                    $res.ContentType = if ($types.ContainsKey($ext)) { $types[$ext] } else { "application/octet-stream" }
                    $body = [System.IO.File]::ReadAllBytes($full)
                }
            }

            $res.ContentLength64 = $body.Length
            if ($req.HttpMethod -ne "HEAD") { $res.OutputStream.Write($body, 0, $body.Length) }
            $res.OutputStream.Close()
        } catch {
            Write-Host "  ! $($req.Url.AbsolutePath)：$($_.Exception.Message)" -ForegroundColor DarkYellow
            try { $res.StatusCode = 500; $res.Close() } catch { }
        } finally {
            if ($null -ne $res) { try { $res.Close() } catch { } }
        }
    }
} finally {
    try { $listener.Stop(); $listener.Close() } catch { }
}
