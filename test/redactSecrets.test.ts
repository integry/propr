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

test('redactSecrets replaces OpenRouter API keys', () => {
    const input = 'key is sk-or-v1-' + 'a'.repeat(64);
    const result = redactSecrets(input);
    assert.ok(!result.includes('sk-or-v1-'));
    assert.ok(result.includes('[REDACTED_OPENROUTER_KEY]'));
});

test('redactSecrets replaces Stripe secret keys', () => {
    const input = 'sk_live_' + 'a'.repeat(24);
    const result = redactSecrets(input);
    assert.ok(!result.includes('sk_live_'));
    assert.ok(result.includes('[REDACTED_STRIPE_SECRET_KEY]'));
});

test('redactSecrets replaces Anthropic API keys', () => {
    const input = 'sk-ant-' + 'a'.repeat(32);
    const result = redactSecrets(input);
    assert.ok(!result.includes('sk-ant-'));
    assert.ok(result.includes('[REDACTED_ANTHROPIC_KEY]'));
});

test('redactSecrets replaces Slack tokens', () => {
    const input = 'xoxb-1234567890-abcdefghij';
    const result = redactSecrets(input);
    assert.ok(!result.includes('xoxb-'));
    assert.ok(result.includes('[REDACTED_SLACK_TOKEN]'));
});

test('redactSecrets replaces AWS temporary access keys (ASIA prefix)', () => {
    const input = 'key is ASIAIOSTEMPKEY7EXAMP';
    const result = redactSecrets(input);
    assert.ok(!result.includes('ASIAIOSTEMPKEY7EXAMP'));
    assert.ok(result.includes('[REDACTED_AWS_ACCESS_KEY]'));
});

test('redactSecrets replaces AWS secret access keys', () => {
    const input = 'aws_secret_access_key = wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY1';
    const result = redactSecrets(input);
    assert.ok(!result.includes('wJalrXUtnFEMI'));
    assert.ok(result.includes('[REDACTED_AWS_SECRET_KEY]'));
});

test('redactSecrets replaces generic secret assignment patterns', () => {
    const input = 'SECRET_KEY="abcdefghijklmnopqrstuvwxyz1234"';
    const result = redactSecrets(input);
    assert.ok(!result.includes('abcdefghijklmnopqrstuvwxyz1234'));
    assert.ok(result.includes('[REDACTED_SECRET]'));
});

test('redactSecrets replaces generic API_KEY assignment patterns', () => {
    const input = "API_KEY='someLongSecretValue12345678'";
    const result = redactSecrets(input);
    assert.ok(!result.includes('someLongSecretValue12345678'));
    assert.ok(result.includes('[REDACTED_SECRET]'));
});

test('redactObject redacts secrets in conversation log structure used by createLogFiles', () => {
    const conversationLog = [
        {
            type: 'assistant',
            message: {
                content: [{ text: 'I found the token ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmn in the config' }]
            }
        },
        {
            type: 'assistant',
            message: {
                content: [{ text: 'The AWS key is AKIAIOSFODNN7EXAMPLE' }]
            }
        }
    ];
    const redacted = redactObject(conversationLog);
    const serialized = JSON.stringify(redacted);
    assert.ok(!serialized.includes('ghp_'), 'GitHub token should be redacted');
    assert.ok(!serialized.includes('AKIAIOSFODNN7EXAMPLE'), 'AWS key should be redacted');
    assert.ok(serialized.includes('[REDACTED_GITHUB_TOKEN]'));
    assert.ok(serialized.includes('[REDACTED_AWS_ACCESS_KEY]'));
});
