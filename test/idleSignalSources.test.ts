import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { IDLE_PARTICIPANTS_REDIS_KEY } from '@propr/shared';
import { closeConnection, collectIdleSignals, evaluateIdle, registerIdleParticipant } from '@propr/core';
import { createDaemonIdleSources } from '../src/daemon/idleSignalSources.js';

const MINUTE = 60_000;

after(async () => { await closeConnection(); });

function pollingSources(intakeMode: string) {
    const sources = createDaemonIdleSources({
        redis: {} as never,
        database: {} as never,
        intakeMode,
        composed: true,
        connectInFlight: () => 0,
    });
    return { polling: sources.polling };
}

test('polling intake with an interval longer than the idle window still blocks idle shutdown', async () => {
    // POLLING_INTERVAL_MS=3600000 with PROPR_IDLE_SHUTDOWN_AFTER=15m: the real next poll is the
    // startup timer's, so no deadline derived from the observation time may let the window expire.
    const signals = await collectIdleSignals(pollingSources('polling'));
    for (const elapsed of [0, 15 * MINUTE, 45 * MINUTE]) {
        const evaluation = evaluateIdle(signals, { now: Date.now() + elapsed, windowMs: 15 * MINUTE });
        assert.equal(evaluation.idle, false);
        assert.equal(evaluation.blockers[0].signal, 'scheduled_work');
        assert.equal(evaluation.nextDueAt, null, 'no invented poll deadline for the wake hint');
    }
});

test('other intake modes are not blocked by polling', async () => {
    const signals = await collectIdleSignals(pollingSources('routing_websocket'));
    assert.equal(evaluateIdle(signals, { now: Date.now(), windowMs: 15 * MINUTE }).idle, true);
});

/** The participant registry in Redis. */
function registryRedis() {
    const entries = new Map<string, string>();
    return {
        entries,
        hset: async (_key: string, field: string, value: string) => { entries.set(field, value); return 1; },
        hdel: async (_key: string, field: string) => (entries.delete(field) ? 1 : 0),
        hgetall: async (key: string) => (key === IDLE_PARTICIPANTS_REDIS_KEY ? Object.fromEntries(entries) : {}),
    };
}

async function separateProcessBlockers(redis: ReturnType<typeof registryRedis>, composed: boolean) {
    const { 'process registrations': registrations } = createDaemonIdleSources({ redis: redis as never, database: {} as never, intakeMode: 'routing_websocket', composed, connectInFlight: () => 0 });
    const evaluation = evaluateIdle(await collectIdleSignals({ registrations }), { now: Date.now(), windowMs: 15 * MINUTE });
    return evaluation.blockers.filter(blocker => blocker.signal === 'separate_processes').map(blocker => blocker.detail);
}

test('a standalone daemon never stops idle: processes it stopped would not start again if the stop were called off', async () => {
    assert.deepEqual(await separateProcessBlockers(registryRedis(), false), [
        'the daemon runs as its own process: idle shutdown needs the single-process control plane (propr all-in-one)',
    ]);
});

test('in the all-in-one process, only a process registered outside it blocks idle shutdown', async () => {
    const redis = registryRedis();
    const local = ['api', 'worker'].map(role => registerIdleParticipant(redis, { role: role as 'api' | 'worker', id: `${role}-here`, intervalMs: 60_000 }));
    await new Promise(resolve => setTimeout(resolve, 10));
    assert.deepEqual(await separateProcessBlockers(redis, true), [], 'its own API and worker exit with it');

    // A separately run indexing worker (PROPR_INDEXING=separate), with a live heartbeat.
    const startedAt = Date.now() - 60_000;
    redis.entries.set('indexing_worker:indexer:7', JSON.stringify({ role: 'indexing_worker', id: 'indexer:7', host: 'indexer', pid: 7, pidNamespace: null, bootId: null, startedAt, seenAt: Date.now() }));
    // Another process that wrote over one of this process's keys.
    const [api] = local;
    redis.entries.set(api.key, JSON.stringify({ ...api.participant, startedAt: api.participant.startedAt - 1, seenAt: Date.now() }));
    assert.deepEqual(await separateProcessBlockers(redis, true), [
        'api:api-here runs outside the all-in-one process',
        'indexing_worker:indexer:7 runs outside the all-in-one process',
    ]);
    await Promise.all(local.map(registration => registration.stop()));
});
