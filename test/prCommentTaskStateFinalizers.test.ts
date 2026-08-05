import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import type { Job } from 'bullmq';
import type { JobResult, WorkerStateManager } from '@propr/core';
import type { MainJobData, MainWorker } from '../src/workerFactory.js';

const finalizeCompletedPRCommentTask = mock.fn(async () => true);
const finalizeFailedPRCommentTask = mock.fn(async () => true);
const logInfo = mock.fn();
const logError = mock.fn();

await mock.module('../src/jobs/prCommentTaskFinalizer.js', {
    namedExports: { finalizeCompletedPRCommentTask, finalizeFailedPRCommentTask },
});
await mock.module('@propr/core', {
    namedExports: { logger: { info: logInfo, error: logError } },
});

const { attachPRCommentTaskStateFinalizers } = await import('../src/jobs/prCommentTaskStateFinalizers.js');

type Listener = (...args: never[]) => void;

function createWorkerHarness() {
    const listeners = new Map<string, Listener>();
    const worker = {
        on: mock.fn((event: string, listener: Listener) => {
            listeners.set(event, listener);
            return worker;
        }),
        off: mock.fn((event: string, listener: Listener) => {
            if (listeners.get(event) === listener) listeners.delete(event);
            return worker;
        }),
    };
    return {
        worker: worker as unknown as MainWorker,
        emit(event: string, ...args: unknown[]) {
            listeners.get(event)?.(...args as never[]);
        },
        listeners,
    };
}

function makeJob(getState: () => Promise<string>, name = 'processPullRequestComment') {
    return {
        id: 'task-123',
        name,
        getState,
    } as unknown as Job<MainJobData>;
}

test('completed hook finalizes only PR comment jobs', async () => {
    finalizeCompletedPRCommentTask.mock.resetCalls();
    const harness = createWorkerHarness();
    const stateManager = {} as WorkerStateManager;
    const finalizers = attachPRCommentTaskStateFinalizers(harness.worker, stateManager);

    const result: JobResult = { status: 'skipped' };
    harness.emit('completed', makeJob(async () => 'completed'), result);
    harness.emit('completed', makeJob(async () => 'completed', 'processGitHubIssue'), result);
    await finalizers.close();

    assert.equal(finalizeCompletedPRCommentTask.mock.calls.length, 1);
    assert.equal(finalizeCompletedPRCommentTask.mock.calls[0].arguments[0], 'task-123');
    assert.equal(harness.listeners.size, 0);
});

test('failed hook ignores retryable attempts and finalizes exhausted jobs', async () => {
    finalizeFailedPRCommentTask.mock.resetCalls();
    const harness = createWorkerHarness();
    const finalizers = attachPRCommentTaskStateFinalizers(
        harness.worker,
        {} as WorkerStateManager,
    );

    harness.emit('failed', makeJob(async () => 'waiting'), new Error('retrying'));
    harness.emit('failed', makeJob(async () => 'failed'), new Error('exhausted'));
    await finalizers.close();

    assert.equal(finalizeFailedPRCommentTask.mock.calls.length, 1);
    assert.equal(finalizeFailedPRCommentTask.mock.calls[0].arguments[1].message, 'exhausted');
});
