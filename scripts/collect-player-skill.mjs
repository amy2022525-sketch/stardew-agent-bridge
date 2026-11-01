/** Only public, fixed skill resources may enter a distribution; never copy its runtime directory wholesale. */
import { copyFileSync, lstatSync, mkdirSync } from 'node:fs';
import path from 'node:path';

export const PLAYER_SKILL_FILES = Object.freeze([
    'SKILL.md',
    'agents/openai.yaml',
    'references/gameplay-guide.md',
    'references/bridge-playbook.md',
    'references/journaling.md',
    'assets/short-term.template.md',
    'assets/long-term.template.md'
]);

export function collectPlayerSkill(root, output) {
    const source = path.join(root, 'skills', 'stardew-player');
    const destination = path.join(output, 'skills', 'stardew-player');
    // Check every required source before creating a partial skill in the package.
    for (const name of PLAYER_SKILL_FILES) {
        if (!lstatSync(path.join(source, name)).isFile()) throw new Error(`Skill resource must be a regular file: ${name}`);
    }
    for (const name of PLAYER_SKILL_FILES) {
        const target = path.join(destination, name);
        mkdirSync(path.dirname(target), { recursive: true });
        copyFileSync(path.join(source, name), target);
    }
    return { files: PLAYER_SKILL_FILES.length };
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(import.meta.filename)) {
    if (process.argv.length !== 4) throw new Error('Usage: collect-player-skill.mjs <source-root> <package-root>');
    process.stdout.write(JSON.stringify(collectPlayerSkill(path.resolve(process.argv[2]), path.resolve(process.argv[3]))) + '\n');
}
