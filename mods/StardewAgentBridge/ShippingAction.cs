using StardewValley;
using StardewValley.Buildings;

namespace StardewAgentBridge;

internal sealed class ShippingAction : IGameAction
{
    private readonly Observations observations;
    private readonly string reference;
    private readonly int slot;
    private readonly int requested;
    private bool executed;
    public ShippingAction(Request request, Observations observations)
    {
        this.observations = observations;
        reference = Protocol.Text(request.Args, "target"); slot = Protocol.Integer(request.Args, "slot"); requested = Protocol.Integer(request.Args, "count");
    }
    public object? Tick()
    {
        if (executed) throw new ActionFault("VERIFY_FAILED", "出货已执行，不能重复提交。");
        var target = observations.Resolve(reference);
        if (target.Identity is not ShippingBin bin || target.Location is not Farm farm) throw new ActionFault("INVALID_ARGUMENT", "目标必须是当前农场的真实出货箱。");
        var box = new Microsoft.Xna.Framework.Rectangle(bin.tileX.Value, bin.tileY.Value, bin.tilesWide.Value, bin.tilesHigh.Value);
        var position = Game1.player.TilePoint;
        var distance = Math.Abs(position.X - Math.Clamp(position.X, box.Left, box.Right - 1)) + Math.Abs(position.Y - Math.Clamp(position.Y, box.Top, box.Bottom - 1));
        if (distance > 1) throw new ActionFault("OUT_OF_REACH", "需要先 move near 出货箱，站在占地的上下左右相邻格。");
        if (slot < 0 || slot >= Game1.player.Items.Count || Game1.player.Items[slot] is not { } item) throw new ActionFault("NOT_FOUND", "背包槽位没有物品。");
        if (!Utility.highlightShippableObjects(item)) throw new ActionFault("INVALID_ARGUMENT", "该物品不能正常出货，未发生转移。");
        if (item.Stack < requested) throw new ActionFault("INSUFFICIENT_RESOURCE", "当前槽位数量不足，未发生转移。");
        var ship = typeof(ShippingBin).GetMethod("shipItem", System.Reflection.BindingFlags.Instance | System.Reflection.BindingFlags.Public | System.Reflection.BindingFlags.NonPublic)
            ?? throw new ActionFault("UNSUPPORTED", "当前游戏版本缺少已核验的正常出货回调。");
        var itemId = item.QualifiedItemId; var quality = item.Quality; var before = item.Stack; var money = Game1.player.Money;
        var queue = farm.getShippingBin(Game1.player);
        int Quantity() => queue.Where(i => i.QualifiedItemId == itemId && i.Quality == quality).Sum(i => i.Stack);
        var queueBefore = Quantity();
        var shipment = item;
        // 分拆实际持有的堆叠，之后走 ShippingBin 自身的正常出货回调。
        if (requested < item.Stack) { shipment = item.getOne(); shipment.Stack = requested; item.Stack -= requested; }
        executed = true;
        ship.Invoke(bin, new object[] { shipment, Game1.player });
        var after = Game1.player.Items[slot];
        var inventoryDelta = (ReferenceEquals(after, item) ? after.Stack : 0) - before;
        var queueDelta = Quantity() - queueBefore;
        if (inventoryDelta != -requested || queueDelta != requested || Game1.player.Money != money)
            throw new ActionFault("VERIFY_FAILED", $"出货核验失败：背包变化 {inventoryDelta}，队列变化 {queueDelta}；已停止，不重试。");
        return new { kind = "ship", itemId, quality, requested, shipped = queueDelta, inventoryDelta, verified = true,
            moneyBefore = money, moneyAfter = Game1.player.Money, pendingSettlement = true, detail = "物品已进入真实出货队列，收入在正常睡觉结算后到账。", snapshot = observations.Snapshot() };
    }
    public void Cancel() { }
}
