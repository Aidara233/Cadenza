#:property PublishAot=false
#:property JsonSerializerIsReflectionEnabledByDefault=true
// Minimal CDP driver: launches headless Chrome, runs a script of steps from a file.
// Usage: dotnet run cdp.cs <steps.txt> [outDir]
// Step lines:  goto <url> | wait <ms> | eval <js> | shot <name> | size <w> <h> | until <js> [timeoutMs]
using System.Diagnostics;
using System.Net.WebSockets;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;

var steps = File.ReadAllLines(args[0]);
var outDir = args.Length > 1 ? args[1] : "shots";
Directory.CreateDirectory(outDir);
var chrome = @"C:\Program Files\Google\Chrome\Application\chrome.exe";
var profile = Path.Combine(Path.GetTempPath(), "cadenza-cdp-" + Environment.ProcessId);
var port = 9333;
var psi = new ProcessStartInfo(chrome, $"--headless=new --disable-gpu --no-first-run --no-default-browser-check --remote-debugging-port={port} --user-data-dir=\"{profile}\" --window-size=1600,1000 --force-device-scale-factor=1 about:blank")
{ UseShellExecute = false, RedirectStandardError = true, RedirectStandardOutput = true };
var proc = Process.Start(psi)!;
var http = new HttpClient();
string? wsUrl = null;
for (var i = 0; i < 50 && wsUrl is null; i++)
{
    try
    {
        var list = JsonNode.Parse(await http.GetStringAsync($"http://127.0.0.1:{port}/json/list"))!.AsArray();
        wsUrl = list.FirstOrDefault(t => (string?)t!["type"] == "page")?["webSocketDebuggerUrl"]?.ToString();
    }
    catch { }
    if (wsUrl is null) await Task.Delay(200);
}
if (wsUrl is null) { Console.WriteLine("no chrome"); proc.Kill(true); return 1; }

var ws = new ClientWebSocket();
await ws.ConnectAsync(new Uri(wsUrl), default);
var id = 0;
var waiters = new Dictionary<int, TaskCompletionSource<JsonNode>>();
var logs = new List<string>();
_ = Task.Run(async () =>
{
    var buf = new byte[1 << 20];
    while (ws.State == WebSocketState.Open)
    {
        var sb = new StringBuilder();
        WebSocketReceiveResult r;
        do { r = await ws.ReceiveAsync(buf, default); sb.Append(Encoding.UTF8.GetString(buf, 0, r.Count)); } while (!r.EndOfMessage);
        var msg = JsonNode.Parse(sb.ToString())!;
        if (msg["id"] is { } mid) { lock (waiters) { if (waiters.Remove((int)mid, out var t)) t.SetResult(msg); } }
        else
        {
            var m = (string?)msg["method"];
            if (m == "Runtime.consoleAPICalled")
            {
                var type = (string?)msg["params"]!["type"];
                var text = string.Join(" ", msg["params"]!["args"]!.AsArray().Select(a => a!["value"]?.ToString() ?? a!["description"]?.ToString() ?? ""));
                lock (logs) logs.Add($"[console.{type}] {text}");
            }
            else if (m == "Runtime.exceptionThrown")
            {
                var d = msg["params"]!["exceptionDetails"]!;
                lock (logs) logs.Add($"[EXCEPTION] {d["exception"]?["description"] ?? d["text"]} @ {d["url"]}:{d["lineNumber"]}");
            }
            else if (m == "Log.entryAdded")
            {
                var e = msg["params"]!["entry"]!;
                lock (logs) logs.Add($"[log.{e["level"]}] {e["text"]} {e["url"]}");
            }
        }
    }
});

async Task<JsonNode> Send(string method, object? p = null)
{
    var my = Interlocked.Increment(ref id);
    var tcs = new TaskCompletionSource<JsonNode>();
    lock (waiters) waiters[my] = tcs;
    var payload = JsonSerializer.Serialize(new { id = my, method, @params = p ?? new { } });
    await ws.SendAsync(Encoding.UTF8.GetBytes(payload), WebSocketMessageType.Text, true, default);
    var done = await Task.WhenAny(tcs.Task, Task.Delay(30000));
    if (done != tcs.Task) throw new TimeoutException(method);
    return tcs.Task.Result;
}
async Task<string> Eval(string js)
{
    var r = await Send("Runtime.evaluate", new { expression = js, awaitPromise = true, returnByValue = true });
    var res = r["result"]!;
    if (res["exceptionDetails"] is { } ex) return "EXC: " + (ex["exception"]?["description"] ?? ex["text"]);
    var v = res["result"]!;
    return v["value"] is { } val ? (val is JsonValue jv && jv.TryGetValue<string>(out var s) ? s : val.ToJsonString()) : (string?)v["description"] ?? (string?)v["type"] ?? "";
}

Console.WriteLine("connected " + wsUrl);
await Send("Runtime.enable");
await Send("Log.enable");
await Send("Page.enable");
await Send("Emulation.setDeviceMetricsOverride", new { width = 1600, height = 1000, deviceScaleFactor = 1, mobile = false });

var fail = 0;
foreach (var raw in steps)
{
    var line = raw.Trim();
    if (line.Length == 0 || line.StartsWith('#')) continue;
    var sp = line.IndexOf(' ');
    var cmd = sp < 0 ? line : line[..sp];
    var arg = sp < 0 ? "" : line[(sp + 1)..];
    switch (cmd)
    {
        case "goto": await Send("Page.navigate", new { url = arg }); await Task.Delay(1200); break;
        case "wait": await Task.Delay(int.Parse(arg)); break;
        case "size":
            var wh = arg.Split(' ');
            await Send("Emulation.setDeviceMetricsOverride", new { width = int.Parse(wh[0]), height = int.Parse(wh[1]), deviceScaleFactor = 1, mobile = false });
            break;
        case "eval": Console.WriteLine($"> {Trunc(arg, 90)}\n  = {await Eval(arg)}"); break;
        case "expect":
            {
                var v = await Eval(arg);
                var ok = v == "true";
                if (!ok) fail++;
                Console.WriteLine($"{(ok ? "PASS" : "FAIL")} {Trunc(arg, 110)}{(ok ? "" : "  => " + v)}");
                break;
            }
        case "until":
            {
                var parts = arg.Split(" ;; ");
                var to = parts.Length > 1 ? int.Parse(parts[1]) : 8000;
                var sw = Stopwatch.StartNew(); string v = "";
                while (sw.ElapsedMilliseconds < to) { v = await Eval(parts[0]); if (v == "true") break; await Task.Delay(150); }
                var ok = v == "true";
                if (!ok) fail++;
                Console.WriteLine($"{(ok ? "PASS" : "FAIL")} until {Trunc(parts[0], 100)} ({sw.ElapsedMilliseconds}ms){(ok ? "" : "  => " + v)}");
                break;
            }
        case "shot":
            {
                var r = await Send("Page.captureScreenshot", new { format = "png" });
                await File.WriteAllBytesAsync(Path.Combine(outDir, arg + ".png"), Convert.FromBase64String((string)r["result"]!["data"]!));
                Console.WriteLine($"shot {arg}");
                break;
            }
        case "logs":
            lock (logs) { foreach (var l in logs) Console.WriteLine("  " + l); logs.Clear(); }
            break;
    }
}
lock (logs) foreach (var l in logs) Console.WriteLine("  " + l);
Console.WriteLine($"== {fail} failed");
try { await Send("Browser.close"); } catch { }
await Task.Delay(300);
try { if (!proc.HasExited) proc.Kill(true); } catch { }
try { Directory.Delete(profile, true); } catch { }
return fail == 0 ? 0 : 2;

static string Trunc(string s, int n) => s.Length > n ? s[..n] + "…" : s;
