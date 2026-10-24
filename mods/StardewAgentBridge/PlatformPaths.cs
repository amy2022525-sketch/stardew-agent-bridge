using System;
using System.Collections.Generic;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;

namespace StardewAgentBridge;

/// <summary>
/// 跨平台数据根解析：Mod 侧唯一实现，与 Node 侧 <c>packages/platform/src/data-root.ts</c> 规则完全一致。
///
/// 规则（两侧必须完全一致，见 docs/LINUX_DEVELOPMENT.md 与 tests/fixtures/platform-paths.json）：
///
/// | 场景 | 规则 |
/// | --- | --- |
/// | 显式 <c>config.DataDirectory</c> | 最高优先；必须是绝对路径（相对值直接报错，不做猜测） |
/// | 非空 <c>SAB_HOME</c> | 其次；Linux 上必须是绝对路径，相对值明确报错 |
/// | Windows 默认 | <c>%LOCALAPPDATA%\StardewAgentBridge</c>，缺失时 <c>~/AppData/Local/StardewAgentBridge</c> |
/// | Linux 默认 | 绝对 <c>XDG_DATA_HOME</c> 下的 <c>StardewAgentBridge</c>，否则 <c>~/.local/share/StardewAgentBridge</c> |
/// | Linux 上的 LOCALAPPDATA | 忽略 |
/// | Linux 上相对的 XDG_DATA_HOME | 视为无效并回退默认 |
///
/// 通过 Steam 启动游戏时终端环境变量不会被继承，所以安装器把解析后的绝对路径写进
/// <c>config.DataDirectory</c>；本类不读取游戏自己的配置，也不写任何文件。
/// </summary>
public static class PlatformPaths
{
    public const string AppDirectoryName = "StardewAgentBridge";

    /// <summary>当前进程的平台标识：与 Node 的 <c>process.platform</c> 对齐（<c>win32</c> / <c>linux</c>）。</summary>
    public static string CurrentPlatformId()
    {
        if (RuntimeInformation.IsOSPlatform(OSPlatform.Windows)) return "win32";
        return "linux";
    }

    public static string HomeDirectory()
    {
        var profile = Environment.GetFolderPath(Environment.SpecialFolder.UserProfile);
        if (!string.IsNullOrWhiteSpace(profile)) return profile;
        var home = Environment.GetEnvironmentVariable("HOME");
        return string.IsNullOrWhiteSpace(home) ? string.Empty : home;
    }

    /// <summary>解析结果：失败时只返回错误码与说明，绝不回退到「猜一个目录」。</summary>
    public sealed class DataRootResult
    {
        public string Path { get; init; } = string.Empty;

        /// <summary><c>explicit</c> / <c>SAB_HOME</c> / <c>LOCALAPPDATA</c> / <c>XDG_DATA_HOME</c> / <c>default</c>。</summary>
        public string Source { get; init; } = "default";

        public string Platform { get; init; } = "linux";

        /// <summary><c>PATH_INVALID</c> / <c>NO_HOME</c>；为空表示成功。</summary>
        public string? ErrorCode { get; init; }

        public string? ErrorMessage { get; init; }

        public bool Ok => ErrorCode is null;

        public override string ToString() => Ok ? $"{Path}（{Source}）" : $"{ErrorCode}: {ErrorMessage}";
    }

    public static DataRootResult Resolve(
        string? explicitOverride,
        Func<string, string?> readEnv,
        string homeDir,
        string platform,
        bool requireAbsoluteExplicit)
    {
        homeDir ??= string.Empty;
        var explicitValue = Trim(explicitOverride);
        if (explicitValue.Length > 0)
        {
            if (requireAbsoluteExplicit && !IsAbsolute(explicitValue, platform))
            {
                return Failure("PATH_INVALID", $"数据目录必须是绝对路径：{explicitValue}", platform);
            }
            return Success(Normalize(explicitValue, platform), "explicit", platform);
        }

        var sabHome = Trim(readEnv?.Invoke("SAB_HOME"));
        if (sabHome.Length > 0)
        {
            if (platform == "linux" && !IsAbsolute(sabHome, platform))
            {
                return Failure(
                    "PATH_INVALID",
                    $"Linux 上 SAB_HOME 必须是绝对路径（收到 \"{sabHome}\"）。请使用 \"$HOME/...\" 这样的绝对路径，" +
                    "否则启动目录不同会分裂成多个数据根。",
                    platform);
            }
            return Success(Normalize(sabHome, platform), "SAB_HOME", platform);
        }

        if (platform == "linux")
        {
            var xdg = Trim(readEnv?.Invoke("XDG_DATA_HOME"));
            // XDG 规范要求绝对路径；相对值视为无效并回退默认，但来源会写清楚。
            if (xdg.Length > 0 && IsAbsolute(xdg, platform))
            {
                return Success(Join("linux", xdg, AppDirectoryName), "XDG_DATA_HOME", platform);
            }
            if (homeDir.Trim().Length == 0)
            {
                return Failure("NO_HOME", "缺少用户主目录，无法确定默认数据目录；请在 Mod 配置里设置 DataDirectory。", platform);
            }
            return Success(Join("linux", homeDir, ".local", "share", AppDirectoryName), "default", platform);
        }

        var localAppData = Trim(readEnv?.Invoke("LOCALAPPDATA"));
        if (localAppData.Length > 0)
        {
            return Success(Join("win32", localAppData, AppDirectoryName), "LOCALAPPDATA", platform);
        }
        if (homeDir.Trim().Length == 0)
        {
            return Failure("NO_HOME", "缺少 %LOCALAPPDATA% 与用户主目录，无法确定默认数据目录；请在 Mod 配置里设置 DataDirectory。", platform);
        }
        return Success(Join("win32", homeDir, "AppData", "Local", AppDirectoryName), "default", platform);
    }

    /// <summary>生产代码入口：读取真实环境变量、平台与主目录。</summary>
    public static DataRootResult ResolveForProcess(string? explicitOverride, bool requireAbsoluteExplicit) =>
        Resolve(
            explicitOverride,
            name => Environment.GetEnvironmentVariable(name),
            HomeDirectory(),
            CurrentPlatformId(),
            requireAbsoluteExplicit);

    /// <summary>旧 Linux 数据根（历史默认），只用于诊断提示，绝不自动合并或删除。</summary>
    public static string? LegacyLinuxRoot(string homeDir)
    {
        if (string.IsNullOrWhiteSpace(homeDir)) return null;
        return Join("linux", homeDir, "AppData", "Local", AppDirectoryName);
    }

    /// <summary>目标平台语义下的绝对路径判断（不跟随链接、不访问磁盘）。</summary>
    public static bool IsAbsolute(string? value, string platform)
    {
        if (string.IsNullOrEmpty(value)) return false;
        if (platform == "linux") return value![0] == '/';
        // Windows：UNC、盘符根、根相对路径都算绝对。
        if (value!.Length >= 2 && (value[0] == '\\' || value[0] == '/')) return true;
        if (value.Length >= 3 && char.IsLetter(value[0]) && value[1] == ':' && (value[2] == '\\' || value[2] == '/')) return true;
        return false;
    }

    /// <summary>按目标平台语义做纯词法规范化：去重复分隔符、折叠 <c>.</c> 与 <c>..</c>、去末尾分隔符。</summary>
    public static string Normalize(string value, string platform)
    {
        if (string.IsNullOrEmpty(value)) return string.Empty;
        var windows = platform == "win32";
        var separator = windows && value.IndexOf('\\') >= 0 ? '\\' : (windows ? '\\' : '/');

        string prefix = string.Empty;
        var body = value;
        if (windows)
        {
            if (body.StartsWith("\\\\", StringComparison.Ordinal) || body.StartsWith("//", StringComparison.Ordinal))
            {
                // UNC：保留开头两个分隔符与前两段（server、share）。
                var unc = Split(body, windows);
                var head = new List<string>();
                var cursor = 0;
                while (cursor < unc.Count && head.Count < 2)
                {
                    if (unc[cursor].Length > 0) head.Add(unc[cursor]);
                    cursor++;
                }
                prefix = new string(separator, 2) + string.Join(separator.ToString(), head) + separator;
                var rest = new List<string>();
                for (var index = cursor; index < unc.Count; index++) rest.Add(unc[index]);
                body = string.Join(separator.ToString(), rest);
            }
            else if (body.Length >= 2 && char.IsLetter(body[0]) && body[1] == ':')
            {
                prefix = body.Substring(0, 2) + separator;
                body = body.Length > 2 ? body.Substring(2) : string.Empty;
            }
            else if (body.Length > 0 && (body[0] == '\\' || body[0] == '/'))
            {
                prefix = separator.ToString();
                body = body.Substring(1);
            }
        }
        else if (body[0] == '/')
        {
            prefix = "/";
            body = body.Substring(1);
        }

        var parts = Split(body, windows);
        var stack = new List<string>();
        foreach (var part in parts)
        {
            if (part.Length == 0 || part == ".") continue;
            if (part == "..")
            {
                if (stack.Count > 0 && stack[stack.Count - 1] != "..") stack.RemoveAt(stack.Count - 1);
                else if (prefix.Length == 0) stack.Add("..");
                continue;
            }
            stack.Add(part);
        }
        var joined = string.Join(separator.ToString(), stack);
        var result = prefix + joined;
        if (result.Length == 0) result = ".";
        // 去掉末尾分隔符（保留根）。
        while (result.Length > prefix.Length && (result[result.Length - 1] == '/' || result[result.Length - 1] == '\\'))
        {
            result = result.Substring(0, result.Length - 1);
        }
        if (windows && result.Length == 2 && result[1] == ':') result += separator;
        return result;
    }

    /// <summary>按目标平台语义拼接并规范化。</summary>
    public static string Join(string platform, params string[] parts)
    {
        var windows = platform == "win32";
        var separator = windows ? '\\' : '/';
        var builder = new StringBuilder();
        foreach (var part in parts)
        {
            if (string.IsNullOrEmpty(part)) continue;
            if (builder.Length > 0 && builder[builder.Length - 1] != separator) builder.Append(separator);
            builder.Append(part);
        }
        return Normalize(builder.ToString(), platform);
    }

    /// <summary>组件级判断目标是否在根目录内部；Windows 不区分大小写，Linux 按真实大小写。</summary>
    public static bool IsPathInside(string root, string target, string platform)
    {
        if (string.IsNullOrEmpty(root) || string.IsNullOrEmpty(target)) return false;
        var comparison = platform == "win32" ? StringComparison.OrdinalIgnoreCase : StringComparison.Ordinal;
        var normalizedRoot = Normalize(root, platform);
        var normalizedTarget = Normalize(target, platform);
        if (normalizedRoot.Length == 0) return false;
        if (normalizedTarget.Equals(normalizedRoot, comparison)) return false;
        var prefix = normalizedRoot.EndsWith("/", StringComparison.Ordinal) || normalizedRoot.EndsWith("\\", StringComparison.Ordinal)
            ? normalizedRoot
            : normalizedRoot + (platform == "win32" ? "\\" : "/");
        return normalizedTarget.StartsWith(prefix, comparison);
    }

    private static List<string> Split(string value, bool windows)
    {
        var parts = new List<string>();
        var builder = new StringBuilder();
        foreach (var ch in value)
        {
            if (ch == '/' || (windows && ch == '\\'))
            {
                parts.Add(builder.ToString());
                builder.Clear();
                continue;
            }
            builder.Append(ch);
        }
        parts.Add(builder.ToString());
        return parts;
    }

    private static string Trim(string? value) => string.IsNullOrWhiteSpace(value) ? string.Empty : value!.Trim();

    private static DataRootResult Success(string path, string source, string platform) =>
        new DataRootResult { Path = path, Source = source, Platform = platform };

    private static DataRootResult Failure(string code, string message, string platform) =>
        new DataRootResult { ErrorCode = code, ErrorMessage = message, Platform = platform, Path = string.Empty };
}
