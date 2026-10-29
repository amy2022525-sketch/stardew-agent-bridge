using System.Globalization;
using System.Security.Cryptography;
using System.Text.Json;

namespace StardewAgentBridge.Multiplayer;

public sealed class MultiplayerConfig
{
    public bool Enabled { get; set; }
    public string Role { get; set; } = "farmhand";
    public string? ExpectedWorldId { get; set; }
    public string? ExpectedActorFarmerId { get; set; }
    public bool RequireHostCoordinator { get; set; } = true;
    public int PermissionLeaseMs { get; set; } = 5000;
    public string PolicyFile { get; set; } = "multiplayer/policy.json";
    public void Validate()
    {
        if (!Enabled) return;
        if (Role is not ("farmhand" or "host-coordinator") || !RequireHostCoordinator || PermissionLeaseMs is < 1000 or > 10000)
            throw new ActionFault("CONFIG_INVALID", "联机角色/主机校验/许可时限配置无效。");
        if (PolicyFile != "multiplayer/policy.json") throw new ActionFault("CONFIG_INVALID", "首版政策文件固定为 multiplayer/policy.json。");
        if (ExpectedActorFarmerId != null) MpIdentity.ParseFarmer(ExpectedActorFarmerId);
        if (ExpectedWorldId is { Length: > 100 }) throw new ActionFault("CONFIG_INVALID", "世界标识过长。");
    }
}

public static class MpIdentity
{
    public static string Nonce() => Convert.ToBase64String(RandomNumberGenerator.GetBytes(16)).TrimEnd('=').Replace('+', '-').Replace('/', '_');
    public static long ParseFarmer(string value)
    {
        if (!long.TryParse(value, NumberStyles.AllowLeadingSign, CultureInfo.InvariantCulture, out var id)
            || id.ToString(CultureInfo.InvariantCulture) != value)
            throw new ActionFault("INVALID_ARGUMENT", "Farmer ID 必须为无损规范 Int64 十进制字符串。");
        return id;
    }
    public static string Farmer(long value) => value.ToString(CultureInfo.InvariantCulture);
}

public sealed record ActorContext(string WorldId, string HostFarmerId, string HostSessionId, string ActorFarmerId,
    string ActorSessionId, string ConnectionId, int PolicyRevision, string PermissionLeaseId,
    int WorldGeneration = 0, int SceneGeneration = 0, int DayGeneration = 0);

public sealed record NativeContext(bool Ready, bool Multiplayer, bool MainPlayer, bool SplitScreen,
    string WorldId, long ActorId, long HostId, string Location, int Day);

public sealed class ActorPolicy
{
    public bool Enabled { get; set; }
    public int MaxActionMs { get; set; } = 5000;
    public int MaxContinuousControlMs { get; set; } = 120000;
    public List<string> AllowedLocations { get; set; } = new();
    public List<AllowedArea> AllowedAreas { get; set; } = new();
    public bool AllowMovement { get; set; } = true;
    public bool AllowWatering { get; set; }
    public bool AllowOwnInventoryCraft { get; set; }
    public bool AllowOwnFood { get; set; } = true;
    public bool AllowOwnEquipment { get; set; } = true;
    public void Validate()
    {
        if (AllowedLocations == null || AllowedAreas == null || MaxActionMs is < 100 or > 10000 || MaxContinuousControlMs is < 1000 or > 3600000
            || AllowedLocations.Count > 64 || AllowedAreas.Count > 128
            || AllowedLocations.Any(x => string.IsNullOrWhiteSpace(x) || x.Length > 160)
            || AllowedAreas.Any(x => x == null || x.Width is < 1 or > 1024 || x.Height is < 1 or > 1024 || x.X < 0 || x.Y < 0 || !AllowedLocations.Contains(x.Location)))
            throw new ActionFault("CONFIG_INVALID", "联机政策包含无效时限、位置或区域。");
    }
    public bool AllowsLocation(string location) => AllowedLocations.Contains(location, StringComparer.Ordinal);
    public bool AllowsTile(string location, int x, int y) => AllowedAreas.Any(a => a.Location == location && x >= a.X && y >= a.Y && (long)x < (long)a.X + a.Width && (long)y < (long)a.Y + a.Height);
}

public sealed class AllowedArea
{
    public string Location { get; set; } = "";
    public int X { get; set; }
    public int Y { get; set; }
    public int Width { get; set; }
    public int Height { get; set; }
}

public sealed class HostPolicy
{
    public int SchemaVersion { get; set; } = 1;
    public string WorldId { get; set; } = "";
    public int Revision { get; set; } = 1;
    public Dictionary<string, ActorPolicy> Actors { get; set; } = new();
    public void Validate()
    {
        if (SchemaVersion != 1 || Revision < 1 || Actors == null || Actors.Count > 64 || WorldId == null || WorldId.Length > 100) throw new ActionFault("CONFIG_INVALID", "主机政策版本或大小无效。");
        foreach (var entry in Actors) { MpIdentity.ParseFarmer(entry.Key); if (entry.Value == null) throw new ActionFault("CONFIG_INVALID", "角色政策不能为空。"); entry.Value.Validate(); }
    }
}

public sealed class MpEnvelope
{
    public string Protocol { get; set; } = "sab-mp/1";
    public string Type { get; set; } = "";
    public string MessageId { get; set; } = MpIdentity.Nonce();
    public string? CorrelationId { get; set; }
    public string? HostSessionId { get; set; }
    public string ActorSessionId { get; set; } = "";
    public string? ConnectionId { get; set; }
    public long Sequence { get; set; }
    public JsonElement Payload { get; set; }
    public bool IsWellFormed() => Protocol == "sab-mp/1" && Types.Contains(Type)
        && MessageId is { Length: >= 16 and <= 80 } && ActorSessionId is { Length: >= 16 and <= 80 }
        && Sequence is > 0 and <= 9007199254740991 && Payload.ValueKind == JsonValueKind.Object
        && JsonSerializer.SerializeToUtf8Bytes(this, ProtocolJson).Length <= 16384;
    public static readonly JsonSerializerOptions ProtocolJson = new() { PropertyNamingPolicy = JsonNamingPolicy.CamelCase, PropertyNameCaseInsensitive = false, MaxDepth = 16 };
    public static readonly HashSet<string> Types = new(StringComparer.Ordinal)
    { "ClientHello", "HostHello", "LeaseRequest", "LeaseGrant", "LeaseRelease", "LeaseRevoke", "PhaseChanged", "ObservationRequest", "ObservationReport" };
}

public sealed class HostReply
{
    public string WorldId { get; set; } = "";
    public string HostFarmerId { get; set; } = "";
    public string ActorFarmerId { get; set; } = "";
    public int PolicyRevision { get; set; }
    public ActorPolicy? Policy { get; set; }
    public string Phase { get; set; } = "active";
    public int PhaseSequence { get; set; }
    public int DayGeneration { get; set; }
    public int SaveRevision { get; set; }
}

public sealed class LeaseReply
{
    public string LeaseId { get; set; } = "";
    public int TtlMs { get; set; }
    public int PolicyRevision { get; set; }
}

public sealed record HostObservation(string ActorFarmerId, string Location, int X, int Y, long HostTick);

/// <summary>Expiry starts at the local request time, never at arrival of a delayed grant.</summary>
public sealed class PermissionLease
{
    public string? Id { get; private set; }
    public long Deadline { get; private set; }
    private long lastSequence;
    public bool Valid(long now) => Id != null && now < Deadline;
    public bool Accept(string id, long sequence, long requestSent, long now, int ttlMs)
    {
        if (ttlMs is < 1000 or > 10000 || id is not { Length: >= 16 and <= 80 } || sequence <= lastSequence
            || now < requestSent || now - requestSent >= ttlMs) return false;
        Id = id; Deadline = requestSent + ttlMs; lastSequence = sequence; return true;
    }
    public void Revoke() { Id = null; Deadline = 0; }
    public void Reset() { Revoke(); lastSequence = 0; }
}
