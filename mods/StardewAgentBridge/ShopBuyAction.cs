using Microsoft.Xna.Framework.Input;
using StardewValley;
using StardewValley.Menus;

namespace StardewAgentBridge;

// 每件走一次真实商店点击，购买物先入包，再核对扣款和数量。
// 私有 tryToPurchaseItem 的 bool 表示售罄，而非成交；不得用它做重试依据。
public sealed class ShopBuyAction : IGameAction
{
    private readonly Observations observations;
    private readonly ShopMenu menu;
    private readonly string itemId;
    private readonly int requested;
    private readonly int moneyBefore;
    private readonly int quantityBefore;
    private int bought;
    private int ticks;
    public ShopBuyAction(Observations observations, string itemId, int count)
    {
        this.observations = observations; this.itemId = itemId; requested = count;
        menu = Game1.activeClickableMenu as ShopMenu ?? throw new ActionFault("MENU_MISMATCH", "需要先在营业时从柜台南侧打开商店，再 shop 查看货架。");
        if (Game1.eventUp) throw new ActionFault("BUSY", "剧情未结束，请先处理当前对话。");
        if (menu.currency != 0) throw new ActionFault("UNSUPPORTED", "当前仅验证普通金钱购买，不支持兑换货币商店。");
        if (Game1.oldKBState.IsKeyDown(Keys.LeftShift) || Game1.oldKBState.IsKeyDown(Keys.RightShift)) throw new ActionFault("BUSY", "请松开 Shift，避免游戏把单件点击变成批量购买。");
        if (menu.heldItem != null) throw new ActionFault("BUSY", "商店已有手持物品，请先 closemenu 安全入包，或由用户处理。");
        var item = Find() ?? throw new ActionFault("NOT_FOUND", "货架没有此 itemId，请先 shop 查看。");
        if (item.IsRecipe || item is not Item) throw new ActionFault("UNSUPPORTED", "当前购买只覆盖可入包的普通物品，不支持配方/即时服务。");
        if (!menu.itemPriceAndStock.TryGetValue(item, out var stock) || stock.TradeItem != null) throw new ActionFault("UNSUPPORTED", "此条目没有普通金钱报价，或需要兑换物。");
        moneyBefore = Game1.player.Money; quantityBefore = Quantity();
    }
    private ISalable? Find() => menu.forSale.FirstOrDefault(item => item.QualifiedItemId == itemId);
    private int Quantity() => Game1.player.Items.Where(item => item?.QualifiedItemId == itemId).Sum(item => item!.Stack);
    public static void DepositHeld(ShopMenu menu)
    {
        if (menu.heldItem == null) return;
        if (menu.heldItem is not Item item || !Game1.player.couldInventoryAcceptThisItem(item)) throw new ActionFault("INSUFFICIENT_RESOURCE", "背包不能接纳手持物品；物品仍保留在商店手上，未丢弃。");
        if (!Game1.player.addItemToInventoryBool(item)) throw new ActionFault("INSUFFICIENT_RESOURCE", "物品未完全入包，已停止；请用户处理商店手持物品。");
        menu.heldItem = null;
    }
    private object Finish(string? note = null) => new {
        mode = "game", kind = "buy", itemId, requested, bought,
        moneyBefore, moneyAfter = Game1.player.Money, spent = moneyBefore - Game1.player.Money,
        inventoryDelta = Quantity() - quantityBefore, verified = Quantity() - quantityBefore == bought,
        note, snapshot = observations.Snapshot()
    };
    public object? Tick()
    {
        if (++ticks < 35) return null; // 正常菜单防误触计时，不绕过它。
        if (!ReferenceEquals(Game1.activeClickableMenu, menu)) throw new ActionFault("MENU_MISMATCH", "购买中商店被关闭或替换，已停止。");
        if (bought == requested) return Finish();
        var item = Find();
        string? reason = null;
        if (item == null || !menu.itemPriceAndStock.TryGetValue(item, out var stock) || stock.Stock == 0) reason = "售罄";
        else if (stock.Price < 0 || stock.TradeItem != null) reason = "报价变化";
        else if (Game1.player.Money < stock.Price) reason = "金钱不足";
        if (reason != null) {
            if (bought > 0) return Finish(reason);
            throw new ActionFault("INSUFFICIENT_RESOURCE", reason);
        }
        var price = menu.itemPriceAndStock[item!].Price;
        var probe = item!.GetSalableInstance() as Item;
        if (probe == null) throw new ActionFault("UNSUPPORTED", "物品不支持入包。");
        probe.Stack = 1;
        if (!Game1.player.couldInventoryAcceptThisItem(probe)) {
            if (bought > 0) return Finish("背包已满");
            throw new ActionFault("INSUFFICIENT_RESOURCE", "背包已满，购买未发生。");
        }
        if (Game1.oldKBState.IsKeyDown(Keys.LeftShift) || Game1.oldKBState.IsKeyDown(Keys.RightShift)) throw new ActionFault("BUSY", "购买期间检测到 Shift，已停止。");
        var index = menu.forSale.IndexOf(item);
        menu.currentItemIndex = Math.Clamp(index, 0, Math.Max(0, menu.forSale.Count - menu.forSaleButtons.Count));
        var button = menu.forSaleButtons[index - menu.currentItemIndex];
        var beforeMoney = Game1.player.Money; var beforeQuantity = Quantity();
        menu.receiveLeftClick(button.bounds.Center.X, button.bounds.Center.Y);
        // 正常 UI 先拿在手上；使用与游戏自动入包一致的 Farmer 入口。
        if (menu.heldItem != null) {
            if (menu.heldItem.QualifiedItemId != itemId) throw new ActionFault("VERIFY_FAILED", "购买产生不同物品，保留手持物品并停止。");
            DepositHeld(menu);
        }
        var delta = Quantity() - beforeQuantity; var spent = beforeMoney - Game1.player.Money;
        if (delta != 1 || spent != price) throw new ActionFault("VERIFY_FAILED", $"购买核验失败：实际入包 {delta}，扣款 {spent}，预期 1 件/{price} 金。已停止，不重试，请查看新快照。");
        bought++; ticks = 30; // 下一次单件点击间隔至少五帧。
        return null;
    }
    public void Cancel() { /* 不回滚或重放已经成交的正常购买。 */ }
}
