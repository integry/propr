import assert from 'node:assert/strict';
import { test } from 'node:test';
import { redact } from '../mcp/adapter.js';

/** Keys/values the MCP result redaction must return unchanged. */
const KEPT: Array<[string, unknown]> = [
  ['input_tokens', 1200],
  ['output_tokens', 0],
  ['cache_creation_input_tokens', null],
  ['cache_read_input_tokens', 400],
  ['tokens', 42],
  ['total_tokens', 1.5e6],
  ['token_outlier_multiplier', 4.5],
  ['token_outlier_min_tokens', 500000],
  ['token_outlier_baseline_runs', 20],
  ['token_outlier_pause_alerts', 0],
  ['token_outlier_pause_window_hours', 24],
  ['pr_review_max_context_tokens', 12000],
  ['tokenBudgetEnabled', true],
  ['has_token', false],
  ['tokens', { input: 10, output: 2, cache: { read: null, write: 3 } }],
  ['token_counts', [1, 2, 3]],
];

/** Keys/values the MCP result redaction must drop. */
const REMOVED: Array<[string, unknown]> = [
  ['token', 'ghp_abcdefghijklmnop'],
  ['accessToken', 'opaque-value'],
  ['access_token', 'opaque-value'],
  ['bearerToken', 'opaque-value'],
  ['instance_token', 'opaque-value'],
  ['refreshToken', 'opaque-value'],
  ['tokenHash', 'a1b2c3'],
  ['token_hash', ''],
  ['input_tokens', '1200'],
  ['tokens', '{"input":10}'],
  ['tokens', { input: 10, raw: 'opaque-value' }],
  ['token_counts', [1, 'opaque-value']],
  ['tokens', { nested: [{ deeper: 'opaque-value' }] }],
  // Every other key class is removed whatever the value type.
  ['client_secret', 'opaque-value'],
  ['secret_count', 3],
  ['password', 'opaque-value'],
  ['password_set', true],
  ['credentials', { user: 'x' }],
  ['private_key', 'opaque-value'],
  ['apiKey', 'opaque-value'],
  ['api_key_configured', false],
  ['access_key_id', 'opaque-value'],
  ['cookie', 'opaque-value'],
  ['authorization', 'opaque-value'],
  ['worktree_path', '/tmp/w'],
  ['stored_path', '/tmp/s'],
  ['job_data', { a: 1 }],
  ['container_env', ['A=1']],
];

const wrappers: Array<[string, (entry: Record<string, unknown>) => unknown, (redacted: unknown) => unknown]> = [
  ['top level', entry => entry, out => out],
  ['nested object', entry => ({ outer: { inner: entry } }), out => (out as { outer: { inner: unknown } }).outer.inner],
  ['array item', entry => ({ rows: [entry] }), out => (out as { rows: unknown[] }).rows[0]],
  ['JSON-encoded string', entry => JSON.stringify({ outer: entry }), out => (JSON.parse(out as string) as { outer: unknown }).outer],
  ['JSON-encoded string inside an object', entry => ({ payload: JSON.stringify([entry]) }), out => (JSON.parse((out as { payload: string }).payload) as unknown[])[0]],
];

for (const [where, wrap, unwrap] of wrappers) {
  test(`token counts and token-threshold settings are returned (${where})`, () => {
    for (const [key, value] of KEPT) {
      const entry = { [key]: value, sibling: 1 };
      assert.deepEqual(unwrap(redact(wrap(entry))), entry, `${key}: ${JSON.stringify(value)}`);
    }
  });

  test(`credential-shaped values and other sensitive key classes are removed (${where})`, () => {
    for (const [key, value] of REMOVED) {
      assert.deepEqual(unwrap(redact(wrap({ [key]: value, sibling: 1 }))), { sibling: 1 }, `${key}: ${JSON.stringify(value)}`);
    }
  });
}

test('a token key holding bytes or another non-plain object is removed', () => {
  for (const value of [Buffer.from('ghp_abcdefghijklmnop'), new Uint8Array([1, 2]), new Date(0)]) {
    assert.deepEqual(redact({ token: value, sibling: 1 }), { sibling: 1 });
  }
});

test('kept token containers are still redacted inside', () => {
  assert.deepEqual(redact({ tokens: { input: 1, credentials: 5 } }), { tokens: { input: 1 } });
});
