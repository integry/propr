import { test } from 'node:test';
import assert from 'node:assert';
import { sanitizeErrorMessage } from '../src/jobs/errorSanitizer.js';

test('sanitizeErrorMessage redacts authenticated GitHub remote URLs before posting errors', () => {
    const message = [
        'Repository integry/propr-routing is corrupted but has active worktrees: error: could not lock config file .git/config: File exists',
        "fatal: could not set 'remote.origin.url' to 'https://x-access-token:ghs_IsZU7NVBbpMggDIqNs1RN0QagmXhQr2cffSD@github.com/integry/propr-routing.git'",
    ].join('\n');

    const sanitized = sanitizeErrorMessage(message);

    assert.ok(!sanitized.includes('ghs_IsZU7NVBbpMggDIqNs1RN0QagmXhQr2cffSD'));
    assert.ok(!sanitized.includes('x-access-token:ghs_'));
    assert.ok(sanitized.includes('https://[REDACTED]@github.com/integry/propr-routing.git'));
});

test('sanitizeErrorMessage redacts standalone GitHub tokens', () => {
    const sanitized = sanitizeErrorMessage('failed with token ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmn');

    assert.ok(!sanitized.includes('ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmn'));
    assert.ok(sanitized.includes('[REDACTED_GITHUB_TOKEN]'));
});
