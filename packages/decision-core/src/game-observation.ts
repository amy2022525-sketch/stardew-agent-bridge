/** Read-only facts shared by watering guards and completion checks. */
import type { EntitySummary, SnapshotSummary } from '@sab/contracts';

/** Native SMAPI snapshots describe planted HoeDirt as soil, not crop. */
export function hasLiveCrop(entity: EntitySummary): boolean {
    const state = entity.cropState;
    if (state && typeof state === 'object' && !Array.isArray(state)
        && (state as Record<string, unknown>).dead === true) return false;
    return entity.kind === 'crop'
        || (typeof entity.crop === 'string' && entity.crop.length > 0)
        || (state !== null && typeof state === 'object' && !Array.isArray(state)
            && typeof (state as Record<string, unknown>).itemId === 'string');
}

export function toolForSlot(snapshot: SnapshotSummary, slot: string): 'watering_can' | 'other' | 'unknown' {
    const index = Number(slot);
    if (!Number.isInteger(index) || index < 0) return 'unknown';
    const entry = snapshot.inventory.find(item => item.slot === index);
    if (!entry) return 'unknown';
    if (entry.tool === 'WateringCan' || entry.tool === 'watering_can' || entry.itemId === '(T)WateringCan') return 'watering_can';
    return 'other';
}

/** Only observed dry crops and native refillable tiles are watering targets. */
export function wateringTargets(snapshot: SnapshotSummary): Set<string> {
    return new Set(snapshot.entities.filter(entity => {
        if (entity.refillable === true) return true;
        return hasLiveCrop(entity) && (entity.needsWater === true
            || (entity.needsWater !== false && entity.watered === false));
    }).map(entity => entity.ref));
}

function withoutRefs(value: unknown): unknown {
    if (Array.isArray(value)) return value.map(withoutRefs);
    if (value && typeof value === 'object') {
        return Object.fromEntries(Object.entries(value).filter(([key]) => key !== 'ref').map(([key, item]) => [key, withoutRefs(item)]));
    }
    return value;
}

/** Re-observe after model latency; rebind only provably identical static targets. */
export function refreshActionArgs(before: SnapshotSummary, now: SnapshotSummary, tool: string, args: Record<string, unknown>): Record<string, unknown> | null {
    for (const key of ['instanceId', 'worldGeneration', 'sceneGeneration', 'location', 'date', 'time', 'player', 'inventory', 'menu'] as const) {
        if (JSON.stringify(withoutRefs(before[key])) !== JSON.stringify(withoutRefs(now[key]))) return null;
    }
    const updated = { ...args };
    for (const key of ['target', 'near']) {
        const reference = args[key];
        if (typeof reference !== 'string') continue;
        const original = [...before.entities, ...before.exits].find(entity => entity.ref === reference);
        if (!original) return null;
        const candidates = [...now.entities, ...now.exits].filter(entity => entity.kind === original.kind
            && entity.tile.x === original.tile.x && entity.tile.y === original.tile.y
            && JSON.stringify(withoutRefs(entity)) === JSON.stringify(withoutRefs(original)));
        const candidate = candidates[0];
        if (!candidate) return null;
        const staticTarget = ['soil', 'tile', 'water', 'terrain', 'exit', 'door', 'building', 'shippingBin', 'crop'].includes(original.kind);
        if (!staticTarget && !(tool === 'stardew_move' && key === 'near') && candidate.ref !== reference) return null;
        updated[key] = candidate.ref;
    }
    return updated;
}
