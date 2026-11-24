import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const { credentialStoreLockPath } = await import('../packages/core/src/agents/credentials/credentialStoreLock.ts');

const here = path.dirname(fileURLToPath(import.meta.url));
const contender = path.join(here, 'fixtures', 'credentialStoreLockContender.ts');
const lockModule = process.env.PROPR_TEST_CREDENTIAL_LOCK_MODULE
    ?? path.join(here, '..', 'packages', 'core', 'src', 'agents', 'credentials', 'credentialStoreLock.ts');

function runContender(args: string[]): Promise<void> {
    return new Promise((resolve, reject) => {
        const child = spawn(process.execPath, ['--import', 'tsx', contender, lockModule, ...args], { stdio: ['ignore', 'ignore', 'pipe'] });
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
        fs.writeFileSync(lockPath, 'crashed-holder 4242 2026-11-24T00:00:00.000Z\n');
        const ancient = (Date.now() - 10 * 60_000) / 1000;
        fs.utimesSync(lockPath, ancient, ancient);

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
        assert.deepEqual(fs.readdirSync(lockRoot), [], 'the lock, pending links and takeover markers are all cleaned up');
    } finally {
        fs.rmSync(scratch, { recursive: true, force: true });
    }
});
