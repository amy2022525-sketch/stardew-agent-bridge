using System.Text.Json;
using System.Text.Json.Serialization;

namespace StardewAgentBridge;

// 一帧请求：op/protocol 由上游 Bridge 填写；epoch 是 Mod 侧签发的控制权代次，
// 迟到的请求带着旧 epoch 到达时会被拒绝，而不是被重新执行。
public sealed record Request(
    string RequestId,
    string Command,
    JsonElement Args,
    int TimeoutMs = 15000,
    string? ActionId = null,
    int Epoch = 0,
    string? Op = null,
    string? Protocol = null);

public sealed record Fault(
    string Code,
    string Message,
    bool EffectKnown,
    string NextAction);

// 一帧响应：status 取 succeeded/partial/failed/cancelled/unknown，
// error 携带 effectKnown 与 nextAction，供上层决定「查询 / 观察 / 停止」。
public sealed record Response(
    string Op,
    string RequestId,
    string Status,
    object? Result = null,
    Fault? Error = null,
    string? ActionId = null,
    int Epoch = 0,
    long ElapsedMs = 0)
{
    public static Response Ok(Request r, object? result, int epoch, long elapsedMs) =>
        new("response", r.RequestId, "succeeded", result, null, r.ActionId, epoch, elapsedMs);

    public static Response Partial(Request r, object? result, int epoch, long elapsedMs) =>
        new("response", r.RequestId, "partial", result, null, r.ActionId, epoch, elapsedMs);

    public static Response Fail(Request r, string code, string message, int epoch, long elapsedMs, bool? effectKnown = null, string? nextAction = null) =>
        new("response", r.RequestId, StatusFor(code), null, new Fault(code, message, effectKnown ?? EffectKnownFor(code), nextAction ?? NextActionFor(code)), r.ActionId, epoch, elapsedMs);

    public static Response Unknown(Request r, string code, string message, int epoch, long elapsedMs) =>
        new("response", r.RequestId, "unknown", null, new Fault(code, message, false, "query_action"), r.ActionId, epoch, elapsedMs);

    private static string StatusFor(string code) => code switch
    {
        "CANCELLED" => "cancelled",
        "TIMEOUT" => "unknown",
        "RESULT_UNKNOWN" => "unknown",
        _ => "failed"
    };

    // 明确知道「没有生效」的错误：允许上层换成新 ID 重试；其余不确定。
    private static bool EffectKnownFor(string code) => code switch
    {
        "RESULT_UNKNOWN" => false,
        "TIMEOUT" => false,
        "INTERNAL_ERROR" => false,
        "VERIFY_FAILED" or "LOAD_FAILED" => false,
        _ => true
    };

    private static string NextActionFor(string code) => code switch
    {
        "RESULT_UNKNOWN" or "TIMEOUT" => "query_action",
        "CANCELLED" => "observe",
        "STALE_REF" or "MENU_MISMATCH" or "NO_SAVE_LOADED" or "PAUSE_BLOCKED" or "OUT_OF_REACH" or "PATH_BLOCKED" => "observe",
        "CONTROL_EXPIRED" or "CONTROL_REQUIRED" or "CONTROL_BUSY" => "restart_control",
        "UNSUPPORTED" or "PROTOCOL_MISMATCH" => "upgrade",
        "AUTH_FAILED" or "GAME_UNAVAILABLE" => "fix_environment",
        "BUSY" or "ACTION_BUSY" => "wait",
        _ => "observe"
    };
}

public sealed class ActionFault : Exception
{
    public string Code { get; }

    public ActionFault(string code, string message) : base(message) => Code = code;
}

public static class Protocol
{
    public const string Name = "stardew-agent-bridge/1";

    public static readonly JsonSerializerOptions Json = new()
    {
        PropertyNamingPolicy = JsonNamingPolicy.CamelCase,
        PropertyNameCaseInsensitive = false,
        DefaultIgnoreCondition = JsonIgnoreCondition.Never
    };

    // 能力表只列出真实存在、可被 Agent 调用的命令。调试类命令（瞬移、资源修改、跳剧情）不存在。
    public static readonly string[] Capabilities =
    {
        "snapshot", "move", "select", "use", "interact", "menu", "screenshot", "status", "stop", "wait",
        "pause", "closemenu", "shop", "buy", "inspect", "ship", "container", "recipes", "craft", "place",
        "eat", "equip", "fish", "combat", "saves", "load", "control"
    };

    public static readonly string[] WriteCommands =
    {
        "move", "select", "use", "interact", "menu", "buy", "pause", "closemenu", "wait",
        "ship", "container", "craft", "place", "eat", "equip", "fish", "combat", "load"
    };

    public static void Validate(Request r)
    {
        if (r.Args.ValueKind != JsonValueKind.Object) throw new ActionFault("INVALID_ARGUMENT", "args 必须是 JSON 对象。");
        string[] allowed = r.Command switch
        {
            "hello" or "status" or "screenshot" or "stop" => r.Command == "stop" ? new[] { "actionId" } : Array.Empty<string>(),
            "snapshot" => new[] { "radius" },
            "control" => new[] { "operation", "holder", "leaseExpiresAt", "epoch", "pause", "mode" },
            "move" => new[] { "near", "tile" }, "select" => new[] { "slot" }, "use" or "interact" or "menu" => new[] { "target" },
            "wait" => new[] { "milliseconds" }, "pause" or "closemenu" => Array.Empty<string>(),
            "shop" => Array.Empty<string>(), "buy" => new[] { "itemId", "count" },
            "inspect" => new[] { "target" }, "ship" => new[] { "target", "slot", "count" },
            "container" => new[] { "target", "operation", "slot", "count" }, "recipes" => Array.Empty<string>(),
            "craft" => new[] { "recipe", "count" }, "place" => new[] { "target", "slot" }, "eat" => new[] { "slot" },
            "equip" => new[] { "slot", "kind", "operation" }, "fish" => new[] { "target", "milliseconds" },
            "combat" => new[] { "target", "milliseconds", "minHealth" },
            "saves" => Array.Empty<string>(), "load" => new[] { "saveId" },
            _ => throw new ActionFault("UNSUPPORTED", "未知命令。")
        };
        if (r.Args.EnumerateObject().Any(p => !allowed.Contains(p.Name))) throw new ActionFault("INVALID_ARGUMENT", "请求包含未知参数。");
        bool ValidId(string? id) => id != null && System.Text.RegularExpressions.Regex.IsMatch(id, "^[a-zA-Z0-9_-]{1,80}$");
        var readOnlyContainer = r.Command == "container" && Text(r.Args, "operation") == "list";
        if (IsWrite(r.Command) && !readOnlyContainer && !ValidId(r.ActionId)) throw new ActionFault("INVALID_ARGUMENT", "写动作需要有效 actionId。");
        if (r.Command == "snapshot" && r.Args.TryGetProperty("radius", out _) && (Integer(r.Args, "radius") < 1 || Integer(r.Args, "radius") > 16)) throw new ActionFault("INVALID_ARGUMENT", "radius 必须为 1–16。");
        if (r.Command == "select" && (Integer(r.Args, "slot") < 0 || Integer(r.Args, "slot") > 35)) throw new ActionFault("INVALID_ARGUMENT", "slot 必须为 0–35。");
        if (r.Command == "wait" && (Integer(r.Args, "milliseconds") < 100 || Integer(r.Args, "milliseconds") > 10000)) throw new ActionFault("INVALID_ARGUMENT", "milliseconds 必须为 100–10000。");
        if (r.Command == "stop" && r.Args.TryGetProperty("actionId", out _) && !ValidId(Text(r.Args, "actionId"))) throw new ActionFault("INVALID_ARGUMENT", "actionId 无效。");
        if (r.Command is "use" or "interact" or "menu") CheckReference(Text(r.Args, "target"));
        if (r.Command is "inspect" or "ship" or "place" or "container") CheckReference(Text(r.Args, "target"));
        if (r.Command is "fish" or "combat" && r.Args.TryGetProperty("target", out _)) CheckReference(Text(r.Args, "target"));
        if (r.Command is "ship" or "place" or "eat" or "equip" && (Integer(r.Args, "slot") < 0 || Integer(r.Args, "slot") > 35)) throw new ActionFault("INVALID_ARGUMENT", "slot 必须为 0–35。");
        if (r.Command == "container")
        {
            var operation = Text(r.Args, "operation");
            if (operation is not ("list" or "deposit" or "withdraw")) throw new ActionFault("INVALID_ARGUMENT", "operation 需要 list/deposit/withdraw。");
            if (operation != "list" && (Integer(r.Args, "slot") < 0 || Integer(r.Args, "slot") > (operation == "withdraw" ? 71 : 35))) throw new ActionFault("INVALID_ARGUMENT", "slot 超出支持范围。");
            if (operation != "list" && (Integer(r.Args, "count") < 1 || Integer(r.Args, "count") > 999)) throw new ActionFault("INVALID_ARGUMENT", "count 必须为1–999。");
        }
        if (r.Command is "ship" or "craft" && (Integer(r.Args, "count") < 1 || Integer(r.Args, "count") > 999)) throw new ActionFault("INVALID_ARGUMENT", "count 必须为1–999。");
        if (r.Command == "craft" && string.IsNullOrWhiteSpace(Text(r.Args, "recipe"))) throw new ActionFault("INVALID_ARGUMENT", "recipe 不能为空。");
        if (r.Command is "fish" or "combat" && r.Args.TryGetProperty("milliseconds", out _) && (Integer(r.Args, "milliseconds") < 100 || Integer(r.Args, "milliseconds") > (r.Command == "fish" ? 55000 : 10000))) throw new ActionFault("INVALID_ARGUMENT", "milliseconds 超出命令范围。");
        if (r.Command == "combat" && r.Args.TryGetProperty("minHealth", out _) && (Integer(r.Args, "minHealth") < 1 || Integer(r.Args, "minHealth") > 999)) throw new ActionFault("INVALID_ARGUMENT", "minHealth 必须为1–999。");
        if (r.Command == "equip")
        {
            if (Text(r.Args, "kind") is not ("hat" or "boots" or "leftRing" or "rightRing" or "pants" or "shirt")) throw new ActionFault("INVALID_ARGUMENT", "不支持此装备槽。");
            if (r.Args.TryGetProperty("operation", out _) && Text(r.Args, "operation") is not ("equip" or "unequip")) throw new ActionFault("INVALID_ARGUMENT", "operation 需要 equip/unequip。");
        }
        if (r.Command == "load")
        {
            var saveId = Text(r.Args, "saveId");
            if (string.IsNullOrWhiteSpace(saveId) || saveId.Length > 160 || saveId.IndexOfAny(new[] { '/', '\\', ':', '\0' }) >= 0 || saveId.Contains("..")) throw new ActionFault("INVALID_ARGUMENT", "saveId 需要 saves 返回的单个存档ID，不能包含路径。");
        }
        if (r.Command == "move")
        {
            if (r.Args.TryGetProperty("near", out _) == r.Args.TryGetProperty("tile", out var tile)) throw new ActionFault("INVALID_ARGUMENT", "move 需要 near 或 tile，且互斥。");
            if (r.Args.TryGetProperty("near", out _)) CheckReference(Text(r.Args, "near"));
            else if (tile.ValueKind != JsonValueKind.Object || tile.EnumerateObject().Any(p => p.Name is not ("x" or "y")) || Integer(tile, "x") < -1 || Integer(tile, "y") < -1) throw new ActionFault("INVALID_ARGUMENT", "tile 需要整数 x、y；-1 仅允许真实地图出口。");
        }
        if (r.Command == "buy")
        {
            var count = Integer(r.Args, "count");
            if (count < 1 || count > 999) throw new ActionFault("INVALID_ARGUMENT", "count 必须为 1–999。");
        }
    }

    private static void CheckReference(string reference)
    {
        if (!System.Text.RegularExpressions.Regex.IsMatch(reference, "^@s[0-9]+:[em][0-9]+$")) throw new ActionFault("INVALID_ARGUMENT", "目标引用格式无效。");
    }

    public static bool IsWrite(string command) => WriteCommands.Contains(command);

    public static string Text(JsonElement args, string key) => args.TryGetProperty(key, out var value) && value.ValueKind == JsonValueKind.String
        ? value.GetString()! : throw new ActionFault("INVALID_ARGUMENT", $"缺少字符串参数 {key}。");

    public static int Integer(JsonElement args, string key) => args.TryGetProperty(key, out var value) && value.ValueKind == JsonValueKind.Number && value.TryGetInt32(out var number)
        ? number : throw new ActionFault("INVALID_ARGUMENT", $"缺少整数参数 {key}。");

    public static bool Flag(JsonElement args, string key) => args.TryGetProperty(key, out var value) && value.ValueKind == JsonValueKind.True;
}
