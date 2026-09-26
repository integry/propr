import { after, mock, test } from 'node:test';
import assert from 'node:assert/strict';

const events: string[] = [];
const noOp = () => undefined;

const core = await import('@propr/core');
await mock.module('@propr/core', {
    namedExports: {
        ...core,
        cleanupWorktree: async () => { await new Promise(resolve => setTimeout(resolve, 5)); events.push('worktree-removed'); },
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

test('the PR lock is held until the worktree holding the PR branch is removed', async () => {
    const log = { debug: noOp, info: noOp, warn: noOp, error: noOp };
    await cleanupJob({
        stateManager: {} as never, lockKey: 'lock:pr:acme:web:42', lockToken: 'token', taskId: 'task-1',
        localRepoPath: '/repo', worktreeInfo: { worktreePath: '/worktrees/pr-42', branchName: 'feature' } as never,
        repoOwner: 'acme', repoName: 'web', pullRequestNumber: 42, jobBranchName: 'feature', jobLlm: null,
        correlatedLogger: log as never, redisClient: { llen: async () => 0 } as never,
    });
    // The next job for this PR can only start once the branch is free again.
    assert.deepEqual(events, ['ci-released', 'worktree-removed', 'lock-released']);
});
