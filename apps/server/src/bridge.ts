/**
 * 常驻 Bridge：装配 Mod 客户端、账本、控制权、动作服务与 MCP 传输，
 * 并对外提供 `/mcp`、`/api/v1` 与 Web 静态页面。
 *
 * 只有这一处装配业务对象：HTTP MCP、stdio 适配器与 Web 共用同一实例。
 */
import { createHmac, randomUUID } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { unlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import {
    createMcpHandler,
    hostHeaderValidationResponse,
    localhostAllowedHostnames,
    localhostAllowedOrigins,
    originValidationResponse,
    isLegacyRequest,
    WebStandardStreamableHTTPServerTransport
} from '@modelcontextprotocol/server';
import {
    BRIDGE_VERSION,
    BridgeError,
    CONTRACTS_SCHEMA_VERSION,
    MAX_REQUEST_BYTES,
    TOOLS,
    makeFault,
    type ClientPresence
} from '@sab/contracts';
import { ModClient } from '@sab/game-client';
import { ActionLedger, ActionService, ControlManager, EventLog } from '@sab/control-core';
import { createToolServer } from '@sab/mcp';
import { PRIVATE_FILE_MODE, atomicWriteFile, processIdentityOfCurrentProcess, readJsonIfExists } from '@sab/platform';
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
import { dataPaths, ensureDirs, resolveDataDir, resolveStdioAdapter, type DataPaths } from './paths.js';
import { serveStatic } from './static.js';
import { redactDiagnostics } from './redact.js';
import { checkMcpConnection, MCP_CHECK_CLIENT_ID, validMcpClientId, type McpConnectionCheck } from './mcp-connections.js';

export interface BridgeOptions {
    /** CLI 在初始化账本前已成功绑定的端口；避免端口冲突触碰账本。 */
    httpServer?: Server;
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
    private readonly legacySessions = new Map<string, { clientId: string; server: ReturnType<typeof createToolServer>; transport: WebStandardStreamableHTTPServerTransport; lastUsedAt: number }>();
    private server: Server | null = null;
    private startedAt = new Date().toISOString();
    private readonly sessionToken: string;
    private readonly csrfToken: string;
    private boundPort = 0;
    private endpointOwned = false;
    private mcpCheckRunning = false;
    private readonly mcpChecks: Partial<Record<TransportMode, McpConnectionCheck>> = {};

    constructor(options: BridgeOptions = {}) {
        this.server = options.httpServer ?? null;
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
        this.mod.on('heartbeat', () => this.control.fromHello(this.mod.hello));
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
                    resolveContext: () => {
                        const info = requestContext.authInfo;
                        if (!info?.clientId) throw new BridgeError('AUTH_FAILED', '缺少已认证的 MCP 调用者身份。');
                        const clientId = info.clientId;
                        const clientName =
                            typeof info?.extra?.['clientName'] === 'string' ? (info.extra['clientName'] as string) : clientId;
                        return { clientId, clientName, transport: 'http', signal: requestContext.requestInfo?.signal };
                    },
                    logger: (level, message, meta) => this.logger.log(level, message, meta)
                }),
            {
                legacy: 'reject',
                responseMode: 'sse',
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
        const server = this.server ?? createServer();
        server.on('request', (req, res) => {
            void this.handle(req, res);
        });
        this.server = server;
        const port = server.listening ? (server.address() as import('node:net').AddressInfo).port : await new Promise<number>((resolve, reject) => {
            server.once('error', reject);
            server.listen(this.config.bridgePort, '127.0.0.1', () => {
                const address = server.address();
                resolve(typeof address === 'object' && address ? address.port : this.config.bridgePort);
            });
        });
        this.mod.connect();
        this.boundPort = port;
        const identity = processIdentityOfCurrentProcess();
        const endpoint = {
            schemaVersion: CONTRACTS_SCHEMA_VERSION,
            bridgeVersion: BRIDGE_VERSION,
            port,
            mcpUrl: `http://127.0.0.1:${port}/mcp`,
            pid: process.pid,
            processStart: identity.startTime,
            dataRoot: this.paths.root,
            startedAt: this.startedAt
        };
        // endpoint 是私人状态：原子写、0600，且只在本次实例确实监听成功后写入。
        atomicWriteFile(this.paths.endpoint, `${JSON.stringify(endpoint, null, 2)}\n`, { mode: PRIVATE_FILE_MODE });
        this.endpointOwned = true;
        this.logger.info(`Bridge 已监听 http://127.0.0.1:${port}/ （MCP: /mcp, Web: /）`);
        this.events.publish('bridge_started', { port, pid: process.pid });
        return port;
    }

    async stop(): Promise<void> {
        this.events.publish('bridge_stopping', {});
        this.control.stop();
        await this.mcpHandler.close();
        await Promise.all([...this.legacySessions.values()].map(async session => { await session.transport.close(); await session.server.close(); }));
        this.legacySessions.clear();
        await this.mod.close();
        this.ledger.close();
        this.releaseEndpoint();
        const server = this.server;
        this.server = null;
        if (server) {
            await new Promise<void>((resolve) => server.close(() => resolve()));
        }
    }

    /** 只移除本次实例写入的 endpoint；其他实例刚写的新文件保持不动。 */
    private releaseEndpoint(): void {
        if (!this.endpointOwned) return;
        const current = readJsonIfExists<{ pid?: number }>(this.paths.endpoint);
        if (!current || current.pid !== process.pid) {
            this.endpointOwned = false;
            return;
        }
        try {
            unlinkSync(this.paths.endpoint);
        } catch {
            /* 已被清理 */
        }
        this.endpointOwned = false;
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
                    modVersion: this.mod.hello?.modVersion ?? null,
                    gameVersion: this.mod.hello?.gameVersion ?? null,
                    smapiVersion: this.mod.hello?.smapiVersion ?? null,
                    saveLoaded: this.mod.hello?.saveLoaded ?? null,
                    worldGeneration: this.mod.hello?.worldGeneration ?? null,
                    dataRoot: this.paths.root,
                    pid: process.pid,
                    processStart: processIdentityOfCurrentProcess().startTime,
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
        const abort = new AbortController();
        res.once('close', () => { if (!res.writableFinished) abort.abort(); });
        const request = toWebRequest(req, body, abort.signal);
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
        const authInfo = {
            token: client.credential.token,
            clientId: client.clientId,
            scopes: ['stardew'],
            extra: { clientName: client.clientName }
        };
        let parsedBody: unknown;
        try { parsedBody = body.length ? JSON.parse(body.toString('utf8')) : undefined; } catch { /* SDK 返回规范化解析错误。 */ }
        if (req.headers['mcp-session-id'] || await isLegacyRequest(request.clone(), parsedBody)) {
            const sessionId = typeof req.headers['mcp-session-id'] === 'string' ? req.headers['mcp-session-id'] : undefined;
            let session = sessionId ? this.legacySessions.get(sessionId) : undefined;
            if (sessionId && (!session || session.clientId !== client.clientId)) {
                sendJson(res, 404, { error: 'MCP 会话不存在或不属于该客户端，请重新连接。' });
                return;
            }
            if (!session) {
                if ((parsedBody as { method?: string } | undefined)?.method !== 'initialize') {
                    sendJson(res, 400, { error: '旧版 MCP 必须先 initialize 建立会话。' });
                    return;
                }
                for (const [id, stale] of this.legacySessions) {
                    if (Date.now() - stale.lastUsedAt > 15 * 60_000) {
                        this.legacySessions.delete(id);
                        await stale.transport.close();
                        await stale.server.close();
                    }
                }
                if (this.legacySessions.size >= 32) { sendJson(res, 429, { error: 'MCP 会话数达到上限，请关闭闲置客户端。' }); return; }
                const id = randomUUID();
                const server = createToolServer({
                    serverInfo: { name: 'stardew-agent-bridge', version: BRIDGE_VERSION },
                    executor: {
                        executeTool: (toolName, args, ctx) => {
                            this.registry.touch(ctx.clientId, ctx.clientName, ctx.transport);
                            this.registry.countCall(ctx.clientId);
                            return this.actions.executeTool(toolName, args, ctx);
                        }
                    },
                    resolveContext: () => ({ clientId: client.clientId, clientName: client.clientName, transport: 'http' })
                });
                const transport = new WebStandardStreamableHTTPServerTransport({
                    sessionIdGenerator: () => id,
                    onsessionclosed: () => { this.legacySessions.delete(id); }
                });
                session = { clientId: client.clientId, server, transport, lastUsedAt: Date.now() };
                this.legacySessions.set(id, session);
                try { await server.connect(transport); }
                catch (error) { this.legacySessions.delete(id); throw error; }
            }
            session.lastUsedAt = Date.now();
            const response = await session.transport.handleRequest(request, { authInfo, parsedBody });
            await writeWebResponse(res, response);
            return;
        }
        const response = await this.mcpHandler.fetch(request, {
            authInfo,
            parsedBody
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
            const abort = new AbortController();
            res.once('close', () => { if (!res.writableFinished) abort.abort(); });
            const result = await this.actions.executeTool(toolName, args, { ...caller, signal: abort.signal });
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

        if (method === 'GET' && pathname === '/api/v1/mcp') {
            sendJson(res, 200, {
                url: `http://127.0.0.1:${this.boundPort}/mcp`, toolCount: TOOLS.length,
                clients: this.presence().filter(client => (client.transport === 'http' || client.transport === 'stdio') && client.clientId !== MCP_CHECK_CLIENT_ID && client.toolCalls > 0),
                checks: this.mcpChecks
            });
            return;
        }

        if (method === 'POST' && pathname === '/api/v1/mcp/check') {
            const body = await this.readJsonBody(req);
            if (body.transport !== 'http' && body.transport !== 'stdio') {
                sendJson(res, 400, makeFault('INVALID_ARGUMENT', '请选择 HTTP 或 stdio。'));
                return;
            }
            if (this.mcpCheckRunning) {
                sendJson(res, 409, { error: '已有连接检测正在进行，请稍后再试。' });
                return;
            }
            this.mcpCheckRunning = true;
            const abort = new AbortController();
            const timer = setTimeout(() => abort.abort(), 10_000);
            res.once('close', () => { if (!res.writableFinished) abort.abort(); });
            try {
                const credential = this.auth.issue(MCP_CHECK_CLIENT_ID, 'Web MCP 连接检测');
                const result = await checkMcpConnection({
                    transport: body.transport, url: `http://127.0.0.1:${this.boundPort}/mcp`, token: credential.token,
                    dataDir: this.paths.root, adapterPath: resolveStdioAdapter(), signal: abort.signal
                });
                this.mcpChecks[body.transport] = result;
                sendJson(res, 200, { ...result, modConnected: this.mod.connected, saveLoaded: this.mod.hello?.saveLoaded ?? false });
            } catch {
                sendJson(res, 502, { error: 'MCP 连接检测未通过。请确认 Bridge 和本机 stdio 适配器可用后重试。' });
            } finally {
                clearTimeout(timer);
                this.mcpCheckRunning = false;
            }
            return;
        }

        if ((method === 'GET' && pathname === '/api/v1/hosts') || (method === 'POST' && pathname === '/api/v1/mcp/config')) {
            const body = method === 'POST' ? await this.readJsonBody(req) : Object.fromEntries(url.searchParams);
            const host = (body.host ?? 'dsh') as HostId;
            const transport = (body.transport ?? 'http') as TransportMode;
            if (!Object.hasOwn(HOST_LABELS, host)) {
                sendJson(res, 400, makeFault('INVALID_ARGUMENT', `未知宿主 ${host}。`));
                return;
            }
            if (transport !== 'http' && transport !== 'stdio') {
                sendJson(res, 400, makeFault('INVALID_ARGUMENT', '请选择 HTTP 或 stdio。'));
                return;
            }
            const clientId = body.clientId ?? (host === 'generic' ? 'agent' : host);
            if (!validMcpClientId(clientId)) {
                sendJson(res, 400, makeFault('INVALID_ARGUMENT', '连接名称需 2–40 位字母、数字、下划线或横线，以字母或数字开头；请避开系统保留名称。'));
                return;
            }
            const credential = this.auth.issue(clientId, HOST_LABELS[host]);
            const snippet = generateHostConfig({
                host,
                transport,
                clientId,
                clientName: HOST_LABELS[host],
                token: credential.token,
                bridgeUrl: `http://127.0.0.1:${this.boundPort}/mcp`,
                stdioAdapterPath: resolveStdioAdapter(),
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
            if (!validMcpClientId(clientId)) {
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
        return redactDiagnostics({
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
        }, this.paths) as Record<string, unknown>;
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

