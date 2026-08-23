import { describe, test, mock } from 'node:test';
import assert from 'node:assert/strict';

const hardLimits = new Map<string | undefined, number>([
    [undefined, 196000],
    ['large-reviewer', 980000],
    ['small-reviewer', 196000],
]);
const getModelHardLimit = (model: string | undefined) => hardLimits.get(model) ?? hardLimits.get(undefined)!;

await mock.module('@propr/core', {
    namedExports: {
        calculateCostWithCachePricing: mock.fn(),
        getAuthenticatedOctokit: mock.fn(),
        getDetailedUsageStats: mock.fn(),
        getModelHardLimit,
        getModelPricing: mock.fn(),
        getOpenRouterId: mock.fn(),
    },
});
await mock.module('../src/jobs/prCommentJobHelpers.js', {
    namedExports: {
        buildCommentHistory: mock.fn(),
        fetchLinkedIssueContext: mock.fn(),
    },
});
await mock.module('../src/jobs/prCommentJobUtils.js', {
    namedExports: {
        fetchAllComments: mock.fn(),
        fetchPRFileContents: mock.fn(),
        fetchPRFiles: mock.fn(),
        formatFileContents: mock.fn(),
        formatPRDiffWithMetadata: mock.fn(),
    },
});

const {
    REVIEW_CONTEXT_TOKEN_RESERVE,
    resolveReviewContextTokenBudget,
} = await import('../src/jobs/reviewContextHelpers.js');

describe('review context token budget', () => {
    test('keeps reserved output and runtime capacity inside the smallest reviewer window', () => {
        const models = ['large-reviewer', 'small-reviewer'];
        const smallestReviewerWindow = Math.min(...models.map(model => getModelHardLimit(model)));
        const automaticBudget = resolveReviewContextTokenBudget(models);

        assert.equal(automaticBudget + REVIEW_CONTEXT_TOKEN_RESERVE, smallestReviewerWindow);
        assert.equal(
            resolveReviewContextTokenBudget(models, smallestReviewerWindow),
            automaticBudget,
            'an explicit limit must not bypass the safe input ceiling',
        );
        assert.equal(resolveReviewContextTokenBudget(models, 120000), 120000);
    });
});
