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
const lockModule = process.env.PROPR_TEST_CREDENTIAL_LOCK_MODULE
    ?? path.join(here, '..', 'packages', 'core', 'src', 'agents', 'credentials', 'credentialStoreLock.ts');

function runContender(args: string[], env: Record<string, string> = {}): Promise<void> {
    return new Promise((resolve, reject) => {
        const child = spawn(process.execPath, ['--import', 'tsx', contender, lockModule, ...args], { stdio: ['ignore', 'ignore', 'pipe'], env: { ...process.env, ...env } });
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
