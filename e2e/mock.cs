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
        if (role == "tool")
        {
            // goal 收尾：finish_goal 的结果里写着「目标收尾已记录」——回一段总结，让最后一步像真的收尾。
            var toolText = LastToolText(msgs);
            message = toolText.Contains("目标收尾")
                ? Text("目标已完成。总结：长任务收尾，没有遗留项。", "目标已收，做一句总结。")
                : Text("工具结果收到了。我看了一下：\n\n- 输出正常\n- 没有发现异常\n\n```csharp\nvar ok = true; // 示例代码\n```\n\n要继续吗？", "检查工具返回的内容，归纳结论。");
        }
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
