import { test, describe } from 'node:test';
import assert from 'node:assert';

/**
 * Test suite for ultrafix and PR review settings.
 *
 * Tests cover:
 * - CLI parseSettingValue validation for new keys
 * - VALID_SETTING_KEYS includes new keys
 * - isValidSettingKey type guard for new keys
 * - Boundary validation for numeric settings
 */

import {
  VALID_SETTING_KEYS,
  isValidSettingKey,
  parseSettingValue,
} from '../packages/cli/src/api/settings.js';

describe('VALID_SETTING_KEYS includes new ultrafix keys', () => {
  test('should include pr_review_model', () => {
    assert.ok(VALID_SETTING_KEYS.includes('pr_review_model'));
  });

  test('should include model_reasoning_level', () => {
    assert.ok(VALID_SETTING_KEYS.includes('model_reasoning_level'));
  });

  test('should include ultrafix_rating_goal', () => {
    assert.ok(VALID_SETTING_KEYS.includes('ultrafix_rating_goal'));
  });

  test('should include ultrafix_max_cycles', () => {
    assert.ok(VALID_SETTING_KEYS.includes('ultrafix_max_cycles'));
  });

  test('should include ultrafix_pause_seconds', () => {
    assert.ok(VALID_SETTING_KEYS.includes('ultrafix_pause_seconds'));
  });

  test('should have 14 total setting keys', () => {
    assert.strictEqual(VALID_SETTING_KEYS.length, 14);
  });
});

describe('isValidSettingKey for new keys', () => {
  test('pr_review_model is valid', () => {
    assert.ok(isValidSettingKey('pr_review_model'));
  });

  test('model_reasoning_level is valid', () => {
    assert.ok(isValidSettingKey('model_reasoning_level'));
  });

  test('ultrafix_rating_goal is valid', () => {
    assert.ok(isValidSettingKey('ultrafix_rating_goal'));
  });

  test('ultrafix_max_cycles is valid', () => {
    assert.ok(isValidSettingKey('ultrafix_max_cycles'));
  });

  test('ultrafix_pause_seconds is valid', () => {
    assert.ok(isValidSettingKey('ultrafix_pause_seconds'));
  });

  test('unknown_key is not valid', () => {
    assert.ok(!isValidSettingKey('unknown_key'));
  });
});

describe('parseSettingValue for pr_review_model', () => {
  test('should accept any string value', () => {
    assert.strictEqual(parseSettingValue('pr_review_model', 'claude-opus-4-6'), 'claude-opus-4-6');
  });

  test('should accept empty string', () => {
    assert.strictEqual(parseSettingValue('pr_review_model', ''), '');
  });
});

describe('parseSettingValue for ultrafix_rating_goal', () => {
  test('should parse valid value 7', () => {
    assert.strictEqual(parseSettingValue('ultrafix_rating_goal', '7'), 7);
  });

  test('should accept minimum value 1', () => {
    assert.strictEqual(parseSettingValue('ultrafix_rating_goal', '1'), 1);
  });

  test('should accept maximum value 10', () => {
    assert.strictEqual(parseSettingValue('ultrafix_rating_goal', '10'), 10);
  });

  test('should reject value 0', () => {
    assert.throws(() => parseSettingValue('ultrafix_rating_goal', '0'), /must be a number between 1 and 10/);
  });

  test('should reject value 11', () => {
    assert.throws(() => parseSettingValue('ultrafix_rating_goal', '11'), /must be a number between 1 and 10/);
  });

  test('should reject non-numeric value', () => {
    assert.throws(() => parseSettingValue('ultrafix_rating_goal', 'abc'), /must be a positive integer between 1 and 10/);
  });

  test('should reject negative value', () => {
    assert.throws(() => parseSettingValue('ultrafix_rating_goal', '-1'), /must be a positive integer between 1 and 10/);
  });
});

describe('parseSettingValue for ultrafix_max_cycles', () => {
  test('should parse valid value 5', () => {
    assert.strictEqual(parseSettingValue('ultrafix_max_cycles', '5'), 5);
  });

  test('should accept minimum value 1', () => {
    assert.strictEqual(parseSettingValue('ultrafix_max_cycles', '1'), 1);
  });

  test('should accept large values (no upper limit)', () => {
    assert.strictEqual(parseSettingValue('ultrafix_max_cycles', '10000'), 10000);
  });

  test('should reject value 0', () => {
    assert.throws(() => parseSettingValue('ultrafix_max_cycles', '0'), /must be a positive integer/);
  });

  test('should reject non-numeric value', () => {
    assert.throws(() => parseSettingValue('ultrafix_max_cycles', 'xyz'), /must be a positive integer/);
  });
});

describe('parseSettingValue for ultrafix_pause_seconds', () => {
  test('should parse valid value 60', () => {
    assert.strictEqual(parseSettingValue('ultrafix_pause_seconds', '60'), 60);
  });

  test('should accept minimum value 0', () => {
    assert.strictEqual(parseSettingValue('ultrafix_pause_seconds', '0'), 0);
  });

  test('should accept large values (no upper limit)', () => {
    assert.strictEqual(parseSettingValue('ultrafix_pause_seconds', '86400'), 86400);
  });

  test('should reject value -1', () => {
    assert.throws(() => parseSettingValue('ultrafix_pause_seconds', '-1'), /must be a non-negative integer/);
  });

  test('should reject non-numeric value', () => {
    assert.throws(() => parseSettingValue('ultrafix_pause_seconds', 'abc'), /must be a non-negative integer/);
  });
});
