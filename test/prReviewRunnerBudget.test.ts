/**
 * Per-reviewer budgeting in the review runner: each routed reviewer is fitted
 * to its own capacity from the shared untrimmed diff, omission reasons reach
 * the review comment separately, and logs carry sizes but never prompt text.
 */
import { describe, test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { buildAnalysisSafetySuffix } from '../packages/core/src/agents/impl/utils/analysisPromptSafety.js';

await mock.module('@propr/core', {
    namedExports: {
        buildAnalysisSafetySuffix,
        getAuthenticatedOctokit: mock.fn(),
        calculateCostWithCachePricing: mock.fn(),
        getDetailedUsageStats: mock.fn(() => ({ totalTokens: 0 })),
        getModelPricing: mock.fn(),
        getOpenRouterId: mock.fn(),
        getModelName: (model: string) => model,
    },
});

// Context fetching is not exercised here; keep its heavier dependencies out.
await mock.module('../src/jobs/prCommentJobHelpers.js', {
    namedExports: { buildCommentHistory: mock.fn(() => ''), fetchLinkedIssueContext: mock.fn(async () => ({})) },
});
await mock.module('../src/jobs/prCommentJobUtils.js', {
    namedExports: {
        fetchAllComments: mock.fn(async () => []),
        fetchPRFileContents: mock.fn(async () => new Map()),
        fetchPRFiles: mock.fn(async () => []),
        formatFileContents: mock.fn(() => ''),
    },
});

const renderCalls: Array<Record<string, unknown>> = [];
await mock.module('../src/jobs/reviewFindingNumberAllocator.js', {
    namedExports: {
        buildReviewCommentWithReservedFindingRange: mock.fn(async (_assignment: unknown, _result: unknown, _url: unknown, options: Record<string, unknown>) => {
            renderCalls.push(options);
            return { reviewCommentBody: 'review body', findingCount: 0 };
        }),
    },
});

const { runSingleReview } = await import('../src/jobs/prReviewRunner.js');
const { preparePRDiff } = await import('../src/jobs/prDiffFormatting.js');
const { ReviewTokenStatsCache } = await import('../src/jobs/reviewTokenEstimator.js');

const MARKER = 'UNIQUE_PROMPT_TEXT_MARKER';

function largeDiffFiles() {
    const files = Array.from({ length: 40 }, (_, index) => ({
        filename: `src/module${String(index).padStart(2, '0')}.ts`,
        status: 'modified',
        additions: 250,
        deletions: 0,
        patch: Array.from({ length: 250 }, (_, line) => `+export const ${MARKER}_${index}_${line} = computeReviewBudget(input${line}, { reviewer: 'r${index}' });`).join('\n'),
    }));
    files.push({ filename: 'src/generated.ts', status: 'modified', additions: 50000, deletions: 0, patch: undefined as unknown as string });
    return files;
}

function createContext(agents: Record<string, { type: string }>, prompts: Map<string, string>, logs: Array<Record<string, unknown>>) {
    const logger = {
        info: (fields: Record<string, unknown>) => logs.push(fields),
        warn: (fields: Record<string, unknown>) => logs.push(fields),
        error: (fields: Record<string, unknown>) => logs.push(fields),
    };
    return {
        registry: {
            getAgentByAlias: (alias: string) => agents[alias] && {
                config: { alias, type: agents[alias].type },
                analyze: async (prompt: string, options: { model: string }) => {
                    prompts.set(alias, prompt);
                    return { response: '## Overall Evaluation\nok', modelUsed: options.model, executionTimeMs: 1, success: true };
                },
            },
        },
        octokit: { request: async () => ({ data: { id: 1, html_url: 'https://example.test/comment' } }) },
        pullRequestNumber: 7, repoOwner: 'acme', repoName: 'repo', taskId: 'task-1', taskUrl: 'https://example.test/task',
        combinedCommentBody: '/review', commentHistory: '', originalTaskSpec: 'Original objective',
        preparedDiff: preparePRDiff(largeDiffFiles(), 4000000),
        tokenStats: new ReviewTokenStatsCache(),
        changedFilePaths: [], findingStartNumber: 1, redisClient: {},
        fileContents: '', relatedContext: '', checkSummary: '', hasCurrentCheckFailure: false,
        reviewPromptOverride: '',
        reviewBudgetSettings: { percent: 100, legacyMaxContextTokens: 0 },
        correlatedLogger: logger,
    };
}

describe('runSingleReview budgeting', () => {
    test('fits each routed reviewer to its own capacity and reports omission reasons separately', async () => {
        const prompts = new Map<string, string>();
        const logs: Array<Record<string, unknown>> = [];
        renderCalls.length = 0;
        const ctx = createContext({ claude: { type: 'claude' }, codex: { type: 'codex' } }, prompts, logs);

        await runSingleReview({ agentAlias: 'codex', model: 'gpt-6-astra', label: 'Astra' }, ctx as never);
        await runSingleReview({ agentAlias: 'claude', model: 'claude-opus-5-5', label: 'Opus' }, ctx as never);

        const [codexRender, claudeRender] = renderCalls;
        assert.ok((codexRender.budgetOmittedFiles as string[]).length > 0, 'the 272K Codex reviewer trims its own diff');
        assert.deepEqual(claudeRender.budgetOmittedFiles, [], 'the 1M Claude reviewer keeps the whole diff');
        for (const render of [codexRender, claudeRender]) {
            assert.deepEqual(render.missingPatchFiles, ['src/generated.ts']);
            assert.ok((render.omittedDiffFiles as string[]).includes('src/generated.ts'));
        }
        assert.ok(prompts.get('claude')!.length > prompts.get('codex')!.length);

        const budgetLogs = logs.filter(entry => 'safeInputTokens' in entry);
        assert.equal(budgetLogs.length, 2);
        const codexLog = budgetLogs.find(entry => entry.agentType === 'codex')!;
        assert.equal(codexLog.contextWindow, 272000);
        assert.equal(codexLog.capacitySource, 'runtime-verified');
        assert.equal(codexLog.budgetPercent, 100);
        assert.equal(codexLog.maxContextTokens, 200800);
        assert.ok((codexLog.estimatedTokens as number) <= 200800);
        assert.equal(codexLog.missingPatchFileCount, 1);
        assert.ok((codexLog.budgetOmittedFileCount as number) > 0);
        assert.equal(codexLog.trimReason, 'review context budget');
        for (const entry of logs) assert.ok(!JSON.stringify(entry).includes(MARKER), 'prompt text must stay out of logs');
    });

    test('applies a retained legacy cap to a large reviewer', async () => {
        const prompts = new Map<string, string>();
        const logs: Array<Record<string, unknown>> = [];
        renderCalls.length = 0;
        const ctx = { ...createContext({ claude: { type: 'claude' } }, prompts, logs), reviewBudgetSettings: { percent: 100, legacyMaxContextTokens: 60000 } };

        await runSingleReview({ agentAlias: 'claude', model: 'claude-opus-5-5', label: 'Opus' }, ctx as never);

        const budgetLog = logs.find(entry => 'safeInputTokens' in entry)!;
        assert.equal(budgetLog.maxContextTokens, 60000);
        assert.equal(budgetLog.ceilingLimitedBy, 'legacy-cap');
        assert.equal(budgetLog.trimReason, 'legacy token cap');
        assert.ok((budgetLog.estimatedTokens as number) <= 60000);
        assert.ok((renderCalls[0].budgetOmittedFiles as string[]).length > 0);
    });
});
