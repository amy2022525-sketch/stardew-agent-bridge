/**
 * 把 28 个 `stardew_*` 工具注册成真正的 MCP 工具。
 *
 * 同一份定义同时服务于：
 *  - 常驻服务的 HTTP MCP 端点（`/mcp`）
 *  - stdio 适配器（通过 HTTP 调用同一个常驻服务）
 * 因此两个传输必然得到等价结果，不存在第二套业务实现。
 */
import {
    McpServer,
    fromJsonSchema,
    type CallToolResult,
    type ContentBlock,
    type ServerContext
} from '@modelcontextprotocol/server';
import { TOOLS, type ToolKind } from '@sab/contracts';

export interface ToolContext {
    clientId: string;
    clientName: string;
    transport: 'http' | 'stdio' | 'web' | 'cli';
    signal?: AbortSignal;
}

export interface ToolImage {
    mimeType: string;
    dataBase64: string;
    sampledAt: string;
}

export interface ToolResult {
    isError: boolean;
    text: string;
    structured?: Record<string, unknown>;
    image?: ToolImage;
}

export interface ToolExecutor {
    executeTool(toolName: string, args: unknown, ctx: ToolContext): Promise<ToolResult>;
}

export interface Logger {
    (level: 'debug' | 'info' | 'warn' | 'error', message: string, meta?: Record<string, unknown>): void;
}

export interface CreateToolServerOptions {
    serverInfo: { name: string; version: string };
    executor: ToolExecutor;
    /** 由调用方依据认证结果构造调用者身份；不能信任模型自报的名称。 */
    resolveContext: (request: ServerContext) => ToolContext;
    logger?: Logger;
}

function kindLabel(kind: ToolKind): string {
    switch (kind) {
        case 'read':
            return '只读';
        case 'write':
            return '写入';
        case 'mixed':
            return '混合';
        default:
            return '控制';
    }
}

/** 构造一个完整注册好工具的 McpServer 实例（每个 HTTP 请求/stdio 连接各一个）。 */
export function createToolServer(options: CreateToolServerOptions): McpServer {
    const server = new McpServer(options.serverInfo, {
        capabilities: { tools: {}, logging: {} }
    });

    for (const tool of TOOLS) {
        server.registerTool(
            tool.name,
            {
                title: tool.title,
                description: `[${kindLabel(tool.kind)}] ${tool.description}`,
                inputSchema: fromJsonSchema(tool.inputSchema),
                annotations: tool.annotations
            },
            async (args: unknown, ctx: ServerContext): Promise<CallToolResult> => {
                const resolved = options.resolveContext(ctx);
                const toolContext = { ...resolved, signal: AbortSignal.any([ctx.mcpReq.signal, ...(resolved.signal ? [resolved.signal] : [])]) };
                const result = await options.executor.executeTool(tool.name, args ?? {}, toolContext);
                const content: ContentBlock[] = [{ type: 'text', text: result.text }];
                if (result.image) {
                    content.push({
                        type: 'image',
                        data: result.image.dataBase64,
                        mimeType: result.image.mimeType
                    });
                }
                const payload: CallToolResult = { content };
                if (result.structured) payload.structuredContent = result.structured;
                if (result.isError) payload.isError = true;
                return payload;
            }
        );
    }

    return server;
}

export { TOOLS };
