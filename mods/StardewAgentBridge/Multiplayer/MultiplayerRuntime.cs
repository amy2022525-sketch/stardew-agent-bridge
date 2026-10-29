using System.Globalization;
using System.Text;
using System.Text.Json;
using StardewModdingAPI;
using StardewModdingAPI.Events;
using StardewValley;
using StardewValley.Buildings;
using StardewValley.Menus;
using StardewValley.Tools;
using StardewValley.TerrainFeatures;

namespace StardewAgentBridge.Multiplayer;

/// <summary>Native-game adapter. All Tick/Guard/Admin access is on SMAPI's game thread.</summary>
public sealed class MultiplayerRuntime : IDisposable
{
    private const string MessageType = "SAB.Multiplayer.v1";
    private readonly IModHelper helper;
    private readonly IMonitor monitor;
    private readonly string modId, policyPath;
    private readonly MultiplayerConfig config;
    private readonly Observations observations;
    private readonly Action saveConfig;
    private readonly Queue<(long Sender, string Mod, string Json)> inbox = new();
    private IClickableMenu? ownedMenu;
    public SessionMachine Machine { get; }
    public bool Coordinator => config.Enabled && config.Role == "host-coordinator";
    public bool Active => Context.IsMultiplayer;

    public MultiplayerRuntime(IModHelper helper, IMonitor monitor, string modId, string dataRoot,
        MultiplayerConfig config, Observations observations, Action saveConfig, Action<string> invalidated)
    {
        this.helper = helper; this.monitor = monitor; this.modId = modId; this.config = config;
        if (config.Enabled && string.IsNullOrWhiteSpace(dataRoot)) throw new ActionFault("CONFIG_INVALID", "联机需要有效的绝对数据目录。");
        this.observations = observations; this.saveConfig = saveConfig;
        policyPath = Path.Combine(dataRoot, "multiplayer", "policy.json");
        var policy = new HostPolicy();
        if (config.Enabled && Coordinator && File.Exists(policyPath))
        {
            try { if (new FileInfo(policyPath).Length > 262144 || (File.GetAttributes(policyPath) & FileAttributes.ReparsePoint) != 0) throw new IOException(); policy = JsonSerializer.Deserialize<HostPolicy>(File.ReadAllText(policyPath), MpEnvelope.ProtocolJson) ?? throw new JsonException(); policy.Validate(); }
            catch (Exception e) when (e is JsonException or IOException or ActionFault or UnauthorizedAccessException) { policy = new(); monitor.Log("联机政策读取失败，保持全部禁用：" + e.GetType().Name, LogLevel.Warn); }
        }
        Machine = new(config, policy, Send, CompatiblePeer);
        Machine.Invalidated = invalidated;
        Machine.ObserveActor = id => {
            var actor = Context.IsWorldReady ? Game1.getOnlineFarmers().FirstOrDefault(p => p.UniqueMultiplayerID == id) : null;
            return actor?.currentLocation == null ? null : new HostObservation(MpIdentity.Farmer(id), actor.currentLocation.NameOrUniqueName, (int)actor.Tile.X, (int)actor.Tile.Y, Environment.TickCount64);
        };
        if (!config.Enabled) return;
        helper.Events.Multiplayer.ModMessageReceived += Receive;
        helper.Events.Multiplayer.PeerDisconnected += Disconnected;
        helper.Events.GameLoop.Saving += Saving;
        helper.Events.GameLoop.DayEnding += DayEnding;
        helper.Events.GameLoop.Saved += Saved;
        helper.Events.GameLoop.DayStarted += DayStarted;
        helper.ConsoleCommands.Add("sab_mp", "联机状态/绑定/主机政策：status | list | bind | allow <FarmerID> | revoke <FarmerID> | area <FarmerID> <x> <y> <width> <height> | disable", Admin);
    }
    private static NativeContext Native()
    {
        if (!Context.IsWorldReady) return new(false, Context.IsMultiplayer, Context.IsMainPlayer, Context.IsSplitScreen, "", 0, 0, "", 0);
        return new(true, Context.IsMultiplayer, Context.IsMainPlayer, Context.IsSplitScreen,
            Convert.ToString(Game1.uniqueIDForThisGame, CultureInfo.InvariantCulture)!, Game1.player.UniqueMultiplayerID,
            Game1.MasterPlayer.UniqueMultiplayerID, Game1.currentLocation?.NameOrUniqueName ?? "", Game1.Date.TotalDays);
    }
    private bool CompatiblePeer(long id)
    {
        var peer = helper.Multiplayer.GetConnectedPlayer(id);
        return peer?.HasSmapi == true && !peer.IsSplitScreen && peer.GetMod(modId) != null
            && Context.IsWorldReady && Game1.getOnlineFarmers().Any(x => x.UniqueMultiplayerID == id);
    }
    private void Send(long player, MpEnvelope message)
    {
        if (!CompatiblePeer(player)) return;
        // SMAPI uses Newtonsoft for mod messages. Send bounded JSON text so JsonElement is never deserialized by two serializers.
        var json = JsonSerializer.Serialize(message, MpEnvelope.ProtocolJson);
        if (Encoding.UTF8.GetByteCount(json) <= 16384) helper.Multiplayer.SendMessage(json, MessageType, new[] { modId }, new[] { player });
    }
    private void Receive(object? sender, ModMessageReceivedEventArgs e)
    {
        if (e.FromModID != modId || e.Type != MessageType || inbox.Count >= 128) return;
        try { var json = e.ReadAs<string>(); if (json.Length <= 16384 && Encoding.UTF8.GetByteCount(json) <= 16384) inbox.Enqueue((e.FromPlayerID, e.FromModID, json)); }
        catch (Exception error) when (error is not OutOfMemoryException) { monitor.Log("已忽略无效联机消息。", LogLevel.Trace); }
    }
    private void Disconnected(object? sender, PeerDisconnectedEventArgs e) => Machine.Disconnect(e.Peer.PlayerID);
    private void Saving(object? sender, SavingEventArgs e) => Machine.SetPhase("saving");
    private void DayEnding(object? sender, DayEndingEventArgs e) => Machine.SetPhase("day_transition");
    private void Saved(object? sender, SavedEventArgs e) => Machine.SetPhase("day_transition", saved: true);
    private void DayStarted(object? sender, DayStartedEventArgs e) { Machine.SetPhase("active", dayStarted: true); observations.Reset(); }
    public void Tick()
    {
        if (!config.Enabled) return;
        Machine.Tick(Native());
        for (var i = 0; i < 16 && inbox.TryDequeue(out var incoming); i++)
        {
            try { var message = JsonSerializer.Deserialize<MpEnvelope>(incoming.Json, MpEnvelope.ProtocolJson); if (message != null) Machine.Receive(incoming.Sender, incoming.Mod, modId, message); }
            catch (Exception e) when (e is JsonException or InvalidOperationException or ArgumentException) { }
        }
    }

    public object Describe(string operation)
    {
        if (operation is not ("status" or "connection" or "policy" or "players")) throw new ActionFault("INVALID_ARGUMENT", "operation 需要 status/connection/policy/players。");
        if (operation != "players") return Machine.Status();
        return new { kind = "multiplayer", players = !Context.IsWorldReady ? Array.Empty<object>() : Game1.getOnlineFarmers().Take(32).Select(p => (object)new {
            farmerId = MpIdentity.Farmer(p.UniqueMultiplayerID), name = p.Name.Length > 64 ? p.Name[..64] : p.Name,
            isHost = p.UniqueMultiplayerID == Game1.MasterPlayer.UniqueMultiplayerID,
            localActor = p.UniqueMultiplayerID == Game1.player.UniqueMultiplayerID
        }).ToArray() };
    }

    public object Bind() { Machine.BindCurrent(); saveConfig(); return Machine.Status(); }

    /// <summary>MP1 支持矩阵与当前主机政策的交集；未授权或不在许可地点时不宣称任何写命令。</summary>
    public string[] WriteCommands()
    {
        if (!config.Enabled) return Active ? Array.Empty<string>() : Protocol.WriteCommands;
        if (!Active) return Array.Empty<string>();
        var policy = Machine.ActorPolicy;
        var location = Game1.currentLocation?.NameOrUniqueName ?? "";
        if (!Machine.Authorized || policy == null || !policy.AllowsLocation(location)) return Array.Empty<string>();
        return MpWriteMatrix.Where(command => command switch
        {
            "move" or "interact" => policy.AllowMovement,
            "use" => policy.AllowWatering,
            "menu" or "craft" => policy.AllowOwnInventoryCraft,
            "eat" => policy.AllowOwnFood,
            "equip" => policy.AllowOwnEquipment,
            _ => true // select / closemenu / wait 只操作自己的输入，不触及共享世界
        }).ToArray();
    }
    private static readonly string[] MpWriteMatrix = { "move", "select", "use", "interact", "menu", "closemenu", "wait", "craft", "eat", "equip" };

    /// <summary>写命令为空时的首要拒绝原因（与错误码同名）；非空或未启用联机时返回 null。</summary>
    public string? WriteCommandsReason()
    {
        if (!config.Enabled) return null;
        if (!Active) return "FARMHAND_REQUIRED";
        if (Machine.Phase != "active") return "WORLD_TRANSITION";
        if (!Machine.Bound) return "ACTOR_BINDING_REQUIRED";
        var policy = Machine.ActorPolicy;
        if (policy?.Enabled != true) return "HOST_PERMISSION_REQUIRED";
        if (!Machine.Authorized) return "HOST_PERMISSION_REQUIRED";
        if (!policy.AllowsLocation(Game1.currentLocation?.NameOrUniqueName ?? "")) return "HOST_PERMISSION_REQUIRED";
        return null;
    }

    public void CheckControl(string operation, string? mode, string? protocol, ActorContext? expected)
    {
        if (operation is "release" or "takeover") return;
        if (!Active) { if (config.Enabled) throw new ActionFault("FARMHAND_REQUIRED", "联机 profile 需要正常进入 farmhand。"); return; }
        if (!config.Enabled) throw new ActionFault("MULTIPLAYER_DISABLED", "联机功能尚未启用。");
        if (protocol != Protocol.NameV2) throw new ActionFault("UNSUPPORTED_IN_MULTIPLAYER", "多人写操作需要 v2 本地协议。");
        if (operation == "acquire")
        {
            if (mode != "realtime") throw new ActionFault("MODE_UNSUPPORTED", "联机控制必须显式 mode=realtime；世界不会随本地动作暂停。");
            Machine.RequestControl();
            if (!Machine.Authorized && Machine.Bound && Machine.ActorPolicy?.Enabled == true && Machine.Phase == "active")
                throw new ActionFault("HOST_PERMISSION_REQUIRED", "已请求主机短期许可。请只读查询 stardew_multiplayer，等 permissionLeaseHeld=true 后重新 start realtime；尚未执行游戏动作。");
        }
        // 确认对象始终是机器当前真实作用域；acquire/renew 携带的旧上下文必须与之一致，
        // hello→acquire 之间许可或连接改变时不能借用旧回执继续。
        Machine.AssertScope(operation is "acquire" or "renew" ? expected ?? Machine.Scope : Machine.Scope);
    }

    public void Guard(Request request)
    {
        if (request.Command is "hello" or "status" or "stop" or "multiplayer" or "control") return;
        if (!Active) { if (config.Enabled && Protocol.IsWrite(request.Command)) throw new ActionFault("FARMHAND_REQUIRED", "联机 profile 需要正常进入 farmhand。"); return; }
        if (!config.Enabled) throw new ActionFault("MULTIPLAYER_DISABLED", "当前配置保持单人模式；联机尚未启用。");
        if (Coordinator || Context.IsMainPlayer || Context.IsSplitScreen) throw new ActionFault("FARMHAND_REQUIRED", "首版仅控制独立 farmhand，不能操作真人主机或分屏。");
        if (request.Command is "saves" or "load") throw new ActionFault("UNSUPPORTED_IN_MULTIPLAYER", "不能从 farmhand 读取/加载主机存档。");
        if (request.Command is "snapshot" or "inspect" or "screenshot" or "recipes" or "shop") return;
        if (request.Command == "container") throw new ActionFault("UNSUPPORTED_IN_MULTIPLAYER", "首版未开放共享箱子操作。");
        if (request.Protocol != Protocol.NameV2) throw new ActionFault("UNSUPPORTED_IN_MULTIPLAYER", "多人写需要 v2 协议。");
        Machine.AssertScope(request.ActorContext);
        var policy = Machine.ActorPolicy!;
        if (!policy.AllowsLocation(Game1.currentLocation.NameOrUniqueName)) throw new ActionFault("HOST_PERMISSION_REQUIRED", "当前位置不在主机许可范围。");
        if (Game1.eventUp || Game1.fadeToBlack || Game1.killScreen) throw new ActionFault("WORLD_TRANSITION", "剧情/过场/倒地期间停止新动作。");
        switch (request.Command)
        {
            case "move":
                if (!policy.AllowMovement) break;
                var point = request.Args.TryGetProperty("near", out _) ? observations.Resolve(Protocol.Text(request.Args, "near")).Tile
                    : new Microsoft.Xna.Framework.Point(Protocol.Integer(request.Args.GetProperty("tile"), "x"), Protocol.Integer(request.Args.GetProperty("tile"), "y"));
                var exits = Game1.currentLocation.warps.Where(w => w.X == point.X && w.Y == point.Y).ToArray();
                if (exits.Any(w => !policy.AllowsLocation(w.TargetName))) throw new ActionFault("HOST_PERMISSION_REQUIRED", "出口目标不在主机许可地点中。");
                var touch = Observations.InBounds(Game1.currentLocation, point) ? Game1.currentLocation.doesTileHaveProperty(point.X, point.Y, "TouchAction", "Back") : null;
                if (touch != null && (NativeDoor.Destination(touch, touch: true) is not { } destination || !policy.AllowsLocation(destination)))
                    throw new ActionFault("UNSUPPORTED_IN_MULTIPLAYER", "只允许目标地点获批的原生 Warp TouchAction；睡觉、剧情和未知触发器均不开放。");
                return;
            case "wait":
                if (Protocol.Integer(request.Args, "milliseconds") <= policy.MaxActionMs) return;
                throw new ActionFault("INVALID_ARGUMENT", "等待超过主机单次动作上限。");
            case "select": return;
            case "equip": if (policy.AllowOwnEquipment) return; break;
            case "eat": if (policy.AllowOwnFood) return; break;
            case "craft": if (policy.AllowOwnInventoryCraft) return; break;
            case "menu":
                if (policy.AllowOwnInventoryCraft && request.Args.TryGetProperty("operation", out var op) && op.GetString() == "open_inventory") return;
                break; // no generic clicks into transactions, quests or sleep confirmations
            case "closemenu":
                if (Game1.activeClickableMenu == null || ReferenceEquals(ownedMenu, Game1.activeClickableMenu)) return;
                break;
            case "use":
            {
                var target = observations.Resolve(Protocol.Text(request.Args, "target"));
                if (policy.AllowWatering && Game1.player.CurrentTool is WateringCan
                    && target.Location.terrainFeatures.TryGetValue(target.Tile.ToVector2(), out var terrain) && terrain is HoeDirt
                    && policy.AllowsTile(target.Location.NameOrUniqueName, target.Tile.X, target.Tile.Y)) return;
                break;
            }
            case "interact":
            {
                if (!policy.AllowMovement) break;
                var target = observations.Resolve(Protocol.Text(request.Args, "target"));
                if (target.Identity is Warp warp && policy.AllowsLocation(warp.TargetName)) return;
                if (target.Kind == "door" && target.Identity is Building building && policy.AllowsLocation(building.GetIndoorsName())) return;
                if (target.Kind == "action" && NativeDoor.Destination(target.Location.doesTileHaveProperty(target.Tile.X, target.Tile.Y, "Action", "Buildings")) is { } door
                    && policy.AllowsLocation(door)) return;
                break;
            }
        }
        throw new ActionFault("UNSUPPORTED_IN_MULTIPLAYER", "当前操作分支未被主机政策/MP1能力矩阵开放。");
    }
    public IGameAction InventoryMenu()
    {
        return new MenuAction(() => {
            if (Game1.activeClickableMenu != null) throw new ActionFault("ACTION_BUSY", "当前菜单属于玩家/游戏，不覆盖它。");
            ownedMenu = new GameMenu(); Game1.activeClickableMenu = ownedMenu;
            return observations.Result("已打开自己的背包菜单；联机世界继续运行。", false);
        });
    }
    private sealed class MenuAction : IGameAction
    {
        private readonly Func<object> action;
        public MenuAction(Func<object> action) => this.action = action;
        public object Tick() => action();
        public void Cancel() { }
    }
    public DateTime Deadline(DateTime requested) => !Active || Machine.ActorPolicy == null ? requested :
        requested < DateTime.UtcNow.AddMilliseconds(Machine.ActorPolicy.MaxActionMs) ? requested : DateTime.UtcNow.AddMilliseconds(Machine.ActorPolicy.MaxActionMs);

    private void Admin(string command, string[] args)
    {
        try
        {
            if (args.Length == 0 || args[0] is "status" or "list") { monitor.Log(JsonSerializer.Serialize(Describe(args.FirstOrDefault() == "list" ? "players" : "status"), MpEnvelope.ProtocolJson), LogLevel.Info); return; }
            if (args[0] == "bind" && args.Length == 1) { Bind(); monitor.Log("已绑定当前真实世界和自己的 farmhand；仍需主机允许。", LogLevel.Info); return; }
            if (!Coordinator || !Context.IsWorldReady || !Context.IsMainPlayer || Context.IsSplitScreen) throw new ActionFault("HOST_REQUIRED", "只允许主机本地管理授权。");
            var policy = JsonSerializer.Deserialize<HostPolicy>(JsonSerializer.Serialize(Machine.Policy, MpEnvelope.ProtocolJson), MpEnvelope.ProtocolJson)!;
            policy.WorldId = Native().WorldId; policy.Revision++;
            if (args[0] == "disable" && args.Length == 1) foreach (var actor in policy.Actors.Values) actor.Enabled = false;
            else if (args.Length >= 2 && args[0] is "allow" or "revoke" or "area")
            {
                var id = MpIdentity.ParseFarmer(args[1]);
                if (id == Game1.MasterPlayer.UniqueMultiplayerID || !CompatiblePeer(id)) throw new ActionFault("ACTOR_MISMATCH", "请选择当前在线、安装本Mod的独立 farmhand ID。");
                if (!policy.Actors.TryGetValue(args[1], out var actor)) { actor = new ActorPolicy(); policy.Actors[args[1]] = actor; }
                if (args[0] == "allow" && args.Length == 2)
                {
                    actor.Enabled = true; actor.AllowOwnInventoryCraft = true;
                    var location = Game1.getOnlineFarmers().First(p => p.UniqueMultiplayerID == id).currentLocation.NameOrUniqueName;
                    if (!actor.AllowedLocations.Contains(location)) actor.AllowedLocations.Add(location);
                }
                else if (args[0] == "revoke" && args.Length == 2) actor.Enabled = false;
                else if (args[0] == "area" && args.Length == 6)
                {
                    var location = Game1.getOnlineFarmers().First(p => p.UniqueMultiplayerID == id).currentLocation.NameOrUniqueName;
                    actor.AllowedLocations.Add(location); actor.AllowedLocations = actor.AllowedLocations.Distinct().ToList();
                    actor.AllowedAreas.Add(new AllowedArea { Location = location, X = int.Parse(args[2], CultureInfo.InvariantCulture), Y = int.Parse(args[3], CultureInfo.InvariantCulture), Width = int.Parse(args[4], CultureInfo.InvariantCulture), Height = int.Parse(args[5], CultureInfo.InvariantCulture) });
                    actor.AllowWatering = true;
                }
                else throw new ActionFault("INVALID_ARGUMENT", "参数需要 allow/revoke <FarmerID> 或 area <FarmerID> <x> <y> <width> <height>。");
            }
            else throw new ActionFault("INVALID_ARGUMENT", "未知管理命令。");
            policy.Validate(); PrivatePolicyFile.Write(Path.GetDirectoryName(Path.GetDirectoryName(policyPath)!)!, policyPath, JsonSerializer.SerializeToUtf8Bytes(policy, MpEnvelope.ProtocolJson));
            Machine.ReplacePolicy(policy);
            monitor.Log("联机政策已更新；旧许可已撤销，请重新观察/获取控制。", LogLevel.Info);
        }
        catch (Exception e) when (e is ActionFault or IOException or FormatException or OverflowException or UnauthorizedAccessException)
        { monitor.Log(e is ActionFault a ? a.Code + ": " + a.Message : "联机配置写入/参数校验失败：" + e.GetType().Name, LogLevel.Warn); }
    }
    public void Dispose()
    {
        if (!config.Enabled) return;
        Machine.ReleaseControl(); inbox.Clear();
        helper.Events.Multiplayer.ModMessageReceived -= Receive; helper.Events.Multiplayer.PeerDisconnected -= Disconnected;
        helper.Events.GameLoop.Saving -= Saving; helper.Events.GameLoop.Saved -= Saved; helper.Events.GameLoop.DayStarted -= DayStarted;
        helper.Events.GameLoop.DayEnding -= DayEnding;
    }
}
