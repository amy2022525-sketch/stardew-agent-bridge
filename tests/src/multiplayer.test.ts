import assert from 'node:assert/strict';
import { after, describe, it } from 'node:test';
import { readFileSync, mkdtempSync, rmSync, statSync } from 'node:fs';
import { createHash } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { ActionLedger } from '@sab/control-core';
import { MOD_PROTOCOL_V2, actionSignature, canonicalFarmerId, canonicalJson, isActorContext, multiplayerDedupKey, validateToolArguments, type ActorContext, type ActionReceipt, type MultiplayerStatus } from '@sab/contracts';
import { startStack, ctxOf, type Stack } from './helpers.js';

const actor: ActorContext = { worldId: 'world-1', hostFarmerId: '9007199254740993', hostSessionId: 'hhhhhhhhhhhhhhhhhhhhhh', actorFarmerId: '9223372036854775807',
    actorSessionId: 'aaaaaaaaaaaaaaaaaaaaaa', connectionId: 'cccccccccccccccccccccc', policyRevision: 1, permissionLeaseId: 'llllllllllllllllllllll', worldGeneration: 1, sceneGeneration: 0, dayGeneration: 0 };
function status(): MultiplayerStatus { return { enabled: true, role: 'farmhand', state: 'authorized', reason: 'none', worldId: actor.worldId, actorFarmerId: actor.actorFarmerId,
    hostFarmerId: actor.hostFarmerId, actorSessionId: actor.actorSessionId, hostSessionId: actor.hostSessionId, connectionId: actor.connectionId, policyRevision: 1,
    permissionLeaseHeld: true, permissionRemainingMs: 4000, actorContext: { ...actor }, phase: 'active', phaseSequence: 0, dayGeneration: 0, saveRevision: 0 }; }
const stacks: Stack[] = [], directories: string[] = [];
async function stack() { const s = await startStack({ multiplayer: status() }); stacks.push(s); return s; }
after(async () => { for (const s of stacks) await s.stop(); for (const dir of directories) rmSync(dir, { recursive: true, force: true }); });

describe('MP2 wire identity and safe contracts', () => {
    it('shares lossless Int64 fixtures with C# and never accepts numeric IDs', () => {
        const fixture = JSON.parse(readFileSync(new URL('../../fixtures/multiplayer-identities.json', import.meta.url), 'utf8')) as { valid: string[]; invalid: unknown[] };
        for (const id of fixture.valid) assert.equal(canonicalFarmerId(id), id);
        for (const id of fixture.invalid) assert.throws(() => canonicalFarmerId(id));
        assert.ok(isActorContext(actor)); assert.equal(isActorContext({ ...actor, actorFarmerId: 9223372036854775807 }), false);
        assert.equal(isActorContext({ ...actor, connectionId: '../bad' }), false);
    });
    it('keeps dedup key stable across reconnection, with full actor context in intent signature', () => {
        const changed = { ...actor, connectionId: 'dddddddddddddddddddddd' };
        assert.equal(multiplayerDedupKey(actor, 'eat-once'), multiplayerDedupKey(changed, 'eat-once'));
        assert.notEqual(multiplayerDedupKey(actor, 'eat-once'), multiplayerDedupKey({ ...actor, actorFarmerId: '2' }, 'eat-once'));
        assert.notEqual(multiplayerDedupKey(actor, 'eat-once'), multiplayerDedupKey({ ...actor, worldId: 'other' }, 'eat-once'));
        const base = { clientId: 'agent', controlSessionId: 'ctrl', command: 'eat', args: { slot: 1 } };
        assert.notEqual(actionSignature({ ...base, actorContext: actor }), actionSignature({ ...base, actorContext: changed }));
    });
    it('restricts MP tool to reads, distinguishes own inventory from generic menu clicks', () => {
        for (const operation of ['status', 'players', 'policy', 'connection']) assert.ok(validateToolArguments('stardew_multiplayer', { operation }).ok);
        for (const operation of ['bind', 'allow', 'revoke']) assert.equal(validateToolArguments('stardew_multiplayer', { operation }).ok, false);
        assert.ok(validateToolArguments('stardew_menu', { operation: 'open_inventory' }).ok);
        assert.equal(validateToolArguments('stardew_menu', { operation: 'open_inventory', target: '@s1:m1' }).ok, false);
        assert.ok(validateToolArguments('stardew_use', { target: '@mp2_abcdefghijklmnopqrstuv_e1' }).ok);
        assert.equal(validateToolArguments('stardew_status', { worldId: 'world-1' }).ok, false);
    });
});

describe('MP real Bridge over fake native Mod', () => {
    it('requires explicit realtime before reaching control acquire', async () => {
        const s = await stack(); assert.equal(s.bridge.mod.hello?.protocol, MOD_PROTOCOL_V2);
        for (const args of [{ operation: 'start' }, { operation: 'start', mode: 'step' }]) {
            const result = await s.bridge.actions.executeTool('stardew_session', args, ctxOf(s)); assert.match(result.text, /REALTIME_REQUIRED/);
        }
        assert.equal(s.mod.commandCount('control'), 0);
        const started = await s.bridge.actions.executeTool('stardew_session', { operation: 'start', mode: 'realtime' }, ctxOf(s));
        assert.equal(started.isError, false, started.text); assert.deepEqual(s.bridge.control.activeSession?.actorContext, actor);
    });
    it('writes schema 2 actor-scoped receipts without claiming saved or host committed', async () => {
        const s = await stack();
        await s.bridge.actions.executeTool('stardew_session', { operation: 'start', mode: 'realtime' }, ctxOf(s));
        const result = await s.bridge.actions.executeTool('stardew_select', { slot: 0, actionId: 'mp-select' }, ctxOf(s));
        assert.equal(result.isError, false, result.text);
        const receipt = result.structured?.receipt as ActionReceipt;
        assert.equal(receipt.schemaVersion, 2); assert.equal(receipt.multiplayer?.confirmationScope, 'local_observed');
        assert.equal(receipt.multiplayer?.durability, 'not_saved'); assert.equal(receipt.multiplayer?.actor.actorFarmerId, '9223372036854775807');
        assert.equal(receipt.pause.state, 'unknown'); assert.equal(receipt.pause.requested, false);
        assert.deepEqual(s.mod.requests.find(r => r.command === 'select')?.actorContext, actor);
        const duplicate = await s.bridge.actions.executeTool('stardew_select', { slot: 0, actionId: 'mp-select' }, ctxOf(s));
        assert.equal(duplicate.isError, false, duplicate.text); assert.equal(s.mod.commandCount('select'), 1);
    });
    it('normalizes unattributable actor-context receipts into a consistent unknown', async () => {
        const s = await stack(); const ctx = ctxOf(s);
        await s.bridge.actions.executeTool('stardew_session', { operation: 'start', mode: 'realtime' }, ctx);
        const other: ActorContext = { ...actor, actorFarmerId: '3' };
        s.mod.setBehavior('eat', () => ({ status: 'succeeded', result: { changed: true }, responseActorContext: other }));
        const wrong = (await s.bridge.actions.executeTool('stardew_eat', { slot: 1, actionId: 'mp-eat-wrong-actor' }, ctx)).structured?.receipt as ActionReceipt;
        assert.equal(wrong.status, 'unknown'); assert.equal(wrong.effectKnown, false); assert.equal(wrong.verified, false);
        assert.equal(wrong.effects, null); assert.equal(wrong.stopReason, null);
        assert.equal(wrong.error?.code, 'RESULT_UNKNOWN'); assert.equal(wrong.nextAction, 'query_action');
        assert.equal(wrong.multiplayer?.durability, 'unknown'); assert.equal(wrong.multiplayer?.confirmationScope, 'none');
        assert.match(wrong.summary, /结果不明/); assert.doesNotMatch(wrong.summary, /已完成/);
        s.mod.setBehavior('eat', () => ({ status: 'partial', result: { changed: false }, responseActorContext: null }));
        const missing = (await s.bridge.actions.executeTool('stardew_eat', { slot: 1, actionId: 'mp-eat-missing-actor' }, ctx)).structured?.receipt as ActionReceipt;
        assert.equal(missing.status, 'unknown'); assert.equal(missing.effectKnown, false);
        assert.equal(missing.multiplayer?.durability, 'unknown'); assert.equal(missing.multiplayer?.confirmationScope, 'none');
        assert.match(missing.summary, /结果不明/); assert.doesNotMatch(missing.summary, /部分完成/);
        s.mod.setBehavior('eat', () => ({ status: 'unknown', error: { code: 'RESULT_UNKNOWN', message: '动作中断。', effectKnown: false }, responseActorContext: other }));
        const unknown = (await s.bridge.actions.executeTool('stardew_eat', { slot: 1, actionId: 'mp-eat-unknown-actor' }, ctx)).structured?.receipt as ActionReceipt;
        assert.equal(unknown.status, 'unknown'); assert.equal(unknown.effectKnown, false);
        assert.equal(unknown.multiplayer?.durability, 'unknown'); assert.match(unknown.summary, /结果不明/);
        s.mod.clearBehavior('eat');
        const attributed = (await s.bridge.actions.executeTool('stardew_eat', { slot: 1, actionId: 'mp-eat-same-actor' }, ctx)).structured?.receipt as ActionReceipt;
        assert.equal(attributed.status, 'succeeded'); assert.equal(attributed.multiplayer?.durability, 'not_saved');
        assert.match(attributed.summary, /已完成/); assert.doesNotMatch(attributed.summary, /结果不明/);
    });
    it('web receipt query reports ambiguous action IDs as a structured 409 with scope hint', async () => {
        const s = await stack(); const ctx = ctxOf(s);
        const base = `http://127.0.0.1:${s.bridgePort}`;
        await s.bridge.actions.executeTool('stardew_session', { operation: 'start', mode: 'realtime' }, ctx);
        await s.bridge.actions.executeTool('stardew_eat', { slot: 1, actionId: 'amb-web-1' }, ctx);
        await s.bridge.actions.executeTool('stardew_session', { operation: 'end' }, ctx);
        s.mod.multiplayer!.actorContext = { ...actor, actorFarmerId: '3' }; s.mod.multiplayer!.actorFarmerId = '3';
        const hello = await s.bridge.mod.request('hello', {}, { isWrite: false }); s.bridge.mod.hello = hello.result as typeof s.bridge.mod.hello;
        await s.bridge.actions.executeTool('stardew_session', { operation: 'start', mode: 'realtime' }, ctx);
        await s.bridge.actions.executeTool('stardew_eat', { slot: 1, actionId: 'amb-web-1' }, ctx);
        assert.equal(s.mod.commandCount('eat'), 2);
        const sessionResponse = await fetch(base + '/api/v1/session');
        const cookie = sessionResponse.headers.get('set-cookie')!.split(';')[0]!;
        const ambiguous = await fetch(`${base}/api/v1/receipt?actionId=amb-web-1`, { headers: { cookie } });
        assert.equal(ambiguous.status, 409);
        assert.equal(((await ambiguous.json()) as { code: string }).code, 'AMBIGUOUS_ACTION_ID');
        const scoped = await fetch(`${base}/api/v1/receipt?actionId=amb-web-1&worldId=${actor.worldId}&actorFarmerId=${actor.actorFarmerId}`, { headers: { cookie } });
        assert.equal(scoped.status, 200);
        const scopedJson = (await scoped.json()) as { receipt: ActionReceipt };
        assert.equal(scopedJson.receipt.multiplayer?.actor.actorFarmerId, actor.actorFarmerId);
    });
    it('rejects reused action ID after reconnect and filters receipt lookups by client', async () => {
        const s = await stack(); const ctx = ctxOf(s);
        await s.bridge.actions.executeTool('stardew_session', { operation: 'start', mode: 'realtime' }, ctx);
        await s.bridge.actions.executeTool('stardew_eat', { slot: 1, actionId: 'eat-stable' }, ctx);
        const other = await s.bridge.actions.executeTool('stardew_status', { actionId: 'eat-stable' }, ctxOf(s, 'other-agent'));
        assert.equal(other.structured?.receipt, null); assert.deepEqual(other.structured?.recentReceipts, []);
        await s.bridge.actions.executeTool('stardew_session', { operation: 'end' }, ctx);
        s.mod.multiplayer!.actorContext = { ...actor, connectionId: 'dddddddddddddddddddddd' }; s.mod.multiplayer!.connectionId = 'dddddddddddddddddddddd';
        const hello = await s.bridge.mod.request('hello', {}, { isWrite: false }); s.bridge.mod.hello = hello.result as typeof s.bridge.mod.hello;
        await s.bridge.actions.executeTool('stardew_session', { operation: 'start', mode: 'realtime' }, ctx);
        const replay = await s.bridge.actions.executeTool('stardew_eat', { slot: 1, actionId: 'eat-stable' }, ctx);
        assert.match(replay.text, /IDEMPOTENCY_CONFLICT/); assert.equal(s.mod.commandCount('eat'), 1);
    });
    it('host lease revocation closes local control without automatically reacquiring', async () => {
        const s = await stack(); await s.bridge.actions.executeTool('stardew_session', { operation: 'start', mode: 'realtime' }, ctxOf(s));
        s.mod.multiplayer!.permissionLeaseHeld = false; s.mod.multiplayer!.actorContext = null; s.mod.multiplayer!.reason = 'HOST_PERMISSION_REVOKED';
        const response = await s.bridge.mod.request('hello', {}, { isWrite: false });
        s.bridge.mod.hello = response.result as typeof s.bridge.mod.hello; s.bridge.control.fromHello(s.bridge.mod.hello);
        assert.equal(s.bridge.control.activeSession, null);
        const denied = await s.bridge.actions.executeTool('stardew_select', { slot: 0 }, ctxOf(s));
        assert.equal(denied.isError, true); assert.equal(s.mod.commandCount('select'), 0);
    });
    it('binding requires Web session, CSRF and same origin, and is not an MCP tool', async () => {
        const s = await stack(); const base = `http://127.0.0.1:${s.bridgePort}`;
        assert.equal((await fetch(base + '/api/v1/multiplayer/bind', { method: 'POST', headers: { authorization: `Bearer ${s.token}` } })).status, 401);
        const session = await fetch(base + '/api/v1/session'); const cookie = session.headers.get('set-cookie')!.split(';')[0]!;
        const { csrfToken } = await session.json() as { csrfToken: string };
        assert.equal((await fetch(base + '/api/v1/multiplayer/bind', { method: 'POST', headers: { cookie } })).status, 403);
        assert.equal((await fetch(base + '/api/v1/multiplayer/bind', { method: 'POST', headers: { cookie, 'x-sab-csrf': csrfToken, origin: 'https://example.com' } })).status, 403);
        assert.equal(s.mod.commandCount('multiplayer_bind'), 0);
        const bound = await fetch(base + '/api/v1/multiplayer/bind', { method: 'POST', headers: { cookie, 'x-sab-csrf': csrfToken, origin: base } });
        assert.equal(bound.status, 200); assert.equal(s.mod.commandCount('multiplayer_bind'), 1);
        const state = await fetch(base + '/api/v1/status', { headers: { cookie } }); const json = await state.json() as { mod: { multiplayer: MultiplayerStatus } };
        assert.equal(json.mod.multiplayer.actorFarmerId, actor.actorFarmerId);
    });
});

describe('MP ledger v1 to v2 additive migration', () => {
    function file() { const dir = mkdtempSync(path.join(os.tmpdir(), 'sab-mp-ledger-')); directories.push(dir); return path.join(dir, 'ledger.sqlite'); }
    function intent(scope: ActorContext, id: string, clientId = 'agent') { return { dedupKey: multiplayerDedupKey(scope, id), actionId: id, signature: canonicalJson(scope), command: 'eat', clientId,
        controlSessionId: null, gameInstanceId: 'instance', worldGeneration: 1, intentAt: new Date().toISOString(), actorContext: scope }; }
    it('backs up committed WAL records before adding columns and preserves old tombstones', () => {
        const filename = file(); const v1 = new DatabaseSync(filename);
        v1.exec(`PRAGMA journal_mode=WAL; CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL); INSERT INTO meta VALUES ('schema_version','1');
            CREATE TABLE actions (dedup_key TEXT PRIMARY KEY,action_id TEXT NOT NULL,signature TEXT NOT NULL,command TEXT NOT NULL,client_id TEXT NOT NULL,control_session_id TEXT,game_instance_id TEXT NOT NULL,world_generation INTEGER NOT NULL,status TEXT NOT NULL,intent_at TEXT NOT NULL,finished_at TEXT,receipt TEXT,reconcilations TEXT);
            INSERT INTO actions VALUES ('old#once','once','original-signature','eat','agent',NULL,'old',3,'unknown','2026-01-01',NULL,NULL,NULL);`);
        const ledger = new ActionLedger(filename);
        try {
            assert.equal(ledger.writable, true, ledger.lastError ?? ''); assert.equal(ledger.schemaVersion, 2); assert.ok(ledger.backupPath);
            assert.equal(ledger.lookup('old#once', 'original-signature').kind, 'same'); assert.equal(ledger.countActions(), 1);
            const backup = new DatabaseSync(ledger.backupPath!, { readOnly: true });
            assert.equal((backup.prepare("SELECT value FROM meta WHERE key='schema_version'").get() as { value: string }).value, '1');
            assert.equal((backup.prepare('SELECT signature FROM actions').get() as { signature: string }).signature, 'original-signature'); backup.close();
            if (process.platform !== 'win32') assert.equal(statSync(ledger.backupPath!).mode & 0o777, 0o600);
        } finally { ledger.close(); v1.close(); }
    });
    it('future schema is refused and never silently downgraded', () => {
        const filename = file(); const db = new DatabaseSync(filename); db.exec("CREATE TABLE meta (key TEXT PRIMARY KEY,value TEXT NOT NULL); INSERT INTO meta VALUES ('schema_version','99')"); db.close();
        const before = createHash('sha256').update(readFileSync(filename)).digest('hex'); const ledger = new ActionLedger(filename);
        assert.equal(ledger.writable, false); assert.match(ledger.lastError ?? '', /Unsupported ledger schema/); ledger.close();
        assert.equal(createHash('sha256').update(readFileSync(filename)).digest('hex'), before);
    });
    it('identical action ID on different world/actors remains separate and ambiguous unscoped lookup fails', () => {
        const filename = file(); let ledger = new ActionLedger(filename);
        ledger.recordIntent(intent(actor, 'same')); const other = { ...actor, actorFarmerId: '2' }; ledger.recordIntent(intent(other, 'same'));
        assert.throws(() => ledger.findById('same'), /多个作用域/);
        assert.equal(ledger.findById('same', 'agent', actor)?.multiplayer?.actor.actorFarmerId, actor.actorFarmerId);
        assert.equal(ledger.findById('same', 'other-agent', actor), null);
        assert.equal(ledger.unresolved(10, 'agent', actor).length, 1);
        ledger.close(); ledger = new ActionLedger(filename);
        assert.equal(ledger.lookup(multiplayerDedupKey(actor, 'same'), canonicalJson(actor)).kind, 'same'); ledger.close();
    });
});
