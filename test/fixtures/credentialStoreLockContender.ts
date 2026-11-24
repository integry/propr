/**
 * One worker process contending for a credential store lock (see
 * agentCredentialStoreLockMultiprocess.test.ts). Inside the critical section
 * it claims an "inside" marker with O_EXCL; finding one already there means
 * two processes held the lock at once.
 *
 * argv: lockModule lockRoot store workDir id holdMs pauseAfterStaleMs barrierIds
 */
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const [lockModule, lockRoot, store, workDir, id, holdMs, pauseAfterStaleMs, barrierIds] = process.argv.slice(2);
const { withCredentialStoreLock } = await import(pathToFileURL(lockModule).href);
const sleep = (ms: number): void => { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); };

let firstObservation = true;
const onStaleLockObserved = (): void => {
    if (!firstObservation) return;
    firstObservation = false;
    // Every barrier contender observes the same stale holder before any of them breaks it.
    fs.writeFileSync(path.join(workDir, `observed-${id}`), '');
    const peers = barrierIds ? barrierIds.split(',') : [];
    const deadline = Date.now() + 10_000;
    while (!peers.every(peer => fs.existsSync(path.join(workDir, `observed-${peer}`))) && Date.now() < deadline) sleep(5);
    // Descheduled between the stale observation and the takeover.
    sleep(Number(pauseAfterStaleMs));
};

await withCredentialStoreLock(store, { lockRoot, pollMs: 5, timeoutMs: 15_000, onStaleLockObserved }, () => {
    const inside = path.join(workDir, 'inside');
    try {
        fs.writeFileSync(inside, id, { flag: 'wx' });
    } catch {
        fs.appendFileSync(path.join(workDir, 'violations'), `${id} entered while ${fs.readFileSync(inside, 'utf8')} held the lock\n`);
    }
    sleep(Number(holdMs));
    fs.appendFileSync(path.join(workDir, 'completed'), `${id}\n`);
    try { if (fs.readFileSync(inside, 'utf8') === id) fs.rmSync(inside); } catch { /* the overlapping holder removed it */ }
});
