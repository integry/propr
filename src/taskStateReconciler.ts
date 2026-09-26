import {
    executeDockerCommand,
    inspectLegacyDockerContainerLivenessForTask,
    inspectTaskContainerLivenessForTask,
    logger,
    taskStateExpectation,
    TaskStates,
    type TaskState,
    type TaskStateData,
    type UpdateMetadata,
    type WorkerStateManager,
} from '@propr/core';
import type {
    PersistedTaskStateCandidate,
    PersistedTaskStateStore,
    PersistedTaskTerminalTransition,
} from './persistedTaskStateStore.js';
import {
    completedJobTransition,
    failedTaskTransition,
    redisTerminalTransition,
} from './taskReconciliationTransitions.js';
import {
    abortReason,
    deadlineWasExhausted,
    ReconciliationDeadlineExceededError,
    runWithinRemainingBudget,
} from './taskReconciliationBudget.js';
import { taskAgeMs } from './taskReconciliationTime.js';

export const DEFAULT_RECONCILIATION_STALE_MS = 15 * 60 * 1000;
export const DEFAULT_RECONCILIATION_ORPHAN_GRACE_MS = 60 * 1000;
export const DEFAULT_RECONCILIATION_TIME_BUDGET_MS = 30 * 1000;
const LEGACY_UNLINKED_TASK_MIN_AGE_MS = 7 * 24 * 60 * 60 * 1000;

export interface ReconciliationJob {
    failedReason?: string;
    returnvalue?: unknown;
    getState(): Promise<string>;
}

export interface ReconciliationQueue {
    getJob(jobId: string): Promise<ReconciliationJob | undefined | null>;
}

export type ReconciliationStateManager = Pick<
    WorkerStateManager,
    'getTaskState' | 'updateTaskStateIfCurrentDetailed'
>;

export type TaskContainerLiveness = 'running' | 'not_found' | 'unavailable';

export interface TaskStateReconciliationSummary {
    scanned: number;
    stale: number;
    live: number;
    suspected: number;
    recovered: number;
    skipped: number;
    errors: number;
}

export interface TaskStateReconciliationOptions {
    queue: ReconciliationQueue;
    stateManager: ReconciliationStateManager;
    store: PersistedTaskStateStore;
    cursor?: string;
    batchSize?: number;
    staleMs?: number;
    orphanGraceMs?: number;
    timeBudgetMs?: number;
    now?: number;
    inspectContainer?: (taskId: string) => Promise<TaskContainerLiveness>;
    backlog?: PersistedTaskStateCandidate[];
    signal?: AbortSignal;
}

export interface TaskStateReconciliationResult {
    nextCursor: string;
    backlog: PersistedTaskStateCandidate[];
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
const TERMINAL_TASK_STATES = new Set<TaskState>([
    TaskStates.COMPLETED,
    TaskStates.FAILED,
    TaskStates.CANCELLED,
]);

function taskIdIsQueueJobId(candidate: PersistedTaskStateCandidate): boolean {
    return candidate.taskType === 'pr-comment'
        || candidate.taskType === 'review'
        || candidate.taskType === 'merge_conflict'
        || candidate.taskId.startsWith('pr-comment-')
        || candidate.taskId.startsWith('pr-comments-');
}

export async function inspectLegacyTaskContainerLiveness(
    taskId: string,
    executor: typeof executeDockerCommand = executeDockerCommand,
): Promise<TaskContainerLiveness> {
    const exact = await inspectTaskContainerLivenessForTask(taskId, executor);
    if (exact.liveness === 'running') return 'running';
    if (exact.liveness === 'unavailable') return 'unavailable';

    // Pre-label containers can only be checked by their historical name suffix.
    return inspectLegacyDockerContainerLivenessForTask(taskId, executor);
}

interface ReconciliationRunContext {
    options: TaskStateReconciliationOptions;
    summary: TaskStateReconciliationSummary;
    deadline: number;
    signal: AbortSignal;
    now: number;
}

async function finalizeCandidate(
    candidate: PersistedTaskStateCandidate,
    transition: PersistedTaskTerminalTransition,
    current: TaskStateData | null,
    context: ReconciliationRunContext,
): Promise<void> {
    const { options, summary, deadline, signal, now } = context;
    // Candidates can be carried across runs while a reused BullMQ job ID moves
    // to a newer task. Revalidate after the outcome was read so neither the
    // Redis nor the durable path attributes another task's result to this one.
    const ownsJob = await runWithinRemainingBudget(
        () => options.store.ownsJobAssignment(candidate),
        deadline,
        signal,
    );
    if (!ownsJob) {
        logger.warn({ taskId: candidate.taskId, jobId: candidate.jobId },
            'Skipped stale task whose persisted queue job assignment changed');
        summary.skipped++;
        return;
    }
    if (current && !TERMINAL_TASK_STATES.has(current.state)) {
        const metadata: UpdateMetadata = {
            reason: transition.reason,
            error: transition.state === TaskStates.FAILED
                ? transition.metadata.error as UpdateMetadata['error']
                : undefined,
            historyMetadata: transition.metadata,
        };
        const updated = await runWithinRemainingBudget(
            () => options.stateManager.updateTaskStateIfCurrentDetailed(
                candidate.taskId,
                taskStateExpectation(current),
                transition.state,
                metadata,
            ),
            deadline,
            signal,
        );
        if (!updated) {
            summary.skipped++;
            return;
        }
        if (updated.publication.historyPersisted) {
            await runWithinRemainingBudget(() => options.store.clearMissing(candidate.taskId), deadline, signal);
            summary.recovered++;
            if (!updated.publication.eventPublished) summary.errors++;
            return;
        }
    }

    const persisted = await runWithinRemainingBudget(
        () => options.store.finalizeIfCurrent(
            candidate,
            transition,
            new Date(now).toISOString(),
        ),
        deadline,
        signal,
    );
    if (persisted.stateChanged) {
        summary.recovered++;
        if (!persisted.eventPublished) summary.errors++;
    } else {
        summary.skipped++;
    }
}

async function reconcileQueueJob(
    candidate: PersistedTaskStateCandidate,
    current: TaskStateData | null,
    job: ReconciliationJob,
    context: ReconciliationRunContext,
): Promise<void> {
    const { options, summary, deadline, signal } = context;
    const queueJobId = candidate.jobId ?? candidate.taskId;
    const jobState = await runWithinRemainingBudget(() => job.getState(), deadline, signal);
    if (LIVE_JOB_STATES.has(jobState)) {
        await runWithinRemainingBudget(() => options.store.clearMissing(candidate.taskId), deadline, signal);
        summary.live++;
        return;
    }
    if (jobState === 'completed') {
        await finalizeCandidate(candidate, completedJobTransition(job.returnvalue), current, context);
        return;
    }
    if (jobState === 'failed') {
        await finalizeCandidate(candidate, failedTaskTransition(
            job.failedReason || 'Task job failed before task finalization',
            'bullmq_failed_reconciliation',
        ), current, context);
        return;
    }
    logger.warn({ taskId: candidate.taskId, queueJobId, jobState },
        'Skipped stale task with an unrecognized BullMQ state');
    summary.skipped++;
}

async function reconcileMissingJob(
    candidate: PersistedTaskStateCandidate,
    current: TaskStateData | null,
    context: ReconciliationRunContext,
): Promise<void> {
    const { options, summary, deadline, signal, now } = context;
    const liveness = await runWithinRemainingBudget(
        () => (options.inspectContainer ?? inspectLegacyTaskContainerLiveness)(candidate.taskId),
        deadline,
        signal,
    );
    if (liveness === 'running') {
        await runWithinRemainingBudget(() => options.store.clearMissing(candidate.taskId), deadline, signal);
        summary.live++;
        return;
    }
    if (liveness === 'unavailable') {
        summary.errors++;
        return;
    }

    // Old workers did not persist issue-job IDs. A still-present Redis state is
    // insufficient evidence that such a job is gone because taskId != job.id.
    if (current && !candidate.jobId && !taskIdIsQueueJobId(candidate)) {
        logger.warn({ taskId: candidate.taskId },
            'Deferred stale task without a durable queue job ID while Redis state still exists');
        summary.skipped++;
        return;
    }
    const candidateAge = taskAgeMs(candidate.updatedAt, now);
    if (!candidate.jobId
        && !taskIdIsQueueJobId(candidate)
        && (candidateAge === null || candidateAge < LEGACY_UNLINKED_TASK_MIN_AGE_MS)) {
        logger.warn({ taskId: candidate.taskId, candidateAge },
            'Deferred legacy task without a durable queue job ID until the Redis retention window elapses');
        summary.skipped++;
        return;
    }

    const observation = await runWithinRemainingBudget(
        () => options.store.recordMissing(candidate, new Date(now).toISOString()),
        deadline,
        signal,
    );
    const observationAge = taskAgeMs(observation.firstMissingAt, now);
    if (observation.observations < 2
        || observationAge === null
        || observationAge < (options.orphanGraceMs ?? DEFAULT_RECONCILIATION_ORPHAN_GRACE_MS)) {
        summary.suspected++;
        return;
    }

    await finalizeCandidate(candidate, failedTaskTransition(
        'Task was orphaned after worker restart; no BullMQ job or running task container was found',
        'orphan_reconciliation',
    ), current, context);
}

async function reconcileCandidate(
    candidate: PersistedTaskStateCandidate,
    context: ReconciliationRunContext,
): Promise<void> {
    const { options, summary, deadline, signal, now } = context;
    const age = taskAgeMs(candidate.updatedAt, now);
    if (age === null || age < (options.staleMs ?? DEFAULT_RECONCILIATION_STALE_MS)) {
        summary.skipped++;
        return;
    }
    summary.stale++;

    const current = await runWithinRemainingBudget(
        () => options.stateManager.getTaskState(candidate.taskId),
        deadline,
        signal,
    );
    if (current && TERMINAL_TASK_STATES.has(current.state)) {
        await finalizeCandidate(candidate, redisTerminalTransition(current), current, context);
        return;
    }
    const redisAge = current ? taskAgeMs(current.updatedAt, now) : null;
    if (current && redisAge !== null && redisAge < (options.staleMs ?? DEFAULT_RECONCILIATION_STALE_MS)) {
        await runWithinRemainingBudget(() => options.store.clearMissing(candidate.taskId), deadline, signal);
        summary.live++;
        return;
    }

    const queueJobId = candidate.jobId ?? candidate.taskId;
    const job = await runWithinRemainingBudget(
        () => options.queue.getJob(queueJobId),
        deadline,
        signal,
    );
    if (job) {
        await reconcileQueueJob(candidate, current, job, context);
        return;
    }
    await reconcileMissingJob(candidate, current, context);
}

export async function reconcileStaleTaskStates(
    options: TaskStateReconciliationOptions,
): Promise<TaskStateReconciliationResult> {
    const timeBudgetMs = Math.max(0, options.timeBudgetMs ?? DEFAULT_RECONCILIATION_TIME_BUDGET_MS);
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
                () => options.store.scanNonTerminalTasks(
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
            suspected: 0,
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
            now: options.now ?? Date.now(),
        };

        for (let index = 0; index < page.tasks.length; index++) {
            if (Date.now() >= deadline) {
                backlogStart = index;
                break;
            }
            try {
                await reconcileCandidate(page.tasks[index], context);
            } catch (error) {
                if (deadlineWasExhausted(error, controller.signal)) {
                    backlogStart = index;
                    break;
                }
                if (controller.signal.aborted) throw abortReason(controller.signal);
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
