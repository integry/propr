import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, utimes, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { execFile } from 'node:child_process';
import {
    createGitRescueRefPruneDependencies, isRescueRef, pruneRescueBundles, pruneRescueRefs, rescueRefName, sanitizeRescueId,
} from '../packages/core/src/git/rescueRefs.js';

const execGit = promisify(execFile);
const DAY = 24 * 60 * 60 * 1000;

async function git(cwd: string, args: string[]): Promise<string> {
    const { stdout } = await execGit('git', args, { cwd });
    return stdout.trim();
}

test('rescue ref names are valid single path components and recognised everywhere', () => {
    assert.equal(rescueRefName('pr-comment:integry/propr#12'), 'refs/propr/rescue/pr-comment-integry-propr-12');
    assert.equal(sanitizeRescueId('..hidden.lock'), 'hidden-lock');
    assert.ok(isRescueRef('refs/propr/rescue/task-1'));
    assert.ok(isRescueRef('refs/heads/propr/rescue/task-1'));
    assert.ok(!isRescueRef('refs/heads/2736/salvage'));
    assert.ok(!isRescueRef('main'));
});

test('only rescue refs older than the retention period are deleted', async () => {
    const now = new Date('2026-10-20T00:00:00Z');
    const deleted: string[] = [];
    const result = await pruneRescueRefs({
        listRefs: async () => [
            { ref: 'refs/propr/rescue/old', sha: 'a' },
            { ref: 'refs/propr/rescue/new', sha: 'b' },
            { ref: 'refs/propr/rescue/unknown', sha: 'c' },
            { ref: 'refs/heads/main', sha: 'd' },
        ],
        commitDate: async sha => ({ a: new Date(now.getTime() - 15 * DAY), b: new Date(now.getTime() - 2 * DAY) } as Record<string, Date>)[sha],
        deleteRef: async ref => { deleted.push(ref); },
    }, { olderThanDays: 14, now });
    assert.deepEqual(deleted, ['refs/propr/rescue/old']);
    assert.deepEqual(result, { deleted: ['refs/propr/rescue/old'], retained: 2, failed: 0 });
});

test('git prune dependencies list and delete rescue refs on the remote only', async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), 'propr-rescue-prune-'));
    try {
        const remote = path.join(tempDir, 'remote.git');
        const clone = path.join(tempDir, 'clone');
        await git(tempDir, ['init', '--bare', remote]);
        await git(tempDir, ['clone', remote, clone]);
        await git(clone, ['config', 'user.email', 'test@example.com']);
        await git(clone, ['config', 'user.name', 'Test']);
        await writeFile(path.join(clone, 'file.txt'), 'work\n');
        await git(clone, ['add', '.']);
        await git(clone, ['commit', '-m', 'work']);
        await git(clone, ['push', 'origin', 'HEAD:refs/heads/main', 'HEAD:refs/propr/rescue/task-1']);

        const deps = createGitRescueRefPruneDependencies({ repoUrl: remote, token: 'token', commitDate: async () => new Date(0) });
        const listed = await deps.listRefs();
        assert.deepEqual(listed.map(entry => entry.ref), ['refs/propr/rescue/task-1']);

        const result = await pruneRescueRefs(deps, { olderThanDays: 14 });
        assert.deepEqual(result.deleted, ['refs/propr/rescue/task-1']);
        assert.equal(await git(remote, ['for-each-ref', 'refs/propr']), '');
        assert.notEqual(await git(remote, ['rev-parse', 'refs/heads/main']), '');
    } finally {
        await rm(tempDir, { recursive: true, force: true });
    }
});

test('expired rescue bundles are deleted and empty directories removed', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'propr-rescue-bundles-'));
    try {
        const repoDir = path.join(directory, 'integry', 'propr');
        await mkdir(repoDir, { recursive: true });
        const oldBundle = path.join(repoDir, 'old.bundle');
        const newBundle = path.join(directory, 'integry', 'other', 'new.bundle');
        await writeFile(oldBundle, 'old');
        await mkdir(path.dirname(newBundle), { recursive: true });
        await writeFile(newBundle, 'new');
        const fifteenDaysAgo = new Date(Date.now() - 15 * DAY);
        await utimes(oldBundle, fifteenDaysAgo, fifteenDaysAgo);

        const result = await pruneRescueBundles({ directory, olderThanDays: 14 });
        assert.deepEqual(result.deleted, [oldBundle]);
        assert.equal(result.retained, 1);
        assert.ok(!existsSync(repoDir));
        assert.ok(existsSync(newBundle));
    } finally {
        await rm(directory, { recursive: true, force: true });
    }
});
