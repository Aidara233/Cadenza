# Cadenza 的发布包：一份能直接摆到任意静态宿主上的页面。
#
#   powershell -NoProfile -ExecutionPolicy Bypass -File publish.ps1 [-Version 1.2.0]
#
# 产物：publish\cadenza-<version>.zip
#
# ⚠️ 包里有**两种**跑法，对应 Cadenza 一直以来的两条路：
#   · 只有静态文件也能用（页面直连核心）—— 但那样 `Origin` 白名单与 token 都回落到浏览器；
#   · 带上 serve.ps1 / serve.sh / serve.py 就多一层反代（推荐）—— 页面只跟一个源说话。
# ⚠️ 不带 `e2e/`：那是「怎么验证这个头」的记录（含 mock 上游与 trace 脚本），不是运行时要的东西。
param([string]$Version = "1.2.0")
$ErrorActionPreference = "Stop"

$root = $PSScriptRoot
$out = Join-Path $root "publish"
$stage = Join-Path $out "cadenza-$Version"

if (Test-Path $stage) { Remove-Item -Recurse -Force $stage }
New-Item -ItemType Directory -Force -Path $stage, (Join-Path $stage "css"), (Join-Path $stage "js") | Out-Null

Copy-Item (Join-Path $root "index.html") $stage -Force
Copy-Item (Join-Path $root "css\*.css") (Join-Path $stage "css") -Force
Copy-Item (Join-Path $root "js\*.js") (Join-Path $stage "js") -Force
Copy-Item (Join-Path $root "serve.ps1") $stage -Force
Copy-Item (Join-Path $root "serve.sh") $stage -Force
Copy-Item (Join-Path $root "serve.py") $stage -Force
Copy-Item (Join-Path $root "README.md") $stage -Force

# 判据：页面、样式、脚本、启动脚本都得在（少一个就是「发布成功但打不开」）。
foreach ($required in @("index.html", "css\base.css", "js\app.js", "serve.ps1", "serve.sh", "serve.py")) {
    if (-not (Test-Path (Join-Path $stage $required))) { throw "产物不全：缺 $required" }
}

# 版本自检：页面里的 VERSION 与本包的版本号必须是同一个数（两份副本，漂了很难发现）。
$appJs = Get-Content (Join-Path $stage "js\app.js") -Raw
if ($appJs -notmatch "const VERSION = `"$([regex]::Escape($Version))`";") {
    throw "js\app.js 里的 VERSION 不是 $Version —— 先改它，再打包（否则页面底栏会报错版本号）"
}

$zip = Join-Path $out "cadenza-$Version.zip"
Remove-Item $zip -Force -ErrorAction SilentlyContinue
Compress-Archive -Path (Join-Path $stage "*") -DestinationPath $zip -CompressionLevel Optimal

$hash = (Get-FileHash $zip -Algorithm SHA256).Hash.ToLowerInvariant()
Set-Content -Path (Join-Path $out "SHA256SUMS") -Value "$hash  cadenza-$Version.zip" -Encoding ascii

Write-Host ("{0} — {1:N0} KB" -f (Split-Path $zip -Leaf), ((Get-Item $zip).Length / 1KB))
Write-Host "产物在 $out"
