using System.Text.Json;

namespace StardewAgentBridge;

public interface IGameAction
{
    object? Tick();
    void Cancel();
}

// 主线程只允许一个写动作；「已用 ID」和「终态缓存」分开保存：
// 缓存被淘汰也不能让消费动作重新执行，这是扣钱/扣物品类动作的最后一道保险。
public sealed class ActionCoordinator
{
    private sealed record Active(Request Request, object Owner, IGameAction Action, DateTime StartedAt, DateTime Deadline, Action<Response> Reply);

    private Active? active;
    private readonly Dictionary<string, string> seen = new();
    private readonly Dictionary<string, Response> completed = new();
    private readonly Queue<string> order = new();
    private readonly ControlAuthority control;
    private readonly Func<Response, Response> decorate;

    public Action<Exception>? OnError { get; set; }

    public ActionCoordinator(ControlAuthority control, Func<Response, Response> decorate)
    {
        this.control = control;
        this.decorate = decorate;
    }

    public string? ActiveId => active?.Request.ActionId;
    public string? ActiveCommand => active?.Request.Command;
    public int RecordedActions => seen.Count;

    public object Status(string[] releasedInputs) => new
    {
        kind = "status",
        activeActionId = ActiveId,
        command = ActiveCommand,
        recordedActions = seen.Count,
        actionLimit = 65536,
        releasedInputs,
        epoch = control.Epoch,
        holderName = control.HolderName,
        expiresAt = control.ExpiresAt?.ToString("o")
    };

    private static string Signature(Request r) => r.Command + ":" + Canonical(r.Args);

    private static string Canonical(JsonElement value) => value.ValueKind == JsonValueKind.Object
        ? "{" + string.Join(",", value.EnumerateObject().OrderBy(p => p.Name, StringComparer.Ordinal).Select(p => JsonSerializer.Serialize(p.Name) + ":" + Canonical(p.Value))) + "}"
        : value.ValueKind == JsonValueKind.Array
            ? "[" + string.Join(",", value.EnumerateArray().Select(Canonical)) + "]"
            : value.GetRawText();

    public void Start(Request request, object owner, DateTime deadline, Func<IGameAction> create, Action<Response> reply)
    {
        var id = request.ActionId!;
        if (seen.TryGetValue(id, out var signature))
        {
            if (signature != Signature(request))
            {
                reply(Response.Fail(request, "IDEMPOTENCY_CONFLICT", "同一 actionId 不能用于不同参数。", control.Epoch, 0));
                return;
            }
            if (completed.TryGetValue(id, out var previous))
            {
                reply(previous with { RequestId = request.RequestId });
                return;
            }
            reply(Response.Unknown(request, "RESULT_UNKNOWN", "该 actionId 已提交但尚无最终结果：请查询、观察后决定，不能重新执行。", control.Epoch, 0));
            return;
        }
        if (active != null)
        {
            reply(Response.Fail(request, "ACTION_BUSY", "已有动作正在执行。", control.Epoch, 0, true, "wait"));
            return;
        }
        if (seen.Count >= 65536)
        {
            reply(Response.Fail(request, "OUTPUT_LIMIT", "本次存档会话已达 65536 个动作记录上限，请正常保存并重新加载；旧消费请求不能重放。", control.Epoch, 0));
            return;
        }
        // 先记录 ID：即使创建动作时游戏抛错，重试也不能再次消费物品。
        seen.Add(id, Signature(request));
        try { active = new(request, owner, create(), DateTime.UtcNow, deadline, reply); }
        catch (Exception error)
        {
            if (error is not ActionFault) OnError?.Invoke(error);
            var response = Fault(request, error);
            response = decorate(response);
            Remember(response);
            reply(response);
        }
    }

    public void Tick(DateTime now, Func<object, bool> disconnected)
    {
        if (active == null) return;
        if (disconnected(active.Owner)) { Stop("CANCELLED", "发起动作的连接已断开，已释放游戏输入。"); return; }
        if (now >= active.Deadline) { Stop("TIMEOUT", "游戏动作超时，已停止后续操作；结果不明请先观察。"); return; }
        try
        {
            var result = active.Action.Tick();
            if (result != null) Finish(Response.Ok(active.Request, result, control.Epoch, Elapsed(active)));
        }
        catch (Exception error)
        {
            if (error is not ActionFault) OnError?.Invoke(error);
            Finish(Fault(active!.Request, error, mayHaveEffects: true));
        }
    }

    public void Stop(string code = "CANCELLED", string message = "已停止自动动作并释放输入。")
    {
        if (active != null) Finish(Response.Unknown(active.Request, code, message, control.Epoch, Elapsed(active)));
    }

    /// <summary>只停止指定 actionId 的动作；不是自己发起的就不动。返回是否真的停掉了某个动作。</summary>
    public bool StopIfOwned(string? actionId)
    {
        if (active == null) return false;
        if (actionId != null && active.Request.ActionId != actionId) return false;
        Stop("CANCELLED", "已按请求停止动作并释放游戏输入。");
        return true;
    }

    public void Reset()
    {
        Stop("STALE_REF", "存档会话已改变。");
        seen.Clear();
        completed.Clear();
        order.Clear();
    }

    private static long Elapsed(Active active) => Math.Max(0, (long)(DateTime.UtcNow - active.StartedAt).TotalMilliseconds);

    private void Finish(Response response)
    {
        var prior = active!;
        active = null;
        try { prior.Action.Cancel(); }
        catch (Exception error)
        {
            OnError?.Invoke(error);
            response = response with
            {
                Status = "unknown",
                Error = new Fault("RESULT_UNKNOWN", "停止动作时发生异常，结果不明。", false, "query_action")
            };
        }
        response = decorate(response);
        Remember(response);
        prior.Reply(response);
    }

    private void Remember(Response response)
    {
        if (response.ActionId == null) return;
        completed[response.ActionId] = response;
        order.Enqueue(response.ActionId);
        while (order.Count > 256) completed.Remove(order.Dequeue());
    }

    private Response Fault(Request request, Exception error, bool mayHaveEffects = false) => error is ActionFault fault
        ? mayHaveEffects
            ? Response.Unknown(request, fault.Code, fault.Message, control.Epoch, 0)
            : Response.Fail(request, fault.Code, fault.Message, control.Epoch, 0)
        : Response.Unknown(request, "INTERNAL_ERROR", "游戏动作发生异常：结果不明，请重新观察并查看 SMAPI 日志。", control.Epoch, 0);
}
