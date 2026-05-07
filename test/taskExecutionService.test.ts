import { describe, test } from 'node:test';
import assert from 'node:assert';

const {
  buildExecutionContextConfig,
  parseContextConfig
} = await import('../packages/core/src/services/taskExecutionService.ts');

describe('taskExecutionService context_config persistence', () => {
  test('parses string context_config objects without dropping unrelated keys', () => {
    const parsed = parseContextConfig(JSON.stringify({
      runUltrafix: true,
      customMetadata: {
        retained: true,
      },
    }));

    assert.deepStrictEqual(parsed, {
      runUltrafix: true,
      customMetadata: {
        retained: true,
      },
    });
  });

  test('execution result persistence preserves unrelated context_config keys', () => {
    const updated = buildExecutionContextConfig(
      {
        runUltrafix: true,
        customMetadata: {
          retained: true,
        },
      },
      [
        {
          number: 42,
          url: 'https://example.com/issues/42',
          title: 'Issue 42',
        },
      ],
      []
    );

    assert.deepStrictEqual((updated as Record<string, unknown>).customMetadata, {
      retained: true,
    });
    assert.deepStrictEqual(updated.executionResults, [
      {
        number: 42,
        url: 'https://example.com/issues/42',
        title: 'Issue 42',
      },
    ]);
  });
});
