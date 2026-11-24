import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

const directory = await mkdtemp(path.join(tmpdir(), 'idle-drain-'));
process.env.PROPR_IDLE_WAKE_HINT_FILE = path.join(directory, 'idle-wake-hint.json');

const {
    buildIdleWakeHint,
    closeConnection,
    connectReplaySince,
    emptyIdleSignals,
    idleActivity,
    IdleActivityTracker,
    readIdleWakeHint,
    setIdleShutdownComposedProcess,
    startIdleShutdownListener,
    writeIdleWakeHint,
} = await import('@propr/core');
const { drainIdleControlPlane, recoverFromIdleWake } = await import('../src/daemon/idleShutdown.js');
const { recordAcceptedReplay } = await import('../src/daemon/idleReplayObligation.js');
const { IDLE_LAST_SHUTDOWN_REDIS_KEY, IDLE_LAST_WAKE_REDIS_KEY, IDLE_PARTICIPANTS_REDIS_KEY, IDLE_SHUTDOWN_INTENT_REDIS_KEY, resolveIdleShutdownConfig } = await import('@propr/shared');
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
