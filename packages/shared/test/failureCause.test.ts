import assert from 'node:assert/strict';
import { test } from 'node:test';
import { describeFailureCause } from '../src/failureCause.js';
import { describeUsageLimitKind, formatTimeUntil } from '../src/usageLimitText.js';

test('provider authentication failures read as one plain sentence without upstream HTML titles (#3523)', () => {
    const cause = describeFailureCause('Agent execution failed: Failed to authenticate. API Error: 403 Attention Required! | Cloudflare');
    assert.equal(cause, 'Provider authentication failed.');
});

test('an agent process that dies after reporting success is an unexpected stop (#3479)', () => {
    assert.equal(
        describeFailureCause('Claude process exited with code 132 after reporting a successful result'),
        'The agent process stopped unexpectedly.',
    );
});

test('unknown failures keep their first line without container paths', () => {
    const cause = describeFailureCause('Error: could not read /usr/src/app/logs/executions/issue-1-conversation.json\n    at stack');
    assert.doesNotMatch(cause, /usr\/src\/app|at stack/);
    assert.match(cause, /^Could not read/);
    assert.match(cause, /\.$/);
});

test('an empty failure still has a cause', () => {
    assert.equal(describeFailureCause(''), 'The run failed without reporting a cause.');
    assert.equal(describeFailureCause(undefined, 'Fallback.'), 'Fallback.');
});

test('ordinary words do not trip the signal pattern', () => {
    assert.doesNotMatch(describeFailureCause('A significant migration step failed'), /stopped unexpectedly/);
});

test('usage-limit text names the limit and an exact remaining time', () => {
    assert.equal(describeUsageLimitKind("You've hit your weekly limit · resets Nov 18, 4pm (UTC)"), 'weekly limit');
    assert.equal(describeUsageLimitKind('Limit reached'), null);
    const now = Date.UTC(2026, 10, 16, 17, 1, 33);
    const reset = Math.floor(Date.UTC(2026, 10, 16, 18, 2, 0) / 1000);
    assert.equal(formatTimeUntil(reset, now), 'in 1 h 1 min');
    // Four minutes later the same reset reads consistently, not "less than an hour".
    assert.equal(formatTimeUntil(reset, now + 4 * 60_000), 'in 57 min');
    assert.equal(formatTimeUntil(reset + 2 * 86_400, now), 'in 2 days 1 h');
});
