import assert from 'node:assert/strict';
import * as actualChildProcess from 'node:child_process';
import { EventEmitter } from 'node:events';
import { mock, test } from 'node:test';

function pausableStream() {
    return Object.assign(new EventEmitter(), {
        paused: false,
        pause(): void { this.paused = true; },
        resume(): void { this.paused = false; },
    });
}

const child = Object.assign(new EventEmitter(), {
    stdout: pausableStream(),
    stderr: pausableStream(),
    stdin: { destroyed: false, writableEnded: false, write(_d: string, cb: (e?: Error | null) => void) { cb(); return true; }, end() { this.writableEnded = true; } },
    exitCode: null as number | null,
    kill: mock.fn(() => true),
});

await mock.module('child_process', {
    namedExports: {
        ...actualChildProcess,
        spawn: mock.fn(() => child),
        execFileSync: mock.fn(),
    },
});

const { executeSupervisedDockerCommand } = await import('../src/claude/docker/supervisedDockerExecutor.js');

const tick = (): Promise<void> => new Promise(resolve => setImmediate(resolve));

test('a slow sink pauses the source streams and preserves ordering without unbounded buffering', async () => {
    const received: string[] = [];
    const gates: Array<() => void> = [];
    const execution = executeSupervisedDockerCommand(['run', 'img'], {
        goalId: 'g', sessionId: 's', controllerEpoch: 1, turnId: 't',
        maxQueuedBytes: 200,
        durableOutput: output => {
            received.push(output.data);
            return new Promise<void>(resolve => { gates.push(resolve); });
        },
    });

    const chunk = 'x'.repeat(30);
    for (let i = 0; i < 4; i += 1) child.stdout.emit('data', Buffer.from(`${i}${chunk}`));
    await tick();

    // The first chunk is in flight; the rest are queued past the high-water mark,
    // so the source stream is paused and memory stays bounded.
    assert.equal(child.stdout.paused, true);
    assert.equal(received.length, 1);

    // Release deliveries one at a time; ordering is preserved and the stream
    // resumes once the backlog drains below the low-water mark.
    while (gates.length) {
        const release = gates.shift()!;
        release();
        await tick();
    }
    assert.equal(child.stdout.paused, false);
    assert.deepEqual(received.map(value => value[0]), ['0', '1', '2', '3']);

    child.exitCode = 0;
    child.emit('close', 0);
    assert.deepEqual(await execution.completion, { exitCode: 0 });
});

test('exceeding the queued-byte bound cancels with an actionable overflow error', async () => {
    const execution = executeSupervisedDockerCommand(['run', 'img'], {
        goalId: 'g', sessionId: 's', controllerEpoch: 1, turnId: 't2',
        maxQueuedBytes: 16,
        // Never resolves: simulates a sink that is permanently too slow.
        durableOutput: () => new Promise<void>(() => {}),
    });

    child.stdout.emit('data', Buffer.from('y'.repeat(64)));
    await tick();
    child.emit('close', 0);

    await assert.rejects(execution.completion, /backpressure bound/);
});
