// 只为运行真实控制器源码的隔离测试提供最小游戏接口；不代表真实游戏验收。
namespace StardewModdingAPI
{
    public static class Context { public static bool IsWorldReady { get; set; } = true; public static bool IsMultiplayer { get; set; } }
}
namespace StardewValley
{
    public sealed class Farmer { public bool UsingTool { get; set; } }
    public static class Game1
    {
        public static Menus.IClickableMenu? activeClickableMenu;
        public static bool eventUp, fadeToBlack, killScreen;
        public static Farmer player = new();
        public static bool shouldTimePass() => activeClickableMenu == null;
    }
}
namespace StardewValley.Menus
{
    public class IClickableMenu
    {
        public virtual bool readyToClose() => true;
        public virtual void exitThisMenu() => StardewValley.Game1.activeClickableMenu = null;
    }
    public sealed class GameMenu : IClickableMenu { }
}
