/**
 * 本机配置与凭据存储。
 *
 * - `config.json`：可提交/可复制的非敏感配置（端口、时限、日志级别）。
 * - `credentials.json`：本机凭据（Mod 令牌、各客户端令牌、Web 会话密钥），
 *   仅保存在数据目录，绝不进入仓库、日志或问题包。
 */
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { existsSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import {
    CONTRACTS_SCHEMA_VERSION,
    DEFAULT_BRIDGE_PORT,
    DEFAULT_MOD_HOST,
    DEFAULT_MOD_PORT,
    LEASE_TTL_MS
} from '@sab/contracts';
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
    if (!existsSync(paths.config)) {
        writeFileSync(paths.config, JSON.stringify(DEFAULT_CONFIG, null, 2), 'utf8');
        return { ...DEFAULT_CONFIG };
    }
    let raw: unknown;
    try {
        raw = JSON.parse(readFileSync(paths.config, 'utf8'));
    } catch (error) {
        throw new Error(`config.json 无法解析：${error instanceof Error ? error.message : String(error)}`);
    }
    const record = (raw ?? {}) as Record<string, unknown>;
    const web = (record.web ?? {}) as Record<string, unknown>;
    const dev = (record.dev ?? {}) as Record<string, unknown>;
    const level = record.logLevel;
    return {
        schemaVersion: CONTRACTS_SCHEMA_VERSION,
        bridgePort: clampInt(record.bridgePort, DEFAULT_CONFIG.bridgePort, 1024, 65535),
        modPort: clampInt(record.modPort, DEFAULT_CONFIG.modPort, 1024, 65535),
        modHost: typeof record.modHost === 'string' && record.modHost.length > 0 ? record.modHost : DEFAULT_MOD_HOST,
        leaseTtlMs: clampInt(record.leaseTtlMs, DEFAULT_CONFIG.leaseTtlMs, 30_000, 3_600_000),
        logLevel: level === 'debug' || level === 'info' || level === 'warn' || level === 'error' ? level : 'info',
        web: { enabled: web.enabled !== false },
        dev: { exposeDebugCommands: dev.exposeDebugCommands === true }
    };
}

export function saveConfig(paths: DataPaths, config: BridgeConfig): void {
    writeFileSync(paths.config, JSON.stringify(config, null, 2), 'utf8');
}

export function newToken(): string {
    return randomBytes(32).toString('hex');
}

export function loadCredentials(paths: DataPaths): CredentialsFile {
    if (!existsSync(paths.credentials)) {
        const created: CredentialsFile = {
            schemaVersion: CONTRACTS_SCHEMA_VERSION,
            modToken: newToken(),
            webSessionSecret: newToken(),
            clients: {}
        };
        writeFileSync(paths.credentials, JSON.stringify(created, null, 2), { encoding: 'utf8', mode: 0o600 });
        return created;
    }
    const parsed = JSON.parse(readFileSync(paths.credentials, 'utf8')) as Partial<CredentialsFile>;
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
    writeFileSync(paths.credentials, JSON.stringify(credentials, null, 2), { encoding: 'utf8', mode: 0o600 });
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
    private loadedStamp: number;

    constructor(paths: DataPaths) {
        this.paths = paths;
        this.credentials = loadCredentials(paths);
        this.loadedStamp = stampOf(paths.credentials);
    }

    /**
     * credentials.json 也由 CLI 子进程写入（token issue/rotate/revoke）。
     * 这里按文件修改时间热加载，运行中的 Bridge 才能立刻接受新令牌或拒绝已吊销令牌。
     */
    private refresh(): void {
        const stamp = stampOf(this.paths.credentials);
        if (stamp === this.loadedStamp) return;
        try {
            this.credentials = loadCredentials(this.paths);
            this.loadedStamp = stampOf(this.paths.credentials);
        } catch {
            /* 文件正在被写入：保留上一次成功读取的结果。 */
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

function stampOf(file: string): number {
    try {
        return statSync(file).mtimeMs;
    } catch {
        return 0;
    }
}
