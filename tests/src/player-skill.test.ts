import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { validateToolArguments } from '@sab/contracts';

const repo = path.resolve(import.meta.dirname, '../../..');
const { collectPlayerSkill, PLAYER_SKILL_FILES } = await import(pathToFileURL(path.join(repo, 'scripts/collect-player-skill.mjs')).href) as {
    collectPlayerSkill(root: string, output: string): { files: number };
    PLAYER_SKILL_FILES: readonly string[];
};

function fixture(missing?: string) {
    const area = mkdtempSync(path.join(tmpdir(), 'sab-player-skill-'));
    const source = path.join(area, 'input');
    const output = path.join(area, 'output');
    for (const name of PLAYER_SKILL_FILES) {
        if (name === missing) continue;
        const target = path.join(source, 'skills/stardew-player', name);
        mkdirSync(path.dirname(target), { recursive: true });
        copyFileSync(path.join(repo, 'skills/stardew-player', name), target);
    }
    return { area, source, output, close() {
        assert.equal(path.dirname(area), path.resolve(tmpdir()));
        assert.ok(path.basename(area).startsWith('sab-player-skill-'));
        rmSync(area, { recursive: true, force: true });
    } };
}

describe('portable player skill', () => {
    it('ships public skill resources without private play logs or adjacent credentials', () => {
        const f = fixture();
        try {
            const skill = path.join(f.source, 'skills/stardew-player');
            mkdirSync(path.join(skill, 'playlogs'), { recursive: true });
            writeFileSync(path.join(skill, 'playlogs/session.md'), 'private history');
            writeFileSync(path.join(skill, 'secrets.json'), '{"synthetic":"not-a-real-key"}');
            const result = collectPlayerSkill(f.source, f.output);
            assert.equal(result.files, 7);
            for (const file of PLAYER_SKILL_FILES) assert.deepEqual(readFileSync(path.join(f.output, 'skills/stardew-player', file)), readFileSync(path.join(skill, file)));
            assert.equal(existsSync(path.join(f.output, 'skills/stardew-player/playlogs')), false);
            assert.equal(existsSync(path.join(f.output, 'skills/stardew-player/secrets.json')), false);
        } finally { f.close(); }
    });

    it('rejects an incomplete skill before creating a partial distribution', () => {
        const f = fixture('references/journaling.md');
        try {
            assert.throws(() => collectPlayerSkill(f.source, f.output));
            assert.equal(existsSync(f.output), false);
        } finally { f.close(); }
    });

    it('keeps documented memory calls compatible with actual MCP contracts', () => {
        const text = readFileSync(path.join(repo, 'skills/stardew-player/references/bridge-playbook.md'), 'utf8');
        const samples = [...text.matchAll(/```json\s*([\s\S]*?)```/g)];
        assert.ok(samples.length > 0);
        for (const sample of samples) {
            const call = JSON.parse(sample[1]!) as { tool: string; arguments: unknown };
            const result = validateToolArguments(call.tool, call.arguments);
            assert.equal(result.ok, true, JSON.stringify(result));
        }
    });
});
