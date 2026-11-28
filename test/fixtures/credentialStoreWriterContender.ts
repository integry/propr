/**
 * One process changing a canonical credential store file through the
 * operator writer, as pasting or removing a credential in Settings does (see
 * agentCredentialStoreLockMultiprocess.test.ts). It records `"written"`, or
 * the error, in `result-<id>`.
 *
 * argv: writerModule lockRoot store workDir id path content   (content "-" removes the file)
 * env:  CONTENDER_STALE_MS          stale threshold (default: the module's)
 *       CONTENDER_PUBLISH_AFTER     a peer id: once the operator mutation is recorded
 *                                   as pending, stay suspended before publishing
 *                                   until that peer has recorded its result
 */
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const [writerModule, lockRoot, store, workDir, id, relative, content] = process.argv.slice(2);
const { writeCredentialStoreFiles } = await import(pathToFileURL(writerModule).href);
const sleep = (ms: number): void => { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); };
const waitFor = (file: string): void => {
    const deadline = Date.now() + 20_000;
    while (!fs.existsSync(file) && Date.now() < deadline) sleep(5);
};

const publishAfter = process.env.CONTENDER_PUBLISH_AFTER;
let suspended = false;
const onBeforePublish = publishAfter ? (): void => {
    if (suspended) return;
    suspended = true;
    fs.writeFileSync(path.join(workDir, `publishing-${id}`), '');
    // Descheduled between recording the mutation and publishing it.
    waitFor(path.join(workDir, `result-${publishAfter}`));
    sleep(50);
} : undefined;
const staleMs = process.env.CONTENDER_STALE_MS ? Number(process.env.CONTENDER_STALE_MS) : undefined;

let outcome: unknown;
try {
    await writeCredentialStoreFiles(store, [{ path: relative, content: content === '-' ? null : Buffer.from(content) }], {
        lock: { lockRoot, pollMs: 5, timeoutMs: 15_000, staleMs }, onBeforePublish,
    });
    outcome = 'written';
} catch (error) {
    outcome = { error: (error as Error).message };
}
fs.writeFileSync(path.join(workDir, `result-${id}`), JSON.stringify(outcome));
