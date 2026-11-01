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
#   powershell ... -Bind 0.0.0.0        (对局域网开放；Windows 先加一条 URL ACL，见下)
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
    # 监听地址。**默认只在本机**——不是审美选择，是 `HttpListener` 的硬约束：
    # 回环之外的前缀（`http://+:17990/`）需要一条 URL ACL，没有它 Start() 直接「拒绝访问」，
    # 而这台机器上实测就是没加（非管理员）。所以要对局域网开放是**一条显式决定**：
    #   -Bind 0.0.0.0        （先按下面那句 netsh 加一次 ACL，或者用管理员身份跑）
    # 要从手机/平板打开页面时才需要它；只在本机看时，默认值就是对的。
    [string]$Bind = "127.0.0.1",
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

try {
    $listener.Start()
} catch {
    Write-Host "✗ Cadenza 起不来（$prefix）：$($_.Exception.Message)" -ForegroundColor Red
    if (-not $isLoopback) {
        # ⚠️ 这一格几乎总是「URL ACL 没加」：HttpListener 绑回环之外的前缀需要一条保留，
        # 而它不是端口占用。把命令原样印出来——不然这句话看起来像「端口被占」。
        Write-Host "  绑回环之外的地址需要一条 URL ACL（Windows 的规矩，不是端口被占）。先跑一次（管理员）："
        Write-Host "      netsh http add urlacl url=http://+:$Port/ user=$env:USERNAME" -ForegroundColor Cyan
        Write-Host "  或者用管理员身份重跑本脚本。不想动 ACL 就用默认的 -Bind 127.0.0.1（只在本机用）。"
    } else {
        Write-Host "  端口被占或落在 Windows 保留段。换个端口：-Port 17991，并设 LILARA_HEAD_PORT=17991 后重启核心。"
    }
    exit 1
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
Write-Host "  监听 $(if ($isLoopback) { "127.0.0.1（只在本机；要手机/平板打开用 -Bind 0.0.0.0）" } else { "$Bind（对局域网开放）" })"
Write-Host ""

# 对局域网开放时把代价说出来，并把可达地址列出来（别的设备照着输）。
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
