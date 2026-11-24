import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { prepareAllInOneEnvironment, resolveIndexingMode, runShutdownSequence } from '../src/allInOneConfig.js';

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
    const source = readFileSync(new URL('../src/allInOne.ts', import.meta.url), 'utf8');
    assert.match(source, /\['daemon', 'indexing', 'worker', 'api'\] as const/);
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
