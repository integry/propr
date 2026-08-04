import { describe, test } from 'node:test';
import assert from 'node:assert';
import {
    findRunningDockerContainerForTask,
    type ExecutionResult,
} from '../packages/core/src/claude/docker/dockerExecutor.js';

function result(stdout: string, exitCode = 0, stderr = ''): ExecutionResult {
    return { stdout, stderr, exitCode, messageTimestamps: new Map() };
}

describe('running Docker task container lookup', () => {
    test('finds a running container by the task ID suffix', async () => {
        let receivedArgs: string[] = [];
        const executor = async (_command: string, args: string[]) => {
            receivedArgs = args;
            return result('417758dda147:codex-issue-1734-96957312\n');
        };

        const container = await findRunningDockerContainerForTask(
            'pr-comments-propr-gitfix-1734-96957312',
            executor,
        );

        assert.deepStrictEqual(container, {
            id: '417758dda147',
            name: 'codex-issue-1734-96957312',
        });
        assert.ok(receivedArgs.includes('name=96957312$'));
    });

    test('returns null when no matching container is running', async () => {
        const container = await findRunningDockerContainerForTask(
            'pr-comments-propr-gitfix-1734-96957312',
            async () => result(''),
        );

        assert.strictEqual(container, null);
    });

    test('fails open when Docker inspection is unavailable', async () => {
        const container = await findRunningDockerContainerForTask(
            'pr-comments-propr-gitfix-1734-96957312',
            async () => { throw new Error('Docker unavailable'); },
        );

        assert.strictEqual(container, null);
    });
});
