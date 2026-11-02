// Mock OpenAI-chat upstream for Cadenza E2E. Keyword-scripted replies.
using System.Net;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;

var port = args.Length > 0 ? args[0] : "15799";
var l = new HttpListener();
l.Prefixes.Add($"http://127.0.0.1:{port}/");
l.Start();
Console.WriteLine($"mock on {port}");
var n = 0;
var flaky = new System.Collections.Concurrent.ConcurrentDictionary<string, int>();
var goalTurns = new System.Collections.Concurrent.ConcurrentDictionary<string, int>();
while (true)
{
    var ctx = await l.GetContextAsync();
    _ = Task.Run(async () =>
    {
        using var r = new StreamReader(ctx.Request.InputStream, Encoding.UTF8);
        var body = await r.ReadToEndAsync();
        if (Environment.GetEnvironmentVariable("MOCK_DUMP") == "1") File.WriteAllText($"req-{n + 1}.json", body);

        // Tavily 形状的搜索端点：联网工具的可配置端点就能指到这里（不打真网）。
        if (string.Equals(ctx.Request.Url?.AbsolutePath, "/search", StringComparison.Ordinal))
        {
            var query = "";
            try { query = (string?)System.Text.Json.Nodes.JsonNode.Parse(body)?["query"] ?? ""; } catch { }
            var search = new JsonObject
            {
                ["answer"] = "模拟摘要：" + query,
                ["results"] = new JsonArray(new JsonObject
                {
                    ["title"] = "README 示例",
                    ["url"] = "https://example.test/readme",
                    ["content"] = "这是模拟的搜索结果。",
                    ["score"] = 0.91,
                }),
            };
            await Write(ctx, search.ToJsonString());
            return;
        }

        var req = JsonNode.Parse(body)!;
        var msgs = req["messages"]!.AsArray();
        if (Environment.GetEnvironmentVariable("MOCK_DUMP") == "1") File.WriteAllText($"req-{n + 1}.json", body);
        // Decide by the latest non-system turn: if a tool result came after the last assistant turn, summarise it.
        string role = "user", content = "";
        // The core appends a synthetic floating_context call+result each step; ignore that pair.
        static bool Synthetic(JsonNode m) =>
            ((string?)m["tool_call_id"] ?? "").StartsWith("floating-")
            || (m["tool_calls"] is JsonArray tc && tc.Count > 0 && tc.All(t => ((string?)t!["id"] ?? "").StartsWith("floating-")));
        for (var k = msgs.Count - 1; k >= 0; k--)
        {
            var m = msgs[k]!;
            if (Synthetic(m)) continue;
            var mrole = (string?)m["role"];
            if (mrole == "assistant") break;
            if (mrole == "tool") { role = "tool"; break; }
            if (mrole == "user") break;
        }
        if (role != "tool")
        {
            for (var k = msgs.Count - 1; k >= 0; k--)
            {
                if ((string?)msgs[k]!["role"] != "user") continue;
                var c = msgs[k]!["content"];
                content = c is JsonValue v && v.TryGetValue<string>(out var s) ? s : c?.ToJsonString() ?? "";
                break;
            }
        }
        var id = Interlocked.Increment(ref n);
        JsonObject message;
        // ⚠️ **上一轮用户消息里有没有图**（`16-images` 靠这个证伪/证实）：
        // 只认协议里那一格（`content` 数组里的 `image_url`），不猜「是不是刚上传过」——
        // 判据必须是**上游真的收到了什么**，而不是头以为它发了什么。
        // ⚠️ 位置在 `if/else if` 链**之前**：插进链中间会把链断开（C# 里那是语法错误）。
        var hasImage = false;
        var imageNote = "";
        for (var k = msgs.Count - 1; k >= 0 && !hasImage; k--)
        {
            if ((string?)msgs[k]!["role"] != "user") continue;
            if (msgs[k]!["content"] is not JsonArray parts) continue;
            foreach (var p in parts)
            {
                if ((string?)p?["type"] != "image_url") continue;
                var url = (string?)p!["image_url"]?["url"] ?? "";
                hasImage = true;
                imageNote = url.StartsWith("data:image/png;base64,")
                    ? "PNG 的 data URL"
                    : url.Length > 40 ? url[..40] + "…" : url;
                break;
            }
        }

        if (role == "tool")
        {
            // goal 收尾：finish_goal 的结果里写着「目标收尾已记录」——回一段总结，让最后一步像真的收尾。
            var toolText = LastToolText(msgs);
            message = toolText.Contains("目标收尾")
                ? Text("目标已完成。总结：长任务收尾，没有遗留项。", "目标已收，做一句总结。")
                : Text("工具结果收到了。我看了一下：\n\n- 输出正常\n- 没有发现异常\n\n```csharp\nvar ok = true; // 示例代码\n```\n\n要继续吗？", "检查工具返回的内容，归纳结论。");
        }
        // ⚠️ **上一轮用户消息里有没有图**（`16-images` 靠这个证伪/证实）：
        // 只认协议里那一格（`content` 数组里的 `image_url`），不猜「是不是刚上传过」——
        // 判据必须是**上游真的收到了什么**，而不是头以为它发了什么。
        else if (hasImage)
            message = Text($"看到图了：{imageNote}", "用户发了图，我看得到。");
        else if (content.Contains("ls"))
            message = Call("ls", "{\"path\":\".\"}", "用户想看目录，调 ls。");
        else if (content.Contains("write"))
            message = Call("write", "{\"path\":\"cadenza-demo.txt\",\"content\":\"hello from cadenza\\n\"}", "要写文件，这一步需要审批。");
        else if (content.Contains("ask"))
            message = Call("ask", "{\"questions\":[{\"id\":\"layout\",\"question\":\"用哪种布局？\",\"type\":\"choice\",\"options\":[\"三栏\",\"双栏\",\"单栏\"]},{\"id\":\"name\",\"question\":\"给项目起个名字\",\"type\":\"text\"},{\"id\":\"meta\",\"question\":\"补充信息\",\"type\":\"form\",\"fields\":[{\"name\":\"owner\",\"label\":\"负责人\",\"value\":\"lila\"},{\"name\":\"due\",\"label\":\"截止\"}]}]}", "需要用户决定几件事。");
        else if (content.Contains("search"))
            message = Call("search", "{\"pattern\":\"readme\",\"mode\":\"content\"}", "用户要搜索，用 search。");
        else if (content.Contains("联网"))
            message = Call("web_search", "{\"query\":\"lilara\"}", "用户要联网搜索。");
        else if (content.Contains("跑命令"))
            message = Call("shell", "{\"command\":\"echo mock-shell-ok\"}", "用户要跑一条命令，用 shell。");
        // 后台任务一族（14-jobs）：先起一个真进程（4 秒，够「在跑」被看见、也够被停掉），
        // 再让模型盘点一次任务表。⚠️ 这两个分支必须排在「跑命令」之前见上面的顺序无关——
        // 「后台跑」里不含「跑命令」，两串不重叠。
        else if (content.Contains("后台跑"))
            message = Call("shell", "{\"command\":\"echo bg-start; sleep 30; echo bg-done\",\"background\":true}", "用户要一条后台命令。");
        else if (content.Contains("盘点任务"))
            message = Call("jobs", "{}", "用户想看后台任务表。");
        // `wait`：把对话里出现过的那个 job id 交给它（模型自己也是这么拿到的）。任务此时已被停掉，
        // 于是 wait 立刻返回「等到了 … Killed」——这一步验的是**卡片**，不是等待本身。
        else if (content.Contains("等它跑完"))
        {
            var jid = FindJobId(msgs);
            message = jid is null
                ? Text("没有可等的任务。", null)
                : Call("wait", $"{{\"task\":\"{jid}\",\"timeoutSeconds\":5}}", "用户要我等后台任务。");
        }
        // Same tool, but the script takes ~4 s: long enough to interrupt before it finishes,
        // and it leaves two files behind so 「真的被杀掉了吗」有物证可查。
        else if (content.Contains("长命令"))
            message = Call("shell", "{\"command\":\"echo started > shell-started.txt; sleep 4; echo finished > shell-finished.txt\"}", "用户要跑一条慢命令，用 shell。");
        else if (content.Contains("长任务"))
        {
            // goal 循环：前两次纯文本（让核心自动续跑），第三次调 finish_goal。
            var turn = goalTurns.AddOrUpdate(content, 1, (_, c) => c + 1);
            message = turn switch
            {
                < 3 => Text($"还在推进（第 {turn} 回合）。", null),
                _ => Call("finish_goal", "{}", "目标完成，调用 finish_goal 收尾。"),
            };
        }
        else if (content.Contains("edge"))
            // Table whose delimiter and body rows omit the edge pipes, with a cell-count mismatch.
            message = Text("| 检查 | 结果 |\n---|---\n源块默认值未声明 | 报错 |\n| ok | fine | extra |\n\n收工。", null);
        else if (content.Contains("slow"))
        {
            await Task.Delay(6000);
            message = Text("慢慢说完了。", null);
        }
        else if (content.Contains("fail"))
        {
            // Non-transient: the core does not retry a 400 ⇒ one `error` event right away.
            ctx.Response.StatusCode = 400;
            await Write(ctx, "{\"error\":{\"message\":\"mock bad request\"}}");
            return;
        }
        else if (content.Contains("overload"))
        {
            // Always transient ⇒ the core keeps retrying (retry.attempt events) until interrupted.
            ctx.Response.StatusCode = 503;
            await Write(ctx, "{\"error\":{\"message\":\"mock upstream overloaded\"}}");
            return;
        }
        else if (content.Contains("flaky") && flaky.AddOrUpdate(content, 1, (_, c) => c + 1) <= 2)
        {
            // First two calls for this text fail transiently, the third succeeds.
            ctx.Response.StatusCode = 503;
            await Write(ctx, "{\"error\":{\"message\":\"mock flaky upstream\"}}");
            return;
        }
        else
            message = Text($"## 收到\n\n你说的是：**{Trunc(content)}**。\n\n这是一个 *模拟* 回复，包含 `inline code`、列表：\n\n1. 第一项\n2. 第二项\n\n> 引用一句话。\n\n| 列 | 值 |\n|---|---|\n| a | 1 |\n| b | 2 |", "先想一想用户要什么。然后组织一个带格式的回答。");

        // ⚠️ **流式**（核心 2026-11）：只有请求里真的带了 `"stream": true` 才走 SSE。
        // 关着流式时这里**一个字节都不变**——e2e 的其它脚本靠这条判据证明「开关默认关」。
        if (req["stream"] is JsonValue sv && sv.TryGetValue<bool>(out var streaming) && streaming)
        {
            await WriteSse(ctx, message, id, 800 + body.Length / 4, 40 + id * 7);
            return;
        }

        var resp = new JsonObject
        {
            ["id"] = $"mock-{id}",
            ["model"] = (string?)req["model"] ?? "mock",
            ["choices"] = new JsonArray(new JsonObject
            {
                ["index"] = 0,
                ["message"] = message,
                ["finish_reason"] = message["tool_calls"] is null ? "stop" : "tool_calls",
            }),
            ["usage"] = new JsonObject
            {
                ["prompt_tokens"] = 800 + body.Length / 4,
                ["completion_tokens"] = 40 + id * 7,
                ["total_tokens"] = 840 + body.Length / 4 + id * 7,
                ["prompt_tokens_details"] = new JsonObject { ["cached_tokens"] = id > 1 ? 512 : 0 },
            },
        };
        await Task.Delay(700);
        await Write(ctx, resp.ToJsonString());
    });
}

static async Task Write(HttpListenerContext ctx, string s)
{
    var b = Encoding.UTF8.GetBytes(s);
    ctx.Response.ContentType = "application/json";
    ctx.Response.ContentLength64 = b.Length;
    await ctx.Response.OutputStream.WriteAsync(b);
    ctx.Response.Close();
}

// SSE（`text/event-stream`）：把同一条回复按协议切成增量帧发出去。
//
// ⚠️ 三件事必须与核心的读法对上（`OpenAiHttp.PostStreamAsync`）：
//   · 每帧一行 `data: <json>` + 空行——它只认 `data:` 开头的行；
//   · 结尾必须是 `data: [DONE]`（或者把连接关掉，但那会让「答完了」与「断了」混在一起）；
//   · `stream_options.include_usage` 的用量只出现在**尾帧**（`choices` 是空数组）。
// ⚠️ 每帧之前 `FlushAsync`：不 flush 的话整个响应在缓冲区里等到结束才到，
// 而「流式」在核心那边会退化成一次性的（测试仍然全绿，但什么也没证明）。
static async Task WriteSse(HttpListenerContext ctx, JsonObject message, int id, int promptTokens, int completionTokens)
{
    var res = ctx.Response;
    res.ContentType = "text/event-stream";
    res.Headers["Cache-Control"] = "no-store";
    res.SendChunked = true;             // SSE 没有内容长度；与 ContentLength64 互斥
    var output = res.OutputStream;

    async Task Send(string json)
    {
        await output.WriteAsync(Encoding.UTF8.GetBytes("data: " + json + "\n\n"));
        await output.FlushAsync();
    }

    JsonObject Chunk(JsonObject delta, string? finish) => new()
    {
        ["id"] = $"mock-{id}",
        ["object"] = "chat.completion.chunk",
        ["model"] = "mock",
        ["choices"] = new JsonArray(new JsonObject
        {
            ["index"] = 0,
            ["delta"] = delta,
            ["finish_reason"] = finish,
        }),
    };

    var reasoning = (string?)message["reasoning_content"];
    var text = (string?)message["content"] ?? "";
    var calls = message["tool_calls"] as JsonArray;

    // 次序与整份响应里的字段次序一致：思考 → 正文 → 工具调用。
    // ⚠️ 片间隔 150ms：核心的攒批窗口是 50ms，一片一帧会让「流式」看起来像一次性的。
    if (!string.IsNullOrEmpty(reasoning))
        foreach (var piece in Pieces(reasoning, 3))
        {
            await Send(Chunk(new JsonObject { ["reasoning_content"] = piece }, null).ToJsonString());
            await Task.Delay(150);
        }

    if (text.Length > 0)
        foreach (var piece in Pieces(text, 8))
        {
            await Send(Chunk(new JsonObject { ["content"] = piece }, null).ToJsonString());
            await Task.Delay(150);
        }

    if (calls is { Count: > 0 })
    {
        // id / name 一次给全，**参数分两半**：核心把 `arguments` 逐字拼接，
        // 拼接坏了就看不到工具卡（那正是这条分支要证的东西）。
        var call = calls[0]!.AsObject();
        var fn = call["function"]!.AsObject();
        var args = (string?)fn["arguments"] ?? "{}";
        var cut = args.Length / 2;
        await Send(Chunk(new JsonObject
        {
            ["tool_calls"] = new JsonArray(new JsonObject
            {
                ["index"] = 0,
                ["id"] = (string?)call["id"],
                ["type"] = "function",
                ["function"] = new JsonObject { ["name"] = (string?)fn["name"], ["arguments"] = args[..cut] },
            }),
        }, null).ToJsonString());
        await Task.Delay(150);
        await Send(Chunk(new JsonObject
        {
            ["tool_calls"] = new JsonArray(new JsonObject
            {
                ["index"] = 0,
                ["function"] = new JsonObject { ["arguments"] = args[cut..] },
            }),
        }, null).ToJsonString());
    }

    await Send(Chunk(new JsonObject(), calls is { Count: > 0 } ? "tool_calls" : "stop").ToJsonString());

    // 用量尾帧：`choices` 空数组，usage 只在这里（与 include_usage 的约定一致）。
    await Send(new JsonObject
    {
        ["id"] = $"mock-{id}",
        ["object"] = "chat.completion.chunk",
        ["model"] = "mock",
        ["choices"] = new JsonArray(),
        ["usage"] = new JsonObject
        {
            ["prompt_tokens"] = promptTokens,
            ["completion_tokens"] = completionTokens,
            ["total_tokens"] = promptTokens + completionTokens,
        },
    }.ToJsonString());

    await Send("[DONE]");
    res.Close();
}

// 把一段文本切成 n 片。
// ⚠️ 按 **rune** 而不是 char 切：C# 的 string 索引是 UTF-16 单元，切开一个 emoji 会得到
// 两个坏代理项，而它会被原样写进 JSON（服务端解析成功、屏幕上是一个问号）。
static IEnumerable<string> Pieces(string s, int n)
{
    var elems = new List<string>();
    foreach (var rune in s.EnumerateRunes()) elems.Add(rune.ToString());
    if (elems.Count == 0) yield break;
    var per = Math.Max(1, (int)Math.Ceiling(elems.Count / (double)n));
    for (var i = 0; i < elems.Count; i += per)
    {
        var take = Math.Min(per, elems.Count - i);
        yield return string.Concat(elems.GetRange(i, take));
    }
}
static string Trunc(string s) => s.Length > 40 ? s[..40] + "…" : s;

// 对话里出现过的第一个 `job-…`（模板文本，不含正则之外的转义）。mock 自己不知道任务 id，
// 而 `wait` 需要一个真的——它本来就在前面的工具结果里。
static string? FindJobId(JsonArray msgs)
{
    foreach (var m in msgs)
    {
        var c = m?["content"];
        var s = c is JsonValue v && v.TryGetValue<string>(out var t) ? t : c?.ToJsonString() ?? "";
        var i = s.IndexOf("job-", StringComparison.Ordinal);
        if (i < 0) continue;
        var end = i + 4;
        while (end < s.Length && Uri.IsHexDigit(s[end])) end++;
        if (end - i - 4 >= 6) return s[i..end];
    }
    return null;
}

// 最后一条**非浮动**工具结果的文本。goal 收尾要靠它判断「刚跑的是不是 finish_goal」。
static string LastToolText(JsonArray msgs)
{
    for (var k = msgs.Count - 1; k >= 0; k--)
    {
        var m = msgs[k]!;
        if ((string?)m["role"] != "tool") continue;
        if (((string?)m["tool_call_id"] ?? "").StartsWith("floating-")) continue;

        var c = m["content"];
        return c is JsonValue v && v.TryGetValue<string>(out var s) ? s : c?.ToJsonString() ?? "";
    }
    return "";
}
static JsonObject Text(string t, string? reasoning)
{
    var o = new JsonObject { ["role"] = "assistant", ["content"] = t };
    if (reasoning is not null) o["reasoning_content"] = reasoning;
    return o;
}
static JsonObject Call(string name, string argsJson, string reasoning) => new()
{
    ["role"] = "assistant",
    ["content"] = "好的，我来处理。",
    ["reasoning_content"] = reasoning,
    ["tool_calls"] = new JsonArray(new JsonObject
    {
        ["id"] = "call_" + Guid.NewGuid().ToString("N")[..10],
        ["type"] = "function",
        ["function"] = new JsonObject { ["name"] = name, ["arguments"] = argsJson },
    }),
};
