import { describe, test, mock } from 'node:test';
import assert from 'node:assert';

await mock.module('@propr/core', {
  namedExports: {
    PlanIssueStatus: {},
    updatePlanIssue: mock.fn(async () => null),
  },
});

const {
  buildIssueUpdate,
  resolveIssueUltrafixSettings,
  resolveAndPersistIssueUltrafixSettings,
  validateIssueUltrafixPayload,
} = await import('../packages/api/routes/planIssueRouteUtils.ts');

describe('planIssueRouteUtils ultrafix overrides', () => {
  test('inherit mode restores planner ultrafix goal and max cycle defaults', () => {
    const resolved = resolveIssueUltrafixSettings(
      {
        run_ultrafix: null,
        ultrafix_goal: 9,
        ultrafix_max_cycles: 4,
      },
      {
        runUltrafix: true,
        ultrafixGoal: 7,
        ultrafixMaxCycles: 2,
      }
    );

    assert.deepStrictEqual(resolved, {
      runUltrafix: true,
      ultrafixGoal: 7,
      ultrafixMaxCycles: 2,
    });
  });

  test('explicit enable keeps issue-level ultrafix goal and max cycle overrides', () => {
    const resolved = resolveIssueUltrafixSettings(
      {
        run_ultrafix: true,
        ultrafix_goal: 9,
        ultrafix_max_cycles: 4,
      },
      {
        runUltrafix: true,
        ultrafixGoal: 7,
        ultrafixMaxCycles: 2,
      }
    );

    assert.deepStrictEqual(resolved, {
      runUltrafix: true,
      ultrafixGoal: 9,
      ultrafixMaxCycles: 4,
    });
  });

  test('switching an issue back to inherit clears persisted ultrafix overrides', () => {
    const update = buildIssueUpdate({
      run_ultrafix: null,
    });

    assert.deepStrictEqual(update, {
      agent_alias: undefined,
      model_name: undefined,
      status: undefined,
      run_ultrafix: null,
      ultrafix_goal: null,
      ultrafix_max_cycles: null,
    });
  });

  test('disabling ultrafix clears dependent issue-level goal and max cycle values', () => {
    const update = buildIssueUpdate({
      run_ultrafix: false,
      ultrafix_goal: 8,
      ultrafix_max_cycles: 3,
    });

    assert.deepStrictEqual(update, {
      agent_alias: undefined,
      model_name: undefined,
      status: undefined,
      run_ultrafix: false,
      ultrafix_goal: null,
      ultrafix_max_cycles: null,
    });
  });

  test('issue-level goal or max updates promote the issue to explicit ultrafix mode', () => {
    const update = buildIssueUpdate({
      ultrafix_goal: 8,
      ultrafix_max_cycles: 3,
    });

    assert.deepStrictEqual(update, {
      agent_alias: undefined,
      model_name: undefined,
      status: undefined,
      run_ultrafix: true,
      ultrafix_goal: 8,
      ultrafix_max_cycles: 3,
    });
  });

  test('clearing an issue-level ultrafix goal does not implicitly enable ultrafix', () => {
    const update = buildIssueUpdate({
      ultrafix_goal: null,
    });

    assert.deepStrictEqual(update, {
      agent_alias: undefined,
      model_name: undefined,
      status: undefined,
      run_ultrafix: undefined,
      ultrafix_goal: null,
      ultrafix_max_cycles: undefined,
    });
  });

  test('rejects inherit mode when explicit ultrafix overrides are provided', () => {
    const error = validateIssueUltrafixPayload({
      run_ultrafix: null,
      ultrafix_goal: 5,
    });

    assert.strictEqual(
      error,
      'run_ultrafix cannot inherit planner defaults when ultrafix_goal or ultrafix_max_cycles is set'
    );
  });

  test('rejects disabled ultrafix when explicit ultrafix overrides are provided', () => {
    const error = validateIssueUltrafixPayload({
      run_ultrafix: false,
      ultrafix_max_cycles: 3,
    });

    assert.strictEqual(
      error,
      'run_ultrafix cannot be false when ultrafix_goal or ultrafix_max_cycles is set'
    );
  });

  test('snapshots inherited planner ultrafix settings before implementation starts', async () => {
    const { updatePlanIssue } = await import('@propr/core');
    const updatePlanIssueMock = updatePlanIssue as unknown as {
      mock: {
        resetCalls: () => void;
        mockImplementationOnce: (fn: (...args: unknown[]) => unknown) => void;
        calls: Array<{ arguments: unknown[] }>;
      };
    };
    updatePlanIssueMock.mock.resetCalls();
    updatePlanIssueMock.mock.mockImplementationOnce(async (_draftId, _issueNumber, updates) => ({
      issue_number: 17,
      ...updates,
    }));

    const resolved = await resolveAndPersistIssueUltrafixSettings(
      'draft-1',
      {
        issue_number: 17,
        run_ultrafix: null,
        ultrafix_goal: null,
        ultrafix_max_cycles: null,
      },
      {
        runUltrafix: true,
        ultrafixGoal: 7,
        ultrafixMaxCycles: 2,
      }
    );

    assert.deepStrictEqual(updatePlanIssueMock.mock.calls[0].arguments, [
      'draft-1',
      17,
      {
        run_ultrafix: true,
        ultrafix_goal: 7,
        ultrafix_max_cycles: 2,
      },
    ]);
    assert.deepStrictEqual(resolved, {
      issue_number: 17,
      run_ultrafix: true,
      ultrafix_goal: 7,
      ultrafix_max_cycles: 2,
    });
  });

  test('cleans invalid persisted ultrafix values instead of only normalizing them in memory', async () => {
    const { updatePlanIssue } = await import('@propr/core');
    const updatePlanIssueMock = updatePlanIssue as unknown as {
      mock: {
        resetCalls: () => void;
        mockImplementationOnce: (fn: (...args: unknown[]) => unknown) => void;
        calls: Array<{ arguments: unknown[] }>;
      };
    };
    updatePlanIssueMock.mock.resetCalls();
    updatePlanIssueMock.mock.mockImplementationOnce(async (_draftId, _issueNumber, updates) => ({
      issue_number: 22,
      ...updates,
    }));

    const resolved = await resolveAndPersistIssueUltrafixSettings(
      'draft-2',
      {
        issue_number: 22,
        run_ultrafix: true,
        ultrafix_goal: 99,
        ultrafix_max_cycles: 0,
      },
      null
    );

    assert.deepStrictEqual(updatePlanIssueMock.mock.calls[0].arguments, [
      'draft-2',
      22,
      {
        run_ultrafix: true,
        ultrafix_goal: null,
        ultrafix_max_cycles: null,
      },
    ]);
    assert.deepStrictEqual(resolved, {
      issue_number: 22,
      run_ultrafix: true,
      ultrafix_goal: null,
      ultrafix_max_cycles: null,
    });
  });
});
