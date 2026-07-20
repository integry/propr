import { after, test, describe } from 'node:test';
import assert from 'node:assert/strict';

import {
  CLAUDE_REASONING_LEVELS,
  CODEX_REASONING_LEVELS,
  REASONING_LEVELS,
} from '@propr/shared';
import { parseSettingValue } from '../packages/cli/src/api/settings.ts';

process.env.PROPR_DEMO_MODE = 'true';

const { closeConnection } = await import('../packages/core/src/db/connection.ts');
const { validateModelReasoningLevel } = await import('../packages/core/src/config/configManagerReasoning.ts');
const { extractSettingSaves } = await import('../packages/api/routes/configSettings.ts');
const { saveSettingsWithRollback } = await import('../packages/api/routes/configRoutesSettings.ts');

after(async () => {
  await closeConnection();
});

describe('shared reasoning level vocabulary', () => {
  test('defines all accepted values and agent subsets', () => {
    assert.deepEqual(REASONING_LEVELS, ['low', 'medium', 'high', 'xhigh', 'max', 'ultra', 'ultracode', 'auto']);
    assert.deepEqual(CODEX_REASONING_LEVELS, ['low', 'medium', 'high', 'xhigh', 'max', 'ultra']);
    assert.deepEqual(CLAUDE_REASONING_LEVELS, ['low', 'medium', 'high', 'xhigh', 'max', 'ultracode', 'auto']);
  });
});

describe('CLI model_reasoning_level parsing', () => {
  for (const level of REASONING_LEVELS) {
    test(`accepts ${level}`, () => {
      assert.equal(parseSettingValue('model_reasoning_level', level), level);
    });
  }

  test('normalizes case before saving', () => {
    assert.equal(parseSettingValue('model_reasoning_level', 'ULTRACODE'), 'ultracode');
  });

  test('clears with empty string', () => {
    assert.equal(parseSettingValue('model_reasoning_level', ''), '');
  });

  test('rejects invalid values before API calls', () => {
    assert.throws(
      () => parseSettingValue('model_reasoning_level', 'bogus'),
      /model_reasoning_level: must be one of: low, medium, high, xhigh, max, ultra, ultracode, auto, or an empty string/
    );
  });
});

describe('API model_reasoning_level extraction', () => {
  for (const level of REASONING_LEVELS) {
    test(`extracts ${level}`, async () => {
      const result = await extractSettingSaves({ model_reasoning_level: level });
      assert.equal(result.error, undefined);
      assert.deepEqual(result.saves, [{ name: 'model_reasoning_level' }]);
      assert.equal(result.normalized.model_reasoning_level, level);
    });
  }

  test('normalizes uppercase API payloads', async () => {
    const result = await extractSettingSaves({ model_reasoning_level: 'ULTRACODE' });
    assert.equal(result.error, undefined);
    assert.equal(result.normalized.model_reasoning_level, 'ultracode');
  });

  test('rejects invalid API payloads', async () => {
    const result = await extractSettingSaves({ model_reasoning_level: 'bogus' });
    assert.match(result.error ?? '', /model_reasoning_level must be one of/);
    assert.deepEqual(result.saves, []);
  });
});

describe('core model_reasoning_level validation', () => {
  test('accepts all values plus agent default', () => {
    for (const level of ['', ...REASONING_LEVELS]) {
      assert.deepEqual(validateModelReasoningLevel(level), { valid: true, value: level });
    }
  });

  test('normalizes mixed-case levels', () => {
    assert.deepEqual(validateModelReasoningLevel('XHIGH'), { valid: true, value: 'xhigh' });
  });

  test('rejects invalid and whitespace-only values', () => {
    assert.deepEqual(validateModelReasoningLevel('bogus').valid, false);
    const whitespaceResult = validateModelReasoningLevel('   ');
    assert.equal(whitespaceResult.valid, false);
    assert.match((whitespaceResult as { valid: false; error: string }).error, /whitespace-only/);
  });
});

describe('settings save rollback path for model_reasoning_level', () => {
  test('invalid values return 400 before any transaction starts', async () => {
    let published = false;
    const result = await saveSettingsWithRollback({
      settings: {
        worker_concurrency: 10,
        model_reasoning_level: 'bogus',
      },
      publishConfigUpdate: async () => {
        published = true;
      },
    });

    assert.equal(result.status, 400);
    assert.match(String(result.body.error), /model_reasoning_level must be one of/);
    assert.equal(published, false);
  });
});
