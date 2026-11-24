/**
 * Worker-side wait for the Docker API (Fly legacy Docker: the app container
 * no longer waits for the docker sidecar). Run with:
 * `npx tsx --test test/workerDockerReadiness.test.ts`
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DOCKER_STARTUP_POLL_MS, resolveDockerStartupWaitSeconds, waitForDockerApiAtStartup } from '../src/workerDockerReadiness.js';

function recordingLogger() {
    const lines: Array<{ level: string; message: string; details: object }> = [];
    return {
        lines,
        info: (details: object, message: string) => { lines.push({ level: 'info', message, details }); },
        warn: (details: object, message: string) => { lines.push({ level: 'warn', message, details }); },
    };
}

function fakeClock() {
    let t = 1_000_000;
    return { now: () => t, sleep: async (ms: number) => { t += ms; } };
}

test('without PROPR_DOCKER_STARTUP_WAIT_SECONDS the worker never probes Docker', async () => {
    const logger = recordingLogger();
    let probes = 0;
    for (const env of [{}, { PROPR_DOCKER_STARTUP_WAIT_SECONDS: '' }, { PROPR_DOCKER_STARTUP_WAIT_SECONDS: '0' }]) {
        assert.equal(await waitForDockerApiAtStartup({ logger, env, probe: async () => { probes += 1; } }), false);
    }
    assert.equal(probes, 0);
    assert.deepEqual(logger.lines, []);
});

test('waits through a daemon that is still booting, then continues', async () => {
    const logger = recordingLogger();
    const clock = fakeClock();
    let probes = 0;
    const ready = await waitForDockerApiAtStartup({
        logger, env: { PROPR_DOCKER_STARTUP_WAIT_SECONDS: '300' }, ...clock,
        // dockerd answers on the 35th probe (~34 s after the worker started).
        probe: async () => { probes += 1; if (probes < 35) throw new Error('Cannot connect to the Docker daemon at tcp://127.0.0.1:2375'); },
    });
    assert.equal(ready, true);
    assert.equal(probes, 35);
    assert.deepEqual(logger.lines.map(line => line.message), [
        'Waiting for the Docker API before preparing agent images',
        'Docker API is reachable; preparing agent images',
    ]);
    assert.equal((logger.lines[1].details as { waitedMs: number }).waitedMs, 34 * DOCKER_STARTUP_POLL_MS);
});

test('an already reachable daemon is used at once and logs nothing', async () => {
    const logger = recordingLogger();
    assert.equal(await waitForDockerApiAtStartup({ logger, env: { PROPR_DOCKER_STARTUP_WAIT_SECONDS: '300' }, probe: async () => {} }), true);
    assert.deepEqual(logger.lines, []);
});

test('gives up at the deadline and lets the worker continue', async () => {
    const logger = recordingLogger();
    const clock = fakeClock();
    let probes = 0;
    const ready = await waitForDockerApiAtStartup({
        logger, env: { PROPR_DOCKER_STARTUP_WAIT_SECONDS: '5' }, ...clock,
        probe: async () => { probes += 1; throw new Error('down'); },
    });
    assert.equal(ready, false);
    assert.equal(probes, 6);
    assert.equal(logger.lines.at(-1)?.level, 'warn');
    assert.equal(logger.lines.at(-1)?.message, 'Docker API still unreachable; continuing worker startup');
});

test('a supervisor shutdown aborts the wait', async () => {
    const logger = recordingLogger();
    const controller = new AbortController();
    let probes = 0;
    await assert.rejects(waitForDockerApiAtStartup({
        logger, env: { PROPR_DOCKER_STARTUP_WAIT_SECONDS: '300' }, signal: controller.signal,
        probe: async () => { probes += 1; if (probes === 3) controller.abort(); throw new Error('down'); },
        sleep: async () => {},
    }), { name: 'AbortError' });
    assert.equal(probes, 3);
});

test('an invalid wait value turns the wait off with a warning', () => {
    for (const value of ['abc', '-1', '1.5', '3601']) {
        const logger = recordingLogger();
        assert.equal(resolveDockerStartupWaitSeconds({ PROPR_DOCKER_STARTUP_WAIT_SECONDS: value }, logger), 0);
        assert.equal(logger.lines[0]?.level, 'warn');
    }
    assert.equal(resolveDockerStartupWaitSeconds({ PROPR_DOCKER_STARTUP_WAIT_SECONDS: ' 300 ' }, recordingLogger()), 300);
});
