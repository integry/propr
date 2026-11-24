import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import {
    createBoundedExit, createComponentSupervisor, DEFAULT_SHUTDOWN_TIMEOUT_MS, installShutdownSignalHandlers, prepareAllInOneEnvironment,
    resolveIndexingMode, resolveShutdownTimeoutMs, runShutdownSequence, SHUTDOWN_ORDER, type StartupStage,
} from '../src/allInOneConfig.js';

test('PROPR_INDEXING defaults to inline and accepts off/inline/separate', () => {
    assert.equal(resolveIndexingMode(undefined), 'inline');
    assert.equal(resolveIndexingMode(''), 'inline');
    assert.equal(resolveIndexingMode(' OFF '), 'off');
    assert.equal(resolveIndexingMode('separate'), 'separate');
    assert.throws(() => resolveIndexingMode('sometimes'), /PROPR_INDEXING must be one of off, inline, separate/);
});

test('the composed process disables API autostart and defaults to a same-origin UI', () => {
    const env: NodeJS.ProcessEnv = { API_PUBLIC_URL: 'https://propr.example.com' };
    const defaulted = prepareAllInOneEnvironment(env);
    assert.equal(env.PROPR_API_DISABLE_AUTOSTART, '1');
    assert.equal(env.PROPR_SERVE_UI, '1');
    assert.equal(env.FRONTEND_URL, 'https://propr.example.com');
    assert.deepEqual(defaulted, ['PROPR_SERVE_UI', 'FRONTEND_URL']);

    const local: NodeJS.ProcessEnv = { DASHBOARD_API_PORT: '4100' };
    prepareAllInOneEnvironment(local);
    assert.equal(local.FRONTEND_URL, 'http://localhost:4100');
});

test('explicit operator settings win over all-in-one defaults', () => {
    const env: NodeJS.ProcessEnv = { FRONTEND_URL: 'https://ui.example.com', PROPR_SERVE_UI: '0' };
    assert.deepEqual(prepareAllInOneEnvironment(env), []);
    assert.equal(env.FRONTEND_URL, 'https://ui.example.com');
    assert.equal(env.PROPR_SERVE_UI, '0');

    const explicitDir: NodeJS.ProcessEnv = { PROPR_UI_DIST_DIR: '/srv/ui' };
    prepareAllInOneEnvironment(explicitDir);
    assert.equal(explicitDir.PROPR_SERVE_UI, undefined);
});

test('shutdown runs steps strictly in order and continues past a failing step', async () => {
    const events: string[] = [];
    const step = (name: string, fail = false) => ({
        name,
        close: async () => {
            events.push(`start:${name}`);
            await new Promise(resolve => setTimeout(resolve, 5));
            events.push(`end:${name}`);
            if (fail) throw new Error(`${name} failed`);
        },
    });
    const errors: string[] = [];
    const failed = await runShutdownSequence(
        [step('daemon'), step('indexing worker', true), step('worker'), step('api')],
        { info: () => undefined, error: message => errors.push(message) },
    );
    assert.deepEqual(failed, ['indexing worker']);
    assert.equal(errors.length, 1);
    assert.deepEqual(events, [
        'start:daemon', 'end:daemon',
        'start:indexing worker', 'end:indexing worker',
        'start:worker', 'end:worker',
        'start:api', 'end:api',
    ]);
});

test('all-in-one closes intake before workers, the worker after indexing, and the API last', () => {
    assert.deepEqual(SHUTDOWN_ORDER, ['daemon', 'indexing', 'worker', 'api']);
    const source = readFileSync(new URL('../src/allInOne.ts', import.meta.url), 'utf8');
    assert.match(source, /supervisor\.run\(stages\)/);
    assert.match(source, /startIndexingWorkerService\(\{ installSignalHandlers: false, ownEgressProxies: false \}\)/);
    assert.match(source, /startDaemon\(\{ installSignalHandlers: false, closeSharedQueue: false, idleShutdownStop \}\)/);
    assert.match(source, /startWorker\(\{ installSignalHandlers: false, signal \}\)/);
    assert.match(source, /installShutdownSignalHandlers\(/);
    assert.match(source, /startApiServer\(\{ installSignalHandlers: false \}\)/);
});

test('npm exposes the all-in-one entry', () => {
    const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { scripts: Record<string, string> };
    assert.equal(pkg.scripts['all-in-one'], 'node dist/src/allInOne.js');
    assert.equal(pkg.scripts['all-in-one:dev'], 'LOG_LEVEL=debug tsx src/allInOne.ts');
});

function deferred(): { promise: Promise<void>; resolve(): void; reject(error: Error): void } {
    let resolve!: () => void;
    let reject!: (error: Error) => void;
    const promise = new Promise<void>((res, rej) => { resolve = res; reject = rej; });
    return { promise, resolve, reject };
}

const quietLog = { info: () => undefined, error: () => undefined };

function componentStage(events: string[], name: string, role: StartupStage['role'], gate?: Promise<void>): StartupStage {
    return {
        name,
        role,
        run: async () => {
            events.push(`start:${name}`);
            await gate;
            events.push(`started:${name}`);
            return { close: async () => { events.push(`close:${name}`); } };
        },
    };
}

test('termination during a deferred worker startup closes the late worker and starts nothing after it', async () => {
    const events: string[] = [];
    const workerGate = deferred();
    const supervisor = createComponentSupervisor({
        log: quietLog,
        finalSteps: () => [{ name: 'shared task queue', close: async () => { events.push('close:shared task queue'); } }],
    });
    const startup = supervisor.run([
        componentStage(events, 'api', 'api'),
        componentStage(events, 'daemon', 'daemon'),
        componentStage(events, 'worker', 'worker', workerGate.promise),
        { name: 'pull request status maintenance', run: async () => { events.push('start:status maintenance'); } },
        componentStage(events, 'indexing worker', 'indexing'),
    ]);
    await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(events, ['start:api', 'started:api', 'start:daemon', 'started:daemon', 'start:worker']);

    // SIGTERM arrives while the worker is still starting.
    let closed = false;
    const closing = supervisor.close().then(failed => { closed = true; return failed; });
    assert.equal(supervisor.closing, true);
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(closed, false, 'shutdown must wait for the component still starting');
    assert.deepEqual(events.filter(event => event.startsWith('close:')), []);

    workerGate.resolve();
    assert.deepEqual(await closing, []);
    assert.equal(await startup, false);
    assert.deepEqual(events, [
        'start:api', 'started:api', 'start:daemon', 'started:daemon', 'start:worker', 'started:worker',
        'close:daemon', 'close:worker', 'close:api', 'close:shared task queue',
    ]);
    assert.equal(supervisor.close(), supervisor.close(), 'close is idempotent');
});

test('a startup failure after termination is logged and does not abort the drain', async () => {
    const events: string[] = [];
    const errors: string[] = [];
    const workerGate = deferred();
    const supervisor = createComponentSupervisor({ log: { info: () => undefined, error: message => errors.push(message) } });
    const startup = supervisor.run([
        componentStage(events, 'api', 'api'),
        componentStage(events, 'worker', 'worker', workerGate.promise),
        componentStage(events, 'indexing worker', 'indexing'),
    ]);
    await new Promise(resolve => setImmediate(resolve));
    const closing = supervisor.close();
    workerGate.reject(new Error('redis went away'));
    assert.equal(await startup, false);
    assert.deepEqual(await closing, []);
    assert.deepEqual(events, ['start:api', 'started:api', 'start:worker', 'close:api']);
    assert.deepEqual(errors, ['all-in-one: worker failed to start during shutdown']);
});

test('a startup failure without termination still rejects startup', async () => {
    const supervisor = createComponentSupervisor({ log: quietLog });
    await assert.rejects(
        supervisor.run([{ name: 'worker', role: 'worker', run: async () => { throw new Error('boom'); } }]),
        /boom/,
    );
});

test('termination before startup begins starts no component', async () => {
    const events: string[] = [];
    const supervisor = createComponentSupervisor({ log: quietLog });
    assert.deepEqual(await supervisor.close(), []);
    assert.equal(await supervisor.run([componentStage(events, 'api', 'api')]), false);
    assert.deepEqual(events, []);
});

test('uninterrupted startup closes every component in shutdown order', async () => {
    const events: string[] = [];
    const supervisor = createComponentSupervisor({ log: quietLog });
    assert.equal(await supervisor.run([
        componentStage(events, 'api', 'api'),
        componentStage(events, 'daemon', 'daemon'),
        componentStage(events, 'worker', 'worker'),
        componentStage(events, 'indexing worker', 'indexing'),
    ]), true);
    await supervisor.close();
    assert.deepEqual(events.filter(event => event.startsWith('close:')), ['close:daemon', 'close:indexing worker', 'close:worker', 'close:api']);
});

test('a component that never finishes starting does not hold the stop: the rest close after a bounded wait', async () => {
    // Live: the worker stage waits for an agent image that never becomes ready, so SIGTERM never got past it.
    const events: string[] = [];
    const infos: string[] = [];
    const supervisor = createComponentSupervisor({ log: { info: message => infos.push(message), error: () => undefined }, startupWaitMs: 20 });
    void supervisor.run([
        componentStage(events, 'api', 'api'),
        componentStage(events, 'daemon', 'daemon'),
        componentStage(events, 'worker', 'worker', new Promise<void>(() => undefined)),
    ]);
    await new Promise(resolve => setImmediate(resolve));
    const closing = supervisor.close();
    assert.equal(supervisor.pendingStep, 'worker (still starting)');
    assert.deepEqual(await closing, []);
    assert.deepEqual(events.filter(event => event.startsWith('close:')), ['close:daemon', 'close:api']);
    assert.ok(infos.includes('all-in-one: worker did not finish starting within 0s; closing the components that started without it'));
    assert.equal(supervisor.pendingStep, null);
});

test('the all-in-one exit is bounded: a close that never finishes still ends in exit 0', async () => {
    const exits: number[] = [];
    const errors: string[] = [];
    let flushed = false;
    const closeAndExit = createBoundedExit({
        close: () => new Promise<string[]>(() => undefined),
        exit: code => { exits.push(code); },
        pendingStep: () => 'api',
        log: { info: () => undefined, error: message => errors.push(message) },
        flush: async () => { flushed = true; },
        deadlineMs: 20,
    });
    closeAndExit();
    closeAndExit();
    await new Promise(resolve => setTimeout(resolve, 60));
    assert.deepEqual(exits, [0], 'exits once, with 0');
    assert.equal(flushed, true, 'logs are flushed before the exit');
    assert.deepEqual(errors, ['all-in-one: shutdown did not finish within 20 ms (still closing: api); exiting anyway']);
});

test('the all-in-one exit reports the close result: 0 when clean, 1 when a step failed', async () => {
    for (const [failed, code] of [[[], 0], [['worker'], 1]] as const) {
        const exits: number[] = [];
        createBoundedExit({ close: async () => [...failed], exit: c => { exits.push(c); }, pendingStep: () => null, log: quietLog, deadlineMs: 1_000 })();
        await new Promise(resolve => setTimeout(resolve, 10));
        assert.deepEqual(exits, [code]);
    }
});

test('signal and idle shutdown in all-in-one both go through the bounded exit', () => {
    const source = readFileSync(new URL('../src/allInOne.ts', import.meta.url), 'utf8');
    assert.match(source, /const closeAndExit = createBoundedExit\(/);
    assert.equal(source.match(/process\.exit\(failed/g), null, 'no unbounded exit after close()');
    assert.match(source, /installShutdownSignalHandlers\(\{\n\s+stop: signal => closeAndExit\(0, \{ signal \}\),/);
    assert.match(source, /idle shutdown, closing every component'\);\n\s+closeAndExit\(exitCode, \{ \.\.\.options, stopHost: /, 'the arranged wake and the host stop reach the bounded exit');
});

test('the all-in-one exit keeps the code its caller asked for (a called-off idle stop exits 1)', async () => {
    for (const close of [async () => [] as string[], () => new Promise<string[]>(() => undefined)]) {
        const exits: number[] = [];
        createBoundedExit({ close, exit: c => { exits.push(c); }, pendingStep: () => null, log: quietLog, deadlineMs: 20 })(1);
        await new Promise(resolve => setTimeout(resolve, 60));
        assert.deepEqual(exits, [1], 'whether the close completes or runs past its deadline');
    }
});

test('an idle exit still closing when the arranged wake comes exits 1 then, not 0 at the later relative deadline', async () => {
    const exits: Array<[number, number]> = [];
    const errors: string[] = [];
    const started = Date.now();
    const exitBy = started + 40;
    createBoundedExit({
        close: () => new Promise<string[]>(() => undefined),
        exit: code => { exits.push([code, Date.now()]); },
        pendingStep: () => 'worker',
        log: { info: () => undefined, error: message => errors.push(message) },
        deadlineMs: 5_000,
    })(0, { exitBy });
    await new Promise(resolve => setTimeout(resolve, 200));
    assert.equal(exits.length, 1);
    assert.equal(exits[0][0], 1, 'the wake reached a process still running: the supervisor must start it');
    assert.ok(exits[0][1] - started < 1_000, 'at the wake, not after the 5 s close deadline');
    assert.match(errors[0], /still shutting down when the wake arranged for the idle stop came \(still closing: worker\)/);
});

test('an idle exit that closes before the arranged wake exits 0, flushing only for the time left', async () => {
    const exits: number[] = [];
    const flushes: Array<{ timeoutMs: number | undefined; at: number }> = [];
    const exitBy = Date.now() + 500;
    createBoundedExit({
        close: async () => [],
        exit: code => { exits.push(code); },
        pendingStep: () => null,
        log: quietLog,
        flush: async timeoutMs => { flushes.push({ timeoutMs, at: Date.now() }); },
        deadlineMs: 5_000,
    })(0, { exitBy });
    await new Promise(resolve => setTimeout(resolve, 20));
    assert.deepEqual(exits, [0]);
    assert.equal(flushes.length, 1);
    const [{ timeoutMs, at }] = flushes;
    assert.ok(timeoutMs !== undefined && timeoutMs <= exitBy - at, 'the flush cannot carry the exit past the wake');

    // A wake that is already due when the close starts: exit 1 at once.
    const late: number[] = [];
    createBoundedExit({ close: () => new Promise<string[]>(() => undefined), exit: code => { late.push(code); }, pendingStep: () => null, log: quietLog, deadlineMs: 5_000 })(0, { exitBy: Date.now() - 1 });
    await new Promise(resolve => setTimeout(resolve, 20));
    assert.deepEqual(late, [1]);
});

test('an idle exit whose log flush runs through the arranged wake exits 1, not the 0 chosen before the flush', async () => {
    const exits: number[] = [];
    const errors: string[] = [];
    const exitBy = Date.now() + 40;
    createBoundedExit({
        close: async () => [],
        exit: code => { exits.push(code); },
        pendingStep: () => null,
        log: { info: () => undefined, error: message => errors.push(message) },
        // A flush that ignores the time it was given: it resolves only after the wake.
        flush: () => new Promise<void>(resolve => setTimeout(resolve, 120)),
        deadlineMs: 5_000,
    })(0, { exitBy });
    await new Promise(resolve => setTimeout(resolve, 200));
    assert.deepEqual(exits, [1], 'the wake reached a running process: the supervisor must start it again');
    assert.match(errors[0], /wake arranged for the idle stop came while the logs were flushed/);

    // A called-off stop's exit 1 and an unbounded (no wake) exit 0 are not changed by a slow flush.
    const codes: number[] = [];
    createBoundedExit({ close: async () => [], exit: code => { codes.push(code); }, pendingStep: () => null, log: quietLog, flush: () => new Promise<void>(resolve => setTimeout(resolve, 30)), deadlineMs: 5_000 })(1, { exitBy: null });
    createBoundedExit({ close: async () => [], exit: code => { codes.push(code); }, pendingStep: () => null, log: quietLog, flush: () => new Promise<void>(resolve => setTimeout(resolve, 30)), deadlineMs: 5_000 })(0);
    await new Promise(resolve => setTimeout(resolve, 100));
    assert.deepEqual(codes.sort(), [0, 1]);
});

test('shutdown aborts the signal of the stage still starting, so a stuck startup cannot hold the drain', async () => {
    const events: string[] = [];
    const supervisor = createComponentSupervisor({ log: quietLog });
    const startup = supervisor.run([
        componentStage(events, 'api', 'api'),
        {
            // Like the worker's wait for an agent image that never becomes ready.
            name: 'worker',
            role: 'worker',
            run: signal => new Promise((_resolve, reject) => {
                events.push('start:worker');
                signal.addEventListener('abort', () => reject(signal.reason), { once: true });
            }),
        },
    ]);
    await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(await supervisor.close(), []);
    assert.equal(await startup, false);
    assert.deepEqual(events, ['start:api', 'started:api', 'start:worker', 'close:api']);
});

test('PROPR_SHUTDOWN_TIMEOUT_MS defaults below the Fly stop timeout and is bounded', () => {
    assert.equal(resolveShutdownTimeoutMs(undefined), DEFAULT_SHUTDOWN_TIMEOUT_MS);
    assert.ok(DEFAULT_SHUTDOWN_TIMEOUT_MS < 60_000);
    assert.equal(resolveShutdownTimeoutMs(' 5000 '), 5000);
    for (const bad of ['0', '999', 'soon', '1.5e3x']) assert.throws(() => resolveShutdownTimeoutMs(bad), /PROPR_SHUTDOWN_TIMEOUT_MS/);
});

function fakeSignals(): { emit(signal: 'SIGINT' | 'SIGTERM'): void; on(signal: 'SIGINT' | 'SIGTERM', handler: () => void): void } {
    const handlers = new Map<string, () => void>();
    return { emit: signal => handlers.get(signal)?.(), on: (signal, handler) => { handlers.set(signal, handler); } };
}

const quietSignalLog = { info: () => undefined, warn: () => undefined, error: () => undefined };

/** The all-in-one wiring: signals reach the bounded exit. */
function installSignalExit(signals: ReturnType<typeof fakeSignals>, close: () => Promise<string[]>, exit: (code: number) => void, deadlineMs: number, errors: string[] = []): void {
    const closeAndExit = createBoundedExit({ close, exit, pendingStep: () => 'api', log: { info: () => undefined, error: message => errors.push(message) }, deadlineMs });
    installShutdownSignalHandlers({ stop: signal => closeAndExit(0, { signal }), log: quietSignalLog, exit, on: signals.on });
}

test('a finished drain exits 0, a failed close exits 1, a second signal exits 1 at once', async () => {
    for (const [failed, code] of [[[], 0], [['worker'], 1]] as const) {
        const signals = fakeSignals();
        const exits: number[] = [];
        let finish!: (value: string[]) => void;
        installSignalExit(signals, () => new Promise(resolve => { finish = resolve; }), c => exits.push(c), 60_000);
        signals.emit('SIGTERM');
        signals.emit('SIGINT');
        assert.deepEqual(exits, [1]);
        finish([...failed]);
        await new Promise(resolve => setTimeout(resolve, 10));
        assert.deepEqual(exits, [1, code]);
    }
});

test('a drain that never finishes exits 0 at the deadline', async () => {
    const signals = fakeSignals();
    const exits: number[] = [];
    const errors: string[] = [];
    installSignalExit(signals, () => new Promise(() => undefined), c => exits.push(c), 20, errors);
    signals.emit('SIGTERM');
    await new Promise(resolve => setTimeout(resolve, 80));
    assert.deepEqual(exits, [0]);
    assert.match(errors[0], /did not finish within 20 ms/);
});

test('SIGTERM ends a real process whose drain hangs within the shutdown timeout', { timeout: 30_000 }, async () => {
    const tsx = createRequire(import.meta.url).resolve('tsx/cli');
    const fixture = fileURLToPath(new URL('./fixtures/allInOneShutdownHang.ts', import.meta.url));
    const child = spawn(process.execPath, [tsx, fixture], {
        env: { ...process.env, PROPR_SHUTDOWN_TIMEOUT_MS: '1000' },
        stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = '';
    child.stderr.on('data', chunk => { output += String(chunk); });
    const exited = new Promise<number | null>(resolve => child.on('exit', code => resolve(code)));
    await new Promise<void>((resolve, reject) => {
        child.stdout.on('data', chunk => { output += String(chunk); if (output.includes('ready')) resolve(); });
        child.on('exit', () => reject(new Error(`fixture exited before it was ready:\n${output}`)));
    });
    const sentAt = Date.now();
    child.kill('SIGTERM');
    const kill = setTimeout(() => child.kill('SIGKILL'), 10_000);
    const code = await exited;
    clearTimeout(kill);
    const elapsed = Date.now() - sentAt;
    assert.equal(code, 0, output);
    assert.ok(elapsed >= 900 && elapsed < 5_000, `exited ${elapsed} ms after SIGTERM`);
    assert.match(output, /received SIGTERM, shutting down gracefully/);
    assert.match(output, /did not finish within 1s \(still closing: api\); exiting anyway/);
});

test('an idle exit rechecks API activity once the close is over: a request after the idle period began exits 1 without a host stop', async () => {
    const since = Date.now() - 1_000;
    const run = async (lastActivityAt: () => number, call: { activitySince?: number | null; signal?: string } = { activitySince: since }) => {
        const exits: number[] = [];
        let hostStops = 0;
        let closed = false;
        createBoundedExit({
            // Read only once the close is over: the request arrives while a component is still closing.
            close: async () => { closed = true; return []; },
            exit: code => { exits.push(code); },
            pendingStep: () => null,
            log: quietLog,
            lastActivityAt: () => (closed ? lastActivityAt() : 0),
            deadlineMs: 1_000,
        })(0, { ...call, stopHost: async () => { hostStops += 1; } });
        await new Promise(resolve => setTimeout(resolve, 10));
        return { exits, hostStops };
    };
    assert.deepEqual(await run(() => since + 1), { exits: [1], hostStops: 0 }, 'a request during the close');
    assert.deepEqual(await run(() => since), { exits: [0], hostStops: 1 }, 'the last request predates the idle period');
    assert.deepEqual(await run(() => 0), { exits: [0], hostStops: 1 }, 'no request at all');
    assert.deepEqual(await run(() => since + 1, {}), { exits: [0], hostStops: 1 }, 'no idle boundary given (not an idle exit)');
    assert.deepEqual(await run(() => { throw new Error('unreadable'); }), { exits: [1], hostStops: 0 }, 'unreadable activity counts as a request');
});
