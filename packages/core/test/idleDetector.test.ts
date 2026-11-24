import assert from 'node:assert/strict';
import test from 'node:test';
import {
    DEFAULT_IDLE_SHUTDOWN_AFTER_MS,
    formatIdleShutdownDuration,
    isIdleShutdownEnvironmentManaged,
    parseIdleShutdownDuration,
    parseIdleShutdownSwitch,
    resolveIdleShutdownConfig,
} from '@propr/shared';
import { IdleClock, emptyIdleSignals, evaluateIdle, type IdleSignals } from '../src/idle/idleDetector.js';
import { IdleActivityTracker, parseIdleActivity } from '../src/idle/idleActivity.js';

const NOW = Date.UTC(2026, 10, 24, 12, 0, 0);
const WINDOW = 15 * 60_000;

function signals(overrides: Partial<IdleSignals> = {}): IdleSignals {
    return { ...emptyIdleSignals(), ...overrides };
}

function evaluate(overrides: Partial<IdleSignals> = {}) {
    return evaluateIdle(signals(overrides), { now: NOW, windowMs: WINDOW });
}

test('no signals is idle', () => {
    const result = evaluate();
    assert.equal(result.idle, true);
    assert.deepEqual(result.blockers, []);
    assert.equal(result.nextDueAt, null);
});

const queue = (counts: Partial<IdleSignals['queues'][number]>) => ({
    name: 'github-issue-processor', waiting: 0, active: 0, prioritized: 0, waitingChildren: 0, paused: 0, ...counts,
});

for (const [label, counts] of [
    ['waiting', { waiting: 1 }],
    ['active', { active: 2 }],
    ['prioritized', { prioritized: 1 }],
    ['paused', { paused: 1 }],
    ['waiting-children', { waitingChildren: 1 }],
] as const) {
    test(`a ${label} BullMQ job in any queue blocks idle`, () => {
        const result = evaluate({ queues: [queue({ name: 'empty' }), queue({ name: 'agent-runtime-build', ...counts })] });
        assert.equal(result.idle, false);
        assert.equal(result.blockers.length, 1);
        assert.equal(result.blockers[0].signal, 'queue_jobs');
        assert.match(result.blockers[0].detail, /^agent-runtime-build: /);
    });
}

test('empty queues do not block idle', () => {
    assert.equal(evaluate({ queues: [queue({}), queue({ name: 'indexing-processor' })] }).idle, true);
});

for (const [field, signal, pattern] of [
    ['activeAgentRuns', 'agent_runs', /1 active agent run$/],
    ['uiSessions', 'ui_sessions', /open Web UI session/],
    ['mcpRequests', 'mcp_requests', /in-flight MCP request/],
    ['httpRequests', 'http_requests', /in-flight HTTP request/],
    ['followupHandoffs', 'followup_handoffs', /pending follow-up handoff/],
    ['connectDeliveries', 'connect_deliveries', /Connect delivery being processed/],
    ['runningGoals', 'goals', /running goal/],
    ['ultrafixLoops', 'ultrafix_loops', /Ultrafix loop waiting/],
] as const) {
    test(`${field} blocks idle`, () => {
        const result = evaluate({ [field]: 1 });
        assert.equal(result.idle, false);
        assert.deepEqual(result.blockers.map(blocker => blocker.signal), [signal]);
        assert.match(result.blockers[0].detail, pattern);
    });
}

test('an unreadable signal blocks idle (fail safe)', () => {
    const result = evaluate({ unavailable: ['BullMQ queues'] });
    assert.equal(result.idle, false);
    assert.deepEqual(result.blockers, [{ signal: 'unavailable', detail: 'could not read BullMQ queues' }]);
});

test('scheduled work due within the window blocks idle; later work becomes the wake hint', () => {
    const soon = { kind: 'automation' as const, dueAt: NOW + WINDOW - 1, detail: 'scheduled automation' };
    const later = { kind: 'delayed_job' as const, dueAt: NOW + WINDOW + 60_000, detail: 'delayed job in github-issue-processor' };
    const blocked = evaluate({ scheduled: [later, soon] });
    assert.equal(blocked.idle, false);
    assert.equal(blocked.blockers[0].signal, 'scheduled_work');
    assert.match(blocked.blockers[0].detail, /scheduled automation \(due in \d+s\)/);
    assert.equal(blocked.nextDueAt, soon.dueAt);

    const idle = evaluate({ scheduled: [later] });
    assert.equal(idle.idle, true);
    assert.equal(idle.nextDueAt, later.dueAt);
    assert.deepEqual(idle.nextDue, [later]);
});

test('overdue scheduled work is reported as due now', () => {
    const result = evaluate({ scheduled: [{ kind: 'ultrafix_retry', dueAt: NOW - 1000, detail: 'Ultrafix retry for a/b#1' }] });
    assert.equal(result.idle, false);
    assert.match(result.blockers[0].detail, /due now/);
});

test('polling intake always blocks, whatever its interval, and reports no deadline', () => {
    const result = evaluate({ pollingIntake: true });
    assert.equal(result.idle, false);
    assert.equal(result.blockers[0].signal, 'scheduled_work');
    assert.match(result.blockers[0].detail, /polling/);
    assert.equal(result.nextDueAt, null, 'no observation-time deadline that could drift past the real next poll');
});

test('IdleClock requires continuous idleness and resets on activity', () => {
    const clock = new IdleClock(NOW);
    assert.equal(clock.observe(true, NOW), NOW);
    assert.equal(clock.isDue(NOW + WINDOW - 1, WINDOW), false);
    assert.equal(clock.isDue(NOW + WINDOW, WINDOW), true);
    assert.equal(clock.observe(false, NOW + 1000), null);
    assert.equal(clock.isDue(NOW + 2 * WINDOW, WINDOW), false);
    assert.equal(clock.observe(true, NOW + 5000), NOW + 5000);
});

test('IdleClock moves the start forward to the last request', () => {
    const clock = new IdleClock(NOW);
    clock.observe(true, NOW);
    assert.equal(clock.observe(true, NOW + 60_000, NOW + 30_000), NOW + 30_000);
    // An older request never moves it back.
    assert.equal(clock.observe(true, NOW + 90_000, NOW + 10_000), NOW + 30_000);
});

test('IdleClock does not count time before the process started', () => {
    const clock = new IdleClock(NOW);
    assert.equal(clock.observe(true, NOW + 1000, NOW - 60_000), NOW + 1000);
});

test('idle window parsing accepts units and bare minutes within 1m..24h', () => {
    assert.equal(parseIdleShutdownDuration('15m'), 15 * 60_000);
    assert.equal(parseIdleShutdownDuration('1h30m'), 90 * 60_000);
    assert.equal(parseIdleShutdownDuration('1h 30m'), 90 * 60_000);
    assert.equal(parseIdleShutdownDuration('90s'), 90_000);
    assert.equal(parseIdleShutdownDuration('20'), 20 * 60_000);
    assert.equal(parseIdleShutdownDuration('24h'), 24 * 3_600_000);
    for (const invalid of ['30s', '25h', '15x', 'm', '', '1.5h', '-5m', 'abc15m']) {
        assert.equal(parseIdleShutdownDuration(invalid), null, invalid);
    }
    assert.equal(formatIdleShutdownDuration(90 * 60_000), '1h30m');
    assert.equal(formatIdleShutdownDuration(15 * 60_000), '15m');
});

test('the switch accepts on/off spellings only', () => {
    assert.equal(parseIdleShutdownSwitch('on'), true);
    assert.equal(parseIdleShutdownSwitch('OFF'), false);
    assert.equal(parseIdleShutdownSwitch('maybe'), null);
});

test('idle shutdown is off by default', () => {
    assert.deepEqual(resolveIdleShutdownConfig({}), { enabled: false, afterMs: DEFAULT_IDLE_SHUTDOWN_AFTER_MS, source: 'default', warnings: [] });
});

test('the instance setting applies unless the environment pins it', () => {
    const stored = { enabled: true, afterMs: 30 * 60_000 };
    assert.deepEqual(resolveIdleShutdownConfig({}, stored), { enabled: true, afterMs: 30 * 60_000, source: 'settings', warnings: [] });
    const pinned = resolveIdleShutdownConfig({ PROPR_IDLE_SHUTDOWN: 'off' }, stored);
    assert.equal(pinned.enabled, false);
    assert.equal(pinned.source, 'environment');
    assert.equal(isIdleShutdownEnvironmentManaged({ PROPR_IDLE_SHUTDOWN_AFTER: '5m' }), true);
    assert.equal(isIdleShutdownEnvironmentManaged({ PROPR_IDLE_SHUTDOWN: ' ' }), false);
});

test('an invalid environment value never turns idle shutdown on', () => {
    const config = resolveIdleShutdownConfig({ PROPR_IDLE_SHUTDOWN: 'yes please', PROPR_IDLE_SHUTDOWN_AFTER: '5 minutes' }, { enabled: true, afterMs: 60_000 });
    assert.equal(config.enabled, false);
    assert.equal(config.afterMs, 60_000);
    assert.equal(config.warnings.length, 2);
});

test('the activity tracker counts requests until they end, once', () => {
    const tracker = new IdleActivityTracker();
    let notified = 0;
    tracker.onChange(() => { notified += 1; });
    tracker.setSessionCounter(() => 3);
    const endMcp = tracker.begin('mcp');
    const endHttp = tracker.begin('http');
    assert.equal(notified, 1);
    assert.deepEqual({ ...tracker.snapshot(NOW), lastRequestAt: 0 }, { uiSessions: 3, mcpRequests: 1, httpRequests: 1, lastRequestAt: 0, publishedAt: NOW });
    endMcp();
    endMcp();
    endHttp();
    const snapshot = tracker.snapshot(NOW);
    assert.equal(snapshot.mcpRequests, 0);
    assert.equal(snapshot.httpRequests, 0);
    assert.ok(snapshot.lastRequestAt > 0);
});

test('published activity is parsed defensively', () => {
    assert.equal(parseIdleActivity(null), null);
    assert.equal(parseIdleActivity('not json'), null);
    // A record with a missing or invalid field is malformed, not "zero activity".
    assert.equal(parseIdleActivity('{"uiSessions":2,"mcpRequests":-1,"httpRequests":"3"}'), null);
    assert.equal(parseIdleActivity('{"uiSessions":2,"mcpRequests":0,"httpRequests":0,"lastRequestAt":0}'), null);
    assert.equal(parseIdleActivity('null'), null);
    assert.deepEqual(parseIdleActivity('{"uiSessions":2.5,"mcpRequests":0,"httpRequests":1,"lastRequestAt":5,"publishedAt":9}'), {
        uiSessions: 2, mcpRequests: 0, httpRequests: 1, lastRequestAt: 5, publishedAt: 9,
    });
});
