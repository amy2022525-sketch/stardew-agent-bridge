import { copyFileSync } from 'node:fs';
import path from 'node:path';
export function syncSourceAssets(root) {
    copyFileSync(path.join(root, 'apps/server/src/host-templates.mjs'), path.join(root, 'apps/server/dist/host-templates.mjs'));
}
