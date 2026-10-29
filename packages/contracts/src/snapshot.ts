/**
 * Mod 原始快照 → 契约快照摘要 → 文字渲染 / 输出限制。
 *
 * Mod 返回的是游戏内真实观察结果；这里只做归一化、排序与裁剪，不改变事实。
 */
import {
    SNAPSHOT_COMPACT_TARGET_BYTES,
    SNAPSHOT_HARD_LIMIT_BYTES,
    type EntitySummary,
    type InventoryEntry,
    type SnapshotSummary
} from './protocol.js';
import { isActorContext } from './multiplayer.js';

type Raw = Record<string, unknown>;

function num(value: unknown): number | null {
    return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function str(value: unknown): string | null {
    return typeof value === 'string' ? value : null;
}

function asRaw(value: unknown): Raw | null {
    return value && typeof value === 'object' && !Array.isArray(value) ? (value as Raw) : null;
}

function normalizeEntity(value: unknown): EntitySummary | null {
    const raw = asRaw(value);
    if (!raw) return null;
    const ref = str(raw.ref);
    const tile = asRaw(raw.tile);
    if (!ref || !tile) return null;
    const entity: EntitySummary = {
        ref,
        kind: str(raw.kind) ?? 'unknown',
        name: str(raw.name) ?? '',
        tile: { x: num(tile.x) ?? 0, y: num(tile.y) ?? 0 }
    };
    if (typeof raw.passable === 'boolean') entity.passable = raw.passable;
    const action = str(raw.action);
    if (action) entity.action = action;
    for (const [key, entry] of Object.entries(raw)) {
        if (key in entity) continue;
        if (entry === null || entry === undefined) continue;
        entity[key] = entry;
    }
    return entity;
}

function normalizeInventory(value: unknown): InventoryEntry[] {
    if (!Array.isArray(value)) return [];
    const out: InventoryEntry[] = [];
    for (const entry of value) {
        const raw = asRaw(entry);
        if (!raw) continue;
        const slot = num(raw.slot);
        const itemId = str(raw.itemId);
        if (slot === null || !itemId) continue;
        const item: InventoryEntry = {
            slot,
            itemId,
            name: str(raw.name) ?? itemId,
            count: num(raw.count) ?? 0
        };
        const quality = num(raw.quality);
        if (quality !== null) item.quality = quality;
        const category = num(raw.category);
        if (category !== null) item.category = category;
        const tool = str(raw.tool);
        if (tool) item.tool = tool;
        const water = num(raw.water);
        if (water !== null) item.water = water;
        const capacity = num(raw.waterCapacity);
        if (capacity !== null) item.waterCapacity = capacity;
        out.push(item);
    }
    return out.sort((a, b) => a.slot - b.slot);
}

export interface NormalizeContext {
    /** Bridge 维护的场景代次（地图切换时递增）。 */
    sceneGeneration: number;
    sampledAt?: string;
}

/** 把 Mod 快照归一化为契约类型；缺失字段保持 null，不猜测。 */
export function normalizeSnapshot(rawInput: unknown, ctx: NormalizeContext): SnapshotSummary {
    const raw = asRaw(rawInput) ?? {};
    const player = asRaw(raw.player);
    const position = player ? asRaw(player.position) : null;
    const date = asRaw(raw.date);
    const control = asRaw(raw.control);
    const menu = asRaw(raw.menu);
    const observation = asRaw(raw.observation);
    const navigation = asRaw(raw.navigation);

    const entities: EntitySummary[] = [];
    if (Array.isArray(raw.entities)) {
        for (const entry of raw.entities) {
            const normalized = normalizeEntity(entry);
            if (normalized) entities.push(normalized);
        }
    }
    const exits: EntitySummary[] = [];
    if (navigation && Array.isArray(navigation.exits)) {
        for (const entry of navigation.exits) {
            const normalized = normalizeEntity(entry);
            if (normalized) exits.push(normalized);
        }
    }

    let menuSummary: SnapshotSummary['menu'] = null;
    if (menu) {
        const options: { ref: string; label: string }[] = [];
        if (Array.isArray(menu.options)) {
            for (const option of menu.options) {
                const rawOption = asRaw(option);
                const ref = rawOption ? str(rawOption.ref) : null;
                if (!rawOption || !ref) continue;
                options.push({ ref, label: str(rawOption.label) ?? '' });
            }
        }
        menuSummary = {
            type: str(menu.type) ?? 'unknown',
            text: str(menu.text) ?? '',
            options
        };
    }

    const shippingRaw = raw.shipping;
    const shipping = Array.isArray(shippingRaw)
        ? shippingRaw
              .map((entry) => asRaw(entry))
              .filter((entry): entry is Raw => entry !== null)
              .map((entry) => ({
                  itemId: str(entry.itemId) ?? '',
                  count: num(entry.count) ?? 0,
                  quality: num(entry.quality) ?? 0
              }))
        : null;

    return {
        multiplayer: asRaw(raw.multiplayer) ? { actorContext: isActorContext(asRaw(raw.multiplayer)?.actor) ? asRaw(raw.multiplayer)!.actor as import('./multiplayer.js').ActorContext : null,
            observationScope: 'local_actor_and_visible_world', worldClock: 'not_globally_paused' } : undefined,
        snapshotId: str(raw.snapshotId) ?? 's0',
        instanceId: str(raw.instanceId) ?? 'unknown',
        worldGeneration: num(raw.saveGeneration) ?? 0,
        sceneGeneration: ctx.sceneGeneration,
        location: str(raw.location) ?? 'unknown',
        date: date
            ? { season: str(date.season) ?? 'unknown', day: num(date.day) ?? 0, year: num(date.year) ?? 0 }
            : null,
        time: num(raw.time),
        player: player
            ? {
                  name: str(player.name) ?? 'unknown',
                  money: num(player.money),
                  health: num(player.health),
                  maxHealth: num(player.maxHealth),
                  energy: num(player.energy),
                  maxEnergy: num(player.maxEnergy),
                  position: position ? { x: num(position.x) ?? 0, y: num(position.y) ?? 0 } : null,
                  selectedSlot: num(player.selectedSlot),
                  maxItems: num(player.maxItems)
              }
            : null,
        inventory: normalizeInventory(raw.inventory),
        entities,
        exits,
        menu: menuSummary,
        control: {
            ready: control ? control.ready === true : false,
            blockedBy: control && Array.isArray(control.blockedBy) ? control.blockedBy.map((v) => String(v)) : []
        },
        shipping,
        truncated: observation ? observation.truncated === true : false,
        sampledAt: ctx.sampledAt ?? new Date().toISOString()
    };
}

const KIND_LABEL: Record<string, string> = {
    object: '对象',
    action: '交互点',
    soil: '耕地',
    terrain: '地形',
    tile: '地块',
    water: '水面',
    npc: 'NPC',
    monster: '怪物',
    animal: '动物',
    building: '建筑',
    door: '门',
    shippingBin: '出货箱',
    mailbox: '信箱',
    furniture: '家具',
    bed: '床',
    exit: '出口',
    menu: '菜单'
};

function describeEntity(entity: EntitySummary, compact = false): string {
    const label = KIND_LABEL[entity.kind] ?? entity.kind;
    const bits: string[] = [`${entity.ref}=${label}:${entity.name || '?'}@(${entity.tile.x},${entity.tile.y})`];
    if (entity.action) bits.push(`action=${String(entity.action).slice(0, 40)}`);
    if (entity.readyToHarvest === true) bits.push('可采收');
    if (entity.needsWater === true) bits.push('需浇水');
    if (entity.tilled === true) bits.push(entity.watered === true ? '已浇水' : '未浇水');
    if (entity.artifactSpot === true) bits.push('古物点');
    if (entity.diggable === true) bits.push('可挖');
    if (entity.fishable === true) bits.push('可钓');
    if (typeof entity.health === 'number') bits.push(`hp=${entity.health}`);
    if (entity.passable === false) bits.push('不可通行');
    if (entity.pettedToday === true) bits.push('已抚摸');
    if (!compact && typeof entity.itemId === 'string') bits.push(`item=${entity.itemId}`);
    return bits.join(' ');
}

/** 渲染为紧凑文字，供文字模型直接决策；不丢失导航与引用信息。 */
export function renderSnapshotText(summary: SnapshotSummary): string {
    const lines: string[] = [];
    const date = summary.date ? `${summary.date.season} ${summary.date.day} 日, 第 ${summary.date.year} 年` : '日期未知';
    const clock = summary.time !== null ? `${String(Math.floor(summary.time / 100)).padStart(2, '0')}:${String(summary.time % 100).padStart(2, '0')}` : '--:--';
    lines.push(`【观察】${summary.location} ${date} ${clock}  snapshot=${summary.snapshotId} world=${summary.worldGeneration} scene=${summary.sceneGeneration}`);
    if (summary.player) {
        const p = summary.player;
        const pos = p.position ? `(${p.position.x},${p.position.y})` : '(?,?)';
        lines.push(
            `【角色】${p.name} ${pos} 金币=${p.money ?? '?'} 生命=${p.health ?? '?'}/${p.maxHealth ?? '?'} 体力=${p.energy ?? '?'}/${p.maxEnergy ?? '?'} 选中槽=${p.selectedSlot ?? '?'}`
        );
    }
    if (summary.control.blockedBy.length > 0) lines.push(`【阻塞】${summary.control.blockedBy.join(',')}`);
    if (summary.inventory.length > 0) {
        lines.push(
            `【背包】${summary.inventory
                .map((item) => `${item.slot}:${item.name}x${item.count}${item.tool ? `(${item.tool}${item.water !== undefined ? ` 水${item.water}/${item.waterCapacity}` : ''})` : ''}`)
                .join(' | ')}`
        );
    } else {
        lines.push('【背包】空');
    }
    if (summary.menu) {
        lines.push(`【菜单】${summary.menu.type}${summary.menu.text ? `: ${summary.menu.text.replace(/\s+/g, ' ').slice(0, 240)}` : ''}`);
        for (const option of summary.menu.options) lines.push(`  - ${option.ref} ${option.label}`);
    }
    if (summary.entities.length > 0) {
        lines.push(`【附近 ${summary.entities.length} 项】`);
        for (const entity of summary.entities) lines.push(`  - ${describeEntity(entity)}`);
    }
    if (summary.exits.length > 0) {
        lines.push(`【出口 ${summary.exits.length} 个】`);
        for (const exit of summary.exits) lines.push(`  - ${describeEntity(exit, true)}`);
    }
    if (summary.shipping) {
        lines.push(`【出货箱】${summary.shipping.length === 0 ? '空' : summary.shipping.map((s) => `${s.itemId}x${s.count}`).join(', ')}`);
    }
    if (summary.truncated) lines.push('【提示】观察范围未覆盖整张地图，换图请使用出口引用或 move。');
    return lines.join('\n');
}

export function byteLength(value: unknown): number {
    return Buffer.byteLength(typeof value === 'string' ? value : JSON.stringify(value), 'utf8');
}

export interface TrimResult<T> {
    value: T;
    bytes: number;
    truncated: boolean;
}

/**
 * 输出限制：超过硬上限时裁剪实体列表（保留出口、菜单与角色信息），
 * 并明确标记 truncated，绝不在不告知的情况下丢失导航字段。
 */
export function trimSnapshotText(text: string, limit: number = SNAPSHOT_HARD_LIMIT_BYTES): TrimResult<string> {
    const bytes = Buffer.byteLength(text, 'utf8');
    if (bytes <= limit) return { value: text, bytes, truncated: false };
    const keepRatio = limit / bytes;
    const lines = text.split('\n');
    const keep = Math.max(20, Math.floor(lines.length * keepRatio));
    const head = lines.slice(0, keep);
    head.push(`【裁剪】输出超过 ${limit} 字节上限，已截断 ${lines.length - keep} 行；请缩小 radius 或分批观察。`);
    const value = head.join('\n');
    return { value, bytes: Buffer.byteLength(value, 'utf8'), truncated: true };
}

export function compactTarget(): number {
    return SNAPSHOT_COMPACT_TARGET_BYTES;
}
