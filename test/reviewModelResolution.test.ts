import { test, after, mock } from 'node:test';
import assert from 'node:assert';

// ========== Mock logger ==========
const mockLogger = {
    info: () => {},
    warn: () => {},
    error: () => {},
    debug: () => {},
};

// ========== Mock loadPrReviewModel ==========
let mockPrReviewModel = '';
const mockLoadPrReviewModel = mock.fn(async () => mockPrReviewModel);

// ========== Mock AgentRegistry ==========
const mockAgentConfigs = [
    {
        config: {
            id: 'claude-agent-1',
            type: 'claude' as const,
            alias: 'claude',
            enabled: true,
            supportedModels: ['claude-opus-4-6', 'claude-sonnet-4-6'],
            defaultModel: 'claude-sonnet-4-6',
        },
    },
    {
        config: {
            id: 'antigravity-agent-1',
            type: 'antigravity' as const,
            alias: 'antigravity',
            enabled: true,
            supportedModels: ['antigravity-gemini-2.5-pro', 'antigravity-gemini-2.5-flash'],
            defaultModel: 'antigravity-gemini-2.5-pro',
        },
    },
];

const mockRegistryInstance = {
    ensureInitialized: mock.fn(async () => {}),
    getAllAgents: () => mockAgentConfigs as any,
    getDefaultAgent: () => mockAgentConfigs[0] as any,
    getAgentByAlias: (alias: string) => mockAgentConfigs.find(a => a.config.alias === alias) as any,
};

const mockResolveLlmLabel = mock.fn(async (label: string) => {
    const agent = mockAgentConfigs.find(candidate =>
        candidate.config.supportedModels.some(model => model === label)
    );
    if (!agent) throw new Error(`Unknown test model: ${label}`);
    return { agentAlias: agent.config.alias, model: label };
});

const actualCore = await import('@propr/core');
await mock.module('@propr/core', {
    namedExports: {
        ...actualCore,
        loadPrReviewModel: mockLoadPrReviewModel,
        loadSettings: mock.fn(async () => ({ default_agent_alias: 'claude' })),
        resolveLlmLabel: mockResolveLlmLabel,
        AgentRegistry: {
            getInstance: () => mockRegistryInstance,
        },
    },
});

// Import AFTER mocking
const { resolveReviewAssignments } = await import('../src/jobs/prCommentReviewJob.ts');
const { reserveActionableFindingRange } = await import('../src/jobs/reviewFindingNumberAllocator.ts');
const { applyPendingCommentCommandContext } = await import('../src/jobs/prPendingComments.ts');

test('reserveActionableFindingRange atomically assigns non-overlapping PR-wide ranges', async () => {
    const sequences = new Map<string, number>();
    const evalCalls: Array<{ key: string; observedHighest: number; rangeSize: number }> = [];
    const redisClient = {
        eval: mock.fn(async (
            _script: string,
            _keyCount: number,
            key: string,
            observedHighest: number,
            rangeSize: number,
        ) => {
            evalCalls.push({ key, observedHighest, rangeSize });
            const reservedHighest = Math.max(sequences.get(key) ?? 0, observedHighest);
            sequences.set(key, reservedHighest + rangeSize);
            return reservedHighest + 1;
        }),
    };
    const issueRef = { repoOwner: 'Integry', repoName: 'ProPR', pullRequestNumber: 1763 };

    const [firstRangeStart, secondRangeStart] = await Promise.all([
        reserveActionableFindingRange(redisClient as any, issueRef, 4, 2),
        reserveActionableFindingRange(redisClient as any, issueRef, 4, 3),
    ]);
    const reconciledRangeStart = await reserveActionableFindingRange(
        redisClient as any,
        { ...issueRef, repoOwner: 'INTEGRY', repoName: 'propr' },
        12,
        1,
    );

    assert.deepStrictEqual([firstRangeStart, secondRangeStart], [4, 6]);
    assert.strictEqual(reconciledRangeStart, 12);
    assert.deepStrictEqual(evalCalls, [
        { key: 'review-finding-sequence:integry:propr:1763', observedHighest: 3, rangeSize: 2 },
        { key: 'review-finding-sequence:integry:propr:1763', observedHighest: 3, rangeSize: 3 },
        { key: 'review-finding-sequence:integry:propr:1763', observedHighest: 11, rangeSize: 1 },
    ]);
});

test('resolveReviewAssignments - pr_review_model fallback', async (t) => {

    await t.test('uses explicit requestedModels when provided, ignoring pr_review_model', async () => {
        mockPrReviewModel = 'antigravity-gemini-2.5-pro';
        mockLoadPrReviewModel.mock.resetCalls();

        const assignments = await resolveReviewAssignments(['claude-opus-4-6'], null, mockLogger as any);

        assert.strictEqual(assignments.length, 1);
        assert.strictEqual(assignments[0].model, 'claude-opus-4-6');
        assert.strictEqual(assignments[0].label, 'claude-opus-4-6');
        // loadPrReviewModel should NOT be called when explicit models provided
        assert.strictEqual(mockLoadPrReviewModel.mock.callCount(), 0);
    });

    await t.test('uses pr_review_model when no requestedModels, ignoring the llm parameter', async () => {
        mockPrReviewModel = 'antigravity-gemini-2.5-pro';
        mockLoadPrReviewModel.mock.resetCalls();

        const assignments = await resolveReviewAssignments(undefined, 'claude-sonnet-4-6', mockLogger as any);

        assert.strictEqual(assignments.length, 1);
        assert.strictEqual(assignments[0].agentAlias, 'antigravity');
        assert.strictEqual(assignments[0].model, 'antigravity-gemini-2.5-pro');
        assert.strictEqual(mockLoadPrReviewModel.mock.callCount(), 1);
    });

    await t.test('falls back to pr_review_model when no requestedModels and no llm', async () => {
        mockPrReviewModel = 'antigravity-gemini-2.5-pro';
        mockLoadPrReviewModel.mock.resetCalls();

        const assignments = await resolveReviewAssignments(undefined, null, mockLogger as any);

        assert.strictEqual(assignments.length, 1);
        assert.strictEqual(assignments[0].model, 'antigravity-gemini-2.5-pro');
        assert.strictEqual(assignments[0].agentAlias, 'antigravity');
        assert.strictEqual(mockLoadPrReviewModel.mock.callCount(), 1);
    });

    await t.test('falls back to default agent when pr_review_model is empty', async () => {
        mockPrReviewModel = '';
        mockLoadPrReviewModel.mock.resetCalls();

        const assignments = await resolveReviewAssignments(undefined, null, mockLogger as any);

        assert.strictEqual(assignments.length, 1);
        // Should use default agent (claude) with its default model
        assert.strictEqual(assignments[0].agentAlias, 'claude');
        assert.strictEqual(assignments[0].model, 'claude-sonnet-4-6');
        assert.strictEqual(mockLoadPrReviewModel.mock.callCount(), 1);
    });

    await t.test('falls back to default agent when pr_review_model is undefined', async () => {
        mockPrReviewModel = '';
        mockLoadPrReviewModel.mock.resetCalls();

        const assignments = await resolveReviewAssignments(undefined, undefined, mockLogger as any);

        assert.strictEqual(assignments.length, 1);
        assert.strictEqual(assignments[0].agentAlias, 'claude');
        assert.strictEqual(mockLoadPrReviewModel.mock.callCount(), 1);
    });

    await t.test('empty requestedModels array falls back to pr_review_model', async () => {
        mockPrReviewModel = 'claude-opus-4-6';
        mockLoadPrReviewModel.mock.resetCalls();

        const assignments = await resolveReviewAssignments([], null, mockLogger as any);

        assert.strictEqual(assignments.length, 1);
        assert.strictEqual(assignments[0].model, 'claude-opus-4-6');
        assert.strictEqual(mockLoadPrReviewModel.mock.callCount(), 1);
    });

    await t.test('carries a batched /use selection through a model-less /review assignment', async () => {
        mockPrReviewModel = 'antigravity-gemini-2.5-pro';
        mockLoadPrReviewModel.mock.resetCalls();
        const jobData = {
            pullRequestNumber: 42,
            repoOwner: 'owner',
            repoName: 'repo',
            correlationId: 'review-use-override',
            commandMode: 'default' as const,
            llm: 'claude-sonnet-4-6',
            requestedModels: undefined as string[] | undefined,
        };
        const comments = [
            {
                id: 1,
                body: '',
                author: 'alice',
                type: 'issue' as const,
                commandMode: 'use' as const,
                requestedModels: ['claude-opus-4-6'],
                llmOverride: 'claude-opus-4-6',
            },
            {
                id: 2,
                body: '',
                author: 'alice',
                type: 'issue' as const,
                commandMode: 'review' as const,
                requestedModels: [],
            },
        ];

        applyPendingCommentCommandContext(jobData, comments, mockLogger as any);
        const assignments = await resolveReviewAssignments(jobData.requestedModels, jobData.llm, mockLogger as any);

        assert.deepStrictEqual(jobData.requestedModels, ['claude-opus-4-6']);
        assert.strictEqual(assignments.length, 1);
        assert.strictEqual(assignments[0].agentAlias, 'claude');
        assert.strictEqual(assignments[0].model, 'claude-opus-4-6');
        assert.strictEqual(mockLoadPrReviewModel.mock.callCount(), 0);
    });
});

after(async () => {
    await actualCore.closeConnection();
});
