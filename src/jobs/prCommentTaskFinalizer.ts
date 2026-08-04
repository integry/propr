import type { JobResult, TaskState, WorkerStateManager } from '@propr/core';
import { TaskStates } from '@propr/core';

type TaskStateStore = Pick<WorkerStateManager, 'getTaskState' | 'updateTaskState'>;

const TERMINAL_STATES: ReadonlySet<TaskState> = new Set([
    TaskStates.COMPLETED,
    TaskStates.FAILED,
    TaskStates.CANCELLED,
]);

export function isTerminalTaskState(state: TaskState): boolean {
    return TERMINAL_STATES.has(state);
}

function resultReason(result: JobResult): string | undefined {
    return typeof result.reason === 'string' && result.reason.trim() ? result.reason : undefined;
}

/**
 * Makes a BullMQ PR-comment result visible in the persistent task state.
 *
 * Processors still update their detailed states while they work. This finalizer
 * covers early-return paths and acts as an idempotent safety net from the
 * worker's `completed` event.
 */
export async function finalizePRCommentTaskResult(
    taskId: string,
    stateManager: TaskStateStore,
    result: JobResult,
): Promise<boolean> {
    const task = await stateManager.getTaskState(taskId);
    if (!task || isTerminalTaskState(task.state)) return false;

    const reason = resultReason(result);
    const historyMetadata = {
        outcome: result.status,
        resultReason: reason ?? null,
        pullRequestNumber: typeof result.pullRequestNumber === 'number' ? result.pullRequestNumber : null,
    };

    if (result.status === 'cancelled') {
        await stateManager.updateTaskState(taskId, TaskStates.CANCELLED, {
            reason: reason ? `Task cancelled: ${reason}` : 'Task cancelled',
            historyMetadata,
        });
        return true;
    }

    if (result.status === 'rescheduled' || result.status === 'requeued') {
        await stateManager.updateTaskState(taskId, TaskStates.CANCELLED, {
            reason: reason
                ? `Task attempt ${result.status}: ${reason}`
                : `Task attempt ${result.status}`,
            historyMetadata: { ...historyMetadata, superseded: true },
        });
        return true;
    }

    await stateManager.updateTaskState(taskId, TaskStates.COMPLETED, {
        reason: result.status === 'skipped'
            ? `Task skipped: ${reason ?? 'no work required'}`
            : reason ?? `Task finished with outcome: ${result.status}`,
        historyMetadata,
        commitHash: typeof result.commit === 'string' ? result.commit : undefined,
    });
    return true;
}

/** Marks a failed BullMQ attempt terminal if the processor did not already do so. */
export async function finalizePRCommentTaskFailure(
    taskId: string,
    stateManager: TaskStateStore,
    error: Error,
): Promise<boolean> {
    const task = await stateManager.getTaskState(taskId);
    if (!task || isTerminalTaskState(task.state)) return false;

    await stateManager.updateTaskState(taskId, TaskStates.FAILED, {
        reason: `Worker job failed: ${error.message}`,
        error: { message: error.message, category: 'worker' },
        historyMetadata: { outcome: 'failed' },
    });
    return true;
}
