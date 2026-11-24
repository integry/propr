import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import {
    createComponentSupervisor, DEFAULT_SHUTDOWN_TIMEOUT_MS, installShutdownSignalHandlers, prepareAllInOneEnvironment, resolveIndexingMode,
    resolveShutdownTimeoutMs, runShutdownSequence, SHUTDOWN_ORDER, type StartupStage,
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
    assert.match(source, /startDaemon\(\{ installSignalHandlers: false, closeSharedQueue: false \}\)/);
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

test('a finished drain exits 0, a failed close exits 1, a second signal exits 1 at once', async () => {
    for (const [failed, code] of [[[], 0], [['worker'], 1]] as const) {
        const signals = fakeSignals();
        const exits: number[] = [];
        let finish!: (value: string[]) => void;
        installShutdownSignalHandlers({ close: () => new Promise(resolve => { finish = resolve; }), timeoutMs: 60_000, log: quietSignalLog, exit: c => exits.push(c), on: signals.on });
        signals.emit('SIGTERM');
        signals.emit('SIGINT');
        assert.deepEqual(exits, [1]);
        finish([...failed]);
        await new Promise(resolve => setImmediate(resolve));
        assert.deepEqual(exits, [1, code]);
    }
});

test('a drain that never finishes exits 0 at the deadline', async () => {
    const signals = fakeSignals();
    const exits: number[] = [];
    const errors: string[] = [];
    installShutdownSignalHandlers({
        close: () => new Promise(() => undefined), timeoutMs: 20,
        log: { ...quietSignalLog, error: message => errors.push(message) }, exit: c => exits.push(c), on: signals.on,
    });
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
    assert.match(output, /did not finish within 1000 ms; exiting/);
});
