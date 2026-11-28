/**
 * The daemon's work producers (issue #3770): an idle drain pauses the sweeps
 * that queue work before its last check and resumes them when it aborts.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createDaemonWorkProducers } from '../src/daemon/workProducers.js';

const quietLog = { error: () => undefined };

/** A sweep whose run in progress finishes when released. */
function sweep(events: string[], name: string) {
    let starts = 0;
    let release: () => void = () => undefined;
    return {
        get starts() { return starts; },
        release: () => release(),
        start: () => {
            starts += 1;
            events.push(`${name} started`);
            const run = new Promise<void>(resolve => { release = resolve; });
            return async () => { await run; events.push(`${name} stopped`); };
        },
    };
}

test('pause waits for a run in progress and reports the ones still running at the deadline', async () => {
    const events: string[] = [];
    const producers = createDaemonWorkProducers(quietLog);
    const fast = sweep(events, 'schedule');
    const slow = sweep(events, 'auto-merge');
    producers.add('schedule', fast.start);
    producers.add('auto-merge', slow.start);
    fast.release();
    assert.deepEqual(await producers.pause(50), ['auto-merge']);
    assert.ok(events.includes('schedule stopped'));
    assert.ok(!events.includes('auto-merge stopped'));

    slow.release();
    assert.deepEqual(await producers.pause(50), [], 'a later pause waits for the same stop');
    await producers.stop();
});

test('resume starts each producer again only once its earlier run has finished', async () => {
    const events: string[] = [];
    const producers = createDaemonWorkProducers(quietLog);
    const slow = sweep(events, 'auto-merge');
    producers.add('auto-merge', slow.start);
    assert.deepEqual(await producers.pause(10), ['auto-merge']);
    producers.resume();
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(slow.starts, 1, 'not restarted while its run is still going: no overlap');

    slow.release();
    await new Promise(resolve => setTimeout(resolve, 10));
    assert.equal(slow.starts, 2);
    assert.deepEqual(events, ['auto-merge started', 'auto-merge stopped', 'auto-merge started']);
    slow.release();
    await producers.stop();
});

test('a producer added while paused starts on resume; none starts again once closed', async () => {
    const events: string[] = [];
    const producers = createDaemonWorkProducers(quietLog);
    await producers.pause(10);
    const late = sweep(events, 'merge conflict');
    producers.add('merge conflict', late.start);
    assert.equal(late.starts, 0);
    producers.resume();
    await new Promise(resolve => setTimeout(resolve, 10));
    assert.equal(late.starts, 1);

    late.release();
    await producers.stop();
    producers.resume();
    await new Promise(resolve => setTimeout(resolve, 10));
    assert.equal(late.starts, 1, 'closed stays closed');
});

test('a resume that races another pause does not start the producer', async () => {
    const events: string[] = [];
    const producers = createDaemonWorkProducers(quietLog);
    const slow = sweep(events, 'schedule');
    producers.add('schedule', slow.start);
    await producers.pause(10);
    producers.resume();
    const paused = producers.pause(1_000);
    slow.release();
    assert.deepEqual(await paused, []);
    await new Promise(resolve => setTimeout(resolve, 10));
    assert.equal(slow.starts, 1);
    await producers.stop();
});
