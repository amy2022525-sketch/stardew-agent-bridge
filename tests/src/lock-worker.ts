import path from 'node:path';
import { acquireInstanceLock } from '@sab/server';

const root = process.argv[2]!;
process.once('message', () => {
    const result = acquireInstanceLock({ lockPath: path.join(root, 'bridge.lock'), dataRoot: root, programVersion: '0.1.0' });
    process.send?.({ event: 'result', acquired: result.acquired });
    if (result.acquired) setTimeout(() => { result.handle.release(); process.disconnect(); }, 750);
    else process.disconnect();
});
process.send?.({ event: 'ready' });
