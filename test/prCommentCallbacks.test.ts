import assert from 'node:assert/strict';
import { mock, test } from 'node:test';

class SupersededTaskAttemptError extends Error {
    constructor(taskId: string) {
        super(`superseded: ${taskId}`);
    }
}

const log = {
    info: mock.fn(),
    warn: mock.fn(),
    debug: mock.fn(),
};

await mock.module('@propr/core', {
    namedExports: {
        filterCommentByAuthor: () => true,
        logger: log,
        SupersededTaskAttemptError,
        TaskStates: {
            COMPLETED: 'completed',
            FAILED: 'failed',
            CANCELLED: 'cancelled',
            CLAUDE_EXECUTION: 'claude_execution',
        },
    },
});

await mock.module('../src/jobs/prCommentMetrics.js', {
    namedExports: { buildMetricsSection: () => '' },
});

await mock.module('../src/jobs/prCompletionComment.js', {
    namedExports: { buildCompletionComment: () => '' },
});

await mock.module('../src/jobs/prFileUtils.js', {
    namedExports: {
        fetchPRFiles: async () => [],
        fetchPRFileContents: async () => [],
        formatPRDiff: () => '',
        formatPRDiffWithMetadata: () => '',
        formatFileContents: () => '',
        agentResultToClaudeResponse: (value: unknown) => value,
    },
});

await mock.module('../src/jobs/prCommentCommandContext.js', {
    namedExports: { applyPendingCommentCommandContext: () => {} },
});

await mock.module('../src/jobs/prCommentTaskTitleUpdate.js', {
    namedExports: { updateTaskTitleForPR: async () => {} },
});

const {
    createContainerIdCallbackForPR,
    createSessionIdCallbackForPR,
} = await import('../src/jobs/prCommentJobHelpers.js');

test('session callback propagates superseded generation ownership', async () => {
    const callback = createSessionIdCallbackForPR(
        'task-1748',
        { repoOwner: 'integry', repoName: 'propr', pullRequestNumber: 1748 },
        {
            llm: 'codex',
            stateManager: {
                getTaskState: async () => ({
                    state: 'claude_execution',
                    prProcessingLockToken: 'successor-token',
                }),
            },
            correlatedLogger: log,
            redisClient: {},
            prProcessingLockToken: 'stale-token',
        } as never,
    );

    await assert.rejects(callback('session-old'), SupersededTaskAttemptError);
});

test('container callback propagates superseded generation ownership', async () => {
    const callback = createContainerIdCallbackForPR(
        'task-1748',
        {
            getTaskState: async () => ({
                state: 'claude_execution',
                prProcessingLockToken: 'successor-token',
            }),
        } as never,
        'stale-token',
    );

    await assert.rejects(
        callback('container-old', 'agent-old'),
        SupersededTaskAttemptError,
    );
});
