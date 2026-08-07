import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

await mock.module('@propr/core', {
    namedExports: {
        createWorktreeFromExistingBranch: mock.fn(),
        ensureGitRepository: mock.fn(),
        ensureRepoCloned: mock.fn(),
        getRepoUrl: mock.fn(),
        resolveLlmLabel: mock.fn(),
    },
});
const { gatherReviewContext } = await import('../src/jobs/reviewContextScout.js');

test('context scout uses a read-only workspace with a 30 minute timeout', async () => {
    const root = await mkdtemp(join(tmpdir(), 'propr-review-scout-runtime-'));
    let receivedOptions: Record<string, unknown> | undefined;
    const agent = {
        analyze: mock.fn(async (_prompt: string, options: Record<string, unknown>) => {
            receivedOptions = options;
            return {
                success: true,
                response: '{"references":[]}',
                modelUsed: 'fast-model',
                executionTimeMs: 1,
            };
        }),
    };
    const logger = { info: mock.fn(), warn: mock.fn(), error: mock.fn(), debug: mock.fn() };

    const result = await gatherReviewContext({
        agent: agent as never,
        model: 'fast-model',
        worktreePath: root,
        prDiff: '## src/changed.ts\n+changed',
        changedFiles: ['src/changed.ts'],
        originalTaskSpec: 'Keep review scope focused',
        pullRequestNumber: 1761,
        repoOwner: 'integry',
        repoName: 'propr',
        taskId: 'task-1',
        correlationId: 'correlation-1',
        correlatedLogger: logger as never,
    });

    assert.equal(result.context, '');
    assert.equal(receivedOptions?.timeoutMs, 30 * 60 * 1000);
    assert.equal(receivedOptions?.readOnlyWorkspacePath, root);
    assert.equal(receivedOptions?.allowReadOnlyCommands, true);
    assert.equal(receivedOptions?.responseFormat, 'json');
});
