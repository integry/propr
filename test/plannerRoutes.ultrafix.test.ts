import { describe, test } from 'node:test';
import assert from 'node:assert';

const {
  buildUpdatedExecutionConfig,
  mergeExecutionContextConfig
} = await import('../packages/api/routes/plannerRoutes.ts');

describe('plannerRoutes ultrafix execution config updates', () => {
  test('numeric runUltrafix values follow the same normalization rules as issue updates', () => {
    const updated = buildUpdatedExecutionConfig(
      {
        useEpic: false,
        autoMerge: false,
      },
      {
        runUltrafix: 1,
        ultrafixGoal: 8,
      }
    );

    assert.deepStrictEqual(updated, {
      useEpic: false,
      autoMerge: false,
      runUltrafix: true,
      ultrafixGoal: 8,
      ultrafixMaxCycles: undefined,
    });
  });

  test('planner-level ultrafix defaults do not implicitly enable ultrafix', () => {
    const updated = buildUpdatedExecutionConfig(
      {
        useEpic: false,
        autoMerge: false,
        runUltrafix: false,
      },
      {
        ultrafixGoal: 8,
      }
    );

    assert.deepStrictEqual(updated, {
      useEpic: false,
      autoMerge: false,
      runUltrafix: false,
      ultrafixGoal: 8,
      ultrafixMaxCycles: undefined,
    });
  });

  test('clearing draft ultrafix goal does not implicitly enable ultrafix', () => {
    const updated = buildUpdatedExecutionConfig(
      {
        useEpic: false,
        autoMerge: false,
        runUltrafix: false,
        ultrafixGoal: 7,
        ultrafixMaxCycles: 4,
      },
      {
        ultrafixGoal: null,
      }
    );

    assert.deepStrictEqual(updated, {
      useEpic: false,
      autoMerge: false,
      runUltrafix: false,
      ultrafixGoal: null,
      ultrafixMaxCycles: null,
    });
  });

  test('rejects contradictory draft ultrafix payloads', () => {
    assert.throws(
      () => buildUpdatedExecutionConfig(
        {
          runUltrafix: false,
        },
        {
          runUltrafix: false,
          ultrafixGoal: 5,
        }
      ),
      /runUltrafix cannot be false when ultrafixGoal or ultrafixMaxCycles is set/
    );
  });

  test('null runUltrafix clears draft ultrafix state and dependent overrides', () => {
    const updated = buildUpdatedExecutionConfig(
      {
        runUltrafix: true,
        ultrafixGoal: 7,
        ultrafixMaxCycles: 4,
      },
      {
        runUltrafix: null,
      }
    );

    assert.deepStrictEqual(updated, {
      runUltrafix: undefined,
      ultrafixGoal: null,
      ultrafixMaxCycles: null,
    });
  });

  test('execution settings persistence preserves unrelated context_config keys', () => {
    const merged = mergeExecutionContextConfig(
      JSON.stringify({
        customFlag: 'keep-me',
        executionMetadata: { source: 'planner' },
        runUltrafix: true,
      }),
      {
        runUltrafix: false,
        ultrafixGoal: null,
        ultrafixMaxCycles: null,
      }
    );

    assert.deepStrictEqual(merged, {
      customFlag: 'keep-me',
      executionMetadata: { source: 'planner' },
      runUltrafix: false,
      ultrafixGoal: null,
      ultrafixMaxCycles: null,
    });
  });
});
