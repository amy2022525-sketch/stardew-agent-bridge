using System.Reflection;
using StardewModdingAPI;
using StardewValley;
using StardewValley.Menus;

namespace StardewAgentBridge;

// 标题界面的正常存档发现/加载入口；不读取任意路径，不修改存档内容。
public static class LifecycleActions
{
    private sealed record Attempt(string SaveId, object Result, bool Failed = false);
    private static readonly Dictionary<string, Attempt> attempts = new(StringComparer.Ordinal);
    private static readonly MethodInfo findSaves = typeof(LoadGameMenu).GetMethod("FindSaveGames", BindingFlags.Static | BindingFlags.NonPublic,
        null, new[] { typeof(string) }, null) ?? throw new InvalidOperationException("游戏缺少正常存档发现入口。");

    private static List<Farmer> Scan()
    {
        try { return findSaves.Invoke(null, new object?[] { null }) as List<Farmer> ?? new(); }
        catch (TargetInvocationException) { throw new ActionFault("LOAD_FAILED", "读取正常存档列表失败，请查看 SMAPI 日志或游戏存档目录。"); }
    }

    private static HashSet<string> ExistingDirectories()
    {
        var folder = StardewValley.Program.GetSavesFolder();
        if (!Directory.Exists(folder)) return new(StringComparer.Ordinal);
        return Directory.EnumerateDirectories(folder)
            .Where(path => (File.GetAttributes(path) & FileAttributes.ReparsePoint) == 0)
            .Select(path => Path.GetFileName(path)).ToHashSet(StringComparer.Ordinal);
    }

    private static object Metadata(Farmer farmer) => new
    {
        saveId = farmer.slotName, playerName = farmer.Name, farmName = farmer.farmName.Value,
        money = farmer.Money, gameVersion = farmer.gameVersion,
        date = new { year = farmer.yearForSaveGame, seasonIndex = farmer.seasonForSaveGame, day = farmer.dayOfMonthForSaveGame },
        compatible = Utility.CompareGameVersions(Game1.version, farmer.gameVersion, true) >= 0
    };

    public static object ListSaves()
    {
        var existing = ExistingDirectories();
        var farmers = Scan();
        try
        {
            var entries = farmers.Where(f => existing.Contains(f.slotName)).Select(Metadata).ToArray();
            return new { kind = "saves", entries, count = entries.Length, source = "游戏 LoadGameMenu.FindSaveGames 正常本地列表" };
        }
        finally
        {
            // 正常加载菜单也会在释放预览列表时卸载这些独立 Farmer；不触碰当前游戏角色。
            foreach (var farmer in farmers) if (!ReferenceEquals(farmer, Game1.player)) farmer.unload();
        }
    }

    public static object Load(string saveId, string actionId)
    {
        if (string.IsNullOrWhiteSpace(actionId) || !System.Text.RegularExpressions.Regex.IsMatch(actionId, "^[a-zA-Z0-9_-]{1,80}$"))
            throw new ActionFault("INVALID_ARGUMENT", "加载需要有效且唯一的 actionId。");
        if (attempts.TryGetValue(actionId, out var previous))
        {
            if (previous.SaveId != saveId) throw new ActionFault("INVALID_ARGUMENT", "相同 actionId 不能加载不同存档。");
            if (previous.Failed) throw new ActionFault("LOAD_FAILED", "该加载请求已经失败，不能重复启动；请查看游戏日志并重新观察。");
            return previous.Result;
        }
        if (attempts.Count >= 4096) throw new ActionFault("OUTPUT_LIMIT", "本进程存档加载请求记录已满，请重启游戏。");
        if (Context.IsWorldReady) throw new ActionFault("BUSY", "已有存档加载，需通过正常游戏菜单返回标题后才能加载另一个存档。");
        if (Game1.currentLoader != null || Game1.gameMode == 6) throw new ActionFault("BUSY", "游戏正在正常加载，请轮询 doctor 确认 SaveLoaded。");
        if (Game1.activeClickableMenu is not TitleMenu && Game1.activeClickableMenu is not LoadGameMenu)
            throw new ActionFault("BUSY", "当前不在标题或正常加载菜单，不能启动存档加载。");
        if (Game1.activeClickableMenu is TitleMenu && TitleMenu.subMenu is not null && TitleMenu.subMenu is not LoadGameMenu)
            throw new ActionFault("BUSY", "标题上还有其他子菜单，请先正常关闭。");
        var menu = Game1.activeClickableMenu as LoadGameMenu ?? TitleMenu.subMenu as LoadGameMenu;
        if (menu != null && (menu.loading || menu.deleting || menu.deleteConfirmationScreen || menu.timerToLoad > 0 || menu.IsDoingTask()))
            throw new ActionFault("BUSY", "加载菜单正在扫描、读取或处理确认，请等待当前任务结束。");
        if (string.IsNullOrWhiteSpace(saveId) || saveId is "." or ".." || saveId.IndexOfAny(Path.GetInvalidFileNameChars()) >= 0 || saveId.Contains('/') || saveId.Contains('\\'))
            throw new ActionFault("INVALID_ARGUMENT", "saveId 必须是 saves 返回的准确存档 ID，不能是文件路径。");
        var existing = ExistingDirectories();
        if (!existing.Contains(saveId)) throw new ActionFault("NOT_FOUND", "没有精确匹配的本地存档目录，请重新调用 saves。");

        var farmers = Scan();
        try
        {
            var selected = farmers.SingleOrDefault(f => string.Equals(f.slotName, saveId, StringComparison.Ordinal));
            if (selected == null) throw new ActionFault("NOT_FOUND", "游戏正常存档列表中没有该存档，文件可能不完整或不可读取。");
            // 与 LoadGameMenu.receiveLeftClick/SaveFileSlot 构造器相同的版本限制。
            if (Utility.CompareGameVersions(Game1.version, selected.gameVersion, true) < 0)
                throw new ActionFault("INCOMPATIBLE_PROTOCOL", "存档来自更新的游戏版本，正常加载菜单不允许读取。");
            var receipt = new { kind = "load", accepted = true, saveId, actionId,
                detail = "已提交正常游戏加载流程；accepted 仅表示启动，需轮询 doctor 等待 saveLoaded=true。" };
            // 先登记动作 ID，异常也不得重放可能已经开始的加载。
            attempts.Add(actionId, new(saveId, receipt));
            try
            {
                // 本机 SaveFileSlot.Activate 的实际函数体恰为这两句。
                SaveGame.Load(selected.slotName);
                Game1.exitActiveMenu();
            }
            catch
            {
                attempts[actionId] = new(saveId, receipt, true);
                throw new ActionFault("LOAD_FAILED", "正常加载入口发生错误；未重试，请检查游戏日志和当前加载状态。");
            }
            return receipt;
        }
        finally
        {
            foreach (var farmer in farmers) if (!ReferenceEquals(farmer, Game1.player)) farmer.unload();
        }
    }
}
