import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import type { Job } from 'bullmq';
import type { JobResult, WorkerStateManager } from '@propr/core';
import type { MainJobData, MainWorker } from '../src/workerFactory.js';

const finalizedResult = { outcome: 'finalized' as const, stateChanged: true };
const finalizeCompletedPRCommentTask = mock.fn(async () => finalizedResult);
const finalizeFailedPRCommentTask = mock.fn(async () => finalizedResult);
const logInfo = mock.fn();
const logError = mock.fn();
const logWarn = mock.fn();
const logDebug = mock.fn();

await mock.module('../src/jobs/prCommentTaskFinalizer.js', {
    namedExports: { finalizeCompletedPRCommentTask, finalizeFailedPRCommentTask },
});
await mock.module('@propr/core', {
    namedExports: { logger: { info: logInfo, error: logError, warn: logWarn, debug: logDebug } },
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

function makeJob(
    getState: () => Promise<string>,
    name = 'processPullRequestComment',
    options: { attempts?: number; removeOnFail?: boolean } = { attempts: 3 },
    attemptsMade = 1,
) {
    return {
        id: 'task-123',
        name,
        getState,
        opts: options,
        attemptsMade,
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

test('failed hook finalizes an exhausted job from retry metadata without a state lookup', async () => {
    finalizeFailedPRCommentTask.mock.resetCalls();
    const harness = createWorkerHarness();
    const finalizers = attachPRCommentTaskStateFinalizers(harness.worker, {} as WorkerStateManager);
    const getState = mock.fn(async () => { throw new Error('job was removed'); });

    harness.emit('failed', makeJob(getState, 'processPullRequestComment', { attempts: 3 }, 3), new Error('exhausted'));
    await finalizers.close();

    assert.equal(finalizeFailedPRCommentTask.mock.calls.length, 1);
    assert.equal(getState.mock.calls.length, 0);
});

test('failed hook handles jobs removed immediately on failure', async () => {
    finalizeFailedPRCommentTask.mock.resetCalls();
    const harness = createWorkerHarness();
    const finalizers = attachPRCommentTaskStateFinalizers(harness.worker, {} as WorkerStateManager);

    harness.emit(
        'failed',
        makeJob(async () => 'unknown', 'processPullRequestComment', { attempts: 3, removeOnFail: true }, 1),
        new Error('unrecoverable'),
    );
    await finalizers.close();

    assert.equal(finalizeFailedPRCommentTask.mock.calls.length, 1);
});

test('failed hook retries a transient job-state lookup error', async () => {
    finalizeFailedPRCommentTask.mock.resetCalls();
    const harness = createWorkerHarness();
    const finalizers = attachPRCommentTaskStateFinalizers(harness.worker, {} as WorkerStateManager);
    let attempts = 0;

    harness.emit('failed', makeJob(async () => {
        attempts++;
        if (attempts === 1) throw new Error('transient Redis error');
        return 'failed';
    }), new Error('exhausted'));
    await finalizers.close();

    assert.equal(attempts, 2);
    assert.equal(finalizeFailedPRCommentTask.mock.calls.length, 1);
});

test('close waits for pending finalizers to drain', async (t) => {
    const originalImplementation = finalizeCompletedPRCommentTask.mock.mockImplementation;
    t.after(() => finalizeCompletedPRCommentTask.mock.mockImplementation(originalImplementation));
    let releaseFinalizer: (() => void) | undefined;
    let signalFinalizerStarted: (() => void) | undefined;
    const finalizerStarted = new Promise<void>(resolve => { signalFinalizerStarted = resolve; });
    finalizeCompletedPRCommentTask.mock.mockImplementation(async () => {
        signalFinalizerStarted?.();
        return new Promise<typeof finalizedResult>(resolve => {
            releaseFinalizer = () => resolve(finalizedResult);
        });
    });
    const harness = createWorkerHarness();
    const finalizers = attachPRCommentTaskStateFinalizers(harness.worker, {} as WorkerStateManager);

    harness.emit('completed', makeJob(async () => 'completed'), { status: 'complete' });
    await finalizerStarted;
    let closeSettled = false;
    const closePromise = finalizers.close().then(() => { closeSettled = true; });

    await Promise.resolve();
    assert.equal(closeSettled, false);

    releaseFinalizer?.();
    await closePromise;
    assert.equal(closeSettled, true);
});
