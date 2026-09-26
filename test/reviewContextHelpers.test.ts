import { describe, test, mock } from 'node:test';
import assert from 'node:assert/strict';

await mock.module('@propr/core', {
    namedExports: {
        calculateCostWithCachePricing: mock.fn(),
        getAuthenticatedOctokit: mock.fn(),
        getDetailedUsageStats: mock.fn(),
        getModelPricing: mock.fn(),
        getOpenRouterId: mock.fn(),
    },
});
await mock.module('../src/jobs/prCommentJobHelpers.js', {
    namedExports: {
        buildCommentHistory: mock.fn(() => ''),
        fetchLinkedIssueContext: mock.fn(async () => ({})),
    },
});
await mock.module('../src/jobs/prCommentJobUtils.js', {
    namedExports: {
        fetchAllComments: mock.fn(async () => []),
        fetchPRFileContents: mock.fn(async () => new Map()),
        fetchPRFiles: mock.fn(async () => [
            { filename: 'src/config.ts', status: 'modified', additions: 1, deletions: 0, patch: '+safe change' },
            { filename: 'src/huge.ts', status: 'modified', additions: 9000, deletions: 0 },
        ]),
        formatFileContents: mock.fn(() => ''),
    },
});

const {
    fetchReviewContext,
    resolveReviewDiffIoGuard,
    resolveReviewerBudget,
    DEFAULT_REVIEW_DIFF_IO_GUARD_CHARS,
} = await import('../src/jobs/reviewContextHelpers.js');

describe('per-reviewer review context budget', () => {
    const automatic = { percent: 100, legacyMaxContextTokens: 0 };

    test('fits each routed reviewer to its own capacity', () => {
        const large = resolveReviewerBudget({ agentType: 'claude', model: 'claude-opus-5-5' }, automatic);
        const small = resolveReviewerBudget({ agentType: 'codex', model: 'gpt-6-astra' }, automatic);

        assert.equal(large.capacity.contextWindow, 1000000);
        assert.equal(small.capacity.contextWindow, 272000);
        assert.equal(large.ceiling.ceiling, large.capacity.safeInputTokens);
        assert.equal(small.ceiling.ceiling, small.capacity.safeInputTokens);
        assert.ok(large.ceiling.ceiling > small.ceiling.ceiling, 'a smaller reviewer must not narrow a larger one');
    });

    test('keeps a retained legacy cap effective across model changes', () => {
        const settings = { percent: 100, legacyMaxContextTokens: 120000 };
        for (const route of [
            { agentType: 'claude', model: 'claude-opus-5-5' },
            { agentType: 'codex', model: 'gpt-6-astra' },
            { agentType: 'claude', model: 'claude-haiku-4-5-20251001' },
        ]) {
            const { ceiling } = resolveReviewerBudget(route, settings);
            assert.equal(ceiling.ceiling, 120000);
            assert.equal(ceiling.limitedBy, 'legacy-cap');
        }
    });

    test('lets a lower percentage narrow a legacy cap but never raise it', () => {
        const { capacity, ceiling } = resolveReviewerBudget(
            { agentType: 'codex', model: 'gpt-6-astra' },
            { percent: 10, legacyMaxContextTokens: 120000 },
        );
        assert.equal(ceiling.ceiling, Math.floor(capacity.safeInputTokens * 0.1));
        assert.equal(ceiling.limitedBy, 'percentage');
    });
});

describe('review diff I/O guard', () => {
    test('uses a bounded default independent of model capacity', () => {
        assert.deepEqual(resolveReviewDiffIoGuard({}), { maxChars: DEFAULT_REVIEW_DIFF_IO_GUARD_CHARS, source: 'default' });
    });

    test('keeps an explicitly configured advanced limit as the I/O guard', () => {
        assert.deepEqual(resolveReviewDiffIoGuard({ PR_REVIEW_DIFF_MAX_CHARS: '250000' }), { maxChars: 250000, source: 'PR_REVIEW_DIFF_MAX_CHARS' });
        assert.equal(resolveReviewDiffIoGuard({ PR_REVIEW_DIFF_MAX_CHARS: '5' }).maxChars, 100000);
    });
});

test('review context pins file content to the reviewed SHA and rejects head movement', async () => {
    const { fetchPRFileContents } = await import('../src/jobs/prCommentJobUtils.js');
    let head = 'a'.repeat(40);
    const octokit = { paginate: async () => [], request: async () => ({ data: { head: { sha: head } } }) };
    const data = { data: { head: { ref: 'feature', sha: head }, body: '', labels: [], user: { login: 'fixture' }, title: 'Fixture' } };
    const params = { repoOwner: 'acme', repoName: 'repo', pullRequestNumber: 42, correlationId: 'fixture', correlatedLogger: { info() {}, warn() {} } };
    const context = await fetchReviewContext(octokit as never, data, params as never);
    // The shared diff is untrimmed: budgeting happens per reviewer, and a
    // missing GitHub patch stays distinct from any later budget omission.
    assert.deepEqual(context.preparedDiff.files.map(file => file.filename), ['src/config.ts']);
    assert.deepEqual(context.preparedDiff.missingPatchFiles, ['src/huge.ts']);
    assert.deepEqual(context.preparedDiff.ioGuardOmittedFiles, []);
    const calls = (fetchPRFileContents as unknown as { mock: { calls: Array<{ arguments: Array<{ prHeadRef: string }> }> } }).mock.calls;
    assert.equal(calls.at(-1)!.arguments[0].prHeadRef, head);
    head = 'b'.repeat(40);
    await assert.rejects(fetchReviewContext(octokit as never, data, params as never), /head changed/);
});
