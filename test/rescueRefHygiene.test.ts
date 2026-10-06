import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, utimes, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { execFile } from 'node:child_process';
import fs from 'fs-extra';
import {
    createGitRescueRefPruneDependencies, isRescueRef, pruneRescueBundles, pruneRescueRefs, rescueRefCreatedAt, rescueRefName, sanitizeRescueId,
} from '../packages/core/src/git/rescueRefs.js';

const execGit = promisify(execFile);
const DAY = 24 * 60 * 60 * 1000;

async function git(cwd: string, args: string[]): Promise<string> {
    const { stdout } = await execGit('git', args, { cwd });
    return stdout.trim();
}

test('rescue ref names are valid single path components and recognised everywhere', () => {
    const createdAt = new Date('2026-10-06T12:34:56.789Z');
    assert.equal(rescueRefName('pr-comment:integry/propr#12', createdAt), 'refs/propr/rescue/pr-comment-integry-propr-12--20261006T123456Z');
    assert.equal(sanitizeRescueId('..hidden.lock'), 'hidden-lock');
    assert.ok(isRescueRef('refs/propr/rescue/task-1'));
    assert.ok(isRescueRef('refs/heads/propr/rescue/task-1'));
    assert.ok(!isRescueRef('refs/heads/2736/salvage'));
    assert.ok(!isRescueRef('main'));
});

test('the rescue creation time is read back from the ref name', () => {
    const createdAt = new Date('2026-10-06T12:34:56Z');
    assert.deepEqual(rescueRefCreatedAt(rescueRefName('task--1', createdAt)), createdAt);
    assert.equal(rescueRefCreatedAt('refs/propr/rescue/task-1'), undefined);
    assert.equal(rescueRefCreatedAt('refs/propr/rescue/task-1--20261306T000000Z'), undefined);
    assert.equal(rescueRefCreatedAt('refs/propr/rescue/task-1--20261006T120000Z-extra'), undefined);
});

test('only rescue refs created longer ago than the retention period are deleted', async () => {
    const now = new Date('2026-10-20T00:00:00Z');
    const oldRef = rescueRefName('old', new Date(now.getTime() - 15 * DAY));
    const newRef = rescueRefName('new', new Date(now.getTime() - 2 * DAY));
    const deleted: string[] = [];
    const result = await pruneRescueRefs({
        listRefs: async () => [
            { ref: oldRef, sha: 'a' },
            { ref: newRef, sha: 'b' },
            // No creation time in the name: the ref's age cannot be established.
            { ref: 'refs/propr/rescue/unknown', sha: 'c' },
            { ref: 'refs/heads/main', sha: 'd' },
        ],
        deleteRef: async ref => { deleted.push(ref); },
    }, { olderThanDays: 14, now });
    assert.deepEqual(deleted, [oldRef]);
    assert.deepEqual(result, { deleted: [oldRef], retained: 2, failed: 0 });
});

test('a fresh rescue of a commit with an old committer date is retained', async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), 'propr-rescue-old-commit-'));
    try {
        const remote = path.join(tempDir, 'remote.git');
        const clone = path.join(tempDir, 'clone');
        await git(tempDir, ['init', '--bare', remote]);
        await git(tempDir, ['clone', remote, clone]);
        await git(clone, ['config', 'user.email', 'test@example.com']);
        await git(clone, ['config', 'user.name', 'Test']);
        await writeFile(path.join(clone, 'file.txt'), 'imported work\n');
        await git(clone, ['add', '.']);
        const historical = '2001-01-01T00:00:00Z';
        await execGit('git', ['commit', '-m', 'imported'], {
            cwd: clone, env: { ...process.env, GIT_AUTHOR_DATE: historical, GIT_COMMITTER_DATE: historical },
        });
        const ref = rescueRefName('task-1');
        await git(clone, ['push', 'origin', `HEAD:${ref}`]);

        const result = await pruneRescueRefs(createGitRescueRefPruneDependencies({ repoUrl: remote, token: 'token' }), { olderThanDays: 14 });
        assert.deepEqual(result, { deleted: [], retained: 1, failed: 0 });
        assert.notEqual(await git(remote, ['rev-parse', ref]), '');
    } finally {
        await rm(tempDir, { recursive: true, force: true });
    }
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
        const ref = rescueRefName('task-1', new Date(Date.now() - 30 * DAY));
        await git(clone, ['push', 'origin', 'HEAD:refs/heads/main', `HEAD:${ref}`]);

        const deps = createGitRescueRefPruneDependencies({ repoUrl: remote, token: 'token' });
        const listed = await deps.listRefs();
        assert.deepEqual(listed.map(entry => entry.ref), [ref]);

        const result = await pruneRescueRefs(deps, { olderThanDays: 14 });
        assert.deepEqual(result.deleted, [ref]);
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

test('a bundle written after the sweep emptied its directory survives the directory cleanup', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'propr-rescue-bundles-'));
    const originalRemove = fs.remove;
    const originalRmdir = fs.rmdir;
    try {
        const repoDir = path.join(directory, 'integry', 'propr');
        await mkdir(repoDir, { recursive: true });
        const oldBundle = path.join(repoDir, 'old.bundle');
        const freshBundle = path.join(repoDir, 'fresh.bundle');
        await writeFile(oldBundle, 'old');
        const fifteenDaysAgo = new Date(Date.now() - 15 * DAY);
        await utimes(oldBundle, fifteenDaysAgo, fifteenDaysAgo);

        // A worker salvages into the directory after the sweep deleted its last expired
        // bundle, just before the sweep removes the directory.
        const salvageBeforeDirectoryRemoval = async (target: unknown) => {
            if (target === repoDir && !existsSync(freshBundle)) await writeFile(freshBundle, 'fresh');
        };
        (fs as { remove: unknown }).remove = async (target: string) => {
            await salvageBeforeDirectoryRemoval(target);
            return originalRemove(target);
        };
        (fs as { rmdir: unknown }).rmdir = async (target: string) => {
            await salvageBeforeDirectoryRemoval(target);
            return originalRmdir(target);
        };

        const result = await pruneRescueBundles({ directory, olderThanDays: 14 });
        assert.deepEqual(result.deleted, [oldBundle]);
        assert.ok(existsSync(freshBundle));
    } finally {
        (fs as { remove: unknown }).remove = originalRemove;
        (fs as { rmdir: unknown }).rmdir = originalRmdir;
        await rm(directory, { recursive: true, force: true });
    }
});

test('directories that disappear during the sweep are skipped', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'propr-rescue-bundles-'));
    const originalRmdir = fs.rmdir;
    try {
        const repoDir = path.join(directory, 'integry', 'propr');
        await mkdir(repoDir, { recursive: true });
        (fs as { rmdir: unknown }).rmdir = async (target: string) => {
            await originalRmdir(target);
            if (target === repoDir) await originalRmdir(target);
        };
        const result = await pruneRescueBundles({ directory, olderThanDays: 14 });
        assert.deepEqual(result.deleted, []);
        assert.ok(!existsSync(path.join(directory, 'integry')));
    } finally {
        (fs as { rmdir: unknown }).rmdir = originalRmdir;
        await rm(directory, { recursive: true, force: true });
    }
});

test('rescue ids trim long runs of separators', () => {
    assert.equal(sanitizeRescueId(`${'-'.repeat(50_000)}a${'.-'.repeat(50_000)}`), 'a');
    assert.equal(sanitizeRescueId('-.-'), 'task');
});
