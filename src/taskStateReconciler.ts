import type { TaskStateData } from '@propr/core';
import {
    findRunningDockerContainerForTask,
    hashTaskAttemptToken,
    inspectLegacyDockerContainerLivenessForTask,
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
import {
    createTaskReconciliationSummary,
    DEFAULT_TASK_FUTURE_SKEW_ALLOWANCE_MS,
    DEFAULT_TASK_RECONCILIATION_BATCH_SIZE,
    DEFAULT_TASK_RECONCILIATION_CONCURRENCY,
    DEFAULT_TASK_RECONCILIATION_STALE_MS,
    DEFAULT_TASK_RECONCILIATION_TIME_BUDGET_MS,
    taskMatchesExpectation,
    throwIfAborted,
} from './taskStateReconciler.types.js';
import { completedResultMatchesAttempt, loadMatchingPRCommentRemoteOutcome, taskAgeMs } from './taskStateReconciliationChecks.js';
import type {
    ReconciliationContext,
    ReconciliationJob,
    ReconciliationQueue,
    ReconciliationRedis,
    TaskReconciliationOptions,
    TaskReconciliationSummary,
} from './taskStateReconciler.types.js';

export {
    DEFAULT_TASK_FUTURE_SKEW_ALLOWANCE_MS,
    DEFAULT_TASK_RECONCILIATION_BATCH_SIZE,
    DEFAULT_TASK_RECONCILIATION_CONCURRENCY,
    DEFAULT_TASK_RECONCILIATION_STALE_MS,
    DEFAULT_TASK_RECONCILIATION_TIME_BUDGET_MS,
} from './taskStateReconciler.types.js';
export type {
    ReconciliationQueue,
    ReconciliationRedis,
    ReconciliationStateManager,
    TaskReconciliationOptions,
    TaskReconciliationSummary,
} from './taskStateReconciler.types.js';

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

async function findGenerationSpecificContainer(
    task: TaskStateData,
    context: ReconciliationContext,
): Promise<Awaited<ReturnType<typeof findRunningDockerContainerForTask>>> {
    if (!task.prProcessingLockToken) return context.findRunningContainer(task.taskId);
    return context.findRunningContainer(
        task.taskId,
        hashTaskAttemptToken(task.prProcessingLockToken),
    );
}

async function deferForPossibleLegacyContainer(task: TaskStateData, context: ReconciliationContext): Promise<boolean> {
    if (task.prProcessingLockToken) return false;
    throwIfAborted(context.options.signal);
    const labeledContainer = await findGenerationSpecificContainer(task, context);
    throwIfAborted(context.options.signal);
    const liveness = labeledContainer ? 'running' : await context.inspectLegacyContainerLiveness(task.taskId);
    throwIfAborted(context.options.signal);
    if (liveness === 'not_found') return false;
    context.summary.live++;
    return true;
}

async function stopAbandonedTaskContainer(
    task: TaskStateData,
    context: ReconciliationContext,
): Promise<void> {
    const { options, summary, stopContainer } = context;
    const stoppedContainerIds = new Set<string>();
    while (true) {
        throwIfAborted(options.signal);
        const container = await findGenerationSpecificContainer(task, context);
        if (!container) return;
        if (stoppedContainerIds.has(container.id)) {
            throw new Error(`Abandoned agent container ${container.id} remained live after a successful stop`);
        }
        throwIfAborted(options.signal);
        // The generation label prevents a successor's container from matching,
        // while this read closes the replacement window before every stop.
        const current = await options.stateManager.getTaskState(task.taskId);
        if (!taskMatchesExpectation(current, task)) return;
        throwIfAborted(options.signal);
        const result = await stopContainer(container.id, 10);
        if (!result.success) {
            throw new Error(`Could not stop abandoned agent container ${container.id}: ${result.error ?? 'unknown error'}`);
        }
        stoppedContainerIds.add(container.id);
        summary.containersStopped++;
    }
}

async function finalizeCompletedJob(
    task: TaskStateData,
    job: ReconciliationJob,
    options: TaskReconciliationOptions,
    summary: TaskReconciliationSummary,
): Promise<void> {
    throwIfAborted(options.signal);
    const finalized = await finalizePRCommentTaskResult(task.taskId, options.stateManager, job.returnvalue, {
        expectation: taskStateExpectation(task),
    });
    if (!finalized) return;
    summary.finalized++;
    throwIfAborted(options.signal);
    const lockCleared = await clearOwnedPRLock(task, options.redis, options.signal);
    if (lockCleared) summary.locksCleared++;
}

async function finalizeFailedJob(
    task: TaskStateData,
    message: string,
    options: TaskReconciliationOptions,
    summary: TaskReconciliationSummary,
): Promise<void> {
    throwIfAborted(options.signal);
    const finalized = await finalizePRCommentTaskFailure(task.taskId, options.stateManager, new Error(message), {
        expectation: taskStateExpectation(task),
    });
    if (!finalized) return;
    summary.interrupted++;
    throwIfAborted(options.signal);
    const lockCleared = await clearOwnedPRLock(task, options.redis, options.signal);
    if (lockCleared) summary.locksCleared++;
}

async function handleTerminalQueueState(
    task: TaskStateData,
    job: ReconciliationJob | undefined,
    queueState: string,
    context: ReconciliationContext,
): Promise<boolean> {
    const { options, summary } = context;
    if (await deferForPossibleLegacyContainer(task, context)) return true;
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
    if (await deferForPossibleLegacyContainer(task, context)) return true;
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

    const checkpoint = await loadMatchingPRCommentRemoteOutcome(options.redis, task);
    if (checkpoint) {
        // A live retry will discover this same checkpoint and finish itself.
        if (queueState === 'active' && await hasLiveAttempt(task, options.queue, options.redis)) {
            summary.live++;
            return;
        }
        await stopAbandonedTaskContainer(task, context);
        await finalizeCompletedJob(
            task,
            { getState: async () => 'completed', returnvalue: checkpoint },
            options,
            summary,
        );
        return;
    }
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

    if (await deferForPossibleLegacyContainer(task, context)) return;
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
    const inspectLegacyContainerLiveness = options.inspectLegacyContainerLiveness
        ?? inspectLegacyDockerContainerLivenessForTask;
    const stopContainer = options.stopContainer ?? stopDockerContainer;
    const summary = createTaskReconciliationSummary();
    const context = { options, summary, findRunningContainer, inspectLegacyContainerLiveness, stopContainer };
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
        const scanPage = await options.stateManager.getNonTerminalTaskPage({
            taskTypes: ['pr_comment'],
            limit: batchSize,
        });
        const scannedTasks = scanPage.tasks.filter(isPRCommentTaskState);
        throwIfAborted(options.signal);
        const tasks = scannedTasks.filter(task => {
            if (seenTaskIds.has(task.taskId)) return false;
            seenTaskIds.add(task.taskId);
            return true;
        });
        if (tasks.length === 0) {
            if (scanPage.scanComplete) break;
            continue;
        }
        summary.scanned += tasks.length;

        for (let index = 0; index < tasks.length; index += concurrency) {
            throwIfAborted(options.signal);
            await Promise.all(tasks.slice(index, index + concurrency).map(reconcileOne));
        }
        if (scanPage.scanComplete) break;
    }

    return summary;
}
