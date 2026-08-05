import {
    TaskStates,
    taskStateExpectation,
    type JobResult,
    type TaskState,
    type UpdateMetadata,
    type WorkerStateManager,
} from '@propr/core';
import { sanitizeErrorMessage } from './errorSanitizer.js';

const MAX_FINALIZATION_ATTEMPTS = 3;
const TERMINAL_STATES = new Set<TaskState>([
    TaskStates.COMPLETED,
    TaskStates.FAILED,
    TaskStates.CANCELLED,
]);

type TaskStateStore = Pick<
    WorkerStateManager,
    'getTaskState' | 'updateTaskStateIfCurrent'
>;

interface FinalTransition {
    state: TaskState;
    metadata: UpdateMetadata;
}

function resultReason(result: JobResult): string | undefined {
    return typeof result.reason === 'string' ? result.reason : undefined;
}

function completedTransition(result: JobResult | undefined): FinalTransition {
    const status = result?.status;
    const reason = result ? resultReason(result) : undefined;
    const historyMetadata = {
        finalizedBy: 'bullmq_completed',
        jobResultStatus: status ?? null,
        jobResultReason: reason ?? null,
    };

    switch (status) {
        case 'complete':
        case 'completed':
        case 'partial':
        case 'skipped':
            return {
                state: TaskStates.COMPLETED,
                metadata: {
                    reason: status === 'skipped'
                        ? `PR comment job skipped${reason ? `: ${reason}` : ''}`
                        : 'PR comment job completed',
                    historyMetadata,
                },
            };
        case 'cancelled':
        case 'requeued':
        case 'rescheduled':
            return {
                state: TaskStates.CANCELLED,
                metadata: {
                    reason: `PR comment job ${status}${reason ? `: ${reason}` : ''}`,
                    historyMetadata,
                },
            };
        case 'failed':
            return failedTransition(reason ?? 'PR comment job returned a failed result', 'bullmq_completed');
        default: {
            const diagnostic = status
                ? `Unexpected PR comment job result status: ${status}`
                : 'PR comment job completed without a result status';
            return failedTransition(diagnostic, 'bullmq_completed');
        }
    }
}

function failedTransition(errorMessage: string, finalizedBy: string): FinalTransition {
    const message = sanitizeErrorMessage(errorMessage);
    return {
        state: TaskStates.FAILED,
        metadata: {
            reason: 'PR comment job failed',
            error: { message, category: 'worker' },
            historyMetadata: { finalizedBy, error: message },
        },
    };
}

async function applyFinalTransition(
    taskId: string,
    transition: FinalTransition,
    stateManager: TaskStateStore,
): Promise<boolean> {
    for (let attempt = 0; attempt < MAX_FINALIZATION_ATTEMPTS; attempt++) {
        const current = await stateManager.getTaskState(taskId);
        if (!current || TERMINAL_STATES.has(current.state)) return false;
        const updated = await stateManager.updateTaskStateIfCurrent(
            taskId,
            taskStateExpectation(current),
            transition.state,
            transition.metadata,
        );
        if (updated) return true;
    }
    return false;
}

export async function finalizeCompletedPRCommentTask(
    taskId: string,
    result: JobResult | undefined,
    stateManager: TaskStateStore,
): Promise<boolean> {
    return applyFinalTransition(taskId, completedTransition(result), stateManager);
}

export async function finalizeFailedPRCommentTask(
    taskId: string,
    error: Error,
    stateManager: TaskStateStore,
): Promise<boolean> {
    return applyFinalTransition(
        taskId,
        failedTransition(error.message, 'bullmq_failed'),
        stateManager,
    );
}
