# CADENZA — static head server.
#
# The Lilara core only accepts WebSocket handshakes whose Origin matches its
# whitelist (default http://127.0.0.1:17990). This listener serves the Cadenza
# folder on exactly that origin, with no browser caching (a page + three dozen
# modules is the same trap the reference head documented three times).
#
# No dependencies: System.Net.HttpListener ships with Windows PowerShell.
#
#   powershell -NoProfile -ExecutionPolicy Bypass -File Cadenza\serve.ps1
#   powershell ... -Port 17990 -Core http://127.0.0.1:17988
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
    # 2026-10-23：与 serve.sh 的 --no-check / --no-open 对齐。默认会自检并打开浏览器；
    # 自动化（e2e、脚本拉起）用这两个开关关掉。
    [switch]$NoCheck,
    [switch]$NoOpen
)

$ErrorActionPreference = "Stop"
try { [Console]::OutputEncoding = [System.Text.Encoding]::UTF8 } catch { }
$prefix = "http://127.0.0.1:$Port/"
$listener = [System.Net.HttpListener]::new()
$listener.Prefixes.Add($prefix)

try {
    $listener.Start()
} catch {
    Write-Host "✗ Cadenza 起不来（$prefix）：$($_.Exception.Message)" -ForegroundColor Red
    Write-Host "  端口被占或落在 Windows 保留段。换个端口：-Port 17991，并设 LILARA_HEAD_PORT=17991 后重启核心。"
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
Write-Host "  页面 origin http://127.0.0.1:$Port（核心 WS 白名单需包含它）"
Write-Host "  核心 $Core（页面直连；可用 ?core= 或「后台 · 系统」覆盖）"
Write-Host "  根目录 $Root"
Write-Host "  ⚠️ 请用 127.0.0.1 打开——localhost 不是同一个 origin，握手会被静默拒绝。"
Write-Host ""

# Startup check: say out loud what the fatal-but-silent failure is.
if (-not $NoCheck) {
    try {
        $info = Invoke-RestMethod -Uri "$Core/info" -TimeoutSec 2 -ErrorAction Stop
        if ($info.allowedOrigin -eq "http://127.0.0.1:$Port") {
            Write-Host "  ✓ 核心在，WS 白名单 = $($info.allowedOrigin)" -ForegroundColor Green
        } else {
            Write-Host "  ⚠️ 核心在，但白名单是 $($info.allowedOrigin) —— 页面 origin 是 http://127.0.0.1:$Port" -ForegroundColor Yellow
            Write-Host "     浏览器不会把握手 403 交给页面 JS。设 LILARA_HEAD_PORT=$Port 后重启核心。"
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
                $body = [System.Text.Encoding]::UTF8.GetBytes("{`"core`":`"$Core`"}")
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
