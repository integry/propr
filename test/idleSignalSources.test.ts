import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { closeConnection, collectIdleSignals, evaluateIdle } from '@propr/core';
import { createDaemonIdleSources } from '../src/daemon/idleSignalSources.js';

const MINUTE = 60_000;

after(async () => { await closeConnection(); });

function pollingSources(intakeMode: string) {
    const sources = createDaemonIdleSources({
        redis: {} as never,
        database: {} as never,
        intakeMode,
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
