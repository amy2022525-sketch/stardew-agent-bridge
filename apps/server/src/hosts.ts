/**
 * 按用户选择的宿主生成连接配置片段。
 *
 * 只生成文本，不写入任何宿主配置；用户确认后由 CLI/安装向导写入，
 * 写入前备份，写入内容不改动其他 MCP 服务器条目。
 */

export type HostId = 'dsh' | 'codex' | 'claude-code' | 'generic';
export type TransportMode = 'http' | 'stdio';

export interface HostConfigInput {
    host: HostId;
    transport: TransportMode;
    clientId: string;
    clientName: string;
    token: string;
    /** 例如 http://127.0.0.1:17655/mcp */
    bridgeUrl: string;
    /** stdio 适配器入口绝对路径 */
    stdioAdapterPath: string;
    /** stdio 适配器使用的 node 可执行文件 */
    nodeExecutable: string;
    /** 适配器需要的数据目录（用于找到凭据与端点） */
    dataDir: string;
}

export interface HostConfigSnippet {
    host: HostId;
    transport: TransportMode;
    /** 建议写入的文件位置（说明性） */
    targetFile: string;
    language: 'json' | 'toml';
    content: string;
    notes: string[];
}

export const HOST_LABELS: Record<HostId, string> = {
    dsh: 'DSH（DeepSeek Harness）',
    codex: 'Codex CLI',
    'claude-code': 'Claude Code',
    generic: '其他 MCP 客户端'
};

function jsonSnippet(value: unknown): string {
    return JSON.stringify(value, null, 2);
}

function tomlString(value: string): string {
    return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

export function generateHostConfig(input: HostConfigInput): HostConfigSnippet {
    const notes: string[] = [
        '此为配置模板；该宿主版本的实际短任务仍需按 docs/CLIENTS.md 验收。',
        '令牌等价于密码：只写入本机宿主配置，不要提交到仓库或粘贴到公开聊天。',
        '启动顺序无关：Bridge 未运行时宿主会报告连接失败，启动后重连即可。'
    ];

    if (input.host === 'dsh') {
        if (input.transport === 'http') {
            return {
                host: 'dsh',
                transport: 'http',
                targetFile: 'DSH 侧栏 → MCP连接器 → 添加连接 → 导入 JSON',
                language: 'json',
                content: jsonSnippet({
                    mcpServers: {
                        stardew: {
                            transport: 'streamable-http',
                            url: input.bridgeUrl,
                            headers: { Authorization: `Bearer ${input.token}` }
                        }
                    }
                }),
                notes: [
                    ...notes,
                    '也可在连接器界面逐项填写：名称 stardew、URL 为上面的地址、鉴权方式 Bearer、粘贴令牌。',
                    'DSH 不安装本项目专用插件；它通过标准 MCP 客户端连接。'
                ]
            };
        }
        return {
            host: 'dsh',
            transport: 'stdio',
            targetFile: 'DSH 侧栏 → MCP连接器 → 添加连接 → 导入 JSON',
            language: 'json',
            content: jsonSnippet({
                mcpServers: {
                    stardew: {
                        transport: 'stdio',
                        command: input.nodeExecutable,
                        args: [input.stdioAdapterPath],
                        env: {
                            SAB_CLIENT_ID: input.clientId,
                            SAB_HOME: input.dataDir
                        }
                    }
                }
            }),
            notes: [...notes, 'stdio 适配器只做转发，业务仍由常驻 Bridge 执行。']
        };
    }

    if (input.host === 'codex') {
        if (input.transport === 'http') {
            return {
                host: 'codex',
                transport: 'http',
                targetFile: '~/.codex/config.toml（用户级）或 .codex/config.toml（项目级）',
                language: 'toml',
                content: [
                    '[mcp_servers.stardew]',
                    `url = ${tomlString(input.bridgeUrl)}`,
                    'bearer_token_env_var = "SAB_TOKEN"',
                    '',
                    '# 运行前设置环境变量：',
                    `#   PowerShell: $env:SAB_TOKEN = "${input.token}"`,
                    '#   bash:       export SAB_TOKEN="…"'
                ].join('\n'),
                notes: [...notes, '若 Codex 版本不支持 HTTP MCP，请改用 stdio 片段。']
            };
        }
        return {
            host: 'codex',
            transport: 'stdio',
            targetFile: '~/.codex/config.toml（用户级）或 .codex/config.toml（项目级）',
            language: 'toml',
            content: [
                '[mcp_servers.stardew]',
                `command = ${tomlString(input.nodeExecutable)}`,
                `args = [${tomlString(input.stdioAdapterPath)}]`,
                `env = { SAB_CLIENT_ID = ${tomlString(input.clientId)}, SAB_HOME = ${tomlString(input.dataDir)} }`,
                '',
                '# stdio 不把令牌放在命令行：适配器从 SAB_HOME 下的受保护凭据文件读取。'
            ].join('\n'),
            notes
        };
    }

    // Claude Code 和采用 mcpServers JSON 配置的其他客户端。
    if (input.transport === 'http') {
        return {
            host: input.host,
            transport: 'http',
            targetFile: input.host === 'generic' ? 'Agent 程序的 MCP 设置 → 导入 JSON，或填写 URL 和 Bearer 令牌' : '项目根目录 .mcp.json（项目级）或 claude mcp add 命令',
            language: 'json',
            content: jsonSnippet({
                mcpServers: {
                    stardew: {
                        type: 'http',
                        url: input.bridgeUrl,
                        headers: { Authorization: `Bearer ${input.token}` }
                    }
                }
            }),
            notes: [...notes, input.host === 'generic' ? '此 JSON 使用常见的 mcpServers 格式；仅支持表单的客户端可从中提取 URL 和 Authorization 请求头。' : '等价 CLI：claude mcp add --transport http stardew <url> --header "Authorization: Bearer <token>"']
        };
    }
    return {
        host: input.host,
        transport: 'stdio',
        targetFile: input.host === 'generic' ? 'Agent 程序的 MCP 设置 → 本地 stdio 服务' : '项目根目录 .mcp.json（项目级）',
        language: 'json',
        content: jsonSnippet({
            mcpServers: {
                stardew: {
                    type: 'stdio',
                    command: input.nodeExecutable,
                    args: [input.stdioAdapterPath],
                    env: {
                        SAB_CLIENT_ID: input.clientId,
                        SAB_HOME: input.dataDir
                    }
                }
            }
        }),
        notes
    };
}

export const HOST_SUPPORT_MATRIX: { host: string; http: string; stdio: string; note: string }[] = [
    { host: 'DSH', http: '配置模板', stdio: '已验收只读调用', note: 'Desktop 0.2.0-rc.2 / MCP连接器 0.2.70；完整游戏短任务待补齐' },
    { host: 'Codex CLI', http: '配置模板', stdio: '配置模板', note: '真实宿主待验收；支持取决于安装版本' },
    { host: 'Claude Code', http: '配置模板', stdio: '配置模板', note: '真实宿主待验收；.mcp.json 或 claude mcp add' },
    { host: '其他 MCP 客户端', http: '通用 JSON / URL + Bearer', stdio: '通用 JSON / 本地进程', note: '以客户端实际支持的配置格式为准' }
];
