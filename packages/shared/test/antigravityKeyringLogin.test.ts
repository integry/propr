import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
    ANTIGRAVITY_KEYRING_LOGIN_GUIDANCE,
    antigravityLoginFailureReason,
    antigravityMissingLoginReason,
    isAntigravityMissingLoginOutput,
} from '../src/antigravityKeyringLogin.js';

test('the guidance names the keyring, the env var sign-in and the managed login', () => {
    assert.equal(ANTIGRAVITY_KEYRING_LOGIN_GUIDANCE,
        "agy stores its login in the OS keyring on desktops, which ProPR containers can't read. Sign in once with `AGY_CLI_FORCE_FILE_TOKEN_STORAGE=1 agy`, or use ProPR's managed login.");
    assert.equal(antigravityMissingLoginReason(), ANTIGRAVITY_KEYRING_LOGIN_GUIDANCE);
    assert.match(antigravityMissingLoginReason({ keyringMarkerDetected: true }), /^Found ~\/\.config\/antigravity\/credential-user-scope .*AGY_CLI_FORCE_FILE_TOKEN_STORAGE=1 agy/);
});

test('entrypoint and agy missing-login output maps to the actionable reason', () => {
    for (const output of [
        'Warning: no obvious Antigravity authentication files found under /home/node/.gemini',
        "Executing command: agy\nError: authentication required. Run 'agy' to log in, then retry.",
        'authentication required',
    ]) {
        assert.equal(isAntigravityMissingLoginOutput(output), true, output);
        assert.equal(antigravityLoginFailureReason(output), ANTIGRAVITY_KEYRING_LOGIN_GUIDANCE);
    }
    for (const output of ['', undefined, 'AGY_ERROR: {"short_error":"model API failure"}', 'Antigravity authentication-related configuration found', 'the docs mention that authentication required flows exist']) {
        assert.equal(isAntigravityMissingLoginOutput(output), false, String(output));
        assert.equal(antigravityLoginFailureReason(output), undefined);
    }
});
