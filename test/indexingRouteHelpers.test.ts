import { describe, test } from 'node:test';
import assert from 'node:assert';
import {
  getEnabledResummarizationTargets,
  shouldPublishOptimisticIndexing,
  validateStopIndexingInput
} from '../packages/api/routes/indexingRouteHelpers.ts';

describe('indexingRouteHelpers', () => {
  test('preserves configured base branches when building bulk reindex targets', () => {
    const targets = getEnabledResummarizationTargets([
      { name: 'integry/propr', enabled: true, baseBranch: 'release/2026' },
      { name: 'integry/core', enabled: true },
      { name: 'integry/disabled', enabled: false, baseBranch: 'develop' }
    ]);

    assert.deepStrictEqual(targets, [
      { name: 'integry/propr', baseBranch: 'release/2026' },
      { name: 'integry/core', baseBranch: undefined }
    ]);
  });

  test('only publishes optimistic indexing for newly accepted jobs', () => {
    assert.strictEqual(shouldPublishOptimisticIndexing({ success: true }), true);
    assert.strictEqual(
      shouldPublishOptimisticIndexing({
        success: false,
        error: 'Indexing job already queued for this repository and branch'
      }),
      false
    );
  });

  test('rejects non-string stop-indexing branches', () => {
    assert.strictEqual(validateStopIndexingInput({ repository: 'integry/propr', branch: 42 }), 'branch must be a string');
    assert.strictEqual(validateStopIndexingInput({ repository: 'integry/propr', branch: 'release/2026' }), null);
  });
});
