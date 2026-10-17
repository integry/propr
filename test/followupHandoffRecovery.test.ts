import { after, describe, mock, test } from 'node:test';
import assert from 'node:assert/strict';
import knex from 'knex';
import { execFileSync } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createHooklessGit as realGit } from '../packages/core/src/git/hooklessGit.js';
import { up } from '../packages/core/src/db/migrations/20261017000000_create_followup_publication_handoffs.js';

const database = knex({ client: 'better-sqlite3', connection: { filename: ':memory:' }, useNullAsDefault: true });
await up(database);

const root = await mkdtemp(path.join(tmpdir(), 'followup-handoff-'));
const git = (cwd: string, ...args: string[]) => execFileSync('git', ['-c', 'core.hooksPath=/dev/null', '-c', 'user.name=Test Worker', '-c', 'user.email=worker@example.test', ...args], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
git(root, 'init', '--bare', 'upstream.git');
git(root, 'clone', path.join(root, 'upstream.git'), 'work');
const worktree = path.join(root, 'work');
await writeFile(path.join(worktree, 'base.txt'), 'base\n');
git(worktree, 'add', '.'); git(worktree, 'commit', '-m', 'Base');
git(worktree, 'branch', '-M', 'feature'); git(worktree, 'push', 'origin', 'feature');
const bare = path.join(root, 'upstream.git');
const remoteHead = () => git(bare, 'rev-parse', 'refs/heads/feature');

let liveness: 'running' | 'stopped' | 'not_found' | 'unavailable' = 'not_found';
let commitCount = 0;
let pushCount = 0;
const postedComments: string[] = [];
const scheduled: Array<{ reason: string; containerCollisionTaskId?: string }> = [];
const log = { info() {}, warn() {}, error() {}, debug() {} };

interface FakeTaskState { state: string; collision?: boolean }
const taskStates = new Map<string, FakeTaskState>();
const stateUpdates: Array<{ taskId: string; state: string; options: { reason: string; commitHash?: string } }> = [];
const historyAnnotations: Array<{ taskId: string; metadata: Record<string, unknown> }> = [];
const stateManager = {
    getTaskState: async (taskId: string) => taskStates.get(taskId) ?? null,
    updateTaskState: async (taskId: string, state: string, options: { reason: string; commitHash?: string }) => {
        taskStates.set(taskId, { state });
        stateUpdates.push({ taskId, state, options });
    },
    updateHistoryMetadata: async (taskId: string, _state: string, metadata: Record<string, unknown>) => {
        historyAnnotations.push({ taskId, metadata });
    },
};

const octokit = {
    request: async (route: string, params: Record<string, unknown>) => {
        if (route.startsWith('GET /repos/{owner}/{repo}/pulls/')) {
            return { data: { state: 'open', head: { ref: 'feature', sha: remoteHead(), repo: { full_name: 'upstream/repo' } }, base: { ref: 'main' }, title: 'PR', body: '', user: { login: 'integry' } } };
        }
        if (route.startsWith('GET /repos/{owner}/{repo}/git/ref/')) {
            return { data: { object: { sha: remoteHead() } } };
        }
        if (route.startsWith('POST /repos/{owner}/{repo}/issues/')) {
            postedComments.push(params.body as string);
            return { data: { id: postedComments.length, html_url: 'https://example.test/comment' } };
        }
        throw new Error(`Unexpected route ${route}`);
    },
    paginate: async () => postedComments.map(body => ({ body })),
};

await mock.module('@propr/core', { namedExports: {
    db: database,
    logger: { ...log },
    hashTaskAttemptToken: () => 'hash',
    TaskStates: { PENDING: 'pending', PROCESSING: 'processing', COMPLETED: 'completed', FAILED: 'failed', CANCELLED: 'cancelled' },
    inspectTaskContainerLivenessForTask: async () => ({ liveness, container: null }),
    createHooklessGit: realGit,
    commitChanges: async (worktreePath: string, message: string) => {
        git(worktreePath, 'add', '-A');
        git(worktreePath, 'commit', '-m', message);
        commitCount += 1;
        return { commitHash: git(worktreePath, 'rev-parse', 'HEAD'), commitMessage: message, filesChanged: ['edit.txt'] };
    },
} });
await mock.module('../src/jobs/commitAuthor.js', { namedExports: { AI_COMMIT_AUTHOR: { name: 'Test Worker', email: 'worker@example.test' } } });
await mock.module('../src/jobs/prContinuation.js', { namedExports: { findPRContinuation: async () => undefined } });
await mock.module('../src/jobs/pushSalvageTimeline.js', { namedExports: { recordPushSalvageEvent: () => async () => {} } });
await mock.module('../src/jobs/prCommentCollisionRecovery.js', { namedExports: {
    isContainerCollisionCancellation: (state: FakeTaskState | null) => state?.collision === true,
    schedulePRCommentRecovery: async (params: { reason: string; containerCollisionTaskId?: string }) => {
        scheduled.push({ reason: params.reason, containerCollisionTaskId: params.containerCollisionTaskId });
        return 'replacement-task';
    },
} });
await mock.module('../src/jobs/prPublication.js', { namedExports: {
    PullRequestPublication: class {
        continuation: unknown;
        get target() { return { repoOwner: 'upstream', repoName: 'repo', branchName: 'feature', isFork: false }; }
        async push(worktreePath: string) {
            git(worktreePath, 'push', 'origin', 'HEAD:feature');
            pushCount += 1;
            return { commitHash: git(worktreePath, 'rev-parse', 'HEAD') };
        }
    },
} });

const { recoverInterruptedFollowupHandoff, isExplicitFollowupRecoveryRequest } = await import('../src/jobs/followupHandoffRecovery.js');
const {
    advanceFollowupHandoffPhase, beginFollowupHandoff, claimFollowupHandoffSuccessor,
    completeFollowupHandoff, findOpenFollowupHandoff,
} = await import('../src/jobs/followupHandoffStore.js');

const ref = { repoOwner: 'upstream', repoName: 'repo', pullRequestNumber: 265 };

type TestComment = { id: number; body: string; author: string; type: 'issue' };
const comment = (id: number, body: string): TestComment => ({ id, body, author: 'integry', type: 'issue' });

async function beginHandoff(taskId: string, claimedComments: TestComment[], worktreePath = worktree) {
    await beginFollowupHandoff({
        taskId, ref, branchName: 'feature', worktreePath, localRepoPath: path.join(root, 'work'),
        baseBranch: 'main', expectedHeadSha: remoteHead(), claimedComments,
        lockKey: 'lock:pr:upstream:repo:265', lockTokenHash: 'predecessor-hash',
    });
}

function makeParams(taskId: string, commentsToProcess: TestComment[]) {
    const context = {
        repoOwner: 'upstream', repoName: 'repo', pullRequestNumber: 265,
        correlatedLogger: log, commentsToProcess, pickedUpComments: [] as TestComment[],
    };
    const params = {
        job: { data: {} }, context, llm: null, taskId, stateManager,
        state: { octokit }, lockKey: 'lock:pr:upstream:repo:265', lockToken: 'successor-token',
    };
    return { params: params as never as Parameters<typeof recoverInterruptedFollowupHandoff>[0], context };
}

const options = { redisClient: {} as never, pickedUpComments: [] as never };

after(async () => { await database.destroy(); await rm(root, { recursive: true, force: true }); });

describe('interrupted follow-up handoff recovery', () => {
    test('/recover is recognized only as an explicit command line', () => {
        assert.equal(isExplicitFollowupRecoveryRequest([comment(1, 'please /recover the work')]), false);
        assert.equal(isExplicitFollowupRecoveryRequest([comment(1, '/recover')]), true);
        assert.equal(isExplicitFollowupRecoveryRequest([comment(1, 'note\n  /recover now')]), true);
    });

    test('waits while the exact labelled container is live or uninspectable', async () => {
        await writeFile(path.join(worktree, 'edit.txt'), 'unpublished edit\n');
        await beginHandoff('task-live', [comment(11, 'please fix')]);
        await advanceFollowupHandoffPhase('task-live', 'agent-running');
        taskStates.set('task-live', { state: 'processing' });

        liveness = 'running';
        const { params } = makeParams('task-wait', []);
        const waiting = await recoverInterruptedFollowupHandoff(params, options);
        assert.equal(waiting?.status, 'rescheduled');
        assert.deepEqual(scheduled.at(-1), { reason: 'followup_handoff_container_running', containerCollisionTaskId: 'task-live' });

        liveness = 'unavailable';
        const unavailable = await recoverInterruptedFollowupHandoff(params, options);
        assert.equal(unavailable?.reason, 'followup_handoff_container_inspection_unavailable');
        // No agent overlapped and nothing touched the retained worktree.
        assert.equal(commitCount, 0);
        assert.equal(pushCount, 0);
        await completeFollowupHandoff('task-live');
    });

    test('restart after edits but before commit: adopts, publishes exactly once, survives duplicate passes', async () => {
        await beginHandoff('task-a', [comment(11, 'please fix')]);
        await advanceFollowupHandoffPhase('task-a', 'agent-running');
        taskStates.set('task-a', { state: 'cancelled', collision: true });
        liveness = 'not_found';

        const { params, context } = makeParams('task-b', [comment(11, 'please fix')]);
        const result = await recoverInterruptedFollowupHandoff(params, options);
        assert.equal(result?.status, 'complete');
        assert.equal(commitCount, 1);
        assert.equal(pushCount, 1);
        // The unique edit survived into the published branch.
        assert.equal(git(bare, 'show', 'refs/heads/feature:edit.txt'), 'unpublished edit');
        assert.equal(postedComments.filter(body => body.includes('propr-followup-handoff:recovered:task-a')).length, 1);
        assert.equal(await findOpenFollowupHandoff(ref), undefined);
        // The collision-cancelled predecessor stays terminal but its timeline records the recovery.
        assert.ok(historyAnnotations.some(entry => entry.taskId === 'task-a'
            && (entry.metadata.followupRecovery as { successorTaskId: string }).successorTaskId === 'task-b'));
        // The claimed trigger was consumed exactly once, not re-processed.
        assert.deepEqual(context.commentsToProcess, []);
        assert.equal(taskStates.get('task-b')?.state, 'completed');

        // A duplicate recovery pass finds no open handoff and publishes nothing new.
        const { params: duplicate } = makeParams('task-c', []);
        assert.equal(await recoverInterruptedFollowupHandoff(duplicate, options), undefined);
        assert.equal(commitCount, 1);
        assert.equal(pushCount, 1);
    });

    test('restart after commit but before push: pushes the existing commit without recommitting', async () => {
        await writeFile(path.join(worktree, 'committed.txt'), 'committed but unpushed\n');
        git(worktree, 'add', '-A'); git(worktree, 'commit', '-m', 'Follow-up changes');
        const localHead = git(worktree, 'rev-parse', 'HEAD');
        await beginHandoff('task-d', [comment(12, 'next fix')]);
        await advanceFollowupHandoffPhase('task-d', 'committed', { commitHash: localHead });
        taskStates.set('task-d', { state: 'processing' });

        const { params } = makeParams('task-e', []);
        const result = await recoverInterruptedFollowupHandoff(params, options);
        assert.equal(result?.status, 'complete');
        assert.equal(result?.commit, localHead);
        assert.equal(commitCount, 1);
        assert.equal(pushCount, 2);
        assert.equal(remoteHead(), localHead);
        assert.equal(taskStates.get('task-d')?.state, 'completed');
        assert.equal(postedComments.filter(body => body.includes('propr-followup-handoff:recovered:task-d')).length, 1);
    });

    test('restart after push but before the result comment: only the comment is published', async () => {
        const head = git(worktree, 'rev-parse', 'HEAD');
        await beginHandoff('task-f', []);
        await advanceFollowupHandoffPhase('task-f', 'pushed', { commitHash: head });
        taskStates.set('task-f', { state: 'processing' });

        const { params } = makeParams('task-g', []);
        const result = await recoverInterruptedFollowupHandoff(params, options);
        assert.equal(result?.status, 'complete');
        assert.equal(commitCount, 1);
        assert.equal(pushCount, 2);
        assert.equal(postedComments.filter(body => body.includes('propr-followup-handoff:recovered:task-f')).length, 1);
        assert.equal(taskStates.get('task-f')?.state, 'completed');
    });

    test('no-change run: the trigger is re-queued instead of publishing anything', async () => {
        await beginHandoff('task-h', [comment(21, 'still owed')]);
        await advanceFollowupHandoffPhase('task-h', 'agent-exited');
        taskStates.set('task-h', { state: 'processing' });
        const commentsBefore = postedComments.length;

        const { params, context } = makeParams('task-i', []);
        assert.equal(await recoverInterruptedFollowupHandoff(params, options), undefined);
        assert.deepEqual(context.commentsToProcess.map(c => c.id), [21]);
        assert.equal(postedComments.length, commentsBefore);
        assert.equal(await findOpenFollowupHandoff(ref), undefined);
        const closed = await database('followup_publication_handoffs').where({ task_id: 'task-h' }).first();
        assert.equal(closed.next_action, 'no_unique_changes_trigger_requeued');
        assert.equal(taskStates.get('task-h')?.state, 'completed');
    });

    test('user cancellation stays authoritative: blocked with a single operator notice, work preserved', async () => {
        await writeFile(path.join(worktree, 'cancelled-edit.txt'), 'preserved\n');
        await beginHandoff('task-j', [comment(31, 'cancelled work')]);
        await advanceFollowupHandoffPhase('task-j', 'agent-exited');
        taskStates.set('task-j', { state: 'cancelled' });

        const { params } = makeParams('task-k', [comment(32, 'more work')]);
        const blocked = await recoverInterruptedFollowupHandoff(params, options);
        assert.equal(blocked?.status, 'blocked');
        assert.equal(blocked?.reason, 'retained_followup_requires_operator_recovery');
        assert.equal(taskStates.get('task-k')?.state, 'failed');
        const open = await findOpenFollowupHandoff(ref);
        assert.equal(open?.task_id, 'task-j');
        assert.ok(open?.next_action?.includes('/recover'));
        // Nothing was committed, pushed or removed.
        assert.equal(commitCount, 1);
        assert.equal(pushCount, 2);
        assert.ok(git(worktree, 'status', '--porcelain').includes('cancelled-edit.txt'));

        // A repeat trigger does not duplicate the operator notice.
        await recoverInterruptedFollowupHandoff(makeParams('task-k2', [comment(33, 'again')]).params, options);
        assert.equal(postedComments.filter(body => body.includes('propr-followup-handoff:operator:task-j')).length, 1);
    });

    test('an explicit /recover adopts and publishes the cancelled predecessor\'s retained work', async () => {
        const { params, context } = makeParams('task-l', [comment(34, '/recover')]);
        const result = await recoverInterruptedFollowupHandoff(params, options);
        assert.equal(result?.status, 'complete');
        assert.equal(commitCount, 2);
        assert.equal(pushCount, 3);
        assert.equal(git(bare, 'show', 'refs/heads/feature:cancelled-edit.txt'), 'preserved');
        // The pure /recover command is consumed by the recovery itself.
        assert.deepEqual(context.commentsToProcess, []);
        // The user-cancelled predecessor is never flipped out of its terminal state.
        assert.equal(taskStates.get('task-j')?.state, 'cancelled');
        assert.ok(historyAnnotations.some(entry => entry.taskId === 'task-j'));
        assert.equal(await findOpenFollowupHandoff(ref), undefined);
    });

    test('a second live successor is fenced out', async () => {
        await beginHandoff('task-m', []);
        taskStates.set('task-m', { state: 'processing' });
        assert.equal(await claimFollowupHandoffSuccessor('task-m', 'task-x'), true);

        const { params } = makeParams('task-n', []);
        const result = await recoverInterruptedFollowupHandoff(params, options);
        assert.equal(result?.status, 'rescheduled');
        assert.equal(result?.reason, 'followup_handoff_claimed_by_other_successor');
        await completeFollowupHandoff('task-m');
    });

    test('a vanished worktree re-queues the owed trigger without destructive cleanup', async () => {
        await beginHandoff('task-o', [comment(41, 'owed')], path.join(root, 'missing-worktree'));
        taskStates.set('task-o', { state: 'processing' });

        const { params, context } = makeParams('task-p', []);
        assert.equal(await recoverInterruptedFollowupHandoff(params, options), undefined);
        assert.deepEqual(context.commentsToProcess.map(c => c.id), [41]);
        assert.equal(taskStates.get('task-o')?.state, 'completed');
        assert.equal(await findOpenFollowupHandoff(ref), undefined);
    });
});
