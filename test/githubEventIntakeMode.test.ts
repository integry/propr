import assert from 'node:assert/strict';
import test from 'node:test';

import {
  resolveGithubEventIntakeMode,
  GITHUB_EVENT_INTAKE_MODES,
} from '../packages/shared/src/githubEventIntakeMode.js';

test('unset GITHUB_EVENT_INTAKE_MODE defaults to routing_websocket', () => {
    const result = resolveGithubEventIntakeMode({});
    assert.equal(result.mode, 'routing_websocket');
    assert.deepEqual(result.warnings, []);
});

test('explicit valid modes resolve to themselves', () => {
    for (const mode of GITHUB_EVENT_INTAKE_MODES) {
        const result = resolveGithubEventIntakeMode({ eventIntakeMode: mode });
        assert.equal(result.mode, mode);
        assert.deepEqual(result.warnings, []);
    }
});

test('explicit mode is matched case-insensitively and trimmed', () => {
    assert.equal(
        resolveGithubEventIntakeMode({ eventIntakeMode: '  Polling ' }).mode,
        'polling',
    );
});

test('invalid explicit mode throws a clear error', () => {
    assert.throws(
        () => resolveGithubEventIntakeMode({ eventIntakeMode: 'bogus' }),
        /GITHUB_EVENT_INTAKE_MODE="bogus" is not a recognized value/,
    );
});

test('ENABLE_GITHUB_WEBHOOKS does not select the mode but warns', () => {
    const result = resolveGithubEventIntakeMode({ enableGithubWebhooks: 'true' });
    assert.equal(result.mode, 'routing_websocket');
    assert.equal(result.warnings.length, 1);
    assert.match(result.warnings[0], /ENABLE_GITHUB_WEBHOOKS is deprecated/);
});

test('legacy boolean warns even when present alongside an explicit mode', () => {
    const result = resolveGithubEventIntakeMode({
        eventIntakeMode: 'direct_webhook',
        enableGithubWebhooks: 'false',
    });
    assert.equal(result.mode, 'direct_webhook');
    assert.equal(result.warnings.length, 1);
    assert.match(result.warnings[0], /deprecated/);
});
