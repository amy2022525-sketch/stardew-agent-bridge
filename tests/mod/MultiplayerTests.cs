using System.Text.Json;
using StardewAgentBridge;
using StardewAgentBridge.Multiplayer;

internal static class MultiplayerTests
{
    private const long Host = 9007199254740993, Actor = 9223372036854775807;
    private const string Mod = "StardewAgentBridge";
    private sealed class Pair
    {
        public long Time;
        public readonly SessionMachine HostMachine, Client;
        public readonly List<(bool ToHost, MpEnvelope Message)> Queue = new();
        public NativeContext HostContext = new(true, true, true, false, "world-1", Host, Host, "Farm", 1);
        public NativeContext ClientContext = new(true, true, false, false, "world-1", Actor, Host, "Farm", 1);
        public readonly HostPolicy Policy;
        public Pair(bool bound = true, int leaseMs = 5000, int budgetMs = 10000)
        {
            Policy = new() { WorldId = "world-1", Actors = new() { [MpIdentity.Farmer(Actor)] = new ActorPolicy { Enabled = true, AllowedLocations = new() { "Farm", "Town" }, MaxContinuousControlMs = budgetMs } } };
            HostMachine = new(new() { Enabled = true, Role = "host-coordinator", PermissionLeaseMs = leaseMs }, Policy, (_, message) => Queue.Add((false, message)), _ => true, () => Time);
            Client = new(new() { Enabled = true, PermissionLeaseMs = leaseMs, ExpectedWorldId = bound ? "world-1" : null, ExpectedActorFarmerId = bound ? MpIdentity.Farmer(Actor) : null }, new(), (_, message) => Queue.Add((true, message)), _ => true, () => Time);
            HostMachine.ObserveActor = id => new(MpIdentity.Farmer(id), "Farm", 10, 12, Time);
            HostMachine.Tick(HostContext); Client.Tick(ClientContext); Pump();
        }
        public void Pump()
        {
            var turns = 0;
            while (Queue.Count > 0)
            {
                if (++turns > 100) throw new Exception("message loop");
                var message = Queue[0]; Queue.RemoveAt(0);
                if (message.ToHost) HostMachine.Receive(Actor, Mod, Mod, message.Message);
                else Client.Receive(Host, Mod, Mod, message.Message);
            }
        }
        public void Step(int milliseconds = 1) { Time += milliseconds; HostMachine.Tick(HostContext); Client.Tick(ClientContext); Pump(); }
        public void Acquire() { Client.RequestControl(); Step(); }
    }
    public static void Run(Action<bool, string> check, Action<Action, string, string> reject)
    {
        using (var ids = JsonDocument.Parse(File.ReadAllText(Path.Combine(AppContext.BaseDirectory, "fixtures", "multiplayer-identities.json"))))
        {
            foreach (var id in ids.RootElement.GetProperty("valid").EnumerateArray()) check(MpIdentity.Farmer(MpIdentity.ParseFarmer(id.GetString()!)) == id.GetString(), "MP Int64 roundtrip " + id);
            foreach (var id in ids.RootElement.GetProperty("invalid").EnumerateArray())
                if (id.ValueKind == JsonValueKind.String) reject(() => MpIdentity.ParseFarmer(id.GetString()!), "INVALID_ARGUMENT", "MP reject noncanonical ID " + id);
                else check(id.ValueKind != JsonValueKind.String, "MP numeric/null ID cannot enter string contract");
        }
        var lease = new PermissionLease();
        check(lease.Accept("abcdefghijklmnopqrstuv", 1, 100, 150, 1000), "MP accepts correlated timely lease");
        check(lease.Deadline == 1100 && !lease.Valid(1100), "MP lease expiry starts at request send time");
        lease.Revoke();
        check(!lease.Accept("abcdefghijklmnopqrstuv", 1, 100, 150, 1000), "MP duplicate grant cannot revive revoked lease");
        check(!lease.Accept("abcdefghijklmnopqrstuv", 2, 100, 1200, 1000), "MP delayed expired grant is rejected");
        check(!lease.Accept(null!, 3, 100, 150, 1000), "MP null lease ID fails closed");
        lease.Reset(); check(lease.Accept("abcdefghijklmnopqrstuv", 1, 200, 200, 1000), "MP new host session resets sequence fence");

        var p = new Pair();
        check(!p.Client.Authorized && p.Client.Bound, "MP handshake alone grants no control");
        p.Acquire();
        check(p.Client.Authorized, "MP native actor gets host-approved lease");
        var original = p.Client.Scope!;
        check(original.ActorFarmerId == "9223372036854775807" && original.HostFarmerId == "9007199254740993", "MP preserves both unsafe-JS IDs");
        p.Client.AssertScope(original);
        reject(() => p.Client.AssertScope(original with { ActorFarmerId = "2" }), "STALE_ACTOR_SESSION", "MP another actor context is rejected");
        reject(() => p.Client.AssertScope(original with { ConnectionId = MpIdentity.Nonce() }), "STALE_ACTOR_SESSION", "MP another connection context is rejected");
        p.Step(2100);
        var status = JsonSerializer.SerializeToElement(p.Client.Status(), MpEnvelope.ProtocolJson);
        check(status.GetProperty("hostObservation").GetProperty("actionAttribution").GetString() == "unproven", "MP host position observation never claims action commit");
        p.HostMachine.SetPhase("saving"); p.Pump();
        check(!p.Client.Authorized, "MP host saving revokes permission immediately");
        p.Client.RequestControl(); p.Step(); check(!p.Client.Authorized, "MP saving refuses new lease");
        p.HostMachine.SetPhase("active", dayStarted: true, saved: true); p.Pump(); p.Step();
        check(!p.Client.Authorized, "MP next day never auto-resumes old control");
        p.Acquire(); check(p.Client.Authorized && p.Client.Scope!.DayGeneration == 1, "MP next day needs explicit fresh acquire");
        reject(() => p.Client.AssertScope(original), "STALE_ACTOR_SESSION", "MP prior day context cannot mutate world");
        var beforeScene = p.Client.Scope!;
        p.ClientContext = p.ClientContext with { Location = "Town" }; p.Step();
        check(!p.Client.Authorized, "MP map transition closes local control");
        p.Acquire(); check(p.Client.Scope!.SceneGeneration > beforeScene.SceneGeneration, "MP scene fence advances after warp");
        p.Client.ReleaseControl(); check(!p.Client.Authorized, "MP local release cannot keep lease alive");

        var binding = new Pair(bound: false); binding.Acquire();
        check(!binding.Client.Authorized && !binding.Client.Bound, "MP actor binding is separate from host approval");
        binding.Client.BindCurrent(); binding.Step(); binding.Acquire();
        check(binding.Client.Authorized, "MP explicit binding permits approved real actor");
        binding.ClientContext = binding.ClientContext with { ActorId = 44 }; binding.Step();
        check(!binding.Client.Authorized && !binding.Client.Bound, "MP changing farmer never inherits old binding");

        var reconnect = new Pair(); reconnect.Acquire();
        var stale = reconnect.Client.Scope!; reconnect.Time = 10500;
        reconnect.HostMachine.Disconnect(Actor); reconnect.Client.Disconnect(Host); reconnect.Step(); reconnect.Acquire();
        check(!reconnect.Client.Authorized, "MP reconnect cannot reset actor continuous-control budget");
        reconnect.Policy.Revision++; reconnect.HostMachine.ReplacePolicy(reconnect.Policy); reconnect.Pump(); reconnect.Step(2100); reconnect.Acquire();
        check(reconnect.Client.Authorized, "MP explicit host policy revision renews exhausted budget");
        check(reconnect.Client.Scope!.ActorSessionId != stale.ActorSessionId, "MP reconnect rotates actor session nonce");
        reconnect.Policy.Actors[MpIdentity.Farmer(Actor)].Enabled = false; reconnect.Policy.Revision++;
        reconnect.HostMachine.ReplacePolicy(reconnect.Policy); reconnect.Pump();
        check(!reconnect.Client.Authorized, "MP host policy revoke stops live permission");

        var delayed = new Pair(); delayed.Client.RequestControl(); delayed.Client.Tick(delayed.ClientContext);
        var request = delayed.Queue.Single(x => x.Message.Type == "LeaseRequest").Message; delayed.Queue.Clear();
        delayed.HostMachine.Receive(Actor, Mod, Mod, request);
        var grant = delayed.Queue.Single(x => x.Message.Type == "LeaseGrant").Message; delayed.Queue.Clear(); delayed.Time = 6000;
        delayed.Client.Receive(Host, Mod, Mod, grant);
        check(!delayed.Client.Authorized, "MP delayed network grant cannot extend TTL at receipt");

        // ── H01：续期节奏必须跟随实际许可期限，而不是固定间隔 ──
        var scheduled = new Pair();
        scheduled.Acquire(); // Time=1：授予 Deadline=5001、下一次续期时刻 4751
        scheduled.Time += 4749; scheduled.Client.Tick(scheduled.ClientContext);
        check(scheduled.Queue.All(x => x.Message.Type != "LeaseRequest"), "MP renewal waits until its ahead-of-deadline slot");
        scheduled.Time += 1; scheduled.Client.Tick(scheduled.ClientContext);
        check(scheduled.Queue.Any(x => x.Message.Type == "LeaseRequest"), "MP renewal request leaves before the current lease expires");

        var shortLease = new Pair(leaseMs: 1000, budgetMs: 3000);
        shortLease.Acquire();
        var renewed = 0; long revokedAt = -1;
        for (var i = 0; i < 400; i++)
        {
            shortLease.Step(25);
            if (!shortLease.Client.Authorized) { revokedAt = shortLease.Time; break; }
            renewed++;
        }
        check(renewed >= 80, "MP 1000ms lease renews ahead of expiry with no authorization gap");
        check(revokedAt is > 2100 and < 2400, "MP continuous budget still bounds short-lease control");

        var edge = new Pair(leaseMs: 1000);
        edge.Client.RequestControl(); edge.Client.Tick(edge.ClientContext);
        var edgeRequest = edge.Queue.Single(x => x.Message.Type == "LeaseRequest").Message; edge.Queue.Clear();
        edge.HostMachine.Receive(Actor, Mod, Mod, edgeRequest);
        var edgeGrant = edge.Queue.Single(x => x.Message.Type == "LeaseGrant").Message; edge.Queue.Clear();
        edge.Time = 999; edge.Client.Receive(Host, Mod, Mod, edgeGrant);
        var edgeStatus = JsonSerializer.SerializeToElement(edge.Client.Status(), MpEnvelope.ProtocolJson);
        check(edge.Client.Authorized && edgeStatus.GetProperty("permissionRemainingMs").GetInt64() == 1, "MP grant at 999ms of a 1000ms lease keeps the request-send baseline");
        edge.Time = 1000; edge.Client.Tick(edge.ClientContext);
        check(!edge.Client.Authorized, "MP 1000ms lease expires at request send + ttl, not at arrival + ttl");

        var lateEdge = new Pair(leaseMs: 1000);
        lateEdge.Client.RequestControl(); lateEdge.Client.Tick(lateEdge.ClientContext);
        var lateRequest = lateEdge.Queue.Single(x => x.Message.Type == "LeaseRequest").Message; lateEdge.Queue.Clear();
        lateEdge.HostMachine.Receive(Actor, Mod, Mod, lateRequest);
        var lateGrant = lateEdge.Queue.Single(x => x.Message.Type == "LeaseGrant").Message; lateEdge.Queue.Clear();
        lateEdge.Time = 1001; lateEdge.Client.Receive(Host, Mod, Mod, lateGrant);
        check(!lateEdge.Client.Authorized, "MP grant arriving at 1001ms of a 1000ms lease is refused");

        // ── H02：释放/重启后的在途授予不能被下一次 acquire 借用 ──
        var released = new Pair();
        released.Client.RequestControl(); released.Client.Tick(released.ClientContext);
        var releasedRequest = released.Queue.Single(x => x.Message.Type == "LeaseRequest").Message; released.Queue.Clear();
        released.HostMachine.Receive(Actor, Mod, Mod, releasedRequest);
        var releasedGrant = released.Queue.Single(x => x.Message.Type == "LeaseGrant").Message; released.Queue.Clear();
        released.Client.ReleaseControl();
        check(!released.Client.Authorized, "MP local release drops the lease immediately");
        released.Client.RequestControl();                          // 立刻再次 start，新请求尚未发出
        released.Client.Receive(Host, Mod, Mod, releasedGrant);    // 旧授予抢先到达
        check(!released.Client.Authorized, "MP stale grant answering the released acquire cannot authorize the restart");
        released.Step();
        check(released.Client.Authorized, "MP restart after release earns its own fresh lease");

        var restarted = new Pair();
        restarted.Client.RequestControl(); restarted.Client.Tick(restarted.ClientContext);
        var supersededRequest = restarted.Queue.Single(x => x.Message.Type == "LeaseRequest").Message; restarted.Queue.Clear();
        restarted.HostMachine.Receive(Actor, Mod, Mod, supersededRequest);
        var supersededGrant = restarted.Queue.Single(x => x.Message.Type == "LeaseGrant").Message; restarted.Queue.Clear();
        restarted.Client.RequestControl();                         // 未 release 的再次 start：代次递增但 pending 保留
        restarted.Client.Receive(Host, Mod, Mod, supersededGrant);
        check(!restarted.Client.Authorized, "MP grant answering a superseded acquire generation is rejected");
        restarted.Acquire();
        check(restarted.Client.Authorized, "MP latest acquire generation still earns its own lease");

        var replayed = new Pair();
        replayed.Client.RequestControl(); replayed.Client.Tick(replayed.ClientContext);
        var replayRequest = replayed.Queue.Single(x => x.Message.Type == "LeaseRequest").Message; replayed.Queue.Clear();
        replayed.HostMachine.Receive(Actor, Mod, Mod, replayRequest);
        var replayGrant = replayed.Queue.Single(x => x.Message.Type == "LeaseGrant").Message; replayed.Queue.Clear();
        replayed.Client.Receive(Host, Mod, Mod, replayGrant);
        var remainingBefore = JsonSerializer.SerializeToElement(replayed.Client.Status(), MpEnvelope.ProtocolJson).GetProperty("permissionRemainingMs").GetInt64();
        replayed.Client.Receive(Host, Mod, Mod, replayGrant);      // 同一条授予原样重放
        var remainingAfter = JsonSerializer.SerializeToElement(replayed.Client.Status(), MpEnvelope.ProtocolJson).GetProperty("permissionRemainingMs").GetInt64();
        check(replayed.Client.Authorized && remainingBefore == remainingAfter, "MP duplicate grant replay neither extends nor resets the lease");

        var revokedStart = new Pair();
        revokedStart.Client.RequestControl(); revokedStart.Client.Tick(revokedStart.ClientContext);
        var preRevokeRequest = revokedStart.Queue.Single(x => x.Message.Type == "LeaseRequest").Message; revokedStart.Queue.Clear();
        revokedStart.HostMachine.Receive(Actor, Mod, Mod, preRevokeRequest);
        var preRevokeGrant = revokedStart.Queue.Single(x => x.Message.Type == "LeaseGrant").Message; revokedStart.Queue.Clear();
        revokedStart.Policy.Actors[MpIdentity.Farmer(Actor)].Enabled = false; revokedStart.Policy.Revision++;
        revokedStart.HostMachine.ReplacePolicy(revokedStart.Policy); revokedStart.Pump();
        check(!revokedStart.Client.Authorized, "MP policy revoke invalidates pending control");
        revokedStart.Acquire();
        check(!revokedStart.Client.Authorized, "MP revoked actor cannot reacquire while host policy stays disabled");
        revokedStart.Policy.Actors[MpIdentity.Farmer(Actor)].Enabled = true; revokedStart.Policy.Revision++;
        revokedStart.HostMachine.ReplacePolicy(revokedStart.Policy);
        revokedStart.Client.Receive(Host, Mod, Mod, preRevokeGrant); // 撤权前发出的旧授予
        check(!revokedStart.Client.Authorized, "MP pre-revoke grant cannot authorize the restarted acquire");
        revokedStart.Pump();                                        // 送达第二次 POLICY_CHANGED 撤权
        revokedStart.Step(2100);                                    // 刷新 HostHello 拿到新 policyRevision
        revokedStart.Acquire();
        check(revokedStart.Client.Authorized, "MP fresh acquire after re-approval and revision refresh works");

        var spoof = new Pair(); spoof.Client.RequestControl(); spoof.Client.Tick(spoof.ClientContext);
        var fake = new MpEnvelope { Type = "LeaseGrant", ActorSessionId = MpIdentity.Nonce(), Sequence = 99, Payload = JsonSerializer.SerializeToElement(new { leaseId = MpIdentity.Nonce(), ttlMs = 5000, policyRevision = 1 }) };
        spoof.Client.Receive(2, Mod, Mod, fake); spoof.Client.Receive(Host, "another.mod", Mod, fake);
        check(!spoof.Client.Authorized, "MP spoofed player/mod identity cannot grant lease");
        foreach (var payload in new[] { "{}", "{\"actorFarmerId\":null}", "{\"actorFarmerId\":123}", "{\"actorFarmerId\":\"1\",\"worldId\":\"world-1\"}" })
        {
            spoof.HostMachine.Receive(Actor, Mod, Mod, new() { Type = "ClientHello", Sequence = 200, ActorSessionId = MpIdentity.Nonce(), Payload = JsonDocument.Parse(payload).RootElement.Clone() });
        }
        check(true, "MP malformed peer payloads never escape game loop");
        var split = new Pair(); split.ClientContext = split.ClientContext with { SplitScreen = true }; split.Step(); split.Acquire();
        check(!split.Client.Authorized && split.Client.Reason == "SPLIT_SCREEN_UNSUPPORTED", "MP split-screen is rejected");
        var wrongRole = new Pair(); wrongRole.ClientContext = wrongRole.ClientContext with { MainPlayer = true }; wrongRole.Step();
        check(!wrongRole.Client.Authorized && wrongRole.Client.Reason == "FARMHAND_REQUIRED", "MP participant cannot control human host");

        var ctrl = new ControlAuthority(); ctrl.Acquire("mp", DateTime.UtcNow.AddMinutes(1), "realtime");
        var actions = new ActionCoordinator(ctrl, r => r); var creates = 0; Response? receipt = null;
        var action = new Request("mp-one", "select", JsonSerializer.SerializeToElement(new { slot = 0 }), ActionId: "stable", Epoch: ctrl.Epoch, ActorContext: original);
        void Start(Request r) => actions.Start(r, new object(), DateTime.UtcNow.AddSeconds(1), () => { creates++; return new Complete(); }, r => receipt = r);
        Start(action); actions.Tick(DateTime.UtcNow, _ => false); actions.Reset();
        Start(action with { RequestId = "mp-reconnect", ActorContext = original with { ConnectionId = MpIdentity.Nonce() } });
        check(creates == 1 && receipt!.Error?.Code == "IDEMPOTENCY_CONFLICT", "MP tombstone survives title and rejects changed-connection replay");
        Start(action with { RequestId = "mp-other-actor", ActorContext = original with { ActorFarmerId = "3" } }); actions.Tick(DateTime.UtcNow, _ => false);
        check(creates == 2, "MP identical action IDs on distinct actors have distinct namespaces");
        StardewModdingAPI.Context.IsMultiplayer = true;
        check(!ctrl.TryOpenPauseMenu(), "MP takeover cannot manufacture global pause");
        var pause = JsonSerializer.SerializeToElement(ControlAuthority.PauseState(false), Protocol.Json);
        check(pause.GetProperty("state").GetString() == "unknown" && pause.GetProperty("worldContinues").ValueKind == JsonValueKind.Null, "MP pause report keeps world-clock uncertainty");
        StardewModdingAPI.Context.IsMultiplayer = false;

        check(NativeDoor.Destination("Warp 12 8 Town") == "Town", "MP Action Warp uses the native x/y/location order");
        check(NativeDoor.Destination("Warp Town 12 8", touch: true) == "Town", "MP TouchAction Warp uses the native location/x/y order");
        check(NativeDoor.Destination("LockedDoorWarp 3 4 SeedShop 900 1700") == "SeedShop", "MP known locked door retains native opening-hour checks");
        foreach (var raw in new[] { "Sleep", "Door Abigail", "MagicWarp Town 1 2", "Warp Town 1 2", "Warp 1 2 Town;Sleep", "Warp -1 2 Town", "Warp 1 2 Town extra", "LockedDoorWarp 1 2 Town 0 2800 Abigail 500", "Warp 999999999999 2 Town" })
            check(NativeDoor.Destination(raw) == null, "MP unknown or ambiguous map action denied: " + raw);

        var sceneControl = new ControlAuthority(); sceneControl.Acquire("scene", DateTime.UtcNow.AddMinutes(1), "realtime");
        var sceneActions = new ActionCoordinator(sceneControl, r => r);
        var transition = new SceneObserver(); Response? sceneReceipt = null;
        var guards = 0; sceneActions.BeforeTick = _ => guards++;
        sceneActions.Start(action with { ActionId = "native-door" }, new object(), DateTime.UtcNow.AddSeconds(2), () => transition, r => sceneReceipt = r);
        sceneActions.Tick(DateTime.UtcNow, _ => false);
        check(guards == 1 && transition.Writes == 1, "MP native transition starts through the normal write guard");
        check(!sceneActions.BeginSceneObservation(), "MP unexpected destination cannot enter read-only completion");
        transition.Expected = true;
        check(sceneActions.BeginSceneObservation() && transition.Cancels == 1, "MP scene completion releases inputs before old control is revoked");
        sceneControl.Takeover(); sceneActions.Tick(DateTime.UtcNow, _ => false);
        check(sceneReceipt == null && transition.Writes == 1 && guards == 1, "MP fade settling never executes an old write or renews control");
        transition.Settled = true; sceneActions.Tick(DateTime.UtcNow, _ => false);
        check(sceneReceipt?.Status == "succeeded" && sceneReceipt.ActorContext == original && sceneControl.HolderName == null, "MP observed arrival keeps original receipt scope without regaining control");
        sceneActions.Start(action with { ActionId = "wrong-door" }, new object(), DateTime.UtcNow.AddSeconds(2), () => new SceneObserver { Expected = true }, r => sceneReceipt = r);
        check(sceneActions.BeginSceneObservation(), "MP second transition can enter read-only observation");
        sceneActions.Stop("HOST_PERMISSION_REVOKED");
        check(sceneReceipt?.Status == "unknown", "MP host revoke interrupts pending scene observation as unknown");

        var policyRoot = Path.Combine(Path.GetTempPath(), "sab-policy-test-" + Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(policyRoot);
        try
        {
            var policyFile = Path.Combine(policyRoot, "multiplayer", "policy.json");
            PrivatePolicyFile.Write(policyRoot, policyFile, System.Text.Encoding.UTF8.GetBytes("{\"revision\":1}"));
            PrivatePolicyFile.Write(policyRoot, policyFile, System.Text.Encoding.UTF8.GetBytes("{\"revision\":2}"));
            check(File.ReadAllText(policyFile) == "{\"revision\":2}", "MP policy atomic replacement persists the latest revision");
            if (!OperatingSystem.IsWindows())
            {
                check(File.GetUnixFileMode(policyFile) == (UnixFileMode.UserRead | UnixFileMode.UserWrite), "MP real Unix policy file permission is 0600");
                check(File.GetUnixFileMode(Path.GetDirectoryName(policyFile)!) == (UnixFileMode.UserRead | UnixFileMode.UserWrite | UnixFileMode.UserExecute), "MP real Unix policy directory permission is 0700");
                File.CreateSymbolicLink(Path.Combine(policyRoot, "multiplayer", "link.json"), policyFile);
                var rejected = false;
                try { PrivatePolicyFile.Write(policyRoot, Path.Combine(policyRoot, "multiplayer", "link.json"), new byte[] { 1 }); } catch (IOException) { rejected = true; }
                check(rejected && File.ReadAllText(policyFile) == "{\"revision\":2}", "MP policy rejects symlink overwrite without touching its target");
            }
        }
        finally { Directory.Delete(policyRoot, true); }
    }
    private sealed class Complete : IGameAction { public object Tick() => new { changed = false }; public void Cancel() { } }
    private sealed class SceneObserver : IGameAction, ISceneTransitionAction
    {
        public bool Expected, Settled;
        public int Writes, Cancels;
        public bool IsExpectedScene => Expected;
        public bool CanObserveSceneTransition => Expected;
        public object? Tick() { Writes++; return null; }
        public object? ObserveSceneTransition() => Settled ? new { changed = true } : null;
        public void Cancel() => Cancels++;
    }
}
