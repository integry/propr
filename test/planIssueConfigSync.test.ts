import { describe, test, mock } from 'node:test';
import assert from 'node:assert';

const mockUpdatePlanIssue = mock.fn(async () => null);
const mockGetAuthenticatedOctokit = mock.fn(async () => ({ request: mock.fn() }));
const mockSafeUpdateLabels = mock.fn(async () => {});
const mockLoggerError = mock.fn();
const mockLoggerWithCorrelation = mock.fn(() => ({
  info: mock.fn(),
  warn: mock.fn(),
  error: mock.fn(),
  debug: mock.fn(),
}));

await mock.module('@propr/core', {
  namedExports: {
    db: {},
    getAuthenticatedOctokit: mockGetAuthenticatedOctokit,
    logger: {
      error: mockLoggerError,
      withCorrelation: mockLoggerWithCorrelation,
    },
    safeUpdateLabels: mockSafeUpdateLabels,
    updatePlanIssue: mockUpdatePlanIssue,
  },
});

await mock.module('../packages/api/routes/planIssueHelpers.js', {
  namedExports: {
    getLlmLabel: mock.fn(async (modelName: string | null) => modelName ? `llm:${modelName}` : null),
    getOrCreateEpicLabel: mock.fn(async () => null),
  },
});

const {
  filterIssuesNeedingConfigSync,
  persistEffectiveUltrafixSettings,
  syncPendingIssueConfigs,
  updateIssueConfigWithRollback,
} = await import('../packages/api/routes/planIssueConfigSync.ts');

function resetMocks(): void {
  mockUpdatePlanIssue.mock.resetCalls();
  mockSafeUpdateLabels.mock.resetCalls();
  mockGetAuthenticatedOctokit.mock.resetCalls();
  mockLoggerError.mock.resetCalls();
  mockLoggerWithCorrelation.mock.resetCalls();
  mockSafeUpdateLabels.mock.mockImplementation(async () => {});
}

describe('planIssueConfigSync rollback behavior', () => {
  test('rolls back GitHub labels when DB persistence fails after label sync', async () => {
    resetMocks();
    mockUpdatePlanIssue.mock.mockImplementationOnce(async () => {
      throw new Error('db write failed');
    });

    await assert.rejects(
      updateIssueConfigWithRollback({
        draftId: 'draft-1',
        issueNumber: 11,
        repository: 'owner/repo',
        currentIssue: {
          agent_alias: 'codex',
          model_name: 'gpt-5.4',
        },
        updates: {
          model_name: 'gpt-5.5',
        },
      }),
      /db write failed/
    );

    assert.strictEqual(mockSafeUpdateLabels.mock.calls.length, 2);
    assert.deepStrictEqual(mockSafeUpdateLabels.mock.calls.map((call) => call.arguments.slice(1)), [
      [['llm:gpt-5.4'], ['llm:gpt-5.5']],
      [['llm:gpt-5.5'], ['llm:gpt-5.4']],
    ]);
  });

  test('rolls back earlier batch updates when a later pending issue sync fails', async () => {
    resetMocks();
    mockUpdatePlanIssue.mock.mockImplementation(async (_draftId, issueNumber, updates) => {
      if (issueNumber === 2) {
        throw new Error('second issue failed');
      }
      return { issue_number: issueNumber as number, ...updates };
    });

    await assert.rejects(
      syncPendingIssueConfigs({
        draftId: 'draft-2',
        repository: 'owner/repo',
        pendingIssues: [
          { issue_number: 1, agent_alias: 'codex', model_name: 'gpt-5.4' },
          { issue_number: 2, agent_alias: 'codex', model_name: 'gpt-5.4' },
        ],
        updates: {
          model_name: 'gpt-5.5',
        },
      }),
      /second issue failed/
    );

    assert.deepStrictEqual(
      mockUpdatePlanIssue.mock.calls.map((call) => call.arguments),
      [
        ['draft-2', 1, { model_name: 'gpt-5.5' }],
        ['draft-2', 2, { model_name: 'gpt-5.5' }],
        ['draft-2', 1, { model_name: 'gpt-5.4' }],
      ]
    );
    assert.deepStrictEqual(mockSafeUpdateLabels.mock.calls.map((call) => call.arguments.slice(1)), [
      [['llm:gpt-5.4'], ['llm:gpt-5.5']],
      [['llm:gpt-5.4'], ['llm:gpt-5.5']],
      [['llm:gpt-5.5'], ['llm:gpt-5.4']],
    ]);
  });

  test('filters implement-all config sync to pending issues with actual config changes', () => {
    const filtered = filterIssuesNeedingConfigSync({
      pendingIssues: [
        { issue_number: 1, agent_alias: 'codex', model_name: 'gpt-5.4' },
        { issue_number: 2, agent_alias: 'reviewer', model_name: 'gpt-5.5' },
        { issue_number: 3, agent_alias: 'codex', model_name: 'gpt-5.4' },
      ],
      updates: {
        agent_alias: 'codex',
        model_name: 'gpt-5.5',
      },
    });

    assert.deepStrictEqual(filtered.map((issue) => issue.issue_number), [1, 3]);
  });

  test('persists effective ultrafix settings only for issues that inherit planner defaults', async () => {
    resetMocks();
    mockUpdatePlanIssue.mock.mockImplementation(async (_draftId, issueNumber, updates) => ({
      issue_number: issueNumber as number,
      ...updates,
    }));

    const resolvedIssues = await persistEffectiveUltrafixSettings({
      draftId: 'draft-ultrafix',
      issues: [
        { issue_number: 1, run_ultrafix: null, ultrafix_goal: null, ultrafix_max_cycles: null },
        { issue_number: 2, run_ultrafix: true, ultrafix_goal: 5, ultrafix_max_cycles: 2 },
      ],
      contextConfig: {
        runUltrafix: true,
        ultrafixGoal: 5,
        ultrafixMaxCycles: 2,
      },
    });

    assert.deepStrictEqual(mockUpdatePlanIssue.mock.calls.map((call) => call.arguments), [
      ['draft-ultrafix', 1, { run_ultrafix: true, ultrafix_goal: 5, ultrafix_max_cycles: 2 }],
    ]);
    assert.deepStrictEqual(resolvedIssues, [
      { issue_number: 1, run_ultrafix: true, ultrafix_goal: 5, ultrafix_max_cycles: 2 },
      { issue_number: 2, run_ultrafix: true, ultrafix_goal: 5, ultrafix_max_cycles: 2 },
    ]);
  });
});
