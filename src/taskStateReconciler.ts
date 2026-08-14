import {
    inspectExactTaskContainerLivenessForTask,
    inspectLegacyDockerContainerLivenessForTask,
    logger,
    taskStateExpectation,
    type JobResult,
    type TaskStateData,
    type WorkerStateManager,
} from '@propr/core';
import {
    finalizeCompletedPRCommentTask,
    finalizeFailedPRCommentTask,
} from './jobs/prCommentTaskFinalizer.js';

export const DEFAULT_RECONCILIATION_STALE_MS = 15 * 60 * 1000;
export const DEFAULT_RECONCILIATION_TIME_BUDGET_MS = 30 * 1000;

export interface ReconciliationJob {
    id?: string;
    data?: unknown;
    failedReason?: string;
    returnvalue?: unknown;
    getState(): Promise<string>;
}

export interface ReconciliationQueue {
    getJob(taskId: string): Promise<ReconciliationJob | undefined | null>;
}

export type ReconciliationStateManager = Pick<
    WorkerStateManager,
    'scanNonTerminalTasks' | 'getTaskState' | 'updateTaskStateIfCurrentDetailed'
> & Partial<Pick<WorkerStateManager, 'scanRecoverableTasks'>>;

export type TaskContainerLiveness = 'running' | 'not_found' | 'unavailable';

export interface TaskStateReconciliationSummary {
    scanned: number;
    stale: number;
    live: number;
    recovered: number;
    skipped: number;
    errors: number;
}

export interface TaskStateReconciliationOptions {
    queue: ReconciliationQueue;
    stateManager: ReconciliationStateManager;
    cursor?: string;
    batchSize?: number;
    staleMs?: number;
    timeBudgetMs?: number;
    now?: number;
    inspectContainer?: (taskId: string) => Promise<TaskContainerLiveness>;
    inspectLegacyContainer?: (taskId: string) => Promise<TaskContainerLiveness>;
    backlog?: TaskStateData[];
    signal?: AbortSignal;
}

export interface TaskStateReconciliationResult {
    nextCursor: string;
    backlog: TaskStateData[];
    summary: TaskStateReconciliationSummary;
}

const LIVE_JOB_STATES = new Set([
    'active',
    'waiting',
    'delayed',
    'prioritized',
    'waiting-children',
    'paused',
]);

class ReconciliationDeadlineExceededError extends Error {
    constructor() {
        super('Task state reconciliation time budget was exhausted');
        this.name = 'ReconciliationDeadlineExceededError';
    }
}

function abortReason(signal: AbortSignal): unknown {
    return signal.reason ?? new Error('Task state reconciliation was aborted');
}

function deadlineWasExhausted(error: unknown, signal: AbortSignal): boolean {
    return error instanceof ReconciliationDeadlineExceededError
        || (signal.aborted && abortReason(signal) instanceof ReconciliationDeadlineExceededError);
}

async function runWithinRemainingBudget<T>(
    operation: () => Promise<T>,
    deadline: number,
    signal: AbortSignal,
): Promise<T> {
    if (Date.now() >= deadline) throw new ReconciliationDeadlineExceededError();
    signal.throwIfAborted();

    return new Promise<T>((resolve, reject) => {
        const onAbort = (): void => {
            cleanup();
            reject(abortReason(signal));
        };
        const cleanup = (): void => signal.removeEventListener('abort', onAbort);
        signal.addEventListener('abort', onAbort, { once: true });
        if (signal.aborted) {
            onAbort();
            return;
        }

        let pending: Promise<T>;
        try {
            pending = operation();
        } catch (error) {
            cleanup();
            reject(error);
            return;
        }
        pending.then(
            value => {
                cleanup();
                resolve(value);
            },
            error => {
                cleanup();
                reject(error);
            },
        );
    });
}

function taskKind(task: TaskStateData): 'issue' | 'pr_comment' | null {
    if (task.issueRef.type === 'issue') return 'issue';
    if (task.issueRef.type === 'pr_comment') return 'pr_comment';
    if (task.taskId.startsWith('pr-comment-')
        || task.taskId.startsWith('pr-comments-')) return 'pr_comment';
    return null;
}

export function taskAgeMs(updatedAt: string, now = Date.now()): number | null {
    const timestamp = Date.parse(updatedAt);
    if (!Number.isFinite(timestamp) || timestamp > now) return null;
    return now - timestamp;
}

function asJobResult(value: unknown): JobResult | undefined {
    return value !== null && typeof value === 'object'
        ? value as JobResult
        : undefined;
}

function jobMatchesTaskExecution(
    task: TaskStateData,
    job: ReconciliationJob,
    kind: 'issue' | 'pr_comment',
): boolean {
    const persistedTaskId = job.data !== null && typeof job.data === 'object'
        ? (job.data as { taskId?: unknown }).taskId
        : undefined;
    if (typeof persistedTaskId === 'string' && persistedTaskId) {
        return persistedTaskId === task.taskId;
    }
    return kind === 'pr_comment'
        && typeof job.id === 'string'
        && job.id === task.taskId;
}

interface ReconciliationRunContext {
    options: TaskStateReconciliationOptions;
    summary: TaskStateReconciliationSummary;
    deadline: number;
    signal: AbortSignal;
}

async function finalizeFromJob(
    task: TaskStateData,
    job: ReconciliationJob,
    context: ReconciliationRunContext,
): Promise<void> {
    const { options, summary, deadline, signal } = context;
    const jobState = await runWithinRemainingBudget(() => job.getState(), deadline, signal);
    const finalizationOptions = {
        expectation: taskStateExpectation(task),
        signal,
        currentTask: task,
        jobKind: taskKind(task) ?? 'pr_comment',
    };
    if (LIVE_JOB_STATES.has(jobState)) {
        summary.live++;
        return;
    }
    if (jobState === 'completed') {
        const result = await runWithinRemainingBudget(
            () => finalizeCompletedPRCommentTask(
                task.taskId,
                asJobResult(job.returnvalue),
                options.stateManager,
                finalizationOptions,
            ),
            deadline,
            signal,
        );
        if (result.stateChanged) summary.recovered++;
        else summary.skipped++;
        return;
    }
    if (jobState === 'failed') {
        const result = await runWithinRemainingBudget(
            () => finalizeFailedPRCommentTask(
                task.taskId,
                new Error(job.failedReason || 'PR comment job failed before task finalization'),
                options.stateManager,
                finalizationOptions,
            ),
            deadline,
            signal,
        );
        if (result.stateChanged) summary.recovered++;
        else summary.skipped++;
        return;
    }
    logger.warn({ taskId: task.taskId, jobState }, 'Skipped stale task with an unrecognized BullMQ state');
    summary.skipped++;
}

async function reconcileTask(
    task: TaskStateData,
    context: ReconciliationRunContext,
): Promise<void> {
    const { options, summary, deadline, signal } = context;
    const age = taskAgeMs(task.updatedAt, options.now);
    const kind = taskKind(task);
    if (!kind || age === null || age < (options.staleMs ?? DEFAULT_RECONCILIATION_STALE_MS)) {
        summary.skipped++;
        return;
    }
    summary.stale++;

    const exactJobId = typeof task.issueRef.jobId === 'string' && task.issueRef.jobId
        ? task.issueRef.jobId
        : undefined;
    if (kind === 'issue' && !exactJobId) {
        logger.warn({ taskId: task.taskId },
            'Leaving stale issue task unchanged because its exact BullMQ job mapping is unavailable');
        summary.errors++;
        return;
    }
    const jobId = exactJobId ?? task.taskId;
    let job: ReconciliationJob | undefined | null;
    let jobLookupAvailable = true;
    try {
        job = await runWithinRemainingBudget(
            () => options.queue.getJob(jobId),
            deadline,
            signal,
        );
    } catch (error) {
        jobLookupAvailable = false;
        logger.warn({ taskId: task.taskId, jobId, error: (error as Error).message },
            'Cannot reconcile task because BullMQ liveness is unavailable');
    }

    if (job) {
        if (jobMatchesTaskExecution(task, job, kind)) {
            const state = await runWithinRemainingBudget(() => job!.getState(), deadline, signal);
            if (LIVE_JOB_STATES.has(state)) {
                summary.live++;
                return;
            }
        }
    }

    // Even a terminal/missing job is not enough to finalize: its exact labeled
    // container may still be running during a start/completion race.
    const liveness = await runWithinRemainingBudget(
        () => (options.inspectContainer ?? inspectExactTaskContainerLivenessForTask)(task.taskId),
        deadline,
        signal,
    );
    if (liveness === 'running') {
        summary.live++;
        return;
    }
    if (liveness === 'unavailable' || !jobLookupAvailable) {
        logger.warn({ taskId: task.taskId, jobId, jobLookupAvailable, containerLiveness: liveness },
            'Leaving stale task unchanged; verify BullMQ and Docker connectivity before retrying recovery');
        summary.errors++;
        return;
    }

    // Pre-label containers are not exact enough for counts or destructive
    // operations, but they conservatively block terminal recovery.
    const legacyLiveness = await runWithinRemainingBudget(
        () => (options.inspectLegacyContainer ?? inspectLegacyDockerContainerLivenessForTask)(task.taskId),
        deadline,
        signal,
    );
    if (legacyLiveness === 'running') {
        summary.live++;
        return;
    }
    if (legacyLiveness === 'unavailable') {
        logger.warn({ taskId: task.taskId, jobId, legacyContainerLiveness: legacyLiveness },
            'Leaving stale task unchanged because legacy container liveness is unavailable');
        summary.errors++;
        return;
    }

    if (job && !jobMatchesTaskExecution(task, job, kind)) {
        logger.warn({ taskId: task.taskId, jobId },
            'Leaving stale task unchanged because the BullMQ job belongs to a different execution');
        summary.errors++;
        return;
    }

    if (job) {
        await finalizeFromJob(task, job, context);
        return;
    }

    const result = await runWithinRemainingBudget(
        () => finalizeFailedPRCommentTask(
            task.taskId,
            new Error('PR comment task was orphaned after worker restart; BullMQ job outcome is unavailable'),
            options.stateManager,
            {
                expectation: taskStateExpectation(task),
                signal,
                currentTask: task,
            },
        ),
        deadline,
        signal,
    );
    if (result.stateChanged) summary.recovered++;
    else summary.skipped++;
}

export async function reconcileStalePRCommentTasks(
    options: TaskStateReconciliationOptions,
): Promise<TaskStateReconciliationResult> {
    const timeBudgetMs = Math.max(
        0,
        options.timeBudgetMs ?? DEFAULT_RECONCILIATION_TIME_BUDGET_MS,
    );
    const deadline = Date.now() + timeBudgetMs;
    const controller = new AbortController();
    const abortFromParent = (): void => controller.abort(options.signal?.reason);
    if (options.signal?.aborted) abortFromParent();
    else options.signal?.addEventListener('abort', abortFromParent, { once: true });
    const deadlineTimer = setTimeout(
        () => controller.abort(new ReconciliationDeadlineExceededError()),
        timeBudgetMs,
    );

    try {
        const carriedBacklog = options.backlog ?? [];
        const page = carriedBacklog.length > 0
            ? { tasks: carriedBacklog, nextCursor: options.cursor ?? '0' }
            : await runWithinRemainingBudget(
                () => (options.stateManager.scanRecoverableTasks ?? options.stateManager.scanNonTerminalTasks).call(
                    options.stateManager,
                    options.cursor ?? '0',
                    options.batchSize ?? 100,
                ),
                deadline,
                controller.signal,
            );
        const summary: TaskStateReconciliationSummary = {
            scanned: page.tasks.length,
            stale: 0,
            live: 0,
            recovered: 0,
            skipped: 0,
            errors: 0,
        };
        let backlogStart = page.tasks.length;
        const context: ReconciliationRunContext = {
            options,
            summary,
            deadline,
            signal: controller.signal,
        };

        for (let index = 0; index < page.tasks.length; index++) {
            if (Date.now() >= deadline) {
                backlogStart = index;
                break;
            }
            try {
                await reconcileTask(page.tasks[index], context);
            } catch (error) {
                if (deadlineWasExhausted(error, controller.signal)) {
                    backlogStart = index;
                    break;
                }
                if (controller.signal.aborted) {
                    throw abortReason(controller.signal);
                }
                logger.error({
                    taskId: page.tasks[index].taskId,
                    error: (error as Error).message,
                }, 'Failed to reconcile stale task');
                summary.errors++;
            }
        }
        return {
            nextCursor: page.nextCursor,
            backlog: page.tasks.slice(backlogStart),
            summary,
        };
    } finally {
        clearTimeout(deadlineTimer);
        options.signal?.removeEventListener('abort', abortFromParent);
    }
}
