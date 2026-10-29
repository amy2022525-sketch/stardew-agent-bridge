using System.Text.Json;
using System.Text.Json.Nodes;
using Microsoft.Xna.Framework;
using Microsoft.Xna.Framework.Graphics;
using StardewModdingAPI;
using StardewModdingAPI.Events;
using StardewValley;
using StardewAgentBridge.Multiplayer;

namespace StardewAgentBridge;

/// <summary>
/// 游戏侧入口：把本机 Bridge 的请求翻译成游戏里的正常操作。
///
/// 关键约束：
/// - 只通过游戏正常流程动作（不使用传送、改资源、跳剧情）；
/// - 写动作必须带 Mod 侧签发的控制权 epoch，迟到的旧请求无法重新取得控制；
/// - 与 Bridge 失联超过阈值时，游戏侧自行释放输入并尝试正常暂停（不依赖 Bridge 还活着）；
/// - 每步动作后默认尝试正常暂停，但绝不关闭玩家自己打开的菜单，也不跳过剧情。
/// </summary>
public sealed class ModEntry : Mod
{
    private BridgeServer? server;
    private ModConfig config = new();
    private PlatformPaths.DataRootResult dataRoot = new();
    private readonly ControlAuthority control = new();
    private ActionCoordinator actions = null!;
    private readonly Observations observations = new();
    private readonly BackgroundUpdates background = new();
    private MultiplayerRuntime multiplayer = null!;
    private BridgeServer.Pending? screenshot;

    private string? cachedToken;
    private DateTime cachedTokenStamp = DateTime.MinValue;
    private DateTime lastWatchdogRelease = DateTime.MinValue;
    private bool bridgeLinkUp;
    private int? lastSceneGeneration;

    public override void Entry(IModHelper helper)
    {
        config = helper.ReadConfig<ModConfig>();

        // 数据根规则与 Node 侧完全一致（PlatformPaths 与 packages/platform/src/data-root.ts 对应）。
        dataRoot = PlatformPaths.ResolveForProcess(config.DataDirectory, requireAbsoluteExplicit: true);
        LogDataRoot();

        actions = new ActionCoordinator(control, Decorate);
        actions.OnError = error => Monitor.Log($"游戏动作失败：{error}", LogLevel.Error);
        multiplayer = new MultiplayerRuntime(helper, Monitor, ModManifest.UniqueID, DataDir(), config.Multiplayer, observations,
            () => helper.WriteConfig(config), reason => {
                if (reason != "SCENE_CHANGED" || !actions.BeginSceneObservation())
                    actions.Stop("RESULT_UNKNOWN", "联机会话失效：" + reason);
                control.Takeover(); observations.Reset();
            });
        observations.MultiplayerScope = () => JsonSerializer.Serialize(multiplayer.Machine.Scope, Protocol.Json);
        actions.BeforeTick = request => multiplayer.Guard(request);

        if (multiplayer.Coordinator)
        {
            helper.Events.GameLoop.UpdateTicking += (_, _) => multiplayer.Tick();
            helper.Events.GameLoop.ReturnedToTitle += (_, _) => multiplayer.Machine.Reset("STALE_HOST_SESSION");
            Monitor.Log("联机主机协调模式：不启动本地角色控制端口；请用 sab_mp 管理许可。", LogLevel.Info);
            return;
        }

        try { server = new BridgeServer(config.Port, ReadModToken, (message, warn) => Monitor.Log(message, warn ? LogLevel.Warn : LogLevel.Info)); }
        catch (Exception error)
        {
            Monitor.Log($"启动本机桥接服务失败（端口 {config.Port}）：{error.Message}", LogLevel.Error);
            Monitor.Log("请确认没有第二个 Mod 实例占用该端口；Mod 已停止提供游戏能力。", LogLevel.Error);
            return;
        }

        helper.Events.GameLoop.GameLaunched += (_, _) => background.Initialize();
        helper.Events.GameLoop.UpdateTicking += OnTick;
        helper.Events.GameLoop.UpdateTicked += (_, _) => background.AfterUpdate();
        helper.Events.GameLoop.SaveLoaded += (_, _) => Reset("新存档已加载");
        helper.Events.GameLoop.ReturnedToTitle += (_, _) => Reset("已返回标题页");
        helper.Events.Display.Rendered += OnRendered;
        helper.Events.Input.ButtonPressed += OnButtonPressed;

        Monitor.Log($"Stardew Agent Bridge Mod 已启动：ws://127.0.0.1:{config.Port}/", LogLevel.Info);
        Monitor.Log($"紧急停止热键：{config.StopHotkey}（会停止动作、释放输入并尝试正常暂停）。", LogLevel.Info);
        if (ReadModToken() == null)
        {
            Monitor.Log(
                $"尚未找到本地凭据文件（{CredentialsPath()}）。请先启动一次 Stardew Agent Bridge 常驻服务以生成凭据，" +
                "之后无需重启游戏即可连接（Mod 每次连接都会重新读取令牌）。",
                LogLevel.Warn);
        }
    }

    // ---------------------------------------------------------------------
    // 凭据
    // ---------------------------------------------------------------------

    private string DataDir() => dataRoot.Ok ? dataRoot.Path : string.Empty;

    private string CredentialsPath() => Path.Combine(DataDir(), "credentials.json");

    /// <summary>把解析后的数据根与来源打进日志：排障时不需要猜环境变量继承关系。</summary>
    private void LogDataRoot()
    {
        if (!dataRoot.Ok)
        {
            Monitor.Log(
                $"数据根无效（{dataRoot.ErrorCode}）：{dataRoot.ErrorMessage}",
                LogLevel.Error);
            Monitor.Log(
                "请在 Mod 配置 config.json 里用绝对路径设置 DataDirectory，或设置绝对路径的 SAB_HOME 环境变量。",
                LogLevel.Error);
            return;
        }
        Monitor.Log($"数据根：{dataRoot.Path}（来源 {dataRoot.Source}，平台 {dataRoot.Platform}）", LogLevel.Trace);
        if (dataRoot.Source == "default")
        {
            Monitor.Log(
                "提示：当前使用默认数据根。通过 Steam 启动时不会继承终端环境变量；若常驻 Bridge 用的是别的目录，" +
                    "请用安装器写入 DataDirectory，或让两者都使用默认目录。",
                LogLevel.Trace);
        }
        var legacy = PlatformPaths.LegacyLinuxRoot(PlatformPaths.HomeDirectory());
        if (dataRoot.Platform == "linux" && legacy != null && legacy != dataRoot.Path && Directory.Exists(legacy))
        {
            Monitor.Log(
                $"发现旧版数据目录 {legacy}。本版默认使用 {dataRoot.Path}；如需沿用旧数据请显式设置绝对路径的 SAB_HOME，" +
                    "本程序不会自动合并或删除任何一份凭据与账本。",
                LogLevel.Warn);
        }
    }

    // 令牌来自受保护的本机凭据文件；文件更新后（轮换令牌）无需重启游戏。
    private string? ReadModToken()
    {
        try
        {
            var path = CredentialsPath();
            if (!File.Exists(path)) return null;
            var stamp = File.GetLastWriteTimeUtc(path);
            if (cachedToken != null && stamp == cachedTokenStamp) return cachedToken;
            using var document = JsonDocument.Parse(File.ReadAllText(path));
            var token = document.RootElement.TryGetProperty("modToken", out var value) && value.ValueKind == JsonValueKind.String
                ? value.GetString()
                : null;
            cachedToken = string.IsNullOrWhiteSpace(token) ? null : token;
            cachedTokenStamp = stamp;
            return cachedToken;
        }
        catch (Exception error)
        {
            Monitor.Log($"读取凭据文件失败：{error.Message}", LogLevel.Warn);
            return null;
        }
    }

    // ---------------------------------------------------------------------
    // 主循环
    // ---------------------------------------------------------------------

    private void OnTick(object? sender, UpdateTickingEventArgs e)
    {
        multiplayer.Tick();
        if (server == null) return;
        // A normal door can begin fading before currentLocation changes. Stop all
        // inputs now and only observe its expected landing; never run an old guard
        // or simulate movement through the transition.
        if (Context.IsMultiplayer && Game1.fadeToBlack && !actions.ObservingSceneTransition && actions.BeginSceneObservation())
        {
            multiplayer.Machine.ReleaseControl(); control.Takeover(); observations.Reset();
        }
        background.BeforeUpdate();

        if (control.HolderName != null && !control.LeaseValid)
        {
            actions.Stop("CANCELLED", "控制租约到期，已停止输入。");
            if (Context.IsMultiplayer) multiplayer.Machine.ReleaseControl();
            control.Takeover();
            control.TryOpenPauseMenu();
        }

        // 游戏侧 watchdog：Bridge 失联时不等人，自己释放输入与动作。
        var last = server.LastFrameAt;
        bridgeLinkUp = last.HasValue && (DateTime.UtcNow - last.Value).TotalSeconds < config.LinkTimeoutSeconds;
        if (!bridgeLinkUp)
        {
            var owned = control.HolderName != null;
            if ((actions.ActiveId != null || owned) && (DateTime.UtcNow - lastWatchdogRelease).TotalSeconds >= 1)
            {
                lastWatchdogRelease = DateTime.UtcNow;
                actions.Stop("CANCELLED", "与 Bridge 的连接中断，游戏侧已自行释放输入。");
                if (Context.IsMultiplayer) multiplayer.Machine.ReleaseControl();
                control.Takeover();
                try { Game1.player?.Halt(); } catch (Exception) { }
                control.TryOpenPauseMenu();
                Monitor.Log("Bridge 失联：已停止动作、释放输入、撤销控制权并尝试正常暂停。", LogLevel.Warn);
            }
        }

        if (!Context.IsWorldReady) actions.Stop("STALE_REF", "存档未加载。");
        actions.Tick(DateTime.UtcNow, owner => ((BridgeServer.Peer)owner).Lifetime.IsCancellationRequested);

        if (screenshot is { } shot && (shot.Peer.Lifetime.IsCancellationRequested || DateTime.UtcNow >= shot.Received.AddMilliseconds(shot.Request.TimeoutMs)))
        {
            Send(shot, Response.Fail(shot.Request, "TIMEOUT", "截图等待绘制超时。", control.Epoch, 0));
            screenshot = null;
        }

        for (var i = 0; i < 16 && server.Inbox.TryDequeue(out var pending); i++)
        {
            if (pending.Peer.Lifetime.IsCancellationRequested) continue;
            Handle(pending);
        }
    }

    private void Handle(BridgeServer.Pending pending)
    {
        var r = pending.Request;
        var started = pending.Received;
        long Elapsed() => (long)(DateTime.UtcNow - started).TotalMilliseconds;
        void Reply(Response response) => Send(pending, response);

        try
        {
            Protocol.Validate(r);
            if (DateTime.UtcNow >= started.AddMilliseconds(r.TimeoutMs)) throw new ActionFault("TIMEOUT", "请求在队列中已过期。");

            if (r.Command == "hello")
            {
                pending.Peer.Handshaken = true;
                Reply(Response.Ok(r, Hello(r.Protocol ?? Protocol.Name), control.Epoch, Elapsed()));
                return;
            }
            if (!pending.Peer.Handshaken) throw new ActionFault("PROTOCOL_MISMATCH", "需要先发送 hello 完成握手。");
            if (r.Command == "multiplayer") { Reply(Response.Ok(r, multiplayer.Describe(Protocol.Text(r.Args, "operation")), control.Epoch, Elapsed())); return; }
            if (r.Command == "multiplayer_bind") { Reply(Response.Ok(r, multiplayer.Bind(), control.Epoch, Elapsed())); return; }
            multiplayer.Guard(r);

            if (r.Command == "control")
            {
                var result = Response.Ok(r, HandleControl(r), control.Epoch, Elapsed());
                // 控制回执携带实际确认的角色作用域，而不是回显请求里可能过期的上下文。
                if (Context.IsMultiplayer && multiplayer.Machine.Scope is { } confirmed) result = result with { ActorContext = confirmed };
                Reply(result);
                return;
            }
            if (r.Command == "saves") { Reply(Response.Ok(r, LifecycleActions.ListSaves(), control.Epoch, Elapsed())); return; }
            if (r.Command == "load")
            {
                control.AuthorizeWrite(r.Epoch);
                Reply(Response.Ok(r, LifecycleActions.Load(Protocol.Text(r.Args, "saveId"), r.ActionId!), control.Epoch, Elapsed()));
                return;
            }
            if (r.Command == "status")
            {
                Reply(Response.Ok(r, actions.Status(Array.Empty<string>()), control.Epoch, Elapsed()));
                return;
            }
            if (r.Command == "stop")
            {
                var id = r.Args.TryGetProperty("actionId", out _) ? Protocol.Text(r.Args, "actionId") : null;
                var stopped = actions.StopIfOwned(id);
                if (Context.IsMultiplayer && (id == null || stopped)) { multiplayer.Machine.ReleaseControl(); control.Takeover(); }
                var paused = control.TryOpenPauseMenu();
                var released = stopped ? new[] { "move", "tool", "mouse" } : Array.Empty<string>();
                Reply(Response.Ok(r, new
                {
                    kind = "status",
                    activeActionId = (string?)null,
                    command = (string?)null,
                    stopped,
                    releasedInputs = released,
                    pause = ControlAuthority.PauseState(control.SelfPauseOpened),
                    pausedNow = paused
                }, control.Epoch, Elapsed()));
                return;
            }

            if (r.Command == "shop")
            {
                if (!Context.IsWorldReady) throw new ActionFault("NO_SAVE_LOADED", "请先加载单人存档。");
                Reply(Response.Ok(r, observations.ShopList(), control.Epoch, Elapsed()));
                return;
            }
            if (!Context.IsWorldReady) throw new ActionFault("NO_SAVE_LOADED", "请先加载单人存档。");

            if (r.Command == "snapshot")
            {
                Reply(Response.Ok(r, observations.Snapshot(r.Args.TryGetProperty("radius", out _) ? Protocol.Integer(r.Args, "radius") : 8), control.Epoch, Elapsed()));
                return;
            }
            if (r.Command == "inspect") { Reply(Response.Ok(r, observations.Inspect(Protocol.Text(r.Args, "target")), control.Epoch, Elapsed())); return; }
            if (r.Command == "recipes" || (r.Command == "container" && Protocol.Text(r.Args, "operation") == "list"))
            {
                Reply(Response.Ok(r, InventoryActions.Read(r, observations) ?? throw new ActionFault("UNSUPPORTED", "配方读取未实现。"), control.Epoch, Elapsed()));
                return;
            }
            if (r.Command == "screenshot")
            {
                if (screenshot != null) throw new ActionFault("ACTION_BUSY", "已有截图请求在处理。");
                screenshot = pending;
                return;
            }

            // 写动作：必须持有当前 epoch，否则拒绝（迟到请求不能重新取得控制）。
            control.AuthorizeWrite(r.Epoch);
            if (r.Command == "pause" && Game1.activeClickableMenu is not (null or StardewValley.Menus.GameMenu))
                throw new ActionFault("PAUSE_BLOCKED", "当前是剧情、信件、结算或小游戏菜单，请先处理它。");

            actions.Start(
                r,
                pending.Peer,
                multiplayer.Deadline(started.AddMilliseconds(r.TimeoutMs)),
                () => {
                    multiplayer.Guard(r);
                    control.ResumeOwnPause(r.Command);
                    if (Context.IsMultiplayer && r.Command == "menu" && r.Args.TryGetProperty("operation", out var op) && op.GetString() == "open_inventory") return multiplayer.InventoryMenu();
                    return GameActions.Create(r, observations, Helper.Reflection, control);
                },
                response => Send(pending, response));
        }
        catch (ActionFault error)
        {
            Reply(Response.Fail(r, error.Code, error.Message, control.Epoch, Elapsed()));
        }
        catch (Exception error)
        {
            Monitor.Log($"处理 {r.Command} 失败：{error}", LogLevel.Error);
            Reply(Response.Unknown(r, "INTERNAL_ERROR", "游戏桥接异常，结果不明，请查看 SMAPI 日志后重新观察。", control.Epoch, Elapsed()));
        }
    }

    private object HandleControl(Request r)
    {
        var operation = Protocol.Text(r.Args, "operation");
        multiplayer.CheckControl(operation, r.Args.TryGetProperty("mode", out var requestedMode) ? requestedMode.GetString() : null, r.Protocol, r.ActorContext);
        switch (operation)
        {
            case "acquire":
            {
                var holder = r.Args.TryGetProperty("holder", out _) ? Protocol.Text(r.Args, "holder") : "bridge";
                var expiresAt = r.Args.TryGetProperty("leaseExpiresAt", out var raw) && DateTime.TryParse(raw.GetString(), out var parsed)
                    ? parsed.ToUniversalTime()
                    : DateTime.UtcNow.AddMinutes(3);
                control.Acquire(holder, expiresAt, r.Args.TryGetProperty("mode", out _) ? Protocol.Text(r.Args, "mode") : "step");
                return new { kind = "control", epoch = control.Epoch, holderName = control.HolderName, expiresAt = control.ExpiresAt?.ToString("o"), pause = ControlAuthority.PauseState(control.SelfPauseOpened) };
            }
            case "renew":
            {
                var epoch = Protocol.Integer(r.Args, "epoch");
                var expiresAt = r.Args.TryGetProperty("leaseExpiresAt", out var raw) && DateTime.TryParse(raw.GetString(), out var parsed)
                    ? parsed.ToUniversalTime()
                    : DateTime.UtcNow.AddMinutes(3);
                control.Renew(epoch, expiresAt);
                return new { kind = "control", epoch = control.Epoch, holderName = control.HolderName, expiresAt = control.ExpiresAt?.ToString("o"), pause = ControlAuthority.PauseState(control.SelfPauseOpened) };
            }
            case "release":
            {
                var epoch = Protocol.Integer(r.Args, "epoch");
                control.AuthorizeWrite(epoch);
                var pause = Protocol.Flag(r.Args, "pause");
                if (Context.IsMultiplayer) multiplayer.Machine.ReleaseControl();
                actions.StopIfOwned(null);
                control.Release(pause);
                return new { kind = "control", epoch = control.Epoch, holderName = control.HolderName, expiresAt = (string?)null, pause = ControlAuthority.PauseState(control.SelfPauseOpened) };
            }
            case "takeover":
            {
                if (Context.IsMultiplayer) multiplayer.Machine.ReleaseControl();
                actions.StopIfOwned(null);
                control.Takeover();
                try { Game1.player?.Halt(); } catch (Exception) { }
                control.TryOpenPauseMenu();
                Monitor.Log("收到人工接管：已撤销控制权、停止动作并尝试正常暂停。", LogLevel.Warn);
                return new { kind = "control", epoch = control.Epoch, holderName = (string?)null, expiresAt = (string?)null, pause = ControlAuthority.PauseState(control.SelfPauseOpened) };
            }
            default:
                throw new ActionFault("INVALID_ARGUMENT", "control 需要 acquire/renew/release/takeover。");
        }
    }

    private object Hello(string protocol = Protocol.Name)
    {
        var generation = observations.Generation;
        if (lastSceneGeneration != generation) lastSceneGeneration = generation;
        return new
        {
            mode = "game",
            kind = "hello",
            protocol,
            supportedProtocols = new[] { Protocol.Name, Protocol.NameV2 },
            multiplayer = multiplayer.Machine.Status(),
            instanceId = observations.InstanceId,
            modVersion = ModManifest.Version.ToString(),
            gameVersion = Game1.GetVersionString(),
            smapiVersion = Constants.ApiVersion.ToString(),
            saveLoaded = Context.IsWorldReady,
            singlePlayer = !Context.IsMultiplayer,
            capabilities = Protocol.Capabilities,
            // 写命令按当前真实可执行口径声明：联机取 MP1 矩阵与主机政策交集，未授权/不在许可地点/非联机世界不宣称可写；
            // 为空时给出与错误码同名的首要拒绝原因，避免 Agent 反复试错猜测。
            writeCommands = Context.IsMultiplayer || config.Multiplayer.Enabled ? multiplayer.WriteCommands() : Protocol.WriteCommands,
            writeCommandsReason = Context.IsMultiplayer || config.Multiplayer.Enabled ? multiplayer.WriteCommandsReason() : null,
            worldGeneration = generation,
            epoch = control.Epoch,
            controller = control.HolderName,
            lease = new { held = control.HolderName != null, holderName = control.HolderName, expiresAt = control.ExpiresAt?.ToString("o") },
            pause = ControlAuthority.PauseState(control.SelfPauseOpened),
            watchdog = new { bridgeLinkUp, lastHeartbeatAt = server?.LastFrameAt?.ToString("o"), linkTimeoutSeconds = config.LinkTimeoutSeconds },
            window = new { active = GameRunner.instance.IsActive, title = Game1.game1?.Window?.Title },
            realtimeInput = RealtimeActions.InputStatus,
            features = new
            {
                cropMaturity = true,
                shipping = !Context.IsMultiplayer,
                mailbox = true,
                inventory = true,
                realtime = true,
                readyWaitMilliseconds = 2000,
                stepPause = config.PauseAfterEachStep && !Context.IsMultiplayer
            }
        };
    }

    // 给每个响应挂上真实暂停状态；动作结果里已有的 effects 字段原样保留。
    private Response Decorate(Response response)
    {
        if (config.PauseAfterEachStep && control.Mode == "step" && Context.IsWorldReady) control.TryOpenPauseMenu();
        var pause = ControlAuthority.PauseState(control.SelfPauseOpened);
        try
        {
            JsonNode? node = response.Result == null
                ? new JsonObject()
                : JsonSerializer.SerializeToNode(response.Result, response.Result.GetType(), Protocol.Json);
            if (node is JsonObject obj)
            {
                obj["pause"] = JsonSerializer.SerializeToNode(pause, Protocol.Json);
                if (response.ActorContext != null)
                    obj["multiplayer"] = JsonSerializer.SerializeToNode(new { actor = response.ActorContext,
                        confirmationScope = response.Status is "succeeded" or "partial" ? "local_observed" : "none",
                        durability = "not_saved", resourceScope = response.Command == "use" ? "shared_world" : "actor",
                        worldContinues = (bool?)null }, Protocol.Json);
                return response with { Result = obj };
            }
        }
        catch (Exception error)
        {
            Monitor.Log($"附加暂停信息失败：{error.Message}", LogLevel.Trace);
        }
        return response;
    }

    private static void Send(BridgeServer.Pending pending, Response response) => _ = pending.Peer.Send(response);

    private void Reset(string reason)
    {
        actions.Reset(retainDedup: Context.IsMultiplayer);
        observations.Reset();
        server?.InvalidateSessions();
        control.Takeover();
        if (screenshot is { } pending) Send(pending, Response.Fail(pending.Request, "STALE_REF", "存档会话已改变。", control.Epoch, 0));
        screenshot = null;
        Monitor.Log($"会话重置：{reason}（控制权代次 {control.Epoch}，旧写请求已失效）。", LogLevel.Info);
    }

    private void OnButtonPressed(object? sender, ButtonPressedEventArgs e)
    {
        if (!Context.IsWorldReady) return;
        if (e.Button != config.StopHotkey) return;
        var stopped = actions.StopIfOwned(null);
        if (Context.IsMultiplayer) multiplayer.Machine.ReleaseControl();
        control.Takeover();
        try { Game1.player?.Halt(); } catch (Exception) { }
        control.TryOpenPauseMenu();
        Helper.Input.Suppress(e.Button);
        Monitor.Log($"热键停止：{(stopped ? "已停止当前动作" : "当前没有动作")}，已释放输入并撤销控制权。", LogLevel.Warn);
    }

    private void OnRendered(object? sender, RenderedEventArgs e)
    {
        if (screenshot is not { } pending) return;
        screenshot = null;
        try
        {
            var device = Game1.graphics.GraphicsDevice;
            // SMAPI 的 Rendered 事件期间可能仍绑定缩放后的屏幕纹理：
            // 读取当前渲染目标（或后缓冲），再合成 UI，最后垂直翻转。
            var surface = device.GetRenderTargets().FirstOrDefault().RenderTarget as RenderTarget2D;
            var ui = Game1.game1.uiScreen;
            var compose = surface != null && ui != null && !ui.IsDisposed && !ReferenceEquals(surface, ui);
            var width = compose ? ui!.Width : surface?.Width ?? device.PresentationParameters.BackBufferWidth;
            var height = compose ? ui!.Height : surface?.Height ?? device.PresentationParameters.BackBufferHeight;
            if ((long)width * height > 8388608) throw new ActionFault("OUTPUT_LIMIT", "画面尺寸过大，请降低窗口分辨率。");
            var colors = new Color[width * height];
            if (compose)
            {
                if ((long)surface!.Width * surface.Height > 8388608) throw new ActionFault("OUTPUT_LIMIT", "场景画面尺寸过大，请降低缩放或分辨率。");
                var world = new Color[surface.Width * surface.Height];
                surface.GetData(world);
                ui!.GetData(colors);
                for (var y = 0; y < height; y++)
                for (var x = 0; x < width; x++)
                {
                    var i = y * width + x;
                    var overlay = colors[i];
                    var under = world[(int)((long)y * surface.Height / height) * surface.Width + (int)((long)x * surface.Width / width)];
                    var remaining = 255 - overlay.A;
                    colors[i] = new Color(
                        Math.Min(255, overlay.R + (under.R * remaining + 127) / 255),
                        Math.Min(255, overlay.G + (under.G * remaining + 127) / 255),
                        Math.Min(255, overlay.B + (under.B * remaining + 127) / 255), 255);
                }
            }
            else if (surface != null) surface.GetData(colors);
            else device.GetBackBufferData(colors);
            using var texture = new Texture2D(device, width, height);
            texture.SetData(colors);
            using var bytes = new MemoryStream();
            texture.SaveAsPng(bytes, width, height);
            if (bytes.Length > 2800000) throw new ActionFault("OUTPUT_LIMIT", "PNG 超出协议大小，请降低窗口分辨率。");
            Send(pending, Response.Ok(pending.Request, new { kind = "screenshot", mimeType = "image/png", base64 = Convert.ToBase64String(bytes.ToArray()), pause = ControlAuthority.PauseState(control.SelfPauseOpened) }, control.Epoch, 0));
        }
        catch (Exception error)
        {
            Send(pending, Response.Fail(pending.Request, error is ActionFault fault ? fault.Code : "INTERNAL_ERROR", $"截图失败：{error.Message}", control.Epoch, 0));
        }
    }

    protected override void Dispose(bool disposing)
    {
        if (disposing)
        {
            actions.Stop("CANCELLED", "Mod 正在卸载。");
            multiplayer?.Dispose();
            background.Dispose();
            server?.Dispose();
        }
        base.Dispose(disposing);
    }
}

/// <summary>Mod 配置：端口、热键、失联阈值、每步暂停策略与数据目录。</summary>
public sealed class ModConfig
{
    public int Port { get; set; } = 17654;
    public SButton StopHotkey { get; set; } = SButton.F9;
    public double LinkTimeoutSeconds { get; set; } = 5;
    public bool PauseAfterEachStep { get; set; } = true;

    /// <summary>
    /// 数据根绝对路径（安装器写入）。为空时按 PlatformPaths 的规则解析：
    /// 先看 SAB_HOME，再按平台默认目录。相对值会被拒绝并给出明确错误，不做猜测。
    /// </summary>
    public string? DataDirectory { get; set; }
    public MultiplayerConfig Multiplayer { get; set; } = new();
}
