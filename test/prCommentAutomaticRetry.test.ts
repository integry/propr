import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { after, beforeEach, describe, mock, test } from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { UnrecoverableError } from 'bullmq';

/**
 * A PR comment task keeps its BullMQ job ID, so BullMQ's automatic retry of a
 * failed attempt runs under the same task. These tests run the real processor
 * (processPullRequestCommentJob), its real task initialization, collision and
 * cancellation checks, its real error handler and cleanup, and the real worker
 * finalizers against the real WorkerStateManager and a migrated SQLite database.
 * Only Redis, the BullMQ worker loop, GitHub and the review execution itself are
 * in memory; the worker loop follows BullMQ's attempt accounting
 * (Job.moveToFailed / moveToCompleted / moveToDelayed with skipAttempt).
 */

const root = await mkdtemp(path.join(tmpdir(), 'pr-comment-retry-'));
process.env.DATA_DIR = root;
process.env.DB_FILENAME = path.join(root, 'core.sqlite');
process.env.NODE_ENV = 'test';

const redisValues = new Map<string, string>();
function FakeRedis() {
    return {
        on: () => {},
        get: async (key: string) => redisValues.get(key) ?? null,
        setex: async (key: string, _ttl: number, value: string) => { redisValues.set(key, value); return 'OK'; },
        set: async (key: string, value: string, ...args: unknown[]) => {
            if (args.includes('NX') && redisValues.has(key)) return null;
            redisValues.set(key, value);
            return 'OK';
        },
        // The worker state compare-and-set script: write only when the value is unchanged.
        eval: async (_script: string, _keys: number, key: string, expected: string, _ttl: string, next: string) => {
            if (redisValues.get(key) !== expected) return 0;
            redisValues.set(key, next);
            return 1;
        },
        llen: async () => 0,
        lrange: async () => [],
        rpush: async () => 1,
        keys: async () => [],
        del: async (key: string) => { redisValues.delete(key); return 1; },
        quit: async () => 'OK',
        disconnect: () => {},
    };
}
await mock.module('ioredis', { namedExports: { Redis: FakeRedis } });

const fakeQueue = { add: async () => { throw new Error('no replacement job is expected'); }, getJobs: async () => [], getJob: async () => undefined };
await mock.module('../packages/core/src/queue/taskQueue.js', { namedExports: {
    GITHUB_ISSUE_QUEUE_NAME: 'test-issues', COMMENT_BATCH_DELAY_MS: 3000, INDEXING_QUEUE_NAME: 'test-indexing',
    getIssueQueue: async () => fakeQueue, getIndexingQueue: async () => fakeQueue,
    issueQueue: fakeQueue, indexingQueue: fakeQueue,
    createWorker: async () => { throw new Error('not used'); }, shutdownQueue: async () => {},
} });
const publisher = { publishActivity: async () => true, publishTaskUpdate: async () => true, publishDraftUpdate: async () => true };
await mock.module('../packages/core/src/utils/eventPublisher.js', {
    namedExports: { getEventPublisher: () => publisher, closeEventPublisher: async () => {}, publishNotificationUpdateThroughRedis: () => {}, EventPublisher: class {} },
});

const { db, runMigrations, closeConnection } = await import('../packages/core/src/db/connection.js');
const { WorkerStateManager, TaskStates } = await import('../packages/core/src/utils/workerStateManager.js');
await runMigrations();
const stateManager = new WorkerStateManager({ keyPrefix: 'test:pr-comment-retry:' });

/** The PR state GitHub reports when the queued retry checks whether its intent still stands. */
let pullRequestClosed = false;
const core = await import('../packages/core/src/index.ts');
await mock.module('@propr/core', { namedExports: {
    ...core,
    getStateManager: () => stateManager,
    getAuthenticatedOctokit: async () => ({ request: async () => ({ data: {} }), auth: async () => ({ token: 'fixture' }) }),
    // Production's state effect of a withdrawn PR intent (taskIntent.preventWithdrawnJob):
    // the failed attempt's live retry is recorded as withdrawn. Label cleanup is covered by
    // test/taskIntentWithdrawal.test.ts.
    preventWithdrawnJob: async (job: { id?: string }) => {
        if (!pullRequestClosed) return null;
        const cancelled = await stateManager.markTaskCancelled(String(job.id), 'system', {
            reason: core.formatTaskTerminalReason?.('cancelled_pr_closed') ?? 'Cancelled because the pull request was closed without merging.',
            terminalReason: 'cancelled_pr_closed', withdrawnQueuedRetry: true,
        });
        return cancelled.state === TaskStates.CANCELLED || cancelled.state === TaskStates.FAILED ? 'cancelled_pr_closed' : null;
    },
    // No agent container from an earlier attempt is running.
    inspectTaskContainerLivenessForTask: async () => ({ liveness: 'not_found', container: null }),
    inspectLegacyDockerContainerLivenessForTask: async () => 'not_found',
} });

const noOp = async () => {};
/** Each attempt's review work: it records the same states the real review processing does. */
let reviewOutcomes: Array<'fail' | 'succeed'> = [];
let reviewStarts: Array<{ state: string; reason: string }> = [];
const modules: Record<string, Record<string, unknown>> = {
    runCostCap: {
        withRunCostCap: async (_target: unknown, operation: (guard: unknown) => Promise<unknown>) => operation({ setWorkflowCap: async () => undefined }),
        applyWorkflowCostCap: async (workflow: unknown) => workflow,
        pullRequestRunCostCapTarget: () => ({}),
    },
    prPendingComments: {
        pickUpPendingCommentsWithClaim: async (comments: unknown[]) => ({ commentsToProcess: comments, pickedUpComments: [] }),
        applyPendingCommentCommandContext: () => {}, restorePendingComments: noOp,
    },
    prProcessingLock: {
        acquirePRProcessingLock: async () => true, ensurePRProcessingLockToken: async () => 'lease-token',
        releasePRProcessingLock: async () => true, startPRProcessingLockHeartbeat: () => noOp,
    },
    prContinuation: { findPRContinuation: async () => null, continuationStatus: () => '' },
    prContinuationReview: { stopOriginalPRReviewCycle: async () => null },
    prPublicationRecovery: { recoverPendingPublication: async () => undefined },
    followupCiSuspension: { suspendObsoleteValidationForImplementation: noOp, releaseFollowupCiSuspensionsForTask: noOp },
    ultrafixJobHelpers: { handleUltrafixContinuation: noOp, markSelectedUltrafixFindings: noOp, restorePendingCommentsIfUltrafixJobSuperseded: async () => false },
    ultrafixReviewExecutionGate: { shouldDeferUltrafixReview: async () => null, ultrafixReviewDeferralUpdate: () => ({}) },
    prCommentAgentUtils: { generateSummaryTitle: noOp, resolveAndExecuteAgent: noOp, resolvePRCommentModelName: async () => 'Claude Opus 5.5' },
    prCommentReviewJob: {
        executeReviewProcessing: async ({ taskId }: { taskId: string }) => {
            const current = (await stateManager.getTaskState(taskId))!;
            reviewStarts.push({ state: current.state, reason: current.history.at(-1)!.reason });
            await stateManager.updateTaskState(taskId, TaskStates.PROCESSING, { reason: 'Starting review processing', historyMetadata: { commandMode: 'review' } });
            if (reviewOutcomes.shift() === 'fail') throw new Error('Provider stream reset by peer');
            await stateManager.updateTaskState(taskId, TaskStates.COMPLETED, {
                reason: 'Review processing completed successfully', historyMetadata: { commandMode: 'review' },
            });
            return { status: 'complete', pullRequestNumber: 42 };
        },
    },
};
for (const [name, namedExports] of Object.entries(modules)) {
    // Other job modules keep the real exports these fakes do not replace.
    const real = await import(`../src/jobs/${name}.js`);
    await mock.module(`../src/jobs/${name}.js`, { namedExports: { ...real, ...namedExports } });
}

const { processPullRequestCommentJob } = await import('../src/jobs/processPullRequestCommentJob.js');
const { attachPRCommentTaskStateFinalizers } = await import('../src/jobs/prCommentTaskStateFinalizers.js');
const { resumeAutomaticPRCommentRetry, scheduleAutomaticPRCommentRetry } = await import('../src/jobs/prCommentAutomaticRetry.js');

after(async () => {
    await stateManager.close();
    await closeConnection();
    await rm(root, { recursive: true, force: true });
});

const log = { info() {}, warn() {}, error() {}, debug() {} };

/** A BullMQ job for one PR comment, with BullMQ's attempt accounting. */
class QueueJob {
    name = 'processPullRequestComment';
    opts = { attempts: 3, backoff: { type: 'exponential', delay: 10_000 } };
    attemptsMade = 0;
    token: string | undefined = undefined;
    state = 'waiting';
    constructor(public id: string, public data: Record<string, unknown>) {}
    async getState() { return this.state; }
    async updateData(data: Record<string, unknown>) { this.data = data; }
    // A processor's own delay (lock or capacity wait) is not a counted attempt.
    async moveToDelayed() { this.state = 'delayed'; }
}

function commentJob(id = 'pr-comments-batch-acme-web-42-review-1') {
    return new QueueJob(id, {
        repoOwner: 'acme', repoName: 'web', pullRequestNumber: 42, commandMode: 'review',
        correlationId: `correlation-${id}`, llm: 'claude-opus-5-5', branchName: 'feature',
        commentId: 501, commentBody: '/review', commentAuthor: 'reviewer',
    });
}

/** The worker loop: run one attempt, move the job as BullMQ does, then deliver the event. */
class WorkerHarness {
    private readonly worker = new EventEmitter();
    exhausted: string[] = [];

    async runAttempt(job: QueueJob, options: { deliverEvent?: boolean } = {}) {
        job.state = 'active';
        job.token = 'worker-lock';
        let event: [string, ...unknown[]];
        try {
            const result = await processPullRequestCommentJob(job as never);
            job.attemptsMade += 1;
            job.state = 'completed';
            event = ['completed', job, result];
        } catch (error) {
            const retry = job.attemptsMade + 1 < job.opts.attempts && !(error instanceof UnrecoverableError);
            job.attemptsMade += 1;
            job.state = retry ? 'delayed' : 'failed';
            event = ['failed', job, error];
        } finally {
            job.token = undefined;
        }
        if (options.deliverEvent !== false) await this.deliver(...event);
        return event;
    }

    /** Delivers a worker event to the real finalizers and waits for them to settle. */
    async deliver(...[name, ...args]: [string, ...unknown[]]) {
        const finalizers = attachPRCommentTaskStateFinalizers(this.worker as never, stateManager, {
            onExhaustedFailure: async job => { this.exhausted.push(String(job.id)); },
        });
        this.worker.emit(name, ...args);
        await finalizers.close();
    }
}

async function task(taskId: string) {
    return (await stateManager.getTaskState(taskId))!;
}

async function persistedStates(taskId: string): Promise<string[]> {
    return (await db('task_history').where({ task_id: taskId }).orderBy('history_id')).map(row => row.state);
}

function retryRecord(entry: { metadata?: Record<string, unknown> }) {
    return entry.metadata?.automaticRetry as Record<string, unknown> | undefined;
}

let harness: WorkerHarness;
beforeEach(async () => {
    await db('task_history').delete();
    await db('tasks').delete();
    redisValues.clear();
    reviewOutcomes = [];
    reviewStarts = [];
    pullRequestClosed = false;
    harness = new WorkerHarness();
});

describe('automatic retry of a failed PR comment attempt', () => {
    test('a failed first attempt followed by a successful retry completes the same task', async () => {
        const job = commentJob();
        reviewOutcomes = ['fail', 'succeed'];

        await harness.runAttempt(job);
        assert.equal(job.state, 'delayed');
        let current = await task(job.id);
        assert.equal(current.state, TaskStates.PENDING, 'the backoff is shown as waiting for the retry, not as finished');
        assert.equal(current.history.at(-1)!.reason, 'Automatic retry 2 of 3 scheduled after attempt 1 failed');
        const failure = current.history.findLast(entry => entry.state === TaskStates.FAILED)!;
        assert.equal(failure.reason, 'PR comment processing failed');
        assert.deepEqual(retryRecord(failure), { jobId: job.id, attempt: 1, maxAttempts: 3, status: 'failed' });
        assert.equal(current.lastError?.message, 'Provider stream reset by peer', 'the attempt error is kept');

        await harness.runAttempt(job);
        assert.equal(job.state, 'completed');
        assert.deepEqual(reviewStarts.map(start => start.state), [TaskStates.PENDING, TaskStates.PROCESSING]);
        assert.equal(reviewStarts[1].reason, 'Automatic retry 2 of 3 started after attempt 1 failed',
            'the retry is active before its work starts');

        current = await task(job.id);
        assert.equal(current.state, TaskStates.COMPLETED);
        assert.equal(current.attempts, 1, 'one retry of the task was made');
        assert.deepEqual(current.history.map(entry => entry.state), [
            'pending', 'processing', 'failed', 'pending', 'processing', 'processing', 'completed',
        ]);
        const started = current.history[4];
        assert.deepEqual(retryRecord(started), { jobId: job.id, attempt: 2, maxAttempts: 3, failedAttempt: 1, status: 'started' });
        // Identity and attribution are those of the original request.
        assert.equal(current.taskId, job.id);
        assert.equal(current.correlationId, `correlation-${job.id}`);
        assert.equal(current.issueRef.pullRequestNumber, 42);
        assert.equal(current.issueRef.modelName, 'Claude Opus 5.5');
        const rows = await db('tasks').where({ task_id: job.id });
        assert.equal(rows.length, 1, 'no second task was created for the retry');
        assert.equal(rows[0].job_id, job.id);
        assert.deepEqual(await persistedStates(job.id), [
            'pending', 'processing', 'failed', 'pending', 'processing', 'processing', 'completed',
        ], 'the persisted task history keeps the failed attempt and ends completed');
    });

    test('repeated completion delivery leaves the completed retry unchanged', async () => {
        const job = commentJob();
        reviewOutcomes = ['fail', 'succeed'];
        await harness.runAttempt(job);
        const [, , result] = await harness.runAttempt(job);
        const before = await task(job.id);
        const rowsBefore = await persistedStates(job.id);

        await harness.deliver('completed', job, result);
        await harness.deliver('completed', job, result);

        assert.deepEqual(await task(job.id), before);
        assert.deepEqual(await persistedStates(job.id), rowsBefore);
    });

    test('a retry that starts before its backoff was recorded still resumes, and the late event is ignored', async () => {
        const job = commentJob();
        reviewOutcomes = ['fail', 'succeed'];
        const [, , firstError] = await harness.runAttempt(job, { deliverEvent: false });
        assert.equal((await task(job.id)).state, TaskStates.FAILED);

        await harness.runAttempt(job);
        assert.equal(reviewStarts[1].state, TaskStates.PROCESSING);
        assert.equal((await task(job.id)).state, TaskStates.COMPLETED);

        // The first attempt's failed event arrives after the retry has finished.
        await harness.deliver('failed', job, firstError);
        assert.equal((await task(job.id)).state, TaskStates.COMPLETED);
        assert.deepEqual(harness.exhausted, []);
    });

    test('an exhausted job stays failed with every attempt recorded', async () => {
        const job = commentJob();
        reviewOutcomes = ['fail', 'fail', 'fail'];

        await harness.runAttempt(job);
        assert.equal((await task(job.id)).state, TaskStates.PENDING);
        await harness.runAttempt(job);
        assert.equal((await task(job.id)).state, TaskStates.PENDING);
        assert.equal((await task(job.id)).history.at(-1)!.reason, 'Automatic retry 3 of 3 scheduled after attempt 2 failed');
        await harness.runAttempt(job);

        assert.equal(job.state, 'failed');
        const current = await task(job.id);
        assert.equal(current.state, TaskStates.FAILED);
        assert.deepEqual(current.history.filter(entry => entry.state === TaskStates.FAILED).map(entry => retryRecord(entry)?.attempt), [1, 2, 3]);
        assert.deepEqual(harness.exhausted, [job.id], 'the exhausted-failure hook still runs once');
        assert.equal((await persistedStates(job.id)).at(-1), 'failed');
    });

    test('a non-retryable failure is not scheduled for a retry', async () => {
        const job = commentJob();
        job.opts.attempts = 1;
        reviewOutcomes = ['fail'];

        await harness.runAttempt(job);

        assert.equal(job.state, 'failed');
        assert.equal((await task(job.id)).state, TaskStates.FAILED);
        assert.deepEqual(harness.exhausted, [job.id]);
    });

    test('normal first-attempt work is unchanged', async () => {
        const job = commentJob();
        reviewOutcomes = ['succeed'];

        await harness.runAttempt(job);

        const current = await task(job.id);
        assert.equal(current.state, TaskStates.COMPLETED);
        assert.equal(current.attempts, 0);
        assert.deepEqual(current.history.map(entry => entry.state), ['pending', 'processing', 'completed']);
        assert.ok(current.history.every(entry => !retryRecord(entry)));
    });

    test('an explicit new request after exhaustion is its own task and leaves the failed one alone', async () => {
        const failed = commentJob('pr-comments-batch-acme-web-42-review-1');
        failed.opts.attempts = 1;
        reviewOutcomes = ['fail', 'succeed'];
        await harness.runAttempt(failed);

        const followUp = commentJob('pr-comments-batch-acme-web-42-review-2');
        await harness.runAttempt(followUp);

        assert.equal((await task(failed.id)).state, TaskStates.FAILED);
        assert.equal((await task(followUp.id)).state, TaskStates.COMPLETED);
        assert.equal((await task(followUp.id)).attempts, 0);
    });
});

describe('a retry never resurrects stopped work', () => {
    test('a user cancellation during the backoff is kept when the retry runs', async () => {
        const job = commentJob();
        reviewOutcomes = ['fail', 'succeed'];
        await harness.runAttempt(job);
        assert.equal((await task(job.id)).state, TaskStates.PENDING);

        // Stopping a queued retry (taskCancellation.stopTaskExecution) records the withdrawal.
        await stateManager.markTaskCancelled(job.id, 'user', { withdrawnQueuedRetry: true });
        const [, , result] = await harness.runAttempt(job);

        assert.deepEqual(result, { status: 'cancelled', reason: 'task_already_cancelled' });
        assert.equal(reviewStarts.length, 1, 'no work ran for the cancelled retry');
        const current = await task(job.id);
        assert.equal(current.state, TaskStates.CANCELLED);
        assert.equal(current.terminalReason, 'cancelled_by_user');
    });

    test('a cancellation of the failed attempt before its backoff is recorded is kept too', async () => {
        const job = commentJob();
        reviewOutcomes = ['fail', 'succeed'];
        const [, , firstError] = await harness.runAttempt(job, { deliverEvent: false });
        await stateManager.markTaskCancelled(job.id, 'user', { withdrawnQueuedRetry: true });

        await harness.deliver('failed', job, firstError);
        assert.equal((await task(job.id)).state, TaskStates.CANCELLED, 'the late failed event does not schedule a retry');
        await harness.runAttempt(job);

        assert.equal(reviewStarts.length, 1);
        assert.equal((await task(job.id)).state, TaskStates.CANCELLED);
    });

    for (const backoffRecorded of [true, false]) {
        test(`a pull request closed during the backoff withdraws the retry (backoff ${backoffRecorded ? 'recorded' : 'not yet recorded'})`, async () => {
            const job = commentJob();
            reviewOutcomes = ['fail', 'succeed'];
            await harness.runAttempt(job, { deliverEvent: backoffRecorded });
            pullRequestClosed = true;

            const [, , result] = await harness.runAttempt(job);

            assert.deepEqual(result, { status: 'cancelled', reason: 'cancelled_pr_closed' });
            assert.equal(reviewStarts.length, 1);
            const current = await task(job.id);
            assert.equal(current.state, TaskStates.CANCELLED);
            assert.equal(current.terminalReason, 'cancelled_pr_closed');
            assert.ok(current.history.some(entry => entry.state === TaskStates.FAILED), 'the failed attempt stays in history');
        });
    }
});

describe('a retry continuation is verified from BullMQ and the task', () => {
    async function failedTask(taskId: string, metadata: Record<string, unknown> = {}) {
        await stateManager.createTaskStateIfAbsent(taskId, { number: 42, pullRequestNumber: 42, repoOwner: 'acme', repoName: 'web', type: 'pr-comment' }, null, taskId);
        await stateManager.updateTaskState(taskId, TaskStates.PROCESSING);
        await stateManager.updateTaskState(taskId, TaskStates.FAILED, { reason: 'PR comment processing failed', historyMetadata: metadata });
    }
    const resume = (job: QueueJob) => resumeAutomaticPRCommentRetry({ job: job as never, taskId: job.id, stateManager, correlatedLogger: log as never });

    test('a failure that was not recorded by an attempt of this job is not resumed, whatever the job data says', async () => {
        const job = commentJob();
        job.attemptsMade = 1;
        job.data.isRetry = true;
        job.data.automaticRetry = { jobId: job.id, attempt: 1 };
        await failedTask(job.id);

        assert.equal(await resume(job), 'unverified');
        assert.equal((await task(job.id)).state, TaskStates.FAILED);
    });

    test('a failure recorded for another job is not resumed', async () => {
        const job = commentJob();
        job.attemptsMade = 1;
        await failedTask(job.id, { automaticRetry: { jobId: 'another-job', attempt: 1, maxAttempts: 3, status: 'failed' } });

        assert.equal(await resume(job), 'unverified');
        assert.equal(await scheduleAutomaticPRCommentRetry(job as never, 'delayed', stateManager), 'unverified');
        assert.equal((await task(job.id)).state, TaskStates.FAILED);
    });

    test('a failure BullMQ has not counted as an attempt is not resumed', async () => {
        const job = commentJob();
        await failedTask(job.id, { automaticRetry: { jobId: job.id, attempt: 1, maxAttempts: 3, status: 'failed' } });

        // The processor's own delay (lock or capacity wait) does not count an attempt.
        assert.equal(await resume(job), 'not_retry');
        job.attemptsMade = 1;
        await stateManager.updateHistoryMetadata(job.id, TaskStates.FAILED, { automaticRetry: { jobId: job.id, attempt: 2, maxAttempts: 3, status: 'failed' } });
        assert.equal(await resume(job), 'unverified');
        assert.equal((await task(job.id)).state, TaskStates.FAILED);
    });

    test('a job without remaining attempts is not resumed', async () => {
        const job = commentJob();
        job.attemptsMade = 3;
        await failedTask(job.id, { automaticRetry: { jobId: job.id, attempt: 3, maxAttempts: 3, status: 'failed' } });

        assert.equal(await resume(job), 'unverified');
        assert.equal(await scheduleAutomaticPRCommentRetry(job as never, 'failed', stateManager), 'not_retry');
        assert.equal((await task(job.id)).state, TaskStates.FAILED);
    });

    test('completed and cancelled tasks are never reopened', async () => {
        const job = commentJob();
        job.attemptsMade = 1;
        await stateManager.createTaskStateIfAbsent(job.id, { number: 42, repoOwner: 'acme', repoName: 'web', type: 'pr-comment' }, null, job.id);
        await stateManager.updateTaskState(job.id, TaskStates.COMPLETED);
        assert.equal(await resume(job), 'not_failed');
        assert.equal(await scheduleAutomaticPRCommentRetry(job as never, 'delayed', stateManager), 'not_failed');
        assert.equal((await task(job.id)).state, TaskStates.COMPLETED);

        await stateManager.markTaskCancelled(job.id, 'user');
        assert.equal(await resume(job), 'not_failed');
        assert.equal((await task(job.id)).state, TaskStates.COMPLETED, 'the generic terminal guard is unchanged');
    });

    test('the generic terminal guard still refuses ordinary writes to a failed task', async () => {
        const job = commentJob();
        await failedTask(job.id, { automaticRetry: { jobId: job.id, attempt: 1, maxAttempts: 3, status: 'failed' } });

        const unchanged = await stateManager.updateTaskState(job.id, TaskStates.COMPLETED, { reason: 'No changes were needed' });

        assert.equal(unchanged.state, TaskStates.FAILED);
    });
});
