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
            id: 'gemini-agent-1',
            type: 'gemini' as const,
            alias: 'gemini',
            enabled: true,
            supportedModels: ['gemini-2.5-pro', 'gemini-2.5-flash'],
            defaultModel: 'gemini-2.5-pro',
        },
    },
];

const mockRegistryInstance = {
    ensureInitialized: mock.fn(async () => {}),
    getAllAgents: () => mockAgentConfigs as any,
    getDefaultAgent: () => mockAgentConfigs[0] as any,
    getAgentByAlias: (alias: string) => mockAgentConfigs.find(a => a.config.alias === alias) as any,
};

await mock.module('@propr/core', {
    namedExports: {
        ...(await import('@propr/core')),
        loadPrReviewModel: mockLoadPrReviewModel,
        loadSettings: mock.fn(async () => ({ default_agent_alias: 'claude' })),
        AgentRegistry: {
            getInstance: () => mockRegistryInstance,
        },
    },
});

// Import AFTER mocking
const { resolveReviewAssignments } = await import('../src/jobs/prCommentReviewJob.ts');

test('resolveReviewAssignments - pr_review_model fallback', async (t) => {

    await t.test('uses explicit requestedModels when provided, ignoring pr_review_model', async () => {
        mockPrReviewModel = 'gemini-2.5-pro';
        mockLoadPrReviewModel.mock.resetCalls();

        const assignments = await resolveReviewAssignments(['claude-opus-4-6'], null, mockLogger as any);

        assert.strictEqual(assignments.length, 1);
        assert.strictEqual(assignments[0].model, 'claude-opus-4-6');
        assert.strictEqual(assignments[0].label, 'claude-opus-4-6');
        // loadPrReviewModel should NOT be called when explicit models provided
        assert.strictEqual(mockLoadPrReviewModel.mock.callCount(), 0);
    });

    await t.test('uses llm parameter when no requestedModels, ignoring pr_review_model', async () => {
        mockPrReviewModel = 'gemini-2.5-pro';
        mockLoadPrReviewModel.mock.resetCalls();

        const assignments = await resolveReviewAssignments(undefined, 'claude-sonnet-4-6', mockLogger as any);

        assert.strictEqual(assignments.length, 1);
        assert.strictEqual(assignments[0].model, 'claude-sonnet-4-6');
        // loadPrReviewModel should NOT be called when llm is provided
        assert.strictEqual(mockLoadPrReviewModel.mock.callCount(), 0);
    });

    await t.test('falls back to pr_review_model when no requestedModels and no llm', async () => {
        mockPrReviewModel = 'gemini-2.5-pro';
        mockLoadPrReviewModel.mock.resetCalls();

        const assignments = await resolveReviewAssignments(undefined, null, mockLogger as any);

        assert.strictEqual(assignments.length, 1);
        assert.strictEqual(assignments[0].model, 'gemini-2.5-pro');
        assert.strictEqual(assignments[0].agentAlias, 'gemini');
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
});

// Force exit due to module-level initialization in @propr/core
after(() => {
    process.exit(0);
});
