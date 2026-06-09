import { test } from 'node:test';
import assert from 'node:assert/strict';

import { planFilesToRemoveForTokenLimit } from '../packages/core/src/services/context/optimizedContext.ts';

test('plans a direct cut to fit the context token budget', () => {
  const files = ['important.ts', 'useful.ts', 'huge.html', 'least-relevant.html'];
  const plan = planFilesToRemoveForTokenLimit(
    files,
    {
      'important.ts': 100,
      'useful.ts': 150,
      'huge.html': 900,
      'least-relevant.html': 800,
    },
    2_050,
    500,
  );

  assert.deepEqual(plan.filesToRemove, ['huge.html', 'least-relevant.html']);
  assert.equal(plan.tokensFreed, 1_700);
  assert.ok(plan.estimatedRemainingTokens <= 500);
});

test('removes all files when non-file overhead already exceeds the limit', () => {
  const plan = planFilesToRemoveForTokenLimit(
    ['a.ts', 'b.ts'],
    { 'a.ts': 100, 'b.ts': 100 },
    1_000,
    500,
  );

  assert.deepEqual(plan.filesToRemove, ['a.ts', 'b.ts']);
  assert.equal(plan.targetFileTokens, 0);
});

test('removes at least one file when token counts are unavailable', () => {
  const plan = planFilesToRemoveForTokenLimit(
    ['a.ts', 'b.ts'],
    {},
    1_000,
    500,
  );

  assert.deepEqual(plan.filesToRemove, ['b.ts']);
});
