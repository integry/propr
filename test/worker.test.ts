import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
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

const workerSource = readFileSync(new URL('../src/worker.ts', import.meta.url), 'utf8');
const issueProcessorSource = readFileSync(new URL('../src/jobs/processGitHubIssueJob.ts', import.meta.url), 'utf8');

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

    test('worker construction passes the queue, runtime processor, and concurrency to the factory', async () => {
        const fakeWorker = { close: mock.fn(async () => {}) };
        let capturedProcessor: ((job: never) => Promise<unknown>) | undefined;
        const workerFactory = mock.fn(async (queueName: string, processor: typeof capturedProcessor, options: { concurrency: number }) => {
            assert.equal(queueName, 'test-queue');
            assert.deepEqual(options, { concurrency: 7 });
            capturedProcessor = processor;
            return fakeWorker;
        });
        const processors = createProcessorMocks({ status: 'constructed' });

        const worker = await createConfiguredMainWorker({
            queueName: 'test-queue',
            concurrency: 7,
            workerFactory: workerFactory as never,
            processors: processors as unknown as MainJobProcessors,
        });

        assert.equal(worker, fakeWorker);
        assert.equal(workerFactory.mock.calls.length, 1);
        assert.ok(capturedProcessor);
        assert.deepEqual(await capturedProcessor({ name: 'processSystemTask' } as never), { status: 'constructed' });
    });
});

describe('worker composition contract', () => {
    test('wires every supported job processor into the worker entrypoint', () => {
        for (const processor of [
            'processGitHubIssueJob',
            'processPullRequestCommentJob',
            'processTaskImportJob',
            'processSystemTaskJob',
            'processMergeConflictJob',
        ]) {
            assert.match(workerSource, new RegExp(`import \\{ ${processor} \\}`));
            assert.match(workerSource, new RegExp(`export \\{[^}]*${processor}`));
        }
    });

    test('starts the long-running worker only for direct CLI execution', () => {
        assert.match(workerSource, /if \(import\.meta\.url === `file:\/\/\$\{process\.argv\[1\]\}`\)/);
        assert.match(workerSource, /await startWorker\(options\)/);
    });

    test('keeps matrix dispatch separate from child issue execution', () => {
        assert.match(issueProcessorSource, /if \(!job\.data\.isChildJob\)/);
        assert.match(issueProcessorSource, /return await handleDispatch\(job\)/);
        assert.match(issueProcessorSource, /await initializeJobContext\(job\)/);
    });

    test('enforces label checks before repository mutation', () => {
        const labelCheck = issueProcessorSource.indexOf('checkLabelConditions(currentLabels, context)');
        const clone = issueProcessorSource.indexOf('ensureRepoCloned(');
        assert.ok(labelCheck >= 0);
        assert.ok(clone > labelCheck);
    });
});
