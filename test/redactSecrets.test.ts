import { test } from 'node:test';
import assert from 'node:assert';
import { redactSecrets, redactObject } from '../packages/core/src/utils/github/logFiles.js';

test('redactSecrets replaces GitHub personal access tokens', () => {
    const input = 'token is ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmn';
    const result = redactSecrets(input);
    assert.ok(!result.includes('ghp_'));
    assert.ok(result.includes('[REDACTED_GITHUB_TOKEN]'));
});

test('redactSecrets replaces GitHub fine-grained tokens', () => {
    const input = 'github_pat_ABCDEFGHIJKLMNOPQRSTUV1234567890';
    const result = redactSecrets(input);
    assert.ok(!result.includes('github_pat_'));
    assert.ok(result.includes('[REDACTED_GITHUB_TOKEN]'));
});

test('redactSecrets replaces AWS access keys', () => {
    const input = 'key is AKIAIOSFODNN7EXAMPLE';
    const result = redactSecrets(input);
    assert.ok(!result.includes('AKIAIOSFODNN7EXAMPLE'));
    assert.ok(result.includes('[REDACTED_AWS_ACCESS_KEY]'));
});

test('redactSecrets replaces Bearer tokens', () => {
    const input = 'Authorization: Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U';
    const result = redactSecrets(input);
    assert.ok(!result.includes('eyJhbGciOiJ'));
    assert.ok(result.includes('Bearer [REDACTED_BEARER_TOKEN]'));
});

test('redactSecrets leaves normal text unchanged', () => {
    const input = 'This is a normal log message with no secrets';
    assert.strictEqual(redactSecrets(input), input);
});

test('redactSecrets handles multiple secrets in one string', () => {
    const input = 'token1=ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmn key=AKIAIOSFODNN7EXAMPLE';
    const result = redactSecrets(input);
    assert.ok(result.includes('[REDACTED_GITHUB_TOKEN]'));
    assert.ok(result.includes('[REDACTED_AWS_ACCESS_KEY]'));
});

test('redactObject redacts strings within nested objects', () => {
    const input = {
        message: {
            content: [{ text: 'Found token ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmn in env' }]
        }
    };
    const result = redactObject(input);
    assert.ok(!JSON.stringify(result).includes('ghp_'));
    assert.ok(JSON.stringify(result).includes('[REDACTED_GITHUB_TOKEN]'));
});

test('redactObject handles arrays', () => {
    const input = [
        { text: 'ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmn' },
        { text: 'safe text' }
    ];
    const result = redactObject(input);
    assert.ok(!JSON.stringify(result).includes('ghp_'));
    assert.strictEqual(result[1].text, 'safe text');
});

test('redactObject preserves non-string values', () => {
    const input = { count: 42, flag: true, data: null };
    const result = redactObject(input);
    assert.deepStrictEqual(result, input);
});
