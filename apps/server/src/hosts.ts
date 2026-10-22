/**
 * 按用户选择的宿主生成连接配置片段。
 *
 * 只生成文本，不写入任何宿主配置；用户确认后由 CLI/安装向导写入，
 * 写入前备份，写入内容不改动其他 MCP 服务器条目。
 */

export type HostId = 'dsh' | 'codex' | 'claude-code';
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
    'claude-code': 'Claude Code'
};

function jsonSnippet(value: unknown): string {
    return JSON.stringify(value, null, 2);
}

function tomlString(value: string): string {
    return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

export function generateHostConfig(input: HostConfigInput): HostConfigSnippet {
    const notes: string[] = [
        '令牌等价于密码：只写入本机宿主配置，不要提交到仓库或粘贴到公开聊天。',
        '启动顺序无关：Bridge 未运行时宿主会报告连接失败，启动后重连即可。'
    ];

    if (input.host === 'dsh') {
        if (input.transport === 'http') {
            return {
                host: 'dsh',
                transport: 'http',
                targetFile: 'DSH 设置 → MCP 连接器 → 导入 JSON（或连接器商店的"自定义 HTTP"）',
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
            targetFile: 'DSH 设置 → MCP 连接器 → 导入 JSON（自定义 stdio）',
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

    // claude-code
    if (input.transport === 'http') {
        return {
            host: 'claude-code',
            transport: 'http',
            targetFile: '项目根目录 .mcp.json（项目级）或 claude mcp add 命令',
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
            notes: [...notes, '等价 CLI：claude mcp add --transport http stardew <url> --header "Authorization: Bearer <token>"']
        };
    }
    return {
        host: 'claude-code',
        transport: 'stdio',
        targetFile: '项目根目录 .mcp.json（项目级）',
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
    { host: 'DSH', http: '支持（推荐）', stdio: '支持', note: '通过 MCP 连接器导入，无需专用插件' },
    { host: 'Codex CLI', http: '取决于版本', stdio: '支持（推荐）', note: '旧版本仅支持 stdio，可用适配器' },
    { host: 'Claude Code', http: '支持（推荐）', stdio: '支持', note: '.mcp.json 项目级配置或 claude mcp add' }
];
