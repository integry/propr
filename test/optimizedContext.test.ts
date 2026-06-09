import { test } from 'node:test';
import assert from 'node:assert/strict';

import { buildCompactRepomixConfig, planFilesToRemoveForTokenLimit } from '../packages/core/src/services/context/optimizedContext.ts';

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

test('treats large formatted output deltas as file expansion instead of fixed overhead', () => {
  const plan = planFilesToRemoveForTokenLimit(
    ['critical.html', 'useful.html', 'optional.html', 'least-relevant.html'],
    {
      'critical.html': 1_000,
      'useful.html': 1_000,
      'optional.html': 1_000,
      'least-relevant.html': 1_000,
    },
    10_000,
    5_000,
  );

  assert.equal(plan.targetFileTokens > 0, true);
  assert.deepEqual(plan.filesToRemove, ['useful.html', 'optional.html', 'least-relevant.html']);
  assert.equal(plan.estimatedRemainingTokens <= 5_000, true);
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

test('compact repomix config disables metadata before files are dropped', () => {
  const compactConfig = buildCompactRepomixConfig({
    output: {
      fileSummary: true,
      directoryStructure: true,
      includeFullDirectoryStructure: true,
      topFilesLength: 10,
      tokenCountTree: true,
    },
  });

  assert.equal(compactConfig.output.fileSummary, false);
  assert.equal(compactConfig.output.directoryStructure, false);
  assert.equal(compactConfig.output.includeFullDirectoryStructure, false);
  assert.equal(compactConfig.output.topFilesLength, 0);
  assert.equal(compactConfig.output.tokenCountTree, true);
});
