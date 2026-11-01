/**
 * 决策执行器凭据（§11.4）：独立私密文件 `<dataRoot>/decision/secrets.json`。
 *
 * - 只保存本项目管理的 secretRef → 值映射，不是任意文件路径或环境变量名。
 * - 写入后只返回 configured:true，绝不回传明文、可复制字段或写进 localStorage。
 * - Linux 私密目录 0700、凭据文件 0600；只修正本应用目录，不 chmod 父目录。
 * - 容器部署可选 `secretFile`（白名单 `<secretDir>/<name>`）作为只读来源。
 * - 错误摘要与日志永远不包含密钥内容。
 */
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { BridgeError } from '@sab/contracts';
import { PRIVATE_FILE_MODE, atomicWriteFile, ensureFileMode } from '@sab/platform';
import type { DataPaths } from './paths.js';
import type { DecisionProviderEntry } from './decision-config.js';

export const SECRETS_SCHEMA_VERSION = 1;
const SECRET_MIN_LENGTH = 8;
const SECRET_MAX_LENGTH = 4096;
const SECRET_REF_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/;

interface SecretEntry {
    value: string;
    updatedAt: string;
}

interface SecretsFile {
    schemaVersion: number;
    entries: Record<string, SecretEntry>;
}

export interface DecisionSecretOptions {
    /** 容器部署的只读凭据目录白名单；默认 /run/secrets。 */
    secretDir?: string;
}

export class DecisionSecretStore {
    private readonly file: string;
    private readonly secretDir: string;

    constructor(private readonly paths: DataPaths, options: DecisionSecretOptions = {}) {
        this.file = paths.decisionSecrets;
        this.secretDir = options.secretDir ?? '/run/secrets';
    }

    private load(): SecretsFile {
        if (!existsSync(this.file)) return { schemaVersion: SECRETS_SCHEMA_VERSION, entries: {} };
        try {
            ensureFileMode(this.file, PRIVATE_FILE_MODE);
            const parsed = JSON.parse(readFileSync(this.file, 'utf8').replace(/^\uFEFF/, '')) as Partial<SecretsFile>;
            const entries: Record<string, SecretEntry> = {};
            for (const [ref, entry] of Object.entries(parsed.entries ?? {})) {
                if (typeof entry?.value === 'string' && entry.value.length > 0) {
                    entries[ref] = { value: entry.value, updatedAt: typeof entry.updatedAt === 'string' ? entry.updatedAt : new Date(0).toISOString() };
                }
            }
            return { schemaVersion: SECRETS_SCHEMA_VERSION, entries };
        } catch (error) {
            // 损坏文件不删除、不重建：直接拒绝使用凭据，让用户明确处理。
            throw new BridgeError('PROVIDER_NOT_CONFIGURED', '执行模型凭据文件无法解析，请清除后重新写入。', {
                detail: { reason: error instanceof Error ? error.message.slice(0, 120) : 'parse error' }
            });
        }
    }

    private persist(file: SecretsFile): void {
        atomicWriteFile(this.file, `${JSON.stringify(file, null, 2)}\n`, { mode: PRIVATE_FILE_MODE });
    }

    /** provider 是否已有可用凭据（本项目记录或白名单 secret-file）；不返回内容。 */
    hasProvider(config: DecisionProviderEntry): boolean {
        return this.resolve(config) !== null;
    }

    has(secretRef: string | null): boolean {
        if (secretRef === null) return false;
        try {
            return typeof this.load().entries[secretRef]?.value === 'string';
        } catch {
            return false;
        }
    }

    /** 写入/替换：只返回是否已配置，不回显任何明文。 */
    set(secretRef: string, value: string): { configured: true } {
        if (!SECRET_REF_RE.test(secretRef)) throw new BridgeError('INVALID_ARGUMENT', 'secretRef 非法。');
        if (typeof value !== 'string' || value.length < SECRET_MIN_LENGTH) throw new BridgeError('INVALID_ARGUMENT', '密钥长度过短（至少 8 个字符）。');
        if (value.length > SECRET_MAX_LENGTH) throw new BridgeError('INVALID_ARGUMENT', '密钥过长。');
        const file = this.load();
        file.entries[secretRef] = { value, updatedAt: new Date().toISOString() };
        this.persist(file);
        return { configured: true };
    }

    clear(secretRef: string): { configured: false } {
        if (!SECRET_REF_RE.test(secretRef)) throw new BridgeError('INVALID_ARGUMENT', 'secretRef 非法。');
        const file = this.load();
        if (file.entries[secretRef]) {
            delete file.entries[secretRef];
            this.persist(file);
        }
        return { configured: false };
    }

    /**
     * 取 Authorization 值。authMode:none 显式返回 null（不把缺 Key 静默当成匿名调用）。
     * 优先 secretFile（只读白名单），其次本项目管理的凭据记录。
     */
    authorizationHeader(config: DecisionProviderEntry): string | null {
        if (config.authMode === 'none') return null;
        const value = this.resolve(config);
        if (value === null) return null;
        return `Bearer ${value}`;
    }

    resolve(config: DecisionProviderEntry): string | null {
        if (config.secretFile) {
            const fromFile = this.readSecretFile(config.secretFile);
            if (fromFile !== null) return fromFile;
        }
        if (config.secretRef === null) return null;
        try {
            return this.load().entries[config.secretRef]?.value ?? null;
        } catch {
            return null;
        }
    }

    /** 只读 secret-file：路径必须在白名单目录内且不跟随 `..`。 */
    private readSecretFile(declared: string): string | null {
        const base = path.resolve(this.secretDir);
        const target = path.resolve(declared);
        const relative = path.relative(base, target);
        if (relative.startsWith('..') || path.isAbsolute(relative) || relative.length === 0) {
            return null;
        }
        try {
            if (!existsSync(target)) return null;
            const text = readFileSync(target, 'utf8').trim();
            return text.length > 0 ? text : null;
        } catch {
            return null;
        }
    }
}
