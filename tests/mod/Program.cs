using System.Text.Json;
using StardewAgentBridge;
using StardewValley;
using StardewValley.Menus;

var passed = 0;
void Check(bool result, string message)
{
    if (!result) throw new Exception(message);
    passed++;
    Console.WriteLine($"PASS {message}");
}
void Reject(Action action, string code, string message)
{
    try { action(); }
    catch (ActionFault error) when (error.Code == code) { Check(true, message); return; }
    throw new Exception(message);
}

var now = DateTime.UtcNow;
var control = new ControlAuthority(() => now);
Reject(() => control.AuthorizeWrite(control.Epoch), "CONTROL_EXPIRED", "无持有者不能仅凭当前 epoch 写入");
control.Acquire("first", now.AddMinutes(3));
var oldEpoch = control.Epoch;
Reject(() => control.Acquire("second", now.AddMinutes(3)), "CONTROL_BUSY", "Mod 本身拒绝已有租约时再次 acquire");
control.AuthorizeWrite(oldEpoch);
control.Release(false);
Check(control.Epoch > oldEpoch, "正常 release 也撤销旧代次");
Reject(() => control.AuthorizeWrite(oldEpoch), "CONTROL_EXPIRED", "release 后迟到请求失效");
control.Acquire("third", now.AddSeconds(2));
oldEpoch = control.Epoch;
now = now.AddSeconds(3);
Reject(() => control.AuthorizeWrite(oldEpoch), "CONTROL_EXPIRED", "Bridge 仍连接时 Mod 也独立拒绝过期写入");
Reject(() => control.Renew(oldEpoch, now.AddMinutes(3)), "CONTROL_EXPIRED", "过期 renew 不能复活旧租约");
control.Acquire("next", now.AddMinutes(3), "realtime");
Check(control.Mode == "realtime", "实时模式传递到游戏侧");

Game1.activeClickableMenu = null;
Check(control.TryOpenPauseMenu() && control.SelfPauseOpened, "记录实际由控制器创建的暂停菜单对象");
control.ResumeOwnPause("move");
Check(Game1.activeClickableMenu == null, "下一段动作可以正常退出自身暂停菜单");
control.TryOpenPauseMenu();
var userMenu = new GameMenu();
Game1.activeClickableMenu = userMenu;
control.ResumeOwnPause("move");
Check(ReferenceEquals(Game1.activeClickableMenu, userMenu) && !control.SelfPauseOpened, "旧标记不能误关玩家后来打开的菜单");

Game1.activeClickableMenu = null;
var started = 0;
var cancelled = 0;
Response? receipt = null;
var coordinator = new ActionCoordinator(control, response => response);
var request = new Request("r1", "select", JsonSerializer.SerializeToElement(new { slot = 0 }), ActionId: "action-1", Epoch: control.Epoch);
coordinator.Start(request, new object(), DateTime.UtcNow.AddSeconds(1), () => { started++; return new Hanging(() => cancelled++); }, response => receipt = response);
coordinator.StopIfOwned("wrong-id");
Check(coordinator.ActiveId == "action-1", "迟到或其他动作 ID 的取消不能停止当前动作");
coordinator.StopIfOwned("action-1");
Check(cancelled == 1 && receipt?.Status == "unknown" && receipt.Error?.EffectKnown == false, "停止动作释放输入且不把未知副作用写为已知成功");
Check(receipt!.ElapsedMs >= 0, "动作耗时不能是截止时间相减得到的负数");
coordinator.Start(request with { RequestId = "r2" }, new object(), DateTime.UtcNow.AddSeconds(1), () => { started++; return new Hanging(() => cancelled++); }, response => receipt = response);
Check(started == 1, "相同逻辑动作停止后仍不能再次创建消费动作");
coordinator.Start(request with { RequestId = "r3", ActionId = "partial-fault" }, new object(), DateTime.UtcNow.AddSeconds(1), () => new Throwing(), response => receipt = response);
coordinator.Tick(DateTime.UtcNow, _ => false);
Check(receipt?.Status == "unknown" && receipt.Error?.EffectKnown == false, "运行中的消费动作报错不能证明之前没有生效");
Protocol.Validate(new Request("read-container", "container", JsonSerializer.SerializeToElement(new { target = "@s1:e1", operation = "list" })));
Check(true, "箱子 list 与其他只读查询一样不要求写动作 ID");
Reject(() => Protocol.Validate(new Request("write-container", "container", JsonSerializer.SerializeToElement(new { target = "@s1:e1", operation = "deposit", slot = 0, count = 1 }))), "INVALID_ARGUMENT", "箱子 deposit 仍必须提供写动作 ID");
Console.WriteLine($"{passed} checks passed; isolated controller tests only.");

sealed class Hanging(Action cancel) : IGameAction
{
    public object? Tick() => null;
    public void Cancel() => cancel();
}

sealed class Throwing : IGameAction
{
    public object? Tick() => throw new ActionFault("MENU_MISMATCH", "menu changed after an earlier purchase");
    public void Cancel() { }
}
