import type { Job } from 'bullmq';
import type { Logger } from 'pino';
import type { Redis } from 'ioredis';
import {
    inspectLegacyDockerContainerLivenessForTask,
    inspectTaskContainerLivenessForTask,
    issueQueue,
    TaskStates,
    type CommentJobData,
    type TaskContainerInspection,
    type TaskStateData,
    type UnprocessedComment,
    type WorkerStateManager,
} from '@propr/core';
import { restorePendingComments } from './prPendingComments.js';

export interface PRCommentContainerCollision {
    taskId: string;
    inspection: TaskContainerInspection;
    source: 'exact-label' | 'legacy-name';
}

/** Only collision-owned cancellation may create a replacement automatically. */
export function isContainerCollisionCancellation(state: TaskStateData | null): boolean {
    if (state?.state !== TaskStates.CANCELLED) return false;
    const cancellation = state.history.findLast(entry => entry.state === TaskStates.CANCELLED);
    if (cancellation) {
        return cancellation.reason.includes('agent_container_already_running')
            || cancellation.metadata?.recoveryReason === 'agent_container_already_running';
    }
    // Legacy task records may predate cancellation history metadata.
    return state.lastError?.message.includes('agent_container_already_running') === true;
}

/** Fail-closed collision check for the current task and any recovery ancestor. */
export async function inspectPRCommentContainerCollision(
    taskIds: string[],
): Promise<PRCommentContainerCollision | null> {
    for (const taskId of [...new Set(taskIds)]) {
        const inspection = await inspectTaskContainerLivenessForTask(taskId);
        if (inspection.liveness === 'running' || inspection.liveness === 'unavailable') {
            return { taskId, inspection, source: 'exact-label' };
        }

        const legacyLiveness = await inspectLegacyDockerContainerLivenessForTask(taskId);
        if (legacyLiveness !== 'not_found') {
            return {
                taskId,
                inspection: {
                    liveness: legacyLiveness === 'running' ? 'running' : 'unavailable',
                    container: null,
                },
                source: 'legacy-name',
            };
        }
    }
    return null;
}

interface ScheduleRecoveryParams {
    job: Job<CommentJobData>;
    taskId: string;
    stateManager: WorkerStateManager;
    redisClient: Redis;
    pickedUpComments: UnprocessedComment[];
    delay: number;
    reason: string;
    correlatedLogger: Logger;
    containerCollisionTaskId?: string;
    containerCollisionTaskIds?: string[];
}

async function recordRecoveryLink(
    params: ScheduleRecoveryParams,
    replacementTaskId: string,
): Promise<void> {
    const { job, taskId, stateManager, reason, correlatedLogger } = params;
    const historyMetadata = {
        recoveryOfTaskId: taskId,
        replacementTaskId,
        recoveryReason: reason,
    };
    try {
        const replacementState = await stateManager.createTaskStateIfAbsent(replacementTaskId, {
            number: job.data.pullRequestNumber,
            pullRequestNumber: job.data.pullRequestNumber,
            repoOwner: job.data.repoOwner,
            repoName: job.data.repoName,
            type: 'pr-comment',
            comments: job.data.comments,
            modelName: job.data.llm ?? undefined,
        }, job.data.correlationId, replacementTaskId);
        if (replacementState) {
            await stateManager.updateHistoryMetadata(replacementTaskId, replacementState.state, historyMetadata);
        }

        const originalState = await stateManager.getTaskState(taskId);
        if (originalState) {
            await stateManager.updateHistoryMetadata(taskId, originalState.state, historyMetadata);
        }
    } catch (error) {
        correlatedLogger.warn({ taskId, replacementTaskId, error: (error as Error).message }, 'Failed to link PR comment recovery task state');
    }
}

/** Restore destructively claimed comments before publishing a delayed owner. */
export async function schedulePRCommentRecovery(
    params: ScheduleRecoveryParams,
): Promise<string | undefined> {
    const { job, taskId, redisClient, pickedUpComments, delay, reason, correlatedLogger } = params;
    await restorePendingComments(pickedUpComments, {
        repoOwner: job.data.repoOwner,
        repoName: job.data.repoName,
        pullRequestNumber: job.data.pullRequestNumber,
        redisClient,
    });

    const recoveryData = { ...job.data };
    delete recoveryData.prProcessingLockToken;
    const recoveryJob = await issueQueue.add(job.name, {
        ...recoveryData,
        ...(params.containerCollisionTaskId
            ? { containerCollisionTaskId: params.containerCollisionTaskId }
            : {}),
        ...(params.containerCollisionTaskIds
            ? { containerCollisionTaskIds: params.containerCollisionTaskIds }
            : {}),
    }, { delay });
    const replacementTaskId = recoveryJob?.id ? String(recoveryJob.id) : undefined;
    correlatedLogger.info({ taskId, replacementTaskId, delay, reason, restoredCommentCount: pickedUpComments.length }, 'Scheduled PR comment recovery job');
    if (replacementTaskId) await recordRecoveryLink(params, replacementTaskId);
    return replacementTaskId;
}

interface PreExecutionRecoveryParams {
    job: Job<CommentJobData>;
    taskId: string;
    stateManager: WorkerStateManager;
    redisClient: Redis;
    pickedUpComments: UnprocessedComment[];
    correlatedLogger: Logger;
    releaseLock: () => Promise<unknown>;
}

export interface PreExecutionRecoveryDecision {
    preexistingState: TaskStateData | null;
    result?: { status: string; reason: string; replacementTaskId?: string };
}

type CancellationRecoveryParams = Omit<PreExecutionRecoveryParams, 'releaseLock'> & {
    releaseLock?: () => Promise<unknown>;
};

/** Preserve a latest explicit user cancellation before any replacement is queued. */
export async function evaluatePRCommentCancellation(
    params: CancellationRecoveryParams,
): Promise<PreExecutionRecoveryDecision> {
    const { job, taskId, stateManager, redisClient, pickedUpComments, correlatedLogger } = params;
    const preexistingState = await stateManager.getTaskState(taskId);
    if (preexistingState?.state !== TaskStates.CANCELLED
        || isContainerCollisionCancellation(preexistingState)) {
        return { preexistingState };
    }

    try {
        await restorePendingComments(pickedUpComments, {
            repoOwner: job.data.repoOwner,
            repoName: job.data.repoName,
            pullRequestNumber: job.data.pullRequestNumber,
            redisClient,
        });
    } finally {
        await params.releaseLock?.();
    }
    correlatedLogger.info({ taskId }, 'Task was already cancelled; preserving terminal state and not starting a recovery agent');
    return { preexistingState, result: { status: 'cancelled', reason: 'task_already_cancelled' } };
}

/** Resolve cancellation ownership before replacing a lock-contending job. */
export async function handlePRCommentLockContention(
    params: CancellationRecoveryParams,
): Promise<{ status: string; reason: string; replacementTaskId?: string }> {
    const cancellationDecision = await evaluatePRCommentCancellation(params);
    if (cancellationDecision.result) return cancellationDecision.result;
    const replacementTaskId = await schedulePRCommentRecovery({
        ...params,
        delay: 10000,
        reason: 'pr_locked_by_other_job',
    });
    return { status: 'rescheduled', reason: 'pr_locked_by_other_job', replacementTaskId };
}

async function scheduleRecoveryAndRelease(
    params: PreExecutionRecoveryParams,
    options: {
        delay: number;
        reason: string;
        containerCollisionTaskId?: string;
        containerCollisionTaskIds?: string[];
        preserveLock?: boolean;
    },
): Promise<string | undefined> {
    const { preserveLock, ...recoveryOptions } = options;
    try {
        return await schedulePRCommentRecovery({ ...params, ...recoveryOptions });
    } finally {
        if (!preserveLock) await params.releaseLock();
    }
}

/** Resolves terminal ownership and container liveness before an agent starts. */
export async function evaluatePRCommentPreExecutionRecovery(
    params: PreExecutionRecoveryParams,
): Promise<PreExecutionRecoveryDecision> {
    const { job, taskId, correlatedLogger } = params;
    const cancellationDecision = await evaluatePRCommentCancellation(params);
    const { preexistingState } = cancellationDecision;
    if (cancellationDecision.result) return cancellationDecision;
    const collisionCancellation = isContainerCollisionCancellation(preexistingState);

    const collisionAncestorTaskIds = [...new Set([
        ...(job.data.containerCollisionTaskIds ?? []),
        ...(job.data.containerCollisionTaskId ? [job.data.containerCollisionTaskId] : []),
    ])];
    const collision = await inspectPRCommentContainerCollision([taskId, ...collisionAncestorTaskIds]);
    if (collision) {
        correlatedLogger.warn({
            taskId,
            collisionTaskId: collision.taskId,
            liveness: collision.inspection.liveness,
            inspectionSource: collision.source,
            containerId: collision.inspection.container?.id,
            containerName: collision.inspection.container?.name,
        }, 'Agent execution for this task may already be running. Rescheduling without starting another attempt.');
        const replacementTaskId = await scheduleRecoveryAndRelease(params, {
            delay: 60000,
            reason: 'agent_container_already_running',
            containerCollisionTaskId: job.data.containerCollisionTaskId ?? collision.taskId,
            containerCollisionTaskIds: [...new Set([...collisionAncestorTaskIds, collision.taskId])],
            preserveLock: collision.taskId === taskId,
        });
        return { preexistingState, result: { status: 'rescheduled', reason: 'agent_container_already_running', replacementTaskId } };
    }

    if (collisionCancellation) {
        const replacementTaskId = await scheduleRecoveryAndRelease(params, {
            delay: 3000,
            reason: 'cancelled_collision_attempt_recovery',
        });
        return { preexistingState, result: { status: 'rescheduled', reason: 'cancelled_collision_attempt_recovery', replacementTaskId } };
    }
    return { preexistingState };
}

/** Create only a genuinely new attempt; never overwrite recovery/cancellation history. */
export async function createPRCommentTaskStateIfMissing(params: {
    job: Job<CommentJobData>;
    taskId: string;
    stateManager: WorkerStateManager;
    preexistingState: TaskStateData | null;
    modelName: string | null;
    correlatedLogger: Logger;
}): Promise<void> {
    if (params.preexistingState) return;
    const { job, taskId, stateManager, modelName, correlatedLogger } = params;
    try {
        await stateManager.createTaskState(taskId, {
            number: job.data.pullRequestNumber,
            pullRequestNumber: job.data.pullRequestNumber,
            repoOwner: job.data.repoOwner,
            repoName: job.data.repoName,
            type: 'pr-comment',
            comments: job.data.comments,
            modelName: modelName ?? undefined,
        }, job.data.correlationId, String(job.id ?? taskId));
    } catch (error) {
        correlatedLogger.warn({ taskId, error: (error as Error).message }, 'Failed to create initial task state, continuing anyway');
    }
}
