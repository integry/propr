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
    connectReplaySince,
    readIdleWakeHint,
    writeIdleWakeHint,
} = await import('@propr/core');
const { recoverFromIdleWake } = await import('../src/daemon/idleShutdown.js');
const { IDLE_LAST_WAKE_REDIS_KEY, IDLE_WAKE_SIGNAL_REDIS_KEY } = await import('@propr/shared');
/** Wait until the fake relay has received `count` frames of `type`. */
async function sentFrames(type: string, count: number) {
    for (let attempt = 0; attempt < 200 && (FakeSocket.last?.frames(type).length ?? 0) < count; attempt += 1) {
        await new Promise(resolve => setTimeout(resolve, 5));
    }
    assert.equal(FakeSocket.last!.frames(type).length, count);
}

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
        idleFrameAckTimeoutMs: 50,
    });
}

/** Answer the next frame of `type` the way a relay with idle wake support would. */
function acknowledge(type: 'wake_hint' | 'replay') {
    const socket = FakeSocket.last!;
    socket.emit('message', Buffer.from(JSON.stringify({ type: `${type}_ack` })));
}

const SHUTDOWN_AT = Date.UTC(2026, 10, 24, 2, 0, 0);

async function writeHint(nextDueAt: number | null, connect = false) {
    const hint = buildIdleWakeHint({
        shutdownAt: SHUTDOWN_AT,
        reason: 'idle for 900s',
        idleForMs: 900_000,
        nextDue: nextDueAt === null ? [] : [{ kind: 'automation', dueAt: nextDueAt, detail: 'scheduled automation' }],
        connect,
    });
    await writeIdleWakeHint(hint, hintFile);
    return hint;
}

test('the wake hint counts only when Connect acknowledges it', async () => {
    const service = routingService();
    await service.start();
    FakeSocket.last!.emit('open');
    // Today's relay answers an unknown frame with an error (or nothing): not accepted.
    FakeSocket.last!.emit('message', Buffer.from(JSON.stringify({ type: 'error', code: 'unknown_frame', message: 'unknown frame type' })));
    assert.equal(await service.sendWakeHint('2026-11-24T14:00:00.000Z'), false);
    assert.equal(service.getIdleWakeSupport(), 'rejected');
    assert.deepEqual(FakeSocket.last!.frames('wake_hint'), [{ type: 'wake_hint', reason: 'idle_shutdown', nextDueAt: '2026-11-24T14:00:00.000Z' }]);

    const accepted = service.sendWakeHint(null);
    acknowledge('wake_hint');
    assert.equal(await accepted, true);
    assert.equal(service.getIdleWakeSupport(), 'accepted');
    assert.equal(service.getInFlightCount(), 0);
    await service.stop();
    assert.equal(await service.sendWakeHint(null), false, 'no socket after stop');
});

test('a wake from an HTTP request records the wake, and the replay obligation is released only once Connect accepts it', async () => {
    await writeHint(SHUTDOWN_AT + 6 * 3_600_000, true);
    const redis = new FakeRedis();
    redis.values.set(IDLE_WAKE_SIGNAL_REDIS_KEY, 'http');
    const service = routingService();
    await service.start();
    const processStartedAt = Date.now() - 4_000;
    // Recovery starts before the socket opens; the replay request waits for it.
    const recovery = recoverFromIdleWake({ redis: redis as never, routingService: service, processStartedAt, waitMs: 0 });
    await new Promise(resolve => setTimeout(resolve, 0));
    FakeSocket.last!.emit('open');
    await sentFrames('replay', 1);
    assert.deepEqual(FakeSocket.last!.frames('replay'), [{ type: 'replay', reason: 'idle_wake', since: new Date(SHUTDOWN_AT).toISOString() }]);
    acknowledge('replay');
    await recovery;

    const wake = JSON.parse(redis.values.get(IDLE_LAST_WAKE_REDIS_KEY)!);
    assert.equal(wake.source, 'http');
    assert.ok(wake.coldStartMs >= 4_000);
    assert.equal(wake.shutdownAt, new Date(SHUTDOWN_AT).toISOString());
    assert.equal(redis.values.has(IDLE_WAKE_SIGNAL_REDIS_KEY), false, 'the wake signal is consumed');

    const consumed = await readIdleWakeHint(hintFile);
    assert.equal(consumed?.wokeAt, wake.wokeAt);
    assert.equal(consumed?.connectReplay, 'accepted');

    // A plain restart afterwards is neither another wake nor another replay.
    redis.values.delete(IDLE_LAST_WAKE_REDIS_KEY);
    await recoverFromIdleWake({ redis: redis as never, routingService: service, processStartedAt, waitMs: 0 });
    assert.equal(redis.values.has(IDLE_LAST_WAKE_REDIS_KEY), false);
    assert.equal(FakeSocket.last!.frames('replay').length, 1);
    await service.stop();
});

test('a relay that does not accept the replay leaves it pending for the next start', async () => {
    await writeHint(null, true);
    const redis = new FakeRedis();
    const service = routingService();
    await service.start();
    FakeSocket.last!.emit('open');
    // No replay_ack: the frame reached the socket, which proves nothing.
    await recoverFromIdleWake({ redis: redis as never, routingService: service, processStartedAt: Date.now(), waitMs: 0 });
    assert.equal(FakeSocket.last!.frames('replay').length, 1);
    const afterFirst = await readIdleWakeHint(hintFile);
    assert.equal(typeof afterFirst?.wokeAt, 'string', 'the wake itself is recorded once');
    assert.equal(afterFirst?.connectReplay, 'pending');
    await service.stop();

    // Without Connect intake at all the obligation also stays.
    await recoverFromIdleWake({ redis: redis as never, routingService: null, processStartedAt: Date.now(), waitMs: 0 });
    assert.equal((await readIdleWakeHint(hintFile))?.connectReplay, 'pending');

    const next = routingService();
    await next.start();
    FakeSocket.last!.emit('open');
    const retry = recoverFromIdleWake({ redis: redis as never, routingService: next, processStartedAt: Date.now(), waitMs: 0 });
    await sentFrames('replay', 1);
    acknowledge('replay');
    await retry;
    assert.equal((await readIdleWakeHint(hintFile))?.connectReplay, 'accepted');
    await next.stop();
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

test('a replay owed since an earlier stop is requested from that stop, and a later stop keeps its own replay owed', async () => {
    const earlier = new Date(SHUTDOWN_AT - 3_600_000).toISOString();
    await writeIdleWakeHint({ ...buildIdleWakeHint({ shutdownAt: SHUTDOWN_AT, reason: 'idle', idleForMs: 0, nextDue: [], connect: true, pendingReplaySince: earlier }) }, hintFile);
    assert.equal((await readIdleWakeHint(hintFile))?.replaySince, earlier);
    const redis = new FakeRedis();
    const service = routingService();
    await service.start();
    FakeSocket.last!.emit('open');
    const recovery = recoverFromIdleWake({ redis: redis as never, routingService: service, processStartedAt: Date.now(), waitMs: 0 });
    await sentFrames('replay', 1);
    assert.equal(FakeSocket.last!.frames('replay')[0].since, earlier);

    // Before the relay answers, another idle stop replaces the hint (carrying the same cursor).
    const laterStop = SHUTDOWN_AT + 3_600_000;
    await new Promise(resolve => setTimeout(resolve, 10));
    const laterIntakeStoppedAt = laterStop - 20_000;
    await writeIdleWakeHint(buildIdleWakeHint({ shutdownAt: laterStop, reason: 'idle', idleForMs: 0, nextDue: [], connect: true, pendingReplaySince: earlier, intakeStoppedAt: laterIntakeStoppedAt }), hintFile);
    acknowledge('replay');
    await recovery;
    const after = await readIdleWakeHint(hintFile);
    assert.equal(after?.shutdownAt, new Date(laterStop).toISOString(), 'the later stop is not overwritten');
    assert.equal(after?.wokeAt, undefined, 'the later stop is still a pending wake');
    assert.equal(after?.connectReplay, 'pending', 'deliveries cached since the later stop are still owed');
    assert.equal(after?.replaySince, undefined, 'the acknowledged replay covered the earlier interval');
    assert.equal(connectReplaySince(after!), new Date(laterIntakeStoppedAt).toISOString(), 'the later stop still owes everything since its intake disconnected');
    await service.stop();
});

test('the replay starts when intake disconnected for the drain, not at the later shutdown time', async () => {
    const intakeStoppedAt = SHUTDOWN_AT - 25_000;
    await writeIdleWakeHint(buildIdleWakeHint({ shutdownAt: SHUTDOWN_AT, reason: 'idle', idleForMs: 0, nextDue: [], connect: true, intakeStoppedAt }), hintFile);
    const service = routingService();
    await service.start();
    FakeSocket.last!.emit('open');
    const recovery = recoverFromIdleWake({ redis: new FakeRedis() as never, routingService: service, processStartedAt: Date.now(), waitMs: 0 });
    await sentFrames('replay', 1);
    assert.equal(FakeSocket.last!.frames('replay')[0].since, new Date(intakeStoppedAt).toISOString(), 'deliveries cached while draining are covered');
    acknowledge('replay');
    await recovery;
    assert.equal((await readIdleWakeHint(hintFile))?.connectReplay, 'accepted');
    await service.stop();
});
