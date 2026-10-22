using Microsoft.Xna.Framework;
using System.Reflection;
using StardewValley;
using StardewValley.Menus;
using StardewValley.Objects;
using StardewValley.TerrainFeatures;
using StardewValley.Tools;
using StardewValley.Buildings;
using StardewValley.Monsters;
using StardewValley.Locations;

namespace StardewAgentBridge;

public sealed class Observations
{
    public sealed record Target(GameLocation Location, int Generation, Point Tile, object? Identity, string Kind, string? Action = null, int Option = -1);
    private readonly Dictionary<string, Target> references = new();
    private readonly Queue<List<string>> snapshots = new();
    private long sequence;
    public string InstanceId { get; } = Guid.NewGuid().ToString("N");
    public int Generation { get; private set; }
    public void Reset() { Generation++; references.Clear(); snapshots.Clear(); }
    public static object Tile(Point p) => new { x = p.X, y = p.Y };
    private static object? EquipmentItem(Item? item) => item == null ? null : new { itemId = item.QualifiedItemId, name = item.DisplayName };
    public static Point Position => Game1.player.TilePoint;
    public static bool InBounds(GameLocation location, Point p) => p.X >= 0 && p.Y >= 0 && p.X < location.Map.Layers[0].LayerWidth && p.Y < location.Map.Layers[0].LayerHeight;
    public static bool Walkable(GameLocation location, Point p)
    {
        if (!InBounds(location, p)) return false;
        var box = Game1.player.GetBoundingBox();
        box.Offset(p.X * 64 + 32 - box.Center.X, p.Y * 64 + 32 - box.Center.Y);
        // 观察和规划不能触发碰撞副作用；游戏按玩家碰撞规则判断。
        return !location.isCollidingPosition(box, Game1.viewport, true, 0, false, Game1.player, true, false, false, true);
    }
    public static object ControlState()
    {
        var reasons = new List<string>();
        if (Game1.activeClickableMenu != null) reasons.Add("menu");
        if (Game1.eventUp) reasons.Add("event");
        if (Game1.fadeToBlack) reasons.Add("transition");
        if (Game1.player.UsingTool) reasons.Add("toolAnimation");
        if (Game1.player.freezePause > 0) reasons.Add("freezePause");
        if (!Game1.player.CanMove && reasons.Count == 0) reasons.Add("playerAnimation");
        if (Game1.paused) reasons.Add("paused");
        return new {
            ready = reasons.Count == 0, blockedBy = reasons,
            eventUp = Game1.eventUp, fadeToBlack = Game1.fadeToBlack,
            usingTool = Game1.player.UsingTool, freezePause = Game1.player.freezePause,
            paused = Game1.paused, menuType = Game1.activeClickableMenu?.GetType().Name,
            currentEvent = Game1.CurrentEvent is { } ev ? new { ev.id, isFestival = ev.isFestival, isWedding = ev.isWedding, playerControl = ev.playerControlSequence } : null
        };
    }
    public Target Resolve(string reference, bool menu = false)
    {
        if (!references.TryGetValue(reference, out var target) || target.Generation != Generation || !ReferenceEquals(target.Location, Game1.currentLocation))
            throw new ActionFault("STALE_REF", "引用不属于当前场景或已过期，请重新 snapshot。");
        if (menu)
        {
            if (target.Kind != "menu" || !ReferenceEquals(target.Identity, Game1.activeClickableMenu) || target.Action != MenuSignature(Game1.activeClickableMenu)) throw new ActionFault("MENU_MISMATCH", "菜单已改变，请重新 snapshot。");
        }
        else if (target.Kind == "menu") throw new ActionFault("INVALID_ARGUMENT", "动作需要场景目标引用。");
        else if (target.Identity is NPC npc)
        {
            if (!target.Location.characters.Contains(npc)) throw new ActionFault("STALE_REF", "角色已离开当前地图。");
            target = target with { Tile = npc.TilePoint };
        }
        else if (target.Identity is FarmAnimal animal)
        {
            if (!target.Location.animals.Values.Contains(animal)) throw new ActionFault("STALE_REF", "动物已离开当前地图。");
            target = target with { Tile = animal.TilePoint };
        }
        else if (target.Identity is Furniture furniture)
        {
            if (!target.Location.furniture.Contains(furniture) || furniture.TileLocation.ToPoint() != target.Tile) throw new ActionFault("STALE_REF", "家具已移动或消失。");
        }
        else if (target.Identity is StardewValley.Object obj)
        {
            if (!target.Location.objects.TryGetValue(target.Tile.ToVector2(), out var current) || !ReferenceEquals(current, obj)) throw new ActionFault("STALE_REF", "对象已改变或消失。");
        }
        else if (target.Identity is TerrainFeature feature)
        {
            if (!target.Location.terrainFeatures.TryGetValue(target.Tile.ToVector2(), out var current) || !ReferenceEquals(current, feature)) throw new ActionFault("STALE_REF", "地形目标已消失。");
        }
        else if (target.Identity is Warp warp && !target.Location.warps.Contains(warp)) throw new ActionFault("STALE_REF", "出口已改变。");
        else if (target.Identity is Building building && (!target.Location.buildings.Contains(building) || (target.Kind == "door" ? building.getPointForHumanDoor() != target.Tile : !building.occupiesTile(target.Tile.X, target.Tile.Y)))) throw new ActionFault("STALE_REF", "建筑已移动或消失。");
        else if (target.Kind == "action" && MapAction(target.Location, target.Tile) != target.Action) throw new ActionFault("STALE_REF", "地图交互点已改变。");
        return target;
    }
    public static string MenuSignature(IClickableMenu? menu) => menu is DialogueBox dialogue
        ? dialogue.getCurrentString() + "\n" + string.Join("|", (dialogue.responses ?? Array.Empty<StardewValley.Response>()).Select(r => r.responseKey + ":" + r.responseText))
        : menu is LetterViewerMenu ? $"{menu.GetType().Name}:{ReadField(menu, "page")}:{ReadField(menu, "mailTitle")}:{string.Join('|', MenuButtons(menu).Select(b => b.Label))}"
        : menu is ItemGrabMenu grab ? $"{menu.GetType().Name}:{grab.heldItem?.QualifiedItemId}:{grab.heldItem?.Stack}:{string.Join('|', grab.ItemsToGrabMenu?.actualInventory.Select(i => i == null ? "" : $"{i.QualifiedItemId}:{i.Quality}:{i.Stack}") ?? Array.Empty<string>())}"
        : menu?.GetType().FullName ?? "";
    internal static object? ReadField(object owner, string name) => owner.GetType().GetField(name, BindingFlags.Instance | BindingFlags.Public | BindingFlags.NonPublic)?.GetValue(owner);
    public static IEnumerable<(Point Point, string Label)> MenuButtons(IClickableMenu menu)
    {
        if (menu is ShippingMenu)
        {
            if (ReadField(menu, "outro") is true) yield break;
            if (ReadField(menu, "okButton") is ClickableComponent ok) yield return (ok.bounds.Center, "确认收入结算并继续保存");
            yield break;
        }
        if (menu is LetterViewerMenu letter)
        {
            if (ReadField(letter, "itemsToGrab") is IEnumerable<ClickableComponent> items)
                foreach (var item in items.Where(i => i.visible && i.item != null)) yield return (item.bounds.Center, $"领取附件：{item.item.DisplayName} x{item.item.Stack}");
            if (letter.HasQuestOrSpecialOrder && ReadField(letter, "acceptQuestButton") is ClickableComponent accept && accept.visible) yield return (accept.bounds.Center, "接受信件任务");
            if (ReadField(letter, "forwardButton") is ClickableComponent next && next.visible) yield return (next.bounds.Center, "下一页");
            if (ReadField(letter, "backButton") is ClickableComponent back && back.visible) yield return (back.bounds.Center, "上一页");
            if (letter.upperRightCloseButton is { } close) yield return (close.bounds.Center, "关闭信件");
            yield break;
        }
        if (menu is ItemGrabMenu grab)
        {
            if (grab.heldItem != null)
            {
                // 只提供真实空格，避免自动交换或丢弃玩家已有物品。
                for (var i = 0; i < grab.inventory.inventory.Count && i < Game1.player.MaxItems; i++)
                    if (i >= grab.inventory.actualInventory.Count || grab.inventory.actualInventory[i] == null)
                    { yield return (grab.inventory.inventory[i].bounds.Center, $"放入背包：{grab.heldItem.DisplayName}"); break; }
            }
            else if (grab.ItemsToGrabMenu != null)
            {
                for (var i = 0; i < grab.ItemsToGrabMenu.actualInventory.Count && i < grab.ItemsToGrabMenu.inventory.Count; i++)
                    if (grab.ItemsToGrabMenu.actualInventory[i] is { } item && grab.ItemsToGrabMenu.inventory[i].visible)
                        yield return (grab.ItemsToGrabMenu.inventory[i].bounds.Center, $"取走物品：{item.DisplayName} x{item.Stack}");
            }
            if (grab.heldItem == null && grab.readyToClose())
            {
                var close = grab.okButton ?? grab.upperRightCloseButton;
                if (close != null) yield return (close.bounds.Center, "关闭物品菜单");
            }
            yield break;
        }
        if (menu is LevelUpMenu && menu.allClickableComponents != null)
            foreach (var button in menu.allClickableComponents.Where(c => c.visible && c.bounds.Width > 0 && c.bounds.Height > 0))
                yield return (button.bounds.Center, string.IsNullOrWhiteSpace(button.name) ? "确认升级选项" : button.name);
    }
    public static bool ReadyToHarvest(Crop crop) => !crop.dead.Value && (crop.forageCrop.Value || crop.currentPhase.Value >= crop.phaseDays.Count - 1 && (!crop.fullyGrown.Value || crop.dayOfCurrentPhase.Value <= 0));
    public static object CropState(Crop crop) => new { itemId = crop.indexOfHarvest.Value, phase = crop.currentPhase.Value, phaseCount = crop.phaseDays.Count,
        dayOfPhase = crop.dayOfCurrentPhase.Value, fullyGrown = crop.fullyGrown.Value, dead = crop.dead.Value, readyToHarvest = ReadyToHarvest(crop),
        regrows = crop.RegrowsAfterHarvest(), harvestMethod = crop.GetHarvestMethod().ToString() };
    public object Inspect(string reference)
    {
        var target = Resolve(reference);
        target.Location.terrainFeatures.TryGetValue(target.Tile.ToVector2(), out var terrain);
        target.Location.objects.TryGetValue(target.Tile.ToVector2(), out var item);
        return new { kind = "inspect", target = reference, entityKind = target.Kind, tile = Tile(target.Tile), action = target.Action,
            passable = Walkable(target.Location, target.Tile), crop = terrain is HoeDirt dirt && dirt.crop != null ? CropState(dirt.crop) : null,
            fishable = target.Location.isTileFishable(target.Tile.X, target.Tile.Y),
            tree = terrain is Tree tree ? new { health = tree.health.Value, growthStage = tree.growthStage.Value, stump = tree.stump.Value } : null,
            item = item == null ? null : new { itemId = item.QualifiedItemId, item.DisplayName, item.Stack, item.Quality, item.Category },
            building = target.Identity is Building building ? new { type = building.buildingType.Value, x = building.tileX.Value, y = building.tileY.Value, width = building.tilesWide.Value, height = building.tilesHigh.Value } : null,
            monster = target.Identity is Monster monster ? new { monster.Health, monster.MaxHealth, monster.DamageToFarmer } : null,
            world = WorldState.Inspect(target),
            control = ControlState() };
    }
    private static string? MapAction(GameLocation location, Point p)
    {
        var action = location.doesTileHaveProperty(p.X, p.Y, "Action", "Buildings") ?? location.doesTileHaveProperty(p.X, p.Y, "TouchAction", "Back");
        if (action != null) return action;
        // 矿井梯子由真实图块索引识别，游戏本身没有给这些图块写 Action 属性。
        if (location is MineShaft)
            return location.getTileIndexAt(new xTile.Dimensions.Location(p.X, p.Y), "Buildings", "mine") switch
            { 112 => "MineElevator", 115 => "MineExit", 173 => "MineDown", 174 => "MineShaft", _ => null };
        return null;
    }
    public object Snapshot(int radius = 8)
    {
        var location = Game1.currentLocation;
        var center = Position;
        var id = "s" + ++sequence;
        var keys = new List<string>();
        string Add(Target target, bool menu = false)
        {
            var reference = $"@{id}:{(menu ? "m" : "e")}{keys.Count + 1}";
            references.Add(reference, target); keys.Add(reference); return reference;
        }
        var entities = new List<object>();
        var width = location.Map.Layers[0].LayerWidth;
        var height = location.Map.Layers[0].LayerHeight;
        // 全量显示观察方框中的地块；明确范围，路径规划仍由游戏碰撞检查决定。
        for (var y = Math.Max(0, center.Y - radius); y <= Math.Min(height - 1, center.Y + radius); y++)
        for (var x = Math.Max(0, center.X - radius); x <= Math.Min(width - 1, center.X + radius); x++)
        {
            var p = new Point(x, y);
            location.terrainFeatures.TryGetValue(p.ToVector2(), out var terrain);
            location.objects.TryGetValue(p.ToVector2(), out var obj);
            var dirt = terrain as HoeDirt;
            var action = MapAction(location, p);
            var water = location.CanRefillWateringCanOnTile(x, y);
            var kind = obj != null ? "object" : action != null ? "action" : dirt != null ? "soil" : terrain != null ? "terrain" : water ? "water" : "tile";
            var name = obj?.DisplayName ?? (action != null ? action : dirt?.crop != null ? "作物" : dirt != null ? "耕地" : terrain?.GetType().Name ?? (water ? "水源" : location.doesTileHaveProperty(x, y, "Diggable", "Back") != null ? "可耕地" : "地块"));
            // 土地引用固定格子；树、杂草、石头等实体引用固定实际对象。
            object? identity = obj ?? (object?)(terrain is HoeDirt ? null : terrain);
            var reference = Add(new(location, Generation, p, identity, kind, action));
            var entity = new Dictionary<string, object?> { ["ref"] = reference, ["kind"] = kind, ["name"] = name, ["tile"] = Tile(p), ["passable"] = Walkable(location, p) };
            entity["diggable"] = obj == null && terrain == null && action == null && location.doesTileHaveProperty(x, y, "Diggable", "Back") != null;
            entity["refillable"] = water;
            if (water) entity["fishable"] = location.isTileFishable(x, y);
            entity["needsWater"] = dirt?.crop != null && !dirt.crop.dead.Value && dirt.needsWatering() && dirt.state.Value != HoeDirt.watered;
            if (dirt != null) { entity["tilled"] = true; entity["watered"] = dirt.state.Value == HoeDirt.watered; if (dirt.crop != null) { entity["crop"] = dirt.crop.indexOfHarvest.Value; entity["cropState"] = CropState(dirt.crop); entity["readyToHarvest"] = ReadyToHarvest(dirt.crop); } }
            if (obj != null) { entity["itemId"] = obj.QualifiedItemId; entity["quality"] = obj.Quality; entity["artifactSpot"] = obj.QualifiedItemId == "(O)590"; }
            if (terrain is Tree tree) entity["health"] = tree.health.Value;
            if (action != null) entity["action"] = action;
            entities.Add(entity);
        }
        bool Nearby(Point p) => Math.Abs(p.X - center.X) <= radius && Math.Abs(p.Y - center.Y) <= radius;
        foreach (var building in location.buildings)
        {
            if (building.humanDoor.Value.X < 0 || building.humanDoor.Value.Y < 0)
            {
                var tile = new Point(building.tileX.Value, building.tileY.Value);
                if (!Nearby(tile)) continue;
                var buildingReference = Add(new(location, Generation, tile, building, building is ShippingBin ? "shippingBin" : "building"));
                entities.Add(new { @ref = buildingReference, kind = building is ShippingBin ? "shippingBin" : "building", name = building.buildingType.Value, tile = Tile(tile), passable = false,
                    bounds = new { x = tile.X, y = tile.Y, width = building.tilesWide.Value, height = building.tilesHigh.Value }, action = building is ShippingBin ? "ship" : "interact" });
                continue;
            }
            var p = building.getPointForHumanDoor();
            if (!Nearby(p) || !InBounds(location, p)) continue;
            var isHome = location is Farm farm && ReferenceEquals(farm.GetMainFarmHouse(), building);
            var reference = Add(new(location, Generation, p, building, "door"));
            entities.Add(new { @ref = reference, kind = "door", name = isHome ? "农舍入口" : $"建筑入口 → {building.GetIndoorsName()}", tile = Tile(p), passable = false });
        }
        if (location is Farm mailFarm && Nearby(mailFarm.GetMainMailboxPosition()))
        {
            var tile = mailFarm.GetMainMailboxPosition();
            var reference = Add(new(location, Generation, tile, null, "mailbox", "Mailbox"));
            entities.Add(new { @ref = reference, kind = "mailbox", name = "农场信箱", tile = Tile(tile), passable = false, unread = Game1.mailbox.Count, action = "interact" });
        }
        foreach (var furniture in location.furniture.Where(f => Nearby(f.TileLocation.ToPoint())))
        {
            var p = furniture.TileLocation.ToPoint();
            var reference = Add(new(location, Generation, p, furniture, furniture is BedFurniture ? "bed" : "furniture"));
            entities.Add(new { @ref = reference, kind = furniture is BedFurniture ? "bed" : "furniture", name = furniture.DisplayName, tile = Tile(p), passable = Walkable(location, p) });
        }
        var exits = new List<object>();
        foreach (var warp in location.warps)
        {
            var p = new Point(warp.X, warp.Y);
            var reference = Add(new(location, Generation, p, warp, "exit"));
            var exit = new { @ref = reference, kind = "exit", name = $"出口 → {warp.TargetName}", tile = Tile(p), passable = true, action = "move near 引用或移动到出口格触发正常切图", destination = warp.TargetName };
            exits.Add(exit);
            if (Nearby(p)) entities.Add(exit);
        }
        foreach (var npc in location.characters.Where(n => Nearby(n.TilePoint)))
        {
            var reference = Add(new(location, Generation, npc.TilePoint, npc, "npc"));
            entities.Add(new { @ref = reference, kind = npc is Monster ? "monster" : "npc", name = npc.displayName, tile = Tile(npc.TilePoint), passable = false,
                health = npc is Monster monster ? (int?)monster.Health : null });
        }
        foreach (var animal in WorldState.Animals(location, center, radius))
        {
            var reference = Add(new(location, Generation, animal.TilePoint, animal, "animal"));
            entities.Add(new { @ref = reference, kind = "animal", name = animal.displayName, tile = Tile(animal.TilePoint), passable = false, pettedToday = animal.wasPet.Value, produce = animal.currentProduce.Value });
        }
        object? menu = null;
        if (Game1.activeClickableMenu is { } currentMenu)
        {
            var options = new List<object>();
            if (currentMenu is DialogueBox dialogue)
            {
                if (dialogue.responses is { Length: > 0 })
                    for (var i = 0; i < dialogue.responses.Length; i++) options.Add(new { @ref = Add(new(location, Generation, center, currentMenu, "menu", Action: MenuSignature(currentMenu), Option: i), true), label = dialogue.responses[i].responseText });
                else options.Add(new { @ref = Add(new(location, Generation, center, currentMenu, "menu", Action: MenuSignature(currentMenu), Option: -1), true), label = "继续" });
                menu = new { type = currentMenu.GetType().Name, text = dialogue.getCurrentString(), options };
            }
            else
            {
                foreach (var button in MenuButtons(currentMenu)) options.Add(new { @ref = Add(new(location, Generation, button.Point, currentMenu, "menu", Action: MenuSignature(currentMenu)), true), label = button.Label });
                var text = currentMenu is LetterViewerMenu && ReadField(currentMenu, "mailMessage") is IEnumerable<string> pages ? string.Join("\n", pages) : currentMenu is ShopMenu ? "可用 shop 查看货架、buy 购买、closemenu 关闭。" : "使用已观察的菜单选项，或 closemenu 正常关闭普通菜单。";
                menu = new { type = currentMenu.GetType().Name, text, options };
            }
        }
        snapshots.Enqueue(keys);
        while (snapshots.Count > 16) foreach (var key in snapshots.Dequeue()) references.Remove(key);
        var inventory = Game1.player.Items.Select((item, slot) => (item, slot)).Where(v => v.item != null).Select(v =>
        {
            var entry = new Dictionary<string, object> { ["slot"] = v.slot, ["itemId"] = v.item.QualifiedItemId, ["name"] = v.item.DisplayName, ["count"] = v.item.Stack };
            entry["category"] = v.item.Category;
            entry["quality"] = v.item.Quality;
            if (v.item is Tool tool) entry["tool"] = tool.GetType().Name;
            if (v.item is WateringCan can) { entry["water"] = can.WaterLeft; entry["waterCapacity"] = can.waterCanMax; }
            return entry;
        }).ToArray();
        return new { mode = "game", kind = "snapshot", snapshotId = id, instanceId = InstanceId, saveGeneration = Generation, location = location.NameOrUniqueName,
            date = new { season = Game1.currentSeason, day = Game1.dayOfMonth, year = Game1.year }, time = Game1.timeOfDay,
            player = new { name = Game1.player.Name, farmName = Game1.player.farmName.Value, money = Game1.player.Money,
                health = Game1.player.health, maxHealth = Game1.player.maxHealth, position = Tile(center), energy = Game1.player.Stamina,
                maxEnergy = Game1.player.MaxStamina, selectedSlot = Game1.player.CurrentToolIndex, canMove = Game1.player.CanMove, facingDirection = Game1.player.FacingDirection, maxItems = Game1.player.MaxItems },
            equipment = new { hat = EquipmentItem(Game1.player.hat.Value), boots = EquipmentItem(Game1.player.boots.Value), leftRing = EquipmentItem(Game1.player.leftRing.Value), rightRing = EquipmentItem(Game1.player.rightRing.Value), shirt = EquipmentItem(Game1.player.shirtItem.Value), pants = EquipmentItem(Game1.player.pantsItem.Value) },
            weather = new { raining = Game1.isRaining, snowing = Game1.isSnowing, outdoors = location.IsOutdoors },
            mine = location is MineShaft shaft ? new { level = shaft.mineLevel, stonesRemaining = shaft.stonesLeftOnThisLevel } : null,
            inventory, control = ControlState(), navigation = new { exits }, world = WorldState.Summary(),
            shipping = location is Farm shippingFarm ? shippingFarm.getShippingBin(Game1.player).Select(i => new { itemId = i.QualifiedItemId, count = i.Stack, quality = i.Quality }).ToArray() : null,
            observation = new { radius, center = Tile(center), truncated = center.X - radius > 0 || center.Y - radius > 0 || center.X + radius < width - 1 || center.Y + radius < height - 1, width, height }, entities, menu };
    }
    // 只读诊断：用于解释「为什么动不了 / 出口在哪」，不改变任何游戏状态。
    public object Diagnostic(int radius = 12)
    {
        var location = Game1.currentLocation;
        var player = Game1.player;
        var center = player.TilePoint;
        var distance = (Warp w) => Math.Abs(w.X - center.X) + Math.Abs(w.Y - center.Y);

        var warps = location.warps
            .OrderBy(distance).Take(24)
            .Select(w => (object)new { x = w.X, y = w.Y, target = w.TargetName, targetX = w.TargetX, targetY = w.TargetY, distance = distance(w) })
            .ToArray();

        var npcs = location.characters
            .Select(n => (object)new
            {
                name = n.Name, x = n.TilePoint.X, y = n.TilePoint.Y,
                moving = n.isMoving(), controller = n.controller?.GetType().Name,
                speed = n.Speed,
            }).ToArray();

        var obstacles = new List<object>();
        for (var dy = -2; dy <= 2; dy++)
        for (var dx = -2; dx <= 2; dx++)
        {
            var p = new Point(center.X + dx, center.Y + dy);
            if (!InBounds(location, p)) continue;
            var passable = Walkable(location, p);
            if (passable) continue;
            obstacles.Add(new
            {
                x = p.X, y = p.Y,
                @object = location.objects.TryGetValue(p.ToVector2(), out var obj) ? obj.Name : null,
                terrain = location.terrainFeatures.TryGetValue(p.ToVector2(), out var tf) ? tf.GetType().Name : null,
                action = MapAction(location, p),
                building = location.buildings.FirstOrDefault(b => b.occupiesTile(p.X, p.Y))?.buildingType.Value,
            });
        }

        return new
        {
            mode = "game", kind = "diag", instanceId = InstanceId, saveGeneration = Generation,
            location = location.NameOrUniqueName,
            mapSize = new { width = location.Map.Layers[0].LayerWidth, height = location.Map.Layers[0].LayerHeight },
            player = new
            {
                name = player.Name, x = center.X, y = center.Y,
                canMove = player.CanMove, usingTool = player.UsingTool,
                freezePause = player.freezePause, isEmoting = player.IsEmoting, currentEmote = player.CurrentEmote,
                facing = player.FacingDirection,
            },
            global = new
            {
                eventUp = Game1.eventUp, fadeToBlack = Game1.fadeToBlack,
                menu = Game1.activeClickableMenu?.GetType().Name, paused = Game1.paused, isActive = GameRunner.instance.IsActive,
                currentEvent = Game1.CurrentEvent is { } ev
                    ? new { ev.id, isFestival = ev.isFestival, isWedding = ev.isWedding, playerControl = ev.playerControlSequence }
                    : null,
            },
            warps, npcs, obstacles,
            buildingDoors = location.buildings.Select(b => (object)new { type = b.buildingType.Value, x = b.getPointForHumanDoor().X, y = b.getPointForHumanDoor().Y }).ToArray(),
        };
    }
    // 命名瞬移：用游戏自身的 warpFarmer，避免因出口格在地图外而无法通过走路触发。
    public void WarpTo(string name, int x, int y)
    {
        var location = Game1.getLocationFromName(name) ?? throw new ActionFault("NOT_FOUND", $"地图不存在：{name}");
        Game1.warpFarmer(name, x, y, Game1.player.FacingDirection);
    }
    // 只读：列出当前商店菜单的可买条目，供决策模型选择 itemId。
    public object ShopList()
    {
        if (Game1.activeClickableMenu is not ShopMenu menu) throw new ActionFault("INVALID_ARGUMENT", "当前没有打开商店菜单。");
        var items = menu.forSale.Select((item, index) =>
        {
            menu.itemPriceAndStock.TryGetValue(item, out var stock);
            return (object)new
            {
                index,
                itemId = item.QualifiedItemId,
                name = item.DisplayName,
                price = stock?.Price ?? -1,
                stock = stock?.Stock ?? -1,
            };
        }).ToArray();
        return new
        {
            mode = "game", kind = "shop",
            shopId = menu.ShopId,
            currencyId = menu.currency,
            money = Game1.player.Money,
            affordable = ShopMenu.getPlayerCurrencyAmount(Game1.player, menu.currency),
            items,
        };
    }
    public object Result(string detail, bool changed = true) => new { kind = "action", location = Game1.currentLocation.NameOrUniqueName, position = Tile(Position), changed, detail, snapshot = Snapshot() };
}

