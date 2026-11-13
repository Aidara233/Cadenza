# Cadenza E2E: isolated core (own data root, port 17989) + mock OpenAI-chat upstream (15799)
# + Cadenza on 17994 + headless Chrome over CDP. Touches nothing in ~/.lilara.
#
#   powershell -NoProfile -ExecutionPolicy Bypass -File e2e\run.ps1 [-CoreExe <path to lilara.exe>]
#
# Scripts run in order (2 resets the isolated data root through the API; 3, 4, 6, 7 build on its session).
# 5-reconnect.txt needs the core killed and restarted by hand while it waits — run it separately.

param(
    [string]$CoreExe = "",
    [string[]]$Scripts = @("1-boot", "2-flow", "3-asks-axes", "4-views-layout", "6-mixer-fit", "7-sync", "8-search", "9-network", "10-goal", "11-shell", "12-provider-timeout", "13-subagents", "14-jobs", "15-archive", "16-images", "18-streaming", "19-runstate", "20-mobile"),
    [string]$Work = (Join-Path $env:TEMP "cadenza-e2e"),
    # -Auth starts the core with LILARA_AUTH=1, reads the token out of its startup banner and
    # substitutes @TOKEN@ in the step scripts. Such a core rejects every anonymous request, so
    # the default script list cannot run against it: with -Auth the default is 17-auth alone.
    [switch]$Auth
)
$ErrorActionPreference = "Stop"
# -File passes "a,b,c" as one string; accept both forms.
$Scripts = @($Scripts | ForEach-Object { $_ -split "," } | Where-Object { $_ })
if ($Auth -and -not $PSBoundParameters.ContainsKey("Scripts")) { $Scripts = @("17-auth") }
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
    # MUST stop here when the build fails (learned the hard way, 2026-10-28): PowerShell does not
    # stop on a native command's non-zero exit code ($ErrorActionPreference does not cover it), so the
    # script happily runs the PREVIOUS exe. The symptom is a whole script going red for reasons that
    # look like a broken frontend. The classic trigger: a leftover e2e core still holds
    # "$Work\core\Lilara.Core.dll", the copy fails, and every new endpoint returns 404.
    if ($LASTEXITCODE -ne 0) { throw "core build failed (exit $LASTEXITCODE) - see the dotnet output above" }
    $CoreExe = "$Work\core\lilara.exe"
}

$env:LILARA_HOME = "$Work\home"; $env:LILARA_PORT = "17989"; $env:LILARA_HEAD_PORT = "17994"
# Clear leftovers from a previous run before starting: a serve.ps1 that never exited keeps holding
# 17994, and the new head just DIES silently (port in use is its own startup error), so the script
# would drive a page served by old code plus an old data root. That failure looks like a broken
# frontend, so sweep first. NOTE: keep this file pure ASCII - PowerShell 5.1 decodes a BOM-less
# .ps1 with the local code page, and non-ASCII comments can kill the parse on GBK machines.
Get-CimInstance Win32_Process | Where-Object {
    $_.CommandLine -and $_.CommandLine -match 'serve\.ps1' -and $_.CommandLine -match '\-Port\s+17994'
} | ForEach-Object { try { Stop-Process -Id $_.ProcessId -Force } catch { } }
# LILARA_AUTH=1 is what makes the core check a token at all; unset it otherwise so a shell that
# happens to export it cannot poison every other script.
if ($Auth) { $env:LILARA_AUTH = "1" } else { Remove-Item Env:LILARA_AUTH -ErrorAction SilentlyContinue }
# With -Auth the core's stdout goes to a file: the token exists ONLY in that banner, and the hidden
# window would otherwise swallow it.
$coreRedir = if ($Auth) { " > `"$Work\core-out.log`" 2>&1" } else { "" }
$core = Start-Process -FilePath "cmd.exe" -ArgumentList "/c", "ping -n 99999 127.0.0.1 >nul | `"$CoreExe`"$coreRedir" -WorkingDirectory "$Work\proj" -PassThru -WindowStyle Hidden
$mock = Start-Process -FilePath "dotnet" -ArgumentList "run", "`"$here\mock.cs`"", "15799" -PassThru -WindowStyle Hidden
$head = Start-Process -FilePath "powershell" -ArgumentList "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", "`"$root\serve.ps1`"", "-Port", "17994", "-Core", "http://127.0.0.1:17989", "-NoOpen" -PassThru -WindowStyle Hidden
Start-Sleep -Seconds 8

$token = ""

# The token scrape and the probe live INSIDE the try below: a throw here must still hit the
# finally block, otherwise the core / mock / head survive the run and keep holding port 17989
# and the log file (learned the hard way on the first -Auth run).
$failed = 0
try {
    if ($Auth) {
        # The banner line is "<CJK> token <value>", but this file must stay pure ASCII and the
        # core's redirected stdout encoding follows the machine code page - so DO NOT match the
        # CJK word. GenerateToken() is 32 random bytes as base64url with the padding trimmed:
        # exactly 43 chars.
        # The redirect target is still open by cmd/core while we read it, so a plain
        # File.ReadAllText fails with "file in use" - open it shared instead. And give the core a
        # few seconds: the banner appears a beat after the process starts.
        $hits = @()
        for ($i = 0; $i -lt 20 -and $hits.Count -eq 0; $i++) {
            Start-Sleep -Milliseconds 500
            $raw = ""
            try {
                $fs = [System.IO.File]::Open("$Work\core-out.log", [System.IO.FileMode]::Open, [System.IO.FileAccess]::Read, [System.IO.FileShare]::ReadWrite)
                $sr = New-Object System.IO.StreamReader($fs)
                $raw = $sr.ReadToEnd()
                $sr.Dispose(); $fs.Dispose()
            } catch { }
            $hits = @([regex]::Matches($raw, '[A-Za-z0-9_-]{43}') | ForEach-Object { $_.Value } | Select-Object -Unique)
        }
        if ($hits.Count -ne 1) { throw "could not scrape exactly one token from $Work\core-out.log (found $($hits.Count))" }
        $token = $hits[0]
        # Fail fast, with a precise message, if the scrape or the core wiring is wrong - rather
        # than letting 17-auth go red for a reason that looks like a broken frontend.
        $probe = Invoke-WebRequest -UseBasicParsing -Uri "http://127.0.0.1:17989/info" -Headers @{ Authorization = "Bearer $token" }
        if ($probe.Content -notmatch 'dataRoot') { throw "the scraped token was rejected by the core (see $Work\core-out.log)" }
        Write-Host "auth token scraped (length $($token.Length))"
    }
    foreach ($s in $Scripts) {
        Write-Host "=== $s" -ForegroundColor Cyan
        $steps = "$here\$s.txt"
        if ($token) {
            $text = [System.IO.File]::ReadAllText($steps)
            if ($text.Contains("@TOKEN@")) {
                # cdp.cs uses File.ReadAllLines: write UTF-8 WITH BOM so the CJK steps survive any code page.
                $steps = "$Work\$s.resolved.txt"
                [System.IO.File]::WriteAllText($steps, $text.Replace("@TOKEN@", $token), (New-Object System.Text.UTF8Encoding $true))
            }
        }
        dotnet run "$here\cdp.cs" "$steps" "$Work\shots" 2>&1 | Where-Object { $_ -notmatch "warning IL" }
        if ($LASTEXITCODE -ne 0) { $failed++ }
    }
} finally {
    # Tree kill: cmd's ping (stdin keeper) and dotnet's child app must go too.
    # taskkill writes to stderr for an already-dead pid, and "$ErrorActionPreference = Stop" plus
    # "2>&1" turns that into a terminating error, so wrap each one.
    foreach ($p in $core, $mock, $head) { try { & taskkill /PID $p.Id /T /F 2>&1 | Out-Null } catch { } }
    Get-CimInstance Win32_Process -Filter "name='lilara.exe'" | Where-Object { $_.ExecutablePath -eq $CoreExe } | ForEach-Object { try { Stop-Process -Id $_.ProcessId -Force } catch { } }
}
Write-Host "screenshots: $Work\shots"
exit $failed
