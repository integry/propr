import { after, mock, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

const directory = await mkdtemp(path.join(tmpdir(), 'idle-drain-'));
process.env.PROPR_IDLE_WAKE_HINT_FILE = path.join(directory, 'idle-wake-hint.json');

const {
    buildIdleWakeHint,
    closeConnection,
    collectIdleSignals,
    connectReplaySince,
    emptyIdleSignals,
    idleActivity,
    IdleActivityTracker,
    readIdleWakeHint,
    setIdleShutdownComposedProcess,
    startIdleShutdownListener,
    writeIdleWakeHint,
} = await import('@propr/core');
const { DEFAULT_IDLE_DRAIN_TIMINGS, drainIdleControlPlane, recoverFromIdleWake } = await import('../src/daemon/idleShutdown.js');
const { stopDaemonProcess } = await import('../src/daemon/idleStopExit.js');
const { recordAcceptedReplay } = await import('../src/daemon/idleReplayObligation.js');
const { createDaemonWorkProducers } = await import('../src/daemon/workProducers.js');
const { createDaemonActivitySources } = await import('../src/daemon/idleSignalSources.js');
const { createIdleActivityMiddleware, createWakeHandler, startApiIdleShutdown } = await import('../packages/api/idleShutdownIntegration.js');
const { createBoundedExit } = await import('../src/allInOneConfig.js');
const {
    IDLE_LAST_SHUTDOWN_REDIS_KEY, IDLE_LAST_WAKE_REDIS_KEY, IDLE_PARTICIPANTS_REDIS_KEY, IDLE_SHUTDOWN_ACKS_REDIS_PREFIX, IDLE_SHUTDOWN_INTENT_REDIS_KEY, resolveIdleShutdownConfig,
} = await import('@propr/shared');
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
    async scan(_cursor: string, _match: string, pattern: string) {
        const prefix = pattern.replace(/\*$/, '');
        return ['0', [...this.hub.strings.keys()].filter(key => key.startsWith(prefix))];
    }
    duplicate() { return this.hub.connect(); }
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
    stoppedAt: number | null = null;
    replays: Array<string | null> = [];
    /** Settles the outstanding replay request (the relay's answer). */
    answerReplay: (accepted: boolean) => void = () => undefined;
    constructor(private readonly acceptsWakeHint: boolean) {}
    async sendWakeHint() { this.calls.push('wake_hint'); return this.acceptsWakeHint; }
    async stop() { this.calls.push('stop'); this.stoppedAt ??= Date.now(); }
    async start() { this.calls.push('start'); }
    requestReplay(since: string | null) {
        this.calls.push('replay');
        this.replays.push(since);
        return new Promise<boolean>(resolve => { this.answerReplay = resolve; });
    }
}

/** A hint file in memory: reads return what was last written. */
function hintStore(initial: unknown = null) {
    const store = { current: initial as { shutdownAt: string; connectReplay?: string; wokeAt?: string; intakeStoppedAt?: string; replaySince?: string } | null };
    return {
        store,
        readHint: async () => store.current,
        writeHint: async (hint: unknown) => { store.current = JSON.parse(JSON.stringify(hint)); },
    };
}

const settle = () => new Promise(resolve => setTimeout(resolve, 20));

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

function context(hub: Hub, routing: FakeRouting | null, overrides: { collect?: () => Promise<IdleSignals>; writeHint?: (hint: unknown) => Promise<void>; readHint?: () => Promise<unknown> } = {}) {
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
            readHint: (overrides.readHint ?? (async () => null)) as never,
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
    assert.deepEqual(routing.calls, ['wake_hint', 'stop', 'start', 'replay'], 'Connect intake resumes and asks for what was cached while disconnected');
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
    let writes = 0;
    // The record owed before the disconnect is written; the stop's hint is not (the disk filled meanwhile).
    const { ctx, exits } = context(hub, routing, { writeHint: async () => { writes += 1; if (writes > 1) throw new Error('ENOSPC: no space left on device'); } });
    assert.equal(await drainIdleControlPlane(request, ctx), false);
    await new Promise(resolve => setTimeout(resolve, 50));
    assert.deepEqual(events, ['api quiesced', 'api resumed']);
    assert.deepEqual(routing.calls, ['wake_hint', 'stop', 'start', 'replay'], 'the replay is still requested in process');
    assert.equal(hub.strings.has(IDLE_SHUTDOWN_INTENT_REDIS_KEY), false, 'no stop request was issued');
    assert.deepEqual(exits, []);
    await api.stop();
});

test('a replay obligation that cannot be recorded aborts before intake is disconnected', async () => {
    const hub = new Hub();
    const events: string[] = [];
    const api = apiProcess(hub, events);
    const routing = new FakeRouting(true);
    const { ctx, exits } = context(hub, routing, { writeHint: async () => { throw new Error('EROFS: read-only file system'); } });
    assert.equal(await drainIdleControlPlane(request, ctx), false);
    await new Promise(resolve => setTimeout(resolve, 50));
    assert.deepEqual(routing.calls, ['wake_hint'], 'intake stays connected: nothing is cached by the relay, nothing is owed');
    assert.ok(!events.includes('api quiesced') || events.includes('api resumed'), 'the API admits requests again');
    assert.equal(hub.strings.has(IDLE_SHUTDOWN_INTENT_REDIS_KEY), false);
    assert.deepEqual(exits, []);
    await api.stop();
});

test('the daemon does not exit while a registered process has not acknowledged the stop', async () => {
    const hub = new Hub();
    const events: string[] = [];
    const api = apiProcess(hub, events);
    workerProcess(hub, events, { acknowledges: false });
    const { ctx, exits } = context(hub, null);
    // Nothing scheduled, a long confirmation timeout: it waits (until SIGTERM, here after a while).
    const started = Date.now();
    const cancelled = { ...ctx, timings: { ...TIMINGS, stopConfirmTimeoutMs: 60_000 }, isCancelled: () => Date.now() - started > 300 };
    assert.equal(await drainIdleControlPlane(request, cancelled), true);
    assert.deepEqual(exits, [], 'no exit without every confirmation');
    assert.ok(events.includes('api stopping'));
    assert.ok(hub.strings.has(IDLE_SHUTDOWN_INTENT_REDIS_KEY), 'the request stays stored for a process that reconnects');
    await api.stop();
});

test('a stop still unconfirmed when its confirmation timeout ends is called off: exit 1, never 0, and the request is withdrawn', async () => {
    const hub = new Hub();
    const events: string[] = [];
    const api = apiProcess(hub, events);
    workerProcess(hub, events, { acknowledges: false });
    const { ctx, exits } = context(hub, null);
    assert.equal(await drainIdleControlPlane(request, ctx), true);
    assert.deepEqual(exits, [1], 'the supervisor starts the control plane again');
    assert.ok(events.includes('api stopping'));
    assert.equal(hub.strings.has(IDLE_SHUTDOWN_INTENT_REDIS_KEY), false, 'a process that has not stopped keeps running');
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

test('a standalone daemon close that hangs or fails still ends in exit 0 within the close deadline', async () => {
    for (const close of [() => new Promise<void>(() => undefined), async () => { throw new Error('redis quit failed'); }]) {
        const hub = new Hub();
        apiProcess(hub, []);
        workerProcess(hub, []);
        const { ctx, exits } = context(hub, new FakeRouting(true));
        const started = Date.now();
        assert.equal(await drainIdleControlPlane(request, { ...ctx, close, timings: { ...TIMINGS, closeDeadlineMs: 50 } }), true);
        assert.deepEqual(exits, [0]);
        assert.ok(Date.now() - started < 5_000, 'bounded');
    }
});

test('a stop while an earlier wake still owes its Connect replay keeps that replay\'s cursor', async () => {
    const hub = new Hub();
    const earlierStop = Date.UTC(2026, 10, 24, 2, 0, 0);
    // Shutdown A, woken, replay never acknowledged.
    const owed = { ...buildIdleWakeHint({ shutdownAt: earlierStop, reason: 'idle', idleForMs: 0, nextDue: [], connect: true }), wokeAt: new Date(earlierStop + 60_000).toISOString() };
    const { ctx, exits, hints } = context(hub, new FakeRouting(true), { readHint: async () => owed });
    assert.equal(await drainIdleControlPlane(request, ctx), true);
    assert.deepEqual(exits, [0]);
    const written = hints.at(-1) as { shutdownAt: string; connectReplay?: string; replaySince?: string };
    assert.notEqual(written.shutdownAt, owed.shutdownAt);
    assert.equal(written.connectReplay, 'pending');
    assert.equal(written.replaySince, owed.shutdownAt, 'the next start asks for everything since shutdown A');

    // Once accepted, nothing is carried.
    const accepted = context(new Hub(), new FakeRouting(true), { readHint: async () => ({ ...owed, connectReplay: 'accepted' }) });
    assert.equal(await drainIdleControlPlane(request, accepted.ctx), true);
    assert.equal((accepted.hints.at(-1) as { replaySince?: string }).replaySince, undefined);
});

test('a successful stop owes the replay from before intake disconnected, not from the later shutdown time', async () => {
    const hub = new Hub();
    const routing = new FakeRouting(true);
    // Draining takes a while: a delivery cached by the relay during it must be inside the replay.
    const { ctx, exits, hints } = context(hub, routing, { collect: async () => { await new Promise(resolve => setTimeout(resolve, 30)); return emptyIdleSignals(); } });
    assert.equal(await drainIdleControlPlane(request, ctx), true);
    assert.deepEqual(exits, [0]);
    assert.equal(hints.length, 2, 'the obligation recorded before the disconnect, then the stop\'s hint');
    const written = hints.at(-1) as { shutdownAt: string; intakeStoppedAt?: string; connectReplay?: string; replaySince?: string; wokeAt?: string };
    assert.equal(written.connectReplay, 'pending');
    assert.equal(written.wokeAt, undefined, 'the stop\'s hint is a pending wake');
    assert.equal(written.replaySince, undefined, 'the record replaced is this drain\'s own, not an earlier obligation');
    assert.ok(written.intakeStoppedAt, 'the disconnect time is recorded');
    assert.ok(Date.parse(written.intakeStoppedAt!) <= routing.stoppedAt!, 'taken before intake disconnected');
    assert.ok(Date.parse(written.intakeStoppedAt!) < Date.parse(written.shutdownAt));
    assert.equal(connectReplaySince(written as never), written.intakeStoppedAt, 'the next start asks for everything since the disconnect');
});

test('an aborted drain records the replay owed for its disconnection and asks for it after reconnecting', async () => {
    const hub = new Hub();
    const routing = new FakeRouting(true);
    const hints = hintStore();
    const { ctx, exits } = context(hub, routing, { ...hints, collect: async () => ({ ...emptyIdleSignals(), httpRequests: 1 }) });
    assert.equal(await drainIdleControlPlane(request, ctx), false);
    assert.deepEqual(exits, []);
    assert.deepEqual(routing.calls, ['wake_hint', 'stop', 'start', 'replay']);
    const owed = hints.store.current!;
    assert.equal(owed.connectReplay, 'pending', 'the obligation is durable before the relay answers');
    assert.ok(owed.wokeAt, 'not a stop: the next plain start is not counted as a wake');
    assert.ok(Date.parse(owed.intakeStoppedAt!) <= routing.stoppedAt!);
    assert.deepEqual(routing.replays, [owed.intakeStoppedAt], 'replay since the disconnect');

    // Kept pending until acknowledged, then released.
    routing.answerReplay(true);
    await settle();
    assert.equal(hints.store.current!.connectReplay, 'accepted');
});

test('an aborted drain whose replay is refused leaves it pending; an earlier owed replay keeps its cursor', async () => {
    const earlierStop = Date.UTC(2026, 10, 24, 2, 0, 0);
    const owedEarlier = { ...buildIdleWakeHint({ shutdownAt: earlierStop, reason: 'idle', idleForMs: 0, nextDue: [], connect: true, intakeStoppedAt: earlierStop - 10_000 }), wokeAt: new Date(earlierStop + 60_000).toISOString() };
    const routing = new FakeRouting(true);
    const hints = hintStore(owedEarlier);
    const { ctx } = context(new Hub(), routing, { ...hints, collect: async () => ({ ...emptyIdleSignals(), httpRequests: 1 }) });
    assert.equal(await drainIdleControlPlane(request, ctx), false);
    assert.deepEqual(routing.replays, [new Date(earlierStop - 10_000).toISOString()], 'the earliest owed cursor covers this disconnection too');
    assert.equal(hints.store.current!.replaySince, new Date(earlierStop - 10_000).toISOString(), 'the earlier obligation\'s cursor is kept');
    assert.ok(Date.parse(hints.store.current!.intakeStoppedAt!) <= routing.stoppedAt!, 'alongside this disconnection');
    routing.answerReplay(false);
    await settle();
    assert.equal(hints.store.current!.connectReplay, 'pending', 'requested again by a later drain or start');
});

test('an earlier replay accepted during the drain does not release the replay owed for this disconnection', async () => {
    const earlierStop = Date.UTC(2026, 10, 24, 2, 0, 0);
    const owedEarlier = { ...buildIdleWakeHint({ shutdownAt: earlierStop, reason: 'idle', idleForMs: 0, nextDue: [], connect: true, intakeStoppedAt: earlierStop - 10_000 }), wokeAt: new Date(earlierStop + 60_000).toISOString() };
    const routing = new FakeRouting(true);
    const hints = hintStore(owedEarlier);
    const { ctx } = context(new Hub(), routing, {
        ...hints,
        // The relay acknowledges the replay the earlier wake asked for, after intake disconnected for this drain.
        collect: async () => {
            await recordAcceptedReplay(hints, owedEarlier as never, connectReplaySince(owedEarlier));
            return { ...emptyIdleSignals(), httpRequests: 1 };
        },
    });
    assert.equal(await drainIdleControlPlane(request, ctx), false);
    const owed = hints.store.current!;
    assert.equal(owed.connectReplay, 'pending', 'deliveries cached since this disconnection are still owed');
    assert.equal(owed.replaySince, undefined, 'only the earlier cursor is released');
    assert.deepEqual(routing.replays, [owed.intakeStoppedAt]);
    assert.ok(Date.parse(owed.intakeStoppedAt!) <= routing.stoppedAt!);
});

/** A daemon that dies mid-drain, right after intake disconnected, with the real hint file. */
async function crashAfterDisconnect(hub: Hub, routing: FakeRouting) {
    const { ctx } = context(hub, routing, { collect: () => new Promise<IdleSignals>(() => undefined) });
    const realFile = { ...ctx, readHint: undefined, writeHint: undefined };
    void drainIdleControlPlane(request, realFile);
    for (let attempt = 0; attempt < 200 && routing.stoppedAt === null; attempt += 1) await new Promise(resolve => setTimeout(resolve, 5));
    assert.notEqual(routing.stoppedAt, null, 'intake disconnected');
}

async function restart(hub: Hub) {
    const replays: string[] = [];
    let answer: (accepted: boolean) => void = () => undefined;
    const redis = hub.connect();
    const recovered = recoverFromIdleWake({
        redis,
        routingService: { requestReplay: (since: string | null) => { replays.push(since!); return new Promise<boolean>(resolve => { answer = resolve; }); } },
        processStartedAt: Date.now(),
        waitMs: 0,
    });
    for (let attempt = 0; attempt < 200 && replays.length === 0; attempt += 1) await new Promise(resolve => setTimeout(resolve, 5));
    answer(true);
    await recovered;
    return replays;
}

for (const [label, before] of [
    ['no hint file', null],
    ['a consumed hint whose replay was accepted', { ...buildIdleWakeHint({ shutdownAt: Date.UTC(2026, 10, 24, 2, 0, 0), reason: 'idle', idleForMs: 0, nextDue: [], connect: true }), wokeAt: new Date(Date.UTC(2026, 10, 24, 2, 5, 0)).toISOString(), connectReplay: 'accepted' as const }],
] as const) {
    test(`a crash right after intake disconnects leaves the replay owed (${label}), and the restart asks for it from before the disconnect`, async () => {
        await rm(process.env.PROPR_IDLE_WAKE_HINT_FILE!, { force: true });
        if (before) await writeIdleWakeHint(before);
        const hub = new Hub();
        const routing = new FakeRouting(true);
        await crashAfterDisconnect(hub, routing);
        // The relay caches a delivery while the daemon is gone.
        const cachedAt = Date.now();
        assert.ok(cachedAt >= routing.stoppedAt!);

        const replays = await restart(hub);
        assert.equal(replays.length, 1, 'the restart asks Connect for the cached deliveries');
        assert.ok(Date.parse(replays[0]) <= routing.stoppedAt!, 'from before the disconnect');
        assert.ok(Date.parse(replays[0]) <= cachedAt, 'the delivery cached mid-drain is inside the replay');
        assert.equal(hub.strings.has(IDLE_LAST_WAKE_REDIS_KEY), false, 'the drain never stopped the instance: the restart is not a wake');
        assert.equal(hub.strings.has(IDLE_LAST_SHUTDOWN_REDIS_KEY), false, 'nor a completed idle shutdown');
        const after = await readIdleWakeHint();
        assert.equal(after?.connectReplay, 'accepted', 'released once Connect accepted it');
    });
}

test('a crash mid-drain keeps an earlier replay\'s cursor', async () => {
    const earlierStop = Date.UTC(2026, 10, 24, 2, 0, 0);
    await writeIdleWakeHint({ ...buildIdleWakeHint({ shutdownAt: earlierStop, reason: 'idle', idleForMs: 0, nextDue: [], connect: true, intakeStoppedAt: earlierStop - 10_000 }), wokeAt: new Date(earlierStop + 60_000).toISOString() });
    const hub = new Hub();
    await crashAfterDisconnect(hub, new FakeRouting(true));
    assert.deepEqual(await restart(hub), [new Date(earlierStop - 10_000).toISOString()]);
});

test('an aborted drain that never disconnected intake owes no replay', async () => {
    const routing = new FakeRouting(true);
    const hints = hintStore();
    const hub = new Hub();
    const { ctx } = context(hub, routing, { ...hints });
    // The drain request cannot be recorded: abort before intake is stopped.
    (ctx.redis as unknown as { set: () => Promise<never> }).set = async () => { throw new Error('READONLY'); };
    assert.equal(await drainIdleControlPlane(request, ctx), false);
    assert.deepEqual(routing.calls, ['wake_hint']);
    assert.equal(hints.store.current, null);
});

test('in a composed process the participants only acknowledge and the daemon runs the coordinated close', async () => {
    const hub = new Hub();
    const signals: string[] = [];
    const onSignal = () => { signals.push('SIGTERM'); };
    process.on('SIGTERM', onSignal);
    setIdleShutdownComposedProcess(true);
    try {
        const listeners = ['api', 'worker'].map(role => startIdleShutdownListener({
            role: role as 'api' | 'worker', id: `${role}-composed`, createConnection: hub.connect, pollMs: 10, onQuiesce: async () => undefined,
        }));
        const stops: string[] = [];
        let closed = 0;
        const { ctx, exits } = context(hub, new FakeRouting(true));
        const started = Date.now();
        assert.equal(await drainIdleControlPlane(request, { ...ctx, close: async () => { closed += 1; }, stopProcess: () => { stops.push('coordinated close'); } }), true);
        assert.ok(Date.now() - started < TIMINGS.deregisterWaitMs, 'it does not wait for participants in its own process to deregister');
        assert.deepEqual(stops, ['coordinated close']);
        assert.deepEqual(exits, [], 'the coordinated close exits, not the daemon');
        assert.equal(closed, 0);
        assert.deepEqual(signals, []);
        assert.equal(hub.strings.has(IDLE_SHUTDOWN_INTENT_REDIS_KEY), false);
        await Promise.all(listeners.map(listener => listener.stop()));
    } finally {
        setIdleShutdownComposedProcess(false);
        process.off('SIGTERM', onSignal);
    }
});

/** The daemon's sweeps as the drain sees them. */
function fakeProducers(events: string[], stillRunning: string[] = []) {
    return {
        pause: async () => { events.push('sweeps paused'); return stillRunning; },
        resume: () => { events.push('sweeps resumed'); },
    };
}

/** A worker that lost its Redis connection before the stop request: it sees (and acknowledges) it only after `reconnect()`. */
function stragglerWorker(hub: Hub, events: string[]) {
    let listener: ReturnType<typeof startIdleShutdownListener>;
    listener = startIdleShutdownListener({
        role: 'worker',
        id: 'worker-straggler',
        createConnection: hub.connect,
        pollMs: 10,
        onShutdown: () => { events.push('worker stopping'); void listener.stop(); },
    });
    const connections = hub.connections.slice(-2);
    for (const connection of connections) connection.connected = false;
    return { reconnect: () => { for (const connection of connections) connection.connected = true; }, stop: () => listener.stop() };
}

test('the daemon\'s own sweeps are paused before the last check and resumed when the drain aborts', async () => {
    const hub = new Hub();
    const events: string[] = [];
    const api = apiProcess(hub, events);
    const { ctx, exits } = context(hub, new FakeRouting(true), {
        collect: async () => { events.push('re-check'); return { ...emptyIdleSignals(), httpRequests: 1 }; },
    });
    assert.equal(await drainIdleControlPlane(request, { ...ctx, producers: fakeProducers(events) }), false);
    await settle();
    assert.deepEqual(events.slice(0, 3), ['sweeps paused', 'api quiesced', 're-check'], 'paused before anything else is quiesced');
    assert.ok(events.includes('sweeps resumed'));
    assert.deepEqual(exits, []);
    await api.stop();
});

test('a daemon sweep that does not finish its run in progress aborts the drain before anything is stopped', async () => {
    const hub = new Hub();
    const events: string[] = [];
    const routing = new FakeRouting(true);
    const { ctx, exits } = context(hub, routing, { collect: async () => { events.push('re-check'); return emptyIdleSignals(); } });
    assert.equal(await drainIdleControlPlane(request, { ...ctx, producers: fakeProducers(events, ['auto-merge sweep']) }), false);
    assert.deepEqual(events, ['sweeps paused', 'sweeps resumed']);
    assert.deepEqual(routing.calls, ['wake_hint'], 'intake stays connected');
    assert.equal(hub.strings.has(IDLE_SHUTDOWN_INTENT_REDIS_KEY), false);
    assert.deepEqual(exits, []);
});

test('a stop acknowledgement held past an automation deadline does not end in exit 0 with the run left behind', async () => {
    const hub = new Hub();
    const events: string[] = [];
    const api = apiProcess(hub, events);
    const straggler = stragglerWorker(hub, events);
    const routing = new FakeRouting(true);
    const hints = hintStore();
    const dueAt = Date.now() + 2_000;
    const automation = { kind: 'automation' as const, dueAt, detail: 'scheduled automation' };
    // The daemon's scheduler: running, it queues the automation's run once due.
    const queued: string[] = [];
    const producers = createDaemonWorkProducers({ error: () => undefined });
    producers.add('agent run sweeps', () => {
        const timer = setInterval(() => { if (Date.now() >= dueAt && queued.length === 0) queued.push('automation run'); }, 10);
        return async () => { clearInterval(timer); };
    });
    // Due beyond the idle window, so the drain goes ahead and Connect accepts that deadline as its wake.
    const idleBeforeAutomation = { ...request, evaluation: { ...request.evaluation, nextDueAt: dueAt, nextDue: [automation] }, config: { ...config, afterMs: 200 } };
    const { ctx, exits } = context(hub, routing, { ...hints, collect: async () => ({ ...emptyIdleSignals(), scheduled: [automation] }) });
    const timings = { ...TIMINGS, stopConfirmTimeoutMs: 60_000, quiesceTimeoutMs: 300, deregisterWaitMs: 300, closeDeadlineMs: 300 };

    assert.equal(await drainIdleControlPlane(idleBeforeAutomation, { ...ctx, producers, timings }), true);
    assert.ok(Date.now() < dueAt, 'decided before the wake Connect accepted');
    assert.deepEqual(exits, [1], 'the stop is called off: an on-failure supervisor starts the control plane again, and the start runs the automation');
    assert.ok(events.includes('api stopping'));
    assert.equal(hub.strings.has(IDLE_SHUTDOWN_INTENT_REDIS_KEY), false, 'the stop request is withdrawn');
    assert.ok(hints.store.current!.wokeAt, 'the start is not counted as a wake from an idle stop');
    assert.equal(hints.store.current!.connectReplay, 'pending', 'it still asks Connect for the deliveries cached since intake disconnected');

    // The deadline passes while the worker is still disconnected; then it reconnects.
    await new Promise(resolve => setTimeout(resolve, dueAt - Date.now() + 50));
    assert.deepEqual(queued, [], 'the scheduler, paused before the last check, queued nothing while the stop ran');
    straggler.reconnect();
    await new Promise(resolve => setTimeout(resolve, 100));
    assert.ok(!events.includes('worker stopping'), 'the called-off stop does not stop it');
    assert.deepEqual(exits, [1], 'and the daemon never exits 0');
    await straggler.stop();
    await api.stop();
    await producers.stop();
});

test('work queued while the processes stopped, or due with no wake arranged for it, calls the stop off instead of exit 0', async () => {
    const lateRun = { kind: 'automation' as const, dueAt: Date.now() + 60 * 60_000, detail: 'scheduled automation' };
    const cases: Array<[string, IdleSignals]> = [
        ['a job queued by a process before it acknowledged', { ...emptyIdleSignals(), queues: [{ name: 'tasks', waiting: 1, active: 0, prioritized: 0, waitingChildren: 0, paused: 0 }] }],
        ['an automation scheduled during the stop', { ...emptyIdleSignals(), scheduled: [lateRun] }],
        ['work signals that cannot be read', { ...emptyIdleSignals(), unavailable: ['BullMQ queues'] }],
    ];
    for (const [label, work] of cases) {
        const hub = new Hub();
        const events: string[] = [];
        apiProcess(hub, events);
        workerProcess(hub, events);
        const hints = hintStore();
        const { ctx, exits } = context(hub, null, { ...hints });
        const collectWork = async () => { events.push('work check'); return work; };
        assert.equal(await drainIdleControlPlane(request, { ...ctx, collectWork }), true, label);
        assert.deepEqual(exits, [1], label);
        assert.equal(events.at(-1), 'work check', `${label}: checked once every process stopped`);
        assert.ok(events.includes('worker stopping'), label);
        assert.equal(hub.strings.has(IDLE_SHUTDOWN_INTENT_REDIS_KEY), false, label);
        assert.ok(hints.store.current!.wokeAt, label);
    }
});

test('scheduled work due at or after the wake that was arranged does not call the stop off', async () => {
    const hub = new Hub();
    apiProcess(hub, []);
    workerProcess(hub, []);
    const automation = { kind: 'automation' as const, dueAt: Date.now() + 60 * 60_000, detail: 'scheduled automation' };
    const hinted = { ...request, evaluation: { ...request.evaluation, nextDueAt: automation.dueAt, nextDue: [automation] } };
    const signals = async () => ({ ...emptyIdleSignals(), scheduled: [automation] });
    const { ctx, exits } = context(hub, new FakeRouting(true), { collect: signals });
    assert.equal(await drainIdleControlPlane(hinted, { ...ctx, collectWork: signals }), true);
    assert.deepEqual(exits, [0]);
});

test('scheduled work due too soon for the stop to finish before it aborts the drain before anything is stopped', async () => {
    const hub = new Hub();
    const events: string[] = [];
    const api = apiProcess(hub, events);
    const worker = workerProcess(hub, events);
    const routing = new FakeRouting(true);
    const automation = { kind: 'automation' as const, dueAt: Date.now() + 1_500, detail: 'scheduled automation' };
    const soon = { ...request, evaluation: { ...request.evaluation, nextDueAt: automation.dueAt, nextDue: [automation] }, config: { ...config, afterMs: 200 } };
    const { ctx, exits } = context(hub, routing, { collect: async () => ({ ...emptyIdleSignals(), scheduled: [automation] }) });
    // The deregistration wait and the close alone could take until the automation is due.
    const timings = { ...TIMINGS, deregisterWaitMs: 1_000, closeDeadlineMs: 1_000 };
    assert.equal(await drainIdleControlPlane(soon, { ...ctx, timings, producers: fakeProducers(events) }), false);
    await settle();
    assert.ok(!events.includes('worker stopping') && !events.includes('api stopping'));
    assert.ok(events.includes('sweeps resumed'));
    assert.deepEqual(routing.calls, ['wake_hint', 'stop', 'start', 'replay']);
    assert.deepEqual(exits, []);
    await api.stop();
    await worker.stop();
});

test('in a composed process a called-off stop runs the coordinated close with exit 1', async () => {
    const hub = new Hub();
    setIdleShutdownComposedProcess(true);
    try {
        const listeners = ['api', 'worker'].map(role => startIdleShutdownListener({
            role: role as 'api' | 'worker', id: `${role}-composed`, createConnection: hub.connect, pollMs: 10, onQuiesce: async () => undefined,
        }));
        const stops: number[] = [];
        const { ctx, exits } = context(hub, new FakeRouting(true));
        const collectWork = async () => ({ ...emptyIdleSignals(), queues: [{ name: 'tasks', waiting: 1, active: 0, prioritized: 0, waitingChildren: 0, paused: 0 }] });
        assert.equal(await drainIdleControlPlane(request, { ...ctx, collectWork, stopProcess: code => { stops.push(code); } }), true);
        assert.deepEqual(stops, [1]);
        assert.deepEqual(exits, []);
        await Promise.all(listeners.map(listener => listener.stop()));
    } finally {
        setIdleShutdownComposedProcess(false);
    }
});

/** An all-in-one process: its API and worker only acknowledge; `stopProcess` is its one coordinated close. */
async function composedProcess(hub: Hub, run: (events: string[]) => Promise<void>) {
    setIdleShutdownComposedProcess(true);
    const events: string[] = [];
    const listeners = ['api', 'worker'].map(role => startIdleShutdownListener({
        role: role as 'api' | 'worker', id: `${role}-composed`, createConnection: hub.connect, pollMs: 10,
        onQuiesce: async () => { events.push(`${role} quiesced`); },
        onShutdown: () => { events.push(`${role} acknowledged the stop`); },
    }));
    try {
        await run(events);
    } finally {
        await Promise.all(listeners.map(listener => listener.stop()));
        setIdleShutdownComposedProcess(false);
    }
}

test('a process outside the all-in-one process that registered while draining aborts before anything is asked to stop', async () => {
    const hub = new Hub();
    await composedProcess(hub, async events => {
        const routing = new FakeRouting(true);
        const hints = hintStore();
        const stops: number[] = [];
        const { ctx } = context(hub, routing, {
            ...hints,
            // A separately run indexing worker starts while the API is quiesced: it would exit 0 on its own.
            collect: async () => {
                hub.hashes.get(IDLE_PARTICIPANTS_REDIS_KEY)!.set('indexing_worker:indexer:7', JSON.stringify({
                    role: 'indexing_worker', id: 'indexer:7', host: 'indexer', pid: 7, pidNamespace: null, bootId: null, startedAt: Date.now(), seenAt: Date.now(),
                }));
                return emptyIdleSignals();
            },
        });
        assert.equal(await drainIdleControlPlane(request, { ...ctx, stopProcess: code => { stops.push(code); } }), false);
        await settle();
        assert.deepEqual(stops, [], 'nothing is closed');
        assert.ok(!events.some(event => event.endsWith('acknowledged the stop')), 'no process was asked to stop');
        assert.equal(hub.strings.has(IDLE_SHUTDOWN_INTENT_REDIS_KEY), false);
        assert.equal(hub.strings.has(IDLE_LAST_SHUTDOWN_REDIS_KEY), false, 'no shutdown is recorded for a stop that never started');
        assert.deepEqual(routing.calls, ['wake_hint', 'stop', 'start', 'replay'], 'Connect intake resumes');
        assert.ok(hints.store.current!.wokeAt, 'the next plain start is not counted as a wake');
    });
});

/** Scheduled work beyond the idle window, so the drain goes ahead with Connect's wake at `dueAt`. */
function stopBeforeAutomation(dueInMs: number) {
    const dueAt = Date.now() + dueInMs;
    const automation = { kind: 'automation' as const, dueAt, detail: 'scheduled automation' };
    return {
        dueAt,
        request: { ...request, evaluation: { ...request.evaluation, nextDueAt: dueAt, nextDue: [automation] }, config: { ...config, afterMs: 200 } },
        collect: async () => ({ ...emptyIdleSignals(), scheduled: [automation] }),
        timings: { ...TIMINGS, stopConfirmTimeoutMs: 60_000, quiesceTimeoutMs: 300, deregisterWaitMs: 300, closeDeadlineMs: 300 },
    };
}

test('a stop acknowledgement read only after confirmBy calls the stop off: exit 1 before the wake, not exit 0 after it', { timeout: 10_000 }, async () => {
    const hub = new Hub();
    await composedProcess(hub, async events => {
        const stop = stopBeforeAutomation(2_000);
        const confirmBy = stop.dueAt - stop.timings.deregisterWaitMs - stop.timings.closeDeadlineMs;
        const { ctx } = context(hub, new FakeRouting(true), { collect: stop.collect });
        // Every process acknowledges at once, but the daemon's read of the acknowledgements answers only after confirmBy.
        const read = (ctx.redis as unknown as Connection).hgetall.bind(ctx.redis);
        (ctx.redis as unknown as Connection).hgetall = async (key: string) => {
            const phase = JSON.parse(hub.strings.get(IDLE_SHUTDOWN_INTENT_REDIS_KEY) ?? '{}').phase;
            if (key.startsWith(IDLE_SHUTDOWN_ACKS_REDIS_PREFIX) && phase === 'stop') await new Promise(resolve => setTimeout(resolve, confirmBy + 100 - Date.now()));
            return read(key);
        };
        const stops: Array<[number, number | null]> = [];
        assert.equal(await drainIdleControlPlane(stop.request, { ...ctx, timings: stop.timings, stopProcess: (code, options) => { stops.push([code, options?.exitBy ?? null]); } }), true);
        assert.ok(events.includes('worker acknowledged the stop'));
        assert.deepEqual(stops, [[1, null]], 'called off: the supervisor starts the process again for the automation');
        assert.ok(Date.now() < stop.dueAt, 'decided before the wake');
    });
});

test('a last check for work not over in time for the close to end before the wake calls the stop off', { timeout: 10_000 }, async () => {
    const hub = new Hub();
    await composedProcess(hub, async () => {
        const stop = stopBeforeAutomation(2_000);
        const { ctx } = context(hub, new FakeRouting(true), { collect: stop.collect });
        const stops: number[] = [];
        const collectWork = () => new Promise<IdleSignals>(() => undefined);
        assert.equal(await drainIdleControlPlane(stop.request, { ...ctx, collectWork, timings: stop.timings, stopProcess: code => { stops.push(code); } }), true);
        assert.deepEqual(stops, [1]);
        assert.ok(Date.now() <= stop.dueAt - stop.timings.closeDeadlineMs + 100, 'the close still had its allowance before the wake');
    });
});

test('the wake arranged for the stop is the deadline of the all-in-one close', { timeout: 10_000 }, async () => {
    const hub = new Hub();
    await composedProcess(hub, async () => {
        const stop = stopBeforeAutomation(2_000);
        const { ctx } = context(hub, new FakeRouting(true), { collect: stop.collect });
        const stops: Array<[number, number | null]> = [];
        assert.equal(await drainIdleControlPlane(stop.request, { ...ctx, timings: stop.timings, stopProcess: (code, options) => { stops.push([code, options?.exitBy ?? null]); } }), true);
        assert.deepEqual(stops, [[0, stop.dueAt]], 'exit 0, but only before the wake; the bounded close exits 1 if it is still running then');
    });
    // Without scheduled work nothing bounds it beyond its own deadline.
    await composedProcess(new Hub(), async () => {
        const stops: Array<[number, number | null]> = [];
        const { ctx } = context(new Hub(), new FakeRouting(true));
        assert.equal(await drainIdleControlPlane(request, { ...ctx, stopProcess: (code, options) => { stops.push([code, options?.exitBy ?? null]); } }), true);
        assert.deepEqual(stops, [[0, null]]);
    });
});

test('a standalone daemon close still running at the arranged wake exits 1, not 0', async () => {
    const record = { shutdownAt: new Date().toISOString(), reason: 'idle', idleForMs: 0, nextDueAt: null };
    const exits: number[] = [];
    const started = Date.now();
    await stopDaemonProcess({ close: () => new Promise<void>(() => undefined), exit: code => { exits.push(code); } }, record, { closeDeadlineMs: 5_000, exitCode: 0, wakeAt: started + 50 });
    assert.deepEqual(exits, [1]);
    assert.ok(Date.now() - started < 2_000, 'at the wake, not at the 5 s close deadline');

    const clean: number[] = [];
    await stopDaemonProcess({ close: async () => undefined, exit: code => { clean.push(code); } }, record, { closeDeadlineMs: 5_000, exitCode: 0, wakeAt: Date.now() + 5_000 });
    assert.deepEqual(clean, [0], 'closed before the wake');
});

test('a standalone daemon whose log flush runs through the arranged wake exits 1, not the 0 chosen before the flush', async () => {
    const record = { shutdownAt: new Date().toISOString(), reason: 'idle', idleForMs: 0, nextDueAt: null };
    const exits: number[] = [];
    const flushes: Array<number | undefined> = [];
    const wakeAt = Date.now() + 60;
    // The close ends in time, so exit 0 is chosen; the flush then ignores the time it was given and resolves after the wake.
    const flush = (timeoutMs?: number) => { flushes.push(timeoutMs); return new Promise<void>(resolve => setTimeout(resolve, 150)); };
    await stopDaemonProcess({ close: async () => undefined, exit: code => { exits.push(code); } }, record, { closeDeadlineMs: 5_000, exitCode: 0, wakeAt, flush });
    assert.deepEqual(exits, [1], 'the wake reached a running daemon: the supervisor must start it again');
    assert.equal(flushes.length, 1);
    assert.ok(flushes[0] !== undefined && flushes[0] <= 60, 'the flush was only given the time left until the wake');

    // A called-off stop (exit 1, no wake) is not re-coded by a slow flush, nor is an exit 0 with no wake arranged.
    const codes: number[] = [];
    await stopDaemonProcess({ close: async () => undefined, exit: code => { codes.push(code); } }, record, { closeDeadlineMs: 5_000, exitCode: 1, wakeAt: null, flush });
    await stopDaemonProcess({ close: async () => undefined, exit: code => { codes.push(code); } }, record, { closeDeadlineMs: 5_000, exitCode: 0, wakeAt: null, flush });
    assert.deepEqual(codes, [1, 0]);
});

test('a stop called off while Redis stays unresponsive still reaches the bounded exit 1 instead of staying quiesced', { timeout: 10_000 }, async () => {
    const hub = new Hub();
    const events: string[] = [];
    const api = apiProcess(hub, events);
    workerProcess(hub, events, { acknowledges: false });
    const { ctx, exits } = context(hub, null);
    // From the first read of the stop acknowledgements on, the daemon's Redis connection stops answering: that read,
    // and every command after it (the withdrawal's get, del and publish included), stays pending.
    const connection = ctx.redis as unknown as Connection;
    const stopStored = () => JSON.parse(hub.strings.get(IDLE_SHUTDOWN_INTENT_REDIS_KEY) ?? '{}').phase === 'stop';
    let down = false;
    const hang = <T extends (...args: never[]) => Promise<unknown>>(method: T, ackRead = false): T => ((...args: never[]) => {
        if (ackRead && stopStored() && String(args[0]).startsWith(IDLE_SHUTDOWN_ACKS_REDIS_PREFIX)) down = true;
        return down ? new Promise(() => undefined) : method.apply(connection, args);
    }) as T;
    for (const name of ['get', 'set', 'del', 'publish', 'hgetall', 'hdel'] as const) {
        (connection as unknown as Record<string, unknown>)[name] = hang(connection[name].bind(connection) as never, name === 'hgetall');
    }
    const stopConfirmTimeoutMs = 300;
    const closeDeadlineMs = 300;
    const started = Date.now();
    assert.equal(await drainIdleControlPlane(request, { ...ctx, timings: { ...TIMINGS, stopConfirmTimeoutMs, closeDeadlineMs } }), true);
    assert.deepEqual(exits, [1], 'the supervisor starts the control plane again');
    assert.ok(Date.now() - started < stopConfirmTimeoutMs + 2 * closeDeadlineMs + 1_000, `exited within the acknowledgement timeout plus the bounded clean-up and close, not never (took ${Date.now() - started}ms)`);
    assert.ok(events.includes('api stopping'));
    assert.equal(down, true, 'Redis went away at the acknowledgement read');
    assert.equal(stopStored(), true, 'the withdrawal never completed: the request is left to expire on its own');
    await api.stop();
});

test('direct webhook intake with future scheduled work and no external scheduled wake keeps running: a due time in the hint file wakes nothing', async () => {
    const hub = new Hub();
    const events: string[] = [];
    const api = apiProcess(hub, events);
    const worker = workerProcess(hub, events);
    // Due long after the idle window, so the window alone would let the drain go ahead.
    const automation = { kind: 'automation' as const, dueAt: Date.now() + 6 * 60 * 60_000, detail: 'scheduled automation' };
    const later = { ...request, evaluation: { ...request.evaluation, nextDueAt: automation.dueAt, nextDue: [automation] } };
    const signals = async () => ({ ...emptyIdleSignals(), scheduled: [automation] });
    const hints = hintStore();
    const { ctx, exits } = context(hub, null, { ...hints, collect: signals });
    assert.equal(await drainIdleControlPlane(later, { ...ctx, collectWork: signals, producers: fakeProducers(events) }), false);
    await settle();
    assert.ok(!events.includes('worker stopping') && !events.includes('api stopping'), 'nothing is asked to stop');
    assert.ok(events.includes('api resumed') && events.includes('sweeps resumed'));
    assert.equal(hints.store.current, null, 'no stop hint is written');
    assert.equal(hub.strings.has(IDLE_SHUTDOWN_INTENT_REDIS_KEY), false);
    assert.deepEqual(exits, []);

    // The operator's own scheduler starts the instance from the hint file: then it may stop, waking at the due time.
    const { ctx: external, exits: externalExits } = context(hub, null, { ...hints, collect: signals });
    assert.equal(await drainIdleControlPlane(later, { ...external, collectWork: signals, externalScheduledWake: true }), true);
    assert.deepEqual(externalExits, [0]);
    assert.equal(hints.store.current!.shutdownAt !== undefined, true);
    await api.stop();
    await worker.stop();
});

test('a last check for work left pending after the API quiesced aborts at the drain timeout and restores intake, the sweeps and the API', { timeout: 10_000 }, async () => {
    const hub = new Hub();
    const events: string[] = [];
    const api = apiProcess(hub, events);
    const worker = workerProcess(hub, events);
    const routing = new FakeRouting(true);
    // The daemon's Redis command behind the collection never answers.
    const { ctx, exits } = context(hub, routing, { collect: () => { events.push('re-check'); return new Promise<IdleSignals>(() => undefined); } });
    const drainTimeoutMs = 400;
    const started = Date.now();
    assert.equal(await drainIdleControlPlane(request, { ...ctx, producers: fakeProducers(events), timings: { ...TIMINGS, drainTimeoutMs, closeDeadlineMs: 300 } }), false);
    assert.ok(Date.now() - started < drainTimeoutMs + 1_000, `ended at the drain timeout, not never (took ${Date.now() - started}ms)`);
    await new Promise(resolve => setTimeout(resolve, 50));
    assert.ok(events.indexOf('api quiesced') < events.indexOf('re-check'), 'the check was pending after quiescence');
    assert.ok(events.includes('api resumed'), 'the API admits requests again');
    assert.ok(events.includes('sweeps resumed'), 'the daemon sweeps run again');
    assert.deepEqual(routing.calls, ['wake_hint', 'stop', 'start', 'replay'], 'intake reconnects and asks for what was cached meanwhile');
    assert.ok(!events.includes('worker stopping'));
    assert.deepEqual(exits, []);
    await api.stop();
    await worker.stop();
});

test('an aborted drain whose intake cannot reconnect in time exits 1 instead of staying up with intake down', { timeout: 10_000 }, async () => {
    const hub = new Hub();
    const events: string[] = [];
    const api = apiProcess(hub, events);
    const routing = new FakeRouting(true);
    routing.start = () => { routing.calls.push('start'); return new Promise<void>(() => undefined); };
    const { ctx, exits } = context(hub, routing, { collect: () => new Promise<IdleSignals>(() => undefined) });
    const started = Date.now();
    assert.equal(await drainIdleControlPlane(request, { ...ctx, producers: fakeProducers(events), timings: { ...TIMINGS, drainTimeoutMs: 300, closeDeadlineMs: 300 } }), true);
    assert.deepEqual(exits, [1], 'the supervisor starts the control plane again');
    assert.ok(Date.now() - started < 300 + 2 * 300 + 1_000, `bounded (took ${Date.now() - started}ms)`);
    assert.ok(events.includes('sweeps resumed'));
    await api.stop();
});

/** A write that stays pending until `release()`: the disk hangs. */
function heldWrite() {
    let release: () => void = () => undefined;
    const held = new Promise<void>(resolve => { release = resolve; });
    return { held, release: () => release() };
}

test('a replay obligation recorded only after the drain gave up does not disconnect the restored intake', { timeout: 10_000 }, async () => {
    const hub = new Hub();
    const events: string[] = [];
    const api = apiProcess(hub, events);
    const routing = new FakeRouting(true);
    const hints = hintStore();
    const disk = heldWrite();
    // The record owed before the disconnect is written only after the drain deadline.
    const { ctx, exits } = context(hub, routing, { ...hints, writeHint: async hint => { await disk.held; await hints.writeHint(hint); } });
    assert.equal(await drainIdleControlPlane(request, { ...ctx, producers: fakeProducers(events), timings: { ...TIMINGS, drainTimeoutMs: 200, closeDeadlineMs: 300 } }), false);
    assert.deepEqual(routing.calls, ['wake_hint'], 'intake was never disconnected, so nothing reconnects it');
    disk.release();
    await new Promise(resolve => setTimeout(resolve, 100));
    assert.deepEqual(routing.calls, ['wake_hint'], 'the late record does not disconnect the instance that kept running');
    assert.ok(events.includes('sweeps resumed'));
    assert.ok(!events.includes('api quiesced') || events.includes('api resumed'), 'the API admits requests');
    assert.equal(hub.strings.has(IDLE_SHUTDOWN_INTENT_REDIS_KEY), false);
    assert.deepEqual(exits, []);
    await api.stop();
});

test('a stop hint written only after the drain gave up does not make the next plain start look like a wake', { timeout: 10_000 }, async () => {
    const hub = new Hub();
    const events: string[] = [];
    const api = apiProcess(hub, events);
    const hints = hintStore();
    const disk = heldWrite();
    // Direct intake: the stop's hint is the first write, and it lands after the drain deadline.
    const { ctx, exits } = context(hub, null, { ...hints, writeHint: async hint => { await disk.held; await hints.writeHint(hint); } });
    assert.equal(await drainIdleControlPlane(request, { ...ctx, timings: { ...TIMINGS, drainTimeoutMs: 300, closeDeadlineMs: 300 } }), false);
    assert.ok(events.includes('api quiesced'), 'the drain reached the hint write');
    disk.release();
    await new Promise(resolve => setTimeout(resolve, 50));
    assert.ok(hints.store.current === null || hints.store.current.wokeAt, 'no unconsumed stop hint is left behind');
    assert.equal(hub.strings.has(IDLE_SHUTDOWN_INTENT_REDIS_KEY), false);
    assert.deepEqual(exits, []);
    await api.stop();
});

test('a quiesce wait outliving the drain deadline does not store the withdrawn drain request again', { timeout: 10_000 }, async () => {
    const hub = new Hub();
    const events: string[] = [];
    let release: () => void = () => undefined;
    const quiescing = new Promise<void>(resolve => { release = resolve; });
    // An API process that cannot confirm it is quiesced (its in-flight requests do not finish).
    const listener = startIdleShutdownListener({
        role: 'api', id: 'api-slow', createConnection: hub.connect, pollMs: 10,
        onQuiesce: async () => { events.push('api quiescing'); await quiescing; },
        onResume: () => { events.push('api resumed'); },
    });
    const { ctx, exits } = context(hub, null);
    // The quiesce wait's own timeout is far beyond the drain deadline, so it is still polling (and re-storing) when the drain aborts.
    assert.equal(await drainIdleControlPlane(request, { ...ctx, timings: { ...TIMINGS, quiesceTimeoutMs: 5_000, drainTimeoutMs: 200, closeDeadlineMs: 300 } }), false);
    assert.ok(events.includes('api quiescing'));
    assert.equal(hub.strings.has(IDLE_SHUTDOWN_INTENT_REDIS_KEY), false, 'withdrawn');
    await new Promise(resolve => setTimeout(resolve, 150));
    assert.equal(hub.strings.has(IDLE_SHUTDOWN_INTENT_REDIS_KEY), false, 'not stored again by the abandoned wait: the API is not re-quiesced');
    assert.deepEqual(exits, []);
    release();
    await listener.stop();
});

/** Run `drain` with a mocked clock, advancing it until it settles: production timings take minutes. */
async function withMockedClock<T>(drain: () => Promise<T>): Promise<{ value: T; elapsedMs: number }> {
    mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'], now: Date.now() });
    const started = Date.now();
    try {
        let settled: { value: T } | null = null;
        let failed: unknown = null;
        drain().then(value => { settled = { value }; }, (error: unknown) => { failed = error ?? new Error('rejected'); });
        for (let step = 0; step < 4_000 && !settled && !failed; step += 1) {
            for (let i = 0; i < 5; i += 1) await new Promise(resolve => setImmediate(resolve));
            mock.timers.tick(250);
        }
        if (failed) throw failed;
        assert.ok(settled, 'the drain settled within 1000 s of mocked time');
        return { value: (settled as { value: T }).value, elapsedMs: Date.now() - started };
    } finally {
        mock.timers.reset();
    }
}

test('the production stop confirmation is bounded', () => {
    assert.equal(typeof DEFAULT_IDLE_DRAIN_TIMINGS.stopConfirmTimeoutMs, 'number');
    assert.ok(Number.isFinite(DEFAULT_IDLE_DRAIN_TIMINGS.stopConfirmTimeoutMs) && DEFAULT_IDLE_DRAIN_TIMINGS.stopConfirmTimeoutMs > 0);
});

test('with production timings and nothing scheduled, Redis going away during the stop wait still reaches the bounded exit 1', { timeout: 60_000 }, async () => {
    const hub = new Hub();
    const events: string[] = [];
    const api = apiProcess(hub, events);
    workerProcess(hub, events, { acknowledges: false });
    const { ctx, exits } = context(hub, null);
    const connection = ctx.redis as unknown as Connection;
    const stopStored = () => JSON.parse(hub.strings.get(IDLE_SHUTDOWN_INTENT_REDIS_KEY) ?? '{}').phase === 'stop';
    let down = false;
    const hang = <F extends (...args: never[]) => Promise<unknown>>(method: F, ackRead = false): F => ((...args: never[]) => {
        if (ackRead && stopStored() && String(args[0]).startsWith(IDLE_SHUTDOWN_ACKS_REDIS_PREFIX)) down = true;
        return down ? new Promise(() => undefined) : method.apply(connection, args);
    }) as F;
    for (const name of ['get', 'set', 'del', 'publish', 'hgetall', 'hdel'] as const) {
        (connection as unknown as Record<string, unknown>)[name] = hang(connection[name].bind(connection) as never, name === 'hgetall');
    }
    // Production timings: no override at all.
    const { value, elapsedMs } = await withMockedClock(() => drainIdleControlPlane(request, { ...ctx, timings: {} }));
    assert.equal(value, true);
    assert.equal(down, true, 'Redis went away at the acknowledgement read');
    assert.deepEqual(exits, [1], 'called off: the supervisor starts the control plane again');
    const { stopConfirmTimeoutMs, closeDeadlineMs } = DEFAULT_IDLE_DRAIN_TIMINGS;
    assert.ok(elapsedMs <= stopConfirmTimeoutMs + 2 * closeDeadlineMs + 5_000, `bounded by the confirmation timeout and the clean-up (took ${elapsedMs} ms)`);
    await api.stop();
});

test('with production timings and nothing scheduled, a last check for work that never settles calls the stop off', { timeout: 60_000 }, async () => {
    const hub = new Hub();
    const events: string[] = [];
    const api = apiProcess(hub, events);
    const worker = workerProcess(hub, events);
    const { ctx, exits } = context(hub, null);
    const collectWork = () => new Promise<IdleSignals>(() => undefined);
    const { value, elapsedMs } = await withMockedClock(() => drainIdleControlPlane(request, { ...ctx, collectWork, timings: {} }));
    assert.equal(value, true);
    assert.ok(events.includes('worker stopping'), 'every process acknowledged the stop');
    assert.deepEqual(exits, [1], 'not 0 without the check, and not never');
    const { stopConfirmTimeoutMs, deregisterWaitMs, closeDeadlineMs } = DEFAULT_IDLE_DRAIN_TIMINGS;
    assert.ok(elapsedMs <= deregisterWaitMs + stopConfirmTimeoutMs + 2 * closeDeadlineMs + 5_000, `bounded (took ${elapsedMs} ms)`);
    await api.stop();
    await worker.stop();
});

/** The quiesced API's answer to a request (the real middleware). */
function requestThroughApi(middleware: ReturnType<typeof createIdleActivityMiddleware>) {
    const answer = { status: 0, retryAfter: null as string | null, admitted: false };
    const onEnd: Array<() => void> = [];
    const res = {
        setHeader: (name: string, value: string) => { if (name === 'Retry-After') answer.retryAfter = value; },
        status: (code: number) => { answer.status = code; return res; },
        json: () => res,
        once: (_event: string, listener: () => void) => { onEnd.push(listener); return res; },
    };
    middleware({ path: '/api/status' } as never, res as never, () => { answer.admitted = true; });
    // An admitted request is answered at once: it must not stay in flight for the next test.
    for (const end of onEnd) end();
    return answer;
}

/**
 * The all-in-one wiring for API activity: the real API integration (middleware, activity publisher, drain listener)
 * on the process-wide tracker, a worker, and the daemon's activity sources (Redis records and this process's tracker).
 */
async function composedWithApi(run: (setup: { hub: Hub; events: string[]; middleware: ReturnType<typeof createIdleActivityMiddleware>; collectActivity: () => Promise<IdleSignals>; idleSince: number }) => Promise<void>) {
    setIdleShutdownComposedProcess(true);
    const hub = new Hub();
    const events: string[] = [];
    // Anything an earlier test left on the process-wide tracker predates this idle period.
    await new Promise(resolve => setTimeout(resolve, 5));
    const idleSince = Date.now();
    const stopApi = startApiIdleShutdown({ redis: hub.connect() as never, countSessions: () => 0 });
    const worker = startIdleShutdownListener({
        role: 'worker', id: 'worker-composed', createConnection: hub.connect, pollMs: 10,
        onShutdown: () => { events.push('worker acknowledged the stop'); },
    });
    const sources = createDaemonActivitySources({ redis: hub.connect() as never });
    try {
        await run({ hub, events, middleware: createIdleActivityMiddleware(() => null), collectActivity: () => collectIdleSignals(sources), idleSince });
    } finally {
        await worker.stop();
        await stopApi();
        setIdleShutdownComposedProcess(false);
    }
}

test('a request the quiesced API turns away while the stop hint is written aborts the drain before any process is asked to stop', async () => {
    await composedWithApi(async ({ hub, events, middleware, collectActivity, idleSince }) => {
        const routing = new FakeRouting(true);
        const hints = hintStore();
        let writes = 0;
        let answer: ReturnType<typeof requestThroughApi> | null = null;
        const stops: number[] = [];
        const { ctx, exits } = context(hub, routing, {
            // Step 3 reads the same activity: quiet, so the drain goes on to write the stop's hint.
            collect: collectActivity,
            readHint: hints.readHint,
            writeHint: async hint => {
                writes += 1;
                // The second write is the stop's hint (the first records the replay owed before the disconnect).
                if (writes === 2) {
                    events.push('stop hint written');
                    answer = requestThroughApi(middleware);
                }
                await hints.writeHint(hint);
            },
        });
        const quiet = { ...request, idleSince };
        assert.equal(await drainIdleControlPlane(quiet, { ...ctx, collectWork: async () => emptyIdleSignals(), collectActivity, stopProcess: code => { stops.push(code); } }), false);
        await settle();
        assert.deepEqual(answer, { status: 503, retryAfter: '5', admitted: false }, 'the request reached the quiesced API while the hint was written');
        assert.deepEqual(stops, [], 'nothing is closed');
        assert.deepEqual(exits, []);
        assert.ok(!events.includes('worker acknowledged the stop'), 'no process was asked to stop');
        assert.equal(hub.strings.has(IDLE_SHUTDOWN_INTENT_REDIS_KEY), false);
        assert.equal(hub.strings.has(IDLE_LAST_SHUTDOWN_REDIS_KEY), false, 'no shutdown is recorded for a stop that never started');
        assert.deepEqual(routing.calls, ['wake_hint', 'stop', 'start', 'replay'], 'Connect intake resumes');
        assert.equal(idleActivity.quiescedIntent, null, 'the API admits the retry');
        assert.equal(requestThroughApi(middleware).admitted, true);
        assert.ok(hints.store.current!.wokeAt, 'the next plain start is not counted as a wake');
    });
});

test('a request the API turns away once the stop request is stored calls the stop off (exit 1) instead of exit 0', async () => {
    await composedWithApi(async ({ hub, events, middleware, collectActivity, idleSince }) => {
        const hints = hintStore();
        const stops: number[] = [];
        let answer: ReturnType<typeof requestThroughApi> | null = null;
        const { ctx } = context(hub, new FakeRouting(true), { ...hints, collect: collectActivity });
        const collectWork = async () => {
            // Every process acknowledged; the API, still quiesced, turns a client away just before the last check.
            events.push('work check');
            answer = requestThroughApi(middleware);
            return emptyIdleSignals();
        };
        assert.equal(await drainIdleControlPlane({ ...request, idleSince }, { ...ctx, collectWork, collectActivity, stopProcess: code => { stops.push(code); } }), true);
        assert.deepEqual(answer, { status: 503, retryAfter: '5', admitted: false });
        assert.ok(events.includes('worker acknowledged the stop'));
        assert.deepEqual(stops, [1], 'the supervisor starts the control plane again, and it serves the retry');
        assert.equal(hub.strings.has(IDLE_SHUTDOWN_INTENT_REDIS_KEY), false, 'the stop request is withdrawn');
        assert.ok(hints.store.current!.wokeAt, 'the restart is not counted as a wake');
    });
});

test('with no request during the drain, the same activity checks let the stop end with exit 0', async () => {
    await composedWithApi(async ({ hub, events, collectActivity, idleSince }) => {
        const stops: number[] = [];
        const { ctx } = context(hub, new FakeRouting(true), { ...hintStore(), collect: collectActivity });
        assert.equal(await drainIdleControlPlane({ ...request, idleSince }, { ...ctx, collectWork: async () => emptyIdleSignals(), collectActivity, stopProcess: code => { stops.push(code); } }), true);
        assert.ok(events.includes('worker acknowledged the stop'));
        assert.deepEqual(stops, [0]);
    });
});

/**
 * An idle stop through the all-in-one's real bounded exit, which reads this process's API tracker once the close is
 * over. An earlier component's close is held; `during` runs while it is (the API is still up and quiesced).
 *
 * With `closeTimesOut`, that close is never released: the bounded exit reaches its (short) deadline with the API
 * still up, and `afterDeadline` runs at each awaited step that follows it (the host stop and the log flush).
 */
async function idleStopThroughBoundedExit(
    during: (middleware: ReturnType<typeof createIdleActivityMiddleware>) => void,
    options: { closeTimesOut?: boolean; afterDeadline?: (middleware: ReturnType<typeof createIdleActivityMiddleware>) => void } = {},
) {
    let result: { exited: number[]; hostStops: number; errors: string[] } | null = null;
    await composedWithApi(async ({ hub, events, middleware, collectActivity, idleSince }) => {
        const { ctx } = context(hub, new FakeRouting(true), { ...hintStore(), collect: collectActivity });
        let releaseEarlierClose!: () => void;
        const earlierClose = new Promise<void>(resolve => { releaseEarlierClose = resolve; });
        const exited: number[] = [];
        const errors: string[] = [];
        let hostStops = 0;
        const closeAndExit = createBoundedExit({
            close: async () => { events.push('closing'); await earlierClose; return []; },
            exit: code => { exited.push(code); },
            pendingStep: () => 'worker',
            log: { info: () => undefined, error: message => { errors.push(message); } },
            lastActivityAt: () => idleActivity.snapshot().lastRequestAt,
            flush: async () => { options.afterDeadline?.(middleware); },
            deadlineMs: options.closeTimesOut ? 40 : 5_000,
        });
        // As the all-in-one's idleShutdownStop passes it (src/allInOne.ts).
        const stopProcess = (code: number, call?: { exitBy: number | null; activitySince?: number | null }) => {
            closeAndExit(code, { ...call, idle: true, stopHost: async () => { hostStops += 1; options.afterDeadline?.(middleware); } });
        };
        assert.equal(await drainIdleControlPlane({ ...request, idleSince }, { ...ctx, collectWork: async () => emptyIdleSignals(), collectActivity, stopProcess }), true);
        assert.ok(events.includes('closing'), 'the last checks passed: the coordinated close is under way');
        during(middleware);
        if (options.closeTimesOut) {
            await new Promise(resolve => setTimeout(resolve, 120));
        } else {
            releaseEarlierClose();
        }
        await settle();
        result = { exited, hostStops, errors };
    });
    return result!;
}

test('a request the quiesced API turns away during the coordinated close keeps the host up: exit 1, no host stop', async () => {
    let answer: ReturnType<typeof requestThroughApi> | null = null;
    const { exited, hostStops, errors } = await idleStopThroughBoundedExit(middleware => { answer = requestThroughApi(middleware); });
    assert.deepEqual(answer, { status: 503, retryAfter: '5', admitted: false }, 'the API was still up, and quiesced');
    assert.equal(hostStops, 0, 'the host is not asked to stop');
    assert.deepEqual(exited, [1], 'the supervisor starts the control plane again, and it serves the retry');
    assert.match(errors.join('\n'), /a request reached the API while the idle stop was closing/);
});

test('without a request during the coordinated close, the host is stopped and the exit is 0', async () => {
    const { exited, hostStops } = await idleStopThroughBoundedExit(() => undefined);
    assert.equal(hostStops, 1);
    assert.deepEqual(exited, [0]);
});

/** Connect's wake ping (`POST /wake`) through the API's real middleware and handler. */
function wakePingThroughApi(middleware: ReturnType<typeof createIdleActivityMiddleware>) {
    const answer = { status: 0, body: null as unknown };
    const res = {
        setHeader: () => res,
        status: (code: number) => { answer.status = code; return res; },
        json: (body: unknown) => { answer.body = body; return res; },
        once: () => res,
    };
    middleware({ path: '/wake' } as never, res as never, () => { createWakeHandler(() => null)({} as never, res as never, () => undefined); });
    return answer;
}

test('a Connect wake ping answered after intake disconnects aborts the drain: intake reconnects and asks for the replay', async () => {
    await composedWithApi(async ({ hub, events, middleware, collectActivity, idleSince }) => {
        let answer: ReturnType<typeof wakePingThroughApi> | null = null;
        // The relay caches a delivery for the now disconnected instance and pings it while the API is still up.
        class PingedRouting extends FakeRouting {
            override async stop() { await super.stop(); answer = wakePingThroughApi(middleware); }
        }
        const routing = new PingedRouting(true);
        const stops: number[] = [];
        const { ctx, exits } = context(hub, routing, { ...hintStore(), collect: collectActivity });
        assert.equal(await drainIdleControlPlane({ ...request, idleSince }, { ...ctx, collectWork: async () => emptyIdleSignals(), collectActivity, stopProcess: code => { stops.push(code); } }), false);
        await settle();
        assert.deepEqual(answer, { status: 202, body: { status: 'awake' } }, 'the ping was acknowledged during the drain');
        assert.deepEqual(stops, [], 'nothing is closed');
        assert.deepEqual(exits, []);
        assert.ok(!events.includes('worker acknowledged the stop'), 'no process was asked to stop');
        assert.equal(hub.strings.has(IDLE_SHUTDOWN_INTENT_REDIS_KEY), false);
        assert.deepEqual(routing.calls, ['wake_hint', 'stop', 'start', 'replay'], 'intake reconnects and asks for the cached delivery');
    });
});

test('a Connect wake ping answered once the stop request is stored calls the stop off (exit 1) instead of exit 0', async () => {
    await composedWithApi(async ({ hub, events, middleware, collectActivity, idleSince }) => {
        const hints = hintStore();
        const stops: number[] = [];
        let answer: ReturnType<typeof wakePingThroughApi> | null = null;
        const { ctx } = context(hub, new FakeRouting(true), { ...hints, collect: collectActivity });
        const collectWork = async () => {
            answer = wakePingThroughApi(middleware);
            return emptyIdleSignals();
        };
        assert.equal(await drainIdleControlPlane({ ...request, idleSince }, { ...ctx, collectWork, collectActivity, stopProcess: code => { stops.push(code); } }), true);
        assert.deepEqual(answer, { status: 202, body: { status: 'awake' } });
        assert.ok(events.includes('worker acknowledged the stop'));
        assert.deepEqual(stops, [1], 'the supervisor starts the control plane again, and that start asks for the replay');
        assert.equal(hub.strings.has(IDLE_SHUTDOWN_INTENT_REDIS_KEY), false, 'the stop request is withdrawn');
        assert.ok(hints.store.current!.connectReplay, 'the replay stays owed in the hint file');
    });
});

test('a Connect wake ping answered during the coordinated close keeps the host up: exit 1, no host stop', async () => {
    let answer: ReturnType<typeof wakePingThroughApi> | null = null;
    const { exited, hostStops, errors } = await idleStopThroughBoundedExit(middleware => { answer = wakePingThroughApi(middleware); });
    assert.deepEqual(answer, { status: 202, body: { status: 'awake' } }, 'the API was still up and acknowledged the ping');
    assert.equal(hostStops, 0, 'the host is not asked to stop');
    assert.deepEqual(exited, [1], 'the supervisor starts the control plane again, and that start asks for the replay');
    assert.match(errors.join('\n'), /a request reached the API while the idle stop was closing/);
});

test('an idle close that reaches its deadline exits 1 without a host stop: a wake ping the still-running API acknowledges after it keeps the host up', async () => {
    const answers: Array<ReturnType<typeof wakePingThroughApi>> = [];
    const { exited, hostStops, errors } = await idleStopThroughBoundedExit(() => undefined, {
        closeTimesOut: true,
        // The earlier close still hangs, so the API is still up: Connect pings it after the deadline.
        afterDeadline: middleware => { answers.push(wakePingThroughApi(middleware)); },
    });
    assert.deepEqual(answers, [{ status: 202, body: { status: 'awake' } }], 'the ping was acknowledged after the close deadline');
    assert.equal(hostStops, 0, 'the host is not asked to stop');
    assert.deepEqual(exited, [1], 'the supervisor starts the control plane again, and that start asks for the replay');
    assert.match(errors.join('\n'), /the idle stop did not finish closing within 40 ms \(still closing: worker\); exiting with code 1 without stopping the host/);
});
