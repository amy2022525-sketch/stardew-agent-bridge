using StardewModdingAPI;
using StardewValley;
using StardewValley.Menus;

namespace StardewAgentBridge;

// 游戏侧控制权：epoch 由 Mod 单调递增签发，Bridge 必须在每次写请求里带上它。
// 断线、超时、取消、接管都会让旧 epoch 失效，迟到请求无法重新取得控制。
public sealed class ControlAuthority
{
    public int Epoch { get; private set; } = 1;
    public string? HolderName { get; private set; }
    public DateTime? ExpiresAt { get; private set; }
    public bool SelfPauseOpened { get; set; }

    public bool LeaseValid => HolderName != null && ExpiresAt.HasValue && ExpiresAt.Value > DateTime.UtcNow;

    public void Acquire(string holder, DateTime expiresAt)
    {
        Epoch++;
        HolderName = holder;
        ExpiresAt = expiresAt;
    }

    public void Renew(int epoch, DateTime expiresAt)
    {
        if (epoch != Epoch) throw new ActionFault("CONTROL_EXPIRED", $"控制权代次已变化（当前 {Epoch}，请求 {epoch}），请重新获取控制权。");
        ExpiresAt = expiresAt;
    }

    public void Release(bool pause)
    {
        HolderName = null;
        ExpiresAt = null;
        if (pause) TryOpenPauseMenu();
    }

    public void Takeover()
    {
        Epoch++;
        HolderName = null;
        ExpiresAt = null;
    }

    // 任何写请求都必须通过这里：代次不匹配即拒绝，不猜测、不重放。
    public void AuthorizeWrite(int epoch)
    {
        if (epoch == 0) throw new ActionFault("CONTROL_REQUIRED", "写动作需要控制权 epoch；请先在 Bridge 侧获取控制会话。");
        if (epoch != Epoch) throw new ActionFault("CONTROL_EXPIRED", $"控制权代次已变化（当前 {Epoch}，请求 {epoch}），旧请求已失效，请重新获取控制权并观察真实状态。");
    }

    public static object PauseState(bool selfOpened)
    {
        var menu = Game1.activeClickableMenu;
        var state = menu == null ? "running" : "paused";
        if (Game1.activeClickableMenu == null && (Game1.eventUp || Game1.fadeToBlack)) state = "blocked";
        return new
        {
            state,
            menuType = menu?.GetType().Name,
            selfOpened = menu != null && selfOpened
        };
    }

    // 只在安全条件下打开正常暂停菜单；绝不关闭玩家自己打开的菜单，也不跳过剧情。
    public bool TryOpenPauseMenu()
    {
        if (!Context.IsWorldReady) return false;
        if (Game1.activeClickableMenu != null) return Game1.activeClickableMenu is GameMenu;
        if (Game1.eventUp || Game1.fadeToBlack || Game1.player.UsingTool || Game1.killScreen) return false;
        Game1.activeClickableMenu = new GameMenu();
        SelfPauseOpened = true;
        return true;
    }
}
