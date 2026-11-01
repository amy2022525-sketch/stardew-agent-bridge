/**
 * DXV-01～DXV-09 类断言：两个传输适配器的请求形状、正文提取、错误分类与体积上限。
 * 只用本地 127.0.0.1 假 HTTP 服务，不访问真实模型服务、不产生费用。
 */
import assert from 'node:assert/strict';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { after, before, describe, it } from 'node:test';
import { ChatCompatibleProvider, ProviderCallError, ResponsesProvider, isAddressAllowed } from '@sab/decision-core';
import type { ProviderProfileConfig } from '@sab/decision-core';

type Handler = (req: IncomingMessage, res: ServerResponse, body: string) => void;

let server: Server;
let handler: Handler;
const requests: { url: string; body: Record<string, unknown> }[] = [];

function config(protocol: ProviderProfileConfig['protocol'], port: number, patch: Partial<ProviderProfileConfig> = {}): ProviderProfileConfig {
    return {
        id: 'local',
        label: '本地测试',
        protocol,
        baseUrl: `http://127.0.0.1:${String(port)}/v1`,
        model: 'test-model',
        authMode: 'none',
        secretRef: null,
        decisionFormat: 'json_schema',
        maxOutputParameter: 'max_completion_tokens',
        timeoutMs: 5000,
        maxOutputTokens: 256,
        allowPrivateNetwork: true,
        allowPlainHttp: true,
        ...patch
    };
}

const secrets = { authorizationHeader: () => null };

function call(provider: ChatCompatibleProvider | ResponsesProvider): Promise<unknown> {
    return provider.decide({
        systemPrompt: '系统规则',
        contextJson: '{"task":"water"}',
        outputSchema: { type: 'object', additionalProperties: false, properties: { ok: { type: 'boolean' } }, required: ['ok'] },
        maxOutputTokens: 256,
        signal: new AbortController().signal
    });
}

before(async () => {
    server = createServer((req, res) => {
        const chunks: Buffer[] = [];
        req.on('data', (chunk: Buffer) => chunks.push(chunk));
        req.on('end', () => {
            const text = Buffer.concat(chunks).toString('utf8');
            let parsed: Record<string, unknown> = {};
            try { parsed = JSON.parse(text) as Record<string, unknown>; } catch { /* 保留空对象 */ }
            requests.push({ url: req.url ?? '', body: parsed });
            handler(req, res, text);
        });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
});

after(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
});

function port(): number {
    return (server.address() as AddressInfo).port;
}

describe('出站地址策略（DXV-10）', () => {
    it('默认拒绝环回/私网/云元数据，允许公网', () => {
        for (const ip of ['127.0.0.1', '10.1.2.3', '172.16.5.5', '192.168.1.10', '100.64.0.1', '169.254.169.254', '0.0.0.0', '224.0.0.1']) {
            assert.equal(isAddressAllowed(ip, false), false, ip);
        }
        for (const ip of ['8.8.8.8', '1.1.1.1', '93.184.216.34']) {
            assert.equal(isAddressAllowed(ip, true), true, ip);
            assert.equal(isAddressAllowed(ip, false), true, ip);
        }
    });

    it('允许私网开关只放行私网，不放行链路本地与元数据地址', () => {
        assert.equal(isAddressAllowed('127.0.0.1', true), true);
        assert.equal(isAddressAllowed('192.168.1.10', true), true);
        assert.equal(isAddressAllowed('169.254.169.254', true), false);
        assert.equal(isAddressAllowed('fe80::1', true), false);
    });

    it('IPv6 内嵌 IPv4 不能绕过：::ffff:127.0.0.1 与 6to4 隐私地址按内嵌地址判定', () => {
        assert.equal(isAddressAllowed('::1', false), false);
        assert.equal(isAddressAllowed('::1', true), true);
        assert.equal(isAddressAllowed('::', false), false);
        assert.equal(isAddressAllowed('::ffff:127.0.0.1', false), false);
        assert.equal(isAddressAllowed('::ffff:169.254.169.254', true), false);
        assert.equal(isAddressAllowed('2002:7f00:1::1', false), false, '6to4 内嵌 127.0.0.1');
        assert.equal(isAddressAllowed('2002:a9fe:a9fe::1', true), false, '6to4 内嵌 169.254.169.254');
        assert.equal(isAddressAllowed('::127.0.0.1', false), false, 'IPv4-compatible 环回');
        assert.equal(isAddressAllowed('::169.254.169.254', true), false, 'IPv4-compatible 元数据地址');
        assert.equal(isAddressAllowed('fd00::1', false), false);
        assert.equal(isAddressAllowed('fd00::1', true), true);
        assert.equal(isAddressAllowed('2606:4700:4700::1111', false), true);
        assert.equal(isAddressAllowed('not-an-ip', true), false);
    });
});

describe('Chat 兼容适配器', () => {
    it('只发送选定长度字段，URL 只追加一次资源路径，usage 归一', async () => {
        requests.length = 0;
        handler = (_req, res) => {
            res.setHeader('content-type', 'application/json');
            res.end(JSON.stringify({
                choices: [{ message: { content: '{"ok":true}' }, finish_reason: 'stop' }],
                usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 }
            }));
        };
        const provider = new ChatCompatibleProvider(config('openai-chat-compatible', port()), secrets);
        const result = await call(provider) as { decisionText: string; usage: { totalTokens: number; source: string }; finishReason: string };
        assert.equal(requests[0]?.url, '/v1/chat/completions');
        assert.equal(requests[0]?.body['max_completion_tokens'], 256);
        assert.equal('max_tokens' in (requests[0]?.body ?? {}), false);
        assert.equal((requests[0]?.body['response_format'] as { type?: string } | undefined)?.type, 'json_schema');
        assert.equal(result.decisionText, '{"ok":true}');
        assert.equal(result.usage.totalTokens, 12);
        assert.equal(result.usage.source, 'provider');
        assert.equal(result.finishReason, 'stop');
    });

    it('baseUrl 不带 /v1 时只追加 /chat/completions，不重复拼接', async () => {
        requests.length = 0;
        handler = (_req, res) => {
            res.setHeader('content-type', 'application/json');
            res.end(JSON.stringify({ choices: [{ message: { content: '{"ok":true}' }, finish_reason: 'stop' }] }));
        };
        const provider = new ChatCompatibleProvider(config('openai-chat-compatible', port(), { baseUrl: `http://127.0.0.1:${String(port())}` }), secrets);
        await call(provider);
        assert.equal(requests[0]?.url, '/chat/completions');
    });

    it('finish_reason=length 不产生动作', async () => {
        handler = (_req, res) => {
            res.setHeader('content-type', 'application/json');
            res.end(JSON.stringify({ choices: [{ message: { content: '{"ok":' }, finish_reason: 'length' }] }));
        };
        const provider = new ChatCompatibleProvider(config('openai-chat-compatible', port()), secrets);
        await assert.rejects(call(provider), (error: unknown) => {
            assert.ok(error instanceof ProviderCallError);
            assert.equal(error.code, 'PROVIDER_OUTPUT_TRUNCATED');
            return true;
        });
    });

    it('tool_calls / refusal 一律拒绝执行', async () => {
        handler = (_req, res) => {
            res.setHeader('content-type', 'application/json');
            res.end(JSON.stringify({ choices: [{ message: { content: null, tool_calls: [{ id: 'x' }] }, finish_reason: 'tool_calls' }] }));
        };
        const provider = new ChatCompatibleProvider(config('openai-chat-compatible', port()), secrets);
        await assert.rejects(call(provider), /不产生动作|工具调用/);
    });

    it('401 归类为 PROVIDER_UNAUTHORIZED 且不重试', async () => {
        handler = (_req, res) => {
            res.statusCode = 401;
            res.setHeader('content-type', 'application/json');
            res.end(JSON.stringify({ error: { message: 'bad key sk-secret-123456' } }));
        };
        const provider = new ChatCompatibleProvider(config('openai-chat-compatible', port(), { authMode: 'bearer', secretRef: 's1' }), {
            authorizationHeader: () => 'Bearer test-secret'
        });
        await assert.rejects(call(provider), (error: unknown) => {
            assert.ok(error instanceof ProviderCallError);
            assert.equal(error.code, 'PROVIDER_UNAUTHORIZED');
            assert.equal(error.retryable, false);
            assert.equal(error.safeSummary.includes('sk-secret'), false, '错误摘要不得回显密钥');
            return true;
        });
    });

    it('不跟随重定向（避免把 Authorization 发往新主机）', async () => {
        handler = (_req, res) => {
            res.statusCode = 302;
            res.setHeader('location', 'http://127.0.0.1:1/elsewhere');
            res.end();
        };
        const provider = new ChatCompatibleProvider(config('openai-chat-compatible', port()), secrets);
        await assert.rejects(call(provider), (error: unknown) => {
            assert.ok(error instanceof ProviderCallError);
            assert.equal(error.code, 'PROVIDER_BAD_RESPONSE');
            assert.match(error.message, /重定向/);
            return true;
        });
    });
});

describe('Responses 适配器', () => {
    it('只从 completed 的 message/output_text 取正文，不把 reasoning 当 JSON', async () => {
        requests.length = 0;
        handler = (_req, res) => {
            res.setHeader('content-type', 'application/json');
            res.end(JSON.stringify({
                status: 'completed',
                output: [
                    { type: 'reasoning', summary: [{ type: 'summary_text', text: '{"ok":false}' }] },
                    { type: 'message', content: [{ type: 'output_text', text: '{"ok":true}' }] }
                ],
                usage: { input_tokens: 30, output_tokens: 5, total_tokens: 35 }
            }));
        };
        const provider = new ResponsesProvider(config('openai-responses', port()), secrets);
        const result = await call(provider) as { decisionText: string; usage: { totalTokens: number } };
        assert.equal(requests[0]?.url, '/v1/responses');
        assert.equal(requests[0]?.body['store'], false);
        assert.equal(requests[0]?.body['stream'], false);
        assert.equal(result.decisionText, '{"ok":true}');
        assert.equal(result.usage.totalTokens, 35);
    });

    it('非 completed 状态不产生动作', async () => {
        handler = (_req, res) => {
            res.setHeader('content-type', 'application/json');
            res.end(JSON.stringify({ status: 'incomplete', incomplete_details: { reason: 'max_output_tokens' }, output: [] }));
        };
        const provider = new ResponsesProvider(config('openai-responses', port()), secrets);
        await assert.rejects(call(provider), (error: unknown) => {
            assert.ok(error instanceof ProviderCallError);
            assert.equal(error.code, 'PROVIDER_OUTPUT_TRUNCATED');
            return true;
        });
    });

    it('completed 但缺少 output_text 时拒绝，不用空串冒充成功', async () => {
        handler = (_req, res) => {
            res.setHeader('content-type', 'application/json');
            res.end(JSON.stringify({ status: 'completed', output: [{ type: 'reasoning' }] }));
        };
        const provider = new ResponsesProvider(config('openai-responses', port()), secrets);
        await assert.rejects(call(provider), /缺少 message\/output_text/);
    });
});

describe('传输边界', () => {
    it('复用已连接的 keep-alive socket 时，慢响应不被误判为连接超时', { timeout: 25000 }, async () => {
        const sockets: number[] = [];
        let number = 0;
        handler = (req, res) => {
            sockets.push(req.socket.remotePort ?? 0);
            number += 1;
            const reply = (): void => { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ choices: [{ message: { content: '{"ok":true}' }, finish_reason: 'stop' }] })); };
            if (number === 1) reply();
            else setTimeout(reply, 10500);
        };
        const provider = new ChatCompatibleProvider(config('openai-chat-compatible', port(), { timeoutMs: 20000 }), secrets);
        await call(provider);
        await call(provider);
        assert.equal(sockets.length, 2);
        assert.equal(sockets[0], sockets[1], '必须实际复用连接，不能只测试两个新连接');
    });
    it('响应体超过 512 KiB 时中断读取', async () => {
        handler = (_req, res) => {
            res.setHeader('content-type', 'application/json');
            res.end(JSON.stringify({ status: 'completed', padding: 'x'.repeat(600 * 1024) }));
        };
        const provider = new ResponsesProvider(config('openai-responses', port()), secrets);
        await assert.rejects(call(provider), (error: unknown) => {
            assert.ok(error instanceof ProviderCallError);
            assert.match(error.message, /512KiB|超过/);
            return true;
        });
    });

    it('总时限生效，超时归类为 PROVIDER_TIMEOUT', async () => {
        handler = (_req, res) => {
            setTimeout(() => {
                res.setHeader('content-type', 'application/json');
                res.end(JSON.stringify({ choices: [{ message: { content: '{"ok":true}' }, finish_reason: 'stop' }] }));
            }, 300);
        };
        const provider = new ChatCompatibleProvider(config('openai-chat-compatible', port(), { timeoutMs: 80 }), secrets);
        await assert.rejects(call(provider), (error: unknown) => {
            assert.ok(error instanceof ProviderCallError);
            assert.equal(error.code, 'PROVIDER_TIMEOUT');
            return true;
        });
    });
});
