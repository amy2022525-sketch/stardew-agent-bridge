using System.Text.Json;
using StardewAgentBridge;

internal static class WorldIdentityTests
{
    /// <summary>
    /// 只测纯函数：不启动游戏、不读存档。原生 ID 一律以字符串保真，
    /// 超过 JS Number.MAX_SAFE_INTEGER 的值不得被转成 double。
    /// </summary>
    public static void Run(Action<bool, string> check)
    {
        check(WorldIdentity.FormatWorldId(18446744073709551615UL) == "18446744073709551615", "世界 ID 以 ulong 十进制字符串保真");
        check(WorldIdentity.FormatWorldId(1) == "1", "世界 ID 不做补零或数制转换");
        check(WorldIdentity.FormatFarmerId(9007199254740993L) == "9007199254740993", "农场工 ID 超过 JS 安全整数仍精确保真");
        check(WorldIdentity.FormatFarmerId(long.MaxValue) == "9223372036854775807", "Int64 上界保持规范十进制");
        check(WorldIdentity.FormatFarmerId(-1L) == "-1", "负农场工 ID 保留符号，不转无符号");

        check(WorldIdentity.IsCanonicalFarmerId("0"), "规范 Int64 接受 0");
        check(WorldIdentity.IsCanonicalFarmerId("-0"), "规范 Int64 与 TS 正则一致，接受 -0");
        check(!WorldIdentity.IsCanonicalFarmerId("01"), "规范 Int64 拒绝前导零");
        check(!WorldIdentity.IsCanonicalFarmerId("+1"), "规范 Int64 拒绝加号");
        check(!WorldIdentity.IsCanonicalFarmerId("1.0"), "规范 Int64 拒绝小数");
        check(!WorldIdentity.IsCanonicalFarmerId(" 1"), "规范 Int64 拒绝空白");
        check(!WorldIdentity.IsCanonicalFarmerId("1e3"), "规范 Int64 拒绝科学计数法");
        check(!WorldIdentity.IsCanonicalFarmerId(""), "规范 Int64 拒绝空串");

        check(WorldIdentity.Create(false, 42, 7) == null, "世界未就绪时不输出身份（旧 Mod 按缺失处理）");

        var identity = WorldIdentity.Create(true, 1234567890123456789UL, 9007199254740993L);
        check(identity != null, "世界就绪时输出可选身份对象");
        using var json = JsonDocument.Parse(JsonSerializer.Serialize(identity));
        var root = json.RootElement;
        check(root.GetProperty("schemaVersion").GetInt32() == 1, "身份 schemaVersion 固定为 1");
        check(root.GetProperty("source").GetString() == "native_game", "身份来源标记为 native_game");
        check(root.GetProperty("worldId").GetString() == "1234567890123456789", "身份里的世界 ID 为字符串");
        check(root.GetProperty("actorFarmerId").GetString() == "9007199254740993", "身份里的农场工 ID 为字符串而非数字");
        check(root.GetProperty("actorFarmerId").ValueKind == JsonValueKind.String, "农场工 ID 绝不序列化为 JSON number");
    }
}
