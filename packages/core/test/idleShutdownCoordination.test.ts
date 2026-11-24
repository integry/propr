import assert from 'node:assert/strict';
import test from 'node:test';
import { IDLE_PARTICIPANTS_REDIS_KEY, IDLE_SHUTDOWN_CHANNEL, IDLE_SHUTDOWN_INTENT_REDIS_KEY } from '@propr/shared';
import { collectParticipantSignals, registerIdleParticipant } from '../src/idle/idleParticipants.js';
import {
    issueIdleShutdownIntent,
    newIdleShutdownIntent,
    waitForIdleAcks,
    withdrawIdleShutdownIntent,
} from '../src/idle/idleShutdownIntent.js';
import { startIdleShutdownListener } from '../src/idle/idleShutdownListener.js';
import { RoutingIdleWake } from '../src/intake/routingIdleFrames.js';

/** Shared Redis state with pub/sub that, like Redis, does not keep messages for a disconnected subscriber. */
class FakeRedisHub {
    strings = new Map<string, string>();
    hashes = new Map<string, Map<string, string>>();
    connections: FakeConnection[] = [];
    connect = () => {
        const connection = new FakeConnection(this);
        this.connections.push(connection);
        return connection as never;
    };
    deliver(channel: string, message: string) {
        for (const connection of this.connections) connection.receive(channel, message);
    }
    hash(key: string) { return Object.fromEntries(this.hashes.get(key) ?? []); }
}

class FakeConnection {
    connected = true;
    channels = new Set<string>();
    private listeners: Record<string, Array<(...args: string[]) => void>> = {};
    constructor(private readonly hub: FakeRedisHub) {}
    on(event: string, listener: (...args: string[]) => void) { (this.listeners[event] ||= []).push(listener); return this; }
    emit(event: string, ...args: string[]) { for (const listener of this.listeners[event] ?? []) listener(...args); }
    receive(channel: string, message: string) { if (this.connected && this.channels.has(channel)) this.emit('message', channel, message); }
    private check() { if (!this.connected) throw new Error('Connection is closed'); }
    async subscribe(channel: string) { this.check(); this.channels.add(channel); }
    async publish(channel: string, message: string) { this.check(); this.hub.deliver(channel, message); return 1; }
    async get(key: string) { this.check(); return this.hub.strings.get(key) ?? null; }
    async set(key: string, value: string) { this.check(); this.hub.strings.set(key, value); return 'OK'; }
    async del(key: string) { this.check(); return this.hub.strings.delete(key) ? 1 : 0; }
    async expire() { return 1; }
    async hset(key: string, field: string, value: string) {
        this.check();
        if (!this.hub.hashes.has(key)) this.hub.hashes.set(key, new Map());
        this.hub.hashes.get(key)!.set(field, value);
        return 1;
    }
    async hdel(key: string, field: string) { this.check(); return this.hub.hashes.get(key)?.delete(field) ? 1 : 0; }
    async hgetall(key: string) { this.check(); return this.hub.hash(key); }
    async quit() { this.connected = false; return 'OK'; }
    drop() { this.connected = false; }
    reconnect() { this.connected = true; this.emit('ready'); }
}

const settle = () => new Promise(resolve => setTimeout(resolve, 20));
const FAST = { pollMs: 10 };

test('a registered process with a stale heartbeat is unavailable until it deregisters', async () => {
    const hub = new FakeRedisHub();
    const redis = hub.connect() as unknown as FakeConnection;
    let now = 1_000_000;
    const registration = registerIdleParticipant(redis as never, { role: 'worker', id: 'w1', now: () => now, intervalMs: 60_000 });
    await settle();
    assert.deepEqual((await collectParticipantSignals(redis as never, { now })).unavailable, []);
    now += 60_000;
    const stale = await collectParticipantSignals(redis as never, { now, isGone: () => false });
    assert.deepEqual(stale.unavailable, ['worker:w1 (no heartbeat for 60s)']);
    await registration.stop();
    assert.deepEqual((await collectParticipantSignals(redis as never, { now })).unavailable, []);

    await redis.hset(IDLE_PARTICIPANTS_REDIS_KEY, 'api:broken', '{');
    assert.deepEqual((await collectParticipantSignals(redis as never, { now })).unavailable, ['the registration of api:broken (malformed)']);
});

test('a process disconnected when the stop was announced still stops and acknowledges after reconnecting', async () => {
    const hub = new FakeRedisHub();
    const daemon = hub.connect() as unknown as FakeConnection;
    const stops: string[] = [];
    const listener = startIdleShutdownListener({
        role: 'worker',
        id: 'w1',
        createConnection: hub.connect,
        onShutdown: intent => { stops.push(intent.id); },
        pollMs: 60_000,
    });
    await settle();
    const [commands, subscriber] = hub.connections.slice(1) as FakeConnection[];
    commands.drop();
    subscriber.drop();

    const intent = { ...newIdleShutdownIntent('quiesce', 'idle for 900s'), phase: 'stop' as const };
    await issueIdleShutdownIntent(daemon as never, intent);
    await settle();
    assert.deepEqual(stops, [], 'the one-shot message is lost while disconnected');
    const pending = await waitForIdleAcks(daemon as never, intent, { roles: ['worker'], timeoutMs: 0, ...FAST, isGone: () => false });
    assert.deepEqual(pending, { confirmed: false, pending: ['worker:w1'] });

    commands.connected = true;
    subscriber.reconnect();
    const confirmed = await waitForIdleAcks(daemon as never, intent, { roles: ['worker'], timeoutMs: 2_000, ...FAST });
    assert.equal(confirmed.confirmed, true);
    assert.deepEqual(stops, [intent.id]);
    await listener.stop();
    assert.deepEqual(hub.hash(IDLE_PARTICIPANTS_REDIS_KEY), {}, 'a stopped process deregisters');
});

test('the daemon keeps waiting (and re-announcing) while a process has not acknowledged', async () => {
    const hub = new FakeRedisHub();
    const daemon = hub.connect() as unknown as FakeConnection;
    await daemon.hset(IDLE_PARTICIPANTS_REDIS_KEY, 'api:silent', JSON.stringify({
        role: 'api', id: 'silent', host: 'elsewhere', pid: 1, pidNamespace: null, bootId: null, startedAt: 0, seenAt: Date.now(),
    }));
    const intent = { ...newIdleShutdownIntent('quiesce', 'idle'), phase: 'stop' as const };
    const announced: string[] = [];
    const watcher = hub.connect() as unknown as FakeConnection;
    await watcher.subscribe(IDLE_SHUTDOWN_CHANNEL);
    watcher.on('message', (_channel, message) => announced.push(message));
    const progress = await waitForIdleAcks(daemon as never, intent, { roles: ['api', 'worker'], timeoutMs: 100, ...FAST });
    assert.deepEqual(progress, { confirmed: false, pending: ['api:silent'] });
    assert.ok(announced.length >= 2, 'the request is re-announced while waiting');
    assert.equal(JSON.parse(hub.strings.get(IDLE_SHUTDOWN_INTENT_REDIS_KEY)!).id, intent.id);
});

test('an API process quiesces, acknowledges, and resumes when the drain is withdrawn', async () => {
    const hub = new FakeRedisHub();
    const daemon = hub.connect() as unknown as FakeConnection;
    const events: string[] = [];
    const listener = startIdleShutdownListener({
        role: 'api',
        id: 'a1',
        createConnection: hub.connect,
        onQuiesce: async () => { events.push('quiesce'); },
        onResume: () => { events.push('resume'); },
        onShutdown: () => { events.push('stop'); },
        pollMs: 10,
    });
    await settle();
    const intent = newIdleShutdownIntent('quiesce', 'idle');
    await issueIdleShutdownIntent(daemon as never, intent);
    const progress = await waitForIdleAcks(daemon as never, intent, { roles: ['api'], timeoutMs: 2_000, ...FAST });
    assert.equal(progress.confirmed, true);
    assert.deepEqual(events, ['quiesce']);
    // Workers do not take part in the quiesce phase.
    await withdrawIdleShutdownIntent(daemon as never, intent.id);
    await settle();
    assert.deepEqual(events, ['quiesce', 'resume']);
    assert.equal(hub.strings.has(IDLE_SHUTDOWN_INTENT_REDIS_KEY), false);
    await listener.stop();
});

class FakeSocket {
    sent: Array<Record<string, unknown>> = [];
}

test('a wake hint counts only when the relay acknowledges it on the same socket', async () => {
    const socket = new FakeSocket();
    const wake = new RoutingIdleWake((frame, target) => { (target as unknown as FakeSocket).sent.push(frame); return true; }, 30);
    assert.equal(await wake.sendWakeHint(socket as never, null), false, 'no answer (today\'s relay) is not acceptance');
    assert.equal(wake.wakeSupport, 'rejected');

    const accepted = wake.sendWakeHint(socket as never, '2026-11-24T14:00:00.000Z');
    wake.handle({ type: 'wake_hint_ack' }, new FakeSocket() as never);
    wake.handle({ type: 'wake_hint_ack' }, socket as never);
    assert.equal(await accepted, true);
    assert.equal(wake.wakeSupport, 'accepted');
    wake.opened(socket as never);
    assert.equal(wake.wakeSupport, 'unknown', 'a new connection may be a different relay');
});

test('a replay request survives a dropped socket and resolves only on acknowledgement', async () => {
    const first = new FakeSocket();
    const second = new FakeSocket();
    const wake = new RoutingIdleWake((frame, target) => { (target as unknown as FakeSocket).sent.push(frame); return true; }, 30);
    const replay = wake.requestReplay(null, '2026-11-24T02:00:00.000Z');
    wake.opened(first as never);
    assert.equal(first.sent.length, 1);
    wake.closed(first as never);
    wake.opened(second as never);
    assert.deepEqual(second.sent, [{ type: 'replay', reason: 'idle_wake', since: '2026-11-24T02:00:00.000Z' }]);
    wake.handle({ type: 'replay_ack' }, second as never);
    assert.equal(await replay, true);

    const unanswered = wake.requestReplay(second as never, null);
    assert.equal(await unanswered, false, 'a relay that does not answer has not replayed anything');
});
