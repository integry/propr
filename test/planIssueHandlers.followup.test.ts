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
const mockHandleSingleAgentImplementation = mock.fn();

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
    handleSingleAgentImplementation: mockHandleSingleAgentImplementation,
    getOrCreateEpicLabel: mock.fn(async () => null),
  },
});

const {
  createImplementIssueHandler,
  createUpdateIssueHandler
} = await import('../packages/api/routes/planIssueHandlers.ts');

function resetMocks(): void {
  mockGetPlanIssue.mock.resetCalls();
  mockGetPlanIssuesByDraft.mock.resetCalls();
  mockUpdatePlanIssue.mock.resetCalls();
  mockLoadPrimaryProcessingLabels.mock.resetCalls();
  mockGetAuthenticatedOctokit.mock.resetCalls();
  mockSafeUpdateLabels.mock.resetCalls();
  mockLoggerWithCorrelation.mock.resetCalls();
  mockHandleSingleAgentImplementation.mock.resetCalls();
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

  test('updateIssueHandler returns a reconciliation payload when rollback fails', async () => {
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
      issue_number: 16,
      agent_alias: 'codex',
      model_name: 'gpt-5.4',
    }));
    mockUpdatePlanIssue.mock.mockImplementationOnce(async () => {
      throw new Error('db write failed');
    });
    mockSafeUpdateLabels.mock.mockImplementationOnce(async () => {});
    mockSafeUpdateLabels.mock.mockImplementationOnce(async () => {
      throw new Error('rollback label sync failed');
    });

    const req = {
      params: { id: 'draft-rollback', issueNumber: '16' },
      user: { id: 'user-1' },
      body: { model_name: 'gpt-5.5' },
    };
    const res = createResponse();

    await handler(req as never, res as never);

    assert.strictEqual(res.statusCode, 409);
    assert.deepStrictEqual(res.body, {
      error: 'Failed to persist issue config after GitHub labels changed; manual reconciliation required',
      code: 'ISSUE_CONFIG_SYNC_RECONCILIATION_REQUIRED',
      details: {
        draftId: 'draft-rollback',
        issueNumber: 16,
        repository: 'owner/repo',
        persistedModelName: 'gpt-5.4',
        githubLabelModelName: 'gpt-5.5',
        updateError: 'db write failed',
        rollbackError: 'rollback label sync failed',
      },
    });
  });

  test('updateIssueHandler surfaces non-reconciliation rollback failures to the caller', async () => {
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
      issue_number: 18,
      agent_alias: 'codex',
      model_name: 'gpt-5.4',
    }));
    mockUpdatePlanIssue.mock.mockImplementationOnce(async () => ({
      issue_number: 18,
      agent_alias: 'codex-next',
      model_name: 'gpt-5.5',
    }));
    mockUpdatePlanIssue.mock.mockImplementationOnce(async () => {
      throw new Error('db write failed');
    });
    mockUpdatePlanIssue.mock.mockImplementationOnce(async () => {
      throw new Error('rollback db write failed');
    });
    mockSafeUpdateLabels.mock.mockImplementationOnce(async () => {});

    const req = {
      params: { id: 'draft-rollback-db', issueNumber: '18' },
      user: { id: 'user-1' },
      body: { model_name: 'gpt-5.5', status: 'under_review' },
    };
    const res = createResponse();

    await handler(req as never, res as never);

    assert.strictEqual(res.statusCode, 500);
    assert.deepStrictEqual(res.body, {
      error: 'Failed to update issue and failed to roll back synchronized config changes',
      code: 'ISSUE_CONFIG_ROLLBACK_FAILED',
      details: {
        draftId: 'draft-rollback-db',
        issueNumber: 18,
        repository: 'owner/repo',
        originalError: 'db write failed',
        rollbackError: 'rollback db write failed',
      },
    });
  });

  test('implementIssue persists effective ultrafix settings before implementation starts', async () => {
    resetMocks();
    const handler = createImplementIssueHandler({
      verifyOwnership: async () => ({
        authorized: true,
        draft: {
          repository: 'owner/repo',
          name: 'Plan',
          context_config: JSON.stringify({
            runUltrafix: true,
            ultrafixGoal: 7,
            ultrafixMaxCycles: 2,
          }),
        },
      }),
    });

    mockGetPlanIssue.mock.mockImplementationOnce(async () => ({
      issue_number: 17,
      status: 'pending',
      agent_alias: 'codex',
      model_name: 'gpt-5.4',
      run_ultrafix: null,
      ultrafix_goal: null,
      ultrafix_max_cycles: null,
    }));
    mockUpdatePlanIssue.mock.mockImplementationOnce(async (_draftId, issueNumber, updates) => ({
      issue_number: issueNumber as number,
      status: 'pending',
      agent_alias: 'codex',
      model_name: 'gpt-5.4',
      ...updates,
    }));
    mockHandleSingleAgentImplementation.mock.mockImplementationOnce(async (params) => ({
      success: true,
      planIssue: params.planIssue,
    }));

    const req = {
      params: { id: 'draft-implement', issueNumber: '17' },
      user: { id: 'user-1' },
      body: {},
    };
    const res = createResponse();

    await handler(req as never, res as never);

    assert.deepStrictEqual(mockUpdatePlanIssue.mock.calls[0]?.arguments, [
      'draft-implement',
      17,
      { run_ultrafix: true, ultrafix_goal: 7, ultrafix_max_cycles: 2 },
    ]);
    assert.deepStrictEqual(mockHandleSingleAgentImplementation.mock.calls[0]?.arguments[0].planIssue, {
      issue_number: 17,
      status: 'pending',
      agent_alias: 'codex',
      model_name: 'gpt-5.4',
      run_ultrafix: true,
      ultrafix_goal: 7,
      ultrafix_max_cycles: 2,
    });
    assert.strictEqual(res.statusCode, 200);
  });

  test('implementIssue rejects a repository assertion that does not match the draft', async () => {
    resetMocks();
    const handler = createImplementIssueHandler({
      verifyOwnership: async () => ({
        authorized: true,
        draft: {
          repository: 'owner/repo',
          name: 'Plan',
          context_config: null,
        },
      }),
    });

    const req = {
      params: { id: 'draft-mismatch', issueNumber: '5' },
      user: { id: 'user-1' },
      body: { repository: 'other/repo' },
    };
    const res = createResponse();

    await handler(req as never, res as never);

    assert.strictEqual(res.statusCode, 400);
    assert.deepStrictEqual(res.body, { error: 'Issue belongs to owner/repo, not other/repo' });
  });

  test('implementIssue rejects malformed models entries with 400', async () => {
    resetMocks();
    const handler = createImplementIssueHandler({
      verifyOwnership: async () => ({
        authorized: true,
        draft: {
          repository: 'owner/repo',
          name: 'Plan',
          context_config: null,
        },
      }),
    });

    const req = {
      params: { id: 'draft-models', issueNumber: '5' },
      user: { id: 'user-1' },
      body: { models: [{ agent_alias: 'codex' }] },
    };
    const res = createResponse();

    await handler(req as never, res as never);

    assert.strictEqual(res.statusCode, 400);
    assert.deepStrictEqual(res.body, { error: 'models must be an array of { agent_alias, model_name } objects' });
  });

  test('implementIssue returns 404 when the issue is missing from the plan', async () => {
    resetMocks();
    const handler = createImplementIssueHandler({
      verifyOwnership: async () => ({
        authorized: true,
        draft: {
          repository: 'owner/repo',
          name: 'Plan',
          context_config: null,
        },
      }),
    });
    mockGetPlanIssue.mock.mockImplementationOnce(async () => null);

    const req = {
      params: { id: 'draft-missing', issueNumber: '99' },
      user: { id: 'user-1' },
      body: {},
    };
    const res = createResponse();

    await handler(req as never, res as never);

    assert.strictEqual(res.statusCode, 404);
    assert.deepStrictEqual(res.body, { error: 'Issue not found in this plan' });
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
