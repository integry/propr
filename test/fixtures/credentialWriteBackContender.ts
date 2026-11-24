/**
 * One worker process writing a refreshed Claude token back through the
 * credential broker (see agentCredentialStoreLockMultiprocess.test.ts). It
 * materialises the canonical store, then commits `token` with `mtimeMs` and
 * records its write-back results in `result-<id>`.
 *
 * argv: brokerModule lockRoot store workDir id token mtimeMs
 * env:  CONTENDER_STALE_MS             stale threshold (default: the module's)
 *       CONTENDER_PUBLISH_AFTER        a peer id: once the replacement is prepared,
 *                                      stay suspended before publishing it until
 *                                      that peer has recorded its result
 */
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const [brokerModule, lockRoot, store, workDir, id, token, mtimeMs] = process.argv.slice(2);
const { CredentialBroker } = await import(pathToFileURL(brokerModule).href);
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
    // Descheduled between preparing the replacement and renaming it into place.
    waitFor(path.join(workDir, `result-${publishAfter}`));
    sleep(50);
} : undefined;
const staleMs = process.env.CONTENDER_STALE_MS ? Number(process.env.CONTENDER_STALE_MS) : undefined;

const broker = new CredentialBroker({ lock: { lockRoot, pollMs: 5, timeoutMs: 15_000, staleMs }, onBeforePublish });
const bundle = broker.materialize([{ id: 'claude-config', provider: 'claude', store: 'config', canonicalRoot: store }]);
fs.writeFileSync(path.join(workDir, `materialized-${id}`), '');
let outcome: unknown;
try {
    const results = await broker.commit(bundle, [{ storeId: 'claude-config', path: '.credentials.json', content: Buffer.from(token), mtimeMs: Number(mtimeMs) }]);
    outcome = results.map((result: { outcome: string }) => result.outcome);
} catch (error) {
    outcome = { error: (error as Error).message };
}
fs.writeFileSync(path.join(workDir, `result-${id}`), JSON.stringify(outcome));
