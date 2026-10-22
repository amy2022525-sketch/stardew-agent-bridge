using Microsoft.Xna.Framework;
using Microsoft.Xna.Framework.Input;
using StardewValley;
using StardewValley.Menus;
using StardewValley.Monsters;
using StardewValley.Tools;
using HarmonyLib;
using System.Reflection;

namespace StardewAgentBridge;

// 决策由调用模型完成；这里仅在有界时间内执行真实游戏输入并核对实际结果。
public static class RealtimeActions
{
    public static object InputStatus => FishingInput.Status;
    public static IGameAction? Create(Request request, Observations observations) => request.Command switch
    {
        "fish" => new FishingAction(request, observations),
        "combat" => new CombatAction(request, observations),
        _ => null
    };

    private static int OptionalInt(Request r, string key, int fallback, int min, int max)
    {
        var value = r.Args.TryGetProperty(key, out _) ? Protocol.Integer(r.Args, key) : fallback;
        if (value < min || value > max) throw new ActionFault("INVALID_ARGUMENT", $"{key} 必须为 {min}–{max}。");
        return value;
    }

    private static void Ready(bool allowFishing = false)
    {
        if (Game1.eventUp || Game1.fadeToBlack || Game1.player.health <= 0 || Game1.player.freezePause > 0)
            throw new ActionFault("BUSY", "剧情、过渡、受击或角色倒下时不能开始实时动作。");
        if (allowFishing && Game1.player.CurrentTool is FishingRod rod && rod.inUse() &&
            (Game1.activeClickableMenu == null || Game1.activeClickableMenu is BobberBar)) return;
        if (Game1.activeClickableMenu != null || Game1.player.UsingTool || !Game1.player.CanMove)
            throw new ActionFault("BUSY", "请先处理菜单或等待当前工具动画结束。");
    }

    private static Dictionary<string, int> Inventory() => Game1.player.Items.Where(i => i != null)
        .GroupBy(i => i.QualifiedItemId + ":" + i.Quality)
        .ToDictionary(g => g.Key, g => g.Sum(i => i.Stack));

    private static object[] InventoryDelta(Dictionary<string, int> before)
    {
        var after = Inventory();
        return before.Keys.Union(after.Keys).OrderBy(k => k, StringComparer.Ordinal)
            .Where(k => after.GetValueOrDefault(k) != before.GetValueOrDefault(k))
            .Select(k => (object)new { item = k, count = after.GetValueOrDefault(k) - before.GetValueOrDefault(k) }).ToArray();
    }

    // SMAPI 强制要求 Game1.input 保持 SInputState 类型，不能替换为 InputState 子类。
    // 仅在显式钓鱼动作内合成该实例的左键返回值，退出后恢复物理输入。
    private sealed class FishingInput : IDisposable
    {
        private static readonly Harmony harmony = new("AgentStardew.Bridge.FishingInput");
        private static readonly HashSet<MethodBase> patched = new();
        private static FishingInput? active;
        public static object Status => new { active = active != null, inputType = Game1.input.GetType().FullName };
        private readonly InputState source;
        public bool Held { get; set; }
        private bool disposed;
        public FishingInput()
        {
            source = Game1.input;
            if (active != null) throw new ActionFault("BUSY", "已有钓鱼输入控制器。");
            var method = source.GetType().GetMethod(nameof(InputState.GetMouseState), BindingFlags.Instance | BindingFlags.Public | BindingFlags.NonPublic)
                ?? throw new ActionFault("UNSUPPORTED", "当前输入源没有已核验的鼠标状态读取接口。");
            if (!patched.Contains(method))
            {
                harmony.Patch(method, postfix: new HarmonyMethod(typeof(FishingInput).GetMethod(nameof(ApplyMouse), BindingFlags.Static | BindingFlags.NonPublic)));
                patched.Add(method);
            }
            active = this;
        }
        public bool Owned => !disposed && ReferenceEquals(active, this) && ReferenceEquals(Game1.input, source);
        private static void ApplyMouse(InputState __instance, ref MouseState __result)
        {
            var owner = active;
            if (owner == null || owner.disposed || !ReferenceEquals(__instance, owner.source)) return;
            var state = __result;
            __result = new MouseState(state.X, state.Y, state.ScrollWheelValue,
                owner.Held ? ButtonState.Pressed : ButtonState.Released,
                state.MiddleButton, state.RightButton, state.XButton1, state.XButton2);
        }
        public void Dispose()
        {
            if (disposed) return;
            var owned = Owned;
            disposed = true; Held = false;
            if (ReferenceEquals(active, this)) active = null;
            if (!owned) return;
            // 清除本控制器上一帧的合成左键，防止退出后留下额外一次点击。
            Game1.oldMouseState = source.GetMouseState();
        }
    }

    private sealed class FishingAction : IGameAction
    {
        private readonly Observations observations;
        private readonly Farmer player = Game1.player;
        private readonly GameLocation location = Game1.currentLocation;
        private readonly FishingRod rod;
        private readonly FishingInput input;
        private readonly Dictionary<string, int> before = Inventory();
        private readonly DateTime started = DateTime.UtcNow;
        private readonly DateTime deadline;
        private readonly float releasePower;
        private readonly List<string> stages = new();
        private string phase = "starting";
        private bool sawFishing, sawMinigame, sawCatch, terminal;
        private int ticks, hookCooldown;

        public FishingAction(Request r, Observations observations)
        {
            this.observations = observations;
            var duration = OptionalInt(r, "milliseconds", 45000, 100, 55000);
            deadline = started.AddMilliseconds(duration);
            Ready(true);
            if (player.CurrentTool is not FishingRod selected) throw new ActionFault("INVALID_ARGUMENT", "请先选择钓鱼竿。");
            rod = selected;
            if (!rod.inUse())
            {
                if (player.Stamina < 8) throw new ActionFault("INSUFFICIENT_RESOURCE", "体力不足以开始一次抛竿。");
                var origin = Observations.Position;
                Point target;
                if (r.Args.TryGetProperty("target", out _))
                {
                    var observed = observations.Resolve(Protocol.Text(r.Args, "target"));
                    target = observed.Tile;
                    if (!ReferenceEquals(observed.Location, location) || !location.isTileFishable(target.X, target.Y))
                        throw new ActionFault("INVALID_ARGUMENT", "目标不是当前地图可钓鱼的水面；水井等补水点不一定能钓鱼。");
                    var dx = target.X - origin.X; var dy = target.Y - origin.Y;
                    if (dx != 0 && dy != 0 || dx == 0 && dy == 0 || Math.Abs(dx) + Math.Abs(dy) > 6)
                        throw new ActionFault("OUT_OF_REACH", "请移到目标水面的岸边并与水面横向或纵向对齐；目标距离应为 1–6 格。");
                    player.faceDirection(dx > 0 ? 1 : dx < 0 ? 3 : dy > 0 ? 2 : 0);
                }
                else
                {
                    var direction = player.FacingDirection switch { 0 => new Point(0, -1), 1 => new Point(1, 0), 2 => new Point(0, 1), _ => new Point(-1, 0) };
                    var found = Enumerable.Range(1, 4).Select(d => origin + new Point(direction.X * d, direction.Y * d))
                        .Where(p => Observations.InBounds(location, p) && location.isTileFishable(p.X, p.Y)).Cast<Point?>().FirstOrDefault();
                    if (found == null) throw new ActionFault("INVALID_ARGUMENT", "当前朝向前方没有可钓水面；请先站到岸边，或指定已观察的水面引用。");
                    target = found.Value;
                }
                // 目标决定朝向和正常蓄力时机；不写浮标位置，落点及是否入水由游戏确认。
                var distance = Math.Abs(target.X - origin.X) + Math.Abs(target.Y - origin.Y);
                var level = player.FishingLevel;
                var addedDistance = level >= 15 ? 4 : level >= 8 ? 3 : level >= 4 ? 2 : level >= 1 ? 1 : 0;
                var baseDistance = player.FacingDirection is 1 or 3 ? 4 : 3;
                releasePower = Math.Clamp((distance - 0.1f) / (baseDistance + addedDistance), 0.08f, 0.99f);
                player.lastClick = target.ToVector2() * 64 + new Vector2(32);
            }
            else releasePower = 0.65f;
            input = new FishingInput();
            if (!rod.inUse())
            {
                input.Held = true;
                try { player.BeginUsingTool(); }
                catch { input.Dispose(); throw; }
            }
            Mark("casting");
        }

        private void Mark(string next)
        {
            phase = next;
            if (!stages.Contains(next)) stages.Add(next);
        }
        public object? Tick()
        {
            ticks++;
            if (!input.Owned) throw new ActionFault("BUSY", "钓鱼期间输入控制器被其他来源接管。");
            if (!ReferenceEquals(player, Game1.player) || !ReferenceEquals(location, Game1.currentLocation))
                return Finish("stopped", "location_changed", "地图或角色已改变，钓鱼输入已释放。");
            if (player.health <= 0 || Game1.eventUp || Game1.fadeToBlack)
                return Finish("stopped", "interrupted", "剧情、过渡或角色状态打断钓鱼。");

            if (Game1.activeClickableMenu is BobberBar bar)
            {
                sawMinigame = true; Mark("minigame");
                if (DateTime.UtcNow >= deadline) return Finish("partial", "budget_exhausted", "时间预算已用完，已通过游戏正常退出入口放弃本次小游戏。");
                // 游戏绿条向上为负速度，按住产生负加速度；只选择普通鼠标输入。
                // 提前考虑刹车距离，保持鱼位于绿条中部，不修改绿条/鱼/捕获进度。
                var center = bar.bobberBarPos + bar.bobberBarHeight / 2f;
                var desired = bar.bobberPosition + Math.Clamp(bar.bobberSpeed * 4, -18, 18);
                var error = center - desired;
                var desiredSpeed = Math.Clamp(-error * 0.075f, -4.5f, 4.5f);
                input.Held = bar.bobberBarSpeed > desiredSpeed;
                return null;
            }
            if (Game1.activeClickableMenu != null)
            {
                Mark("menu_pending");
                return Finish("partial", "menu_pending", "钓鱼产生菜单（可能是满背包、宝箱或对话），已释放输入；请按当前菜单继续处理。");
            }

            // 出鱼提示仍由 FishingRod.tickUpdate 消费正常点击并执行物品入包。
            if (rod.fishCaught)
            {
                // 小游戏末帧可能仍在按住，先松开一帧，再制造正常收取点击边沿。
                if (!sawCatch) { sawCatch = true; Mark("collecting"); input.Held = false; return null; }
                if (DateTime.UtcNow >= deadline) return Finish("partial", "catch_pending", "已钓起物品但收取仍待游戏处理；保留当前状态，请再次调用 fish 继续。");
                input.Held = true;
                return null;
            }
            if (sawCatch)
            {
                input.Held = false;
                if (!rod.inUse() && !player.UsingTool && player.CanMove)
                {
                    var gained = Inventory().Any(p => p.Value > before.GetValueOrDefault(p.Key));
                    return Finish(gained ? "completed" : "partial", gained ? "inventory_verified" : "inventory_not_verified",
                        gained ? "本轮收杆完成，已确认真实背包物品增加。" : "收杆动画结束，尚未确认背包增加；请检查菜单和背包。");
                }
            }
            if (DateTime.UtcNow >= deadline) return Finish("partial", "budget_exhausted", "钓鱼时间预算已用完，已停止自动输入；未把等待或未入包鱼获计作成功。");
            if (rod.isTimingCast)
            {
                Mark("casting");
                input.Held = rod.castingPower < releasePower;
                return null;
            }
            input.Held = false;
            if (rod.isFishing) { sawFishing = true; Mark(rod.isNibbling ? "bite" : "waiting_bite"); }
            if (rod.isNibbling && !rod.hit && !rod.isReeling && !rod.pullingOutOfWater && hookCooldown-- <= 0)
            {
                // 与按下使用工具按钮相同的真实入口；鱼种、咬钩及小游戏由游戏产生。
                rod.DoFunction(location, (int)player.lastClick.X, (int)player.lastClick.Y, 0, player);
                hookCooldown = 10;
                Mark("hooking");
                return null;
            }
            if (rod.pullingOutOfWater) Mark("reeling");
            if (ticks > 15 && !rod.inUse() && !player.UsingTool && player.CanMove)
                return Finish("partial", sawMinigame ? "fish_escaped" : sawFishing ? "no_catch" : "cast_not_in_water",
                    sawMinigame ? "本轮小游戏已结束，鱼逃脱，未增加鱼获。" : "本轮未形成已入包鱼获；请重新观察岸边和落点。");
            return null;
        }

        private object Finish(string outcome, string reason, string detail)
        {
            StopOwnedFishing(outcome != "completed");
            terminal = true;
            return new { kind = "action", command = "fish", outcome, reason, phase, stages = stages.ToArray(),
                elapsedMs = (int)(DateTime.UtcNow - started).TotalMilliseconds,
                changed = InventoryDelta(before).Length > 0, inventoryDelta = InventoryDelta(before),
                fishingState = new { rod.isFishing, rod.isTimingCast, rod.isCasting, rod.isNibbling, rod.isReeling, rod.pullingOutOfWater, rod.fishCaught },
                detail, snapshot = observations.Snapshot() };
        }
        private void StopOwnedFishing(bool abort)
        {
            input.Held = false;
            if (abort && input.Owned && ReferenceEquals(player, Game1.player) && ReferenceEquals(location, Game1.currentLocation))
            {
                if (Game1.activeClickableMenu is BobberBar bar) bar.emergencyShutDown(); // 与菜单退出键相同的失败/放弃入口。
                else if (Game1.activeClickableMenu == null && !rod.fishCaught && !rod.showingTreasure && rod.inUse())
                    rod.doneFishing(player, false); // 正常收起工具入口，不生成鱼，不清除已捕获待领取物品。
            }
            input.Dispose();
        }
        public void Cancel()
        {
            if (!terminal) StopOwnedFishing(true);
            else input.Dispose();
        }
    }

    private sealed class CombatAction : IGameAction
    {
        private readonly Observations observations;
        private readonly Farmer player = Game1.player;
        private readonly GameLocation location = Game1.currentLocation;
        private readonly MeleeWeapon weapon;
        private readonly Monster target;
        private readonly int beforeHealth, playerBefore, minHealth;
        private readonly Dictionary<string, int> beforeInventory = Inventory();
        private readonly DateTime started = DateTime.UtcNow, deadline;
        private DateTime nextSwing = DateTime.MinValue;
        private int swings;

        public CombatAction(Request r, Observations observations)
        {
            this.observations = observations;
            deadline = started.AddMilliseconds(OptionalInt(r, "milliseconds", 1000, 100, 10000));
            minHealth = OptionalInt(r, "minHealth", 30, 1, 999);
            Ready();
            if (player.CurrentTool is not MeleeWeapon selected || selected.isScythe())
                throw new ActionFault("INVALID_ARGUMENT", "请先选择近战武器；镰刀不作为战斗武器。");
            weapon = selected;
            if (player.health <= minHealth) throw new ActionFault("LOW_HEALTH", $"生命值 {player.health} 已到停止阈值 {minHealth}，请先补给或撤退。");
            if (r.Args.TryGetProperty("target", out _))
            {
                var observed = observations.Resolve(Protocol.Text(r.Args, "target"));
                if (!ReferenceEquals(observed.Location, location) || observed.Identity is not Monster monster)
                    throw new ActionFault("INVALID_ARGUMENT", "combat 的目标必须是当前观察到的怪物。");
                target = monster;
            }
            else target = location.characters.OfType<Monster>().Where(m => m.Health > 0)
                .OrderBy(m => Vector2.DistanceSquared(player.GetBoundingBox().Center.ToVector2(), m.GetBoundingBox().Center.ToVector2()))
                .FirstOrDefault() ?? throw new ActionFault("NO_TARGET", "当前地图没有活着的怪物。");
            if (!location.characters.Contains(target) || target.Health <= 0) throw new ActionFault("STALE_REF", "目标怪物已离开或倒下。");
            if (!InReach()) throw new ActionFault("OUT_OF_REACH", "目标超出近战范围（约两格）；请先使用 move 靠近，再重新观察并攻击。");
            beforeHealth = target.Health; playerBefore = player.health;
        }

        private bool InReach() => Vector2.Distance(player.GetBoundingBox().Center.ToVector2(), target.GetBoundingBox().Center.ToVector2()) <= 128;
        public object? Tick()
        {
            if (!ReferenceEquals(Game1.player, player) || !ReferenceEquals(Game1.currentLocation, location)) return Finish("stopped", "location_changed", "地图或角色改变，已停止攻击。");
            if (player.health <= minHealth) return Finish("stopped", "low_health", "生命值到达设置阈值，已停止新攻击；请撤退或补给。");
            if (Game1.eventUp || Game1.fadeToBlack || Game1.activeClickableMenu != null) return Finish("stopped", "interrupted", "剧情、菜单或切图打断战斗，已停止新攻击。");
            if (!ReferenceEquals(player.CurrentTool, weapon)) return Finish("stopped", "weapon_changed", "当前装备已改变，已停止攻击。");
            if (target.Health <= 0) return Finish("completed", "target_defeated", "已确认目标怪物生命值归零；掉落物仍需根据快照收集。");
            if (!location.characters.Contains(target)) return Finish("partial", "target_removed", "目标离开当前角色列表，不能仅凭消失判定击杀。");
            if (!InReach()) return Finish("partial", "target_out_of_reach", "怪物已移出近战范围，已停止挥砍；请重新观察后移动。");
            if (DateTime.UtcNow >= deadline) return Finish("partial", "budget_exhausted", "战斗预算已用完；已记录真实怪物及玩家生命变化。");
            if (player.UsingTool || !player.CanMove || player.freezePause > 0 || DateTime.UtcNow < nextSwing) return null;
            var delta = target.GetBoundingBox().Center.ToVector2() - player.GetBoundingBox().Center.ToVector2();
            player.faceDirection(Math.Abs(delta.X) > Math.Abs(delta.Y) ? delta.X > 0 ? 1 : 3 : delta.Y > 0 ? 2 : 0);
            player.lastClick = target.GetBoundingBox().Center.ToVector2();
            player.BeginUsingTool(); // 正常武器动画及碰撞判伤；不调用 damageMonster/takeDamage。
            swings++;
            nextSwing = DateTime.UtcNow.AddMilliseconds(180);
            return null;
        }
        private object Finish(string outcome, string reason, string detail) => new
        {
            kind = "action", command = "combat", outcome, reason, phase = "stopped", swings,
            elapsedMs = (int)(DateTime.UtcNow - started).TotalMilliseconds,
            target = new { name = target.Name, healthBefore = beforeHealth, healthAfter = Math.Max(0, target.Health),
                damageVerified = Math.Max(0, beforeHealth - Math.Max(0, target.Health)), present = location.characters.Contains(target) },
            player = new { healthBefore = playerBefore, healthAfter = player.health, minHealth },
            changed = target.Health != beforeHealth || player.health != playerBefore,
            inventoryDelta = InventoryDelta(beforeInventory), detail, snapshot = observations.Snapshot()
        };
        public void Cancel()
        {
            // 不注入移动或持续攻击；已开始的一次正常武器动画由游戏自然收尾。
        }
    }
}
