import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, renameSync, unlinkSync, writeSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { ownedPath } from './runtime/lib.mjs';
/** Set a private ACL before writing any secret on Windows; POSIX files start at 0600. */
export function writePrivateOutput(output, content) {
    if (!path.isAbsolute(output)) throw new Error('OUTPUT_MUST_BE_ABSOLUTE');
    if (existsSync(output)) throw new Error('OUTPUT_EXISTS');
    const dir = path.dirname(output);
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const temporary = ownedPath(dir, path.join(dir, `.sab-private-${randomBytes(12).toString('hex')}`));
    let fd;
    try {
        fd = openSync(temporary, 'wx', 0o600);
        if (process.platform === 'win32') {
            const who = spawnSync('whoami.exe', ['/user', '/fo', 'csv', '/nh'], { encoding: 'utf8', shell: false });
            const sid = who.stdout?.match(/S-1-[0-9-]+/)?.[0];
            if (!sid) throw new Error('PRIVATE_ACL_IDENTITY_FAILED');
            const acl = spawnSync('icacls.exe', [temporary, '/inheritance:r', '/grant:r', `*${sid}:F`, '/grant:r', '*S-1-5-18:F'], { stdio: 'ignore', shell: false });
            if (acl.status !== 0) throw new Error('PRIVATE_ACL_FAILED');
        }
        writeSync(fd, Buffer.from(content, 'utf8')); fsyncSync(fd); closeSync(fd); fd = undefined;
        renameSync(temporary, ownedPath(dir, output));
    } finally { if (fd !== undefined) closeSync(fd); if (existsSync(temporary)) unlinkSync(temporary); }
}
