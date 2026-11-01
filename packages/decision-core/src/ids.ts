/**
 * 决策执行器 ID 与散列工具：服务端生成、ASCII、有界；不含路径分隔符或 SQL 注入面。
 * 任务/运行/证据 ID 全部通过 @sab/contracts 的 isDecisionId 校验（80 字符上限）。
 */
import { createHash, randomBytes as cryptoRandomBytes, randomUUID } from "node:crypto";
import { canonicalJson, isDecisionId } from "@sab/contracts";

/** 生成决策域 ID：`p` 前缀保证首字符为字母，整体满足 DECISION_ID_PATTERN。 */
export function newDecisionId(prefix: string): string {
    const clean = prefix.replace(/[^A-Za-z0-9_-]/g, "").slice(0, 12) || "d";
    const id = `p${clean}_${randomUUID().replace(/-/g, "")}`;
    if (!isDecisionId(id)) throw new Error("内部错误：生成了非法决策 ID");
    return id;
}

/** 短期 contextToken：高熵随机串，只存散列，不存明文。 */
export function newContextToken(randomBytes: number): string {
    return cryptoRandomBytes(randomBytes).toString("base64url");
}

export function sha256Hex(text: string): string {
    return createHash("sha256").update(text, "utf8").digest("hex");
}

/** 与 @sab/contracts canonicalJson 一致的规范化（键排序、无空白）。 */
export function canonicalHash(value: unknown): string {
    return sha256Hex(canonicalJson(value));
}

/** 不透明分页游标：base64url(JSON)，不泄露 SQL、rowid 或路径。 */
export function encodeCursor(payload: Record<string, unknown>): string {
    return Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
}

export function decodeCursor(cursor: string): Record<string, unknown> | null {
    if (cursor.length > 200) return null;
    try {
        const text = Buffer.from(cursor, "base64url").toString("utf8");
        if (text.length > 160) return null;
        const parsed: unknown = JSON.parse(text);
        if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return null;
        return parsed as Record<string, unknown>;
    } catch {
        return null;
    }
}

/** 服务端动作 ID：dx 前缀 + run 随机后缀 + 递增序号；≤80 且匹配 ACTION_ID_PATTERN。 */
export function newActionId(runSalt: string, attemptNo: number): string {
    const id = `dx${runSalt}_${attemptNo.toString(36)}`;
    if (id.length > 80 || !/^[A-Za-z0-9_-]{1,80}$/.test(id)) throw new Error("内部错误：生成了非法动作 ID");
    return id;
}
