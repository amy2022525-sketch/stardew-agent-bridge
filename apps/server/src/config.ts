/**
 * 本机配置与凭据存储。
 *
 * - `config.json`：可提交/可复制的非敏感配置（端口、时限、日志级别）。
 * - `credentials.json`：本机凭据（Mod 令牌、各客户端令牌、Web 会话密钥），
 *   仅保存在数据目录，绝不进入仓库、日志或问题包。
 *
 * 写入策略（跨平台一致）：
 * - 同目录临时文件 + fsync + 原子 rename，绝不暴露半截 JSON；
 * - 凭据文件 0600、应用根 0700；已有文件的实际模式会被检查并修正；
 * - 运行中的 Bridge 按「mtimeNs + size」热加载凭据，令牌轮换立即生效，
 *   不会因为时间戳精度不足而漏掉更新。
 */
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { existsSync, readFileSync, statSync } from 'node:fs';
import {
    CONTRACTS_SCHEMA_VERSION,
    DEFAULT_BRIDGE_PORT,
    DEFAULT_MOD_HOST,
    DEFAULT_MOD_PORT,
    LEASE_TTL_MS
} from '@sab/contracts';
import { PRIVATE_FILE_MODE, PUBLIC_FILE_MODE, atomicWriteFile, ensureFileMode, readJsonIfExists } from '@sab/platform';
import type { DataPaths } from './paths.js';

export interface BridgeConfig {
    schemaVersion: number;
    bridgePort: number;
    modPort: number;
    modHost: string;
    leaseTtlMs: number;
    logLevel: 'debug' | 'info' | 'warn' | 'error';
    web: { enabled: boolean };
    dev: { exposeDebugCommands: boolean };
    /**
     * 可选（容器部署）：外部展示根地址，例如 http://127.0.0.1:18055。
     * 缺省时保持原有回环行为；旧 config.json 无此字段也能正常启动。
     * 仅影响展示与配置导出，不影响锁复用、内部探测或 MCP 自检地址。
     */
    publicBaseUrl?: string;
}

export const DEFAULT_CONFIG: BridgeConfig = {
    schemaVersion: CONTRACTS_SCHEMA_VERSION,
    bridgePort: DEFAULT_BRIDGE_PORT,
    modPort: DEFAULT_MOD_PORT,
    modHost: DEFAULT_MOD_HOST,
    leaseTtlMs: LEASE_TTL_MS,
    logLevel: 'info',
    web: { enabled: true },
    dev: { exposeDebugCommands: false }
};

export interface ClientCredential {
    clientId: string;
    clientName: string;
    token: string;
    createdAt: string;
}

export interface CredentialsFile {
    schemaVersion: number;
    modToken: string;
    webSessionSecret: string;
    clients: Record<string, ClientCredential>;
}

function clampInt(value: unknown, fallback: number, min: number, max: number): number {
    const parsed = typeof value === 'number' ? value : Number(value);
    if (!Number.isFinite(parsed)) return fallback;
    return Math.min(max, Math.max(min, Math.trunc(parsed)));
}

export function loadConfig(paths: DataPaths): BridgeConfig {
    let raw: unknown = DEFAULT_CONFIG;
    if (!existsSync(paths.config)) {
        writeFileAtomicSafe(paths.config, `${JSON.stringify(DEFAULT_CONFIG, null, 2)}\n`, PUBLIC_FILE_MODE);
    } else {
        try {
            raw = JSON.parse(readFileSync(paths.config, 'utf8').replace(/^\uFEFF/, ''));
        } catch (error) {
            throw new Error(`config.json 无法解析：${error instanceof Error ? error.message : String(error)}`);
        }
    }
    const record = (raw ?? {}) as Record<string, unknown>;
    const web = (record.web ?? {}) as Record<string, unknown>;
    const dev = (record.dev ?? {}) as Record<string, unknown>;
    const level = record.logLevel;
    // 显式环境优先于持久化展示地址，首次启动也采用同一条解析路径。
    // 非 Docker 启动两者都没有，则保持原有回环行为。
    const publicBaseUrl =
        process.env.SAB_PUBLIC_BASE_URL || (typeof record.publicBaseUrl === 'string' ? record.publicBaseUrl : '');
    return {
        schemaVersion: CONTRACTS_SCHEMA_VERSION,
        bridgePort: clampInt(record.bridgePort, DEFAULT_CONFIG.bridgePort, 1024, 65535),
        modPort: clampInt(record.modPort, DEFAULT_CONFIG.modPort, 1024, 65535),
        modHost: typeof record.modHost === 'string' && record.modHost.length > 0 ? record.modHost : DEFAULT_MOD_HOST,
        leaseTtlMs: clampInt(record.leaseTtlMs, DEFAULT_CONFIG.leaseTtlMs, 30_000, 3_600_000),
        logLevel: level === 'debug' || level === 'info' || level === 'warn' || level === 'error' ? level : 'info',
        web: { enabled: web.enabled !== false },
        dev: { exposeDebugCommands: dev.exposeDebugCommands === true },
        // 可选容器展示地址：非法值不在这里抛错（保持旧启动路径兼容），
        // 由容器预检在业务初始化前用 container-addresses 的严格解析拒绝。
        ...(publicBaseUrl.trim().length > 0 ? { publicBaseUrl: publicBaseUrl.trim() } : {})
    };
}

export function saveConfig(paths: DataPaths, config: BridgeConfig): void {
    writeFileAtomicSafe(paths.config, `${JSON.stringify(config, null, 2)}\n`, PUBLIC_FILE_MODE);
}

function writeFileAtomicSafe(file: string, content: string, mode: number): void {
    atomicWriteFile(file, content, { mode });
}

export function newToken(): string {
    return randomBytes(32).toString('hex');
}

/** 已存在但权限过宽时修正为 0600（只处理本应用自己的文件）。 */
export function enforceCredentialMode(paths: DataPaths): void {
    if (existsSync(paths.credentials)) ensureFileMode(paths.credentials, PRIVATE_FILE_MODE);
}

export function loadCredentials(paths: DataPaths): CredentialsFile {
    if (!existsSync(paths.credentials)) {
        const created: CredentialsFile = {
            schemaVersion: CONTRACTS_SCHEMA_VERSION,
            modToken: newToken(),
            webSessionSecret: newToken(),
            clients: {}
        };
        saveCredentials(paths, created);
        return created;
    }
    enforceCredentialMode(paths);
    const parsed = (readJsonIfExists<Partial<CredentialsFile>>(paths.credentials) ?? {}) as Partial<CredentialsFile>;
    const credentials: CredentialsFile = {
        schemaVersion: CONTRACTS_SCHEMA_VERSION,
        modToken: typeof parsed.modToken === 'string' && parsed.modToken.length >= 16 ? parsed.modToken : newToken(),
        webSessionSecret:
            typeof parsed.webSessionSecret === 'string' && parsed.webSessionSecret.length >= 16
                ? parsed.webSessionSecret
                : newToken(),
        clients: parsed.clients && typeof parsed.clients === 'object' ? parsed.clients : {}
    };
    if (credentials.modToken !== parsed.modToken || credentials.webSessionSecret !== parsed.webSessionSecret) {
        saveCredentials(paths, credentials);
    }
    return credentials;
}

export function saveCredentials(paths: DataPaths, credentials: CredentialsFile): void {
    writeFileAtomicSafe(paths.credentials, `${JSON.stringify(credentials, null, 2)}\n`, PRIVATE_FILE_MODE);
}

/** 常量时间比较，避免本地时序侧信道。 */
export function secureEqual(a: string, b: string): boolean {
    const left = Buffer.from(a);
    const right = Buffer.from(b);
    if (left.length !== right.length) return false;
    return timingSafeEqual(left, right);
}

export interface ResolvedClient {
    clientId: string;
    clientName: string;
    credential: ClientCredential;
}

export class AuthStore {
    private readonly paths: DataPaths;
    private credentials: CredentialsFile;
    private loadedStamp: string;

    constructor(paths: DataPaths) {
        this.paths = paths;
        this.credentials = loadCredentials(paths);
        this.loadedStamp = stampOf(paths.credentials);
    }

    /**
     * credentials.json 也由 CLI 子进程写入（token issue/rotate/revoke）。
     * 这里按「mtimeNs + size」热加载：原子替换与令牌轮换都会立刻生效，
     * 不依赖毫秒级时间戳的精度。
     */
    private refresh(): void {
        const stamp = stampOf(this.paths.credentials);
        if (stamp === this.loadedStamp) return;
        try {
            this.credentials = loadCredentials(this.paths);
            this.loadedStamp = stampOf(this.paths.credentials);
        } catch {
            /* 文件正在被替换：保留上一次成功读取的结果。 */
        }
    }

    get modToken(): string {
        this.refresh();
        return this.credentials.modToken;
    }

    get webSessionSecret(): string {
        this.refresh();
        return this.credentials.webSessionSecret;
    }

    listClients(): ClientCredential[] {
        this.refresh();
        return Object.values(this.credentials.clients);
    }

    issue(clientId: string, clientName?: string): ClientCredential {
        this.refresh();
        const existing = this.credentials.clients[clientId];
        const credential: ClientCredential = {
            clientId,
            clientName: clientName ?? existing?.clientName ?? clientId,
            token: existing?.token ?? newToken(),
            createdAt: existing?.createdAt ?? new Date().toISOString()
        };
        this.credentials.clients[clientId] = credential;
        saveCredentials(this.paths, this.credentials);
        this.loadedStamp = stampOf(this.paths.credentials);
        return credential;
    }

    rotate(clientId: string): ClientCredential {
        this.refresh();
        const existing = this.credentials.clients[clientId];
        const credential: ClientCredential = {
            clientId,
            clientName: existing?.clientName ?? clientId,
            token: newToken(),
            createdAt: new Date().toISOString()
        };
        this.credentials.clients[clientId] = credential;
        saveCredentials(this.paths, this.credentials);
        this.loadedStamp = stampOf(this.paths.credentials);
        return credential;
    }

    revoke(clientId: string): void {
        this.refresh();
        delete this.credentials.clients[clientId];
        saveCredentials(this.paths, this.credentials);
        this.loadedStamp = stampOf(this.paths.credentials);
    }

    /** 校验 Bearer 令牌；返回归属的客户端。 */
    verifyBearer(header: string | null | undefined): ResolvedClient | null {
        if (!header) return null;
        const match = /^Bearer\s+(.+)$/i.exec(header.trim());
        if (!match?.[1]) return null;
        const token = match[1].trim();
        this.refresh();
        for (const credential of Object.values(this.credentials.clients)) {
            if (secureEqual(credential.token, token)) {
                return { clientId: credential.clientId, clientName: credential.clientName, credential };
            }
        }
        return null;
    }
}

/** 变更指纹：优先用纳秒级 mtime，退回毫秒；始终附带文件大小。 */
function stampOf(file: string): string {
    try {
        const stat = statSync(file, { bigint: true });
        return `${stat.mtimeNs ?? ''}:${stat.size ?? ''}`;
    } catch {
        try {
            const stat = statSync(file);
            return `${stat.mtimeMs}:${stat.size}`;
        } catch {
            return '0:0';
        }
    }
}
