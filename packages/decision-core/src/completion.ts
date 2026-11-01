/**
 * 完成判定（§14）：4 种确定性条件，全部 AND；缺字段/未覆盖/截断/世界不符/过期 = unverifiable。
 * 只接受有限枚举，不接受表达式/JSONPath/SQL。有未决动作时不得 verified completed。
 */
import type { CriterionResult, SnapshotSummary, TaskSuccessCriterion } from "@sab/contracts";
import { compareGameDates } from "./internal-date.js";

import type { TileWaterStamp } from "./internal-date.js";

export interface FreshObservation {
    snapshot: SnapshotSummary;
    observedAtMs: number;
}

export interface CompletionContext {
    /** 任务作用域内按 tile key（`loc,x,y`）聚合的同日新鲜观察。 */
    tileObservations: Map<string, TileWaterStamp>;
    /** 完成前重新观察得到的最新快照（§14.1 finish 后必须重新观察再验证）。 */
    latest: FreshObservation;
    scopeMatchesWorld: boolean;
    unresolvedActionIds: string[];
    nowMs: number;
    /** 观察有效期：超过即过期（由调用方按策略传入，默认 5 分钟）。 */
    evidenceMaxAgeMs: number;
}

export interface CompletionEvaluation {
    results: CriterionResult[];
    allMet: boolean;
    anyUnverifiable: boolean;
    /** manual_review-only 任务永远只能出候选。 */
    manualOnly: boolean;
    notes: string[];
}

function tileKey(loc: string, x: number, y: number): string {
    return `${loc},${String(x)},${String(y)}`;
}

function isFiniteInt(v: unknown): v is number {
    return typeof v === "number" && Number.isInteger(v) && Number.isFinite(v);
}

export function evaluateCriteria(criteria: TaskSuccessCriterion[], ctx: CompletionContext): CompletionEvaluation {
    const results: CriterionResult[] = [];
    const notes: string[] = [];
    const snap = ctx.latest.snapshot;
    const stale = ctx.nowMs - ctx.latest.observedAtMs > ctx.evidenceMaxAgeMs;
    let manualCount = 0;

    criteria.forEach((criterion, index) => {
        switch (criterion.kind) {
            case "at_tile": {
                if (!isFiniteInt(criterion.x) || !isFiniteInt(criterion.y) || !criterion.location) {
                    results.push({ index, status: "unverifiable", evidenceIds: [] });
                    notes.push(`条件#${String(index)} 坐标非法`);
                    return;
                }
                const tolerance = criterion.tolerance ?? 0;
                if (tolerance < 0 || tolerance > 1) {
                    results.push({ index, status: "unverifiable", evidenceIds: [] });
                    notes.push(`条件#${String(index)} tolerance 超出 0–1`);
                    return;
                }
                if (stale || !ctx.scopeMatchesWorld || snap.truncated || snap.date === null || snap.player?.position == null) {
                    results.push({ index, status: "unverifiable", evidenceIds: [] });
                    return;
                }
                if (snap.location !== criterion.location) {
                    results.push({ index, status: "not_met", evidenceIds: [snap.snapshotId] });
                    return;
                }
                const dx = Math.abs(snap.player.position.x - criterion.x);
                const dy = Math.abs(snap.player.position.y - criterion.y);
                const met = dx + dy <= tolerance;
                results.push({ index, status: met ? "met" : "not_met", evidenceIds: [snap.snapshotId] });
                return;
            }
            case "inventory_at_least": {
                if (typeof criterion.itemId !== "string" || criterion.itemId.length === 0 || !Number.isInteger(criterion.count) || criterion.count < 0) {
                    results.push({ index, status: "unverifiable", evidenceIds: [] });
                    return;
                }
                if (stale || !ctx.scopeMatchesWorld || snap.truncated) {
                    results.push({ index, status: "unverifiable", evidenceIds: [] });
                    notes.push(`条件#${String(index)} 快照过期/截断/世界不符`);
                    return;
                }
                let total = 0;
                for (const entry of snap.inventory) {
                    if (entry.itemId !== criterion.itemId) continue; // 不从显示名猜 ID
                    if (criterion.quality !== undefined && entry.quality !== criterion.quality) continue;
                    total += entry.count;
                }
                const met = total >= criterion.count;
                results.push({ index, status: met ? "met" : "not_met", evidenceIds: [snap.snapshotId] });
                if (met) notes.push(`条件#${String(index)} 为当前存量，不代表全部由本任务获取`);
                return;
            }
            case "crop_tiles_watered": {
                if (!criterion.location || !Array.isArray(criterion.tiles) || criterion.tiles.length === 0 || criterion.tiles.length > 64) {
                    results.push({ index, status: "unverifiable", evidenceIds: [] });
                    return;
                }
                if (!ctx.scopeMatchesWorld || snap.date === null) {
                    results.push({ index, status: "unverifiable", evidenceIds: [] });
                    return;
                }
                const evidenceIds: string[] = [];
                let allCovered = true;
                let allMet = true;
                for (const tile of criterion.tiles) {
                    if (!isFiniteInt(tile.x) || !isFiniteInt(tile.y)) { allCovered = false; break; }
                    const key = tileKey(criterion.location, tile.x, tile.y);
                    const obs = ctx.tileObservations.get(key);
                    const sameDay = obs !== undefined && compareGameDates(obs, snap.date) === "same";
                    if (!obs || !sameDay || ctx.nowMs - obs.observedAtMs > ctx.evidenceMaxAgeMs) {
                        allCovered = false;
                        break;
                    }
                    // 无作物 ≠ 满足；必须存在目标作物且 watered=true。
                    if (!obs.hasCrop || !obs.watered) allMet = false;
                    evidenceIds.push(`tile:${key}@${new Date(obs.observedAtMs).toISOString()}`);
                }
                if (!allCovered) {
                    results.push({ index, status: "unverifiable", evidenceIds: [] });
                    notes.push(`条件#${String(index)} 有地块未被同日完整观察，不能推断全浇完`);
                } else {
                    results.push({ index, status: allMet ? "met" : "not_met", evidenceIds });
                }
                return;
            }
            case "manual_review": {
                manualCount += 1;
                results.push({ index, status: "unverifiable", evidenceIds: [] });
                notes.push("manual_review 只生成完成候选，须主模型/Web 审核后标 main_reviewed");
                return;
            }
            default: {
                results.push({ index, status: "unverifiable", evidenceIds: [] });
                notes.push("未知条件类型");
            }
        }
    });

    const anyUnverifiable = results.some((r) => r.status === "unverifiable");
    const allMet = !anyUnverifiable && results.length > 0 && results.every((r) => r.status === "met");
    // 有未决动作时不得宣称 verified 完成。
    const finalAllMet = allMet && ctx.unresolvedActionIds.length === 0;
    if (allMet && ctx.unresolvedActionIds.length > 0) notes.push("存在未决动作，verified 完成被阻止");
    return { results, allMet: finalAllMet, anyUnverifiable, manualOnly: manualCount === criteria.length, notes };
}

export function hasManualCriterion(criteria: TaskSuccessCriterion[]): boolean {
    return criteria.some((c) => c.kind === "manual_review");
}
