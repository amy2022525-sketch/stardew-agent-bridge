import path from 'node:path';
import { acquireInstanceLock } from '@sab/server';

const root = process.argv[2]!;
process.once('message', () => {
    const result = acquireInstanceLock({ lockPath: path.join(root, 'bridge.lock'), dataRoot: root, programVersion: '0.1.0' });
    process.send?.({ event: 'result', acquired: result.acquired,
        ...(!result.acquired ? { reason: result.reason, message: result.message } : {}) });
    // Keep the winner alive until the parent has collected every contender.
    // A timer lets a slow worker acquire legitimately after the first owner exits.
    if (result.acquired) process.once('disconnect', () => result.handle.release());
    else process.disconnect();
});
process.send?.({ event: 'ready' });
