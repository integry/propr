import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import { getSummarizationBatchLimitOverride } from '../packages/core/src/services/relevance/summaryMinerBatchLimits.js';

describe('summary miner batch limits', () => {
  test('applies the OSS 120B summarization override across routed model ids', () => {
    assert.deepEqual(
      getSummarizationBatchLimitOverride('antigravity:antigravity-gpt-oss-120b-medium'),
      { maxBatchTokens: 20_000, maxItemsPerBatch: 5 }
    );
  });

  test('does not cap other Antigravity models by agent namespace alone', () => {
    assert.equal(
      getSummarizationBatchLimitOverride('antigravity-gemini-3.5-flash-medium'),
      undefined
    );
  });
});
