import { describe, test } from 'node:test';
import assert from 'node:assert';

const { buildUpdatedExecutionConfig } = await import('../packages/api/routes/plannerRoutes.ts');

describe('plannerRoutes ultrafix execution config updates', () => {
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
});
