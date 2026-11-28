import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { mock, test } from 'node:test';

const { CredentialBroker, CredentialBrokerError, MAX_RETURNED_CREDENTIAL_BYTES } = await import('../packages/core/src/agents/credentials/broker.ts');
const { collectStagedCredentials } = await import('../packages/core/src/agents/credentials/hostCredentialStaging.ts');

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'propr-credential-bounded-'));
test.after(() => fs.rmSync(scratch, { recursive: true, force: true }));
const SECRET_ENV_LIMIT = 64 * 1024;

let storeCounter = 0;
function makeStore(files: Record<string, string>): string {
    const root = path.join(scratch, `store-${storeCounter++}`);
    fs.mkdirSync(root, { recursive: true });
    for (const [relative, content] of Object.entries(files)) {
        fs.mkdirSync(path.dirname(path.join(root, relative)), { recursive: true });
        fs.writeFileSync(path.join(root, relative), content, { mode: 0o600 });
    }
    return root;
}

/**
 * Count the bytes the broker reads from `target` while `fn` runs. `growAfterStat`
 * appends that many bytes right after the broker's `fstat` of `target`, i.e. the
 * file grows between the size check and the read.
 */
async function readsOf<T>(target: string, fn: () => T | Promise<T>, growAfterStat = 0): Promise<{ value: T; bytesRead: number; wholeFileReads: number }> {
    const fds = new Set<number>();
    let bytesRead = 0;
    let wholeFileReads = 0;
    const { openSync, readSync, fstatSync, readFileSync } = fs;
    mock.method(fs, 'openSync', (file: fs.PathLike, ...rest: any[]) => {
        const fd = openSync(file, ...rest);
        if (String(file) === target) fds.add(fd);
        return fd;
    });
    mock.method(fs, 'fstatSync', (fd: number, ...rest: any[]) => {
        const stat = fstatSync(fd, ...rest);
        if (fds.has(fd) && growAfterStat > 0) fs.appendFileSync(target, Buffer.alloc(growAfterStat, 0x61));
        return stat;
    });
    mock.method(fs, 'readSync', (fd: number, ...rest: any[]) => {
        const read = (readSync as (...args: any[]) => number)(fd, ...rest);
        if (fds.has(fd)) bytesRead += read;
        return read;
    });
    mock.method(fs, 'readFileSync', (file: any, ...rest: any[]) => {
        if (String(file) === target) wholeFileReads++;
        return (readFileSync as (...args: any[]) => unknown)(file, ...rest);
    });
    try {
        const value = await fn();
        return { value, bytesRead, wholeFileReads };
    } finally {
        mock.restoreAll();
    }
}

const broker = (options: { maxBytes?: number } = {}) => new CredentialBroker({ lock: { lockRoot: path.join(scratch, 'locks') }, ...options });

test('an oversized Vibe .env is skipped without reading it', async () => {
    const root = makeStore({ 'config.toml': '' });
    const envFile = path.join(root, '.env');
    fs.writeFileSync(envFile, 'MISTRAL_API_KEY=from-huge-file\n');
    fs.truncateSync(envFile, 1024 * 1024 * 1024); // sparse 1 GiB
    const { value: bundle, bytesRead, wholeFileReads } = await readsOf(envFile, () => broker().materialize([{ id: 'vibe-config', provider: 'vibe', store: 'config', canonicalRoot: root }]));
    assert.deepEqual(bundle.secretEnv, {});
    assert.equal(bytesRead, 0, 'the size is checked before any read');
    assert.equal(wholeFileReads, 0);
});

test('a Vibe .env growing past the limit after its size check is read only up to the limit', async () => {
    const root = makeStore({ 'config.toml': '', '.env': 'MISTRAL_API_KEY=grown\n' });
    const envFile = path.join(root, '.env');
    const { value: bundle, bytesRead, wholeFileReads } = await readsOf(envFile,
        () => broker().materialize([{ id: 'vibe-config', provider: 'vibe', store: 'config', canonicalRoot: root }]), 4 * 1024 * 1024);
    assert.deepEqual(bundle.secretEnv, {}, 'an oversized secret file is ignored');
    assert.ok(bytesRead <= SECRET_ENV_LIMIT + 1, `read ${bytesRead} bytes`);
    assert.equal(wholeFileReads, 0);
    // Within the limit the key is still extracted.
    fs.writeFileSync(envFile, 'MISTRAL_API_KEY=small\n');
    assert.deepEqual(broker().materialize([{ id: 'vibe-config', provider: 'vibe', store: 'config', canonicalRoot: root }]).secretEnv, { MISTRAL_API_KEY: 'small' });
});

test('a store file growing after its size check stops the copy at the store limit', async () => {
    const root = makeStore({ '.credentials.json': 'token', 'settings.json': '{}' });
    const settings = path.join(root, 'settings.json');
    const { bytesRead } = await readsOf(settings, () => {
        assert.throws(() => broker({ maxBytes: 4096 }).materialize([{ id: 'claude-config', provider: 'claude', store: 'config', canonicalRoot: root }]),
            (error: unknown) => error instanceof CredentialBrokerError && /per-run copy limit/.test((error as Error).message));
    }, 1024 * 1024);
    assert.ok(bytesRead <= 4096 + 1, `read ${bytesRead} bytes`);
});

test('a canonical token grown past the store limit is not read whole at write-back', async () => {
    const root = makeStore({ '.credentials.json': 'v0' });
    const writer = broker({ maxBytes: 4096 });
    const bundle = writer.materialize([{ id: 'claude-config', provider: 'claude', store: 'config', canonicalRoot: root }]);
    const canonical = path.join(root, '.credentials.json');
    fs.truncateSync(canonical, 1024 * 1024 * 1024); // another tool replaced it with something huge
    const commit = () => writer.commit(bundle, [{ storeId: 'claude-config', path: '.credentials.json', content: Buffer.from('v1'), mtimeMs: Date.now() }]);
    const { bytesRead, wholeFileReads } = await readsOf(canonical, () => assert.rejects(commit(),
        (error: unknown) => error instanceof CredentialBrokerError && /exceeds the per-run copy limit/.test((error as Error).message)));
    assert.equal(bytesRead + wholeFileReads, 0);
    assert.equal(fs.statSync(canonical).size, 1024 * 1024 * 1024, 'the canonical file is left alone');
});

test('a staged token grown past the return limit after its size check is skipped after a bounded read', async () => {
    const root = makeStore({ 'auth.json': 'v0' });
    const bundle = broker().materialize([{ id: 'codex-config', provider: 'codex', store: 'config', canonicalRoot: root }]);
    const stagingDir = path.join(scratch, `staging-${storeCounter++}`);
    fs.mkdirSync(path.join(stagingDir, 'codex-config'), { recursive: true });
    const staged = path.join(stagingDir, 'codex-config', 'auth.json');
    fs.writeFileSync(staged, 'v1');
    const { value: returned, bytesRead, wholeFileReads } = await readsOf(staged, () => collectStagedCredentials(bundle, stagingDir), 2 * MAX_RETURNED_CREDENTIAL_BYTES);
    assert.deepEqual(returned, []);
    assert.ok(bytesRead <= MAX_RETURNED_CREDENTIAL_BYTES + 1, `read ${bytesRead} bytes`);
    assert.equal(wholeFileReads, 0);
    fs.writeFileSync(staged, 'v1');
    assert.deepEqual(collectStagedCredentials(bundle, stagingDir).map(file => file.content.toString()), ['v1']);
});
