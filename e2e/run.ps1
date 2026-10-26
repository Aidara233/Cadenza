# Cadenza E2E: isolated core (own data root, port 17989) + mock OpenAI-chat upstream (15799)
# + Cadenza on 17994 + headless Chrome over CDP. Touches nothing in ~/.lilara.
#
#   powershell -NoProfile -ExecutionPolicy Bypass -File e2e\run.ps1 [-CoreExe <path to lilara.exe>]
#
# Scripts run in order (2 resets the isolated data root through the API; 3, 4, 6, 7 build on its session).
# 5-reconnect.txt needs the core killed and restarted by hand while it waits — run it separately.

param(
    [string]$CoreExe = "",
    [string[]]$Scripts = @("1-boot", "2-flow", "3-asks-axes", "4-views-layout", "6-mixer-fit", "7-sync", "8-search", "9-network", "10-goal", "11-shell", "12-provider-timeout", "13-subagents"),
    [string]$Work = (Join-Path $env:TEMP "cadenza-e2e")
)
$ErrorActionPreference = "Stop"
# -File passes "a,b,c" as one string; accept both forms.
$Scripts = @($Scripts | ForEach-Object { $_ -split "," } | Where-Object { $_ })
$here = $PSScriptRoot
$root = Split-Path $here -Parent
New-Item -ItemType Directory -Force -Path "$Work\home", "$Work\proj\src", "$Work\shots" | Out-Null
Set-Content -Path "$Work\proj\README.md" -Value "readme"

if (-not $CoreExe) {
    # The core is a library since a128b28; the executable is the CLI host. Build the working tree
    # (it carries the retry.attempt work before it is committed).
    $src = "E:\Workspace\AgentLilaraCode\src\Lilara.Cli\Lilara.Cli.csproj"
    Write-Host "building core from $src"
    dotnet build $src -c Debug -o "$Work\core" | Out-Null
    $CoreExe = "$Work\core\lilara.exe"
}

$env:LILARA_HOME = "$Work\home"; $env:LILARA_PORT = "17989"; $env:LILARA_HEAD_PORT = "17994"
$core = Start-Process -FilePath "cmd.exe" -ArgumentList "/c", "ping -n 99999 127.0.0.1 >nul | `"$CoreExe`"" -WorkingDirectory "$Work\proj" -PassThru -WindowStyle Hidden
$mock = Start-Process -FilePath "dotnet" -ArgumentList "run", "`"$here\mock.cs`"", "15799" -PassThru -WindowStyle Hidden
$head = Start-Process -FilePath "powershell" -ArgumentList "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", "`"$root\serve.ps1`"", "-Port", "17994", "-Core", "http://127.0.0.1:17989", "-NoOpen" -PassThru -WindowStyle Hidden
Start-Sleep -Seconds 8

$failed = 0
try {
    foreach ($s in $Scripts) {
        Write-Host "=== $s" -ForegroundColor Cyan
        dotnet run "$here\cdp.cs" "$here\$s.txt" "$Work\shots" 2>&1 | Where-Object { $_ -notmatch "warning IL" }
        if ($LASTEXITCODE -ne 0) { $failed++ }
    }
} finally {
    # Tree kill: cmd's ping (stdin keeper) and dotnet's child app must go too.
    foreach ($p in $core, $mock, $head) { & taskkill /PID $p.Id /T /F 2>&1 | Out-Null }
    Get-CimInstance Win32_Process -Filter "name='lilara.exe'" | Where-Object { $_.ExecutablePath -eq $CoreExe } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }
}
Write-Host "screenshots: $Work\shots"
exit $failed
