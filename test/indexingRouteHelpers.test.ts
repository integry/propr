import { describe, test } from 'node:test';
import assert from 'node:assert';
import {
  getEnabledResummarizationTargets,
  validateIndexingInput,
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

  test('rejects non-boolean fullReindex values', () => {
    assert.strictEqual(
      validateIndexingInput({ repository: 'integry/propr', fullReindex: 'yes' }),
      'fullReindex must be a boolean'
    );
    assert.strictEqual(
      validateIndexingInput({ repository: 'integry/propr', fullReindex: true }),
      null
    );
  });

  test('rejects non-object indexing request bodies', () => {
    assert.strictEqual(validateIndexingInput(null), 'request body must be a JSON object');
    assert.strictEqual(validateIndexingInput('integry/propr'), 'request body must be a JSON object');
  });

  test('rejects non-string stop-indexing branches', () => {
    assert.strictEqual(validateStopIndexingInput({ repository: 'integry/propr', branch: 42 }), 'branch must be a string');
    assert.strictEqual(validateStopIndexingInput({ repository: 'integry/propr', branch: 'release/2026' }), null);
  });

  test('rejects non-object stop-indexing request bodies', () => {
    assert.strictEqual(validateStopIndexingInput(null), 'request body must be a JSON object');
    assert.strictEqual(validateStopIndexingInput(['integry/propr']), 'request body must be a JSON object');
  });
});
