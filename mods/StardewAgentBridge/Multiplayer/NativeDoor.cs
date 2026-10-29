using System.Globalization;

namespace StardewAgentBridge.Multiplayer;

/// <summary>Known native map door syntax only. Never interprets or executes map actions.</summary>
public static class NativeDoor
{
    public static string? Destination(string? action, bool touch = false)
    {
        if (string.IsNullOrWhiteSpace(action) || action.Length > 256) return null;
        var words = action.Split(' ', StringSplitOptions.RemoveEmptyEntries);
        var warp = words.Length == 4 && words[0] == "Warp";
        var locked = !touch && words.Length == 6 && words[0] == "LockedDoorWarp";
        if (!warp && !locked) return null;
        // Buildings.Action: Warp x y location; Back.TouchAction: Warp location x y.
        var x = touch ? 2 : 1;
        var destination = words[touch ? 1 : 3];
        if (!int.TryParse(words[x], NumberStyles.None, CultureInfo.InvariantCulture, out var tileX) || tileX > 4096
            || !int.TryParse(words[x + 1], NumberStyles.None, CultureInfo.InvariantCulture, out var tileY) || tileY > 4096
            || destination.Length > 128 || destination.Any(c => !(char.IsLetterOrDigit(c) || c is '_' or '-'))) return null;
        if (locked && (!int.TryParse(words[4], NumberStyles.None, CultureInfo.InvariantCulture, out var open) || open > 2800
            || !int.TryParse(words[5], NumberStyles.None, CultureInfo.InvariantCulture, out var close) || close > 2800)) return null;
        return destination;
    }
}
