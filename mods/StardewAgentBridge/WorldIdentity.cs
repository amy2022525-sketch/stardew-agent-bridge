using System.Globalization;
using System.Text.RegularExpressions;

namespace StardewAgentBridge;

/// <summary>
/// 稳定存档身份的规范化（只读、纯函数，便于孤立测试）。
///
/// - worldId：原生 <c>Game1.uniqueIDForThisGame</c> 的 invariant 十进制字符串；
/// - actorFarmerId：本地 <c>Game1.player.UniqueMultiplayerID</c> 的规范 Int64 字符串。
///
/// 绝不把 Int64 转成 JS Number：超过 2^53 的 ID 会丢精度，因此 Mod 侧一律以字符串输出，
/// TS 侧用 <c>DECISION_ID_PATTERN</c>/Int64 正则校验后原样保存。
/// </summary>
public static class WorldIdentity
{
    public const int SchemaVersion = 1;
    public const string SourceNativeGame = "native_game";

    private static readonly Regex CanonicalInt64 = new("^-?(?:0|[1-9][0-9]*)$", RegexOptions.CultureInvariant);

    /// <summary>原生世界 ID 的 invariant 十进制字符串；不做数制转换或填充。</summary>
    public static string FormatWorldId(object uniqueId)
    {
        var text = Convert.ToString(uniqueId, CultureInfo.InvariantCulture);
        return string.IsNullOrWhiteSpace(text) ? "0" : text.Trim();
    }

    /// <summary>农场工 ID 的规范 Int64 字符串（可为负，不做补零）。</summary>
    public static string FormatFarmerId(long farmerId)
    {
        return farmerId.ToString(CultureInfo.InvariantCulture);
    }

    /// <summary>规范 Int64 文本校验：拒绝前导零、加号、空白、科学计数法与超长串。</summary>
    public static bool IsCanonicalFarmerId(string? value)
    {
        if (string.IsNullOrEmpty(value) || value.Length > 20) return false;
        return CanonicalInt64.IsMatch(value);
    }

    /// <summary>
    /// 构造协议里的可选 worldIdentity；世界未就绪时返回 null（旧 Mod 也按缺失处理）。
    /// </summary>
    public static object? Create(bool worldReady, object worldId, long actorFarmerId)
    {
        if (!worldReady) return null;
        var canonicalFarmer = FormatFarmerId(actorFarmerId);
        if (!IsCanonicalFarmerId(canonicalFarmer)) return null;
        return new
        {
            schemaVersion = SchemaVersion,
            source = SourceNativeGame,
            worldId = FormatWorldId(worldId),
            actorFarmerId = canonicalFarmer
        };
    }
}
