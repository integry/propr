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

const { stopDockerContainer } = await import('../src/claude/docker/dockerContainerControl.js');

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
            args: ['ps', '-a', '--filter', 'id=safe-container', '--format', '{{.Status}}'],
            timeout: 5000,
        },
        {
            file: '/usr/bin/docker',
            args: ['stop', '-t', '17', 'safe-container'],
            timeout: 22000,
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
