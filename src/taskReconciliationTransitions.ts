import { TaskStates, type JobResult, type TaskStateData } from '@propr/core';
import { sanitizeErrorMessage } from './jobs/errorSanitizer.js';
import type { PersistedTaskTerminalTransition } from './persistedTaskStateStore.js';

function processorText(value: unknown): string | undefined {
    return typeof value === 'string' && value.trim()
        ? sanitizeErrorMessage(value)
        : undefined;
}

export function failedTaskTransition(
    message: string,
    finalizedBy: string,
): PersistedTaskTerminalTransition {
    return {
        state: TaskStates.FAILED,
        reason: 'Task execution failed',
        metadata: {
            finalizedBy,
            error: { message: sanitizeErrorMessage(message), category: 'worker' },
        },
    };
}

export function completedJobTransition(value: unknown): PersistedTaskTerminalTransition {
    const result = value !== null && typeof value === 'object'
        ? value as JobResult
        : undefined;
    const status = processorText(result?.status);
    const reason = processorText(result?.reason);
    const metadata = {
        finalizedBy: 'bullmq_completed_reconciliation',
        jobResultStatus: status ?? null,
        jobResultReason: reason ?? null,
    };
    if (status === 'cancelled' || status === 'requeued' || status === 'rescheduled') {
        return {
            state: TaskStates.CANCELLED,
            reason: `Task job ${status}${reason ? `: ${reason}` : ''}`,
            metadata,
        };
    }
    if (status === 'failed') {
        return failedTaskTransition(
            reason ?? 'Task job returned a failed result',
            'bullmq_completed_reconciliation',
        );
    }
    if (!status || !['complete', 'completed', 'partial', 'skipped'].includes(status)) {
        return failedTaskTransition(
            status ? `Unexpected task job result status: ${status}` : 'Task job completed without a result status',
            'bullmq_completed_reconciliation',
        );
    }
    return {
        state: TaskStates.COMPLETED,
        reason: status === 'skipped'
            ? `Task job skipped${reason ? `: ${reason}` : ''}`
            : 'Task job completed',
        metadata,
    };
}

/**
 * Replays a terminal Redis transition whose SQLite history write was lost.
 *
 * The original reason and history metadata are preserved: they carry outcome
 * details, such as a rescheduled/requeued jobResultStatus, that cannot be
 * reconstructed once the BullMQ job has been removed.
 */
export function redisTerminalTransition(task: TaskStateData): PersistedTaskTerminalTransition {
    const terminalEntry = task.history?.findLast(entry => entry.state === task.state);
    const originalMetadata = terminalEntry?.metadata ?? {};
    return {
        state: task.state as PersistedTaskTerminalTransition['state'],
        reason: typeof terminalEntry?.reason === 'string' && terminalEntry.reason.trim()
            ? terminalEntry.reason
            : 'Recovered terminal task state from Redis',
        metadata: {
            ...originalMetadata,
            originalFinalizedBy: originalMetadata.finalizedBy ?? null,
            finalizedBy: 'redis_terminal_reconciliation',
            redisUpdatedAt: task.updatedAt,
            redisVersion: task.version ?? null,
        },
    };
}
