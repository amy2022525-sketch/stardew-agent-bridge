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
    private GameMenu? ownedPauseMenu;
    private readonly Func<DateTime> now;
    public bool SelfPauseOpened => ownedPauseMenu != null && ReferenceEquals(Game1.activeClickableMenu, ownedPauseMenu);
    public string Mode { get; private set; } = "step";

    public ControlAuthority(Func<DateTime>? now = null) => this.now = now ?? (() => DateTime.UtcNow);

    public bool LeaseValid => HolderName != null && ExpiresAt.HasValue && ExpiresAt.Value > now();

    public void Acquire(string holder, DateTime expiresAt, string mode = "step")
    {
        if (LeaseValid) throw new ActionFault("CONTROL_BUSY", "已有控制者，必须先释放或由玩家接管。");
        ValidateExpiry(expiresAt);
        if (mode is not ("step" or "realtime")) throw new ActionFault("INVALID_ARGUMENT", "mode 必须为 step 或 realtime。");
        Epoch++;
        HolderName = holder;
        ExpiresAt = expiresAt;
        Mode = mode;
    }

    public void Renew(int epoch, DateTime expiresAt)
    {
        AuthorizeWrite(epoch);
        ValidateExpiry(expiresAt);
        ExpiresAt = expiresAt;
    }

    public void Release(bool pause)
    {
        Takeover();
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
        if (!LeaseValid) throw new ActionFault("CONTROL_EXPIRED", "控制权已释放或租约到期，请重新获取控制权。");
    }

    private void ValidateExpiry(DateTime expiresAt)
    {
        if (expiresAt <= now() || expiresAt > now().AddHours(1))
            throw new ActionFault("INVALID_ARGUMENT", "租约必须位于当前时间之后且不超过一小时。");
    }

    public void ResumeOwnPause(string command)
    {
        if (!SelfPauseOpened || command is "pause" or "closemenu") return;
        if (!ownedPauseMenu!.readyToClose()) throw new ActionFault("BUSY", "暂停菜单尚不能关闭。");
        ownedPauseMenu.exitThisMenu();
        ownedPauseMenu = null;
    }

    public static object PauseState(bool selfOpened)
    {
        var menu = Game1.activeClickableMenu;
        var state = Context.IsMultiplayer ? "unknown" : !Game1.shouldTimePass() ? "paused" : "running";
        if (menu == null && (Game1.eventUp || Game1.fadeToBlack)) state = "blocked";
        return new
        {
            state,
            menuType = menu?.GetType().Name,
            selfOpened = menu != null && selfOpened,
            scope = Context.IsMultiplayer ? "actor_only" : "world",
            worldContinues = Context.IsMultiplayer ? (bool?)null : state != "paused"
        };
    }

    // 只在安全条件下打开正常暂停菜单；绝不关闭玩家自己打开的菜单，也不跳过剧情。
    public bool TryOpenPauseMenu()
    {
        if (!Context.IsWorldReady || Context.IsMultiplayer) return false;
        if (Game1.activeClickableMenu != null) return Game1.activeClickableMenu is GameMenu;
        if (Game1.eventUp || Game1.fadeToBlack || Game1.player.UsingTool || Game1.killScreen) return false;
        ownedPauseMenu = new GameMenu();
        Game1.activeClickableMenu = ownedPauseMenu;
        return true;
    }
}
