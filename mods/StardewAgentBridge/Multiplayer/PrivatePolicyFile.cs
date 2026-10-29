using System.Runtime.InteropServices;

namespace StardewAgentBridge.Multiplayer;

/// <summary>Atomic policy replacement compatible with the game's .NET 6 runtime.</summary>
internal static class PrivatePolicyFile
{
    [DllImport("libc", SetLastError = true, EntryPoint = "chmod")]
    private static extern int Chmod(string path, uint mode);
    private static void CheckLink(string path)
    {
        if ((File.Exists(path) || Directory.Exists(path)) && (File.GetAttributes(path) & FileAttributes.ReparsePoint) != 0)
            throw new IOException("Policy path must not contain symbolic links/reparse points.");
    }
    private static void Mode(string path, uint mode)
    {
        if (!OperatingSystem.IsWindows() && Chmod(path, mode) != 0) throw new IOException("Cannot restrict policy permissions.");
    }
    public static void Write(string root, string path, byte[] data)
    {
        var fullRoot = Path.GetFullPath(root).TrimEnd(Path.DirectorySeparatorChar) + Path.DirectorySeparatorChar;
        var fullPath = Path.GetFullPath(path);
        if (!fullPath.StartsWith(fullRoot, OperatingSystem.IsWindows() ? StringComparison.OrdinalIgnoreCase : StringComparison.Ordinal)) throw new IOException("Policy path escapes data root.");
        CheckLink(root);
        var directory = Path.GetDirectoryName(fullPath)!;
        CheckLink(directory); CheckLink(fullPath);
        Directory.CreateDirectory(directory); Mode(directory, 448); // 0700
        var temp = fullPath + "." + MpIdentity.Nonce() + ".tmp";
        try
        {
            using (var file = new FileStream(temp, FileMode.CreateNew, FileAccess.Write, FileShare.None))
            { Mode(temp, 384); file.Write(data); file.Flush(true); } // 0600
            CheckLink(fullPath); File.Move(temp, fullPath, true);
        }
        finally { if (File.Exists(temp)) File.Delete(temp); }
    }
}
