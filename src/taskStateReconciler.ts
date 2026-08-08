import {
    executeDockerCommand,
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
>;

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

function isPRCommentTask(task: TaskStateData): boolean {
    if (task.issueRef.type !== undefined) return task.issueRef.type === 'pr_comment';
    return task.taskId.startsWith('pr-comment-')
        || task.taskId.startsWith('pr-comments-')
        || (Array.isArray(task.issueRef.comments) && task.issueRef.comments.length > 0);
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

export async function inspectLegacyTaskContainerLiveness(
    taskId: string,
    executor: typeof executeDockerCommand = executeDockerCommand,
): Promise<TaskContainerLiveness> {
    const shortTaskId = taskId.slice(-8);
    if (!shortTaskId) return 'not_found';
    const escapedSuffix = shortTaskId.replace(/[.*+?^$()|[\]\\{}]/g, '\\$&');
    try {
        const result = await executor('docker', [
            'ps',
            '--filter', `name=${escapedSuffix}$`,
            '--format', '{{.ID}}',
        ], { timeout: 10_000 });
        if (result.exitCode !== 0) {
            logger.warn({ taskId, stderr: result.stderr }, 'Docker liveness check failed during task reconciliation');
            return 'unavailable';
        }
        return result.stdout.split('\n').some(line => line.trim())
            ? 'running'
            : 'not_found';
    } catch (error) {
        logger.warn({ taskId, error: (error as Error).message }, 'Docker liveness check was unavailable during task reconciliation');
        return 'unavailable';
    }
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
    if (!isPRCommentTask(task) || age === null || age < (options.staleMs ?? DEFAULT_RECONCILIATION_STALE_MS)) {
        summary.skipped++;
        return;
    }
    summary.stale++;

    const job = await runWithinRemainingBudget(
        () => options.queue.getJob(task.taskId),
        deadline,
        signal,
    );
    if (job) {
        await finalizeFromJob(task, job, context);
        return;
    }

    const liveness = await runWithinRemainingBudget(
        () => (options.inspectContainer ?? inspectLegacyTaskContainerLiveness)(task.taskId),
        deadline,
        signal,
    );
    if (liveness === 'running') {
        summary.live++;
        return;
    }
    if (liveness === 'unavailable') {
        summary.errors++;
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
                () => options.stateManager.scanNonTerminalTasks(
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
                }, 'Failed to reconcile stale PR comment task');
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
