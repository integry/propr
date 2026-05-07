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
});
