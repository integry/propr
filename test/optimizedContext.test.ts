import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  buildCompactRepomixConfig,
  filterExplicitFilesByPackedPaths,
  planFilesToRemoveForTokenLimit,
} from '../packages/core/src/services/context/optimizedContext.ts';

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

test('preserves a measurable singleton when non-file overhead already exceeds the limit', () => {
  const plan = planFilesToRemoveForTokenLimit(
    ['a.ts', 'b.ts'],
    { 'a.ts': 100, 'b.ts': 100 },
    1_000,
    500,
  );

  assert.deepEqual(plan.filesToRemove, ['b.ts']);
  assert.equal(plan.targetFileTokens, 0);
});

test('preserves the highest-priority singleton when the safety target rejects every file', () => {
  const plan = planFilesToRemoveForTokenLimit(
    ['highest-priority.ts', 'second.ts'],
    { 'highest-priority.ts': 990, 'second.ts': 990 },
    3_980,
    3_000,
  );

  assert.deepEqual(plan.filesToRemove, ['second.ts']);
  assert.equal(plan.estimatedRemainingTokens, 2_990);
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

test('skips oversized priority files and keeps later files that fit', () => {
  const files = ['top.css', 'too-large.html', 'third.ts', 'fourth.ts'];
  const plan = planFilesToRemoveForTokenLimit(
    files,
    {
      'top.css': 115_000,
      'too-large.html': 900_000,
      'third.ts': 100_000,
      'fourth.ts': 100_000,
    },
    1_215_000,
    980_000,
  );

  assert.deepEqual(plan.filesToRemove, ['too-large.html']);
  assert.equal(plan.estimatedRemainingTokens <= 980_000, true);
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

test('stops removing when the last file has no measured token count', () => {
  const plan = planFilesToRemoveForTokenLimit(
    ['a.ts'],
    {},
    1_000,
    500,
  );

  assert.deepEqual(plan.filesToRemove, []);
});

test('filters explicit optimization candidates to files Repomix actually packed', () => {
  assert.deepEqual(
    filterExplicitFilesByPackedPaths(
      ['oversized.ts', 'missing.ts'],
      { 'oversized.ts': 5_000 },
    ),
    ['oversized.ts'],
  );
});

test('normalizes explicit paths while preserving priority and removing duplicates', () => {
  assert.deepEqual(
    filterExplicitFilesByPackedPaths(
      ['./src/first.ts', 'src\\second.ts', 'src/first.ts'],
      { 'src/second.ts': 200, 'src/first.ts': 100 },
    ),
    ['src/first.ts', 'src/second.ts'],
  );
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
