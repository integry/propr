import {
    TaskStates,
    taskStateExpectation,
    type JobResult,
    type TaskStatePublicationResult,
    type TaskState,
    type UpdateMetadata,
    type WorkerStateManager,
} from '@propr/core';
import { sanitizeErrorMessage } from './errorSanitizer.js';

const MAX_FINALIZATION_RETRY_DELAY_MS = 1_000;
const TERMINAL_STATES = new Set<TaskState>([
    TaskStates.COMPLETED,
    TaskStates.FAILED,
    TaskStates.CANCELLED,
]);

type TaskStateStore = Pick<
    WorkerStateManager,
    'getTaskState' | 'updateTaskStateIfCurrentDetailed'
>;

export type PRCommentTaskFinalizationOutcome =
    | 'finalized'
    | 'partial_publication'
    | 'already_terminal'
    | 'retry_pending'
    | 'task_missing';

export interface PRCommentTaskFinalizationResult {
    outcome: PRCommentTaskFinalizationOutcome;
    stateChanged: boolean;
    publication?: TaskStatePublicationResult;
}

interface FinalTransition {
    state: TaskState;
    metadata: UpdateMetadata;
}

function sanitizedProcessorText(value: unknown): string | undefined {
    return typeof value === 'string' && value.trim()
        ? sanitizeErrorMessage(value)
        : undefined;
}

function publicationSucceeded(publication: TaskStatePublicationResult): boolean {
    return publication.historyPersisted && publication.eventPublished;
}

async function waitForFinalizationRetry(attempt: number): Promise<void> {
    const delayMs = Math.min(10 * (2 ** attempt), MAX_FINALIZATION_RETRY_DELAY_MS);
    await new Promise(resolve => setTimeout(resolve, delayMs));
}

function completedTransition(result: JobResult | undefined): FinalTransition {
    const status = result?.status;
    const safeStatus = sanitizedProcessorText(status);
    const reason = result ? sanitizedProcessorText(result.reason) : undefined;
    const historyMetadata = {
        finalizedBy: 'bullmq_completed',
        jobResultStatus: safeStatus ?? null,
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
                        ? sanitizeErrorMessage(`PR comment job skipped${reason ? `: ${reason}` : ''}`)
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
                    reason: sanitizeErrorMessage(`PR comment job ${status}${reason ? `: ${reason}` : ''}`),
                    historyMetadata,
                },
            };
        case 'failed':
            return failedTransition(reason ?? 'PR comment job returned a failed result', 'bullmq_completed');
        default: {
            const diagnostic = status
                ? `Unexpected PR comment job result status: ${safeStatus ?? '[invalid]'}`
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
): Promise<PRCommentTaskFinalizationResult> {
    for (let attempt = 0; ; attempt++) {
        const current = await stateManager.getTaskState(taskId);
        if (!current) return { outcome: 'task_missing', stateChanged: false };
        if (TERMINAL_STATES.has(current.state)) {
            return { outcome: 'already_terminal', stateChanged: false };
        }
        const updated = await stateManager.updateTaskStateIfCurrentDetailed(
            taskId,
            taskStateExpectation(current),
            transition.state,
            transition.metadata,
        );
        if (updated) {
            return {
                outcome: publicationSucceeded(updated.publication)
                    ? 'finalized'
                    : 'partial_publication',
                stateChanged: true,
                publication: updated.publication,
            };
        }
        await waitForFinalizationRetry(attempt);
    }
}

export async function finalizeCompletedPRCommentTask(
    taskId: string,
    result: JobResult | undefined,
    stateManager: TaskStateStore,
): Promise<PRCommentTaskFinalizationResult> {
    return applyFinalTransition(taskId, completedTransition(result), stateManager);
}

export async function finalizeFailedPRCommentTask(
    taskId: string,
    error: Error,
    stateManager: TaskStateStore,
): Promise<PRCommentTaskFinalizationResult> {
    return applyFinalTransition(
        taskId,
        failedTransition(error.message, 'bullmq_failed'),
        stateManager,
    );
}
