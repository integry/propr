import { after, afterEach, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import knex, { type Knex } from 'knex';

process.env.NODE_ENV = 'test';

const { up } = await import('../packages/core/src/db/migrations/20261017230000_create_agent_tank_usage_history.js');
const {
    AGENT_TANK_HISTORY_RETENTION_MS,
    readLocalAgentTankUsageHistory,
    recordAgentTankUsageHistory,
    resetAgentTankUsageHistoryTracking,
} = await import('../packages/core/src/services/agentTankUsageHistory.js');
const { downsampleHistoryPoints } = await import('../packages/core/src/services/agentTankHistoryService.js');
const { closeConnection } = await import('../packages/core/src/db/connection.js');

const MINUTE = 60_000;
const T0 = Date.parse('2026-10-17T12:00:00.000Z');

let database: Knex;

beforeEach(async () => {
    database = knex({ client: 'better-sqlite3', connection: { filename: ':memory:' }, useNullAsDefault: true });
    await up(database);
    resetAgentTankUsageHistoryTracking();
});

afterEach(async () => {
    await database.destroy();
});

after(async () => {
    await closeConnection();
});

const claude = (session: number, capturedAt: number, extra: Record<string, unknown> = {}) => ({
    claude: {
        name: 'claude',
        usage: { session: { percent: session }, weeklyAll: { percent: 40 } },
        lastUpdated: new Date(capturedAt).toISOString(),
        ...extra,
    },
});

const range = { since: T0 - 60 * MINUTE, until: T0 + 24 * 60 * MINUTE };

test('a snapshot is stored per metric and read back as series', async () => {
    const written = await recordAgentTankUsageHistory(claude(10, T0), { database, now: T0 });
    assert.equal(written, 2);
    await recordAgentTankUsageHistory(claude(25, T0 + MINUTE), { database, now: T0 + MINUTE });

    const history = await readLocalAgentTankUsageHistory(range, database);
    assert.equal(history.length, 1);
    assert.equal(history[0].agent, 'claude');
    const session = history[0].series.find(series => series.key === 'session');
    assert.deepEqual(session, {
        key: 'session', label: 'Current session', model: null, cycle: 'session',
        points: [
            { t: new Date(T0).toISOString(), percent: 10 },
            { t: new Date(T0 + MINUTE).toISOString(), percent: 25 },
        ],
    });
});

test('the same capture, an older one, or an unchanged value inside the heartbeat is not stored again', async () => {
    await recordAgentTankUsageHistory(claude(10, T0), { database, now: T0 });
    assert.equal(await recordAgentTankUsageHistory(claude(10, T0), { database, now: T0 + MINUTE }), 0);
    assert.equal(await recordAgentTankUsageHistory(claude(12, T0 - MINUTE), { database, now: T0 + MINUTE }), 0);
    assert.equal(await recordAgentTankUsageHistory(claude(10, T0 + 5 * MINUTE), { database, now: T0 + 5 * MINUTE }), 0);
    // Past the 10-minute heartbeat an unchanged value anchors the line again.
    assert.equal(await recordAgentTankUsageHistory(claude(10, T0 + 11 * MINUTE), { database, now: T0 + 11 * MINUTE }), 2);
});

test('a changed value is stored at once while its unchanged sibling is not', async () => {
    await recordAgentTankUsageHistory(claude(10, T0), { database, now: T0 });
    const written = await recordAgentTankUsageHistory(claude(11, T0 + MINUTE), { database, now: T0 + MINUTE });
    assert.equal(written, 1);
});

test('a failed read keeps cached usage upstream and is not recorded', async () => {
    const written = await recordAgentTankUsageHistory(claude(10, T0, { error: 'Timeout waiting for usage data' }), { database, now: T0 });
    assert.equal(written, 0);
});

test('a capture time in the future falls back to the observation time', async () => {
    await recordAgentTankUsageHistory(claude(10, T0 + 60 * MINUTE), { database, now: T0 });
    const [row] = await database('agent_tank_usage_history').select('recorded_at_ms');
    assert.equal(Number(row.recorded_at_ms), T0);
});

test('rows older than retention are pruned', async () => {
    await database('agent_tank_usage_history').insert({
        agent: 'claude', metric_key: 'session', metric_label: 'Current session', model: null, cycle: 'session',
        percent_used: 5, recorded_at: new Date(T0 - AGENT_TANK_HISTORY_RETENTION_MS - MINUTE).toISOString(),
        recorded_at_ms: T0 - AGENT_TANK_HISTORY_RETENTION_MS - MINUTE,
    });
    await recordAgentTankUsageHistory(claude(10, T0), { database, now: T0 });
    const rows = await database('agent_tank_usage_history').count({ count: '*' });
    assert.equal(Number(rows[0].count), 2);
});

test('reads filter by agent, metric and time range', async () => {
    await recordAgentTankUsageHistory({
        ...claude(10, T0),
        antigravity: {
            name: 'antigravity',
            usage: { models: [{ model: 'Gemini 4 Argon Weekly Limit', group: 'Gemini 4 Argon', cycle: 'weekly', usageLeft: 70, percentUsed: 30 }] },
            lastUpdated: new Date(T0).toISOString(),
        },
    }, { database, now: T0 });

    const argon = await readLocalAgentTankUsageHistory({ ...range, agents: ['antigravity'] }, database);
    assert.deepEqual(argon.map(entry => entry.agent), ['antigravity']);
    assert.deepEqual(argon[0].series[0], {
        key: 'model:Gemini 4 Argon Weekly Limit', label: 'Gemini 4 Argon Weekly Limit',
        model: 'Gemini 4 Argon', cycle: 'weekly', points: [{ t: new Date(T0).toISOString(), percent: 30 }],
    });

    const weekly = await readLocalAgentTankUsageHistory({ ...range, metric: 'weeklyAll' }, database);
    assert.deepEqual(weekly.map(entry => entry.series.map(series => series.key)), [['weeklyAll']]);

    const before = await readLocalAgentTankUsageHistory({ since: T0 - 120 * MINUTE, until: T0 - MINUTE }, database);
    assert.deepEqual(before, []);
});

test('downsampling keeps the first and last point and at most the cap', () => {
    const points = Array.from({ length: 1000 }, (_, index) => ({ t: new Date(T0 + index * MINUTE).toISOString(), percent: index % 100 }));
    const thinned = downsampleHistoryPoints(points, 50);
    assert.ok(thinned.length <= 50);
    assert.deepEqual(thinned[0], points[0]);
    assert.deepEqual(thinned[thinned.length - 1], points[points.length - 1]);
    assert.deepEqual(downsampleHistoryPoints(points.slice(0, 10), 50), points.slice(0, 10));
});

test('downsampling keeps every recorded extreme, not just the endpoints', () => {
    const points = Array.from({ length: 1200 }, (_, index) => ({
        t: new Date(T0 + index * MINUTE).toISOString(),
        percent: index === 1 ? 100 : index === 700 ? -1 : 0,
    }));
    const thinned = downsampleHistoryPoints(points);
    assert.ok(thinned.length <= 600);
    assert.equal(Math.max(...thinned.map(point => point.percent)), 100);
    assert.equal(Math.min(...thinned.map(point => point.percent)), -1);
    const times = thinned.map(point => Date.parse(point.t));
    assert.deepEqual(times, [...times].sort((a, b) => a - b));

    const sameInstant = points.map(point => ({ ...point, t: points[0].t }));
    const collapsed = downsampleHistoryPoints(sameInstant, 50);
    assert.ok(collapsed.length <= 50);
    assert.equal(Math.max(...collapsed.map(point => point.percent)), 100);
    assert.equal(Math.min(...collapsed.map(point => point.percent)), -1);
});

/** A database whose inserts reject while `failing` is set. */
function flakyDatabase(): { database: Knex; failing: { value: boolean } } {
    const failing = { value: true };
    const wrapped = ((table: string) => {
        const builder = database(table);
        if (!failing.value) return builder;
        return Object.assign(builder, { insert: () => Promise.reject(new Error('database is unavailable')) });
    }) as unknown as Knex;
    return { database: wrapped, failing };
}

test('a failed write leaves the snapshot eligible for the next attempt', async () => {
    const flaky = flakyDatabase();
    assert.equal(await recordAgentTankUsageHistory(claude(10, T0), { database: flaky.database, now: T0 }), 0);

    flaky.failing.value = false;
    // The same cached capture is retried once storage recovers.
    assert.equal(await recordAgentTankUsageHistory(claude(10, T0), { database: flaky.database, now: T0 + MINUTE }), 2);
    assert.equal(await recordAgentTankUsageHistory(claude(10, T0), { database: flaky.database, now: T0 + 2 * MINUTE }), 0);
    const rows = await database('agent_tank_usage_history').count({ count: '*' });
    assert.equal(Number(rows[0].count), 2);
});

test('concurrent attempts are serialized, so a failed one cannot undo a later success', async () => {
    let releaseFirst: () => void = () => {};
    const firstGate = new Promise<void>(resolve => { releaseFirst = resolve; });
    let call = 0;
    const gated = ((table: string) => {
        const builder = database(table);
        return Object.assign(builder, {
            insert: (rows: unknown) => {
                call += 1;
                if (call === 1) return firstGate.then(() => { throw new Error('database is unavailable'); });
                return database(table).insert(rows);
            },
        });
    }) as unknown as Knex;

    const first = recordAgentTankUsageHistory(claude(10, T0), { database: gated, now: T0 });
    const second = recordAgentTankUsageHistory(claude(20, T0 + MINUTE), { database: gated, now: T0 + MINUTE });
    // The second attempt waits for the first instead of reading its uncommitted baselines.
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(call, 1);
    releaseFirst();
    assert.equal(await first, 0);
    assert.equal(await second, 2);

    // The successful, newer capture is the baseline: re-reading it stores nothing.
    assert.equal(await recordAgentTankUsageHistory(claude(20, T0 + MINUTE), { database, now: T0 + 2 * MINUTE }), 0);
    // The failed older capture is not resurrected behind it.
    assert.equal(await recordAgentTankUsageHistory(claude(10, T0), { database, now: T0 + 2 * MINUTE }), 0);
});
