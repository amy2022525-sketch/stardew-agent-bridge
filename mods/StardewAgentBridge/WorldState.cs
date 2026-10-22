using System.Text.Json;
using Microsoft.Xna.Framework;
using StardewValley;
using StardewValley.Characters;
using StardewValley.Monsters;

namespace StardewAgentBridge;

// 仅读取真实任务、关系、邮件及动物状态；不接受任务、不送礼、不领取奖励或修改亲密度。
public static class WorldState
{
    private static string Short(string? text, int maximum = 160)
        => string.IsNullOrEmpty(text) ? "" : text.Length <= maximum ? text : text[..maximum] + "…";

    private static bool Nearby(Point tile, Point center, int radius)
        => Math.Abs(tile.X - center.X) <= radius && Math.Abs(tile.Y - center.Y) <= radius;

    public static IEnumerable<FarmAnimal> Animals(GameLocation location, Point center, int radius)
        => location.animals.Values.Where(a => a != null && Nearby(a.TilePoint, center, radius))
            .OrderBy(a => Math.Abs(a.TilePoint.X - center.X) + Math.Abs(a.TilePoint.Y - center.Y))
            .ThenBy(a => a.myID.Value);

    private static object FriendshipState(NPC npc)
    {
        var known = Game1.player.friendshipData.TryGetValue(npc.Name, out var relationship);
        return new
        {
            name = npc.Name, displayName = npc.displayName, known,
            points = known ? (int?)relationship.Points : null,
            hearts = known ? (int?)(relationship.Points / 250) : null,
            talkedToday = known && relationship.TalkedToToday,
            giftsToday = known ? relationship.GiftsToday : 0,
            giftsThisWeek = known ? relationship.GiftsThisWeek : 0,
            status = known ? relationship.Status.ToString() : "Unmet",
            tile = Observations.Tile(npc.TilePoint)
        };
    }

    private static object PetState(Pet pet)
    {
        var hasDay = pet.lastPetDay.TryGetValue(Game1.player.UniqueMultiplayerID, out var day);
        return new
        {
            kind = "pet", name = pet.Name, displayName = pet.displayName,
            type = pet.petType.Value, friendship = pet.friendshipTowardFarmer.Value,
            pettedToday = hasDay && day == Game1.Date.TotalDays,
            tile = Observations.Tile(pet.TilePoint)
        };
    }

    private static object AnimalState(FarmAnimal animal)
    {
        var produce = animal.currentProduce.Value;
        return new
        {
            kind = "animal", id = animal.myID.Value, name = animal.Name, displayName = animal.displayName,
            type = animal.type.Value, ageDays = animal.age.Value, baby = animal.isBaby(),
            pettedToday = animal.wasPet.Value, autoPettedToday = animal.wasAutoPet.Value,
            friendship = animal.friendshipTowardFarmer.Value,
            happiness = animal.happiness.Value, fullness = animal.fullness.Value,
            currentProduce = string.IsNullOrEmpty(produce) || produce == "-1" ? null : produce,
            produceQuality = animal.produceQuality.Value,
            harvestType = animal.GetHarvestType()?.ToString(),
            tile = Observations.Tile(animal.TilePoint)
        };
    }

    public static object? Inspect(Observations.Target target) => target.Identity switch
    {
        FarmAnimal animal => AnimalState(animal),
        Pet pet => PetState(pet),
        NPC npc when npc is not Monster => FriendshipState(npc),
        _ => null
    };

    public static object Summary()
    {
        var player = Game1.player;
        var location = Game1.currentLocation;
        var quests = player.questLog.Where(q => !q.destroy.Value && !q.IsHidden()).ToArray();
        var nearby = location.characters.Where(n => n is not Monster && (n.IsVillager || n is Pet) && Nearby(n.TilePoint, Observations.Position, 8))
            .OrderBy(n => Math.Abs(n.TilePoint.X - Observations.Position.X) + Math.Abs(n.TilePoint.Y - Observations.Position.Y))
            .ThenBy(n => n.Name, StringComparer.Ordinal).ToArray();
        var animals = Animals(location, Observations.Position, 8).ToArray();
        return new
        {
            quests = new
            {
                total = quests.Length,
                entries = quests.OrderByDescending(q => q.completed.Value).ThenBy(q => q.id.Value, StringComparer.Ordinal).Take(12).Select(q => new
                {
                    id = q.id.Value, title = Short(q.questTitle, 80), completed = q.completed.Value,
                    accepted = q.accepted.Value, daily = q.dailyQuest.Value,
                    daysLeft = q.dailyQuest.Value ? (int?)q.daysLeft.Value : null,
                    moneyReward = q.moneyReward.Value,
                    // 不触发 reloadObjective；缓存文字为空时按未提供处理。
                    objective = Short(q._currentObjective), objectiveCached = true
                }).ToArray(),
                omitted = Math.Max(0, quests.Length - 12)
            },
            mail = new
            {
                receivedFlags = player.mailReceived.Count,
                unread = player.mailbox.Count,
                scheduledForTomorrow = player.mailForTomorrow.Count,
                // mailReceived 同时保存剧情旗标，不应把它计作准确的历史信件封数。
                receivedCountMeaning = "已读邮件及剧情旗标数量，包含非信件旗标"
            },
            social = new
            {
                knownRelationships = player.friendshipData.Count(),
                talkedToday = player.friendshipData.Pairs.Count(p => p.Value.TalkedToToday),
                giftsToday = player.friendshipData.Pairs.Sum(p => p.Value.GiftsToday),
                nearby = nearby.Take(8).Select(n => n is Pet pet ? PetState(pet) : FriendshipState(n)).ToArray(),
                omittedNearby = Math.Max(0, nearby.Length - 8)
            },
            animals = new { nearby = animals.Take(8).Select(AnimalState).ToArray(), omittedNearby = Math.Max(0, animals.Length - 8) }
        };
    }

    // 稳定排序且排除位置/动画/随机显示文本，避免仅走动或读快照被误报为任务、关系变化。
    public static string InteractionSignature() => JsonSerializer.Serialize(new
    {
        quests = Game1.player.questLog.OrderBy(q => q.id.Value, StringComparer.Ordinal).Select(q => new
        {
            id = q.id.Value, accepted = q.accepted.Value, completed = q.completed.Value,
            destroyed = q.destroy.Value, reward = q.moneyReward.Value, daysLeft = q.daysLeft.Value
        }).ToArray(),
        relationships = Game1.player.friendshipData.Pairs.OrderBy(p => p.Key, StringComparer.Ordinal).Select(p => new
        {
            name = p.Key, p.Value.Points, p.Value.TalkedToToday, p.Value.GiftsToday, p.Value.GiftsThisWeek,
            status = p.Value.Status.ToString()
        }).ToArray(),
        animals = Game1.currentLocation.animals.Values.OrderBy(a => a.myID.Value).Select(a => new
        {
            id = a.myID.Value, petted = a.wasPet.Value, autoPetted = a.wasAutoPet.Value,
            friendship = a.friendshipTowardFarmer.Value, produce = a.currentProduce.Value
        }).ToArray(),
        pets = Game1.currentLocation.characters.OfType<Pet>().OrderBy(p => p.petId.Value).Select(p => new
        {
            id = p.petId.Value, friendship = p.friendshipTowardFarmer.Value,
            petDay = p.lastPetDay.TryGetValue(Game1.player.UniqueMultiplayerID, out var day) ? (int?)day : null
        }).ToArray(),
        mail = Game1.player.mailReceived.OrderBy(m => m, StringComparer.Ordinal).ToArray(),
        unreadMail = Game1.player.mailbox.OrderBy(m => m, StringComparer.Ordinal).ToArray()
    });
}
