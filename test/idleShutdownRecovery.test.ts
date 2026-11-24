import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

const directory = await mkdtemp(path.join(tmpdir(), 'idle-recovery-'));
const hintFile = path.join(directory, 'idle-wake-hint.json');
process.env.PROPR_IDLE_WAKE_HINT_FILE = hintFile;

const {
    RoutingWebSocketIntakeService,
    buildIdleWakeHint,
    closeConnection,
    readIdleWakeHint,
    writeIdleWakeHint,
} = await import('@propr/core');
const { recoverFromIdleWake } = await import('../src/daemon/idleShutdown.js');
const { IDLE_LAST_WAKE_REDIS_KEY, IDLE_WAKE_SIGNAL_REDIS_KEY } = await import('@propr/shared');

after(async () => {
    await closeConnection();
    await rm(directory, { recursive: true, force: true });
});

class FakeRedis {
    values = new Map<string, string>();
    async get(key: string) { return this.values.get(key) ?? null; }
    async set(key: string, value: string) { this.values.set(key, value); return 'OK'; }
    async del(key: string) { this.values.delete(key); return 1; }
}

class FakeSocket {
    static last: FakeSocket | null = null;
    readyState = 1;
    sent: Array<Record<string, unknown>> = [];
    private listeners: Record<string, Array<(...args: unknown[]) => void>> = {};
    constructor() { FakeSocket.last = this; }
    on(event: string, listener: (...args: unknown[]) => void) { (this.listeners[event] ||= []).push(listener); }
    emit(event: string, ...args: unknown[]) { for (const listener of this.listeners[event] ?? []) listener(...args); }
    send(data: string) { this.sent.push(JSON.parse(data) as Record<string, unknown>); }
    ping() {}
    close() { this.readyState = 3; }
    terminate() { this.readyState = 3; }
    frames(type: string) { return this.sent.filter(frame => frame.type === type); }
}

function routingService() {
    return new RoutingWebSocketIntakeService({
        routingUrl: 'wss://routing.example',
        relayToken: 'relay-secret',
        installationId: 42,
        webSocketFactory: FakeSocket as never,
        dispatch: async () => undefined,
    });
}

const SHUTDOWN_AT = Date.UTC(2026, 10, 24, 2, 0, 0);

async function writeHint(nextDueAt: number | null) {
    const hint = buildIdleWakeHint({
        shutdownAt: SHUTDOWN_AT,
        reason: 'idle for 900s',
        idleForMs: 900_000,
        nextDue: nextDueAt === null ? [] : [{ kind: 'automation', dueAt: nextDueAt, detail: 'scheduled automation' }],
    });
    await writeIdleWakeHint(hint, hintFile);
    return hint;
}

test('the wake hint is sent to Connect before the socket closes', async () => {
    const service = routingService();
    await service.start();
    FakeSocket.last!.emit('open');
    assert.equal(service.sendWakeHint('2026-11-24T14:00:00.000Z'), true);
    assert.deepEqual(FakeSocket.last!.frames('wake_hint'), [{ type: 'wake_hint', reason: 'idle_shutdown', nextDueAt: '2026-11-24T14:00:00.000Z' }]);
    assert.equal(service.getInFlightCount(), 0);
    await service.stop();
    assert.equal(service.sendWakeHint(null), false, 'no socket after stop');
});

test('a wake from an HTTP request asks Connect for the replay, records the wake and consumes the hint', async () => {
    await writeHint(SHUTDOWN_AT + 6 * 3_600_000);
    const redis = new FakeRedis();
    redis.values.set(IDLE_WAKE_SIGNAL_REDIS_KEY, 'http');
    const service = routingService();
    await service.start();
    const processStartedAt = Date.now() - 4_000;
    // Recovery runs before the socket opens; the replay request waits for it.
    await recoverFromIdleWake({ redis: redis as never, routingService: service, processStartedAt, waitMs: 0 });
    FakeSocket.last!.emit('open');
    assert.deepEqual(FakeSocket.last!.frames('replay'), [{ type: 'replay', reason: 'idle_wake', since: new Date(SHUTDOWN_AT).toISOString() }]);

    const wake = JSON.parse(redis.values.get(IDLE_LAST_WAKE_REDIS_KEY)!);
    assert.equal(wake.source, 'http');
    assert.ok(wake.coldStartMs >= 4_000);
    assert.equal(wake.shutdownAt, new Date(SHUTDOWN_AT).toISOString());
    assert.equal(redis.values.has(IDLE_WAKE_SIGNAL_REDIS_KEY), false, 'the wake signal is consumed');

    const consumed = await readIdleWakeHint(hintFile);
    assert.equal(consumed?.wokeAt, wake.wokeAt);

    // A plain restart afterwards is not another wake.
    redis.values.delete(IDLE_LAST_WAKE_REDIS_KEY);
    await recoverFromIdleWake({ redis: redis as never, routingService: service, processStartedAt, waitMs: 0 });
    assert.equal(redis.values.has(IDLE_LAST_WAKE_REDIS_KEY), false);
    assert.equal(FakeSocket.last!.frames('replay').length, 1);
    await service.stop();
});

test('a start at the hinted due time is a scheduled wake; the hint file stays readable', async () => {
    await writeHint(Date.now() - 1_000);
    const redis = new FakeRedis();
    await recoverFromIdleWake({ redis: redis as never, routingService: null, processStartedAt: Date.now(), waitMs: 0 });
    assert.equal(JSON.parse(redis.values.get(IDLE_LAST_WAKE_REDIS_KEY)!).source, 'schedule');
    const raw = JSON.parse(await readFile(hintFile, 'utf8'));
    assert.equal(raw.version, 1);
    assert.equal(typeof raw.nextDueAt, 'string');
});

test('a Connect wake ping is named as the source', async () => {
    await writeHint(null);
    const redis = new FakeRedis();
    redis.values.set(IDLE_WAKE_SIGNAL_REDIS_KEY, 'connect_ping');
    await recoverFromIdleWake({ redis: redis as never, routingService: null, processStartedAt: Date.now(), waitMs: 0 });
    assert.equal(JSON.parse(redis.values.get(IDLE_LAST_WAKE_REDIS_KEY)!).source, 'connect_ping');
});

test('without a hint file the start is an ordinary start', async () => {
    await rm(hintFile, { force: true });
    const redis = new FakeRedis();
    await recoverFromIdleWake({ redis: redis as never, routingService: null, processStartedAt: Date.now(), waitMs: 0 });
    assert.equal(redis.values.size, 0);
});
