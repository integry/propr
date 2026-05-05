import { test, describe } from 'node:test';
import assert from 'node:assert';
import { formatSubscriptionUsage } from '../packages/core/src/utils/github/formatSubscriptionUsage.js';

describe('formatSubscriptionUsage', () => {
    // --- Record-first behavior ---

    test('renders subscription usage from records', () => {
        const result = formatSubscriptionUsage({
            records: [
                { agent: 'claude', metricKey: 'Session', metricValue: 16 },
                { agent: 'claude', metricKey: 'Weekly', metricValue: 4 },
            ],
        });
        assert.strictEqual(result, 'Session +16%, Weekly +4%');
    });

    test('prefers records over delta when both are present', () => {
        const result = formatSubscriptionUsage({
            records: [
                { agent: 'claude', metricKey: 'Session', metricValue: 10 },
            ],
            delta: {
                session: { percent: 99 },
            },
            agent: 'claude',
        });
        // Should use records value (10), not delta value (99)
        assert.ok(result.includes('+10%'), 'Should use records value');
        assert.ok(!result.includes('+99%'), 'Should not use delta value');
    });

    test('renders single record', () => {
        const result = formatSubscriptionUsage({
            records: [
                { agent: 'gemini', metricKey: 'Daily', metricValue: 5 },
            ],
        });
        assert.strictEqual(result, 'Daily +5%');
    });

    // --- Delta fallback ---

    test('falls back to delta when records array is empty', () => {
        const result = formatSubscriptionUsage({
            records: [],
            delta: {
                session: { percent: 8 },
                weeklyAll: { percent: 2 },
            },
            agent: 'claude',
        });
        assert.ok(result.includes('Session +8%'), 'Should extract session from delta');
        assert.ok(result.includes('Weekly +2%'), 'Should extract weeklyAll from delta');
    });

    test('falls back to delta when records is undefined', () => {
        const result = formatSubscriptionUsage({
            delta: {
                fiveHour: { percentUsed: 3 },
            },
            agent: 'codex',
        });
        assert.ok(result.includes('Five Hour +3%'), 'Should extract from delta');
    });

    // --- Zero suppression ---

    test('returns empty string when usageMetrics is null', () => {
        assert.strictEqual(formatSubscriptionUsage(null), '');
    });

    test('returns empty string when usageMetrics is undefined', () => {
        assert.strictEqual(formatSubscriptionUsage(undefined), '');
    });

    test('returns empty string when records are all zero', () => {
        const result = formatSubscriptionUsage({
            records: [
                { agent: 'claude', metricKey: 'Session', metricValue: 0 },
                { agent: 'claude', metricKey: 'Weekly', metricValue: 0 },
            ],
        });
        assert.strictEqual(result, '');
    });

    test('returns empty string when delta produces only zero values', () => {
        const result = formatSubscriptionUsage({
            delta: {
                session: { percent: 0 },
            },
            agent: 'claude',
        });
        assert.strictEqual(result, '');
    });

    test('returns empty string when no records and no delta', () => {
        const result = formatSubscriptionUsage({});
        assert.strictEqual(result, '');
    });

    test('filters out zero-value records but keeps non-zero ones', () => {
        const result = formatSubscriptionUsage({
            records: [
                { agent: 'claude', metricKey: 'Session', metricValue: 0 },
                { agent: 'claude', metricKey: 'Weekly', metricValue: 7 },
            ],
        });
        assert.strictEqual(result, 'Weekly +7%');
    });

    // --- Formatting ---

    test('formats fractional values with one decimal place', () => {
        const result = formatSubscriptionUsage({
            records: [
                { agent: 'claude', metricKey: 'Session', metricValue: 2.5 },
            ],
        });
        assert.strictEqual(result, 'Session +2.5%');
    });

    test('formats integer values without decimals', () => {
        const result = formatSubscriptionUsage({
            records: [
                { agent: 'claude', metricKey: 'Session', metricValue: 3 },
            ],
        });
        assert.strictEqual(result, 'Session +3%');
    });

    test('filters out negative values', () => {
        const result = formatSubscriptionUsage({
            records: [
                { agent: 'claude', metricKey: 'Session', metricValue: -5 },
                { agent: 'claude', metricKey: 'Weekly', metricValue: 3 },
            ],
        });
        assert.strictEqual(result, 'Weekly +3%');
    });

    test('aggregates duplicate labels from records', () => {
        const result = formatSubscriptionUsage({
            records: [
                { agent: 'claude', metricKey: 'weeklyAll', metricValue: 2 },
                { agent: 'claude', metricKey: 'Weekly', metricValue: 3 },
            ],
        });
        assert.strictEqual(result, 'Weekly +5%');
    });

    // --- percentLeft legacy delta ---

    test('correctly converts percentLeft-only delta to percent used', () => {
        const result = formatSubscriptionUsage({
            delta: {
                session: { percentLeft: 84 },
            },
            agent: 'claude',
        });
        assert.strictEqual(result, 'Session +16%');
    });

    test('handles percentLeft of 100 (0% used) as empty', () => {
        const result = formatSubscriptionUsage({
            delta: {
                session: { percentLeft: 100 },
            },
            agent: 'claude',
        });
        assert.strictEqual(result, '');
    });

    test('handles percentLeft of 0 (100% used)', () => {
        const result = formatSubscriptionUsage({
            delta: {
                session: { percentLeft: 0 },
            },
            agent: 'claude',
        });
        assert.strictEqual(result, 'Session +100%');
    });

    test('clamps out-of-range percent values from delta', () => {
        const result = formatSubscriptionUsage({
            delta: {
                session: { percent: 140 },
                weeklyAll: { percentLeft: 120 },
            },
            agent: 'claude',
        });
        assert.strictEqual(result, 'Session +100%');
    });

    test('aggregates duplicate labels from delta arrays', () => {
        const result = formatSubscriptionUsage({
            delta: {
                weeklyAll: [
                    { percent: 2 },
                    { percentUsed: 3 },
                ],
            },
            agent: 'claude',
        });
        assert.strictEqual(result, 'Weekly +5%');
    });

    test('uses parent metric key for delta arrays instead of model name', () => {
        const result = formatSubscriptionUsage({
            delta: {
                weeklyAll: [
                    { model: 'claude-3-7-sonnet', percent: 4 },
                ],
            },
            agent: 'claude',
        });
        assert.strictEqual(result, 'Weekly +4%');
    });

    // --- Snake_case field support ---

    test('accepts snake_case usage_metric_records field', () => {
        const result = formatSubscriptionUsage({
            usage_metric_records: [
                { agent: 'claude', metricKey: 'Session', metricValue: 12 },
                { agent: 'claude', metricKey: 'Weekly', metricValue: 3 },
            ],
        } as Record<string, unknown>);
        assert.strictEqual(result, 'Session +12%, Weekly +3%');
    });

    test('accepts snake_case usage_metrics as delta fallback', () => {
        const result = formatSubscriptionUsage({
            usage_metrics: {
                session: { percent: 7 },
            },
            agent: 'claude',
        } as Record<string, unknown>);
        assert.ok(result.includes('Session +7%'), 'Should extract from snake_case delta');
    });

    test('accepts nested snake_case usage_metrics.delta fallback', () => {
        const result = formatSubscriptionUsage({
            usage_metrics: {
                delta: {
                    session: { percent: 7 },
                    weeklyAll: { percent: 2 },
                },
            },
            agent: 'claude',
        } as Record<string, unknown>);
        assert.ok(result.includes('Session +7%'), 'Should extract nested session delta');
        assert.ok(result.includes('Weekly +2%'), 'Should extract nested weeklyAll delta');
    });

    test('prefers usage_metric_records over usage_metrics when both present', () => {
        const result = formatSubscriptionUsage({
            usage_metric_records: [
                { agent: 'claude', metricKey: 'Session', metricValue: 5 },
            ],
            usage_metrics: {
                session: { percent: 99 },
            },
            agent: 'claude',
        } as Record<string, unknown>);
        assert.ok(result.includes('+5%'), 'Should use records value');
        assert.ok(!result.includes('+99%'), 'Should not use delta value');
    });

    test('camelCase records take priority over snake_case usage_metric_records', () => {
        const result = formatSubscriptionUsage({
            records: [
                { agent: 'claude', metricKey: 'Session', metricValue: 20 },
            ],
            usage_metric_records: [
                { agent: 'claude', metricKey: 'Session', metricValue: 99 },
            ],
        } as Record<string, unknown>);
        assert.ok(result.includes('+20%'), 'Should use camelCase records');
        assert.ok(!result.includes('+99%'), 'Should not use snake_case records');
    });
});
