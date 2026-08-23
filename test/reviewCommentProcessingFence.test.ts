import assert from 'node:assert/strict';
import { mock, test } from 'node:test';

await mock.module('@propr/core', {
    namedExports: {
        getModelName: (value: string) => value,
        getProcessedReviewCommentsKey: () => 'processed-review-comments',
    },
});

const { markReviewFindingsProcessed } = await import('../src/jobs/reviewCommentGatherer.js');
const { PRProcessingLeaseLostError } = await import('../src/jobs/prProcessingLock.js');

const reviewComment = {
    id: 10,
    body: '',
    author: 'propr-bot',
    created_at: new Date().toISOString(),
    actionableFindings: [{
        id: 'F3',
        title: 'Fence consumption',
        violatedRequirement: 'Only the lock owner may consume feedback',
        evidence: 'The lock token changed',
        introducedByPR: true as const,
        introducedByPRExplanation: 'The processing attempt lost ownership',
        requiredForMerge: true as const,
        minimumCorrection: 'Check ownership atomically',
    }],
    suggestions: [{ id: 'S4', title: 'Observe contention', description: 'Track lease contention metrics.' }],
    score: 7,
    reviewStatus: 'valid_with_blockers' as const,
};

test('consumes review findings in the same Redis operation that verifies lock ownership', async () => {
    const evalMock = mock.fn(async () => 1);
    await markReviewFindingsProcessed([reviewComment], {
        repoOwner: 'integry',
        repoName: 'propr',
        pullRequestNumber: 1748,
        redisClient: { eval: evalMock },
        correlatedLogger: { info: mock.fn(), warn: mock.fn() },
        prProcessingLockKey: 'lock:pr:integry:propr:1748',
        prProcessingLockToken: 'attempt-token',
    } as never);

    assert.deepEqual(evalMock.mock.calls[0].arguments.slice(1), [
        2,
        'lock:pr:integry:propr:1748',
        'processed-review-comments:findings',
        'attempt-token',
        30 * 24 * 3600,
        '10:F:F3',
        '10:S:S4',
    ]);
});

test('rejects consumption when another worker owns the PR lock', async () => {
    await assert.rejects(
        markReviewFindingsProcessed([reviewComment], {
            repoOwner: 'integry',
            repoName: 'propr',
            pullRequestNumber: 1748,
            redisClient: { eval: async () => 0 },
            correlatedLogger: { info: mock.fn(), warn: mock.fn() },
            prProcessingLockKey: 'lock:pr:integry:propr:1748',
            prProcessingLockToken: 'stale-token',
        } as never),
        PRProcessingLeaseLostError,
    );
});
