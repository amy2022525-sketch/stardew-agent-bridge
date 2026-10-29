import path from 'node:path';
import { existsSync } from 'node:fs';
import { atomicWriteJson, ownedPath, readJsonIfExists } from './lib.mjs';
export function claimVolume(root, { project = process.env.SAB_PROJECT ?? 'standalone', leaseHeld = process.env.SAB_LEASE_HELD === '1' } = {}) {
    if (!leaseHeld || !/^[a-z0-9][a-z0-9_-]{0,62}$/.test(project)) throw new Error('VOLUME_LEASE_REQUIRED');
    const file = ownedPath(root, path.join(root, '.volume-owner.json'));
    if (existsSync(file)) {
        const owner = readJsonIfExists(file);
        if (owner?.application !== 'stardew-agent-bridge' || owner.schemaVersion !== 1 || owner.project !== project) throw new Error('VOLUME_OWNERSHIP_CONFLICT');
    } else atomicWriteJson(file, { application: 'stardew-agent-bridge', schemaVersion: 1, project });
}
