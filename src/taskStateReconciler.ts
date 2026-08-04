import type { JobResult, TaskStateData, WorkerStateManager } from '@propr/core';
import { findRunningDockerContainerForTask, logger, TaskStates } from '@propr/core';
import {
    finalizePRCommentTaskFailure,
    finalizePRCommentTaskResult,
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
}

export const DEFAULT_TASK_RECONCILIATION_STALE_MS = 90 * 1000;

interface ReconciliationContext {
    options: TaskReconciliationOptions;
    summary: TaskReconciliationSummary;
    findRunningContainer: typeof findRunningDockerContainerForTask;
}

const RELEASE_OWNED_PR_LOCK_SCRIPT = `
local current = redis.call('get', KEYS[1])
if current == ARGV[1] then
    return redis.call('del', KEYS[1])
end
return 0
`;

function asJobResult(value: unknown): JobResult {
    if (value && typeof value === 'object' && typeof (value as { status?: unknown }).status === 'string') {
        return value as JobResult;
    }
    throw new Error('Completed PR comment job has no valid result status');
}

function taskAgeMs(task: TaskStateData, now: number): number {
    const updatedAt = new Date(task.updatedAt).getTime();
    return Number.isFinite(updatedAt) ? Math.max(0, now - updatedAt) : Number.POSITIVE_INFINITY;
}

function isPRCommentTask(task: TaskStateData): boolean {
    return task.issueRef.type === 'pr_comment';
}

async function clearOwnedPRLock(
    task: TaskStateData,
    redis: ReconciliationRedis,
): Promise<boolean> {
    if (!isPRCommentTask(task)) return false;
    const { repoOwner, repoName, number } = task.issueRef;
    if (!repoOwner || !repoName || !Number.isFinite(number) || !task.prProcessingLockToken) return false;

    const lockKey = `lock:pr:${repoOwner}:${repoName}:${number}`;
    const released = await redis.eval(
        RELEASE_OWNED_PR_LOCK_SCRIPT,
        1,
        lockKey,
        task.prProcessingLockToken,
    );
    return Number(released) === 1;
}

async function hasLiveBullLock(
    taskId: string,
    queue: ReconciliationQueue,
    redis: ReconciliationRedis,
): Promise<boolean> {
    return (await redis.pttl(queue.toKey(`${taskId}:lock`))) > 0;
}

async function finalizeCompletedJob(
    task: TaskStateData,
    job: ReconciliationJob,
    options: TaskReconciliationOptions,
    summary: TaskReconciliationSummary,
): Promise<void> {
    if (await finalizePRCommentTaskResult(task.taskId, options.stateManager, asJobResult(job.returnvalue))) {
        summary.finalized++;
    }
    if (await clearOwnedPRLock(task, options.redis)) summary.locksCleared++;
}

async function finalizeFailedJob(
    task: TaskStateData,
    message: string,
    options: TaskReconciliationOptions,
    summary: TaskReconciliationSummary,
): Promise<void> {
    if (await finalizePRCommentTaskFailure(task.taskId, options.stateManager, new Error(message))) {
        summary.interrupted++;
    }
    if (await clearOwnedPRLock(task, options.redis)) summary.locksCleared++;
}

async function handleTerminalQueueState(
    task: TaskStateData,
    job: ReconciliationJob | undefined,
    queueState: string,
    context: ReconciliationContext,
): Promise<boolean> {
    const { options, summary, findRunningContainer } = context;
    if (queueState === 'completed' && job) {
        const result = asJobResult(job.returnvalue);
        const isRetryOutcome = result.status === 'rescheduled' || result.status === 'requeued';
        if (isRetryOutcome && await findRunningContainer(task.taskId)) summary.live++;
        else await finalizeCompletedJob(task, job, options, summary);
        return true;
    }
    if (queueState === 'failed' && job) {
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
    if (task.state !== TaskStates.PENDING) {
        await options.stateManager.updateTaskStateIfCurrent(
            task.taskId,
            { state: task.state, updatedAt: task.updatedAt },
            TaskStates.PENDING,
            {
                reason: `Task recovered in BullMQ ${queueState} state`,
                historyMetadata: { recovered: true, queueState },
            },
        );
    }
    summary.queued++;
    return true;
}

async function reconcileStaleTask(
    task: TaskStateData,
    context: ReconciliationContext,
): Promise<void> {
    const { options, summary, findRunningContainer } = context;
    const job = await options.queue.getJob(task.taskId);
    const queueState = job ? await job.getState() : 'missing';
    if (await handleTerminalQueueState(task, job, queueState, context)) return;
    if (await handleQueuedState(task, queueState, context)) return;

    if (await findRunningContainer(task.taskId)) {
        summary.live++;
        return;
    }
    if (queueState === 'active' && await hasLiveBullLock(task.taskId, options.queue, options.redis)) {
        summary.live++;
        return;
    }

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
    const now = (options.now ?? Date.now)();
    const findRunningContainer = options.findRunningContainer ?? findRunningDockerContainerForTask;
    const tasks = (await options.stateManager.getNonTerminalTasks({
        taskTypes: ['pr_comment'],
    })).filter(isPRCommentTask);
    const summary: TaskReconciliationSummary = {
        scanned: tasks.length,
        fresh: 0,
        live: 0,
        queued: 0,
        finalized: 0,
        interrupted: 0,
        locksCleared: 0,
        errors: 0,
    };
    const context = { options, summary, findRunningContainer };

    for (const task of tasks) {
        if (taskAgeMs(task, now) < staleAfterMs) {
            summary.fresh++;
            continue;
        }

        try {
            await reconcileStaleTask(task, context);
        } catch (error) {
            summary.errors++;
            logger.warn({
                taskId: task.taskId,
                error: (error as Error).message,
            }, 'Failed to reconcile stale task state');
        }
    }

    return summary;
}
