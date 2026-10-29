/** Source-only host helper reuses exactly the same host templates as the Web/CLI. */
import { generateHostConfig, HOST_LABELS } from '../../apps/server/src/host-templates.mjs';
import { parsePublicBaseUrl } from './runtime/addresses.mjs';
import { buildComposeArgs } from './compose-command.mjs';
export const HOST_IDS = ['dsh', 'codex', 'claude-code', 'generic'];
export const DEFAULT_CLIENT_ID = { dsh: 'dsh', codex: 'codex', 'claude-code': 'claude-code', generic: 'agent' };
export function stdioArgv({ dockerPath, files, projectName, projectDirectory, envFile, clientId, service = 'runtime' }) {
    if (!/^[A-Za-z0-9][A-Za-z0-9_-]{1,39}$/.test(clientId)) throw new Error('INVALID_CLIENT_ID');
    return { command: dockerPath, args: buildComposeArgs({ files, projectName, projectDirectory, envFile }, ['exec', '-T', '-e', `SAB_CLIENT_ID=${clientId}`, service, '/usr/local/bin/node', '/opt/sab/server/stdio-adapter.mjs']) };
}
export function generateMcpConfig(input) {
    if (!HOST_IDS.includes(input.host) || !['http', 'stdio'].includes(input.transport)) throw new Error('INVALID_HOST_OR_TRANSPORT');
    const clientId = input.clientId ?? DEFAULT_CLIENT_ID[input.host];
    const publicBase = parsePublicBaseUrl(input.publicBaseUrl);
    const command = input.transport === 'stdio' ? stdioArgv({ ...input, clientId }) : undefined;
    const snippet = generateHostConfig({ host: input.host, transport: input.transport, clientId, clientName: HOST_LABELS[input.host],
        token: input.token ?? '<TOKEN>', bridgeUrl: `${publicBase.baseUrl}/mcp`, stdioAdapterPath: '', nodeExecutable: '', dataDir: '',
        ...(command ? { stdioCommand: command } : {}) });
    return { ...snippet, clientId, notes: [...snippet.notes, ...(command ? ['此命令只进入已运行容器；不会启动新的 Bridge 或游戏。'] : [])] };
}
export async function readTokenFromStdin(stream = process.stdin) {
    let text = '';
    for await (const chunk of stream) { text += chunk; if (text.length > 4096) throw new Error('TOKEN_TOO_LARGE'); }
    return text.trim();
}
