import { describe, test, mock } from 'node:test';
import assert from 'node:assert';

const mockGetPlanIssue = mock.fn(async () => null);
const mockGetPlanIssuesByDraft = mock.fn(async () => []);
const mockUpdatePlanIssue = mock.fn(async () => null);
const mockLoadPrimaryProcessingLabels = mock.fn(async () => ['AI']);
const mockGetAuthenticatedOctokit = mock.fn(async () => ({ request: mock.fn() }));
const mockSafeUpdateLabels = mock.fn(async () => {});
const mockLoggerWithCorrelation = mock.fn(() => ({
  info: mock.fn(),
  warn: mock.fn(),
  error: mock.fn(),
  debug: mock.fn(),
}));
const mockProcessBatchIssues = mock.fn(async () => ({ results: [], queuedCount: 0 }));

await mock.module('@propr/core', {
  namedExports: {
    PlanIssueStatus: {
      PENDING: 'pending',
      UNDER_REVIEW: 'under_review',
      MERGED: 'merged',
    },
    getPlanIssue: mockGetPlanIssue,
    getPlanIssuesByDraft: mockGetPlanIssuesByDraft,
    getPlanIssuesByDraftPaginated: mock.fn(async () => ({ issues: [], total: 0 })),
    updatePlanIssue: mockUpdatePlanIssue,
    loadPrimaryProcessingLabels: mockLoadPrimaryProcessingLabels,
    getAuthenticatedOctokit: mockGetAuthenticatedOctokit,
    safeUpdateLabels: mockSafeUpdateLabels,
    logger: {
      withCorrelation: mockLoggerWithCorrelation,
      error: mock.fn(),
    },
    db: {},
  },
});

await mock.module('../packages/api/routes/planIssueHelpers.js', {
  namedExports: {
    getLlmLabel: mock.fn(async (modelName: string | null) => modelName ? `llm:${modelName}` : null),
    handleMultiAgentImplementation: mock.fn(),
    handleSingleAgentImplementation: mock.fn(),
    processBatchIssues: mockProcessBatchIssues,
    getOrCreateEpicLabel: mock.fn(async () => null),
  },
});

const { createUpdateIssueHandler, createImplementAllIssuesHandler } = await import('../packages/api/routes/planIssueHandlers.ts');

function resetMocks(): void {
  mockGetPlanIssue.mock.resetCalls();
  mockGetPlanIssuesByDraft.mock.resetCalls();
  mockUpdatePlanIssue.mock.resetCalls();
  mockLoadPrimaryProcessingLabels.mock.resetCalls();
  mockGetAuthenticatedOctokit.mock.resetCalls();
  mockSafeUpdateLabels.mock.resetCalls();
  mockLoggerWithCorrelation.mock.resetCalls();
  mockProcessBatchIssues.mock.resetCalls();
  mockSafeUpdateLabels.mock.mockImplementation(async () => {});
}

function createResponse() {
  return {
    statusCode: 200,
    body: undefined as unknown,
    status(code: number) {
      this.statusCode = code;
      return this;
    },
    json(payload: unknown) {
      this.body = payload;
      return this;
    }
  };
}

describe('planIssueHandlers follow-up fixes', () => {
  test('updateIssueHandler rolls back DB config when model label sync fails', async () => {
    resetMocks();
    const handler = createUpdateIssueHandler({
      verifyOwnership: async () => ({
        authorized: true,
        draft: {
          repository: 'owner/repo',
        },
      }),
    });

    mockGetPlanIssue.mock.mockImplementation(async () => ({
      issue_number: 12,
      agent_alias: 'codex',
      model_name: 'gpt-5.4',
    }));
    mockUpdatePlanIssue.mock.mockImplementationOnce(async () => ({
      issue_number: 12,
      agent_alias: 'codex-next',
      model_name: 'gpt-5.5',
    }));
    mockUpdatePlanIssue.mock.mockImplementationOnce(async () => ({
      issue_number: 12,
      agent_alias: 'codex',
      model_name: 'gpt-5.4',
    }));
    mockSafeUpdateLabels.mock.mockImplementationOnce(async () => {
      throw new Error('GitHub label update failed');
    });

    const req = {
      params: { id: 'draft-1', issueNumber: '12' },
      user: { id: 'user-1' },
      body: { agent_alias: 'codex-next', model_name: 'gpt-5.5' },
    };
    const res = createResponse();

    await handler(req as never, res as never);

    assert.strictEqual(res.statusCode, 500);
    assert.deepStrictEqual(mockUpdatePlanIssue.mock.calls.map((call) => call.arguments), [
      ['draft-1', 12, { agent_alias: 'codex-next', model_name: 'gpt-5.5' }],
      ['draft-1', 12, { agent_alias: 'codex', model_name: 'gpt-5.4' }],
    ]);
  });

  test('implementAllIssues only rewrites pending issues before implementation', async () => {
    resetMocks();
    const handler = createImplementAllIssuesHandler({
      verifyOwnership: async () => ({
        authorized: true,
        draft: {
          repository: 'owner/repo',
          name: 'Plan',
          context_config: null,
        },
      }),
    });

    const issues = [
      { issue_number: 1, status: 'pending', agent_alias: 'old', model_name: 'gpt-5.4', run_ultrafix: false, ultrafix_goal: null, ultrafix_max_cycles: null },
      { issue_number: 2, status: 'under_review', agent_alias: 'reviewer', model_name: 'gpt-4.1', run_ultrafix: false, ultrafix_goal: null, ultrafix_max_cycles: null },
      { issue_number: 3, status: 'pending', agent_alias: 'old', model_name: 'gpt-5.4', run_ultrafix: false, ultrafix_goal: null, ultrafix_max_cycles: null },
    ];

    mockGetPlanIssuesByDraft.mock.mockImplementation(async () => issues);
    mockUpdatePlanIssue.mock.mockImplementation(async (_draftId, issueNumber, updates) => ({
      issue_number: issueNumber as number,
      ...updates,
    }));
    mockProcessBatchIssues.mock.mockImplementationOnce(async ({ pendingIssues }) => ({
      results: pendingIssues.map((issue: { issue_number: number }) => ({ success: true, issueNumber: issue.issue_number })),
      queuedCount: 0,
    }));

    const req = {
      params: { id: 'draft-2' },
      user: { id: 'user-1' },
      body: { agent_alias: 'new-agent', model_name: 'gpt-5.5' },
    };
    const res = createResponse();

    await handler(req as never, res as never);

    assert.strictEqual(res.statusCode, 200);
    assert.deepStrictEqual(
      mockUpdatePlanIssue.mock.calls.map((call) => call.arguments[1]),
      [1, 3]
    );
    assert.strictEqual(mockSafeUpdateLabels.mock.calls.length, 2);
  });

  test('updateIssueHandler preserves stored ultrafix disablement for partial PATCH updates', async () => {
    resetMocks();
    const handler = createUpdateIssueHandler({
      verifyOwnership: async () => ({
        authorized: true,
        draft: {
          repository: 'owner/repo',
        },
      }),
    });

    mockGetPlanIssue.mock.mockImplementationOnce(async () => ({
      issue_number: 14,
      agent_alias: 'codex',
      model_name: 'gpt-5.4',
      run_ultrafix: false,
      ultrafix_goal: null,
      ultrafix_max_cycles: null,
    }));
    mockUpdatePlanIssue.mock.mockImplementationOnce(async (_draftId, issueNumber, updates) => ({
      issue_number: issueNumber as number,
      agent_alias: 'codex',
      model_name: 'gpt-5.4',
      ...updates,
    }));

    const req = {
      params: { id: 'draft-3', issueNumber: '14' },
      user: { id: 'user-1' },
      body: { ultrafix_goal: null },
    };
    const res = createResponse();

    await handler(req as never, res as never);

    assert.strictEqual(res.statusCode, 200);
    assert.deepStrictEqual(mockUpdatePlanIssue.mock.calls[0]?.arguments, [
      'draft-3',
      14,
      {
        status: undefined,
        run_ultrafix: false,
        ultrafix_goal: null,
        ultrafix_max_cycles: null,
      },
    ]);
  });
});
