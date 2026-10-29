using System.Text.Json;

namespace StardewAgentBridge.Multiplayer;

/// <summary>Pure host/participant state machine. Native game and transport access are injected.</summary>
public sealed class SessionMachine
{
    private sealed class PeerState
    {
        public string ActorSession = "", Connection = MpIdentity.Nonce(), LeaseId = MpIdentity.Nonce();
        public long LastSequence, ContinuousSince = -1, LeaseUntil;
    }
    private readonly MultiplayerConfig config;
    private readonly Func<long> now;
    private readonly Action<long, MpEnvelope> send;
    private readonly Func<long, bool> compatiblePeer;
    private readonly Dictionary<long, PeerState> peers = new();
    private readonly Dictionary<long, long> continuousBudgets = new();
    private readonly Dictionary<long, HashSet<string>> retiredSessions = new();
    private readonly Dictionary<long, (long Window, int Count)> rates = new();
    private readonly PermissionLease lease = new();
    private readonly Dictionary<string, (long Sent, string Type, int Generation)> pending = new();
    private long outbound, lastInbound, nextHello, nextRenew, nextObservation, observedAt, lastGrantDelay;
    private int worldGeneration, sceneGeneration, acquireGeneration;
    private HostObservation? hostObservation;
    public Func<long, HostObservation?>? ObserveActor { get; set; }
    private NativeContext native = new(false, false, false, false, "", 0, 0, "", 0);
    private string actorSession = MpIdentity.Nonce();
    private string? connection, hostSession;
    private int policyRevision, phaseSequence, dayGeneration, saveRevision;
    private bool wantsControl;
    private ActorPolicy? actorPolicy;
    private string phase = "active";
    public HostPolicy Policy { get; private set; }
    public string State { get; private set; } = "waiting_for_world";
    public string Reason { get; private set; } = "NO_SAVE_LOADED";
    public Action<string>? Invalidated { get; set; }
    public bool IsCoordinator => config.Enabled && config.Role == "host-coordinator";
    public bool IsMultiplayer => native.Multiplayer;
    public bool Enabled => config.Enabled;
    public bool Authorized => config.Enabled && !IsCoordinator && native.Ready && native.Multiplayer && !native.MainPlayer && !native.SplitScreen
        && phase == "active" && actorPolicy?.Enabled == true && Bound && lease.Valid(now());
    public bool Bound => config.ExpectedWorldId == native.WorldId && config.ExpectedActorFarmerId == MpIdentity.Farmer(native.ActorId);
    public ActorPolicy? ActorPolicy => actorPolicy;
    public string Phase => phase;
    public ActorContext? Scope => !Authorized || hostSession == null || connection == null || lease.Id == null ? null
        : new(native.WorldId, MpIdentity.Farmer(native.HostId), hostSession, MpIdentity.Farmer(native.ActorId), actorSession, connection, policyRevision, lease.Id, worldGeneration, sceneGeneration, dayGeneration);

    public SessionMachine(MultiplayerConfig config, HostPolicy policy, Action<long, MpEnvelope> send,
        Func<long, bool> compatiblePeer, Func<long>? now = null)
    {
        config.Validate(); policy.Validate(); this.config = config; Policy = policy; this.send = send;
        this.compatiblePeer = compatiblePeer; this.now = now ?? (() => Environment.TickCount64);
    }

    public void Tick(NativeContext current)
    {
        var changed = native.Ready != current.Ready || native.WorldId != current.WorldId || native.ActorId != current.ActorId
            || native.HostId != current.HostId || native.Multiplayer != current.Multiplayer || native.MainPlayer != current.MainPlayer || native.SplitScreen != current.SplitScreen;
        var sceneChanged = native.Ready && current.Ready && native.Location != current.Location;
        native = current;
        if (changed) Reset("STALE_ACTOR_SESSION");
        else if (sceneChanged && !IsCoordinator) { sceneGeneration++; Invalidate("SCENE_CHANGED"); }
        if (!config.Enabled) { State = "disabled"; Reason = "MULTIPLAYER_DISABLED"; return; }
        if (!current.Ready) { State = "waiting_for_world"; Reason = "NO_SAVE_LOADED"; return; }
        if (current.SplitScreen) { Block("SPLIT_SCREEN_UNSUPPORTED"); return; }
        if (!current.Multiplayer) { Block("FARMHAND_REQUIRED"); return; }
        if (IsCoordinator)
        {
            if (!current.MainPlayer) { Block("HOST_REQUIRED"); return; }
            hostSession ??= MpIdentity.Nonce(); State = "coordinator_ready"; Reason = "none"; return;
        }
        if (current.MainPlayer) { Block("FARMHAND_REQUIRED"); return; }
        if (!compatiblePeer(current.HostId)) { Block("HOST_COORDINATOR_REQUIRED"); return; }
        if (lease.Id != null && !lease.Valid(now())) Invalidate("HOST_PERMISSION_EXPIRED");
        if (now() >= nextHello)
        {
            nextHello = now() + 2000;
            Emit(current.HostId, "ClientHello", new { actorFarmerId = MpIdentity.Farmer(current.ActorId), worldId = current.WorldId }, track: true);
        }
        if (hostSession == null) { State = "negotiating"; Reason = "HOST_COORDINATOR_REQUIRED"; return; }
        if (!Bound) { State = "binding_required"; Reason = "ACTOR_BINDING_REQUIRED"; return; }
        if (actorPolicy?.Enabled != true) { State = "awaiting_host_approval"; Reason = "HOST_PERMISSION_REQUIRED"; return; }
        if (phase != "active") { State = "suspended"; Reason = "WORLD_TRANSITION"; return; }
        State = Authorized ? "authorized" : "bound_readonly";
        Reason = Authorized ? "none" : "HOST_PERMISSION_REQUIRED";
        if (wantsControl && now() >= nextRenew)
        {
            // 续期节奏跟随实际许可期限：以请求发出时间为基准，留出已观察到的授予往返延迟，
            // 让新授予在旧许可过期前到达。最短 TTL（1000ms）与临近主机连续预算时同样成立。
            var remaining = lease.Id != null ? lease.Deadline - now() : 0;
            var lead = Math.Max(lastGrantDelay + 50, 250);
            nextRenew = lease.Id != null ? now() + Math.Max(250, remaining - lead) : now() + 1000;
            Emit(current.HostId, "LeaseRequest", new { actorFarmerId = MpIdentity.Farmer(current.ActorId), policyRevision }, track: true);
        }
        if (now() >= nextObservation) { nextObservation = now() + 2000; Emit(current.HostId, "ObservationRequest", new { kind = "actor_position", actorFarmerId = MpIdentity.Farmer(current.ActorId) }, track: true); }
        foreach (var key in pending.Where(x => now() - x.Value.Sent > 10000).Select(x => x.Key).ToArray()) pending.Remove(key);
    }

    public void RequestControl() { acquireGeneration++; wantsControl = true; nextRenew = 0; }
    public void ReleaseControl()
    {
        if (connection != null) Emit(native.HostId, "LeaseRelease", new { });
        // 释放即结束本次 acquire：清掉在途许可请求并递增代次，稍后到达的旧授予不能被下一次 start 借用。
        acquireGeneration++; wantsControl = false; lease.Revoke();
        foreach (var stale in pending.Where(x => x.Value.Type == "LeaseRequest").Select(x => x.Key).ToArray()) pending.Remove(stale);
    }
    public void BindCurrent()
    {
        if (!native.Ready || !native.Multiplayer || native.MainPlayer || native.SplitScreen) throw new ActionFault("FARMHAND_REQUIRED", "请先用正常 Co-op 进入自己的独立 farmhand。");
        config.ExpectedWorldId = native.WorldId; config.ExpectedActorFarmerId = MpIdentity.Farmer(native.ActorId);
        Reset("ACTOR_BINDING_REQUIRED");
    }
    public void Disconnect(long peer)
    {
        if (peers.TryGetValue(peer, out var previous))
        {
            if (!retiredSessions.TryGetValue(peer, out var retired)) retiredSessions[peer] = retired = new(StringComparer.Ordinal);
            if (retired.Count < 32) retired.Add(previous.ActorSession);
        }
        peers.Remove(peer); rates.Remove(peer);
        if (!IsCoordinator && peer == native.HostId) Reset("STALE_HOST_SESSION");
    }
    public void Reset(string reason)
    {
        Invalidate(reason); actorSession = MpIdentity.Nonce(); connection = null; hostSession = null; actorPolicy = null;
        peers.Clear(); continuousBudgets.Clear(); retiredSessions.Clear(); pending.Clear(); rates.Clear(); outbound = lastInbound = 0; phaseSequence = 0; phase = "active"; nextHello = nextRenew = nextObservation = 0;
        worldGeneration++; sceneGeneration = 0; dayGeneration = saveRevision = 0; hostObservation = null; lease.Reset(); lastGrantDelay = 0;
    }
    private void Block(string reason) { if (lease.Id != null) Invalidate(reason); State = "incompatible"; Reason = reason; }
    private void Invalidate(string reason)
    {
        acquireGeneration++; lease.Revoke(); wantsControl = false; hostObservation = null; Reason = reason;
        foreach (var stale in pending.Where(x => x.Value.Type == "LeaseRequest").Select(x => x.Key).ToArray()) pending.Remove(stale);
        Invalidated?.Invoke(reason);
    }

    public void AssertScope(ActorContext? expected)
    {
        if (!Authorized) throw new ActionFault(Reason == "none" ? "HOST_PERMISSION_REQUIRED" : Reason, "联机许可/角色/世界阶段未就绪，请查看 stardew_multiplayer。");
        if (expected == null || expected != Scope) throw new ActionFault("STALE_ACTOR_SESSION", "角色、世界、连接或许可代次已改变；请重新观察和获取控制。");
    }

    public void Receive(long sender, string modId, string expectedModId, MpEnvelope message)
    {
        if (!config.Enabled || !native.Ready || !native.Multiplayer || native.SplitScreen || modId != expectedModId || !compatiblePeer(sender)) return;
        var rate = rates.TryGetValue(sender, out var seen) && now() - seen.Window < 1000 ? seen : (Window: now(), Count: 0);
        if (++rate.Count > 20) { rates[sender] = rate; return; }
        rates[sender] = rate;
        try
        {
            if (!message.IsWellFormed()) return;
            if (IsCoordinator && native.MainPlayer) ReceiveHost(sender, message);
            else if (!native.MainPlayer && sender == native.HostId) ReceiveParticipant(message);
        }
        catch (JsonException) { /* malformed peer data never escapes into the game loop */ }
        catch (ActionFault) { /* untrusted IDs and bounded policy values fail closed */ }
        catch (InvalidOperationException) { }
        catch (KeyNotFoundException) { }
        catch (FormatException) { }
        catch (OverflowException) { }
        catch (ArgumentException) { }
    }

    private void ReceiveHost(long sender, MpEnvelope message)
    {
        if (hostSession == null || sender == native.ActorId) return;
        if (message.Type == "ClientHello")
        {
            if (message.Payload.GetProperty("actorFarmerId").GetString() != MpIdentity.Farmer(sender)
                || message.Payload.GetProperty("worldId").GetString() != native.WorldId) return;
            if (retiredSessions.TryGetValue(sender, out var retired) && retired.Contains(message.ActorSessionId)) return;
            if (!peers.TryGetValue(sender, out var entry) || entry.ActorSession != message.ActorSessionId)
            {
                if (entry != null)
                {
                    if (retired == null) retiredSessions[sender] = retired = new(StringComparer.Ordinal);
                    if (retired.Count >= 32) return;
                    retired.Add(entry.ActorSession);
                }
                // Continuous-control budget is actor-scoped and survives client reconnects.
                var since = continuousBudgets.TryGetValue(sender, out var budget) ? budget : -1;
                entry = new PeerState { ActorSession = message.ActorSessionId, ContinuousSince = since }; peers[sender] = entry;
            }
            if (message.Sequence <= entry.LastSequence) return;
            entry.LastSequence = message.Sequence;
            var policy = Policy.WorldId == native.WorldId && Policy.Actors.TryGetValue(MpIdentity.Farmer(sender), out var value) ? value : null;
            Emit(sender, "HostHello", new HostReply { WorldId = native.WorldId, HostFarmerId = MpIdentity.Farmer(native.ActorId),
                ActorFarmerId = MpIdentity.Farmer(sender), PolicyRevision = Policy.Revision, Policy = policy,
                Phase = phase, PhaseSequence = phaseSequence, DayGeneration = dayGeneration, SaveRevision = saveRevision }, message.MessageId, entry);
            return;
        }
        if (!peers.TryGetValue(sender, out var peer) || message.ActorSessionId != peer.ActorSession || message.ConnectionId != peer.Connection
            || message.HostSessionId != hostSession || message.Sequence <= peer.LastSequence) return;
        peer.LastSequence = message.Sequence;
        if (message.Type == "LeaseRelease") { peer.LeaseUntil = 0; return; }
        if (message.Type == "ObservationRequest" && Policy.WorldId == native.WorldId
            && Policy.Actors.TryGetValue(MpIdentity.Farmer(sender), out var observingPolicy) && observingPolicy.Enabled
            && message.Payload.GetProperty("kind").GetString() == "actor_position"
            && message.Payload.GetProperty("actorFarmerId").GetString() == MpIdentity.Farmer(sender))
        {
            var observation = ObserveActor?.Invoke(sender);
            if (observation != null && observation.ActorFarmerId == MpIdentity.Farmer(sender)) Emit(sender, "ObservationReport", observation, message.MessageId, peer);
            return;
        }
        if (message.Type != "LeaseRequest" || phase != "active" || Policy.WorldId != native.WorldId
            || !Policy.Actors.TryGetValue(MpIdentity.Farmer(sender), out var actor) || !actor.Enabled
            || message.Payload.GetProperty("actorFarmerId").GetString() != MpIdentity.Farmer(sender)
            || message.Payload.GetProperty("policyRevision").GetInt32() != Policy.Revision) return;
        if (peer.ContinuousSince < 0) { peer.ContinuousSince = now(); continuousBudgets[sender] = peer.ContinuousSince; }
        var remaining = actor.MaxContinuousControlMs - (now() - peer.ContinuousSince);
        if (remaining < 1000) { Emit(sender, "LeaseRevoke", new { reason = "HOST_PERMISSION_EXPIRED" }, peer: peer); return; }
        var ttl = (int)Math.Min(config.PermissionLeaseMs, remaining);
        peer.LeaseUntil = now() + ttl;
        Emit(sender, "LeaseGrant", new LeaseReply { LeaseId = peer.LeaseId, TtlMs = ttl, PolicyRevision = Policy.Revision }, message.MessageId, peer);
    }

    private void ReceiveParticipant(MpEnvelope message)
    {
        if (message.ActorSessionId != actorSession) return;
        if (message.Type == "HostHello")
        {
            if (!Consume(message, "ClientHello", 5000, out _)) return;
            var reply = message.Payload.Deserialize<HostReply>(MpEnvelope.ProtocolJson);
            if (reply == null || reply.WorldId != native.WorldId || reply.HostFarmerId != MpIdentity.Farmer(native.HostId)
                || reply.ActorFarmerId != MpIdentity.Farmer(native.ActorId) || message.HostSessionId?.Length != 22 || message.ConnectionId?.Length != 22
                || reply.PolicyRevision < 1 || reply.PhaseSequence < 0) return;
            reply.Policy?.Validate();
            if (hostSession == message.HostSessionId && message.Sequence <= lastInbound) return;
            if (hostSession != null && (hostSession != message.HostSessionId || connection != message.ConnectionId || policyRevision != reply.PolicyRevision)) { Invalidate("STALE_HOST_SESSION"); lease.Reset(); }
            hostSession = message.HostSessionId; connection = message.ConnectionId; policyRevision = reply.PolicyRevision;
            lastInbound = message.Sequence; actorPolicy = reply.Policy;
            if (reply.Phase is not ("active" or "saving" or "day_transition")) { Invalidate("WORLD_TRANSITION"); return; }
            if (reply.PhaseSequence > phaseSequence) Invalidate("WORLD_TRANSITION");
            if (reply.PhaseSequence >= phaseSequence) { phaseSequence = reply.PhaseSequence; phase = reply.Phase; }
            dayGeneration = reply.DayGeneration; saveRevision = reply.SaveRevision;
            return;
        }
        if (message.HostSessionId != hostSession || message.ConnectionId != connection || message.Sequence <= lastInbound) return;
        lastInbound = message.Sequence;
        if (message.Type == "LeaseRevoke") { Invalidate("HOST_PERMISSION_REVOKED"); return; }
        if (message.Type == "ObservationReport" && Consume(message, "ObservationRequest", 5000, out _))
        {
            var report = message.Payload.Deserialize<HostObservation>(MpEnvelope.ProtocolJson);
            if (report != null && report.ActorFarmerId == MpIdentity.Farmer(native.ActorId) && report.Location is { Length: > 0 and <= 160 }
                && report.X is >= -1 and <= 32767 && report.Y is >= -1 and <= 32767 && report.HostTick >= 0)
            { hostObservation = report; observedAt = now(); }
            return;
        }
        if (message.Type == "PhaseChanged")
        {
            var revision = message.Payload.GetProperty("phaseSequence").GetInt32();
            if (revision <= phaseSequence) return;
            phaseSequence = revision; phase = message.Payload.GetProperty("phase").GetString() ?? "unknown";
            dayGeneration = message.Payload.GetProperty("dayGeneration").GetInt32(); saveRevision = message.Payload.GetProperty("saveRevision").GetInt32();
            Invalidate("WORLD_TRANSITION"); return;
        }
        if (message.Type == "LeaseGrant" && wantsControl && Bound && phase == "active" && actorPolicy?.Enabled == true
            && Consume(message, "LeaseRequest", 10000, out var requestSent))
        {
            var grant = message.Payload.Deserialize<LeaseReply>(MpEnvelope.ProtocolJson);
            if (grant != null && grant.PolicyRevision == policyRevision && lease.Accept(grant.LeaseId, message.Sequence, requestSent, now(), grant.TtlMs))
            {
                // 记录真实往返延迟，并从新许可的发出时间基准安排下一次续期。
                lastGrantDelay = now() - requestSent;
                nextRenew = lease.Deadline - Math.Max(lastGrantDelay + 50, 250);
            }
        }
    }

    private bool Consume(MpEnvelope message, string type, int maxAge, out long sent)
    {
        sent = 0;
        if (message.CorrelationId == null || !pending.Remove(message.CorrelationId, out var request) || request.Type != type
            || (type == "LeaseRequest" && request.Generation != acquireGeneration)
            || now() < request.Sent || now() - request.Sent >= maxAge) return false;
        sent = request.Sent; return true;
    }

    public void ReplacePolicy(HostPolicy policy)
    {
        if (!IsCoordinator || !native.MainPlayer || !native.Ready) throw new ActionFault("HOST_REQUIRED", "只允许主机本地管理政策。");
        policy.Validate(); Policy = policy; continuousBudgets.Clear();
        foreach (var entry in peers) { entry.Value.ContinuousSince = -1; entry.Value.LeaseUntil = 0; Emit(entry.Key, "LeaseRevoke", new { reason = "POLICY_CHANGED" }, peer: entry.Value); }
    }
    public void SetPhase(string value, bool dayStarted = false, bool saved = false)
    {
        if (!IsCoordinator || !native.MainPlayer) return;
        phase = value; phaseSequence++; if (dayStarted) dayGeneration++; if (saved) saveRevision++;
        foreach (var entry in peers) { entry.Value.LeaseUntil = 0; Emit(entry.Key, "PhaseChanged", new { phase, phaseSequence, dayGeneration, saveRevision }, peer: entry.Value); }
    }
    public object Status() => new { enabled = config.Enabled, role = config.Role, state = State, reason = Reason, worldId = native.Ready ? native.WorldId : null,
        actorFarmerId = native.Ready ? MpIdentity.Farmer(native.ActorId) : null, hostFarmerId = native.Ready ? MpIdentity.Farmer(native.HostId) : null,
        actorSessionId = actorSession, hostSessionId = hostSession, connectionId = connection, policyRevision,
        permissionLeaseHeld = Authorized, permissionRemainingMs = Authorized ? Math.Max(0, lease.Deadline - now()) : 0,
        actorContext = Scope, policy = actorPolicy, phase, phaseSequence, dayGeneration, saveRevision,
        hostObservation = hostObservation == null || now() - observedAt >= 5000 ? null : new { value = hostObservation, ageMs = now() - observedAt, confirmationScope = "host_observed", actionAttribution = "unproven" },
        worldClock = new { state = "unknown", scope = "not_globally_paused" } };

    private void Emit(long player, string type, object payload, string? correlation = null, PeerState? peer = null, bool track = false)
    {
        var message = new MpEnvelope { Type = type, Sequence = ++outbound, CorrelationId = correlation,
            HostSessionId = hostSession, ActorSessionId = peer?.ActorSession ?? actorSession, ConnectionId = peer?.Connection ?? connection,
            Payload = JsonSerializer.SerializeToElement(payload, MpEnvelope.ProtocolJson) };
        if (track && pending.Count < 32) pending[message.MessageId] = (now(), type, acquireGeneration);
        send(player, message);
    }
}
