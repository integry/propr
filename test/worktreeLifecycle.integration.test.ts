import { test, before, beforeEach, after, mock } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'fs-extra';
import path from 'node:path';
import os from 'node:os';
import knex from 'knex';
import { simpleGit, type SimpleGit } from 'simple-git';

// Import production entry points only after isolating their fixed storage paths.
const root = await fs.mkdtemp(path.join(os.tmpdir(), 'propr-worktree-lifecycle-'));
process.env.GIT_CLONES_BASE_PATH = path.join(root, 'clones');
process.env.GIT_WORKTREES_BASE_PATH = path.join(root, 'worktrees');
process.env.GIT_CONFIG_GLOBAL = path.join(root, 'gitconfig');
process.env.PUSH_RESCUE_WORKTREE_RECORD_DIR = path.join(root, 'salvage-records');
const bin = path.join(root, 'bin');
await fs.ensureDir(bin);
await fs.writeFile(path.join(bin, 'docker'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
await fs.writeFile(path.join(bin, 'sudo'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
process.env.PATH = `${bin}${path.delimiter}${process.env.PATH}`;
const handoffDb = knex({ client: 'better-sqlite3', connection: { filename: ':memory:' }, useNullAsDefault: true });
await handoffDb.schema.createTable('pr_followup_handoffs', table => {
    table.string('worktree_path'); table.string('status'); table.string('phase');
});
await mock.module('../packages/core/src/db/connection.js', { namedExports: { db: handoffDb } });
const { cleanupExistingBranch, addWorktreeWithoutTracking, removeStaleWorktreeRegistration,
    clearMissingWorktreeRegistration, releaseBranchFromSettledWorktree } =
    await import('../packages/core/src/git/worktreeCreation.js');
const { cleanupWorktree, cleanupExpiredWorktrees, safePruneWorktrees,
    createWorktreeForIssue, createWorktreeFromExistingBranch } =
    await import('../packages/core/src/git/repoManager.js');

let repo: string;
let git: SimpleGit;
let worktree: string;
let repoName: string;
let initial: string;
let serial = 0;
before(async () => fs.ensureDir(process.env.GIT_CLONES_BASE_PATH!));
beforeEach(async () => {
    repoName = `repo-${++serial}`;
    repo = path.join(root, 'clones', 'owner', repoName);
    worktree = path.join(root, 'worktrees', 'owner', repoName, 'checkout');
    await fs.ensureDir(repo);
    git = simpleGit(repo);
    await git.init(['--initial-branch=main']);
    await git.addConfig('user.name', 'Test User');
    await git.addConfig('user.email', 'test@example.com');
    await fs.writeFile(path.join(repo, '.gitignore'), 'private.env\n');
    await fs.writeFile(path.join(repo, 'tracked'), 'initial');
    await git.add('.').commit('initial');
    initial = (await git.revparse(['HEAD'])).trim();
});
after(async () => { await handoffDb.destroy(); await fs.remove(root); });

async function create(branch = 'task') {
    await fs.ensureDir(path.dirname(worktree));
    await addWorktreeWithoutTracking(git, worktree, branch, { startPoint: 'main' });
    return simpleGit(worktree);
}
async function privateWork(wt: SimpleGit) {
    await fs.writeFile(path.join(worktree, 'tracked'), 'unpublished');
    await wt.add('.').commit('unpublished');
    await fs.writeFile(path.join(worktree, 'tracked'), 'staged');
    await wt.add('tracked');
    await fs.writeFile(path.join(worktree, 'tracked'), 'unstaged');
    await fs.writeFile(path.join(worktree, 'untracked'), 'untracked data');
    await fs.writeFile(path.join(worktree, 'private.env'), 'private data');
    return { head: await wt.revparse(['HEAD']), index: await wt.raw(['show', ':tracked']) };
}
async function assertPrivateWork(wt: SimpleGit, expected: Awaited<ReturnType<typeof privateWork>>) {
    assert.equal(await wt.revparse(['HEAD']), expected.head);
    assert.equal(await wt.raw(['show', ':tracked']), expected.index);
    assert.equal(await fs.readFile(path.join(worktree, 'tracked'), 'utf8'), 'unstaged');
    assert.equal(await fs.readFile(path.join(worktree, 'untracked'), 'utf8'), 'untracked data');
    assert.equal(await fs.readFile(path.join(worktree, 'private.env'), 'utf8'), 'private data');
    assert.equal(await git.revparse(['refs/heads/task']), expected.head);
    assert.match(await git.raw(['worktree', 'list', '--porcelain']), new RegExp(worktree));
}

test('missing refs succeed in an unborn repository and a populated repository', async () => {
    const empty = path.join(root, 'empty');
    await fs.ensureDir(empty);
    const emptyGit = simpleGit(empty);
    await emptyGit.init();
    await cleanupExistingBranch(emptyGit, 'never-existed');
    await cleanupExistingBranch(git, 'never-existed');
    await git.branch(['prefix/child']);
    await cleanupExistingBranch(git, 'prefix'); // prefix matches are not exact refs
});

test('existing loose and packed branches are retained at their original commits', async () => {
    await git.branch(['task']);
    await assert.rejects(cleanupExistingBranch(git, 'task'), /Existing branch retained/);
    await git.raw(['pack-refs', '--all']);
    await assert.rejects(cleanupExistingBranch(git, 'task'), /Existing branch retained/);
    assert.equal((await git.revparse(['task'])).trim(), initial);
});

test('reuse creates a missing local branch from the requested start point without tracking', async () => {
    await addWorktreeWithoutTracking(git, worktree, 'task', { startPoint: 'main', resetBranch: true });
    assert.equal((await simpleGit(worktree).revparse(['HEAD'])).trim(), initial);
    assert.equal((await git.raw(['config', '--get', 'branch.task.remote'])).trim(), '');
});

test('reuse preserves a packed local branch ahead of its requested start point', async () => {
    const wt = await create();
    const saved = await privateWork(wt);
    await cleanupWorktree(repo, worktree, 'task', { deleteBranch: true });
    await git.raw(['pack-refs', '--all']);
    const retry = `${worktree}-retry`;
    await addWorktreeWithoutTracking(git, retry, 'task', { startPoint: 'main', resetBranch: true });
    assert.equal(await simpleGit(retry).revparse(['HEAD']), saved.head);
    await assertPrivateWork(wt, saved);
});

test('an occupied branch and an existing nonempty destination fail without losing private work', async () => {
    const wt = await create();
    const saved = await privateWork(wt);
    await assert.rejects(addWorktreeWithoutTracking(git, `${worktree}-retry`, 'task', {
        startPoint: 'main', resetBranch: true,
    }), /already (?:checked out|used by worktree)/);
    await assert.rejects(addWorktreeWithoutTracking(git, worktree, 'other', { startPoint: 'main' }));
    await assertPrivateWork(wt, saved);
});

for (const strategy of ['always_delete', 'keep_on_failure', 'keep_for_hours']) {
    for (const success of [true, false]) {
        test(`production cleanup preserves all work with ${strategy}, success=${success}`, async () => {
            const wt = await create();
            const saved = await privateWork(wt);
            await cleanupWorktree(repo, worktree, 'task', {
                deleteBranch: true, success, retentionStrategy: strategy, retentionHours: 0,
            });
            await assertPrivateWork(wt, saved);
        });
    }
}

test('expired retention markers cannot authorize deletion', async () => {
    const wt = await create();
    const saved = await privateWork(wt);
    await fs.writeJson(path.join(worktree, '.retention-info.json'), { scheduledCleanup: '2000-01-01T00:00:00Z' });
    assert.equal((await cleanupExpiredWorktrees(path.join(root, 'worktrees'))).cleaned, 0);
    await assertPrivateWork(wt, saved);
});

test('missing checkouts keep their administrative HEAD and registration even when old', async () => {
    const wt = await create();
    await wt.checkout(['--detach']);
    await fs.writeFile(path.join(worktree, 'tracked'), 'detached history');
    await wt.add('.').commit('detached commit');
    const head = await wt.revparse(['HEAD']);
    const admin = (await fs.readFile(path.join(worktree, '.git'), 'utf8')).trim().slice('gitdir: '.length);
    await fs.move(worktree, `${worktree}-offline`);
    await fs.utimes(admin, new Date(0), new Date(0));
    assert.equal(await removeStaleWorktreeRegistration(git, worktree), false);
    assert.equal((await safePruneWorktrees(repo, 0)).pruned, 0);
    assert.equal((await fs.readFile(path.join(admin, 'HEAD'), 'utf8')).trim(), head.trim());
    assert.match(await git.raw(['worktree', 'list', '--porcelain']), new RegExp(worktree));
});

test('real Git errors abort branch checks and reuse without creating a checkout', async () => {
    const invalid = path.join(root, 'not-a-repo');
    await fs.ensureDir(invalid);
    const invalidGit = simpleGit(invalid);
    await assert.rejects(cleanupExistingBranch(invalidGit, 'missing'), /not a git repository/);
    await assert.rejects(addWorktreeWithoutTracking(invalidGit, worktree, 'missing', {
        startPoint: 'main', resetBranch: true,
    }), /not a git repository/);
    // An unreadable ref database must not be interpreted as an absent branch.
    await fs.writeFile(path.join(repo, '.git', 'packed-refs'), 'invalid packed refs\n');
    await assert.rejects(cleanupExistingBranch(git, 'missing'), /packed-refs/);
    await assert.rejects(addWorktreeWithoutTracking(git, worktree, 'missing', {
        startPoint: 'main', resetBranch: true,
    }), /packed-refs/);
    assert.equal(await fs.pathExists(worktree), false);
});

test('a broken loose branch ref fails closed instead of appearing absent', async () => {
    await fs.writeFile(path.join(repo, '.git', 'refs', 'heads', 'broken'), 'f'.repeat(40) + '\n');
    await assert.rejects(cleanupExistingBranch(git, 'broken'), /bad ref/);
    await assert.rejects(addWorktreeWithoutTracking(git, worktree, 'broken', {
        startPoint: 'main', resetBranch: true,
    }), /bad ref/);
    assert.equal(await fs.pathExists(worktree), false);
    assert.equal(await fs.readFile(path.join(repo, '.git', 'refs', 'heads', 'broken'), 'utf8'), 'f'.repeat(40) + '\n');
});

async function remoteBranch(branch: string) {
    const remote = path.join(root, `remote-${serial}.git`);
    await simpleGit().raw(['init', '--bare', '--initial-branch=main', remote]);
    await git.addRemote('origin', remote);
    await git.push('origin', `main:refs/heads/${branch}`);
    await git.push('origin', 'main');
    await git.fetch('origin');
}
const issue = () => ({ issueId: 42, issueTitle: 'Fix', owner: 'owner', repoName });

test('repoManager creates a fresh issue branch and falls back when a reuse ref is absent', async () => {
    await remoteBranch('published');
    for (const reuseBranch of [undefined, 'never-published']) {
        const result = await createWorktreeForIssue(repo, issue(), { baseBranch: 'main', reuseBranch });
        assert.equal((await simpleGit(result.worktreePath).revparse(['HEAD'])).trim(), initial);
        assert.notEqual(result.branchName, reuseBranch);
        assert.ok((await fs.stat(path.join(result.worktreePath, '.git'))).isFile());
    }
});

for (const entry of ['issue', 'existing'] as const) {
    test(`repoManager ${entry} path reuses remote-only then locally advanced branches safely`, async () => {
        await remoteBranch('task');
        const run = (dir: string) => entry === 'issue'
            ? createWorktreeForIssue(repo, issue(), { baseBranch: 'main', reuseBranch: 'task' })
            : createWorktreeFromExistingBranch(repo, 'task', { owner: 'owner', repoName, worktreeDirName: dir });
        const first = await run('first');
        worktree = first.worktreePath;
        const wt = simpleGit(worktree);
        const saved = await privateWork(wt);
        await assert.rejects(run('occupied'));
        await assertPrivateWork(wt, saved);
        await cleanupWorktree(repo, worktree, 'task', { deleteBranch: true });
        const retry = await run('retry');
        assert.equal(await simpleGit(retry.worktreePath).revparse(['HEAD']), saved.head);
        await assertPrivateWork(wt, saved);
        if (entry === 'existing') await assert.rejects(run('first'), /Existing worktree retained/);
        await assertPrivateWork(wt, saved);
    });
}

const { sweepIdleWorktrees, proveWorktreeDisposable, removeWorktreeIfDisposable, interruptedWorktreeRemovals } = await import('../packages/core/src/git/worktreeReclaim.js');

/** A finished task: its commit is on the task branch and only ignored files remain. */
async function finishedTask(branch = 'task') {
    const wt = await create(branch);
    await fs.writeFile(path.join(repo, '.gitignore'), 'private.env\nnode_modules/\n');
    await fs.writeFile(path.join(worktree, '.gitignore'), 'private.env\nnode_modules/\n');
    await fs.writeFile(path.join(worktree, 'tracked'), 'published');
    await wt.add('.').commit('task work');
    await fs.outputFile(path.join(worktree, 'node_modules', 'dep', 'index.js'), 'module.exports = 1;');
    return (await wt.revparse(['HEAD'])).trim();
}
const registered = async () => (await git.raw(['worktree', 'list', '--porcelain'])).includes(worktree);

for (const success of [true, false]) {
    test(`cleanup removes a finished worktree whose work is stored in Git (success=${success}) and keeps its branch`, async () => {
        const head = await finishedTask();
        await cleanupWorktree(repo, worktree, 'task', { success, retentionStrategy: 'always_delete' });
        assert.equal(await fs.pathExists(worktree), false);
        assert.equal(await registered(), false);
        assert.equal((await git.revparse(['refs/heads/task'])).trim(), head);
    });
}

test('cleanup keeps a clean worktree whose detached HEAD no ref contains', async () => {
    await finishedTask();
    const wt = simpleGit(worktree);
    await wt.checkout(['--detach']);
    await fs.writeFile(path.join(worktree, 'tracked'), 'detached');
    await wt.add('.').commit('detached only');
    await cleanupWorktree(repo, worktree, 'task', { success: true });
    assert.equal(await fs.pathExists(worktree), true);
    assert.equal(await registered(), true);
});

test('cleanup keeps finished worktrees with always_keep, and failures with keep_on_failure', async () => {
    await finishedTask();
    await cleanupWorktree(repo, worktree, 'task', { success: true, retentionStrategy: 'always_keep' });
    assert.equal(await fs.pathExists(worktree), true);
    await cleanupWorktree(repo, worktree, 'task', { success: false, retentionStrategy: 'keep_on_failure' });
    assert.equal(await fs.pathExists(worktree), true);
});

test('cleanup keeps a worktree in the middle of a merge', async () => {
    await finishedTask();
    const admin = (await fs.readFile(path.join(worktree, '.git'), 'utf8')).trim().slice('gitdir: '.length);
    await fs.writeFile(path.join(admin, 'MERGE_HEAD'), initial);
    await cleanupWorktree(repo, worktree, 'task', { success: true });
    assert.equal(await fs.pathExists(worktree), true);
});

test('the idle sweep removes only idle, unreferenced, unmounted worktrees whose work is in Git', async () => {
    const base = path.join(root, 'worktrees');
    const make = async (name: string, dirty = false) => {
        worktree = path.join(base, 'owner', repoName, name);
        await finishedTask(name);
        if (dirty) await fs.writeFile(path.join(worktree, 'untracked'), 'agent notes');
        return worktree;
    };
    const idle = await make('idle');
    const referenced = await make('referenced');
    const mounted = await make('mounted');
    const dirty = await make('dirty', true);
    const recent = await make('recent');
    const now = Date.now();
    for (const dir of [idle, referenced, mounted, dirty]) {
        const admin = (await fs.readFile(path.join(dir, '.git'), 'utf8')).trim().slice('gitdir: '.length);
        for (const file of [dir, path.join(admin, 'HEAD'), path.join(admin, 'index'), path.join(admin, 'logs', 'HEAD')]) {
            await fs.utimes(file, new Date(0), new Date(0)).catch(() => undefined);
        }
    }
    const result = await sweepIdleWorktrees({
        worktreesBasePath: base, minIdleHours: 24, now,
        protectedPaths: async () => [referenced],
        mountedPaths: async () => [{ source: base, service: true }, path.join(mounted, 'src')],
    });
    assert.deepEqual(result.removed, [idle]);
    for (const kept of [referenced, mounted, dirty, recent]) assert.equal(await fs.pathExists(kept), true, kept);
    assert.equal(await fs.pathExists(idle), false);
});

test('the idle sweep removes nothing when liveness cannot be read', async () => {
    await assert.rejects(sweepIdleWorktrees({
        worktreesBasePath: path.join(root, 'worktrees'), minIdleHours: 1,
        protectedPaths: async () => [], mountedPaths: async () => { throw new Error('docker unavailable'); },
    }), /docker unavailable/);
});

for (const flag of ['--assume-unchanged', '--skip-worktree']) {
    test(`cleanup and sweep retain tracked modifications hidden by ${flag}`, async () => {
        const wt = await create();
        await wt.raw(['update-index', flag, 'tracked']);
        await fs.writeFile(path.join(worktree, 'tracked'), 'hidden private edits');
        assert.equal((await wt.raw(['status', '--porcelain'])).trim(), '');
        assert.deepEqual(await proveWorktreeDisposable(worktree), { disposable: false, reason: 'hidden_index_entries' });
        await cleanupWorktree(repo, worktree, 'task', { success: true });
        const result = await sweepIdleWorktrees({ minIdleHours: 1, now: Date.now() + 48 * 3_600_000,
            protectedPaths: async () => [], mountedPaths: async () => [] });
        assert.ok(!result.removed.includes(worktree));
        assert.equal(await fs.readFile(path.join(worktree, 'tracked'), 'utf8'), 'hidden private edits');
        assert.equal(await registered(), true);
    });
}

for (const operation of ['cherry-pick', 'revert']) {
    test(`cleanup retains a manually committed conflict with a pending ${operation} sequence`, async () => {
        await git.checkoutLocalBranch('source');
        await fs.writeFile(path.join(repo, 'tracked'), 'source A');
        await git.add('.').commit('A');
        const a = (await git.revparse(['HEAD'])).trim();
        await fs.writeFile(path.join(repo, 'second'), 'source B');
        await git.add('.').commit('B');
        const b = (await git.revparse(['HEAD'])).trim();
        await git.checkout('main');
        const wt = await create();
        await fs.writeFile(path.join(worktree, 'tracked'), 'task conflict');
        await wt.add('.').commit('task conflict');
        await assert.rejects(wt.raw([operation, a, b]));
        await fs.writeFile(path.join(worktree, 'tracked'), 'resolved');
        await wt.add('tracked').commit('manual resolution');
        const admin = (await wt.revparse(['--absolute-git-dir'])).trim();
        assert.equal(await fs.pathExists(path.join(admin, operation === 'revert' ? 'REVERT_HEAD' : 'CHERRY_PICK_HEAD')), false);
        const todo = await fs.readFile(path.join(admin, 'sequencer', 'todo'), 'utf8');
        assert.equal((await wt.raw(['status', '--porcelain'])).trim(), '');
        assert.deepEqual(await proveWorktreeDisposable(worktree), { disposable: false, reason: 'operation_in_progress' });
        await cleanupWorktree(repo, worktree, 'task', { success: true });
        assert.equal(await fs.readFile(path.join(admin, 'sequencer', 'todo'), 'utf8'), todo);
    });
}

test('removal detaches first and records a partial deletion without treating it as retry authority', async () => {
    await finishedTask();
    const wt = simpleGit(worktree);
    const { repositoryStorageLifecycle } = await import('../packages/core/src/storage/lifecycle.js');
    const realGit = execFileSync('which', ['git'], { encoding: 'utf8' }).trim();
    const wrapper = path.join(bin, 'git');
    // Model a recursive removal which unlinks one tracked file, then fails.
    // This wrapper affects only the fixture's next worktree remove invocation.
    await fs.writeFile(wrapper, `#!/bin/sh
case " $* " in
  *" worktree remove "*)
    /bin/rm -- "$PROPR_TEST_REMOVAL_TARGET/tracked"
    exit 42
    ;;
esac
exec "$PROPR_TEST_REAL_GIT" "$@"
`, { mode: 0o755 });
    process.env.PROPR_TEST_REAL_GIT = realGit;
    process.env.PROPR_TEST_REMOVAL_TARGET = worktree;
    let checks = 0;
    try {
        const outcome = await removeWorktreeIfDisposable(worktree, undefined, async () => {
            assert.equal(await repositoryStorageLifecycle.busy(), true, 'the read claim covers all awaited checks');
            if (++checks === 2) assert.equal((await wt.raw(['branch', '--show-current'])).trim(), '', 'branch freed before slow removal');
            return true;
        });
        assert.deepEqual(outcome, { removed: false, reason: 'remove_failed' });
    } finally {
        await fs.remove(wrapper);
        delete process.env.PROPR_TEST_REAL_GIT;
        delete process.env.PROPR_TEST_REMOVAL_TARGET;
    }
    assert.equal(await fs.pathExists(path.join(worktree, 'tracked')), false);
    assert.ok((await interruptedWorktreeRemovals()).some(record => record.worktreePath === worktree));
    assert.equal(await repositoryStorageLifecycle.busy(), false, 'claim released only after failure');
    assert.deepEqual(await removeWorktreeIfDisposable(worktree), { removed: false, reason: 'uncommitted_changes' });
    assert.equal(await registered(), true, 'a diagnostic cannot authorize forced removal of deleted files');
});

test('removal rechecks Git state after detaching and does not discard newly hidden edits', async () => {
    await finishedTask();
    const wt = simpleGit(worktree);
    let checks = 0;
    const outcome = await removeWorktreeIfDisposable(worktree, undefined, async () => {
        if (++checks === 2) {
            await wt.raw(['update-index', '--assume-unchanged', 'tracked']);
            await fs.writeFile(path.join(worktree, 'tracked'), 'hidden after initial proof');
        }
        return true;
    });
    assert.deepEqual(outcome, { removed: false, reason: 'hidden_index_entries' });
    assert.equal(await fs.readFile(path.join(worktree, 'tracked'), 'utf8'), 'hidden after initial proof');
});

test('sweep refreshes task and mount authority before deletion and accepts protected repository roots', async () => {
    await finishedTask();
    for (const protection of ['repository', 'new-reference', 'new-mount']) {
        let reads = 0;
        const result = await sweepIdleWorktrees({ minIdleHours: 1, now: Date.now() + 48 * 3_600_000,
            protectedPaths: async () => {
                reads++;
                return protection === 'repository' ? [path.dirname(worktree)]
                    : protection === 'new-reference' && reads >= 3 ? [worktree] : [];
            },
            mountedPaths: async () => protection === 'new-mount' && reads >= 3 ? [worktree] : [],
        });
        assert.ok(!result.removed.includes(worktree));
        assert.equal(await fs.pathExists(worktree), true);
    }
});

test('sweep rejects invalid idle ages before consulting external authority', async () => {
    for (const minIdleHours of [NaN, Infinity, 0, -1, 0.5, Number.MAX_SAFE_INTEGER]) {
        const result = await sweepIdleWorktrees({ minIdleHours,
            protectedPaths: async () => { throw new Error('must not query'); }, mountedPaths: async () => [] });
        assert.deepEqual(result.removed, []);
    }
});

test('sweep reports an unreadable worktree root instead of silently treating it as empty', async () => {
    await fs.writeFile(path.join(repo, 'not-a-directory'), 'file');
    await assert.rejects(sweepIdleWorktrees({ worktreesBasePath: path.join(repo, 'not-a-directory'), minIdleHours: 1,
        protectedPaths: async () => [], mountedPaths: async () => [] }), /Cannot read worktree root/);
});

test('cleanup warns for unavailable Git state instead of claiming the checkout holds unpublished work', async () => {
    const { default: logger } = await import('../packages/core/src/utils/logger.js');
    const warnings: Array<{ reason?: string; message: string }> = [];
    const warn = mock.method(logger, 'warn', (context: { reason?: string }, message: string) => {
        warnings.push({ reason: context.reason, message });
    });
    try {
        await cleanupWorktree(repo, worktree, 'task', { success: true });
        const unavailable = warnings.find(warning => warning.reason === 'not_a_worktree');
        assert.ok(unavailable);
        assert.match(unavailable.message, /needs inspection/);
        assert.doesNotMatch(unavailable.message, /work not stored elsewhere/);
    } finally { warn.mock.restore(); }
});

for (const invalid of ['malformed', 'unreadable', 'wrong-path', 'bad-deadline', 'dangling-record']) {
    test(`cleanup and sweep retain a finished checkout with ${invalid} salvage authority`, async () => {
        await finishedTask();
        const { writeSalvageRetentionMarker, readSalvageRetentionRecord } = await import('../packages/core/src/git/pushSalvage.js');
        await writeSalvageRetentionMarker(worktree, { taskId: 'salvage-task', branchName: 'task' });
        const saved = await readSalvageRetentionRecord(worktree);
        assert.ok(saved);
        // The informational marker is untracked and is not the reason to keep it.
        await fs.remove(path.join(worktree, '.retention-info.json'));
        if (invalid === 'dangling-record') {
            await fs.remove(saved.recordPath);
            await fs.symlink(path.join(root, 'missing-record-target'), saved.recordPath);
        } else if (invalid === 'unreadable') {
            // EISDIR is deterministic even when the test runs as root.
            await fs.remove(saved.recordPath);
            await fs.mkdir(saved.recordPath);
        } else {
            await fs.writeFile(saved.recordPath, invalid === 'malformed' ? '{' : JSON.stringify({
                ...saved.record, ...(invalid === 'wrong-path' ? { worktreePath: '/another-checkout' } : { scheduledCleanup: 'invalid' }),
            }));
        }
        assert.deepEqual(await proveWorktreeDisposable(worktree), { disposable: false, reason: 'salvage_retained' });
        await cleanupWorktree(repo, worktree, 'task');
        const swept = await sweepIdleWorktrees({ minIdleHours: 1, now: Date.now() + 48 * 3_600_000,
            protectedPaths: async () => [], mountedPaths: async () => [] });
        assert.ok(!swept.removed.includes(worktree));
        assert.equal(await fs.pathExists(worktree), true);
        assert.equal(await registered(), true);
    });
}

test('salvage authority is refreshed after the awaited liveness check', async () => {
    await finishedTask();
    const outcome = await removeWorktreeIfDisposable(worktree, undefined, async afterDetach => {
        if (afterDetach) {
            const { writeSalvageRetentionMarker, readSalvageRetentionRecord } = await import('../packages/core/src/git/pushSalvage.js');
            await writeSalvageRetentionMarker(worktree, { taskId: 'salvage-task', branchName: 'task' });
            const saved = await readSalvageRetentionRecord(worktree);
            await fs.writeFile(saved!.recordPath, '{');
            await fs.remove(path.join(worktree, '.retention-info.json'));
        }
        return true;
    });
    assert.deepEqual(outcome, { removed: false, reason: 'salvage_retained' });
    assert.equal(await fs.pathExists(worktree), true);
});

for (const late of [false, true]) {
    test(`ancestor mounts protect idle checkouts (arrives after detach=${late})`, async () => {
        await finishedTask();
        let reads = 0;
        const swept = await sweepIdleWorktrees({ minIdleHours: 1, now: Date.now() + 48 * 3_600_000,
            protectedPaths: async () => [], mountedPaths: async () => {
                reads++;
                return !late || reads >= 3 ? [path.dirname(worktree)] : [];
            } });
        assert.ok(!swept.removed.includes(worktree));
        assert.equal(await fs.pathExists(worktree), true);
    });
}

test('failed post-detach liveness refresh leaves no interrupted-removal diagnostic', async () => {
    await finishedTask();
    const outcome = await removeWorktreeIfDisposable(worktree, undefined, async afterDetach => {
        if (afterDetach) throw new Error('Docker unavailable');
        return true;
    });
    assert.deepEqual(outcome, { removed: false, reason: 'remove_failed' });
    assert.equal(await fs.readFile(path.join(worktree, 'tracked'), 'utf8'), 'published');
    assert.ok(!(await interruptedWorktreeRemovals()).some(record => record.worktreePath === worktree));
});

for (const mode of ['mounted', 'unavailable', 'late-mounted']) {
    test(`job-end cleanup retains checkout when Docker is ${mode}`, async () => {
        await finishedTask();
        const docker = path.join(bin, 'docker');
        const count = path.join(root, `docker-count-${serial}`);
        await fs.writeFile(docker, `#!/bin/sh
if [ "$1" = ps ]; then
  ${mode === 'unavailable' ? 'exit 1' : 'echo container'}
else
  ${mode === 'late-mounted' ? `if [ -f '${count}' ]; then echo 'null\tnull\t[{"Source":"${path.dirname(worktree)}"}]'; else touch '${count}'; fi` : `echo 'null\tnull\t[{"Source":"${path.dirname(worktree)}"}]'`}
fi
`, { mode: 0o755 });
        try {
            await cleanupWorktree(repo, worktree, 'task');
            assert.equal(await fs.pathExists(worktree), true);
            assert.equal(await registered(), true);
        } finally { await fs.writeFile(docker, '#!/bin/sh\nexit 0\n', { mode: 0o755 }); }
    });
}

test('idle maintenance claims do not advance durable storage last-use', async () => {
    await finishedTask();
    const { repositoryStorageLifecycle } = await import('../packages/core/src/storage/lifecycle.js');
    await repositoryStorageLifecycle.initialize();
    const clock = path.join(repositoryStorageLifecycle.root, 'last-use');
    await fs.writeFile(clock, '1000');
    await fs.writeFile(path.join(worktree, 'untracked'), 'keep');
    await removeWorktreeIfDisposable(worktree);
    assert.equal(await fs.readFile(clock, 'utf8'), '1000', 'kept candidates do not record use');
    await fs.unlink(path.join(worktree, 'untracked'));
    await removeWorktreeIfDisposable(worktree);
    assert.equal(await fs.pathExists(worktree), false);
    assert.equal(await fs.readFile(clock, 'utf8'), '1000', 'successful removal does not record use');
});

test('sweep uses two fresh liveness snapshots per disposable candidate, with no redundant pre-claim query', async () => {
    await finishedTask();
    const base = path.join(root, 'counted-worktrees');
    const relocated = path.join(base, 'owner', repoName, 'checkout');
    await fs.ensureDir(path.dirname(relocated));
    await git.raw(['worktree', 'move', worktree, relocated]);
    worktree = relocated;
    let references = 0;
    let mounts = 0;
    const swept = await sweepIdleWorktrees({ minIdleHours: 1, now: Date.now() + 48 * 3_600_000,
        worktreesBasePath: base,
        protectedPaths: async () => { references++; return []; },
        mountedPaths: async () => { mounts++; return []; },
    });
    assert.ok(swept.removed.includes(worktree));
    assert.equal(references, 3, 'startup authority check plus two fresh candidate snapshots');
    assert.equal(mounts, 3);
});

for (const cleanup of [true, false]) {
    test(`${cleanup ? 'job cleanup' : 'idle sweep'} reclaims under Compose and launcher shared-storage mounts`, async () => {
        await finishedTask();
        const docker = path.join(bin, 'docker');
        const rows = [
            [['npm', 'run', 'daemon'], { 'com.docker.compose.service': 'daemon' }],
            [['npm', 'run', 'worker'], { 'com.docker.compose.service': 'worker' }],
            [['node', 'dist/src/indexing_worker.js'], { 'propr.service': 'indexing-worker' }],
        ].map(([command, labels]) => [command, labels, [{ Source: root }]].map(value => JSON.stringify(value)).join('\t')).join('\n');
        await fs.writeFile(docker, `#!/bin/sh
if [ "$1" = ps ]; then echo services; else
cat <<'MOUNTS'
${rows}
MOUNTS
fi
`, { mode: 0o755 });
        try {
            if (cleanup) await cleanupWorktree(repo, worktree, 'task');
            else {
                const { runningContainerMountSources } = await import('../packages/core/src/git/worktreeMounts.js');
                const swept = await sweepIdleWorktrees({ minIdleHours: 1, now: Date.now() + 48 * 3_600_000,
                    protectedPaths: async () => [], mountedPaths: () => runningContainerMountSources() });
                assert.ok(swept.removed.includes(worktree));
            }
            assert.equal(await fs.pathExists(worktree), false);
        } finally { await fs.writeFile(docker, '#!/bin/sh\nexit 0\n', { mode: 0o755 }); }
    });
}

test('mount exemptions require service identity and stop at the configured root', async () => {
    const { mountUsesWorktree } = await import('../packages/core/src/git/worktreeReclaim.js');
    const base = process.env.GIT_WORKTREES_BASE_PATH!;
    for (const source of [root, base]) {
        assert.equal(mountUsesWorktree({ source, service: true }, worktree), false);
        assert.equal(mountUsesWorktree({ source, service: false }, worktree), true);
        assert.equal(mountUsesWorktree(source, worktree), true);
    }
    for (const source of [path.join(base, 'owner'), path.dirname(worktree), worktree, path.join(worktree, 'src')]) {
        assert.equal(mountUsesWorktree({ source, service: true }, worktree), true);
    }
});

test('sweep warns when all idle candidates are held in use', async () => {
    const isolated = path.join(root, `warning-${serial}`);
    const checkout = path.join(isolated, 'owner', 'repo', 'task');
    await fs.ensureDir(path.dirname(checkout));
    await git.raw(['worktree', 'add', '--detach', checkout, 'main']);
    const { default: logger } = await import('../packages/core/src/utils/logger.js');
    const warnings: string[] = [];
    const warn = mock.method(logger, 'warn', (_context: unknown, message: string) => { warnings.push(message); });
    try {
        const swept = await sweepIdleWorktrees({ worktreesBasePath: isolated, minIdleHours: 1,
            now: Date.now() + 48 * 3_600_000, protectedPaths: async () => [], mountedPaths: async () => [isolated] });
        assert.equal(swept.kept, 1);
        assert.ok(warnings.some(message => message.includes('every idle candidate is in use')));
    } finally { warn.mock.restore(); }
});

test('sweep summarizes unavailable Docker authority at warn level', async () => {
    const { default: logger } = await import('../packages/core/src/utils/logger.js');
    const warnings: string[] = [];
    const warn = mock.method(logger, 'warn', (_context: unknown, message: string) => { warnings.push(message); });
    try {
        await assert.rejects(sweepIdleWorktrees({ minIdleHours: 1,
            protectedPaths: async () => [], mountedPaths: async () => { throw new Error('spawn docker ENOENT'); } }), /ENOENT/);
        assert.ok(warnings.some(message => message.includes('container mount authority failed')));
    } finally { warn.mock.restore(); }
});

for (const cleanup of [true, false]) {
    test(`${cleanup ? 'cleanup' : 'sweep'} protects a task ancestor mount appearing after detach`, async () => {
        await finishedTask();
        const isolated = path.join(root, 'worktrees', `late-mount-${serial}`);
        const moved = path.join(isolated, 'owner', 'repo', 'task');
        await fs.ensureDir(path.dirname(moved));
        await git.raw(['worktree', 'move', worktree, moved]);
        worktree = moved;
        const docker = path.join(bin, 'docker');
        const counter = path.join(root, `late-ancestor-${serial}`);
        const serviceRow = [['npm', 'run', 'worker'], { 'com.docker.compose.service': 'worker' }, [{ Source: root }]]
            .map(value => JSON.stringify(value)).join('\t');
        const taskRow = [['node', 'agent.js'], null, [{ Source: root }]].map(value => JSON.stringify(value)).join('\t');
        await fs.writeFile(docker, `#!/bin/sh
if [ "$1" = ps ]; then echo containers; else
  count=0
  if [ -f '${counter}' ]; then read count < '${counter}'; fi
  count=$((count + 1))
  echo "$count" > '${counter}'
  if [ "$count" -gt ${cleanup ? 1 : 2} ]; then
    echo '${taskRow}'
  else
    echo '${serviceRow}'
  fi
fi
`, { mode: 0o755 });
        try {
            if (cleanup) await cleanupWorktree(repo, worktree, 'task');
            else {
                const { runningContainerMountSources } = await import('../packages/core/src/git/worktreeMounts.js');
                await sweepIdleWorktrees({ worktreesBasePath: isolated, minIdleHours: 1, now: Date.now() + 48 * 3_600_000,
                    protectedPaths: async () => [], mountedPaths: () => runningContainerMountSources() });
            }
            assert.equal(await fs.pathExists(worktree), true);
            assert.equal(await registered(), true);
        } finally { await fs.writeFile(docker, '#!/bin/sh\nexit 0\n', { mode: 0o755 }); }
    });
}

for (const late of [false, true]) {
    test(`job-end cleanup retains a committed handoff (appears after detach=${late})`, async () => {
        await finishedTask();
        let reads = 0;
        // Add the durable obligation at the same awaited boundary used by Docker.
        const original = handoffDb.client.query.bind(handoffDb.client);
        handoffDb.client.query = async (...args: Parameters<typeof original>) => {
            const query = args[1] as { sql?: string };
            if (query.sql?.startsWith('select') && ++reads === (late ? 2 : 1)) {
                await handoffDb('pr_followup_handoffs').connection(args[0]).insert({ worktree_path: worktree, phase: 'committed', status: 'active' });
            }
            return original(...args);
        };
        try {
            await cleanupWorktree(repo, worktree, 'task');
            assert.equal(await fs.pathExists(worktree), true);
            assert.equal(await registered(), true);
            assert.equal((await simpleGit(worktree).raw(['branch', '--show-current'])).trim(), '');
        } finally { handoffDb.client.query = original; }
        await handoffDb('pr_followup_handoffs').where({ worktree_path: worktree }).update({ status: 'released' });
        await cleanupWorktree(repo, worktree, 'task');
        assert.equal(await fs.pathExists(worktree), false, 'only released obligations allow removal');
    });
}

test('lifecycle claim failure still detaches a retained job-end worktree', async () => {
    await finishedTask();
    const { repositoryStorageLifecycle } = await import('../packages/core/src/storage/lifecycle.js');
    const failing = mock.method(repositoryStorageLifecycle, 'use', async () => { throw new Error('claim write failed'); });
    try {
        await cleanupWorktree(repo, worktree, 'task');
        assert.equal(await fs.pathExists(worktree), true);
        assert.equal((await simpleGit(worktree).raw(['branch', '--show-current'])).trim(), '');
    } finally { failing.mock.restore(); }
});

test('omitted retention strategy honors always_keep from the environment', async () => {
    await finishedTask();
    const previous = process.env.WORKTREE_RETENTION_STRATEGY;
    process.env.WORKTREE_RETENTION_STRATEGY = 'always_keep';
    try { await cleanupWorktree(repo, worktree, 'task'); }
    finally {
        if (previous === undefined) delete process.env.WORKTREE_RETENTION_STRATEGY;
        else process.env.WORKTREE_RETENTION_STRATEGY = previous;
    }
    assert.equal(await fs.pathExists(worktree), true);
});

test('proof, removal and fallback detach never execute repository filter drivers', async () => {
    await finishedTask();
    const marker = path.join(root, 'filter-ran');
    await fs.writeFile(path.join(worktree, '.gitattributes'), 'tracked filter=hostile\n');
    await simpleGit(worktree).add('.gitattributes').commit('attributes');
    for (const [key, value] of [['clean', `touch ${marker}; cat`], ['smudge', `touch ${marker}; cat`], ['process', `touch ${marker}; exit 1`], ['required', 'true']]) {
        execFileSync('git', ['-C', repo, 'config', `filter.hostile.${key}`, value]);
    }
    await fs.writeFile(path.join(worktree, 'tracked'), 'published');
    await fs.writeFile(path.join(worktree, 'keep'), 'force fallback');
    await cleanupWorktree(repo, worktree, 'task');
    assert.equal(await fs.pathExists(marker), false);
    assert.equal(await fs.pathExists(worktree), true, 'untracked attributes keep the checkout');
    await fs.remove(path.join(worktree, 'keep'));
    assert.deepEqual(await removeWorktreeIfDisposable(worktree), { removed: true });
    assert.equal(await fs.pathExists(marker), false);
});

for (const mode of ['refused', 'concurrent']) {
    test(`removal retires diagnostics when ${mode} leaves no partial tracked checkout`, async () => {
        await finishedTask();
        const realGit = execFileSync('which', ['git'], { encoding: 'utf8' }).trim();
        const wrapper = path.join(bin, 'git');
        await fs.writeFile(wrapper, `#!/bin/sh
case " $* " in
  *" worktree remove "*)
    ${mode === 'concurrent' ? '"$PROPR_TEST_REAL_GIT" "$@"' : 'echo changed >> "$PROPR_TEST_REMOVAL_TARGET/tracked"'}
    exit 42
    ;;
esac
exec "$PROPR_TEST_REAL_GIT" "$@"
`, { mode: 0o755 });
        process.env.PROPR_TEST_REAL_GIT = realGit;
        process.env.PROPR_TEST_REMOVAL_TARGET = worktree;
        try {
            assert.deepEqual(await removeWorktreeIfDisposable(worktree), { removed: false, reason: 'remove_failed' });
            assert.ok(!(await interruptedWorktreeRemovals()).some(record => record.worktreePath === worktree));
            assert.equal(await fs.pathExists(worktree), mode === 'refused');
        } finally {
            await fs.remove(wrapper);
            delete process.env.PROPR_TEST_REAL_GIT;
            delete process.env.PROPR_TEST_REMOVAL_TARGET;
        }
    });
}

test('storage gate warning delay rejects unsupported Node timer values', async () => {
    const { worktreeGateWarningDelay } = await import('../packages/core/src/git/worktreeReclaim.js');
    const previous = process.env.WORKTREE_SWEEP_INTERVAL_MS;
    try {
        for (const value of ['2147483648', '-1', 'Infinity', '0', '1.5', '20ms', '']) {
            process.env.WORKTREE_SWEEP_INTERVAL_MS = value;
            assert.equal(worktreeGateWarningDelay(), 3_600_000);
        }
        process.env.WORKTREE_SWEEP_INTERVAL_MS = '2147483647';
        assert.equal(worktreeGateWarningDelay(), 2147483647);
    } finally {
        if (previous === undefined) delete process.env.WORKTREE_SWEEP_INTERVAL_MS;
        else process.env.WORKTREE_SWEEP_INTERVAL_MS = previous;
    }
});

test('an existing-branch worktree can be rebuilt at its saved path after the checkout was deleted', async () => {
    await remoteBranch('goal');
    const first = await createWorktreeFromExistingBranch(repo, 'goal', { owner: 'owner', repoName, worktreeDirName: 'goal-checkout' });
    // The checkout disappears (manual cleanup) but Git keeps its registration.
    await fs.remove(first.worktreePath);
    assert.match(await git.raw(['worktree', 'list', '--porcelain']), /goal-checkout/);
    const rebuilt = await createWorktreeFromExistingBranch(repo, 'goal', { owner: 'owner', repoName, worktreeDirName: 'goal-checkout' });
    assert.equal(rebuilt.worktreePath, first.worktreePath);
    assert.equal((await simpleGit(rebuilt.worktreePath).raw(['branch', '--show-current'])).trim(), 'goal');
    assert.equal((await simpleGit(rebuilt.worktreePath).revparse(['HEAD'])).trim(), initial);
});

test('a missing worktree registration whose HEAD no ref contains is kept and the rebuild fails', async () => {
    await remoteBranch('goal');
    const first = await createWorktreeFromExistingBranch(repo, 'goal', { owner: 'owner', repoName, worktreeDirName: 'goal-checkout' });
    const wt = simpleGit(first.worktreePath);
    await wt.checkout(['--detach']);
    await fs.writeFile(path.join(first.worktreePath, 'tracked'), 'only here');
    await wt.add('.').commit('unpublished detached commit');
    const head = (await wt.revparse(['HEAD'])).trim();
    const admin = (await fs.readFile(path.join(first.worktreePath, '.git'), 'utf8')).trim().slice('gitdir: '.length);
    await fs.remove(first.worktreePath);
    await assert.rejects(createWorktreeFromExistingBranch(repo, 'goal', { owner: 'owner', repoName, worktreeDirName: 'goal-checkout' }),
        /missing but already registered/);
    assert.equal((await fs.readFile(path.join(admin, 'HEAD'), 'utf8')).trim(), head);
});

async function missingGoalCheckout(symlinkedBase = false) {
    await remoteBranch('goal');
    const options = { owner: 'owner', repoName, worktreeDirName: 'goal-checkout' };
    if (symlinkedBase) {
        const parent = path.join(root, 'worktrees', 'owner', repoName);
        const realParent = `${parent}-real`;
        await fs.ensureDir(realParent);
        await fs.symlink(realParent, parent, 'dir');
    }
    const first = await createWorktreeFromExistingBranch(repo, 'goal', options);
    const admin = (await fs.readFile(path.join(first.worktreePath, '.git'), 'utf8')).trim().slice('gitdir: '.length);
    return { options, checkout: first.worktreePath, admin, wt: simpleGit(first.worktreePath) };
}

for (const change of ['added', 'modified', 'deleted', 'corrupt-index', 'locked', 'MERGE_HEAD', 'sequencer']) {
    test(`missing registration retains ${change} state and the original rebuild error`, async () => {
        const { options, checkout, admin, wt } = await missingGoalCheckout();
        if (change === 'added') {
            await fs.writeFile(path.join(checkout, 'newfile'), 'staged content');
            await wt.add('newfile');
        } else if (change === 'modified') {
            await fs.writeFile(path.join(checkout, 'tracked'), 'staged content');
            await wt.add('tracked');
        } else if (change === 'deleted') {
            await wt.rm('tracked');
        } else if (change === 'corrupt-index') {
            await fs.writeFile(path.join(admin, 'index'), 'unreadable index');
        } else if (change === 'sequencer') {
            await fs.ensureDir(path.join(admin, change));
        } else {
            await fs.writeFile(path.join(admin, change), initial);
        }
        const index = await fs.readFile(path.join(admin, 'index'));
        await fs.remove(checkout);
        await assert.rejects(createWorktreeFromExistingBranch(repo, 'goal', options),
            change === 'locked' ? /missing but locked/ : /missing but already registered/);
        if (change === 'locked') assert.equal(await clearMissingWorktreeRegistration(git, checkout), false);
        assert.deepEqual(await fs.readFile(path.join(admin, 'index')), index);
        if (change === 'added' || change === 'modified') {
            assert.equal(await simpleGit(admin).raw(['show', change === 'added' ? ':newfile' : ':tracked']), 'staged content');
        }
    });
}

test('a failed HEAD inspection logs a warning and preserves the original Git diagnosis', async () => {
    const { options, checkout, admin } = await missingGoalCheckout();
    await fs.remove(checkout);
    const realGit = execFileSync('which', ['git'], { encoding: 'utf8' }).trim();
    const wrapper = path.join(bin, 'git');
    await fs.writeFile(wrapper, `#!/bin/sh
case " $* " in
  *" rev-list --count "*) echo 'fatal: bad object during inspection' >&2; exit 1 ;;
esac
exec '${realGit}' "$@"
`, { mode: 0o755 });
    const { default: logger } = await import('../packages/core/src/utils/logger.js');
    const warnings: string[] = [];
    const warn = mock.method(logger, 'warn', (_context: unknown, message: string) => { warnings.push(message); });
    try {
        await assert.rejects(createWorktreeFromExistingBranch(repo, 'goal', options), /missing but already registered/);
        assert.ok(warnings.includes('Could not clear the missing worktree registration'));
        assert.equal(await fs.pathExists(path.join(admin, 'index')), true);
    } finally {
        warn.mock.restore();
        await fs.remove(wrapper);
    }
});

for (const recovery of ['clear', 'detach']) {
    test(`${recovery} matches a missing checkout through a symlinked base path`, async () => {
        const { options, checkout, admin, wt } = await missingGoalCheckout(true);
        assert.notEqual((await fs.readFile(path.join(admin, 'gitdir'), 'utf8')).trim(), path.join(checkout, '.git'));
        if (recovery === 'detach') {
            await fs.writeFile(path.join(checkout, 'newfile'), 'retained staged content');
            await wt.add('newfile');
        }
        await fs.remove(checkout);
        if (recovery === 'clear') {
            const rebuilt = await createWorktreeFromExistingBranch(repo, 'goal', options);
            assert.equal(rebuilt.worktreePath, checkout);
        } else {
            assert.equal(await releaseBranchFromSettledWorktree(git, 'goal', checkout), true);
            assert.equal((await fs.readFile(path.join(admin, 'HEAD'), 'utf8')).trim(), initial);
            assert.equal(await simpleGit(admin).raw(['show', ':newfile']), 'retained staged content');
        }
    });
}

for (const missingHolder of [false, true]) {
    test(`rebuild recovers both a missing target registration and a branch holder (missing=${missingHolder})`, async () => {
        const { options, checkout, wt } = await missingGoalCheckout();
        await wt.checkout(['--detach']);
        const holder = `${checkout}-holder`;
        await git.raw(['worktree', 'add', holder, 'goal']);
        const admin = (await fs.readFile(path.join(holder, '.git'), 'utf8')).trim().slice('gitdir: '.length);
        await fs.remove(checkout);
        if (missingHolder) await fs.remove(holder);
        await createWorktreeFromExistingBranch(repo, 'goal', options);
        assert.equal((await simpleGit(checkout).raw(['branch', '--show-current'])).trim(), 'goal');
        assert.equal((await fs.readFile(path.join(admin, 'HEAD'), 'utf8')).trim(), initial);
    });
}

for (const late of ['staged', 'locked', 'checkout']) {
    test(`clear refreshes ${late} evidence after awaited reachability inspection`, async () => {
        const { checkout, admin } = await missingGoalCheckout();
        await fs.remove(checkout);
        const original = git.raw.bind(git);
        const intercept = mock.method(git, 'raw', async (args: string[]) => {
            const result = await original(args);
            if (args[0] === 'rev-list') {
                if (late === 'staged') {
                    const blob = (await original(['rev-parse', 'HEAD:tracked'])).trim();
                    // Stage an existing blob, with a different path from the committed tree.
                    await simpleGit(admin).raw(['update-index', '--add', '--cacheinfo', `100644,${blob},late-file`]);
                } else if (late === 'locked') await fs.writeFile(path.join(admin, 'locked'), 'late lock');
                else await fs.ensureDir(checkout);
            }
            return result;
        });
        try {
            assert.equal(await clearMissingWorktreeRegistration(git, checkout), false);
            assert.equal(await fs.pathExists(path.join(admin, 'index')), true);
        } finally { intercept.mock.restore(); }
    });
}

/** One pull request run on branch `pr`: a worktree created from it, one local commit, then released. */
async function failedAttempt(dirName: string, message: string): Promise<string> {
    const { worktreePath } = await createWorktreeFromExistingBranch(repo, 'pr', { worktreeDirName: dirName, owner: 'owner', repoName });
    const wt = simpleGit(worktreePath);
    await fs.writeFile(path.join(worktreePath, 'tracked'), message);
    await wt.add('.').commit(message);
    const head = (await wt.revparse(['HEAD'])).trim();
    await git.raw(['worktree', 'remove', '--force', worktreePath]); // push rejected; attempt cleaned up
    return head;
}
async function pushToRemote(parent: string, message: string, force = false): Promise<string> {
    const commit = (await git.raw(['commit-tree', `${initial}^{tree}`, '-p', parent, '-m', message])).trim();
    await git.push('origin', `${commit}:refs/heads/pr`, force ? ['--force'] : []);
    return commit;
}
const headOf = async (dirName: string) => (await simpleGit((await createWorktreeFromExistingBranch(repo, 'pr', { worktreeDirName: dirName, owner: 'owner', repoName })).worktreePath).revparse(['HEAD'])).trim();

test('a local branch left diverged by failed attempts restarts from the rebased PR head and keeps a backup', async () => {
    await remoteBranch('pr');
    const stale = await failedAttempt('attempt-1', 'failed attempt');
    const rebased = await pushToRemote(initial, 'dependabot rebase', true);

    assert.equal(await headOf('attempt-2'), rebased, 'the next run starts from the pull request head');
    const backups = (await git.raw(['for-each-ref', '--format=%(objectname)', 'refs/propr/superseded/pr/'])).trim();
    assert.equal(backups, stale, 'the failed attempt\'s commit is kept under a backup ref');

    // S19: a second realignment of the same branch within the same second keeps its own backup.
    await git.raw(['worktree', 'remove', '--force', path.join(root, 'worktrees', 'owner', repoName, 'attempt-2')]);
    const staleAgain = await failedAttempt('attempt-3', 'failed again');
    const rebasedAgain = await pushToRemote(initial, 'dependabot rebase again', true);
    assert.equal(await headOf('attempt-4'), rebasedAgain);
    const named = (await git.raw(['for-each-ref', '--format=%(refname) %(objectname)', 'refs/propr/superseded/pr/'])).trim().split('\n');
    assert.deepEqual(named.map(line => line.split(' ')[1]).sort(), [stale, staleAgain].sort(), 'both superseded tips are kept');
    for (const line of named) {
        const [ref, tip] = line.split(' ');
        assert.match(ref, new RegExp(`^refs/propr/superseded/pr/\\d{8}T\\d{6}Z-${tip.slice(0, 12)}$`), 'the backup name carries the tip it saves');
    }
});

test('a local branch behind the PR head is fast-forwarded, and one ahead keeps its unpushed commit', async () => {
    await remoteBranch('pr');
    const unpushed = await failedAttempt('attempt-1', 'unpushed work');
    assert.equal(await headOf('attempt-2'), unpushed, 'ahead: the unpushed commit is kept');
    await git.raw(['worktree', 'remove', '--force', path.join(root, 'worktrees', 'owner', repoName, 'attempt-2')]);

    const advanced = await pushToRemote(unpushed, 'someone built on it');
    assert.equal(await headOf('attempt-3'), advanced, 'behind: fast-forwarded to the head');
    assert.equal((await git.raw(['for-each-ref', 'refs/propr/superseded/'])).trim(), '', 'nothing needed a backup');
});
