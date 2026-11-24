import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

const directory = await mkdtemp(path.join(tmpdir(), 'idle-drain-'));
process.env.PROPR_IDLE_WAKE_HINT_FILE = path.join(directory, 'idle-wake-hint.json');

const { closeConnection, emptyIdleSignals, idleActivity, IdleActivityTracker, startIdleShutdownListener } = await import('@propr/core');
const { drainIdleControlPlane } = await import('../src/daemon/idleShutdown.js');
const { IDLE_PARTICIPANTS_REDIS_KEY, IDLE_SHUTDOWN_INTENT_REDIS_KEY, resolveIdleShutdownConfig } = await import('@propr/shared');
type IdleSignals = ReturnType<typeof emptyIdleSignals>;

after(async () => {
    await closeConnection();
    await rm(directory, { recursive: true, force: true });
});

/** Shared Redis state; pub/sub drops messages for a disconnected subscriber, like Redis. */
class Hub {
    strings = new Map<string, string>();
    hashes = new Map<string, Map<string, string>>();
    connections: Connection[] = [];
    connect = () => {
        const connection = new Connection(this);
        this.connections.push(connection);
        return connection as never;
    };
}

class Connection {
    connected = true;
    channels = new Set<string>();
    private listeners: Record<string, Array<(...args: string[]) => void>> = {};
    constructor(private readonly hub: Hub) {}
    on(event: string, listener: (...args: string[]) => void) { (this.listeners[event] ||= []).push(listener); return this; }
    private check() { if (!this.connected) throw new Error('Connection is closed'); }
    async subscribe(channel: string) { this.channels.add(channel); }
    async publish(channel: string, message: string) {
        for (const connection of this.hub.connections) {
            if (connection.connected && connection.channels.has(channel)) for (const listener of connection.listeners.message ?? []) listener(channel, message);
        }
        return 1;
    }
    async get(key: string) { this.check(); return this.hub.strings.get(key) ?? null; }
    async set(key: string, value: string) { this.check(); this.hub.strings.set(key, value); return 'OK'; }
    async del(key: string) { return this.hub.strings.delete(key) ? 1 : 0; }
    async expire() { return 1; }
    async hset(key: string, field: string, value: string) {
        if (!this.hub.hashes.has(key)) this.hub.hashes.set(key, new Map());
        this.hub.hashes.get(key)!.set(field, value);
        return 1;
    }
    async hdel(key: string, field: string) { return this.hub.hashes.get(key)?.delete(field) ? 1 : 0; }
    async hgetall(key: string) { return Object.fromEntries(this.hub.hashes.get(key) ?? []); }
    async quit() { this.connected = false; return 'OK'; }
}

const START = Date.now();
const config = resolveIdleShutdownConfig({ PROPR_IDLE_SHUTDOWN: 'on', PROPR_IDLE_SHUTDOWN_AFTER: '15m' });
const request = {
    evaluation: { idle: true, blockers: [], nextDueAt: null, nextDue: [] },
    idleSince: START - 15 * 60_000,
    idleForMs: 15 * 60_000,
    config,
};
const TIMINGS = { quiesceTimeoutMs: 1_000, stopConfirmTimeoutMs: 1_000, deregisterWaitMs: 500, pollMs: 10 };

class FakeRouting {
    calls: string[] = [];
    constructor(private readonly acceptsWakeHint: boolean) {}
    async sendWakeHint() { this.calls.push('wake_hint'); return this.acceptsWakeHint; }
    async stop() { this.calls.push('stop'); }
    async start() { this.calls.push('start'); }
}

/** An API process: a tracker that quiesces on request, like `startApiIdleShutdown`. */
function apiProcess(hub: Hub, events: string[]) {
    const tracker = new IdleActivityTracker();
    let listener: ReturnType<typeof startIdleShutdownListener>;
    listener = startIdleShutdownListener({
        role: 'api',
        id: 'api-1',
        createConnection: hub.connect,
        pollMs: 10,
        onQuiesce: async intent => { tracker.quiesce(intent.id); events.push('api quiesced'); },
        onResume: () => { tracker.resume(); events.push('api resumed'); },
        onShutdown: () => { events.push('api stopping'); void listener.stop(); },
    });
    return { tracker, stop: () => listener.stop() };
}

function workerProcess(hub: Hub, events: string[], options: { acknowledges?: boolean } = {}) {
    let listener: ReturnType<typeof startIdleShutdownListener>;
    listener = startIdleShutdownListener({
        role: 'worker',
        id: 'worker-1',
        createConnection: hub.connect,
        pollMs: options.acknowledges === false ? 60_000 : 10,
        onShutdown: () => { events.push('worker stopping'); void listener.stop(); },
    });
    if (options.acknowledges === false) {
        // Disconnected for good: it never sees the request.
        for (const connection of hub.connections.slice(-2)) connection.connected = false;
    }
    return { stop: () => listener.stop() };
}

function context(hub: Hub, routing: FakeRouting | null, overrides: { collect?: () => Promise<IdleSignals>; writeHint?: () => Promise<void> } = {}) {
    const exits: number[] = [];
    const hints: unknown[] = [];
    return {
        exits,
        hints,
        ctx: {
            redis: hub.connect(),
            routing: routing as never,
            collect: overrides.collect ?? (async () => emptyIdleSignals()),
            writeHint: overrides.writeHint ?? (async (hint: unknown) => { hints.push(hint); }),
            close: async () => undefined,
            exit: (code: number) => { exits.push(code); },
            timings: TIMINGS,
        },
    };
}

test('a relay that does not acknowledge the wake hint keeps the instance running with intake untouched', async () => {
    const hub = new Hub();
    const routing = new FakeRouting(false);
    const { ctx, exits } = context(hub, routing);
    assert.equal(await drainIdleControlPlane(request, ctx), false);
    assert.deepEqual(routing.calls, ['wake_hint'], 'intake is not stopped');
    assert.equal(hub.strings.has(IDLE_SHUTDOWN_INTENT_REDIS_KEY), false);
    assert.deepEqual(exits, []);
});

test('a request that reaches the API during the drain aborts it before any worker is stopped', async () => {
    const hub = new Hub();
    const events: string[] = [];
    const api = apiProcess(hub, events);
    const worker = workerProcess(hub, events);
    const routing = new FakeRouting(true);
    const { ctx, exits } = context(hub, routing, {
        // The re-check runs only after the API confirmed it is quiesced, and sees the request it turned away.
        collect: async () => {
            events.push('re-check');
            assert.ok(api.tracker.quiescedIntent, 'the API is quiesced before the re-check');
            api.tracker.touch();
            return { ...emptyIdleSignals(), lastActivityAt: api.tracker.snapshot().lastRequestAt };
        },
    });
    assert.equal(await drainIdleControlPlane(request, ctx), false);
    await new Promise(resolve => setTimeout(resolve, 50));
    assert.deepEqual(events, ['api quiesced', 're-check', 'api resumed']);
    assert.deepEqual(routing.calls, ['wake_hint', 'stop', 'start'], 'Connect intake resumes');
    assert.equal(api.tracker.quiescedIntent, null);
    assert.deepEqual(exits, []);
    await api.stop();
    await worker.stop();
});

test('a wake hint file that cannot be written aborts the shutdown and restores intake', async () => {
    const hub = new Hub();
    const events: string[] = [];
    const api = apiProcess(hub, events);
    const routing = new FakeRouting(true);
    const { ctx, exits } = context(hub, routing, { writeHint: async () => { throw new Error('ENOSPC: no space left on device'); } });
    assert.equal(await drainIdleControlPlane(request, ctx), false);
    await new Promise(resolve => setTimeout(resolve, 50));
    assert.deepEqual(events, ['api quiesced', 'api resumed']);
    assert.deepEqual(routing.calls, ['wake_hint', 'stop', 'start']);
    assert.equal(hub.strings.has(IDLE_SHUTDOWN_INTENT_REDIS_KEY), false, 'no stop request was issued');
    assert.deepEqual(exits, []);
    await api.stop();
});

test('the daemon does not exit while a registered process has not acknowledged the stop', async () => {
    const hub = new Hub();
    const events: string[] = [];
    const api = apiProcess(hub, events);
    workerProcess(hub, events, { acknowledges: false });
    const { ctx, exits } = context(hub, null);
    assert.equal(await drainIdleControlPlane(request, ctx), true);
    assert.deepEqual(exits, [], 'no exit without every confirmation');
    assert.ok(events.includes('api stopping'));
    assert.ok(hub.strings.has(IDLE_SHUTDOWN_INTENT_REDIS_KEY), 'the request stays stored for a process that reconnects');
    await api.stop();
});

test('with every process acknowledging, the control plane stops in order and the daemon exits 0', async () => {
    const hub = new Hub();
    const events: string[] = [];
    apiProcess(hub, events);
    workerProcess(hub, events);
    const routing = new FakeRouting(true);
    const { ctx, exits, hints } = context(hub, routing);
    assert.equal(await drainIdleControlPlane(request, ctx), true);
    assert.deepEqual(exits, [0]);
    assert.deepEqual(events.slice(0, 1), ['api quiesced']);
    assert.deepEqual([...events.slice(1)].sort(), ['api stopping', 'worker stopping']);
    assert.equal((hints[0] as { connectReplay?: string }).connectReplay, 'pending', 'the next start owes a Connect replay');
    assert.deepEqual(Object.keys(Object.fromEntries(hub.hashes.get(IDLE_PARTICIPANTS_REDIS_KEY) ?? [])), [], 'every process deregistered');
    assert.equal(hub.strings.has(IDLE_SHUTDOWN_INTENT_REDIS_KEY), false, 'a fresh start does not see the stop request');
    assert.deepEqual(routing.calls, ['wake_hint', 'stop']);
    assert.equal(idleActivity.quiescedIntent, null, 'the process-wide tracker is untouched');
});
