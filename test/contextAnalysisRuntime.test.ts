import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { createContainerExecutionId } from '../packages/core/src/agents/impl/utils/containerExecutionId.js';
import {
  DEFAULT_CONTEXT_ANALYSIS_TIMEOUT_MS,
  resolveContextAnalysisTimeoutMs,
} from '../packages/core/src/services/relevance/contextAnalysisConfig.js';

describe('context analysis runtime safeguards', () => {
  test('creates distinct fallback container IDs for parallel calls in the same millisecond', (t) => {
    t.mock.method(Date, 'now', () => 1_785_825_895_919);

    const first = createContainerExecutionId();
    const second = createContainerExecutionId();

    assert.notStrictEqual(first, second);
    assert.match(first, /^[a-z0-9]+-[a-f0-9]{8}$/);
    assert.match(second, /^[a-z0-9]+-[a-f0-9]{8}$/);
  });

  test('retains the task suffix for task-backed container IDs', () => {
    assert.strictEqual(createContainerExecutionId('task-12345678'), '12345678');
  });

  test('defaults context analysis to thirty minutes', () => {
    assert.strictEqual(DEFAULT_CONTEXT_ANALYSIS_TIMEOUT_MS, 1_800_000);
    assert.strictEqual(resolveContextAnalysisTimeoutMs(undefined), 1_800_000);
  });

  test('accepts a positive timeout override and rejects invalid values', () => {
    assert.strictEqual(resolveContextAnalysisTimeoutMs('7200000'), 7_200_000);
    assert.strictEqual(resolveContextAnalysisTimeoutMs('0'), DEFAULT_CONTEXT_ANALYSIS_TIMEOUT_MS);
    assert.strictEqual(resolveContextAnalysisTimeoutMs('not-a-number'), DEFAULT_CONTEXT_ANALYSIS_TIMEOUT_MS);
  });
});
