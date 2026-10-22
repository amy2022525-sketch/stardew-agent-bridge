using Microsoft.Xna.Framework;
using Microsoft.Xna.Framework.Input;
using StardewValley;
using StardewValley.Inventories;
using StardewValley.Menus;
using StardewValley.Network;
using StardewValley.Objects;
using SObject = StardewValley.Object;

namespace StardewAgentBridge;

// 所有写入由外层 ActionCoordinator 串行、防重；这里仅调用游戏的物品与菜单入口。
public static class InventoryActions
{
    public static object? Read(Request request, Observations observations)
    {
        if (request.Command == "recipes")
        {
            var recipes = Game1.player.craftingRecipes.Keys.OrderBy(k => k, StringComparer.Ordinal).Select(name => {
                var recipe = new CraftingRecipe(name, false);
                return new {
                    recipe = name, name = recipe.DisplayName,
                    output = recipe.GetItemData().QualifiedItemId, producedPerCraft = recipe.numberProducedPerCraft,
                    craftable = recipe.getCraftableCount((IList<Item>?)null),
                    ingredients = recipe.recipeList.Select(p => new { itemOrCategory = p.Key, count = p.Value, available = IngredientCount(p.Key) }).ToArray()
                };
            }).ToArray();
            return new { kind = "recipes", crafting = recipes, cookingSupported = false, detail = "仅列出角色已解锁的制作配方；材料数量只计算当前背包。" };
        }
        if (request.Command == "container" && Protocol.Text(request.Args, "operation") == "list")
        {
            var target = observations.Resolve(Protocol.Text(request.Args, "target"));
            var chest = ResolveChest(target);
            if (chest.GetMutex().IsLocked()) throw new ActionFault("BUSY", "箱子正被使用，请关闭菜单后重新观察。");
            return ChestSnapshot(chest, target.Tile);
        }
        return null;
    }

    public static IGameAction? Create(Request request, Observations observations)
    {
        switch (request.Command)
        {
            case "container":
                var operation = Protocol.Text(request.Args, "operation");
                if (operation == "list") return new Once(() => Read(request, observations)!);
                if (operation is not ("deposit" or "withdraw")) throw new ActionFault("INVALID_ARGUMENT", "operation 需要 list、deposit 或 withdraw。");
                Ready();
                return new TransferAction(request, observations);
            case "craft":
                Ready(); return new CraftAction(observations, Protocol.Text(request.Args, "recipe"), Count(request, 1));
            case "place":
                Ready(); return new Once(() => Place(request, observations));
            case "eat":
                Ready(); return new EatAction(observations, Protocol.Integer(request.Args, "slot"));
            case "equip":
                Ready(); return new Once(() => Equip(request, observations));
            default: return null;
        }
    }

    private sealed class Once : IGameAction
    {
        private readonly Func<object> run;
        public Once(Func<object> run) => this.run = run;
        public object Tick() { Ready(); return run(); }
        public void Cancel() { }
    }

    private static void Ready()
    {
        if (!Game1.player.CanMove || Game1.player.UsingTool || Game1.player.isEating || Game1.player.freezePause > 0 || Game1.activeClickableMenu != null || Game1.eventUp || Game1.fadeToBlack || Game1.paused)
            throw new ActionFault("BUSY", "菜单、剧情、过渡或角色动画尚未结束，请查看 control.blockedBy。");
    }

    private static void Reach(Point tile)
    {
        var p = Observations.Position;
        if (Math.Abs(tile.X - p.X) + Math.Abs(tile.Y - p.Y) > 1)
            throw new ActionFault("OUT_OF_REACH", "箱子或放置目标必须同格或上下左右相邻，请 move near 最新引用。");
    }

    private static int Count(Request request, int fallback)
    {
        var count = request.Args.TryGetProperty("count", out _) ? Protocol.Integer(request.Args, "count") : fallback;
        if (count < 1 || count > 999) throw new ActionFault("INVALID_ARGUMENT", "count 必须为 1–999。");
        return count;
    }

    private static Item Slot(int slot)
    {
        if (slot < 0 || slot >= Game1.player.MaxItems || slot >= Game1.player.Items.Count) throw new ActionFault("INVALID_ARGUMENT", "槽位超出当前背包范围。");
        return Game1.player.Items[slot] ?? throw new ActionFault("INVALID_ARGUMENT", "指定背包槽位为空。");
    }

    private static Chest ResolveChest(Observations.Target target)
    {
        Reach(target.Tile);
        if (target.Identity is not Chest chest || !chest.playerChest.Value || chest.giftbox.Value || chest.SpecialChestType is not (Chest.SpecialChestTypes.None or Chest.SpecialChestTypes.BigChest))
            throw new ActionFault("UNSUPPORTED", "此入口只支持已放置的普通玩家箱子；特殊共享箱、礼物箱和迷你出货箱需要各自规则。");
        return chest;
    }

    private static object Describe(Item item, int slot) => new { slot, itemId = item.QualifiedItemId, name = item.DisplayName, count = item.Stack, quality = item.Quality };

    private static object ChestSnapshot(Chest chest, Point tile) => new {
        kind = "container", tile = Observations.Tile(tile), capacity = chest.GetActualCapacity(),
        items = chest.GetItemsForPlayer().Select((item, slot) => item == null ? null : Describe(item, slot)).Where(i => i != null).ToArray()
    };

    private static int Amount(IEnumerable<Item> items, Item exemplar) => items.Where(i => i != null && i.QualifiedItemId == exemplar.QualifiedItemId && i.Quality == exemplar.Quality).Sum(i => i.Stack);

    // 与 CraftingRecipe 的原生校验一致，支持类别、齐钻和季节野种规则。
#pragma warning disable CS0618
    private static int IngredientCount(string itemOrCategory) => Game1.player.getItemCount(itemOrCategory);
#pragma warning restore CS0618

    // couldInventoryAcceptThisItem 可能只代表还能接收一部分；这里核对整个请求数量的空间。
    private static int Space(IList<Item> items, int capacity, Item item)
    {
        var stack = Math.Max(1, item.maximumStackSize());
        long available = (long)Math.Max(0, capacity - items.Count) * stack;
        foreach (var current in items)
            available += current == null ? stack : current.canStackWith(item) ? Math.Max(0, stack - current.Stack) : 0;
        return (int)Math.Min(int.MaxValue, available);
    }

    // closemenu 的恢复入口：只处理真实制作菜单持物，不生成产物、不放弃余量。
    public static void DepositCraftedHeld(CraftingPage menu)
    {
        if (menu.heldItem == null) return;
        var held = menu.heldItem;
        if (Space(Game1.player.Items, Game1.player.MaxItems, held) < held.Stack)
            throw new ActionFault("INVENTORY_FULL", "制作菜单手持产物尚无足够背包空间，请先在游戏界面腾出空间；产物仍保留在手上。");
        if (!Game1.player.addItemToInventoryBool(held))
            throw new ActionFault("VERIFY_FAILED", "制作产物尚未完整入包，保留手持余量，不能强关菜单。");
        menu.heldItem = null;
    }

    private sealed class TransferAction : IGameAction
    {
        private readonly Request request;
        private readonly Observations observations;
        private readonly string reference, operation;
        private readonly Chest chest;
        private readonly NetMutex mutex;
        private bool requested, acquired, denied, cancelled;
        public TransferAction(Request request, Observations observations)
        {
            this.request = request; this.observations = observations;
            reference = Protocol.Text(request.Args, "target"); operation = Protocol.Text(request.Args, "operation");
            chest = ResolveChest(observations.Resolve(reference)); mutex = chest.GetMutex();
            if (mutex.IsLocked()) throw new ActionFault("BUSY", "箱子已被占用，请先关闭箱子菜单。");
        }
        public object? Tick()
        {
            Ready();
            var target = observations.Resolve(reference);
            if (!ReferenceEquals(chest, ResolveChest(target))) throw new ActionFault("STALE_REF", "箱子目标已变化。");
            if (!requested)
            {
                requested = true;
                mutex.RequestLock(() => { if (cancelled) mutex.ReleaseLock(); else acquired = true; }, () => denied = true);
            }
            if (denied) throw new ActionFault("BUSY", "未能获得箱子使用锁，请重新观察。");
            if (!acquired) return null;
            if (!mutex.IsLockHeld()) throw new ActionFault("BUSY", "箱子使用锁已失效。");
            var items = chest.GetItemsForPlayer();
            var slot = Protocol.Integer(request.Args, "slot");
            IList<Item> source = operation == "deposit" ? Game1.player.Items : items;
            if (slot < 0 || slot >= source.Count || source[slot] == null) throw new ActionFault("INVALID_ARGUMENT", "来源槽位不存在或为空；withdraw 槽位来自最新 container list。");
            var original = source[slot];
            var count = Count(request, original.Stack);
            if (count > original.Stack) throw new ActionFault("INVALID_ARGUMENT", "请求数量大于来源槽位的实际数量。");
            IList<Item> destination = operation == "deposit" ? items : Game1.player.Items;
            var capacity = operation == "deposit" ? chest.GetActualCapacity() : Game1.player.MaxItems;
            if (Space(destination, capacity, original) < count) throw new ActionFault("INVENTORY_FULL", "目标空间不足以接收全部数量；未移动物品。");
            var beforeInventory = Amount(Game1.player.Items, original);
            var beforeChest = Amount(items, original);
            var delivery = count == original.Stack ? original : original.getOne();
            if (count == original.Stack) source[slot] = null!;
            else { delivery.Stack = count; source[slot] = original.ConsumeStack(count)!; }
            var remainder = operation == "deposit" ? chest.addItem(delivery) : Game1.player.addItemToInventory(delivery);
            // 正常 API 返回未接收的余量，恢复原来源槽位，不复制、不丢到地上。
            var remaining = remainder?.Stack ?? 0;
            if (remaining > 0)
            {
                if (source[slot] == null) source[slot] = remainder!;
                else source[slot].Stack += remaining;
            }
            var afterInventory = Amount(Game1.player.Items, delivery);
            var afterChest = Amount(items, delivery);
            var moved = count - remaining;
            if (beforeInventory + beforeChest != afterInventory + afterChest || moved != count)
                throw new ActionFault("VERIFY_FAILED", "箱子转移数量未与请求完全一致，已停止；请重新检查背包和箱子，不要重放写入。");
            return new {
                kind = "container", operation, itemId = delivery.QualifiedItemId, moved, verified = true,
                inventoryBefore = beforeInventory, inventoryAfter = afterInventory,
                containerBefore = beforeChest, containerAfter = afterChest,
                container = ChestSnapshot(chest, target.Tile), snapshot = observations.Snapshot(5)
            };
        }
        public void Cancel() { cancelled = true; if (acquired && mutex.IsLockHeld()) { mutex.ReleaseLock(); acquired = false; } }
    }

    private sealed class CraftAction : IGameAction
    {
        private readonly Observations observations;
        private readonly string recipeName;
        private readonly int requested;
        private CraftingPage? menu;
        private CraftingRecipe? recipe;
        private ClickableTextureComponent? button;
        private int completed, produced, ticks;
        public CraftAction(Observations observations, string name, int count)
        {
            this.observations = observations; recipeName = name; requested = count;
            if (!Game1.player.craftingRecipes.ContainsKey(name)) throw new ActionFault("INVALID_ARGUMENT", "角色尚未解锁此制作配方；请先读取 recipes。");
            if (count < 1 || count > 999) throw new ActionFault("INVALID_ARGUMENT", "count 必须为 1–999 次制作。");
        }
        public object? Tick()
        {
            if (menu == null)
            {
                Ready();
                menu = new CraftingPage(0, 0, 800, 600, false, true, null);
                for (var page = 0; page < menu.pagesOfCraftingRecipes.Count; page++)
                {
                    var match = menu.pagesOfCraftingRecipes[page].FirstOrDefault(p => p.Value.name == recipeName);
                    if (match.Key == null) continue;
                    menu.currentCraftingPage = page; button = match.Key; recipe = match.Value; break;
                }
                if (button == null || recipe == null) throw new ActionFault("UNSUPPORTED", "该配方未出现在游戏制作菜单中。");
                Game1.activeClickableMenu = menu;
            }
            if (!ReferenceEquals(menu, Game1.activeClickableMenu)) throw new ActionFault("MENU_MISMATCH", "制作菜单已被改变，请重新观察。");
            if (Game1.oldKBState.IsKeyDown(Keys.LeftShift) || Game1.oldKBState.IsKeyDown(Keys.RightShift)) throw new ActionFault("BUSY", "请释放 Shift，防止普通制作点击变成批量制作。");
            if (menu.heldItem != null) throw new ActionFault("BUSY", "制作菜单仍有手持物品，请先完成入包。");
            if (++ticks % 3 != 0) return null;
            if (!recipe!.doesFarmerHaveIngredientsInInventory(null)) return Finish("材料不足，停止后续制作。");
            var preview = recipe.createItem();
            if (Space(Game1.player.Items, Game1.player.MaxItems, preview) < preview.Stack) return Finish("背包空间不足，停止后续制作。");
            var beforeCrafted = Game1.player.craftingRecipes[recipeName];
            var amount = preview.Stack;
            var beforeInventory = Amount(Game1.player.Items, preview);
            menu.receiveLeftClick(button!.bounds.Center.X, button.bounds.Center.Y);
            // 原生点击负责消耗材料、生成物品、制作统计、任务和成就；只将实际手持产物入包。
            var held = menu.heldItem;
            var actual = Game1.player.craftingRecipes[recipeName] - beforeCrafted;
            if (actual != amount || held != null && (held.QualifiedItemId != preview.QualifiedItemId || held.Stack != amount))
                throw new ActionFault("VERIFY_FAILED", "原生制作产物或统计不符合预期，已停止；请检查菜单手持物品。");
            if (held != null)
            {
                if (!Game1.player.addItemToInventoryBool(held)) throw new ActionFault("VERIFY_FAILED", "产物未能完整入包，已保留菜单手持物品。");
                menu.heldItem = null;
            }
            // 开启手柄控制时原生菜单会自动入包，此时 heldItem 已为空。
            if (Amount(Game1.player.Items, preview) - beforeInventory != amount)
                throw new ActionFault("VERIFY_FAILED", "实际入包数量与产物不一致，已停止；请核对背包与制作材料。");
            completed++; produced += amount;
            return completed == requested ? Finish("制作完成，产物已入包。") : null;
        }
        private object Finish(string detail)
        {
            if (completed == 0) throw new ActionFault(recipe!.doesFarmerHaveIngredientsInInventory(null) ? "INVENTORY_FULL" : "MISSING_INGREDIENTS", detail);
            if (menu!.readyToClose()) menu.exitThisMenu();
            return new { kind = "craft", recipe = recipeName, requested, completed, produced, partial = completed < requested, detail, snapshot = observations.Snapshot(5) };
        }
        public void Cancel()
        {
            // 被中止时保留一切实际产物；有手持物品时不强关菜单，避免丢失。
            if (menu != null && ReferenceEquals(menu, Game1.activeClickableMenu) && menu.heldItem == null && menu.readyToClose()) menu.exitThisMenu();
        }
    }

    private static object Place(Request request, Observations observations)
    {
        var target = observations.Resolve(Protocol.Text(request.Args, "target"));
        Reach(target.Tile);
        var slot = Protocol.Integer(request.Args, "slot");
        if (Slot(slot) is not SObject item || item is Furniture || item is Wallpaper || !item.isPlaceable())
            throw new ActionFault("UNSUPPORTED", "此入口只放置普通物件、箱子、机器、路径等；家具与墙纸有单独持物规则。");
        var location = Game1.currentLocation;
        var x = target.Tile.X * 64 + 32; var y = target.Tile.Y * 64 + 32;
        if (!Utility.playerCanPlaceItemHere(location, item, x, y, Game1.player)) throw new ActionFault("CANNOT_PLACE", "游戏规则不允许在该格放置：请检查距离、占用、场景和物品类型。");
        var before = Amount(Game1.player.Items, item);
        Game1.player.CurrentToolIndex = slot;
        var accepted = Utility.tryToPlaceItem(location, item, x, y);
        var after = Amount(Game1.player.Items, item);
        if (!accepted || before - after != 1) throw new ActionFault("VERIFY_FAILED", "摆放未得到正常的一件物品消耗回执；请重新 snapshot 检查该格，勿重放请求。");
        return new { kind = "place", itemId = item.QualifiedItemId, consumed = 1, tile = Observations.Tile(target.Tile), snapshot = observations.Snapshot(5) };
    }

    private sealed class EatAction : IGameAction
    {
        private readonly Observations observations;
        private readonly int slot;
        private SObject? item;
        private float stamina;
        private int health, ticks;
        public EatAction(Observations observations, int slot) { this.observations = observations; this.slot = slot; }
        public object? Tick()
        {
            if (item == null)
            {
                Ready();
                if (Slot(slot) is not SObject food || food.Edibility == SObject.inedible) throw new ActionFault("INVALID_ARGUMENT", "指定槽位不是可食用物品。");
                item = food; stamina = Game1.player.Stamina; health = Game1.player.health;
                var before = Amount(Game1.player.Items, item);
                Game1.player.CurrentToolIndex = slot;
                Game1.player.eatObject(item, false);
                if (!Game1.player.isEating) throw new ActionFault("NO_CHANGE", "游戏未开始进食，未消耗物品。");
                Game1.player.reduceActiveItemByOne();
                if (before - Amount(Game1.player.Items, item) != 1) throw new ActionFault("VERIFY_FAILED", "食用数量未准确减少一件，请检查当前背包。");
                return null;
            }
            if (++ticks < 2 || Game1.player.isEating || !Game1.player.CanMove || Game1.player.freezePause > 0) return null;
            return new { kind = "eat", itemId = item.QualifiedItemId, consumed = 1, staminaChange = Game1.player.Stamina - stamina, healthChange = Game1.player.health - health, snapshot = observations.Snapshot(5) };
        }
        // 食物已经由游戏消耗后，不通过取消恢复、重播或跳过进食动画。
        public void Cancel() { }
    }

    private static object Equip(Request request, Observations observations)
    {
        var kind = Protocol.Text(request.Args, "kind");
        var operation = request.Args.TryGetProperty("operation", out _) ? Protocol.Text(request.Args, "operation") : "equip";
        if (operation is not ("equip" or "unequip")) throw new ActionFault("INVALID_ARGUMENT", "operation 需要 equip 或 unequip。");
        var slot = Protocol.Integer(request.Args, "slot");
        if (slot < 0 || slot >= Game1.player.MaxItems || slot >= Game1.player.Items.Count) throw new ActionFault("INVALID_ARGUMENT", "槽位超出当前背包范围。");
        var item = operation == "equip" ? Slot(slot) : null;
        if (operation == "unequip" && Game1.player.Items[slot] != null) throw new ActionFault("INVENTORY_FULL", "卸下装备需要指定一个空背包槽位。");
        bool Compatible() => kind switch {
            "hat" => item is Hat, "boots" => item is Boots, "leftRing" or "rightRing" => item is Ring,
            "pants" => item is Clothing pants && pants.clothesType.Value == Clothing.ClothesType.PANTS,
            "shirt" => item is Clothing shirt && shirt.clothesType.Value == Clothing.ClothesType.SHIRT,
            _ => false
        };
        if (operation == "equip" && (!Compatible() || item!.Stack != 1)) throw new ActionFault("INVALID_ARGUMENT", "物品不符合指定装备栏类型，或数量不是一件。");
        // 与原生 InventoryPage 使用同一 Equip API，触发装备/卸装增益和外观回调。
        Item? previous = kind switch {
            "hat" => Game1.player.Equip(item as Hat, Game1.player.hat),
            "boots" => Game1.player.Equip(item as Boots, Game1.player.boots),
            "leftRing" => Game1.player.Equip(item as Ring, Game1.player.leftRing),
            "rightRing" => Game1.player.Equip(item as Ring, Game1.player.rightRing),
            "pants" => Game1.player.Equip(item as Clothing, Game1.player.pantsItem),
            "shirt" => Game1.player.Equip(item as Clothing, Game1.player.shirtItem),
            _ => throw new ActionFault("INVALID_ARGUMENT", "kind 需要 hat、boots、leftRing、rightRing、pants 或 shirt。")
        };
        Game1.player.Items[slot] = previous;
        return new { kind = "equip", equipmentSlot = kind, operation, equippedItem = item?.QualifiedItemId, returnedItem = previous?.QualifiedItemId, inventorySlot = slot, changed = item != previous, snapshot = observations.Snapshot(5) };
    }
}
