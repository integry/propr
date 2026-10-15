import type { Job } from 'bullmq';
import type { Logger } from 'pino';
import {
    TaskStates,
    type HistoryEntry,
    type TaskStateData,
    type TaskStateExpectation,
    type WorkerStateManager,
} from '@propr/core';

/**
 * A PR comment task keeps its BullMQ job ID, so an automatic retry of the job
 * resumes the same task. The failed attempt is recorded as FAILED like any
 * other failure; this module is the only way such a task becomes active again,
 * and only for the queue's own retry of that same job:
 *
 * - the failure entry names the job and the 1-based attempt that wrote it;
 * - BullMQ's attempt counter (`attemptsMade`, incremented only when the queue
 *   counts a failed attempt) must already include that attempt;
 * - the queue must still allow another attempt.
 *
 * Nothing in the job data is trusted for this. Cancelled tasks, other terminal
 * outcomes and failures written by anything else stay as they are.
 */
export const AUTOMATIC_RETRY_METADATA_KEY = 'automaticRetry';

export interface AutomaticRetryRecord {
    jobId: string;
    /** The 1-based BullMQ attempt this history entry describes. */
    attempt: number;
    maxAttempts: number;
    /** On a scheduled or started retry: the failed attempt it continues. */
    failedAttempt?: number;
    status?: 'failed' | 'scheduled' | 'started';
}

type AttemptJob = Pick<Job, 'id' | 'attemptsMade' | 'opts'>;
type RetryStateStore = Pick<WorkerStateManager, 'getTaskState' | 'updateTaskStateIfCurrent'>;

export type AutomaticRetryTransitionOutcome =
    | 'not_retry'
    | 'not_failed'
    | 'unverified'
    | 'state_changed'
    | 'scheduled'
    | 'resumed';

const MAX_TRANSITION_ATTEMPTS = 5;
const QUEUED_JOB_STATES = new Set(['delayed', 'waiting', 'prioritized', 'paused']);

function maxAttemptsOf(job: AttemptJob): number {
    const attempts = Number(job.opts?.attempts);
    return Number.isInteger(attempts) && attempts > 0 ? attempts : 1;
}

function failedAttemptsOf(job: AttemptJob): number {
    const attemptsMade = Number(job.attemptsMade);
    return Number.isInteger(attemptsMade) && attemptsMade > 0 ? attemptsMade : 0;
}

function readRecord(entry: HistoryEntry | undefined): AutomaticRetryRecord | null {
    const record = entry?.metadata?.[AUTOMATIC_RETRY_METADATA_KEY] as Partial<AutomaticRetryRecord> | undefined;
    if (!record || typeof record.jobId !== 'string' || !Number.isInteger(record.attempt)) return null;
    return record as AutomaticRetryRecord;
}

function expectationOf(task: TaskStateData): TaskStateExpectation {
    return {
        state: task.state, createdAt: task.createdAt, updatedAt: task.updatedAt,
        correlationId: task.correlationId, version: task.version,
    };
}

/**
 * History metadata for the FAILED entry of a PR comment attempt. Written by the
 * attempt itself, before BullMQ decides whether to retry it.
 */
export function automaticRetryFailureMetadata(job: AttemptJob, taskId: string): Record<string, unknown> {
    if (job.id === undefined || job.id === null || String(job.id) !== taskId) return {};
    const record: AutomaticRetryRecord = {
        jobId: String(job.id),
        attempt: failedAttemptsOf(job) + 1,
        maxAttempts: maxAttemptsOf(job),
        status: 'failed',
    };
    return { [AUTOMATIC_RETRY_METADATA_KEY]: record };
}

/**
 * The failed attempt this task's automatic retry continues, or null when the
 * task is not a failed attempt of this job that BullMQ has counted and retries.
 * A scheduled-retry entry recorded after the failure is part of the same retry.
 */
function verifiedFailedAttempt(task: TaskStateData, job: AttemptJob, taskId: string): AutomaticRetryRecord | null {
    const jobId = job.id === undefined || job.id === null ? null : String(job.id);
    const failedAttempts = failedAttemptsOf(job);
    if (!jobId || jobId !== taskId || task.taskId !== taskId) return null;
    if (failedAttempts < 1 || failedAttempts >= maxAttemptsOf(job)) return null;
    if (task.state !== TaskStates.FAILED && task.state !== TaskStates.PENDING) return null;

    const history = task.history ?? [];
    const failedIndex = history.findLastIndex(entry => entry.state === TaskStates.FAILED);
    if (failedIndex < 0) return null;
    const failure = readRecord(history[failedIndex]);
    if (!failure || failure.jobId !== jobId || failure.attempt < 1 || failure.attempt > failedAttempts) return null;

    // Only this retry's own scheduling entries may follow the failure.
    const later = history.slice(failedIndex + 1);
    const onlyScheduled = later.every(entry => {
        const scheduled = readRecord(entry);
        return entry.state === TaskStates.PENDING
            && scheduled?.status === 'scheduled'
            && scheduled.jobId === jobId
            && scheduled.failedAttempt === failure.attempt;
    });
    if (!onlyScheduled) return null;
    if (task.state === TaskStates.PENDING && later.length === 0) return null;
    return failure;
}

async function transitionVerifiedRetry(
    job: AttemptJob,
    taskId: string,
    stateManager: RetryStateStore,
    target: 'scheduled' | 'started',
): Promise<AutomaticRetryTransitionOutcome> {
    for (let attempt = 0; attempt < MAX_TRANSITION_ATTEMPTS; attempt++) {
        const current = await stateManager.getTaskState(taskId);
        if (!current) return 'not_failed';
        if (target === 'scheduled' && current.state !== TaskStates.FAILED) return 'not_failed';
        if (target === 'started' && current.state !== TaskStates.FAILED && current.state !== TaskStates.PENDING) return 'not_failed';
        const failure = verifiedFailedAttempt(current, job, taskId);
        if (!failure) {
            // A plain pending task (first attempt, capacity wait) is not a retry to resume.
            return current.state === TaskStates.FAILED ? 'unverified' : 'not_failed';
        }

        const maxAttempts = maxAttemptsOf(job);
        const nextAttempt = failedAttemptsOf(job) + 1;
        const record: AutomaticRetryRecord = {
            jobId: String(job.id), attempt: nextAttempt, maxAttempts, failedAttempt: failure.attempt, status: target,
        };
        const updated = await stateManager.updateTaskStateIfCurrent(
            taskId,
            expectationOf(current),
            target === 'scheduled' ? TaskStates.PENDING : TaskStates.PROCESSING,
            {
                reason: target === 'scheduled'
                    ? `Automatic retry ${nextAttempt} of ${maxAttempts} scheduled after attempt ${failure.attempt} failed`
                    : `Automatic retry ${nextAttempt} of ${maxAttempts} started after attempt ${failure.attempt} failed`,
                ...(target === 'started' ? { isRetry: true } : {}),
                historyMetadata: { [AUTOMATIC_RETRY_METADATA_KEY]: record },
            },
        );
        if (updated) return target === 'scheduled' ? 'scheduled' : 'resumed';
        // Another writer (a cancellation, a concurrent retry) changed the task: re-verify.
    }
    return 'state_changed';
}

/**
 * Runs after BullMQ counted a failed attempt it will retry. Shows the task as
 * waiting for its automatic retry instead of finished; the failure stays in history.
 * `jobState` is the queue state read after the failure.
 */
export async function scheduleAutomaticPRCommentRetry(
    job: AttemptJob,
    jobState: string,
    stateManager: RetryStateStore,
): Promise<AutomaticRetryTransitionOutcome> {
    if (!QUEUED_JOB_STATES.has(jobState) || job.id === undefined || job.id === null) return 'not_retry';
    return transitionVerifiedRetry(job, String(job.id), stateManager, 'scheduled');
}

/**
 * Called by an attempt once its cancellation and withdrawn-intent checks have
 * passed. Moves the failed (or retry-scheduled) task back to PROCESSING when
 * this attempt is the queue's automatic retry of the recorded failure.
 */
export async function resumeAutomaticPRCommentRetry(params: {
    job: AttemptJob;
    taskId: string;
    stateManager: RetryStateStore;
    correlatedLogger: Pick<Logger, 'info' | 'warn'>;
}): Promise<AutomaticRetryTransitionOutcome> {
    const { job, taskId, stateManager, correlatedLogger } = params;
    if (failedAttemptsOf(job) < 1) return 'not_retry';
    const outcome = await transitionVerifiedRetry(job, taskId, stateManager, 'started');
    if (outcome === 'resumed') {
        correlatedLogger.info({ taskId, attempt: failedAttemptsOf(job) + 1, maxAttempts: maxAttemptsOf(job) },
            'Resumed PR comment task for its automatic retry');
    } else if (outcome === 'unverified' || outcome === 'state_changed') {
        correlatedLogger.warn({ taskId, attemptsMade: failedAttemptsOf(job), outcome },
            'PR comment retry could not be verified as a continuation of its failed attempt; task state left unchanged');
    }
    return outcome;
}
