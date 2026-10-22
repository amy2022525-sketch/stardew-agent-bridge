/**
 * 常驻 Bridge：装配 Mod 客户端、账本、控制权、动作服务与 MCP 传输，
 * 并对外提供 `/mcp`、`/api/v1` 与 Web 静态页面。
 *
 * 只有这一处装配业务对象：HTTP MCP、stdio 适配器与 Web 共用同一实例。
 */
import { createHmac, randomUUID } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import {
    createMcpHandler,
    hostHeaderValidationResponse,
    localhostAllowedHostnames,
    localhostAllowedOrigins,
    originValidationResponse
} from '@modelcontextprotocol/server';
import {
    BRIDGE_VERSION,
    BridgeError,
    CONTRACTS_SCHEMA_VERSION,
    MAX_REQUEST_BYTES,
    makeFault,
    type ClientPresence
} from '@sab/contracts';
import { ModClient } from '@sab/game-client';
import { ActionLedger, ActionService, ControlManager, EventLog } from '@sab/control-core';
import { createToolServer } from '@sab/mcp';
import { AuthStore, loadConfig, type BridgeConfig } from './config.js';
import { ClientRegistry } from './clients.js';
import { generateHostConfig, HOST_LABELS, HOST_SUPPORT_MATRIX, type HostId, type TransportMode } from './hosts.js';
import {
    isLoopback,
    parseCookies,
    readBody,
    sendJson,
    sendText,
    toWebRequest,
    writeWebResponse
} from './http-util.js';
import { Logger } from './logger.js';
import { dataPaths, ensureDirs, resolveDataDir, type DataPaths } from './paths.js';
import { serveStatic } from './static.js';

export interface BridgeOptions {
    dataDir?: string;
    webDist?: string;
    logger?: Logger;
    /** 仅测试使用：注入自定义 Mod 端口/令牌 */
    configOverride?: Partial<BridgeConfig>;
    /** 测试用：跳过真实端口绑定（0 表示随机端口） */
    port?: number;
}

interface HttpContext {
    req: IncomingMessage;
    res: ServerResponse;
    url: URL;
}

export class Bridge {
    readonly paths: DataPaths;
    readonly config: BridgeConfig;
    readonly auth: AuthStore;
    readonly logger: Logger;
    readonly registry = new ClientRegistry();
    readonly events: EventLog;
    readonly ledger: ActionLedger;
    readonly control: ControlManager;
    readonly actions: ActionService;
    readonly mod: ModClient;
    private readonly mcpHandler: ReturnType<typeof createMcpHandler>;
    private server: Server | null = null;
    private startedAt = new Date().toISOString();
    private readonly sessionToken: string;
    private readonly csrfToken: string;
    private boundPort = 0;

    constructor(options: BridgeOptions = {}) {
        const rootDir = resolveDataDir(options.dataDir);
        this.paths = dataPaths(rootDir, options.webDist);
        ensureDirs(this.paths);

        this.config = { ...loadConfig(this.paths), ...(options.configOverride ?? {}) };
        this.auth = new AuthStore(this.paths);
        this.logger =
            options.logger ??
            new Logger({
                level: this.config.logLevel,
                file: path.join(this.paths.logs, 'bridge.log'),
                paths: this.paths
            });

        const ledgerLog = (level: 'debug' | 'info' | 'warn' | 'error', message: string, meta?: Record<string, unknown>) =>
            this.logger.log(level, message, meta);
        this.ledger = new ActionLedger(this.paths.ledger, { logger: ledgerLog });
        this.events = new EventLog({ ledger: this.ledger });
        this.ledger.invalidateOpenSessions(this.startedAt);

        this.mod = new ModClient({
            host: this.config.modHost,
            port: this.config.modPort,
            token: this.auth.modToken,
            clientName: 'bridge',
            logger: (level, message, meta) => this.logger.log(level, message, meta)
        });
        this.control = new ControlManager({
            mod: this.mod,
            ledger: this.ledger,
            leaseTtlMs: this.config.leaseTtlMs,
            logger: ledgerLog,
            emit: (kind, payload) => this.events.publish(kind, payload)
        });
        this.actions = new ActionService({
            mod: this.mod,
            control: this.control,
            ledger: this.ledger,
            events: this.events,
            logger: ledgerLog,
            presence: () => this.presence(),
            port: this.config.bridgePort,
            startedAt: this.startedAt
        });

        this.sessionToken = createHmac('sha256', this.auth.webSessionSecret).update('web-session').digest('hex').slice(0, 32);
        this.csrfToken = createHmac('sha256', this.auth.webSessionSecret).update('web-csrf').digest('hex').slice(0, 32);

        this.mod.on('ready', (hello: unknown) => {
            this.logger.info('Mod 已就绪', { hello: hello ? 'ok' : 'null' });
            this.control.fromHello(this.mod.hello);
            this.events.publish('mod_connected', {
                instanceId: this.mod.hello?.instanceId ?? null,
                modVersion: this.mod.hello?.modVersion ?? null
            });
        });
        this.mod.on('disconnected', (reason: string) => {
            this.logger.warn(`Mod 连接断开：${reason}`);
            this.events.publish('mod_disconnected', { reason });
        });

        this.mcpHandler = this.createMcp();
    }

    private createMcp(): ReturnType<typeof createMcpHandler> {
        return createMcpHandler(
            (requestContext) =>
                createToolServer({
                    serverInfo: { name: 'stardew-agent-bridge', version: BRIDGE_VERSION },
                    executor: {
                        executeTool: (toolName, args, ctx) => {
                            this.registry.touch(ctx.clientId, ctx.clientName, ctx.transport);
                            this.registry.countCall(ctx.clientId);
                            return this.actions.executeTool(toolName, args, ctx);
                        }
                    },
                    resolveContext: (ctx) => {
                        const info = (ctx as unknown as { authInfo?: { clientId?: string; extra?: Record<string, unknown> } }).authInfo;
                        const clientId = typeof info?.clientId === 'string' ? info.clientId : 'unknown';
                        const clientName =
                            typeof info?.extra?.['clientName'] === 'string' ? (info.extra['clientName'] as string) : clientId;
                        return { clientId, clientName, transport: 'http' };
                    },
                    logger: (level, message, meta) => this.logger.log(level, message, meta)
                }),
            {
                onerror: (error) => this.logger.error(`MCP 错误：${error.message}`)
            }
        ) as unknown as ReturnType<typeof createMcpHandler>;
    }

    presence(): ClientPresence[] {
        return this.registry.list();
    }

    get port(): number {
        return this.boundPort;
    }

    async start(): Promise<number> {
        this.mod.connect();
        const server = createServer((req, res) => {
            void this.handle(req, res);
        });
        this.server = server;
        const port = await new Promise<number>((resolve, reject) => {
            server.once('error', reject);
            server.listen(this.config.bridgePort, '127.0.0.1', () => {
                const address = server.address();
                resolve(typeof address === 'object' && address ? address.port : this.config.bridgePort);
            });
        });
        this.boundPort = port;
        const endpoint = {
            schemaVersion: CONTRACTS_SCHEMA_VERSION,
            bridgeVersion: BRIDGE_VERSION,
            port,
            mcpUrl: `http://127.0.0.1:${port}/mcp`,
            pid: process.pid,
            startedAt: this.startedAt
        };
        writeFileSync(this.paths.endpoint, JSON.stringify(endpoint, null, 2), 'utf8');
        this.logger.info(`Bridge 已监听 http://127.0.0.1:${port}/ （MCP: /mcp, Web: /）`);
        this.events.publish('bridge_started', { port, pid: process.pid });
        return port;
    }

    async stop(): Promise<void> {
        this.events.publish('bridge_stopping', {});
        this.control.stop();
        await this.mod.close();
        this.ledger.close();
        const server = this.server;
        this.server = null;
        if (server) {
            await new Promise<void>((resolve) => server.close(() => resolve()));
        }
    }

    // -----------------------------------------------------------------------
    // 路由
    // -----------------------------------------------------------------------

    private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
        const url = new URL(req.url ?? '/', `http://${req.headers.host ?? '127.0.0.1'}`);
        try {
            if (!isLoopback(req)) {
                sendJson(res, 403, { error: '本服务只接受本机回环连接。' });
                return;
            }
            if (url.pathname === '/health') {
                sendJson(res, 200, {
                    ok: true,
                    bridgeVersion: BRIDGE_VERSION,
                    contractsSchemaVersion: CONTRACTS_SCHEMA_VERSION,
                    modConnected: this.mod.connected,
                    uptimeMs: Date.now() - Date.parse(this.startedAt)
                });
                return;
            }
            if (url.pathname === '/mcp') {
                await this.handleMcp(req, res);
                return;
            }
            if (url.pathname.startsWith('/api/v1/')) {
                await this.handleApi({ req, res, url });
                return;
            }
            if (url.pathname.startsWith('/api/')) {
                sendJson(res, 404, { error: '未知 API 路径。' });
                return;
            }
            if (req.method === 'GET' || req.method === 'HEAD') {
                const result = serveStatic(this.paths.webDist, url.pathname, res);
                if (!result.served) sendText(res, result.status, '未找到页面。请先运行 npm run build 生成 Web 产物。');
                return;
            }
            sendJson(res, 405, { error: '方法不支持。' });
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            this.logger.error(`请求处理失败 ${req.method} ${url.pathname}：${message}`);
            if (!res.headersSent) sendJson(res, 500, { error: '内部错误，详见本机日志。' });
            else res.end();
        }
    }

    private async handleMcp(req: IncomingMessage, res: ServerResponse): Promise<void> {
        const body = await readBodyMaybe(req, MAX_REQUEST_BYTES);
        if (body === null) {
            sendJson(res, 413, { error: '请求体过大。' });
            return;
        }
        const request = toWebRequest(req, body);
        const rejected =
            hostHeaderValidationResponse(request, localhostAllowedHostnames()) ??
            originValidationResponse(request, localhostAllowedOrigins());
        if (rejected) {
            this.logger.warn('MCP 请求被 Origin/Host 校验拒绝');
            await writeWebResponse(res, rejected);
            return;
        }
        const client = this.auth.verifyBearer(request.headers.get('authorization'));
        if (!client) {
            sendJson(res, 401, makeFault('AUTH_FAILED', 'MCP 端点需要有效的 Bearer 令牌。'), {
                'www-authenticate': 'Bearer realm="stardew-agent-bridge"'
            });
            return;
        }
        this.registry.touch(client.clientId, client.clientName, 'http');
        const response = await this.mcpHandler.fetch(request, {
            authInfo: {
                token: client.credential.token,
                clientId: client.clientId,
                scopes: ['stardew'],
                extra: { clientName: client.clientName }
            }
        } as never);
        await writeWebResponse(res, response as Response);
    }

    private async handleApi(ctx: HttpContext): Promise<void> {
        const { req, res, url } = ctx;
        const method = (req.method ?? 'GET').toUpperCase();
        const pathname = url.pathname;

        // 写入类端点需要网页会话 + CSRF + 同源
        const needsSession = method !== 'GET';
        const bearer = this.auth.verifyBearer(req.headers.authorization);
        const cookies = parseCookies(req.headers.cookie);
        const hasSession = cookies['sab_session'] === this.sessionToken;
        const sameOrigin = this.checkOrigin(req);

        if (!sameOrigin) {
            sendJson(res, 403, makeFault('ORIGIN_REJECTED'));
            return;
        }

        // 工具通道：Bearer 令牌（stdio 适配器）或网页会话（Web 控制台）。
        // 两条路径都进入同一个 ActionService，不存在第二套业务实现。
        if (pathname.startsWith('/api/v1/tool/')) {
            const caller = bearer
                ? { clientId: bearer.clientId, clientName: bearer.clientName, transport: 'stdio' as const }
                : hasSession
                  ? { clientId: 'web', clientName: 'Web 控制台', transport: 'web' as const }
                  : null;
            if (!caller) {
                sendJson(res, 401, makeFault('AUTH_FAILED', '/api/v1/tool 需要 Bearer 令牌或网页会话。'));
                return;
            }
            if (!bearer && req.headers['x-sab-csrf'] !== this.csrfToken) {
                sendJson(res, 403, makeFault('AUTH_FAILED', '缺少或错误的 CSRF 令牌。'));
                return;
            }
            if (method !== 'POST') {
                sendJson(res, 405, { error: '请使用 POST。' });
                return;
            }
            const toolName = decodeURIComponent(pathname.slice('/api/v1/tool/'.length));
            const body = await readBodyMaybe(req, MAX_REQUEST_BYTES);
            if (body === null) {
                sendJson(res, 413, { error: '请求体过大。' });
                return;
            }
            let args: unknown = {};
            if (body.length > 0) {
                try {
                    args = JSON.parse(body.toString('utf8'));
                } catch {
                    sendJson(res, 400, makeFault('INVALID_ARGUMENT', '请求体不是合法 JSON。'));
                    return;
                }
            }
            this.registry.touch(caller.clientId, caller.clientName, caller.transport);
            this.registry.countCall(caller.clientId);
            const result = await this.actions.executeTool(toolName, args, caller);
            sendJson(res, 200, result);
            return;
        }

        if (method === 'GET' && pathname === '/api/v1/session') {
            res.setHeader(
                'set-cookie',
                `sab_session=${this.sessionToken}; Path=/; HttpOnly; SameSite=Strict; Max-Age=86400`
            );
            sendJson(res, 200, { ok: true, csrfToken: this.csrfToken, bridgeVersion: BRIDGE_VERSION });
            return;
        }

        const requireWeb = (): boolean => {
            if (!hasSession) {
                sendJson(res, 401, makeFault('AUTH_FAILED', '需要网页会话：请打开 http://127.0.0.1:' + this.boundPort + '/ 。'));
                return false;
            }
            if (needsSession && req.headers['x-sab-csrf'] !== this.csrfToken) {
                sendJson(res, 403, makeFault('AUTH_FAILED', '缺少或错误的 CSRF 令牌。'));
                return false;
            }
            return true;
        };

        if (method === 'GET' && pathname === '/api/v1/status') {
            if (!hasSession && !bearer) {
                sendJson(res, 401, makeFault('AUTH_FAILED'));
                return;
            }
            sendJson(res, 200, this.actions.getStatus());
            return;
        }

        if (!requireWeb()) return;

        if (method === 'GET' && pathname === '/api/v1/events') {
            const since = Number(url.searchParams.get('since') ?? '0');
            res.statusCode = 200;
            res.setHeader('content-type', 'text/event-stream; charset=utf-8');
            res.setHeader('cache-control', 'no-store');
            res.setHeader('connection', 'keep-alive');
            for (const event of this.events.since(Number.isFinite(since) ? since : 0)) {
                res.write(`data: ${JSON.stringify(event)}\n\n`);
            }
            const unsubscribe = this.events.subscribe((event) => {
                res.write(`data: ${JSON.stringify(event)}\n\n`);
            });
            const keepAlive = setInterval(() => res.write(': keep-alive\n\n'), 15_000);
            req.on('close', () => {
                clearInterval(keepAlive);
                unsubscribe();
            });
            return;
        }

        if (method === 'GET' && pathname === '/api/v1/receipts') {
            const limit = Math.min(Number(url.searchParams.get('limit') ?? '20') || 20, 100);
            sendJson(res, 200, { receipts: this.actions.recentReceipts(limit) });
            return;
        }

        if (method === 'GET' && pathname === '/api/v1/receipt') {
            const actionId = url.searchParams.get('actionId') ?? '';
            const receipt = this.actions.resolveReceipt(actionId);
            if (!receipt) {
                sendJson(res, 404, makeFault('NOT_FOUND', '没有该 actionId 的收据。'));
                return;
            }
            sendJson(res, 200, { receipt });
            return;
        }

        if (method === 'GET' && pathname === '/api/v1/sessions') {
            sendJson(res, 200, { sessions: this.control.list(), active: this.control.activeSession });
            return;
        }

        if (method === 'GET' && pathname === '/api/v1/screenshot') {
            const result = await this.actions.executeTool(
                'stardew_screenshot',
                {},
                { clientId: 'web', clientName: 'Web 控制台', transport: 'web' }
            );
            if (!result.image) {
                sendJson(res, 409, { error: result.text });
                return;
            }
            const buffer = Buffer.from(result.image.dataBase64, 'base64');
            res.statusCode = 200;
            res.setHeader('content-type', result.image.mimeType);
            res.setHeader('cache-control', 'no-store');
            res.end(buffer);
            return;
        }

        if (method === 'GET' && pathname === '/api/v1/hosts') {
            const host = (url.searchParams.get('host') ?? 'dsh') as HostId;
            const transport = (url.searchParams.get('transport') ?? 'http') as TransportMode;
            if (!HOST_LABELS[host]) {
                sendJson(res, 400, makeFault('INVALID_ARGUMENT', `未知宿主 ${host}。`));
                return;
            }
            const clientId = url.searchParams.get('clientId') ?? host;
            const credential = this.auth.issue(clientId, HOST_LABELS[host]);
            const snippet = generateHostConfig({
                host,
                transport,
                clientId,
                clientName: HOST_LABELS[host],
                token: credential.token,
                bridgeUrl: `http://127.0.0.1:${this.boundPort}/mcp`,
                stdioAdapterPath: path.resolve(process.cwd(), 'adapters', 'stdio', 'dist', 'index.js'),
                nodeExecutable: process.execPath,
                dataDir: this.paths.root
            });
            sendJson(res, 200, { snippet, matrix: HOST_SUPPORT_MATRIX, clientId, token: credential.token });
            return;
        }

        if (method === 'GET' && pathname === '/api/v1/diagnostics') {
            sendJson(res, 200, this.buildDiagnosticsPreview());
            return;
        }

        if (method === 'POST' && pathname === '/api/v1/diagnostics/export') {
            const file = this.exportProblemBundle();
            sendJson(res, 200, { ok: true, file, note: '问题包已脱敏：不含令牌、用户名与完整路径。' });
            return;
        }

        if (method === 'POST' && pathname === '/api/v1/control/start') {
            const body = await this.readJsonBody(req);
            const session = await this.control.start({
                clientId: 'web',
                clientName: 'Web 控制台（人工）',
                mode: body.mode === 'realtime' ? 'realtime' : 'step',
                label: 'Web 控制台'
            });
            this.events.publish('session_started', {
                controlSessionId: session.controlSessionId,
                clientId: 'web',
                mode: session.mode
            });
            sendJson(res, 200, { ok: true, session });
            return;
        }

        if (method === 'POST' && pathname === '/api/v1/control/takeover') {
            const result = await this.control.takeover('web_manual_takeover');
            sendJson(res, 200, { ok: true, ...result });
            return;
        }

        if (method === 'POST' && pathname === '/api/v1/control/end') {
            const session = await this.control.end('web', null, 'web_end');
            sendJson(res, 200, { ok: true, session });
            return;
        }

        if (method === 'POST' && pathname === '/api/v1/stop') {
            const result = await this.actions.executeTool(
                'stardew_stop',
                {},
                { clientId: 'web', clientName: 'Web 控制台', transport: 'web' }
            );
            sendJson(res, 200, result);
            return;
        }

        if (method === 'POST' && pathname === '/api/v1/clients') {
            const body = await this.readJsonBody(req);
            const clientId = typeof body.clientId === 'string' ? body.clientId : null;
            if (!clientId || !/^[A-Za-z0-9_-]{2,40}$/.test(clientId)) {
                sendJson(res, 400, makeFault('INVALID_ARGUMENT', 'clientId 需 2–40 位字母数字下划线横线。'));
                return;
            }
            const credential = this.auth.issue(clientId, typeof body.clientName === 'string' ? body.clientName : clientId);
            sendJson(res, 200, { ok: true, credential });
            return;
        }

        sendJson(res, 404, { error: '未知 API 路径。' });
    }

    private async readJsonBody(req: IncomingMessage): Promise<Record<string, unknown>> {
        const body = await readBodyMaybe(req, MAX_REQUEST_BYTES);
        if (body === null || body.length === 0) return {};
        try {
            const parsed = JSON.parse(body.toString('utf8'));
            return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : {};
        } catch {
            throw new BridgeError('INVALID_ARGUMENT', '请求体不是合法 JSON。');
        }
    }

    private checkOrigin(req: IncomingMessage): boolean {
        const origin = req.headers.origin;
        if (!origin) return true; // 同源 fetch 与命令行工具可能不带 Origin
        const allowed = [`http://127.0.0.1:${this.boundPort}`, `http://localhost:${this.boundPort}`];
        return allowed.includes(origin);
    }

    private buildDiagnosticsPreview(): Record<string, unknown> {
        const status = this.actions.getStatus();
        return {
            generatedAt: new Date().toISOString(),
            bridgeVersion: BRIDGE_VERSION,
            node: process.version,
            platform: `${process.platform}/${process.arch}`,
            paths: {
                root: '<data>',
                config: '<data>/config.json',
                ledger: '<data>/ledger.sqlite',
                log: '<data>/logs/bridge.log'
            },
            config: this.config,
            status,
            recentEvents: this.events.recent(50),
            recentReceipts: this.actions.recentReceipts(10),
            redaction: ['Bearer 令牌', '32 位以上十六进制串', '用户主目录路径', '存档标识']
        };
    }

    private exportProblemBundle(): string {
        const stamp = new Date().toISOString().replace(/[:.]/g, '-');
        const file = path.join(this.paths.exports, `problem-bundle-${stamp}.json`);
        const payload = {
            ...this.buildDiagnosticsPreview(),
            note: '用户主动导出；内容已脱敏，不含令牌与完整本机路径。',
            bundleId: randomUUID()
        };
        writeFileSync(file, JSON.stringify(payload, null, 2), 'utf8');
        this.logger.info(`问题包已导出：${path.basename(file)}`);
        return file;
    }
}

async function readBodyMaybe(req: IncomingMessage, limit: number): Promise<Buffer | null> {
    try {
        if (req.method === 'GET' || req.method === 'HEAD') return Buffer.alloc(0);
        return await readBody(req, limit);
    } catch (error) {
        if (error && typeof error === 'object' && (error as { code?: string }).code === 'BODY_TOO_LARGE') return null;
        throw error;
    }
}

