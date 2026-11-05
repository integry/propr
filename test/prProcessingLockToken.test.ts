import assert from 'node:assert/strict';
import test from 'node:test';
import { startPRProcessingLockHeartbeat } from '../src/jobs/prProcessingLock.js';
import { setTimeout as delay } from 'node:timers/promises';
import { ensurePRProcessingLockToken } from '../src/jobs/prProcessingLock.js';

test('creates and persists a PR processing lock token when one is missing', async () => {
    const data: { prProcessingLockToken?: string } = {};
    let persistedToken: string | undefined;

    const token = await ensurePRProcessingLockToken(data, 'correlation-id', async () => {
        persistedToken = data.prProcessingLockToken;
    });

    assert.match(token, /^correlation-id:[0-9a-f-]{36}$/);
    assert.equal(data.prProcessingLockToken, token);
    assert.equal(persistedToken, token);
});

test('reuses a persisted PR processing lock token without writing again', async () => {
    const data = { prProcessingLockToken: 'existing-token' };
    let persistCalls = 0;

    const token = await ensurePRProcessingLockToken(data, 'correlation-id', async () => {
        persistCalls += 1;
    });

    assert.equal(token, 'existing-token');
    assert.equal(persistCalls, 0);
});

test('heartbeat stop is idempotent and drains an awaited renewal', async () => {
    let finish!: (value: number) => void;
    let began!: () => void;
    const started = new Promise<void>(resolve => { began = resolve; });
    let renewals = 0;
    const stop = startPRProcessingLockHeartbeat({
        redisClient: { set: async () => 'OK', eval: async () => {
            renewals++; began();
            return new Promise<number>(resolve => { finish = resolve; });
        } } as never,
        lockKey: 'pr', lockToken: 'owner', intervalMs: 1,
    });
    await Promise.race([started, delay(1000).then(() => { throw new Error('renewal never started'); })]);
    let drained = false;
    const stopping = stop().then(() => { drained = true; });
    await delay(5);
    assert.equal(drained, false);
    finish(1);
    await stopping;
    await stop();
    await delay(5);
    assert.equal(renewals, 1);
});
