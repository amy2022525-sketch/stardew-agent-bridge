using StardewValley;

namespace StardewAgentBridge;

// 等待只发生在动作开始前，同一 actionId 内最多创建一次实际动作。
internal sealed class ReadyAction : IGameAction
{
    private readonly Func<IGameAction> create;
    private readonly GameLocation location = Game1.currentLocation;
    private readonly DateTime deadline = DateTime.UtcNow.AddMilliseconds(2000);
    private IGameAction? action;
    public ReadyAction(Func<IGameAction> create) => this.create = create;
    public object? Tick()
    {
        if (action != null) return action.Tick();
        if (!ReferenceEquals(location, Game1.currentLocation)) throw new ActionFault("STALE_REF", "等待就绪时场景改变，请重新观察。");
        if (Game1.activeClickableMenu != null || Game1.eventUp || Game1.paused)
            throw new ActionFault("BUSY", "当前菜单、剧情或暂停需要先处理；不会重复执行写动作。");
        if (!Game1.player.CanMove || Game1.player.UsingTool || Game1.player.freezePause > 0 || Game1.fadeToBlack)
        {
            if (DateTime.UtcNow >= deadline) throw new ActionFault("BUSY", "已等待角色动画 2000 毫秒仍未就绪，请查看回执 control；未开始实际操作。");
            return null;
        }
        action = create();
        return action.Tick();
    }
    public void Cancel() => action?.Cancel();
}
