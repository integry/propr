import assert from 'node:assert/strict';
import { beforeEach, mock, test } from 'node:test';

class SupersededTaskAttemptError extends Error {}

let updatedRows = 1;
const update = mock.fn(async (_values: Record<string, unknown>) => updatedRows);
const andWhere = mock.fn(function (this: unknown, _column: string, _value: string) {
    return query;
});
const query = {
    where: mock.fn(() => query),
    andWhere,
    update,
};

await mock.module('@propr/core', {
    namedExports: {
        db: () => query,
        hashTaskAttemptToken: (token: string) => `hash:${token}`,
        SupersededTaskAttemptError,
    },
});

const { updateTaskTitleForPR } = await import('../src/jobs/prCommentTaskTitleUpdate.js');

const correlatedLogger = {
    info: mock.fn(),
    warn: mock.fn(),
};

beforeEach(() => {
    updatedRows = 1;
    query.where.mock.resetCalls();
    andWhere.mock.resetCalls();
    update.mock.resetCalls();
});

test('fences the SQL title update and strips the ephemeral lease token', async () => {
    const updateIssueRef = mock.fn(async () => ({}));
    const stateManager = {
        getTaskState: async () => ({ prProcessingLockToken: 'attempt-token' }),
        updateIssueRef,
    };
    const jobData = {
        pullRequestNumber: 1748,
        repoOwner: 'integry',
        repoName: 'propr',
        correlationId: 'correlation',
        title: 'Fix PR #1748',
        subtitle: 'Fence title writes',
        prProcessingLockToken: 'attempt-token',
    };

    await updateTaskTitleForPR({
        taskId: 'task-1748',
        jobData: jobData as never,
        stateManager: stateManager as never,
        correlatedLogger: correlatedLogger as never,
        prProcessingLockToken: 'attempt-token',
    });

    assert.deepEqual(andWhere.mock.calls[0].arguments, ['attempt_generation', 'hash:attempt-token']);
    const persisted = JSON.parse((update.mock.calls[0].arguments[0] as { initial_job_data: string }).initial_job_data);
    assert.equal(persisted.prProcessingLockToken, undefined);
    assert.equal(persisted.title, 'Fix PR #1748');
    assert.equal(updateIssueRef.mock.calls.length, 1);
});

test('does not update Redis metadata when SQL ownership changes at the write', async () => {
    updatedRows = 0;
    const updateIssueRef = mock.fn(async () => ({}));
    const stateManager = {
        getTaskState: async () => ({ prProcessingLockToken: 'old-token' }),
        updateIssueRef,
    };

    await assert.rejects(
        updateTaskTitleForPR({
            taskId: 'task-takeover',
            jobData: {
                pullRequestNumber: 1748,
                repoOwner: 'integry',
                repoName: 'propr',
                correlationId: 'correlation',
                title: 'Old title',
                prProcessingLockToken: 'old-token',
            } as never,
            stateManager: stateManager as never,
            correlatedLogger: correlatedLogger as never,
            prProcessingLockToken: 'old-token',
        }),
        SupersededTaskAttemptError,
    );

    assert.equal(updateIssueRef.mock.calls.length, 0);
});
