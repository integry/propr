import type { TaskStateData, WorkerStateManager } from '@propr/core';
import {
    findRunningDockerContainerForTask,
    hashTaskAttemptToken,
    isPRCommentTaskState,
    logger,
    stopDockerContainer,
    TaskStates,
} from '@propr/core';
import {
    finalizePRCommentTaskFailure,
    finalizePRCommentTaskResult,
    parsePRCommentJobResult,
    taskStateExpectation,
} from './jobs/prCommentTaskFinalizer.js';

interface ReconciliationJob {
    getState(): Promise<string>;
    returnvalue?: unknown;
    failedReason?: string;
}

export interface ReconciliationQueue {
    getJob(jobId: string): Promise<ReconciliationJob | undefined>;
    toKey(type: string): string;
}

export interface ReconciliationRedis {
    eval(script: string, numberOfKeys: number, ...args: Array<string | number>): Promise<unknown>;
    pttl(key: string): Promise<number>;
}

export type ReconciliationStateManager = Pick<
    WorkerStateManager,
    'getNonTerminalTasks' | 'getTaskState' | 'updateTaskStateIfCurrent'
>;

export interface TaskReconciliationSummary {
    scanned: number;
    fresh: number;
    live: number;
    queued: number;
    finalized: number;
    interrupted: number;
    containersStopped: number;
    locksCleared: number;
    errors: number;
}

export interface TaskReconciliationOptions {
    stateManager: ReconciliationStateManager;
    queue: ReconciliationQueue;
    redis: ReconciliationRedis;
    staleAfterMs?: number;
    now?: () => number;
    findRunningContainer?: typeof findRunningDockerContainerForTask;
    stopContainer?: typeof stopDockerContainer;
    signal?: AbortSignal;
    batchSize?: number;
    concurrency?: number;
    /** Maximum wall-clock time in which new reconciliation batches may start. */
    timeBudgetMs?: number;
    futureSkewAllowanceMs?: number;
}

export const DEFAULT_TASK_RECONCILIATION_STALE_MS = 90 * 1000;
export const DEFAULT_TASK_RECONCILIATION_BATCH_SIZE = 100;
export const DEFAULT_TASK_RECONCILIATION_CONCURRENCY = 4;
export const DEFAULT_TASK_RECONCILIATION_TIME_BUDGET_MS = 30 * 1000;
export const DEFAULT_TASK_FUTURE_SKEW_ALLOWANCE_MS = 5 * 60 * 1000;

interface ReconciliationContext {
    options: TaskReconciliationOptions;
    summary: TaskReconciliationSummary;
    findRunningContainer: typeof findRunningDockerContainerForTask;
    stopContainer: typeof stopDockerContainer;
}

const RELEASE_OWNED_PR_LOCK_SCRIPT = `
local current = redis.call('get', KEYS[1])
if current == ARGV[1] then
    return redis.call('del', KEYS[1])
end
return 0
`;

const ASSERT_OWNED_PR_LOCK_SCRIPT = `
return redis.call('get', KEYS[1]) == ARGV[1] and 1 or 0
`;

function taskAgeMs(task: TaskStateData, now: number, futureSkewAllowanceMs: number): number {
    const updatedAt = new Date(task.updatedAt).getTime();
    if (!Number.isFinite(updatedAt) || updatedAt > now + futureSkewAllowanceMs) {
        return Number.POSITIVE_INFINITY;
    }
    return Math.max(0, now - updatedAt);
}

function throwIfAborted(signal?: AbortSignal): void {
    signal?.throwIfAborted();
}

function completedResultMatchesAttempt(task: TaskStateData, result: unknown): boolean {
    if (task.prProcessingLockToken === undefined) return true;
    if (!result || typeof result !== 'object') return false;
    const record = result as {
        prProcessingAttemptGeneration?: unknown;
        prProcessingLockToken?: unknown;
    };
    if (typeof record.prProcessingAttemptGeneration === 'string') {
        return record.prProcessingAttemptGeneration === hashTaskAttemptToken(task.prProcessingLockToken);
    }
    // Accept results produced during a rolling upgrade, but never emit the raw
    // token in new BullMQ return values.
    return record.prProcessingLockToken === task.prProcessingLockToken;
}

async function clearOwnedPRLock(
    task: TaskStateData,
    redis: ReconciliationRedis,
    signal?: AbortSignal,
): Promise<boolean> {
    if (!isPRCommentTaskState(task)) return false;
    const { repoOwner, repoName, number } = task.issueRef;
    if (!repoOwner || !repoName || !Number.isFinite(number) || !task.prProcessingLockToken) return false;

    const lockKey = `lock:pr:${repoOwner}:${repoName}:${number}`;
    let lastError: unknown;
    for (let attempt = 0; attempt < 3; attempt++) {
        throwIfAborted(signal);
        try {
            const released = await redis.eval(
                RELEASE_OWNED_PR_LOCK_SCRIPT,
                1,
                lockKey,
                task.prProcessingLockToken,
            );
            return Number(released) === 1;
        } catch (error) {
            lastError = error;
            if (attempt < 2) {
                await new Promise(resolve => setTimeout(resolve, 10 * (attempt + 1)));
            }
        }
    }
    throw lastError;
}

async function hasLiveBullLock(
    taskId: string,
    queue: ReconciliationQueue,
    redis: ReconciliationRedis,
): Promise<boolean> {
    return (await redis.pttl(queue.toKey(`${taskId}:lock`))) > 0;
}

async function hasLiveAttempt(
    task: TaskStateData,
    queue: ReconciliationQueue,
    redis: ReconciliationRedis,
): Promise<boolean> {
    if (!await hasLiveBullLock(task.taskId, queue, redis)) return false;
    if (!task.prProcessingLockToken) return true;
    const { repoOwner, repoName, number } = task.issueRef;
    if (!repoOwner || !repoName || !Number.isFinite(number)) return false;
    const lockKey = `lock:pr:${repoOwner}:${repoName}:${number}`;
    const currentAttempt = await redis.eval(
        ASSERT_OWNED_PR_LOCK_SCRIPT,
        1,
        lockKey,
        task.prProcessingLockToken,
    );
    return Number(currentAttempt) === 1;
}

async function hasMatchingPRLease(
    task: TaskStateData,
    redis: ReconciliationRedis,
): Promise<boolean> {
    if (!task.prProcessingLockToken) return false;
    const { repoOwner, repoName, number } = task.issueRef;
    if (!repoOwner || !repoName || !Number.isFinite(number)) return false;
    const currentAttempt = await redis.eval(
        ASSERT_OWNED_PR_LOCK_SCRIPT,
        1,
        `lock:pr:${repoOwner}:${repoName}:${number}`,
        task.prProcessingLockToken,
    );
    return Number(currentAttempt) === 1;
}

function taskMatchesExpectation(current: TaskStateData | null, scanned: TaskStateData): boolean {
    if (!current) return false;
    const expectation = taskStateExpectation(scanned);
    return current.state === expectation.state
        && current.updatedAt === expectation.updatedAt
        && current.version === expectation.version
        && current.prProcessingLockToken === expectation.prProcessingLockToken;
}

async function findGenerationSpecificContainer(
    task: TaskStateData,
    context: ReconciliationContext,
): Promise<Awaited<ReturnType<typeof findRunningDockerContainerForTask>>> {
    if (!task.prProcessingLockToken) return null;
    return context.findRunningContainer(
        task.taskId,
        hashTaskAttemptToken(task.prProcessingLockToken),
    );
}

async function stopAbandonedTaskContainer(
    task: TaskStateData,
    context: ReconciliationContext,
): Promise<void> {
    const { options, summary, stopContainer } = context;
    throwIfAborted(options.signal);
    const container = await findGenerationSpecificContainer(task, context);
    if (!container) return;
    throwIfAborted(options.signal);
    // The label prevents a successor's container from matching, while this
    // final read closes the window in which the scanned Redis state itself was
    // replaced before the destructive operation.
    const current = await options.stateManager.getTaskState(task.taskId);
    if (!taskMatchesExpectation(current, task)) return;
    throwIfAborted(options.signal);
    const result = await stopContainer(container.id, 10);
    if (!result.success) {
        throw new Error(`Could not stop abandoned agent container ${container.id}: ${result.error ?? 'unknown error'}`);
    }
    summary.containersStopped++;
}

async function finalizeCompletedJob(
    task: TaskStateData,
    job: ReconciliationJob,
    options: TaskReconciliationOptions,
    summary: TaskReconciliationSummary,
): Promise<void> {
    throwIfAborted(options.signal);
    const lockCleared = await clearOwnedPRLock(task, options.redis, options.signal);
    throwIfAborted(options.signal);
    const finalized = await finalizePRCommentTaskResult(task.taskId, options.stateManager, job.returnvalue, {
        expectation: taskStateExpectation(task),
    });
    if (!finalized) return;
    summary.finalized++;
    if (lockCleared) summary.locksCleared++;
}

async function finalizeFailedJob(
    task: TaskStateData,
    message: string,
    options: TaskReconciliationOptions,
    summary: TaskReconciliationSummary,
): Promise<void> {
    throwIfAborted(options.signal);
    const lockCleared = await clearOwnedPRLock(task, options.redis, options.signal);
    throwIfAborted(options.signal);
    const finalized = await finalizePRCommentTaskFailure(task.taskId, options.stateManager, new Error(message), {
        expectation: taskStateExpectation(task),
    });
    if (!finalized) return;
    summary.interrupted++;
    if (lockCleared) summary.locksCleared++;
}

async function handleTerminalQueueState(
    task: TaskStateData,
    job: ReconciliationJob | undefined,
    queueState: string,
    context: ReconciliationContext,
): Promise<boolean> {
    const { options, summary } = context;
    if (queueState === 'completed' && job) {
        if (!completedResultMatchesAttempt(task, job.returnvalue)) {
            // A legacy/tokenless or stale completion may describe a previous
            // BullMQ execution. Keep the scanned attempt only while there is
            // affirmative generation-specific liveness; otherwise make the
            // stranded state terminal so reconciliation cannot no-op forever.
            if (await hasLiveBullLock(task.taskId, options.queue, options.redis)) return true;
            if (await hasMatchingPRLease(task, options.redis)) return true;
            if (await findGenerationSpecificContainer(task, context)) return true;
            await finalizeFailedJob(
                task,
                'Completed BullMQ result belongs to a different or unknown task attempt',
                options,
                summary,
            );
            return true;
        }
        const parsed = parsePRCommentJobResult(job.returnvalue);
        if (!parsed) {
            const returnedStatus = job.returnvalue
                && typeof job.returnvalue === 'object'
                && typeof (job.returnvalue as { status?: unknown }).status === 'string'
                ? (job.returnvalue as { status: string }).status
                : 'missing';
            await stopAbandonedTaskContainer(task, context);
            await finalizeFailedJob(
                task,
                `Completed BullMQ job returned an invalid result status: ${returnedStatus}`,
                options,
                summary,
            );
            return true;
        }
        await stopAbandonedTaskContainer(task, context);
        await finalizeCompletedJob(task, job, options, summary);
        return true;
    }
    if (queueState === 'failed' && job) {
        await stopAbandonedTaskContainer(task, context);
        await finalizeFailedJob(
            task,
            job.failedReason || 'BullMQ job failed without updating task state',
            options,
            summary,
        );
        return true;
    }
    return false;
}

async function handleQueuedState(
    task: TaskStateData,
    queueState: string,
    context: ReconciliationContext,
): Promise<boolean> {
    const { options, summary } = context;
    if (!['waiting', 'delayed', 'prioritized', 'waiting-children'].includes(queueState)) return false;
    await stopAbandonedTaskContainer(task, context);
    if (task.state !== TaskStates.PENDING) {
        throwIfAborted(options.signal);
        const updated = await options.stateManager.updateTaskStateIfCurrent(
            task.taskId,
            taskStateExpectation(task),
            TaskStates.PENDING,
            {
                reason: `Task recovered in BullMQ ${queueState} state`,
                historyMetadata: { recovered: true, queueState },
            },
        );
        if (updated) summary.queued++;
    } else {
        summary.queued++;
    }
    return true;
}

async function reconcileStaleTask(
    task: TaskStateData,
    context: ReconciliationContext,
): Promise<void> {
    const { options, summary } = context;
    throwIfAborted(options.signal);
    let job = await options.queue.getJob(task.taskId);
    throwIfAborted(options.signal);
    let queueState = job ? await job.getState() : 'missing';
    throwIfAborted(options.signal);
    if (await handleTerminalQueueState(task, job, queueState, context)) return;
    if (await handleQueuedState(task, queueState, context)) return;

    if (queueState === 'active') {
        if (await hasLiveAttempt(task, options.queue, options.redis)) {
            throwIfAborted(options.signal);
            summary.live++;
            return;
        }

        // Completing a BullMQ job removes its lock. Reload the job so both its
        // state and terminal result come from after that transition.
        throwIfAborted(options.signal);
        job = await options.queue.getJob(task.taskId);
        throwIfAborted(options.signal);
        queueState = job ? await job.getState() : 'missing';
        throwIfAborted(options.signal);
        if (await handleTerminalQueueState(task, job, queueState, context)) return;
        if (await handleQueuedState(task, queueState, context)) return;
    }

    await stopAbandonedTaskContainer(task, context);
    await finalizeFailedJob(
        task,
        queueState === 'active'
            ? 'Worker disappeared while the task was active'
            : 'Task has no live BullMQ job or agent container',
        options,
        summary,
    );
}

/**
 * Reconciles persistent task state with BullMQ and Docker after crashes or
 * deploys. Every mutation is guarded by queue/runtime liveness checks and task
 * age, so a currently executing job is left alone.
 */
export async function reconcileStaleTaskStates(
    options: TaskReconciliationOptions,
): Promise<TaskReconciliationSummary> {
    const staleAfterMs = options.staleAfterMs ?? DEFAULT_TASK_RECONCILIATION_STALE_MS;
    const batchSize = Math.max(1, options.batchSize ?? DEFAULT_TASK_RECONCILIATION_BATCH_SIZE);
    const concurrency = Math.max(1, options.concurrency ?? DEFAULT_TASK_RECONCILIATION_CONCURRENCY);
    const timeBudgetMs = Math.max(1, options.timeBudgetMs ?? DEFAULT_TASK_RECONCILIATION_TIME_BUDGET_MS);
    const futureSkewAllowanceMs = Math.max(
        0,
        options.futureSkewAllowanceMs ?? DEFAULT_TASK_FUTURE_SKEW_ALLOWANCE_MS,
    );
    const now = (options.now ?? Date.now)();
    const deadline = Date.now() + timeBudgetMs;
    const findRunningContainer = options.findRunningContainer ?? findRunningDockerContainerForTask;
    const stopContainer = options.stopContainer ?? stopDockerContainer;
    const summary: TaskReconciliationSummary = {
        scanned: 0,
        fresh: 0,
        live: 0,
        queued: 0,
        finalized: 0,
        interrupted: 0,
        containersStopped: 0,
        locksCleared: 0,
        errors: 0,
    };
    const context = { options, summary, findRunningContainer, stopContainer };
    const seenTaskIds = new Set<string>();

    const reconcileOne = async (task: TaskStateData): Promise<void> => {
        try {
            throwIfAborted(options.signal);
            if (taskAgeMs(task, now, futureSkewAllowanceMs) < staleAfterMs) {
                summary.fresh++;
                return;
            }
            await reconcileStaleTask(task, context);
        } catch (error) {
            throwIfAborted(options.signal);
            summary.errors++;
            logger.warn({ taskId: task.taskId, error: (error as Error).message }, 'Failed to reconcile stale task state');
        }
    };
    while (Date.now() < deadline) {
        throwIfAborted(options.signal);
        const scannedTasks = (await options.stateManager.getNonTerminalTasks({
            taskTypes: ['pr_comment'],
            limit: batchSize,
        })).filter(isPRCommentTaskState);
        throwIfAborted(options.signal);
        const tasks = scannedTasks.filter(task => {
            if (seenTaskIds.has(task.taskId)) return false;
            seenTaskIds.add(task.taskId);
            return true;
        });
        if (tasks.length === 0) break;
        summary.scanned += tasks.length;

        for (let index = 0; index < tasks.length; index += concurrency) {
            throwIfAborted(options.signal);
            await Promise.all(tasks.slice(index, index + concurrency).map(reconcileOne));
        }
        if (scannedTasks.length < batchSize) break;
    }

    return summary;
}
