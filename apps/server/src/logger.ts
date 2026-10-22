/**
 * 日志：同时写标准错误与本机文件；默认脱敏令牌与个人路径。
 * stdio 适配器只把自己的诊断写 stderr——stdout 永远只有 MCP 消息。
 */
import { appendFileSync, existsSync, mkdirSync, renameSync, statSync } from 'node:fs';
import path from 'node:path';
import type { DataPaths } from './paths.js';
import { redactPath } from './paths.js';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const LEVEL_ORDER: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };
const MAX_LOG_BYTES = 8 * 1024 * 1024;

export interface LoggerOptions {
    level?: LogLevel;
    file?: string | null;
    paths?: DataPaths;
    console?: boolean;
    prefix?: string;
}

export class Logger {
    private level: LogLevel;
    private readonly file: string | null;
    private readonly paths?: DataPaths;
    private readonly useConsole: boolean;
    private readonly prefix: string;

    constructor(options: LoggerOptions = {}) {
        this.level = options.level ?? 'info';
        this.file = options.file ?? null;
        this.paths = options.paths;
        this.useConsole = options.console !== false;
        this.prefix = options.prefix ?? 'bridge';
        if (this.file) {
            const dir = path.dirname(this.file);
            if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
        }
    }

    child(prefix: string): Logger {
        const child = new Logger({
            level: this.level,
            file: this.file,
            paths: this.paths,
            console: this.useConsole,
            prefix
        });
        return child;
    }

    setLevel(level: LogLevel): void {
        this.level = level;
    }

    private redact(text: string): string {
        let out = redactPath(text, this.paths);
        out = out.replace(/\b[a-f0-9]{32,128}\b/gi, '<redacted-token>');
        out = out.replace(/Bearer\s+[A-Za-z0-9._-]+/gi, 'Bearer <redacted>');
        return out;
    }

    log(level: LogLevel, message: string, meta?: Record<string, unknown>): void {
        if (LEVEL_ORDER[level] < LEVEL_ORDER[this.level]) return;
        const time = new Date().toISOString();
        let line = `${time} ${level.toUpperCase().padEnd(5)} [${this.prefix}] ${this.redact(message)}`;
        if (meta && Object.keys(meta).length > 0) {
            try {
                line += ` ${this.redact(JSON.stringify(meta))}`;
            } catch {
                line += ' <meta-unserializable>';
            }
        }
        if (this.useConsole) process.stderr.write(`${line}\n`);
        if (this.file) {
            try {
                this.rotateIfNeeded();
                appendFileSync(this.file, `${line}\n`, 'utf8');
            } catch {
                /* 日志失败不影响主流程 */
            }
        }
    }

    private rotateIfNeeded(): void {
        if (!this.file) return;
        try {
            const stat = statSync(this.file);
            if (stat.size > MAX_LOG_BYTES) {
                renameSync(this.file, `${this.file}.1`);
            }
        } catch {
            /* 文件不存在时忽略 */
        }
    }

    debug(message: string, meta?: Record<string, unknown>): void {
        this.log('debug', message, meta);
    }

    info(message: string, meta?: Record<string, unknown>): void {
        this.log('info', message, meta);
    }

    warn(message: string, meta?: Record<string, unknown>): void {
        this.log('warn', message, meta);
    }

    error(message: string, meta?: Record<string, unknown>): void {
        this.log('error', message, meta);
    }
}
