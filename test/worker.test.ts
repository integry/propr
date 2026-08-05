import assert from 'node:assert/strict';
import { after, describe, mock, test } from 'node:test';
import { closeConnection } from '@propr/core';
import {
    checkLabelConditions,
    ensureProcessingLabel,
    getAuthenticatedClient,
} from '../src/jobs/issueJob/github.ts';
import {
    createConfiguredMainWorker,
    createMainJobProcessor,
    type MainJobProcessors,
} from '../src/workerFactory.ts';

after(async () => {
    await closeConnection();
});

function createJobContext() {
    return {
        jobId: 'job-1',
        jobName: 'processGitHubIssue',
        issueRef: { number: 42, repoOwner: 'integry', repoName: 'propr' },
        correlationId: 'correlation-1',
        correlatedLogger: { warn: mock.fn() },
        stateManager: { markTaskFailed: mock.fn(async () => {}) },
        agentAlias: 'claude',
        modelName: 'test-model',
        taskId: 'task-1',
        AI_PROCESSING_TAG: 'AI-processing',
        AI_DONE_TAG: 'AI-done',
        AI_WAITING_TAG: 'AI-waiting',
        AI_PRIMARY_TAG: 'AI',
        PR_LABEL: 'propr',
    };
}

function createProcessorMocks(result: object = { status: 'complete' }) {
    return {
        processGitHubIssueJob: mock.fn(async () => result),
        processPullRequestCommentJob: mock.fn(async () => result),
        processTaskImportJob: mock.fn(async () => result),
        processSystemTaskJob: mock.fn(async () => result),
        processMergeConflictJob: mock.fn(async () => result),
    };
}

describe('worker behavioral contracts', () => {
    test('label gating skips missing-primary and completed issues', () => {
        const context = createJobContext();
        assert.deepEqual(checkLabelConditions(['bug'], context as never), {
            skip: true,
            reason: 'Primary tag missing',
        });
        assert.deepEqual(checkLabelConditions(['AI', 'AI-done'], context as never), {
            skip: true,
            reason: 'Already done',
        });
        assert.deepEqual(checkLabelConditions(['AI'], context as never), { skip: false });
    });

    test('processing-label behavior adds the tag once and preserves an existing tag', async () => {
        const context = createJobContext();
        const addLabel = mock.fn(async () => {});
        await ensureProcessingLabel(['AI'], context as never, {} as never, addLabel as never);
        assert.equal(addLabel.mock.calls.length, 1);
        assert.equal(addLabel.mock.calls[0].arguments[1], 'AI-processing');

        await ensureProcessingLabel(['AI', 'AI-processing'], context as never, {} as never, addLabel as never);
        assert.equal(addLabel.mock.calls.length, 1);
    });

    test('authentication failures mark the task failed and remain observable', async () => {
        const context = createJobContext();
        const authError = new Error('Auth failed');
        await assert.rejects(
            getAuthenticatedClient(
                context as never,
                async () => { throw authError; },
                async operation => operation(),
                () => ({ category: 'authentication' }),
            ),
            authError,
        );
        assert.equal(context.stateManager.markTaskFailed.mock.calls.length, 1);
        assert.equal(context.stateManager.markTaskFailed.mock.calls[0].arguments[0], 'task-1');
        assert.equal(context.stateManager.markTaskFailed.mock.calls[0].arguments[1], authError);
    });

    test('runtime processor dispatches every supported job type and rejects unknown jobs', async () => {
        const processors = createProcessorMocks();
        const processJob = createMainJobProcessor(processors as unknown as MainJobProcessors);
        const names = [
            ['processGitHubIssue', 'processGitHubIssueJob'],
            ['processPullRequestComment', 'processPullRequestCommentJob'],
            ['processTaskImport', 'processTaskImportJob'],
            ['processSystemTask', 'processSystemTaskJob'],
            ['processMergeConflict', 'processMergeConflictJob'],
        ] as const;

        for (const [jobName, processorName] of names) {
            await processJob({ name: jobName } as never);
            assert.equal(processors[processorName].mock.calls.length, 1);
        }
        await assert.rejects(processJob({ name: 'unknown' } as never), /Unknown job type: unknown/);
    });

    test('worker construction attaches hooks before starting the paused worker', async () => {
        const startupOrder: string[] = [];
        const fakeWorker = {
            close: mock.fn(async () => {}),
            run: mock.fn(async () => { startupOrder.push('run'); }),
            emit: mock.fn(),
        };
        let capturedProcessor: ((job: never) => Promise<unknown>) | undefined;
        const workerFactory = mock.fn(async (queueName: string, processor: typeof capturedProcessor, options: { concurrency: number; autorun: boolean }) => {
            assert.equal(queueName, 'test-queue');
            assert.deepEqual(options, { concurrency: 7, autorun: false });
            capturedProcessor = processor;
            return fakeWorker;
        });
        const processors = createProcessorMocks({ status: 'constructed' });

        const worker = await createConfiguredMainWorker({
            queueName: 'test-queue',
            concurrency: 7,
            workerFactory: workerFactory as never,
            processors: processors as unknown as MainJobProcessors,
            beforeRun: () => { startupOrder.push('listeners'); },
        });

        assert.equal(worker, fakeWorker);
        assert.equal(workerFactory.mock.calls.length, 1);
        assert.ok(capturedProcessor);
        assert.deepEqual(startupOrder, ['listeners', 'run']);
        assert.deepEqual(await capturedProcessor({ name: 'processSystemTask' } as never), { status: 'constructed' });
    });
});
