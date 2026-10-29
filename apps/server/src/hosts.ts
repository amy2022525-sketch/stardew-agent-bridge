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
    /** 例如 http://127.0.0.1:17655/mcp（容器模式为公共映射地址） */
    bridgeUrl: string;
    /** stdio 适配器入口绝对路径 */
    stdioAdapterPath: string;
    /** stdio 适配器使用的 node 可执行文件 */
    nodeExecutable: string;
    /** 适配器需要的数据目录（用于找到凭据与端点） */
    dataDir: string;
    /**
     * 容器模式：stdio 不能输出容器内部路径当宿主命令；此时 stdio 片段替换为
     * 「请用宿主 manage.mjs mcp-config 生成」的说明，HTTP 片段照常可用。
     */
    containerMode?: boolean;
    /** Host-side Docker exec command, supplied only by the host configuration helper. */
    stdioCommand?: { command: string; args: string[] };
}


import * as templates from './host-templates.mjs';
export interface HostConfigSnippet {
    host: HostId;
    transport: TransportMode;
    targetFile: string;
    language: 'json' | 'toml';
    content: string;
    notes: string[];
}
export const HOST_LABELS: Record<HostId,string> = templates.HOST_LABELS;
export const HOST_SUPPORT_MATRIX: {host:string;http:string;stdio:string;note:string}[] = templates.HOST_SUPPORT_MATRIX;
export const generateHostConfig: (input:HostConfigInput)=>HostConfigSnippet = templates.generateHostConfig;
