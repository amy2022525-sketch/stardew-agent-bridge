/** Collect the license texts for dependencies that actually enter a native bundle. */
import { buildSync } from 'esbuild';
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export function collectLicenses(output, root = path.resolve(import.meta.dirname, '..')) {
    const packages = new Map();
    for (const entry of ['apps/server/src/cli.ts', 'adapters/stdio/src/index.ts']) {
        const build = buildSync({ absWorkingDir: root, entryPoints: [entry], bundle: true, platform: 'node', format: 'esm', target: 'node22', write: false, metafile: true, logLevel: 'silent' });
        for (const input of Object.keys(build.metafile.inputs)) {
            if (!input.replaceAll('\\', '/').includes('node_modules/')) continue;
            let directory = path.dirname(path.resolve(root, input));
            while (directory !== path.dirname(directory)) {
                const manifest = path.join(directory, 'package.json');
                if (existsSync(manifest)) {
                    const pkg = JSON.parse(readFileSync(manifest, 'utf8'));
                    if (typeof pkg.name === 'string') {
                        if (!packages.has(pkg.name)) packages.set(pkg.name, { directory, pkg });
                        break;
                    }
                }
                directory = path.dirname(directory);
            }
        }
    }
    const licenses = path.join(output, 'licenses'), metadata = [];
    mkdirSync(licenses, { recursive: true });
    for (const { directory, pkg } of packages.values()) {
        const target = path.join(licenses, pkg.name.replaceAll('/', '__'));
        mkdirSync(target, { recursive: true });
        const texts = readdirSync(directory, { withFileTypes: true }).filter(file => file.isFile() && /^(license|licence|copying|notice)(\.|$)/i.test(file.name)).map(file => file.name);
        if (texts.length === 0) throw new Error(`Dependency license text missing: ${pkg.name}`);
        for (const file of texts) copyFileSync(path.join(directory, file), path.join(target, file));
        metadata.push({ name: pkg.name, version: pkg.version, license: pkg.license, files: texts });
    }
    writeFileSync(path.join(licenses, 'bundled-dependencies.json'), JSON.stringify(metadata, null, 2) + '\n');
    return metadata;
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    if (!process.argv[2]) throw new Error('Provide output directory');
    console.log(`Collected ${collectLicenses(path.resolve(process.argv[2])).length} bundled dependency licenses.`);
}
