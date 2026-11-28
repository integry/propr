import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const { credentialStoreLockPath, inspectCredentialStoreLock } = await import('../packages/core/src/agents/credentials/credentialStoreLock.ts');

const here = path.dirname(fileURLToPath(import.meta.url));
const contender = path.join(here, 'fixtures', 'credentialStoreLockContender.ts');
const writeBackContender = path.join(here, 'fixtures', 'credentialWriteBackContender.ts');
const writerContender = path.join(here, 'fixtures', 'credentialStoreWriterContender.ts');
const lockModule = process.env.PROPR_TEST_CREDENTIAL_LOCK_MODULE
    ?? path.join(here, '..', 'packages', 'core', 'src', 'agents', 'credentials', 'credentialStoreLock.ts');
const brokerModule = process.env.PROPR_TEST_CREDENTIAL_BROKER_MODULE
    ?? path.join(here, '..', 'packages', 'core', 'src', 'agents', 'credentials', 'broker.ts');
const writerModule = process.env.PROPR_TEST_CREDENTIAL_WRITER_MODULE
    ?? path.join(here, '..', 'packages', 'core', 'src', 'agents', 'credentials', 'credentialStoreWriter.ts');

function runContender(args: string[], env: Record<string, string> = {}, script = contender, module = lockModule): Promise<void> {
    return new Promise((resolve, reject) => {
        const child = spawn(process.execPath, ['--import', 'tsx', script, module, ...args], { stdio: ['ignore', 'ignore', 'pipe'], env: { ...process.env, ...env } });
        let stderr = '';
        child.stderr.on('data', chunk => { stderr += chunk; });
        child.on('error', reject);
        child.on('exit', code => (code === 0 ? resolve() : reject(new Error(`contender ${args[3]} exited ${code}: ${stderr}`))));
    });
}

test('competing worker processes reclaiming one stale lock never hold it at the same time', { timeout: 60_000 }, async () => {
    const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'propr-credential-lock-mp-'));
    try {
        const lockRoot = path.join(scratch, 'locks');
        const store = path.join(scratch, 'store');
        const workDir = path.join(scratch, 'work');
        fs.mkdirSync(lockRoot);
        fs.mkdirSync(store);
        fs.mkdirSync(workDir);
        // A worker crashed holding the lock.
        const lockPath = credentialStoreLockPath(lockRoot, store);
        fs.mkdirSync(lockPath);
        fs.writeFileSync(path.join(lockPath, '1'), '4242 2026-11-24T00:00:00.000Z\n');
        const ancient = (Date.now() - 10 * 60_000) / 1000;
        fs.utimesSync(path.join(lockPath, '1'), ancient, ancient);

        const shared = [lockRoot, store, workDir];
        const reclaimers = [
            // "fast" breaks the stale lock, takes the replacement and holds it.
            runContender([...shared, 'fast', '800', '0', 'fast,slow']),
            // "slow" saw the same stale lock but resumes only after "fast" holds its replacement.
            runContender([...shared, 'slow', '50', '300', 'fast,slow']),
        ];
        const observed = (id: string) => fs.existsSync(path.join(workDir, `observed-${id}`));
        const deadline = Date.now() + 20_000;
        while (!(observed('fast') && observed('slow')) && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 10));
        assert.ok(observed('fast') && observed('slow'), 'both reclaimers observed the stale holder');
        // Later contenders queue behind whichever holder is current.
        await Promise.all([...reclaimers, ...['c1', 'c2', 'c3'].map(id => runContender([...shared, id, '20', '0', '']))]);

        const violations = fs.existsSync(path.join(workDir, 'violations')) ? fs.readFileSync(path.join(workDir, 'violations'), 'utf8') : '';
        assert.equal(violations, '', 'a reclaimer removed the replacement holder\'s lock');
        assert.deepEqual(fs.readFileSync(path.join(workDir, 'completed'), 'utf8').trim().split('\n').sort(), ['c1', 'c2', 'c3', 'fast', 'slow']);
        assert.deepEqual(inspectCredentialStoreLock(lockRoot, store), { epoch: 6, held: false }, 'one epoch per acquisition, all released');
    } finally {
        fs.rmSync(scratch, { recursive: true, force: true });
    }
});

test('an old holder resuming its release after a stale takeover never frees the replacement lock', { timeout: 60_000 }, async () => {
    const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'propr-credential-lock-release-'));
    try {
        const lockRoot = path.join(scratch, 'locks');
        const store = path.join(scratch, 'store');
        const workDir = path.join(scratch, 'work');
        for (const dir of [lockRoot, store, workDir]) fs.mkdirSync(dir);
        const shared = [lockRoot, store, workDir];
        const marker = (name: string) => fs.existsSync(path.join(workDir, name));
        const waitFor = async (name: string) => {
            const deadline = Date.now() + 20_000;
            while (!marker(name) && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 5));
            assert.ok(marker(name), `${name} was reached`);
        };
        // "old" is paused between finishing and releasing until "replacement" holds a lock taken over from it.
        const old = runContender([...shared, 'old', '0', '0', ''], { CONTENDER_STALE_MS: '300', CONTENDER_RELEASE_AFTER: 'replacement' });
        await waitFor('acquired-old');
        const replacement = runContender([...shared, 'replacement', '1500', '0', ''], { CONTENDER_STALE_MS: '300' });
        await old;
        assert.ok(marker('acquired-replacement'), 'the replacement took the lock over before the old holder released');
        // A third worker arriving after the old release must still wait for the replacement holder.
        const later = runContender([...shared, 'later', '20', '0', '']);
        await Promise.all([replacement, later]);

        const violations = marker('violations') ? fs.readFileSync(path.join(workDir, 'violations'), 'utf8') : '';
        assert.equal(violations, '', 'the old holder\'s release freed the replacement holder\'s lock');
        assert.deepEqual(fs.readFileSync(path.join(workDir, 'completed'), 'utf8').trim().split('\n'), ['old', 'replacement', 'later']);
        assert.deepEqual(inspectCredentialStoreLock(lockRoot, store), { epoch: 3, held: false });
    } finally {
        fs.rmSync(scratch, { recursive: true, force: true });
    }
});

test('a writer suspended before publishing cannot overwrite the newer token of the worker that took its stale lock over', { timeout: 60_000 }, async () => {
    const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'propr-credential-writeback-'));
    try {
        const lockRoot = path.join(scratch, 'locks');
        const store = path.join(scratch, 'store');
        const workDir = path.join(scratch, 'work');
        for (const dir of [lockRoot, store, workDir]) fs.mkdirSync(dir);
        fs.writeFileSync(path.join(store, '.credentials.json'), 'v0', { mode: 0o600 });
        const shared = [lockRoot, store, workDir];
        const marker = (name: string) => fs.existsSync(path.join(workDir, name));
        const waitFor = async (name: string) => {
            const deadline = Date.now() + 20_000;
            while (!marker(name) && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 5));
            assert.ok(marker(name), `${name} was reached`);
        };
        const result = (id: string) => JSON.parse(fs.readFileSync(path.join(workDir, `result-${id}`), 'utf8'));
        const base = Date.now();
        // Both runs started from v0. "old" refreshed earlier; it checked the canonical
        // baseline and prepared its replacement, then stays suspended before the rename
        // until "newer" has taken its lock over as stale and committed.
        const old = runContender([...shared, 'old', 'v-older', String(base + 10_000)],
            { CONTENDER_STALE_MS: '300', CONTENDER_PUBLISH_AFTER: 'newer' }, writeBackContender, brokerModule);
        await waitFor('publishing-old');
        assert.equal(fs.readFileSync(path.join(store, '.credentials.json'), 'utf8'), 'v0', 'nothing published yet');
        const newer = runContender([...shared, 'newer', 'v-newer', String(base + 20_000)], { CONTENDER_STALE_MS: '300' }, writeBackContender, brokerModule);
        await Promise.all([old, newer]);

        assert.deepEqual(result('newer'), ['written'], 'the newer run took the stale lock over and wrote its token');
        assert.equal(fs.readFileSync(path.join(store, '.credentials.json'), 'utf8'), 'v-newer', 'the superseded writer overwrote the newer token');
        // The superseded writer re-acquired the lock and found a newer canonical token.
        assert.deepEqual(result('old'), ['kept-canonical']);
        assert.deepEqual(fs.readdirSync(store), ['.credentials.json'], 'no publication directory or prepared replacement is left in the store');
        assert.deepEqual(inspectCredentialStoreLock(lockRoot, store), { epoch: 3, held: false });
    } finally {
        fs.rmSync(scratch, { recursive: true, force: true });
    }
});

test('a removal suspended before publishing cannot delete the credential of the writer that took its stale lock over', { timeout: 60_000 }, async () => {
    const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'propr-credential-removal-'));
    try {
        const lockRoot = path.join(scratch, 'locks');
        const store = path.join(scratch, 'store');
        const workDir = path.join(scratch, 'work');
        for (const dir of [lockRoot, store, workDir]) fs.mkdirSync(dir);
        fs.writeFileSync(path.join(store, 'auth.json'), 'pasted-v0', { mode: 0o600 });
        const shared = [lockRoot, store, workDir];
        const marker = (name: string) => fs.existsSync(path.join(workDir, name));
        const waitFor = async (name: string) => {
            const deadline = Date.now() + 20_000;
            while (!marker(name) && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 5));
            assert.ok(marker(name), `${name} was reached`);
        };
        const result = (id: string) => JSON.parse(fs.readFileSync(path.join(workDir, `result-${id}`), 'utf8'));
        // "removal" holds the lock and has recorded its mutation as pending, then stays
        // suspended before deleting auth.json until "successor" has taken its lock over
        // as stale and published a replacement.
        const removal = runContender([...shared, 'removal', 'auth.json', '-'],
            { CONTENDER_STALE_MS: '300', CONTENDER_PUBLISH_AFTER: 'successor' }, writerContender, writerModule);
        await waitFor('publishing-removal');
        assert.equal(fs.readFileSync(path.join(store, 'auth.json'), 'utf8'), 'pasted-v0', 'nothing removed yet');
        const successor = runContender([...shared, 'successor', 'auth.json', 'pasted-v1'], { CONTENDER_STALE_MS: '300' }, writerContender, writerModule);
        await Promise.all([removal, successor]);

        assert.equal(result('successor'), 'written', 'the successor took the stale lock over and published its credential');
        assert.equal(fs.readFileSync(path.join(store, 'auth.json'), 'utf8'), 'pasted-v1', 'the resumed removal deleted the successor\'s credential');
        assert.match(result('removal').error, /taken over as stale/);
        const record = JSON.parse(fs.readFileSync(path.join(store, '.propr-operator-mutations.json'), 'utf8'));
        assert.deepEqual(record.pending, [], 'the successor cleared the mark; the superseded writer could not touch the record');
        assert.deepEqual(fs.readdirSync(store).sort(), ['.propr-operator-mutations.json', 'auth.json'], 'no publication or removal directory is left');
        assert.deepEqual(inspectCredentialStoreLock(lockRoot, store), { epoch: 2, held: false });
    } finally {
        fs.rmSync(scratch, { recursive: true, force: true });
    }
});
