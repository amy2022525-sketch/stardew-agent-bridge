using Microsoft.Xna.Framework;
using StardewModdingAPI;
using StardewValley;
using StardewValley.Menus;
using StardewValley.Objects;
using StardewValley.TerrainFeatures;
using StardewValley.Tools;
using StardewValley.Util;

namespace StardewAgentBridge;

public static class GameActions
{
    private sealed class Immediate : IGameAction
    {
        private readonly Func<object> result;
        public Immediate(Func<object> result) => this.result = result;
        public object Tick() => result();
        public void Cancel() { }
    }
    public static IGameAction Create(Request request, Observations observations, IReflectionHelper reflection, ControlAuthority control)
    {
        if (request.Command == "pause") return new Immediate(() => {
            if (!control.TryOpenPauseMenu()) throw new ActionFault("PAUSE_BLOCKED", "当前无法打开正常暂停菜单。");
            return observations.Result("已通过正常游戏菜单尝试暂停。");
        });
        return request.Command is "menu" or "buy" or "wait" or "pause" or "closemenu" or "fish"
            ? CreateNow(request, observations, reflection)
            : new ReadyAction(() => CreateNow(request, observations, reflection));
    }
    private static IGameAction CreateNow(Request request, Observations observations, IReflectionHelper reflection)
    {
        if (request.Command == "menu")
        {
            if (request.Args.TryGetProperty("operation", out var operation) && operation.GetString() == "open_inventory") return new Immediate(() => {
                if (Game1.activeClickableMenu != null) throw new ActionFault("ACTION_BUSY", "已有菜单，请先处理当前菜单。");
                Game1.activeClickableMenu = new GameMenu(); return observations.Result("已正常打开自己的背包菜单。", false);
            });
            return new MenuAction(observations, observations.Resolve(Protocol.Text(request.Args, "target"), true));
        }
        if (request.Command == "buy") return new ShopBuyAction(observations, Protocol.Text(request.Args, "itemId"), Protocol.Integer(request.Args, "count"));
        if (request.Command == "wait") return new WaitAction(observations, Protocol.Integer(request.Args, "milliseconds"));
        if (request.Command == "fish") return RealtimeActions.Create(request, observations) ?? throw new ActionFault("UNSUPPORTED", "钓鱼动作未实现。");
        if (request.Command == "closemenu") return new Immediate(() => {
            var menu = Game1.activeClickableMenu;
            if (menu == null) return observations.Result("当前没有菜单。", false);
            if (menu is not GameMenu && menu is not ShopMenu && menu is not LetterViewerMenu && menu is not ItemGrabMenu && menu is not CraftingPage) throw new ActionFault("UNSUPPORTED", "该菜单需通过 snapshot 给出的真实选项推进。");
            if (menu is CraftingPage crafting) InventoryActions.DepositCraftedHeld(crafting);
            if (!menu.readyToClose()) throw new ActionFault("BUSY", "菜单尚不能关闭，请等待动画；不会丢弃手持物品。");
            if (menu is ShopMenu shop) ShopBuyAction.DepositHeld(shop);
            if (menu is LetterViewerMenu letter && letter.itemsLeftToGrab()) throw new ActionFault("INSUFFICIENT_RESOURCE", "信件还有附件，请使用 menu 正常领取，避免遗漏。");
            menu.exitThisMenu();
            return observations.Result("已通过游戏菜单的正常关闭入口退出。");
        });
        if (request.Command == "pause") return new Immediate(() => {
            if (Game1.activeClickableMenu is GameMenu or ShopMenu) return observations.Result("已有正常暂停菜单，游戏保持暂停。", false);
            if (Game1.activeClickableMenu != null) throw new ActionFault("BUSY", "当前是剧情、信件、结算或小游戏菜单，请先处理它，再确认正常暂停。");
            if (Game1.eventUp || Game1.fadeToBlack || Game1.player.UsingTool) throw new ActionFault("BUSY", "剧情/过渡/工具动画中不能打开暂停菜单。");
            Game1.activeClickableMenu = new GameMenu();
            return observations.Result("已打开游戏菜单暂停单人游戏；继续时调用 closemenu。");
        });
        if (!Game1.player.CanMove || Game1.player.UsingTool || Game1.activeClickableMenu != null || Game1.eventUp || Game1.fadeToBlack)
            throw new ActionFault("BUSY", "暂不能执行此动作；回执 control.blockedBy 说明菜单、剧情或过渡原因。");
        if (request.Command == "ship") return new ShippingAction(request, observations);
        var inventoryAction = InventoryActions.Create(request, observations);
        if (inventoryAction != null) return inventoryAction;
        var realtimeAction = RealtimeActions.Create(request, observations);
        if (realtimeAction != null) return realtimeAction;
        switch (request.Command)
        {
            case "select":
                var slot = Protocol.Integer(request.Args, "slot");
                if (slot < 0 || slot >= Game1.player.Items.Count) throw new ActionFault("INVALID_ARGUMENT", "槽位超出当前背包范围。");
                var changed = Game1.player.CurrentToolIndex != slot;
                Game1.player.CurrentToolIndex = slot;
                return new Immediate(() => observations.Result($"已选择槽位 {slot}。", changed));
            case "move":
                Observations.Target? target = null;
                Point tile;
                if (request.Args.TryGetProperty("near", out _)) { target = observations.Resolve(Protocol.Text(request.Args, "near")); tile = target.Tile; }
                else { var raw = request.Args.GetProperty("tile"); tile = new(Protocol.Integer(raw, "x"), Protocol.Integer(raw, "y")); }
                return new MoveAction(observations, reflection, tile, target, request.Args.TryGetProperty("near", out var near) ? near.GetString() : null);
            case "use": return new UseAction(observations, observations.Resolve(Protocol.Text(request.Args, "target")));
            case "interact": return new InteractAction(observations, observations.Resolve(Protocol.Text(request.Args, "target")));
            default: throw new ActionFault("UNSUPPORTED", "不支持该动作。");
        }
    }
    private static void Reach(Point target)
    {
        var current = Observations.Position;
        if (Math.Abs(current.X - target.X) + Math.Abs(current.Y - target.Y) > 1) throw new ActionFault("OUT_OF_REACH", $"角色 ({current.X},{current.Y}) 到目标 ({target.X},{target.Y}) 需同格或上下左右相邻（曼哈顿距离≤1），对角线不算。请 move near 最新目标引用。");
        var dx = target.X - current.X; var dy = target.Y - current.Y;
        if (dx != 0 || dy != 0) Game1.player.faceDirection(dx > 0 ? 1 : dx < 0 ? 3 : dy > 0 ? 2 : 0);
    }
    private static string InventoryState() => string.Join("|", Game1.player.Items.Select(item => item == null ? "" : $"{item.QualifiedItemId}:{item.Quality}:{item.Stack}"));
    private sealed class WaitAction : IGameAction
    {
        private readonly Observations observations;
        private readonly DateTime end;
        public WaitAction(Observations observations, int milliseconds) { this.observations = observations; end = DateTime.UtcNow.AddMilliseconds(milliseconds); }
        public object? Tick() => DateTime.UtcNow >= end ? observations.Result("等待结束，已重新观察；未跳过剧情或修改游戏时钟。", false) : null;
        public void Cancel() { }
    }
    private sealed class MoveAction : IGameAction, ISceneTransitionAction
    {
        private readonly Observations observations;
        private readonly MovementInput input = new();
        private readonly IReflectedField<IInputSimulator?> simulator;
        private readonly Farmer player = Game1.player;
        private readonly GameLocation location = Game1.currentLocation;
        private readonly string? reference;
        private readonly bool exitGoal;
        private readonly string? expectedDestination;
        public bool CanObserveSceneTransition => IsExpectedScene || expectedDestination != null && ReferenceEquals(location, Game1.currentLocation) && Game1.fadeToBlack && !Game1.eventUp;
        public bool IsExpectedScene => expectedDestination != null && !ReferenceEquals(location, Game1.currentLocation)
            && Game1.currentLocation?.NameOrUniqueName == expectedDestination;
        public object? ObserveSceneTransition() => !IsExpectedScene || Game1.fadeToBlack || !Game1.player.CanMove || Game1.eventUp ? null
            : observations.Result("原生出口切图已在本地观察确认；旧控制权已释放，请重新观察并 start realtime。");
        private readonly HashSet<Point> exitTiles = new();
        private Point goal;
        private Queue<Point> path;
        private Vector2 lastPosition = Game1.player.Position;
        private DateTime lastMoved = DateTime.UtcNow;
        private bool moved;
        private int replans;
        public MoveAction(Observations observations, IReflectionHelper reflection, Point tile, Observations.Target? target, string? reference)
        {
            this.observations = observations; this.reference = reference;
            exitGoal = target?.Identity is Warp || location.warps.Any(w => w.X == tile.X && w.Y == tile.Y);
            expectedDestination = (target?.Identity as Warp ?? location.warps.FirstOrDefault(w => w.X == tile.X && w.Y == tile.Y))?.TargetName
                ?? Multiplayer.NativeDoor.Destination(Observations.InBounds(location, tile) ? location.doesTileHaveProperty(tile.X, tile.Y, "TouchAction", "Back") : null, touch: true);
            if (exitGoal)
            {
                // 一段地图边界可有多个相邻 Warp；边缘端点可能在墙后，按同一出口的真实可达格寻路。
                var destination = (target?.Identity as Warp ?? location.warps.First(w => w.X == tile.X && w.Y == tile.Y)).TargetName;
                var candidates = location.warps.Where(w => w.TargetName == destination).Select(w => new Point(w.X, w.Y)).ToHashSet();
                var frontier = new Queue<Point>(); frontier.Enqueue(tile); exitTiles.Add(tile);
                while (frontier.TryDequeue(out var point))
                    foreach (var direction in Directions)
                        if (candidates.Contains(point + direction) && exitTiles.Add(point + direction)) frontier.Enqueue(point + direction);
            }
            goal = tile; path = FindPath(tile, target != null && !exitGoal);
            simulator = reflection.GetField<IInputSimulator?>(typeof(Game1), "inputSimulator");
            if (simulator.GetValue() != null) throw new ActionFault("BUSY", "其他控制器正在使用游戏模拟输入。");
            simulator.SetValue(input);
        }
        private static readonly Point[] Directions = { new(0, -1), new(1, 0), new(0, 1), new(-1, 0) };
        private Queue<Point> FindPath(Point target, bool near)
        {
            if (!Observations.InBounds(location, target) && !exitGoal) throw new ActionFault("INVALID_ARGUMENT", "坐标超出地图范围。");
            var start = Observations.Position;
            // 商店从柜台南侧交互；站在柜台背后虽然几何相邻，却不能买东西。
            var counter = near && reference != null && observations.Resolve(reference).Action?.StartsWith("Buy ", StringComparison.Ordinal) == true;
            var building = near && reference != null ? observations.Resolve(reference).Identity as StardewValley.Buildings.Building : null;
            bool Arrived(Point p)
            {
                if (exitGoal) return exitTiles.Contains(p);
                if (counter) return p == target + new Point(0, 1);
                if (building != null && building.humanDoor.Value.X < 0)
                {
                    var dx = Math.Abs(p.X - Math.Clamp(p.X, building.tileX.Value, building.tileX.Value + building.tilesWide.Value - 1));
                    var dy = Math.Abs(p.Y - Math.Clamp(p.Y, building.tileY.Value, building.tileY.Value + building.tilesHigh.Value - 1));
                    return dx + dy == 1;
                }
                return near ? Math.Abs(p.X - target.X) + Math.Abs(p.Y - target.Y) <= 1 : p == target;
            }
            var queue = new Queue<Point>(); queue.Enqueue(start);
            var previous = new Dictionary<Point, Point?> { [start] = null };
            while (queue.TryDequeue(out var current))
            {
                if (Arrived(current))
                {
                    if (exitGoal) goal = current;
                    var nodes = new List<Point>();
                    for (var p = current; previous[p] is Point parent; p = parent) nodes.Add(p);
                    nodes.Reverse(); return new Queue<Point>(nodes);
                }
                foreach (var step in Directions)
                {
                    var next = current + step;
                    if (previous.ContainsKey(next)) continue;
                    var isExit = exitGoal && exitTiles.Contains(next);
                    if (!isExit && !Observations.Walkable(location, next)) continue;
                    // 中途不经过自动切图点，交给明确的目标动作处理。
                    var touch = Observations.InBounds(location, next) ? location.doesTileHaveProperty(next.X, next.Y, "TouchAction", "Back") : null;
                    if (!Arrived(next) && (location.warps.Any(w => w.X == next.X && w.Y == next.Y) || touch?.StartsWith("Warp", StringComparison.Ordinal) == true || Context.IsMultiplayer && touch != null)) continue;
                    previous[next] = current; queue.Enqueue(next);
                    if (previous.Count > 16384) throw new ActionFault("PATH_BLOCKED", "路径搜索超过范围，请选择较近目标。");
                }
            }
            var adjacent = string.Join(";", Directions.Select(d => { var p = target + d; return $"({p.X},{p.Y})={(Observations.Walkable(location, p) ? "可站立" : "阻挡")}"; }));
            throw new ActionFault("PATH_BLOCKED", $"从({start.X},{start.Y})到({target.X},{target.Y})未找到可达路径。目标邻格：{adjacent}。请 inspect 并选择其他真实可达目标。");
        }
        public object? Tick()
        {
            input.Direction = -1;
            if (!ReferenceEquals(simulator.GetValue(), input)) throw new ActionFault("BUSY", "游戏模拟输入已被其他控制器接管。");
            if (!ReferenceEquals(location, Game1.currentLocation)) {
                if (Game1.fadeToBlack || !Game1.player.CanMove && Game1.activeClickableMenu == null) return null;
                return observations.Result("移动触发场景切换，过渡已稳定。");
            }
            if (reference != null && !exitGoal)
            {
                var current = observations.Resolve(reference).Tile;
                if (current != goal) { goal = current; path = FindPath(goal, true); }
            }
            if (Game1.activeClickableMenu != null) return observations.Result("移动触发菜单，请根据新快照选择。", moved);
            if (Game1.fadeToBlack || !Game1.player.CanMove) return null;
            if (Game1.player.Position != lastPosition) { moved = true; lastPosition = Game1.player.Position; lastMoved = DateTime.UtcNow; }
            else if ((DateTime.UtcNow - lastMoved).TotalSeconds > 2)
            {
                if (++replans > 2) throw new ActionFault("PATH_BLOCKED", $"角色在({Observations.Position.X},{Observations.Position.Y})停滞，两次重算仍无法前进。");
                path = FindPath(goal, reference != null && !exitGoal); lastMoved = DateTime.UtcNow;
            }
            var center = Game1.player.GetBoundingBox().Center.ToVector2();
            while (path.Count > 0 && Vector2.Distance(center, path.Peek().ToVector2() * 64 + new Vector2(32)) <= 5) path.Dequeue();
            if (path.Count == 0) return observations.Result("已到达目标。", moved);
            var next = path.Peek();
            if (!(exitGoal && next == goal) && !Observations.Walkable(location, next))
            {
                if (++replans > 2) throw new ActionFault("PATH_BLOCKED", $"路径格({next.X},{next.Y})被动态障碍阻挡，两次重算后已停止。");
                path = FindPath(goal, reference != null && !exitGoal); lastMoved = DateTime.UtcNow;
                return null;
            }
            var delta = next.ToVector2() * 64 + new Vector2(32) - center;
            input.Direction = Math.Abs(delta.X) > Math.Abs(delta.Y)
                ? delta.X > 0 ? 1 : 3
                : delta.Y > 0 ? 2 : 0;
            return null;
        }
        public void Cancel()
        {
            input.Direction = -1;
            if (ReferenceEquals(simulator.GetValue(), input)) simulator.SetValue(null);
            player.Halt();
        }
    }
    private sealed class UseAction : IGameAction
    {
        private readonly Observations observations;
        private readonly Observations.Target target;
        private readonly string operation;
        private readonly string before;
        private readonly WateringCan? refillCan;
        private readonly int waterBefore;
        private readonly string inventoryBefore = InventoryState();
        private readonly string worldBefore = WorldState.InteractionSignature();
        private int ticks;
        private bool ended;
        private static string State(Point tile)
        {
            Game1.currentLocation.terrainFeatures.TryGetValue(tile.ToVector2(), out var terrain);
            Game1.currentLocation.objects.TryGetValue(tile.ToVector2(), out var obj);
            return $"{terrain?.GetType().Name}/{(terrain as Tree)?.health.Value}/{(terrain as HoeDirt)?.state.Value}/{(terrain as HoeDirt)?.crop?.indexOfHarvest.Value}/{obj?.QualifiedItemId}/{obj?.minutesUntilReady.Value}";
        }
        public UseAction(Observations observations, Observations.Target target)
        {
            this.observations = observations; this.target = target; Reach(target.Tile); before = State(target.Tile);
            var player = Game1.player;
            var selected = player.CurrentItem;
            target.Location.terrainFeatures.TryGetValue(target.Tile.ToVector2(), out var feature);
            var dirt = feature as HoeDirt;
            if (selected is StardewValley.Object seeds && seeds.Category == StardewValley.Object.SeedsCategory)
            {
                operation = "播种";
                if (seeds.Stack < 1) throw new ActionFault("INSUFFICIENT_RESOURCE", "种子不足。");
                if (dirt == null || dirt.crop != null) throw new ActionFault("INVALID_ARGUMENT", "播种需要没有作物的耕地。");
                // 与游戏的物品放置入口一致，由游戏检查季节、物品并扣除数量。
                if (!Utility.tryToPlaceItem(target.Location, seeds, target.Tile.X * 64, target.Tile.Y * 64)) throw new ActionFault("INSUFFICIENT_RESOURCE", "当前种子不能种在这里，请检查季节和土地。");
            }
            else if (selected is Tool tool && (tool is Hoe || tool is WateringCan || tool is Axe || tool is Pickaxe || tool is MilkPail || tool is Shears || tool is MeleeWeapon scythe && scythe.isScythe()))
            {
                operation = tool is Hoe ? "耕地" : tool is WateringCan ? "浇水" : "使用工具";
                var refill = tool is WateringCan && target.Location.CanRefillWateringCanOnTile(target.Tile.X, target.Tile.Y);
                if (!refill && player.Stamina < 2) throw new ActionFault("INSUFFICIENT_RESOURCE", "体力不足。");
                var artifactSpot = target.Location.objects.TryGetValue(target.Tile.ToVector2(), out var buried) && buried.QualifiedItemId == "(O)590";
                if (tool is Hoe && !artifactSpot && (feature != null || target.Location.objects.ContainsKey(target.Tile.ToVector2()) || target.Location.doesTileHaveProperty(target.Tile.X, target.Tile.Y, "Diggable", "Back") == null)) throw new ActionFault("INVALID_ARGUMENT", "目标不是空置可耕地或可挖掘文物点。");
                if (tool is Hoe && artifactSpot) operation = "挖掘文物点";
                if (tool is WateringCan can)
                {
                    if (refill)
                    {
                        if (can.WaterLeft >= can.waterCanMax) throw new ActionFault("INVALID_ARGUMENT", "浇水壶已满。");
                        operation = "补水"; refillCan = can; waterBefore = can.WaterLeft;
                    }
                    else
                    {
                        if (can.WaterLeft <= 0) throw new ActionFault("INSUFFICIENT_RESOURCE", "浇水壶已空，请朝可补水的水源使用水壶。");
                        if (dirt == null) throw new ActionFault("INVALID_ARGUMENT", "请选择需要浇水的耕地或可补水的水源。");
                        if (dirt.state.Value == HoeDirt.watered) throw new ActionFault("INVALID_ARGUMENT", "目标已经浇水。");
                    }
                }
                player.lastClick = target.Tile.ToVector2() * 64 + new Vector2(32);
                player.toolPower.Value = 0;
                player.BeginUsingTool();
            }
            else throw new ActionFault("UNSUPPORTED", "请选择农务工具、镰刀、动物采集工具或种子；战斗请使用 combat。");
        }
        public object? Tick()
        {
            if (!ReferenceEquals(target.Location, Game1.currentLocation)) throw new ActionFault("STALE_REF", "执行期间地图已改变。");
            ticks++;
            // 松开单次工具使用，避免升级工具进入蓄力；动画和资源消耗由游戏完成。
            if (!ended && ticks > 1 && Game1.player.UsingTool) { Game1.player.EndUsingTool(); ended = true; }
            if (ticks < 3 || Game1.player.UsingTool) return null;
            var changed = refillCan != null ? refillCan.WaterLeft > waterBefore : before != State(target.Tile) || inventoryBefore != InventoryState() || worldBefore != WorldState.InteractionSignature();
            if (!changed) throw new ActionFault("UNSUPPORTED", "工具动画结束，但目标未发生可验证变化，请重新观察。");
            if (refillCan != null) return observations.Result($"补水完成，水量 {waterBefore} → {refillCan.WaterLeft}/{refillCan.waterCanMax}。");
            return observations.Result($"{operation}完成，已检查目标状态。");
        }
        public void Cancel() { /* 不回滚已触发的游戏动画或资源消耗。 */ }
    }
    private sealed class InteractAction : IGameAction, ISceneTransitionAction
    {
        private readonly Observations observations;
        private readonly Observations.Target target;
        private readonly GameLocation location = Game1.currentLocation;
        private readonly object? priorMenu = Game1.activeClickableMenu;
        private readonly string priorMenuSignature = Observations.MenuSignature(Game1.activeClickableMenu);
        private readonly string priorInventory = InventoryState();
        private readonly string priorWorld = WorldState.InteractionSignature();
        private readonly bool targetExisted;
        private readonly string? expectedDestination;
        public bool CanObserveSceneTransition => IsExpectedScene || expectedDestination != null && ReferenceEquals(location, Game1.currentLocation) && Game1.fadeToBlack && !Game1.eventUp;
        public bool IsExpectedScene => expectedDestination != null && !ReferenceEquals(location, Game1.currentLocation)
            && Game1.currentLocation?.NameOrUniqueName == expectedDestination;
        public object? ObserveSceneTransition() => !IsExpectedScene || Game1.fadeToBlack || !Game1.player.CanMove || Game1.eventUp ? null
            : observations.Result("原生门切图已在本地观察确认；旧控制权已释放，请重新观察并 start realtime。");
        private int ticks;
        private static string InventoryState() => string.Join("|", Game1.player.Items.Select(item => item == null ? "" : $"{item.QualifiedItemId}:{item.Stack}"));
        private bool TargetExists()
        {
            if (!ReferenceEquals(location, Game1.currentLocation)) return false;
            return target.Identity switch
            {
                Furniture furniture => location.furniture.Contains(furniture) && furniture.TileLocation.ToPoint() == target.Tile,
                StardewValley.Object obj => location.objects.TryGetValue(target.Tile.ToVector2(), out var current) && ReferenceEquals(current, obj),
                TerrainFeature feature => location.terrainFeatures.TryGetValue(target.Tile.ToVector2(), out var current) && ReferenceEquals(current, feature),
                NPC npc => location.characters.Contains(npc),
                Warp warp => location.warps.Contains(warp),
                FarmAnimal animal => location.animals.Values.Contains(animal),
                _ => false
            };
        }
        public InteractAction(Observations observations, Observations.Target target)
        {
            this.observations = observations; this.target = target; targetExisted = TargetExists();
            expectedDestination = target.Identity is Warp warp ? warp.TargetName
                : target.Kind == "door" && target.Identity is StardewValley.Buildings.Building building ? building.GetIndoorsName()
                : Multiplayer.NativeDoor.Destination(location.doesTileHaveProperty(target.Tile.X, target.Tile.Y, "Action", "Buildings"));
            if (target.Kind == "action" && target.Action == "Sleep") throw new ActionFault("USE_MOVE", "睡觉确认由 TouchAction 触发：请移动到 Sleep 格，而非 interact。");
            if (target.Identity is BedFurniture bed)
            {
                var bounds = bed.boundingBox.Value;
                var player = Game1.player.GetBoundingBox();
                bounds.Inflate(64, 64);
                if (!bounds.Intersects(player)) throw new ActionFault("OUT_OF_REACH", "需要先靠近床。");
            }
            else Reach(target.Tile);
            if (target.Kind == "mailbox") { location.mailbox(); return; }
            if (!location.checkAction(new xTile.Dimensions.Location(target.Tile.X, target.Tile.Y), Game1.viewport, Game1.player))
                throw new ActionFault("UNSUPPORTED", "目标没有可用交互；自动出口可尝试移动到目标格子。");
        }
        public object? Tick()
        {
            if (++ticks < 3 || Game1.fadeToBlack || Game1.activeClickableMenu == null && (Game1.player.UsingTool || !Game1.player.CanMove)) return null;
            var menuChanged = !ReferenceEquals(priorMenu, Game1.activeClickableMenu) || priorMenuSignature != Observations.MenuSignature(Game1.activeClickableMenu);
            var inventoryChanged = priorInventory != InventoryState();
            var targetDisappeared = targetExisted && !TargetExists();
            if (InteractionEvidence.Changed(!ReferenceEquals(location, Game1.currentLocation), menuChanged, inventoryChanged, targetDisappeared) || priorWorld != WorldState.InteractionSignature())
                return observations.Result("交互已产生可验证变化。");
            throw new ActionFault("UNSUPPORTED", "交互未产生当前支持的可验证结果，请重新观察。");
        }
        public void Cancel() { }
    }
    private sealed class MenuAction : IGameAction
    {
        private readonly Observations observations;
        private readonly Observations.Target target;
        private int ticks;
        private bool clicked;
        private bool attempted;
        private readonly int day = Game1.dayOfMonth;
        private readonly bool sleep;
        public MenuAction(Observations observations, Observations.Target target)
        {
            this.observations = observations; this.target = target;
            if (target.Identity is not IClickableMenu) throw new ActionFault("UNSUPPORTED", "目标不是当前菜单。");
            sleep = target.Identity is DialogueBox dialogue && Game1.currentLocation.lastQuestionKey == "Sleep" && target.Option >= 0 && dialogue.responses[target.Option].responseKey == "Yes";
        }
        public object? Tick()
        {
            if (++ticks < 3) return null;
            if (!clicked)
            {
                if (!ReferenceEquals(Game1.activeClickableMenu, target.Identity) || Observations.MenuSignature(Game1.activeClickableMenu) != target.Action)
                {
                    if (!attempted) throw new ActionFault("MENU_MISMATCH", "菜单已改变。");
                    // 切图等选择会在下一帧才关闭原菜单，不能在已点击后误报旧引用失效。
                    clicked = true;
                    return null;
                }
                if (target.Identity is not DialogueBox dialogue)
                {
                    var current = (IClickableMenu)target.Identity!;
                    if (current is ShippingMenu && current.GetType().GetMethod("CanReceiveInput", System.Reflection.BindingFlags.Instance | System.Reflection.BindingFlags.Public | System.Reflection.BindingFlags.NonPublic)?.Invoke(current, null) is false) return null;
                    attempted = true;
                    current.receiveLeftClick(target.Tile.X, target.Tile.Y);
                    clicked = !ReferenceEquals(Game1.activeClickableMenu, current) || Observations.MenuSignature(current) != target.Action || current is ShippingMenu && Observations.ReadField(current, "outro") is true;
                    return null;
                }
                // 先正常展开对话，再选择已观察的选项；遵守菜单的防误触计时。
                if (target.Option >= 0) dialogue.selectedResponse = target.Option;
                attempted = true;
                dialogue.receiveLeftClick(dialogue.xPositionOnScreen + 8, dialogue.yPositionOnScreen + 8);
                clicked = !ReferenceEquals(Game1.activeClickableMenu, target.Identity) || Observations.MenuSignature(Game1.activeClickableMenu) != target.Action;
                return null;
            }
            // 收入或升级菜单需要交还当前模型选择，不能在一个睡觉动作内等待它自行消失。
            if (sleep && Game1.dayOfMonth == day && Game1.activeClickableMenu == null) return null;
            if (Game1.activeClickableMenu == null && (Game1.fadeToBlack || !Game1.player.CanMove)) return null;
            return observations.Result(sleep ? Game1.dayOfMonth == day ? "已触发正常睡觉流程，请处理后续菜单。" : "已确认日期推进，请处理后续菜单并核对保存结果。" : "菜单选择已生效。");
        }
        public void Cancel() { }
    }
}
