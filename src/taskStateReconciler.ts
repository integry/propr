import {
    executeDockerCommand,
    logger,
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
}

export interface TaskStateReconciliationResult {
    nextCursor: string;
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

function isPRCommentTask(task: TaskStateData): boolean {
    if (task.issueRef.type !== undefined) return task.issueRef.type === 'pr_comment';
    return task.taskId.startsWith('pr-comment-')
        || task.taskId.startsWith('pr-comments-')
        || (Array.isArray(task.issueRef.comments) && task.issueRef.comments.length > 0);
}

export function taskAgeMs(updatedAt: string, now = Date.now()): number | null {
    const timestamp = Date.parse(updatedAt);
    if (!Number.isFinite(timestamp)) return null;
    return Math.max(0, now - timestamp);
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

async function finalizeFromJob(
    task: TaskStateData,
    job: ReconciliationJob,
    stateManager: ReconciliationStateManager,
    summary: TaskStateReconciliationSummary,
): Promise<void> {
    const jobState = await job.getState();
    if (LIVE_JOB_STATES.has(jobState)) {
        summary.live++;
        return;
    }
    if (jobState === 'completed') {
        const result = await finalizeCompletedPRCommentTask(
            task.taskId,
            asJobResult(job.returnvalue),
            stateManager,
        );
        if (result.stateChanged) summary.recovered++;
        else summary.skipped++;
        return;
    }
    if (jobState === 'failed') {
        const result = await finalizeFailedPRCommentTask(
            task.taskId,
            new Error(job.failedReason || 'PR comment job failed before task finalization'),
            stateManager,
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
    options: TaskStateReconciliationOptions,
    summary: TaskStateReconciliationSummary,
): Promise<void> {
    const age = taskAgeMs(task.updatedAt, options.now);
    if (!isPRCommentTask(task) || age === null || age < (options.staleMs ?? DEFAULT_RECONCILIATION_STALE_MS)) {
        summary.skipped++;
        return;
    }
    summary.stale++;

    const job = await options.queue.getJob(task.taskId);
    if (job) {
        await finalizeFromJob(task, job, options.stateManager, summary);
        return;
    }

    const liveness = await (options.inspectContainer ?? inspectLegacyTaskContainerLiveness)(task.taskId);
    if (liveness === 'running') {
        summary.live++;
        return;
    }
    if (liveness === 'unavailable') {
        summary.errors++;
        return;
    }

    const result = await finalizeFailedPRCommentTask(
        task.taskId,
        new Error('PR comment task was orphaned after worker restart; BullMQ job outcome is unavailable'),
        options.stateManager,
    );
    if (result.stateChanged) summary.recovered++;
    else summary.skipped++;
}

export async function reconcileStalePRCommentTasks(
    options: TaskStateReconciliationOptions,
): Promise<TaskStateReconciliationResult> {
    const page = await options.stateManager.scanNonTerminalTasks(
        options.cursor ?? '0',
        options.batchSize ?? 100,
    );
    const summary: TaskStateReconciliationSummary = {
        scanned: page.tasks.length,
        stale: 0,
        live: 0,
        recovered: 0,
        skipped: 0,
        errors: 0,
    };
    const deadline = Date.now() + (options.timeBudgetMs ?? DEFAULT_RECONCILIATION_TIME_BUDGET_MS);

    for (let index = 0; index < page.tasks.length; index++) {
        if (Date.now() >= deadline) {
            summary.skipped += page.tasks.length - index;
            break;
        }
        try {
            await reconcileTask(page.tasks[index], options, summary);
        } catch (error) {
            logger.error({
                taskId: page.tasks[index].taskId,
                error: (error as Error).message,
            }, 'Failed to reconcile stale PR comment task');
            summary.errors++;
        }
    }
    return { nextCursor: page.nextCursor, summary };
}
