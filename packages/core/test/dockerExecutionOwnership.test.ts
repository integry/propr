import assert from 'node:assert/strict';
import type { ChildProcess } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { mock, test } from 'node:test';
import type { DockerExecutionTeardownOptions } from '../src/claude/docker/dockerContainerControl.js';

const teardownDockerExecution = mock.fn(async (_options: DockerExecutionTeardownOptions) => {});

await mock.module('../src/claude/docker/dockerContainerControl.js', {
    namedExports: { teardownDockerExecution },
});

const { abortSpawnedExecution } = await import('../src/claude/docker/dockerExecutionOwnership.js');

test('runs a final generation-fenced teardown after fallback child termination', async () => {
    const kill = mock.fn(() => true);
    const scheduleForceKill = mock.fn();
    const childState = Object.assign(new EventEmitter(), {
        exitCode: null as number | null,
        signalCode: null as NodeJS.Signals | null,
        kill,
    });
    const child = childState as unknown as ChildProcess;
    const state = {
        aborted: { value: false },
        containerId: { value: 'container-one' },
        teardownPromise: null,
    };

    const teardown = abortSpawnedExecution(child, state, {
        namedContainer: 'propr-agent-task-1748',
        scheduleForceKill,
        taskId: 'task-1748',
        attemptGeneration: 'generation-hash',
    });

    assert.deepEqual(kill.mock.calls[0]?.arguments, ['SIGTERM']);
    assert.equal(scheduleForceKill.mock.calls.length, 1);
    assert.equal(teardownDockerExecution.mock.calls.length, 1);

    childState.signalCode = 'SIGKILL';
    childState.emit('exit', null, 'SIGKILL');
    await teardown;

    assert.equal(teardownDockerExecution.mock.calls.length, 2);
    assert.deepEqual(teardownDockerExecution.mock.calls[1]?.arguments[0], {
        taskId: 'task-1748',
        attemptGeneration: 'generation-hash',
        containerId: 'container-one',
        containerName: 'propr-agent-task-1748',
    });
});
