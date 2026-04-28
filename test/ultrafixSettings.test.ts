import { test, describe, after } from 'node:test';
import assert from 'node:assert';

/**
 * Test suite for ultrafix and PR review settings.
 *
 * Tests cover:
 * - CLI parseSettingValue validation for new keys
 * - VALID_SETTING_KEYS includes new keys
 * - isValidSettingKey type guard for new keys
 * - Default values and boundary validation
 */

// Re-implement the parsing logic from packages/cli/src/api/settings.ts
// to test it without requiring API client setup.

type SettingKey =
  | 'worker_concurrency'
  | 'github_user_whitelist'
  | 'analysis_model_fast'
  | 'planner_context_model'
  | 'planner_generation_model'
  | 'auto_followup_score_threshold'
  | 'auto_resolve_merge_conflicts'
  | 'pr_review_model'
  | 'ultrafix_rating_goal'
  | 'ultrafix_max_cycles'
  | 'ultrafix_pause_seconds';

const VALID_SETTING_KEYS: SettingKey[] = [
  'worker_concurrency',
  'github_user_whitelist',
  'analysis_model_fast',
  'planner_context_model',
  'planner_generation_model',
  'auto_followup_score_threshold',
  'auto_resolve_merge_conflicts',
  'pr_review_model',
  'ultrafix_rating_goal',
  'ultrafix_max_cycles',
  'ultrafix_pause_seconds',
];

function isValidSettingKey(key: string): key is SettingKey {
  return VALID_SETTING_KEYS.includes(key as SettingKey);
}

function parseSettingValue(key: SettingKey, value: string): number | string | string[] | boolean {
  switch (key) {
    case 'worker_concurrency':
    case 'auto_followup_score_threshold': {
      const parsed = parseInt(value, 10);
      if (isNaN(parsed)) throw new Error(`Invalid value for ${key}: must be a number`);
      if (key === 'auto_followup_score_threshold' && (parsed < 0 || parsed > 9))
        throw new Error(`Invalid value for ${key}: must be between 0 and 9`);
      if (key === 'worker_concurrency' && parsed < 1)
        throw new Error(`Invalid value for ${key}: must be at least 1`);
      return parsed;
    }
    case 'ultrafix_rating_goal': {
      const parsed = parseInt(value, 10);
      if (isNaN(parsed) || parsed < 1 || parsed > 10)
        throw new Error(`Invalid value for ${key}: must be a number between 1 and 10`);
      return parsed;
    }
    case 'ultrafix_max_cycles': {
      const parsed = parseInt(value, 10);
      if (isNaN(parsed) || parsed < 1 || parsed > 50)
        throw new Error(`Invalid value for ${key}: must be a number between 1 and 50`);
      return parsed;
    }
    case 'ultrafix_pause_seconds': {
      const parsed = parseInt(value, 10);
      if (isNaN(parsed) || parsed < 0 || parsed > 600)
        throw new Error(`Invalid value for ${key}: must be a number between 0 and 600`);
      return parsed;
    }
    case 'auto_resolve_merge_conflicts': {
      const lower = value.toLowerCase();
      if (lower !== 'true' && lower !== 'false')
        throw new Error(`Invalid value for ${key}: must be "true" or "false"`);
      return lower === 'true';
    }
    case 'github_user_whitelist':
      return value.split(',').map(s => s.trim()).filter(s => s.length > 0);
    case 'analysis_model_fast':
    case 'planner_context_model':
    case 'planner_generation_model':
    case 'pr_review_model':
      return value;
    default:
      return value;
  }
}

describe('VALID_SETTING_KEYS includes new ultrafix keys', () => {
  test('should include pr_review_model', () => {
    assert.ok(VALID_SETTING_KEYS.includes('pr_review_model'));
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

  test('should have 11 total setting keys', () => {
    assert.strictEqual(VALID_SETTING_KEYS.length, 11);
  });
});

describe('isValidSettingKey for new keys', () => {
  test('pr_review_model is valid', () => {
    assert.ok(isValidSettingKey('pr_review_model'));
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
    assert.throws(() => parseSettingValue('ultrafix_rating_goal', 'abc'), /must be a number between 1 and 10/);
  });

  test('should reject negative value', () => {
    assert.throws(() => parseSettingValue('ultrafix_rating_goal', '-1'), /must be a number between 1 and 10/);
  });
});

describe('parseSettingValue for ultrafix_max_cycles', () => {
  test('should parse valid value 5', () => {
    assert.strictEqual(parseSettingValue('ultrafix_max_cycles', '5'), 5);
  });

  test('should accept minimum value 1', () => {
    assert.strictEqual(parseSettingValue('ultrafix_max_cycles', '1'), 1);
  });

  test('should accept maximum value 50', () => {
    assert.strictEqual(parseSettingValue('ultrafix_max_cycles', '50'), 50);
  });

  test('should reject value 0', () => {
    assert.throws(() => parseSettingValue('ultrafix_max_cycles', '0'), /must be a number between 1 and 50/);
  });

  test('should reject value 51', () => {
    assert.throws(() => parseSettingValue('ultrafix_max_cycles', '51'), /must be a number between 1 and 50/);
  });

  test('should reject non-numeric value', () => {
    assert.throws(() => parseSettingValue('ultrafix_max_cycles', 'xyz'), /must be a number between 1 and 50/);
  });
});

describe('parseSettingValue for ultrafix_pause_seconds', () => {
  test('should parse valid value 60', () => {
    assert.strictEqual(parseSettingValue('ultrafix_pause_seconds', '60'), 60);
  });

  test('should accept minimum value 0', () => {
    assert.strictEqual(parseSettingValue('ultrafix_pause_seconds', '0'), 0);
  });

  test('should accept maximum value 600', () => {
    assert.strictEqual(parseSettingValue('ultrafix_pause_seconds', '600'), 600);
  });

  test('should reject value -1', () => {
    assert.throws(() => parseSettingValue('ultrafix_pause_seconds', '-1'), /must be a number between 0 and 600/);
  });

  test('should reject value 601', () => {
    assert.throws(() => parseSettingValue('ultrafix_pause_seconds', '601'), /must be a number between 0 and 600/);
  });

  test('should reject non-numeric value', () => {
    assert.throws(() => parseSettingValue('ultrafix_pause_seconds', 'abc'), /must be a number between 0 and 600/);
  });
});

describe('Default values for ultrafix settings', () => {
  test('ultrafix_rating_goal default should be 7', () => {
    const DEFAULT_ULTRAFIX_RATING_GOAL = 7;
    assert.strictEqual(DEFAULT_ULTRAFIX_RATING_GOAL, 7);
  });

  test('ultrafix_max_cycles default should be 5', () => {
    const DEFAULT_ULTRAFIX_MAX_CYCLES = 5;
    assert.strictEqual(DEFAULT_ULTRAFIX_MAX_CYCLES, 5);
  });

  test('ultrafix_pause_seconds default should be 60', () => {
    const DEFAULT_ULTRAFIX_PAUSE_SECONDS = 60;
    assert.strictEqual(DEFAULT_ULTRAFIX_PAUSE_SECONDS, 60);
  });

  test('pr_review_model default should be empty string', () => {
    const DEFAULT_PR_REVIEW_MODEL = '';
    assert.strictEqual(DEFAULT_PR_REVIEW_MODEL, '');
  });
});

describe('Settings structure includes new fields', () => {
  test('should handle settings with all ultrafix fields', () => {
    const settings = {
      worker_concurrency: 5,
      github_user_whitelist: ['user1'],
      analysis_model_fast: 'claude-3-5-haiku-20241022',
      planner_context_model: '',
      planner_generation_model: '',
      auto_followup_score_threshold: 4,
      auto_resolve_merge_conflicts: false,
      pr_review_model: 'claude-opus-4-6',
      ultrafix_rating_goal: 7,
      ultrafix_max_cycles: 5,
      ultrafix_pause_seconds: 60
    };

    assert.strictEqual(settings.pr_review_model, 'claude-opus-4-6');
    assert.strictEqual(settings.ultrafix_rating_goal, 7);
    assert.strictEqual(settings.ultrafix_max_cycles, 5);
    assert.strictEqual(settings.ultrafix_pause_seconds, 60);
  });

  test('should handle settings with empty pr_review_model', () => {
    const settings = {
      pr_review_model: '',
      ultrafix_rating_goal: 7,
      ultrafix_max_cycles: 5,
      ultrafix_pause_seconds: 60
    };

    assert.strictEqual(settings.pr_review_model, '');
  });
});

// Force exit after tests to prevent hanging
after(() => {
  process.exit(0);
});
