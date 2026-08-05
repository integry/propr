import assert from 'node:assert/strict';
import { beforeEach, mock, test } from 'node:test';

type ExecCallback = (error: Error | null, stdout: string, stderr: string) => void;

const dockerCalls: Array<{ file: string; args: string[]; timeout: number }> = [];
const responses: Array<{ error: Error | null; stdout: string; stderr: string }> = [];
const execFileMock = mock.fn((
    file: string,
    args: string[],
    options: { timeout: number },
    callback: ExecCallback,
) => {
    dockerCalls.push({ file, args, timeout: options.timeout });
    const response = responses.shift() ?? { error: null, stdout: '', stderr: '' };
    queueMicrotask(() => callback(response.error, response.stdout, response.stderr));
    return undefined;
});

await mock.module('node:child_process', {
    namedExports: { execFile: execFileMock },
});

await mock.module('../src/utils/logger.js', {
    defaultExport: {
        info: mock.fn(),
        warn: mock.fn(),
        error: mock.fn(),
        debug: mock.fn(),
    },
});

const { stopDockerContainer, teardownDockerExecution } = await import('../src/claude/docker/dockerContainerControl.js');

beforeEach(() => {
    dockerCalls.length = 0;
    responses.length = 0;
});

test('rejects unsafe Docker identifiers and timeout values without spawning a process', async () => {
    const injected = await stopDockerContainer('container;touch /tmp/injected');
    const optionLike = await stopDockerContainer('--all');
    const excessiveTimeout = await stopDockerContainer('safe-container', 301);

    assert.equal(injected.success, false);
    assert.match(injected.error ?? '', /Invalid Docker container identifier/);
    assert.equal(optionLike.success, false);
    assert.equal(excessiveTimeout.success, false);
    assert.match(excessiveTimeout.error ?? '', /between 0 and 300/);
    assert.equal(dockerCalls.length, 0);
});

test('passes validated Docker values as argument-array entries', async () => {
    responses.push(
        { error: null, stdout: 'Up 2 minutes\n', stderr: '' },
        { error: null, stdout: 'safe-container\n', stderr: '' },
    );

    const result = await stopDockerContainer('safe-container', 17);

    assert.equal(result.success, true);
    assert.deepEqual(dockerCalls, [
        {
            file: '/usr/bin/docker',
            args: ['inspect', '--type', 'container', '--format', '{{.State.Status}}', 'safe-container'],
            timeout: 5000,
        },
        {
            file: '/usr/bin/docker',
            args: ['stop', '-t', '17', 'safe-container'],
            timeout: 22000,
        },
        {
            file: '/usr/bin/docker',
            args: ['rm', '-f', 'safe-container'],
            timeout: 10000,
        },
    ]);
});

test('force-kills asynchronously when graceful stop fails', async () => {
    responses.push(
        { error: null, stdout: 'Up 2 minutes\n', stderr: '' },
        { error: new Error('stop failed'), stdout: '', stderr: 'stop failed' },
        { error: null, stdout: 'safe-container\n', stderr: '' },
    );

    const result = await stopDockerContainer('abcdef123456');

    assert.equal(result.success, true);
    assert.deepEqual(dockerCalls[2]?.args, ['kill', 'abcdef123456']);
});

test('stops a restarting container instead of treating it as terminal', async () => {
    responses.push(
        { error: null, stdout: 'Restarting (1) 2 seconds ago\n', stderr: '' },
        { error: null, stdout: 'safe-container\n', stderr: '' },
    );

    const result = await stopDockerContainer('safe-container');

    assert.equal(result.success, true);
    assert.deepEqual(dockerCalls[1]?.args, ['stop', '-t', '10', 'safe-container']);
});

test('removes a generation-matched container that never reached running state', async () => {
    responses.push(
        { error: null, stdout: 'created\n', stderr: '' },
        { error: null, stdout: 'safe-container\n', stderr: '' },
    );

    const result = await stopDockerContainer('safe-container');

    assert.equal(result.success, true);
    assert.deepEqual(dockerCalls[1]?.args, ['rm', '-f', 'safe-container']);
});

test('reports failure when an abandoned non-running container cannot be removed', async () => {
    responses.push(
        { error: null, stdout: 'exited\n', stderr: '' },
        { error: new Error('daemon refused removal'), stdout: '', stderr: 'daemon refused removal' },
    );

    const result = await stopDockerContainer('safe-container');

    assert.equal(result.success, false);
    assert.match(result.error ?? '', /refused removal/);
    assert.equal(dockerCalls.length, 2);
});

test('inspects and stops an exact container name when no container ID is available yet', async () => {
    responses.push(
        { error: null, stdout: 'running\n', stderr: '' },
        { error: null, stdout: 'propr-agent-task-name\n', stderr: '' },
    );

    const result = await stopDockerContainer('propr-agent-task-name');

    assert.equal(result.success, true);
    assert.deepEqual(dockerCalls[0]?.args, [
        'inspect', '--type', 'container', '--format', '{{.State.Status}}', 'propr-agent-task-name',
    ]);
    assert.deepEqual(dockerCalls[1]?.args, ['stop', '-t', '10', 'propr-agent-task-name']);
});

test('retries generation-labeled teardown across the Docker creation race', async () => {
    responses.push(
        { error: null, stdout: '', stderr: '' },
        { error: null, stdout: 'container-one\ncontainer-two\n', stderr: '' },
        { error: null, stdout: 'container-one\n', stderr: '' },
        { error: null, stdout: 'container-two\n', stderr: '' },
        { error: null, stdout: '', stderr: '' },
    );

    await teardownDockerExecution({
        taskId: 'task-1748',
        attemptGeneration: 'generation-hash',
        attempts: 3,
        retryDelayMs: 0,
    });

    assert.deepEqual(dockerCalls[0]?.args, [
        'ps', '-aq',
        '--filter', 'label=propr.task.id=task-1748',
        '--filter', 'label=propr.task.attempt-generation=generation-hash',
    ]);
    assert.deepEqual(dockerCalls[1]?.args, ['ps', '-aq', '--filter', 'label=propr.task.id=task-1748', '--filter', 'label=propr.task.attempt-generation=generation-hash']);
    assert.deepEqual(dockerCalls[2]?.args, ['rm', '-f', 'container-one']);
    assert.deepEqual(dockerCalls[3]?.args, ['rm', '-f', 'container-two']);
    assert.equal(dockerCalls.length, 4);
});

test('does not retry label queries when the Docker daemon is unavailable', async () => {
    responses.push({
        error: new Error('Cannot connect to the Docker daemon'),
        stdout: '',
        stderr: 'Cannot connect to the Docker daemon',
    });

    await teardownDockerExecution({
        taskId: 'task-1748',
        attemptGeneration: 'generation-hash',
    });

    assert.equal(dockerCalls.length, 1);
    assert.equal(dockerCalls[0]?.timeout, 1000);
});

test('retries a failed forced removal until the container is gone', async () => {
    responses.push(
        { error: null, stdout: 'container-one\n', stderr: '' },
        { error: new Error('daemon refused removal'), stdout: '', stderr: 'daemon refused removal' },
        { error: null, stdout: '', stderr: '' },
    );

    await teardownDockerExecution({
        taskId: 'task-1748',
        attemptGeneration: 'generation-hash',
        attempts: 1,
        retryDelayMs: 0,
        deadlineMs: 500,
    });

    assert.deepEqual(dockerCalls.map(call => call.args), [
        ['ps', '-aq', '--filter', 'label=propr.task.id=task-1748', '--filter', 'label=propr.task.attempt-generation=generation-hash'],
        ['rm', '-f', 'container-one'],
        ['rm', '-f', 'container-one'],
    ]);
});
