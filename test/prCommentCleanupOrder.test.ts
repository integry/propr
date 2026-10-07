import { after, mock, test } from 'node:test';
import assert from 'node:assert/strict';

const events: string[] = [];
const queued: Array<{ name: string; data: any }> = [];
const cleanupOptions: any[] = [];
const noOp = () => undefined;

const core = await import('@propr/core');
await mock.module('@propr/core', {
    namedExports: {
        ...core,
        issueQueue: { add: async (name: string, data: any) => { events.push('queued'); queued.push({ name, data }); } },
        cleanupWorktree: async (_repo: string, _path: string, _branch: string, options: unknown) => { cleanupOptions.push(options); await new Promise(resolve => setTimeout(resolve, 5)); events.push('worktree-removed'); },
    },
});
await mock.module('../src/jobs/prProcessingLock.js', {
    namedExports: { releasePRProcessingLock: async () => { events.push('lock-released'); return true; } },
});
await mock.module('../src/jobs/followupCiSuspension.js', {
    namedExports: { releaseFollowupCiSuspensionsForTask: async () => { events.push('ci-released'); return []; } },
});
await mock.module('../src/jobs/prCommentUsageLimitRecovery.js', { namedExports: { schedulePRCommentUsageLimitRetry: noOp } });
await mock.module('../src/jobs/prContributionDiscussion.js', { namedExports: { loadOriginalContributionDiscussion: noOp } });

const { cleanupJob } = await import('../src/jobs/prCommentJobUtils.js');
after(async () => { await core.closeConnection?.(); });

test('failed follow-ups retain their work before releasing the PR lock', async () => {
    events.length = 0;
    cleanupOptions.length = 0;
    await cleanupJob({
        success: false, skipPendingCommentFollowup: true,
        stateManager: {} as never, lockKey: 'lock:pr:acme:web:42', lockToken: 'token', taskId: 'failed-task',
        localRepoPath: '/repo', worktreeInfo: { worktreePath: '/worktrees/pr-42', branchName: 'feature' } as never,
        repoOwner: 'acme', repoName: 'web', pullRequestNumber: 42, jobBranchName: 'feature', jobLlm: null,
        correlatedLogger: { debug: noOp, info: noOp, warn: noOp, error: noOp } as never, redisClient: {} as never,
    });
    assert.deepEqual(cleanupOptions, [{ deleteBranch: false, success: false, retentionStrategy: 'keep_on_failure' }]);
    assert.deepEqual(events, ['ci-released', 'worktree-removed', 'lock-released']);
});

for (const deferred of [false, true]) test(`the PR lock is held until the worktree holding the PR branch is removed (capacity deferred: ${deferred})`, async () => {
    events.length = 0;
    const log = { debug: noOp, info: noOp, warn: noOp, error: noOp };
    await cleanupJob({
        skipPendingCommentFollowup: deferred,
        stateManager: { getTaskState: async () => null } as never, lockKey: 'lock:pr:acme:web:42', lockToken: 'token', taskId: 'task-1',
        localRepoPath: '/repo', worktreeInfo: { worktreePath: '/worktrees/pr-42', branchName: 'feature' } as never,
        repoOwner: 'acme', repoName: 'web', pullRequestNumber: 42, jobBranchName: 'feature', jobLlm: null,
        correlatedLogger: log as never, redisClient: { llen: async () => { assert.equal(deferred, false, 'a delayed job must own the retry without enqueueing pending comments'); return 0; } } as never,
    });
    // The next job for this PR can only start once the branch is free again.
    assert.deepEqual(events, ['ci-released', 'worktree-removed', 'lock-released']);
});

for (const reason of ['cancelled_by_user', 'cancelled_pr_closed', undefined]) {
    test(`cleanup preserves independent pending comments after cancellation: ${reason}`, async () => {
        events.length = 0;
        queued.length = 0;
        const pending = [JSON.stringify({ id: 202, body: 'Please add the regression too.', author: 'reviewer' })];
        let current: any = { state: 'processing' };
        await cleanupJob({
            stateManager: { getTaskState: async () => { events.push('state-read'); return current; } } as never,
            lockKey: 'lock:pr:acme:web:42', lockToken: 'token', taskId: 'task-1',
            localRepoPath: '/repo', worktreeInfo: { worktreePath: '/worktrees/pr-42', branchName: 'feature' } as never,
            repoOwner: 'acme', repoName: 'web', pullRequestNumber: 42, jobBranchName: 'feature', jobLlm: null,
            correlatedLogger: { debug: noOp, info: noOp, warn: noOp, error: noOp } as never,
            redisClient: { llen: async () => {
                events.push('pending-read');
                // Simulate cancellation arriving while Redis is awaited.
                current = { state: 'cancelled', terminalReason: reason };
                return pending.length;
            } } as never,
        });
        assert.deepEqual(events.slice(0, 5), ['ci-released', 'worktree-removed', 'lock-released', 'pending-read', 'state-read']);
        assert.equal(queued.length, reason === 'cancelled_pr_closed' ? 0 : 1);
        assert.equal(pending.length, 1, 'cleanup leaves the durable list for the follow-up to claim');
        if (queued.length) {
            assert.equal(queued[0].name, 'processPullRequestComment');
            assert.deepEqual(queued[0].data.comments, [], 'the cancelled request is not replayed');
            assert.equal(queued[0].data.pullRequestNumber, 42);
        }
    });
}
