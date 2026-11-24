import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { IDLE_PARTICIPANTS_REDIS_KEY, IDLE_SHUTDOWN_ACKS_REDIS_PREFIX, IDLE_SHUTDOWN_CHANNEL, IDLE_SHUTDOWN_INTENT_REDIS_KEY } from '@propr/shared';
import {
    collectParticipantSignals,
    isIdleParticipantInThisProcess,
    localInstanceId,
    localProcessIdentity,
    registerIdleParticipant,
    type LocalProcessIdentity,
} from '../src/idle/idleParticipants.js';
import {
    issueIdleShutdownIntent,
    listIdleShutdownTargets,
    newIdleShutdownIntent,
    readIdleAckProgress,
    waitForIdleAcks,
    withdrawIdleShutdownIntent,
} from '../src/idle/idleShutdownIntent.js';
import { setIdleShutdownComposedProcess, startIdleShutdownListener } from '../src/idle/idleShutdownListener.js';
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

    const targets = await listIdleShutdownTargets(daemon as never, ['worker']);
    const intent = { ...newIdleShutdownIntent('quiesce', 'idle for 900s'), phase: 'stop' as const, targets };
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
    const intent = { ...newIdleShutdownIntent('quiesce', 'idle'), phase: 'stop' as const, targets: await listIdleShutdownTargets(daemon as never, ['api', 'worker']) };
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

test('an API process whose quiesce callback fails does not acknowledge, and retries it on the next poll', async () => {
    const hub = new FakeRedisHub();
    const daemon = hub.connect() as unknown as FakeConnection;
    let failing = true;
    let calls = 0;
    const listener = startIdleShutdownListener({
        role: 'api',
        id: 'a1',
        createConnection: hub.connect,
        onQuiesce: async () => {
            calls += 1;
            if (failing) throw new Error('could not publish the API activity record');
        },
        pollMs: 10,
    });
    await settle();
    const intent = newIdleShutdownIntent('quiesce', 'idle');
    await issueIdleShutdownIntent(daemon as never, intent);
    // Several polls pass while the callback keeps failing.
    const unconfirmed = await waitForIdleAcks(daemon as never, intent, { roles: ['api'], timeoutMs: 100, ...FAST });
    assert.equal(unconfirmed.confirmed, false, 'a failed quiesce is never acknowledged');
    assert.ok(calls >= 2, `the failed callback is retried on later polls (called ${calls}x)`);
    assert.deepEqual(hub.hash(`${IDLE_SHUTDOWN_ACKS_REDIS_PREFIX}${intent.id}`), {});

    failing = false;
    const confirmed = await waitForIdleAcks(daemon as never, intent, { roles: ['api'], timeoutMs: 2_000, ...FAST });
    assert.equal(confirmed.confirmed, true, 'acknowledged once the callback succeeds');
    const settled = calls;
    await settle();
    assert.equal(calls, settled, 'a successful callback is not repeated');
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

test('a stop request is for the generations registered when it was issued, not for processes started since', async () => {
    const hub = new FakeRedisHub();
    const daemon = hub.connect() as unknown as FakeConnection;
    const stops: string[] = [];
    const original = startIdleShutdownListener({ role: 'worker', id: 'w0', createConnection: hub.connect, onShutdown: () => { stops.push('original'); }, pollMs: 60_000 });
    await settle();
    const [commands, subscriber] = hub.connections.slice(1) as FakeConnection[];
    commands.drop();
    subscriber.drop();
    // A worker that is about to be replaced by a restart under the same key (a reused pid in a container).
    await daemon.hset(IDLE_PARTICIPANTS_REDIS_KEY, 'worker:w1', JSON.stringify({
        role: 'worker', id: 'w1', host: 'elsewhere', pid: 1, pidNamespace: null, bootId: null, startedAt: 1, seenAt: Date.now(),
    }));
    const intent = { ...newIdleShutdownIntent('quiesce', 'idle'), phase: 'stop' as const, targets: await listIdleShutdownTargets(daemon as never, ['api', 'worker']) };
    assert.deepEqual(intent.targets.map(target => target.key).sort(), ['worker:w0', 'worker:w1']);
    // Stored, as when the daemon died before deleting it.
    await issueIdleShutdownIntent(daemon as never, intent);

    // Processes starting now read the stored request at once, and keep running.
    const restarted = startIdleShutdownListener({ role: 'worker', id: 'w1', createConnection: hub.connect, onShutdown: () => { stops.push('restarted'); }, pollMs: 10 });
    const fresh = startIdleShutdownListener({ role: 'api', id: 'a2', createConnection: hub.connect, onShutdown: () => { stops.push('fresh'); }, pollMs: 10 });
    await settle();
    await settle();
    assert.deepEqual(stops, []);
    assert.deepEqual(hub.hash(`${IDLE_SHUTDOWN_ACKS_REDIS_PREFIX}${intent.id}`), {}, 'nothing acknowledges a request it is not targeted by');
    assert.deepEqual(await waitForIdleAcks(daemon as never, intent, { roles: ['api', 'worker'], timeoutMs: 0, ...FAST, isGone: () => false }),
        { confirmed: false, pending: ['worker:w0'] }, 'only the targeted generation still running is awaited');

    // The targeted generation reconnecting still gets the request.
    commands.connected = true;
    subscriber.reconnect();
    const confirmed = await waitForIdleAcks(daemon as never, intent, { roles: ['api', 'worker'], timeoutMs: 2_000, ...FAST });
    assert.equal(confirmed.confirmed, true);
    assert.deepEqual(stops, ['original']);
    await Promise.all([original.stop(), restarted.stop(), fresh.stop()]);
});

test('in a composed process a stop is only acknowledged: the daemon runs the one coordinated close', async () => {
    const hub = new FakeRedisHub();
    const daemon = hub.connect() as unknown as FakeConnection;
    const signals: string[] = [];
    const onSignal = () => { signals.push('SIGTERM'); };
    process.on('SIGTERM', onSignal);
    setIdleShutdownComposedProcess(true);
    try {
        const listeners = ['api', 'worker'].map(role => startIdleShutdownListener({ role: role as 'api' | 'worker', id: `${role}-1`, createConnection: hub.connect, pollMs: 10 }));
        await settle();
        const intent = { ...newIdleShutdownIntent('quiesce', 'idle'), phase: 'stop' as const, targets: await listIdleShutdownTargets(daemon as never, ['api', 'worker']) };
        await issueIdleShutdownIntent(daemon as never, intent);
        const progress = await waitForIdleAcks(daemon as never, intent, { roles: ['api', 'worker'], timeoutMs: 2_000, ...FAST });
        assert.equal(progress.confirmed, true);
        await settle();
        assert.deepEqual(signals, [], 'no participant signals the shared process');
        assert.deepEqual(Object.keys(hub.hash(IDLE_PARTICIPANTS_REDIS_KEY)).sort(), ['api:api-1', 'worker:worker-1'], 'they deregister in the coordinated close');
        await Promise.all(listeners.map(listener => listener.stop()));
    } finally {
        setIdleShutdownComposedProcess(false);
        process.off('SIGTERM', onSignal);
    }
});

test('a stop acknowledgement whose writes fail is retried once Redis recovers, and the shutdown runs once, only after it', async () => {
    const hub = new FakeRedisHub();
    const daemon = hub.connect() as unknown as FakeConnection;
    const stops: string[] = [];
    setIdleShutdownComposedProcess(true);
    try {
        const listener = startIdleShutdownListener({ role: 'worker', id: 'w1', createConnection: hub.connect, onShutdown: intent => { stops.push(intent.id); }, pollMs: 10 });
        await settle();
        const commands = hub.connections[1] as FakeConnection;
        // Redis refuses the acknowledgement writes (and only those) until it recovers.
        let refused = 0;
        let refusing = true;
        const write = commands.hset.bind(commands);
        commands.hset = async (key: string, field: string, value: string) => {
            if (refusing && key.startsWith(IDLE_SHUTDOWN_ACKS_REDIS_PREFIX)) {
                refused += 1;
                throw new Error('READONLY You can\'t write against a read only replica.');
            }
            return write(key, field, value);
        };
        const intent = { ...newIdleShutdownIntent('quiesce', 'idle'), phase: 'stop' as const, targets: await listIdleShutdownTargets(daemon as never, ['worker']) };
        await issueIdleShutdownIntent(daemon as never, intent);
        const refusedWhileDown = await waitForIdleAcks(daemon as never, intent, { roles: ['worker'], timeoutMs: 100, ...FAST, isGone: () => false });
        assert.equal(refusedWhileDown.confirmed, false);
        assert.ok(refused > 3, `retried on later polls, not given up after the first three writes (${refused} attempts)`);
        assert.deepEqual(stops, [], 'no shutdown without an acknowledgement');

        refusing = false;
        const confirmed = await waitForIdleAcks(daemon as never, intent, { roles: ['worker'], timeoutMs: 2_000, ...FAST });
        assert.equal(confirmed.confirmed, true, 'the drain completes once Redis recovers');
        await new Promise(resolve => setTimeout(resolve, 100));
        assert.deepEqual(stops, [intent.id], 'the shutdown runs exactly once, despite later polls and announcements');
        await listener.stop();
    } finally {
        setIdleShutdownComposedProcess(false);
    }
});

/** The daemon's connection, with the reads of a stop's acknowledgements held for `delayMs` (or forever) before they are answered. */
function slowAckReads(hub: FakeRedisHub, delayMs: number | null) {
    const daemon = hub.connect() as unknown as FakeConnection;
    const read = daemon.hgetall.bind(daemon);
    daemon.hgetall = async (key: string) => {
        if (key.startsWith(IDLE_SHUTDOWN_ACKS_REDIS_PREFIX)) {
            await new Promise(resolve => { if (delayMs !== null) setTimeout(resolve, delayMs); });
        }
        return read(key);
    };
    return daemon;
}

test('an acknowledgement read only after the deadline does not confirm the stop', async () => {
    const hub = new FakeRedisHub();
    const registration = registerIdleParticipant(hub.connect(), { role: 'worker', id: 'w-late', intervalMs: 60_000 });
    await settle();
    const intent = { ...newIdleShutdownIntent('stop', 'idle'), targets: [{ key: registration.key, startedAt: registration.participant.startedAt }] };
    await issueIdleShutdownIntent(hub.connect(), intent);
    // Acknowledged before the deadline, but the read that sees it completes after it.
    await hub.connect().hset(`${IDLE_SHUTDOWN_ACKS_REDIS_PREFIX}${intent.id}`, `stop:${registration.key}`, '{}');
    const started = Date.now();
    const late = await waitForIdleAcks(slowAckReads(hub, 150) as never, intent, { roles: ['worker'], timeoutMs: 50, ...FAST });
    assert.equal(late.confirmed, false, 'too late for the rest of the stop to end before the wake');
    assert.ok(Date.now() - started < 150, 'the outstanding read is not waited for');

    // A read that never answers ends the wait at the deadline too.
    const hanging = await waitForIdleAcks(slowAckReads(hub, null) as never, intent, { roles: ['worker'], timeoutMs: 50, ...FAST });
    assert.equal(hanging.confirmed, false);
    assert.deepEqual(hanging.pending, ['(acknowledgements not read before the deadline)']);

    // The read answers before the timer fires, but the clock has passed the deadline meanwhile (a stalled event loop).
    const realNow = Date.now;
    const stalled = hub.connect() as unknown as FakeConnection;
    const read = stalled.hgetall.bind(stalled);
    let skew = 0;
    stalled.hgetall = async (key: string) => {
        if (key.startsWith(IDLE_SHUTDOWN_ACKS_REDIS_PREFIX)) skew = 60_000;
        return read(key);
    };
    Date.now = () => realNow() + skew;
    try {
        const stale = await waitForIdleAcks(stalled as never, intent, { roles: ['worker'], timeoutMs: 1_000, ...FAST });
        assert.deepEqual(stale, { confirmed: false, pending: ['(acknowledged after the deadline)'] }, 'a confirmation received after the deadline is rejected');
    } finally {
        Date.now = realNow;
    }

    // Read in time, the same acknowledgement confirms.
    assert.equal((await waitForIdleAcks(hub.connect(), intent, { roles: ['worker'], timeoutMs: 1_000, ...FAST })).confirmed, true);
    await registration.stop();
});

test('a participant counts as this process\'s only for the generation registered here', async () => {
    const hub = new FakeRedisHub();
    const registration = registerIdleParticipant(hub.connect(), { role: 'api', id: 'a-local', intervalMs: 60_000 });
    assert.equal(isIdleParticipantInThisProcess(registration.key, registration.participant.startedAt), true);
    assert.equal(isIdleParticipantInThisProcess(registration.key, registration.participant.startedAt - 1), false, 'another process wrote this key');
    assert.equal(isIdleParticipantInThisProcess(registration.key, null), false, 'an unreadable entry is never ours');
    assert.equal(isIdleParticipantInThisProcess('api:elsewhere', registration.participant.startedAt), false);
    await registration.stop();
    assert.equal(isIdleParticipantInThisProcess(registration.key, registration.participant.startedAt), false, 'deregistered');
});

/** A temporary DATA_DIR, so the instance id file of a test is its own. */
async function withDataDir<T>(run: (dir: string) => Promise<T>): Promise<T> {
    const dir = await mkdtemp(path.join(tmpdir(), 'idle-instance-'));
    const previous = process.env.DATA_DIR;
    process.env.DATA_DIR = dir;
    try {
        return await run(dir);
    } finally {
        if (previous === undefined) delete process.env.DATA_DIR;
        else process.env.DATA_DIR = previous;
        await rm(dir, { recursive: true, force: true });
    }
}

test('the instance id persists in DATA_DIR and is shared by every process that reads it', async () => {
    await withDataDir(async dir => {
        const file = path.join(dir, 'idle-instance-id');
        const id = localInstanceId(file);
        assert.match(id ?? '', /^[0-9a-f-]{36}$/);
        assert.equal(localInstanceId(file), id);
        assert.equal((await readFile(file, 'utf8')).trim(), id, 'written for the next boot');
        // After a restart the id comes from the file (a fresh path stands in for a fresh process cache).
        const restored = path.join(dir, 'restored', 'idle-instance-id');
        await mkdir(path.dirname(restored));
        await writeFile(restored, `${id}\n`);
        assert.equal(localInstanceId(restored), id);
        // A file that holds anything else is not replaced, and no id is claimed.
        const garbled = path.join(dir, 'garbled');
        await writeFile(garbled, 'not an id');
        assert.equal(localInstanceId(garbled), null);
        assert.equal(await readFile(garbled, 'utf8'), 'not an id');
    });
});

const BOOT_TIME = 1_800_000_000_000;
const HERE = { host: 'propr-host', pidNamespace: 'pid:[1]', bootId: 'boot-now', instanceId: 'instance-a', bootTime: BOOT_TIME };

function earlierBootEntry(id: string, overrides: Record<string, unknown> = {}) {
    return JSON.stringify({
        role: 'worker', id, host: HERE.host, pid: 100, pidNamespace: HERE.pidNamespace, bootId: 'boot-before',
        instanceId: HERE.instanceId, startedAt: BOOT_TIME - 3_600_000, seenAt: BOOT_TIME - 60_000, ...overrides,
    });
}

test('registrations left by an earlier boot of this installation do not block idle shutdown', async () => {
    const hub = new FakeRedisHub();
    const redis = hub.connect() as unknown as FakeConnection;
    const now = BOOT_TIME + 10 * 60_000;
    await redis.hset(IDLE_PARTICIPANTS_REDIS_KEY, 'worker:propr-host:100', earlierBootEntry('propr-host:100'));
    await redis.hset(IDLE_PARTICIPANTS_REDIS_KEY, 'api:propr-host:101', earlierBootEntry('propr-host:101', { role: 'api', pid: 101 }));
    // Another container of the installation (own hostname, same data directory and kernel).
    await redis.hset(IDLE_PARTICIPANTS_REDIS_KEY, 'worker:sidecar:7', earlierBootEntry('sidecar:7', { host: 'sidecar', pid: 7, pidNamespace: 'pid:[9]' }));
    // The current boot's processes, under other pids.
    await redis.hset(IDLE_PARTICIPANTS_REDIS_KEY, 'worker:propr-host:200', earlierBootEntry('propr-host:200', { pid: 200, bootId: HERE.bootId, startedAt: now - 1_000, seenAt: now }));

    const isGone = () => assert.fail('an earlier boot needs no pid lookup');
    const signals = await collectParticipantSignals(redis as never, { now, local: HERE, isGone });
    assert.deepEqual(signals.unavailable, []);
    assert.deepEqual(signals.participants.map(participant => participant.id), ['propr-host:200']);
    assert.deepEqual(Object.keys(hub.hash(IDLE_PARTICIPANTS_REDIS_KEY)), ['worker:propr-host:200'], 'the obsolete entries are removed');
});

test('a stale registration is not confirmed gone across boots without matching evidence', async () => {
    const now = BOOT_TIME + 10 * 60_000;
    const cases: Record<string, [string, LocalProcessIdentity]> = {
        'another installation (a remote participant)': [earlierBootEntry('remote:1', { instanceId: 'instance-b' }), HERE],
        'an entry without an instance id': [earlierBootEntry('legacy:1', { instanceId: undefined }), HERE],
        'an entry without a boot id': [earlierBootEntry('noboot:1', { bootId: undefined }), HERE],
        'a heartbeat after this kernel booted (another kernel with this id)': [earlierBootEntry('twin:1', { seenAt: BOOT_TIME + 60_000 }), HERE],
        'an unreadable local instance id': [earlierBootEntry('here:1'), { ...HERE, instanceId: null }],
        'an unreadable boot time': [earlierBootEntry('here:2'), { ...HERE, bootTime: null }],
        'a local identity without the persistent fields': [earlierBootEntry('here:3'), { host: HERE.host, pidNamespace: HERE.pidNamespace, bootId: HERE.bootId }],
        'the same boot, a pid still in use': [earlierBootEntry('here:4', { bootId: HERE.bootId }), HERE],
    };
    for (const [name, [entry, local]] of Object.entries(cases)) {
        const hub = new FakeRedisHub();
        const redis = hub.connect() as unknown as FakeConnection;
        await redis.hset(IDLE_PARTICIPANTS_REDIS_KEY, 'worker:x', entry);
        const { unavailable } = await collectParticipantSignals(redis as never, { now, local, isGone: () => false });
        assert.equal(unavailable.length, 1, name);
        assert.deepEqual(Object.keys(hub.hash(IDLE_PARTICIPANTS_REDIS_KEY)), ['worker:x'], `${name}: kept`);
    }
});

test('a stop acknowledgement is not awaited from a process of an earlier boot', async () => {
    const hub = new FakeRedisHub();
    const daemon = hub.connect() as unknown as FakeConnection;
    await daemon.hset(IDLE_PARTICIPANTS_REDIS_KEY, 'api:propr-host:101', earlierBootEntry('propr-host:101', { role: 'api', pid: 101 }));
    await daemon.hset(IDLE_PARTICIPANTS_REDIS_KEY, 'api:remote:1', earlierBootEntry('remote:1', { role: 'api', instanceId: 'instance-b' }));
    const intent = newIdleShutdownIntent('quiesce', 'idle');
    const progress = await readIdleAckProgress(daemon as never, intent, { roles: ['api'], local: HERE, isGone: () => false });
    assert.deepEqual(progress.pending, ['api:remote:1']);
    assert.deepEqual(Object.keys(hub.hash(IDLE_PARTICIPANTS_REDIS_KEY)), ['api:remote:1']);
});

test('after a reboot, the entries this installation registered before it are reconciled by the real identity', { skip: !localProcessIdentity().bootId && 'no kernel boot id here' }, async () => {
    await withDataDir(async () => {
        const hub = new FakeRedisHub();
        const redis = hub.connect() as unknown as FakeConnection;
        const current = registerIdleParticipant(redis as never, { role: 'worker', id: `here:${process.pid}`, intervalMs: 60_000 });
        await settle();
        const local = localProcessIdentity();
        assert.ok(current.participant.instanceId, 'the registration records the instance id');
        assert.equal(current.participant.instanceId, local.instanceId);
        assert.ok(local.bootTime, 'boot time read from /proc/stat');
        // What Redis restored from before the reboot: same installation, another boot, other pids.
        for (const [key, pid] of [['worker:here:1', 1], ['api:here:2', 2]] as const) {
            await redis.hset(IDLE_PARTICIPANTS_REDIS_KEY, key, JSON.stringify({
                ...current.participant, role: key.split(':')[0], id: key.slice(key.indexOf(':') + 1), pid,
                bootId: 'an-earlier-boot', startedAt: local.bootTime! - 7_200_000, seenAt: local.bootTime! - 3_600_000,
            }));
        }
        const { unavailable } = await collectParticipantSignals(redis as never, { now: Date.now() });
        assert.deepEqual(unavailable, []);
        assert.deepEqual(Object.keys(hub.hash(IDLE_PARTICIPANTS_REDIS_KEY)), [current.key]);
        await current.stop();
    });
});
