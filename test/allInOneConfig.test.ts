import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { createComponentSupervisor, prepareAllInOneEnvironment, resolveIndexingMode, runShutdownSequence, SHUTDOWN_ORDER, type StartupStage } from '../src/allInOneConfig.js';

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
    assert.match(source, /startWorker\(\{ installSignalHandlers: false \}\)/);
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
