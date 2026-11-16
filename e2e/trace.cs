#:property PublishAot=false
#:property JsonSerializerIsReflectionEnabledByDefault=true
// Cadenza · trace —— 给「莫名其妙卡死」准备的外部记录仪（诊断用，不属于 e2e 断言）。
//
// 为什么非要从外面录：真的卡住时，页面里能报信的东西（watchdog 的心跳、横幅、DevTools）全都堵在
// **同一条主线程**上；DevTools 尤其坏——它自己的 inspector 也要问主线程，于是「卡住之后再去看」
// 永远看不到。trace 则不同：它由 **browser 进程**生成，由**另一个进程**（这个程序）持续落盘，
// 渲染进程怎么卡都不影响录制。卡死之后还能回头看它是从哪一刻、停在哪两个事件之间开始的。
//
//   dotnet run e2e\trace.cs record                       # 起一个可留证的 Chrome 并开始录
//   dotnet run e2e\trace.cs analyze <trace 文件>         # 事后找「主线程最长的那几段空白」
//
// record 的几种停法：Ctrl+C · 在 trace 文件旁建一个同名 `.stop` 文件 · `--minutes N` 到时。
// 停的时候会发 `Tracing.end` 把尾巴刷完（渲染进程若已卡死，这一步可能等不到——已经落盘的部分
// 照样可用，`analyze` 读的就是它）。
//
// 判读要点：**卡死 = 某条线程上出现一段长空白**。空白「前面最后一个事件」与「后面第一个事件」
// 的名字就是答案：
//   · 空白前是 `ThreadControllerImpl::RunTask` / `MessageLoop::RunTask` ⇒ 主线程被某个任务占住
//     （是 JS 还是原生代码，看它前一层的 `FunctionCall` / `EventDispatch`）；
//   · `BeginMainFrame` / `UpdateLayoutTree` / `Layout` / `Paint` 前后 ⇒ 渲染那一路（样式/布局/绘制）；
//   · 主线程与 `CrGpuMain` / `VizCompositorThread` **一起**空白 ⇒ 卡在合成 / GPU 那边；
//   · 主线程空白而 `CrBrowserMain` 还在动 ⇒ 渲染进程自己的问题，不是浏览器/机器被抢光。
using System.Diagnostics;
using System.Globalization;
using System.Net.WebSockets;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;

Console.OutputEncoding = Encoding.UTF8;

if (args.Length == 0) { Help(); return 0; }
var rest = args.Skip(1).ToArray();
var pos = rest.Length > 0 && !rest[0].StartsWith("--") ? rest[0] : null;
var opt = ParseOpts(pos is null ? rest : rest.Skip(1).ToArray());
return args[0] switch
{
    "record" => await Record(opt),
    "analyze" => Analyze(pos, opt),
    _ => HelpAnd(2),
};

// ────────────────────────────────────────────────────────────── record ──

static async Task<int> Record(Dictionary<string, string> o)
{
    var url = Get(o, "url", "http://127.0.0.1:17990/");
    var port = int.Parse(Get(o, "port", "9444"), CultureInfo.InvariantCulture);
    var chrome = Get(o, "chrome", @"C:\Program Files\Google\Chrome\Application\chrome.exe");
    var profile = Get(o, "profile", Path.Combine(Path.GetTempPath(), "cadenza-trace-profile"));
    var stamp = DateTime.Now.ToString("yyyyMMdd-HHmmss", CultureInfo.InvariantCulture);
    var outPath = Get(o, "out", Path.Combine(Path.GetTempPath(), "cadenza-trace", $"trace-{stamp}.jsonl"));
    // ⚠️ 类目要窄且要少：实测（headless、页面闲着）`*` 全开 1.8 MB/s，`toplevel` 单项就 0.87 MB/s，
    // 而定位「主线程空白」只需要 toplevel（线程级任务/渲染步骤）+ devtools.timeline（函数级/布局绘制）
    // + ipc（同步等待）。这三项约 1.1 MB/s ⇒ 一小时 4 GB，所以还有 `--max-mb` 兜着。
    var cats = Get(o, "cats", "toplevel,devtools.timeline,ipc");
    var maxMb = double.Parse(Get(o, "max-mb", "3000"), CultureInfo.InvariantCulture);
    var minutes = double.Parse(Get(o, "minutes", "0"), CultureInfo.InvariantCulture);
    var headless = o.ContainsKey("headless");

    Directory.CreateDirectory(Path.GetDirectoryName(Path.GetFullPath(outPath))!);
    var startedAt = DateTime.Now;
    var started = Stopwatch.StartNew();
    var stopFile = outPath + ".stop";
    var metaPath = outPath + ".meta.json";
    // 先起 Chrome：headed、独立 user-data-dir（省得和用户正在用的那个实例抢，也保证端口能开）。
    // ⚠️ 必须把 Chrome 的 stdout/stderr 接管过来：不接管的话它**继承我们的管道**，我们退出之后
    // 调用方（`tail`、`run.ps1`、脚本）还得等 Chrome 关掉才拿到 EOF——headed 那一版第一次跑
    // 就是这么把调用方卡了七分钟的（录制其实早就结束了）。
    var psi = new ProcessStartInfo(chrome) { UseShellExecute = false, RedirectStandardOutput = true, RedirectStandardError = true };
    psi.ArgumentList.Add($"--remote-debugging-port={port}");
    psi.ArgumentList.Add($"--user-data-dir={profile}");
    psi.ArgumentList.Add("--no-first-run");
    psi.ArgumentList.Add("--no-default-browser-check");
    psi.ArgumentList.Add("--window-size=1600,1000");
    if (headless) psi.ArgumentList.Add("--headless=new");
    psi.ArgumentList.Add(url);
    Process proc;
    try { proc = Process.Start(psi)!; }
    catch (Exception e) { Console.WriteLine("起不来 Chrome：" + e.Message); return 2; }
    // 排空它们（丢弃）：Chrome 会往 stderr 打调试日志，没人读的管道写满就把它自己憋住。
    proc.OutputDataReceived += (_, _) => { };
    proc.ErrorDataReceived += (_, _) => { };
    proc.BeginOutputReadLine();
    proc.BeginErrorReadLine();

    var http = new HttpClient();
    string? wsUrl = null;
    for (var i = 0; i < 100 && wsUrl is null; i++)
    {
        try
        {
            var v = JsonNode.Parse(await http.GetStringAsync($"http://127.0.0.1:{port}/json/version"))!;
            wsUrl = (string?)v["webSocketDebuggerUrl"];
            var ver = (string?)v["Browser"];
            if (ver is not null) Console.WriteLine("chrome  : " + ver);
        }
        catch { }
        if (wsUrl is null) await Task.Delay(200);
    }
    if (wsUrl is null) { Console.WriteLine($"连不上调试端口 {port}（Chrome 已在用别的 profile？）"); try { proc.Kill(true); } catch { } return 2; }

    // ⚠️ 挂在 **browser** 那一头：页面自己的 target 在卡死时连不上，browser 那一头不会。
    var ws = new ClientWebSocket();
    ws.Options.KeepAliveInterval = TimeSpan.FromSeconds(15);
    await ws.ConnectAsync(new Uri(wsUrl), default);

    var id = 0;
    var waiters = new System.Collections.Concurrent.ConcurrentDictionary<int, TaskCompletionSource<JsonNode>>();
    var cts = new CancellationTokenSource();
    var complete = new TaskCompletionSource<bool>();
    var chunks = 0L;
    var bytes = 0L;
    string? lastError = null;
    var usage = 0.0;
    var fs = new FileStream(outPath, FileMode.Create, FileAccess.Write, FileShare.Read, 1 << 20);
    var w = new StreamWriter(fs, new UTF8Encoding(false)) { AutoFlush = false };

    _ = Task.Run(async () =>
    {
        var buf = new byte[1 << 22];
        while (ws.State == WebSocketState.Open && !cts.IsCancellationRequested)
        {
            var sb = new StringBuilder();
            WebSocketReceiveResult r;
            try
            {
                do { r = await ws.ReceiveAsync(buf, default); sb.Append(Encoding.UTF8.GetString(buf, 0, r.Count)); } while (!r.EndOfMessage);
            }
            catch (Exception e) { lastError = e.Message; break; }
            JsonNode? msg;
            try { msg = JsonNode.Parse(sb.ToString()); } catch { continue; }
            if (msg is null) continue;
            if (msg["id"] is { } mid) { if (waiters.TryRemove((int)mid, out var t)) t.TrySetResult(msg); continue; }
            switch ((string?)msg["method"])
            {
                case "Tracing.dataCollected":
                    {
                        var v = msg["params"]!["value"];
                        if (v is null) break;
                        // 一段就是一个 JSON 数组；**原样一行**写下去（analyze 按行拼回）：
                        // Chrome 有可能把一条事件切成两半，行级拼接能兜住这种情况。
                        var text = v.ToJsonString();
                        if (text.Length <= 2) break;
                        lock (w) { w.WriteLine(text); chunks++; bytes += text.Length; }
                        break;
                    }
                case "Tracing.tracingComplete":
                    complete.TrySetResult(true);
                    break;
                case "Tracing.bufferUsage":
                    usage = Num(msg["params"]?["percentFull"]);
                    break;
            }
        }
    });

    async Task<JsonNode> Send(string method, object? p = null, int timeoutMs = 20000)
    {
        var my = Interlocked.Increment(ref id);
        var tcs = new TaskCompletionSource<JsonNode>();
        waiters[my] = tcs;
        var payload = JsonSerializer.Serialize(new { id = my, method, @params = p ?? new { } });
        await ws.SendAsync(Encoding.UTF8.GetBytes(payload), WebSocketMessageType.Text, true, default);
        var done = await Task.WhenAny(tcs.Task, Task.Delay(timeoutMs));
        if (done != tcs.Task) throw new TimeoutException(method);
        return await tcs.Task;
    }

    Console.CancelKeyPress += (_, e) => { e.Cancel = true; cts.Cancel(); };
    Console.WriteLine($"recording → {outPath}");
    Console.WriteLine("  照常用这个窗口。卡住之后**别关它**，回来按 Ctrl+C（或建 stop 文件）停录。");
    Console.WriteLine($"  cats: {cats}");

    await Send("Tracing.start", new
    {
        traceConfig = new
        {
            includedCategories = cats.Split(',', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries),
            excludedCategories = Array.Empty<string>(),
            // ⚠️ 默认是 recordUntilFull：录满一圈**悄悄停掉**，卡死时发现「怎么没数据」。
            recordMode = "recordAsMuchAsPossible",
        },
        transferMode = "ReportEvents",
    });
    var traceStarted = DateTime.Now;
    startedAt = traceStarted;
    Meta();
    var lastPrint = -1;

    while (!cts.IsCancellationRequested && !complete.Task.IsCompleted)
    {
        await Task.Delay(500);
        if (File.Exists(stopFile)) { try { File.Delete(stopFile); } catch { } break; }
        if (minutes > 0 && started.Elapsed.TotalMinutes >= minutes) break;
        // ⚠️ 盘的保护：不设上限的话「录一天」等于把盘写满（实测 ~1.1 MB/s ⇒ 一小时 4 GB）。
        // 到了上限就**干净地停下**（已经落盘的照样能分析），而不是把文件写到一半断掉。
        if (maxMb > 0 && bytes / 1048576.0 >= maxMb)
        {
            Console.WriteLine($"  到 --max-mb（{maxMb:F0} MB）了，停录。下次可以 --cats devtools.timeline 更省。");
            break;
        }
        if ((int)(started.Elapsed.TotalSeconds) % 30 == 0 && lastPrint != (int)started.Elapsed.TotalSeconds)
        {
            lastPrint = (int)started.Elapsed.TotalSeconds;
            lock (w) { w.Flush(); }
            Console.WriteLine($"  +{(int)started.Elapsed.TotalSeconds,5}s  {bytes / 1048576.0,6:F1} MB  {chunks} 段  缓冲 {usage:F0}%");
        }
    }

    Console.WriteLine("停止录制，向 browser 要尾巴…");
    try { await Send("Tracing.end", null, 15000); } catch (Exception e) { Console.WriteLine("  Tracing.end 没回：" + e.Message); }
    var ok = await Task.WhenAny(complete.Task, Task.Delay(30000)) == complete.Task;
    if (!ok) Console.WriteLine("  ⚠️ 没等到 tracingComplete（多半是渲染进程卡住了）——已经落盘的部分照样能分析。");
    lock (w) { w.Flush(); }
    try { w.Dispose(); } catch { }
    Meta();

    Console.WriteLine($"done    : {outPath}");
    Console.WriteLine($"          {bytes / 1048576.0:F1} MB · {chunks} 段 · 录了 {(int)started.Elapsed.TotalSeconds} 秒");
    Console.WriteLine($"next    : dotnet run e2e\\trace.cs analyze \"{outPath}\"");
    if (!headless) Console.WriteLine("注意    : 这个 Chrome 还开着（录的就是它）。下次 record 会复用它；想留住现场就别关窗口。");
    if (headless) { try { if (!proc.HasExited) proc.Kill(true); } catch { } }
    return 0;

    void Meta()
    {
        try
        {
            File.WriteAllText(metaPath, JsonSerializer.Serialize(new
            {
                startedAt = startedAt.ToString("o", CultureInfo.InvariantCulture),
                url,
                cats,
                headless,
                chunks,
                bytes,
            }, new JsonSerializerOptions { WriteIndented = true }));
        }
        catch { /* 写不进 sidecar 不影响主功能 */ }
    }
}

// ───────────────────────────────────────────────────────────── analyze ──

static int Analyze(string? path, Dictionary<string, string> o)
{
    if (string.IsNullOrEmpty(path)) { Console.WriteLine("需要一个 trace 文件"); return 2; }
    path = Path.GetFullPath(path);
    if (!File.Exists(path)) { Console.WriteLine("没有这个文件：" + path); return 2; }
    var minGapMs = double.Parse(Get(o, "min-gap", "800"), CultureInfo.InvariantCulture);
    var top = int.Parse(Get(o, "top", "10"), CultureInfo.InvariantCulture);

    DateTime? startedAt = null;
    var metaPath = path + ".meta.json";
    if (File.Exists(metaPath))
    {
        try
        {
            var raw = (string?)JsonNode.Parse(File.ReadAllText(metaPath))!["startedAt"];
            if (!string.IsNullOrEmpty(raw)) startedAt = DateTime.Parse(raw, CultureInfo.InvariantCulture, DateTimeStyles.RoundtripKind);
        }
        catch { }
    }

    var names = new Dictionary<(long, long), string>();
    var stat = new Dictionary<(long, long), Stat>();
    var events = 0L;
    var minTs = double.MaxValue;
    var maxTs = double.MinValue;
    var bad = 0;

    using var sr = new StreamReader(path, Encoding.UTF8, false, 1 << 20);
    var pending = "";
    string? line;
    while ((line = sr.ReadLine()) is not null)
    {
        if (line.Length == 0) continue;
        // 一段一行，**行本身就是一段 JSON 数组**（`[...]`）。这里只把它的外框剥掉，再和上一段的
        // 残留拼起来：两段之间正常是逗号（彼此独立），而 Chrome 偶尔把一条事件切成两半——那种
        // 时候两半之间**什么都不能插**。两种都试一次，谁解析得出来用谁。
        var t = line;
        if (t.Length > 2 && t[0] == '[') t = t[1..];
        if (t.Length > 1 && t[^1] == ']') t = t[..^1];
        var body = pending.Length == 0 ? t : pending + "," + t;
        JsonNode? arr = null;
        try { arr = JsonNode.Parse("[" + body + "]"); }
        catch
        {
            try { arr = JsonNode.Parse("[" + (pending.Length == 0 ? t : pending + t) + "]"); }
            catch
            {
                pending = body;
                if (pending.Length > 64 << 20) { pending = ""; bad++; }   // 垃圾不留在内存里
                continue;
            }
        }
        pending = "";
        if (arr is not JsonArray a) continue;
        foreach (var n in a)
        {
            if (n is not JsonObject e) continue;
            events++;
            var ph = (string?)e["ph"];
            var ts = Num(e["ts"]);
            var pid = (long)Num(e["pid"]);
            var tid = (long)Num(e["tid"]);

            if (ph == "M")
            {
                var nm = (string?)e["name"];
                if (nm == "thread_name" || nm == "process_name")
                {
                    var label = (string?)e["args"]?["name"];
                    if (label is not null) names[(pid, tid)] = nm == "process_name" ? "proc:" + label : label;
                }
                continue;
            }
            // ⚠️ 元数据事件带着 `ts=0`（`thread_name` 那一类），把它算进时间轴的话，后面每个偏移都
            // 变成「从 1970 起」——第一版就是这么把一段 26 秒的 trace 印成 33 分钟的。所以时间轴
            // 只由真正的事件决定。
            if (ts <= 0) continue;
            if (ts < minTs) minTs = ts;
            if (ts > maxTs) maxTs = ts;

            var key = (pid, tid);
            if (!stat.TryGetValue(key, out var s)) { s = new Stat(); stat[key] = s; }
            s.Count++;
            if (ts < s.First) s.First = ts;
            if (ts > s.Last)
            {
                var gapMs = (ts - s.Last) / 1000.0;
                if (gapMs >= minGapMs && s.Last > 0)
                    s.AddGap(new Gap { Key = key, From = s.Last, To = ts, Ms = gapMs, Prev = s.LastName, PrevDur = s.LastDur, Next = (string?)e["name"] ?? "?" });
                s.Last = ts;
            }
            s.LastName = (string?)e["name"] ?? "?";
            s.LastDur = Num(e["dur"]);
        }
        continue;
    }

    if (events == 0) { Console.WriteLine("这个 trace 文件里没有事件（录制期间浏览器没给任何东西 / 类目不对）"); return 2; }

    string Name((long, long) k) => names.TryGetValue(k, out var v) ? v : $"{k.Item1}/{k.Item2}";
    // ⚠️ 只报「这会儿本该在干活」的线程。线程池 / 光栅化工作线程闲着不发事件是**正常**的，
    // 把它们算进来，最长的那几条空白永远被它们占着，真正的主线程反而排不上（第一版的坑）。
    var mainLike = new[] { "CrRendererMain", "CrBrowserMain", "CrGpuMain", "VizCompositorThread", "Compositor", "CrUtilityMain", "DedicatedWorker", "Chrome_ChildIOThread", "Chrome_IOThread" };
    var only = Get(o, "threads", "");
    var showAll = o.ContainsKey("all");
    bool Interesting((long, long) k)
    {
        if (showAll) return true;
        var nm = names.TryGetValue(k, out var v) ? v : "";
        if (only.Length > 0) return only.Split(',', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries)
            .Any(x => nm.Contains(x, StringComparison.OrdinalIgnoreCase));
        return mainLike.Any(x => nm.StartsWith(x, StringComparison.OrdinalIgnoreCase));
    }
    static string Fmt(DateTime? at, double minTs, double ts)
    {
        var off = (ts - minTs) / 1e6;
        var hms = TimeSpan.FromSeconds(off);
        var rel = $"{(int)hms.TotalMinutes:00}:{hms.Seconds:00}.{hms.Milliseconds:000}";
        if (at is null) return "+" + rel;
        var abs = at.Value + hms;
        return rel + "  (" + abs.ToString("yyyy-MM-dd HH:mm:ss.fff", CultureInfo.InvariantCulture) + ")";
    }

    Console.WriteLine($"trace   : {path}  ({new FileInfo(path).Length / 1048576.0:F1} MB, {events} 个事件, {stat.Count} 条线程)"
        + (startedAt is null ? "" : "  · 起录 " + startedAt.Value.ToString("yyyy-MM-dd HH:mm:ss", CultureInfo.InvariantCulture)));
    if (bad > 0) Console.WriteLine($"⚠️ {bad} 处无法解析的片段被跳过");
    Console.WriteLine($"分支    : 最长空白 ≥ {minGapMs:F0} ms，列前 {top} 条（线程筛选：{(showAll ? "全部" : only.Length > 0 ? only : "主线程那一类")}）");
    if (minTs > maxTs) { Console.WriteLine("没有可用的时间轴"); return 2; }
    Console.WriteLine($"跨度    : {(maxTs - minTs) / 1e6:F1} 秒");
    Console.WriteLine();

    var shown = stat.Where(kv => Interesting(kv.Key))
        .SelectMany(kv => kv.Value.Gaps)
        .OrderByDescending(g => g.Ms)
        .Take(top)
        .ToList();

    // `--at 08:55:59`：把 watchdog 横幅上那个时刻直接对上。卡死时我们手里只有横幅上的时间，
    // 所以「哪条空白正好覆盖那一刻」是最快的接头方式——有它就先把那几条顶到前面并打星。
    var hits = new HashSet<Gap>();
    if (o.TryGetValue("at", out var atText) && startedAt is not null)
    {
        var fmts = new[] { "yyyy-MM-dd HH:mm:ss", "yyyy-MM-dd HH:mm:ss.fff", "HH:mm:ss" };
        if (DateTime.TryParseExact(atText.Trim(), fmts, CultureInfo.InvariantCulture, DateTimeStyles.None, out var at))
        {
            var target = minTs + (at - startedAt.Value).TotalSeconds * 1e6;
            foreach (var g in shown) if (g.From <= target && target <= g.To) hits.Add(g);
            Console.WriteLine(hits.Count > 0
                ? $"★ 你给的时间点 {atText} 落在下面打了 ★ 的空白里（打星的排在前面）。"
                : $"★ 你给的时间点 {atText} 不在上面任何一条空白里（时间轴按起录时刻对齐，误差在 1 秒内）。");
            Console.WriteLine();
            shown = shown.OrderBy(g => hits.Contains(g) ? 0 : 1).ThenByDescending(g => g.Ms).ToList();
        }
        else Console.WriteLine($"⚠️ --at 认不出这个时间：{atText}（要 HH:mm:ss 或 yyyy-MM-dd HH:mm:ss）");
    }
    if (shown.Count == 0)
    {
        Console.WriteLine("感兴趣的那几条线程上都没有超过门槛的空白——这段时间里它们一直在动。");
        Console.WriteLine("（想连线程池一起看就加 --all）");
        return 0;
    }

    for (var i = 0; i < shown.Count; i++)
    {
        var g = shown[i];
        Console.WriteLine($"{(hits.Contains(g) ? "★" : "#")}{i + 1}  空白 {g.Ms / 1000.0,7:F2} s   @ {Fmt(startedAt, minTs, g.To)}   线程 {Name(g.Key)}（pid {g.Key.Item1} / tid {g.Key.Item2}）");
        Console.WriteLine($"     空白前最后一个事件：{g.Prev}{(g.PrevDur > 0 ? $"  (持续 {g.PrevDur / 1000.0:F1} ms)" : "")}");
        Console.WriteLine($"     空白后第一个事件  ：{g.Next}");
        Console.WriteLine();
    }

    // 哪些线程在场：判读「只有主线程空白」和「连 GPU/合成器一起空白」是两回事。
    Console.WriteLine("在场的线程（事件多的在前，最多 12 条）：");
    foreach (var kv in stat.OrderByDescending(x => x.Value.Count).Take(12))
        Console.WriteLine($"  {kv.Value.Count,9}  {Name(kv.Key),-28} 跨度 {(kv.Value.Last - kv.Value.First) / 1e6,8:F1}s");
    Console.WriteLine();
    Console.WriteLine("怎么读：空白前是 `*::RunTask` ⇒ 主线程被某个任务占住；是 `BeginMainFrame`/`Layout`/`Paint` ⇒");
    Console.WriteLine("渲染那一路；若 CrGpuMain / VizCompositorThread 与主线程**一起**空白 ⇒ 卡在合成或 GPU；");
    Console.WriteLine("只有主线程空白而 CrBrowserMain 还在动 ⇒ 问题在这个渲染进程自己身上。");
    return 0;
}

// ────────────────────────────────────────────────────────────── shared ──

static void Help() => HelpAnd(0);

static int HelpAnd(int code)
{
    Console.WriteLine("""
Cadenza · trace — 卡死现场的外部记录仪

  dotnet run e2e\trace.cs record [--url http://127.0.0.1:17990/] [--port 9444]
                                  [--out <file.jsonl>] [--profile <dir>]
                                  [--cats toplevel,devtools.timeline,ipc] [--max-mb 3000]
                                  [--minutes N] [--headless]
     起一个带 --remote-debugging-port 的 Chrome（独立 profile）并开始录 trace。
     停：Ctrl+C · 在 trace 文件旁建同名 .stop 文件 · --minutes 到点 · 到 --max-mb。
     实测 ~1.1 MB/s（一小时 4 GB）：**按下一次卡死就停**，不要一录一整天。
     想更省：--cats devtools.timeline（~0.3 MB/s，但少了「合成器/GPU 是否也停了」那一格）。

  dotnet run e2e\trace.cs analyze <file.jsonl> [--min-gap 800] [--top 10]
                                  [--at HH:mm:ss] [--threads a,b] [--all]
     找出各线程上最长的几段空白，并打印空白前后的事件名。
     --at 就是 watchdog 横幅上那个时刻，命中的空白会打 ★ 并顶到前面。
     默认只看「本该在干活」的线程（渲染主线程 / 浏览器主线程 / GPU / 合成器 …）；
     --all 连线程池、光栅化工作线程一起看——它们闲着不发事件是正常的，别被误导。

  为什么要有它：卡死时页面里所有报信的东西都堵在同一条主线程上（DevTools 也要问主线程），
  只有 trace 由 browser 进程生成、由外部进程落盘，卡死之后还能回头看它是从哪一刻开始的。
""");
    return code;
}

static Dictionary<string, string> ParseOpts(string[] a)
{
    var d = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
    for (var i = 0; i < a.Length; i++)
    {
        if (!a[i].StartsWith("--")) continue;
        var k = a[i][2..];
        d[k] = i + 1 < a.Length && !a[i + 1].StartsWith("--") ? a[++i] : "1";
    }
    return d;
}

static string Get(Dictionary<string, string> d, string k, string fallback) => d.TryGetValue(k, out var v) ? v : fallback;

static double Num(JsonNode? n)
{
    if (n is JsonValue v)
    {
        if (v.TryGetValue<double>(out var d)) return d;
        if (v.TryGetValue<long>(out var l)) return l;
    }
    return n is null ? 0 : double.TryParse(n.ToString(), NumberStyles.Float, CultureInfo.InvariantCulture, out var p) ? p : 0;
}

sealed class Stat
{
    public long Count;
    public double First = double.MaxValue;
    public double Last;
    public string LastName = "?";
    public double LastDur;
    // 每条线程只留最长的三处空白：线程池/光栅化那些**本来就在闲**的线程，动辄十几秒不发事件，
    // 一律收进来会把真正的主线程挤出去（第一版就是这样，前五条全是 CompositorTileWorker 在打盹）。
    public readonly List<Gap> Gaps = new();

    public void AddGap(Gap g)
    {
        Gaps.Add(g);
        if (Gaps.Count <= 3) return;
        var min = 0;
        for (var i = 1; i < Gaps.Count; i++) if (Gaps[i].Ms < Gaps[min].Ms) min = i;
        Gaps.RemoveAt(min);
    }
}

sealed class Gap
{
    public (long, long) Key;
    public double From;
    public double To;
    public double Ms;
    public string Prev = "?";
    public double PrevDur;
    public string Next = "?";
}
