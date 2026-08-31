import assert from 'node:assert/strict';
import * as actualChildProcess from 'node:child_process';
import { EventEmitter } from 'node:events';
import { mock, test } from 'node:test';

const spawnCalls: Array<{ command: string; args: string[] }> = [];
const writtenInput: string[] = [];
const child = Object.assign(new EventEmitter(), {
    stdout: new EventEmitter(),
    stderr: new EventEmitter(),
    stdin: {
        destroyed: false,
        writableEnded: false,
        write(data: string, callback: (error?: Error | null) => void) {
            writtenInput.push(data);
            callback();
            return true;
        },
        end() { this.writableEnded = true; },
    },
    exitCode: null as number | null,
    signalCode: null as NodeJS.Signals | null,
    kill: mock.fn(() => true),
});

await mock.module('child_process', {
    namedExports: {
        ...actualChildProcess,
        spawn: mock.fn((command: string, args: string[]) => {
            spawnCalls.push({ command, args });
            return child;
        }),
        execFileSync: mock.fn(),
    },
});

const { executeSupervisedDockerCommand } = await import('../src/claude/docker/dockerExecutor.js');

test('duplex Docker execution fences labels, keeps stdin open, and durably orders stream chunks', async () => {
    const output: Array<{ channel: string; data: string }> = [];
    const execution = executeSupervisedDockerCommand(
        ['run', '--name', 'goal-container', 'propr/agent:test', 'agent-command'],
        {
            goalId: 'goal-one',
            sessionId: 'session-one',
            controllerEpoch: 7,
            turnId: 'turn-one',
            attemptId: 'attempt-one',
            worktreeFingerprint: 'worktree-one',
            durableOutput: async event => {
                await Promise.resolve();
                output.push({ channel: event.channel, data: event.data });
            },
        },
    );

    await execution.writeInput('corrective message\n');
    assert.equal(child.stdin.writableEnded, false);
    child.stdout.emit('data', Buffer.from('stdout-one'));
    child.stderr.emit('data', Buffer.from('stderr-one'));
    child.exitCode = 0;
    child.emit('close', 0);

    assert.deepEqual(await execution.completion, { exitCode: 0 });
    assert.deepEqual(writtenInput, ['corrective message\n']);
    assert.deepEqual(output, [
        { channel: 'stdout', data: 'stdout-one' },
        { channel: 'stderr', data: 'stderr-one' },
    ]);
    const args = spawnCalls[0].args;
    assert.ok(args.includes('propr.goal.id=goal-one'));
    assert.ok(args.includes('propr.goal.session=session-one'));
    assert.ok(args.includes('propr.goal.controller-epoch=7'));
    assert.ok(args.includes('propr.goal.turn=turn-one'));
    assert.ok(args.includes('propr.goal.attempt=attempt-one'));
    assert.ok(args.includes('propr.goal.worktree-fingerprint=worktree-one'));
    assert.equal(execution.containerName, 'goal-container');
});
