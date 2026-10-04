/**
 * Per-call usage deltas in bundled Agent Tank mode.
 *
 * The real wrapper and transport router use a mocked runner here to exercise
 * snapshot identity and account provenance. Cold caches, long calls, refresh
 * boundaries and timeouts are covered with the real runner in its test suite.
 */

import { beforeEach, mock, test } from 'node:test';
import assert from 'node:assert/strict';

process.env.NODE_ENV = 'test';

await mock.module('../packages/core/src/utils/logger.js', {
    defaultExport: {
        trace: () => {},
        debug: () => {},
        info: () => {},
        warn: () => {},
        error: () => {},
        fatal: () => {},
    },
});

import type { AgentStatusResponse } from '../packages/core/src/services/agentTankTypes.js';

await mock.module('../packages/core/src/config/configManager.js', {
    namedExports: {
        loadAgentTankSettings: async () => ({ mode: 'bundled', enabled: true, url: '' }),
    },
});

/** The runner's cache, as the hot path sees it. */
let cachedSnapshot: Record<string, AgentStatusResponse> | undefined;
let inspectedAlias = 'claude';
let scheduledRefreshes = 0;
let refreshes = 0;

await mock.module('../packages/core/src/services/agentTankBundledRunner.js', {
    namedExports: {
        getBundledStatusesForDelta: () => cachedSnapshot,
        getBundledStatusForAlias: (alias: string) => alias === inspectedAlias ? Object.values(cachedSnapshot ?? {})[0] : undefined,
        refreshBundledStatuses: async () => { refreshes += 1; return cachedSnapshot; },
        scheduleBundledRefresh: () => { scheduledRefreshes += 1; },
    },
});

const { executeWithUsageTracking } =
    await import('../packages/core/src/agents/impl/utils/usageTrackingWrapper.js');

function snapshot(sessionPercent: number, weeklyPercent: number, lastUpdated: string): AgentStatusResponse {
    return {
        name: 'claude',
        usage: {
            session: { percent: sessionPercent, resetsInSeconds: 764 },
            weeklyAll: { percent: weeklyPercent, resetsInSeconds: 364364 },
        },
        lastUpdated,
    };
}

/**
 * A call long enough for the pre-call probe to settle before it returns.
 *
 * The wrapper drops the measurement when the pre-call snapshot is still pending,
 * so without this the "no delta" assertions would pass for the wrong reason.
 */
async function shortCall<T>(value: T, onCall?: () => void): Promise<T> {
    await new Promise(resolve => setTimeout(resolve, 20));
    onCall?.();
    return value;
}

beforeEach(() => {
    cachedSnapshot = undefined;
    inspectedAlias = 'claude';
    scheduledRefreshes = 0;
    refreshes = 0;
});

test('a call that sees the same cached snapshot twice records no usage delta', async () => {
    cachedSnapshot = { claude: snapshot(42, 31, '2026-09-27T12:00:00.000Z') };

    const { result, usageMetrics } = await executeWithUsageTracking('claude', () => shortCall('llm-output'));

    assert.equal(result, 'llm-output');
    // Not `{ delta: { session: { percent: 0 } } }`: a snapshot subtracted from
    // itself would claim this call consumed nothing.
    assert.equal(usageMetrics, null);
    // Both phases await the runner; neither merely schedules a refresh.
    assert.equal(scheduledRefreshes, 0);
    assert.equal(refreshes, 2);
});

test('a snapshot refreshed during the call records the delta it actually measured', async () => {
    // Same timing as the previous test, so a recorded delta here proves the
    // pre-call probe had settled and the omission above was the same-snapshot
    // rule rather than a still-pending read.
    cachedSnapshot = { claude: snapshot(42, 31, '2026-09-27T12:00:00.000Z') };

    const { usageMetrics } = await executeWithUsageTracking('claude', () => shortCall('llm-output', () => {
        cachedSnapshot = { claude: snapshot(58, 35, '2026-09-27T12:03:00.000Z') };
    }));

    assert.ok(usageMetrics, 'a moved snapshot is a real measurement and must be recorded');
    assert.deepEqual(usageMetrics.delta, {
        session: { percent: 16, resetsInSeconds: 0 },
        weeklyAll: { percent: 4, resetsInSeconds: 0 },
    });
    assert.deepEqual(usageMetrics.records, [
        { agent: 'claude', metricKey: 'Session', metricValue: 16 },
        { agent: 'claude', metricKey: 'Weekly', metricValue: 4 },
    ]);
});

test('an unchanged snapshot is omitted even when the timestamp is missing entirely', async () => {
    // Agent Tank does not promise a `lastUpdated` for every provider, and the
    // bundled parser keeps it undefined when it is absent. Two identical reads
    // are still one snapshot, so there is still nothing to record.
    cachedSnapshot = { claude: { name: 'claude', usage: { session: { percent: 42 } } } };

    const { usageMetrics } = await executeWithUsageTracking('claude', () => shortCall('llm-output'));

    assert.equal(usageMetrics, null);
});

test('a daemon that reports new numbers under an unchanged timestamp is still a measurement', async () => {
    cachedSnapshot = { claude: snapshot(42, 31, '2026-09-27T12:00:00.000Z') };

    const { usageMetrics } = await executeWithUsageTracking('claude', () => shortCall('llm-output', () => {
        cachedSnapshot = { claude: snapshot(49, 31, '2026-09-27T12:00:00.000Z') };
    }));

    assert.equal((usageMetrics?.delta.session as { percent: number }).percent, 7);
});

test('an unsuccessful bundled refresh records nothing and still returns the LLM result', async () => {
    cachedSnapshot = undefined;

    const { result, usageMetrics } = await executeWithUsageTracking('claude', () => shortCall('llm-output'));

    assert.equal(result, 'llm-output');
    assert.equal(usageMetrics, null);
    assert.equal(refreshes, 1);
});

for (const provider of ['claude', 'codex', 'antigravity']) {
    test(`${provider} omits another account's refreshed usage`, async () => {
        inspectedAlias = `${provider}-primary`;
        cachedSnapshot = { [provider]: snapshot(42, 31, '2026-09-27T12:00:00.000Z') };
        const { result, usageMetrics } = await executeWithUsageTracking(provider, () => shortCall('output', () => {
            cachedSnapshot = { [provider]: snapshot(58, 35, '2026-09-27T12:03:00.000Z') };
        }), undefined, `${provider}-secondary`);
        assert.equal(result, 'output');
        assert.equal(usageMetrics, null);
        assert.equal(refreshes, 1);
    });

    test(`${provider} records usage for its inspected custom alias`, async () => {
        inspectedAlias = `${provider}-primary`;
        cachedSnapshot = { [provider]: snapshot(42, 31, '2026-09-27T12:00:00.000Z') };
        const { usageMetrics } = await executeWithUsageTracking(provider, () => shortCall('output', () => {
            cachedSnapshot = { [provider]: snapshot(58, 35, '2026-09-27T12:03:00.000Z') };
        }), undefined, inspectedAlias);
        assert.ok(usageMetrics);
        assert.deepEqual(usageMetrics.records, [
            { agent: provider, metricKey: 'Session', metricValue: 16 },
            { agent: provider, metricKey: 'Weekly', metricValue: 4 },
        ]);
    });
}

test('post-call provenance is checked again after execution yields', async () => {
    inspectedAlias = 'claude-primary';
    cachedSnapshot = { claude: snapshot(42, 31, '2026-09-27T12:00:00.000Z') };
    const { usageMetrics } = await executeWithUsageTracking('claude', () => shortCall('output', () => {
        // A refresh during execution inspected the other configured account.
        inspectedAlias = 'claude-secondary';
        cachedSnapshot = { claude: snapshot(58, 35, '2026-09-27T12:03:00.000Z') };
    }), undefined, 'claude-primary');
    assert.equal(usageMetrics, null);
});
