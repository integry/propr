import {
    TaskStates,
    type TaskState,
    type TaskStateData,
    type UpdateMetadata,
} from './workerStateManager.types.js';

export const MAX_ATOMIC_UPDATE_ATTEMPTS = 8;
export const TERMINAL_TASK_STATES = new Set<TaskState>([
    TaskStates.COMPLETED,
    TaskStates.FAILED,
    TaskStates.CANCELLED,
]);

export async function waitForAtomicUpdateRetry(attempt: number): Promise<void> {
    const delayMs = Math.min(5 * (2 ** attempt), 100);
    await new Promise(resolve => setTimeout(resolve, delayMs));
}

export interface AutomaticRetryAttempt {
    jobId: string | undefined;
    attemptsMade: number;
    totalAttempts: number | undefined;
}

export interface TerminalAutomaticRetryResult {
    status: string;
    reason: string;
}

type TaskStateUpdater = (
    taskId: string,
    newState: TaskState,
    metadata?: UpdateMetadata,
) => Promise<TaskStateData>;

async function resumeFailedTaskForAutomaticRetry(
    taskId: string,
    state: TaskStateData,
    attempt: AutomaticRetryAttempt,
    updateTaskState: TaskStateUpdater,
): Promise<TaskStateData> {
    const totalAttempts = attempt.totalAttempts ?? 1;
    const isRemainingExactJobAttempt = state.state === TaskStates.FAILED
        && attempt.attemptsMade > 0
        && attempt.attemptsMade < totalAttempts
        && attempt.jobId !== undefined
        && state.issueRef.jobId !== undefined
        && String(state.issueRef.jobId) === String(attempt.jobId);
    if (!isRemainingExactJobAttempt) return state;
    return await updateTaskState(taskId, TaskStates.PROCESSING, {
        reason: 'Retrying task after a failed BullMQ attempt',
        isRetry: true,
    });
}

/**
 * Reopen a failed task only for a remaining attempt of the exact BullMQ job,
 * then return the stable result for any task that remains terminal.
 */
export async function getTerminalJobResultForAutomaticRetry(
    taskId: string,
    state: TaskStateData,
    attempt: AutomaticRetryAttempt,
    updateTaskState: TaskStateUpdater,
): Promise<TerminalAutomaticRetryResult | undefined> {
    const initialState = await resumeFailedTaskForAutomaticRetry(taskId, state, attempt, updateTaskState);
    if (initialState.state === TaskStates.COMPLETED) {
        return { status: 'complete', reason: 'task_already_completed' };
    }
    if (initialState.state === TaskStates.CANCELLED) {
        return { status: 'cancelled', reason: 'task_already_cancelled' };
    }
    if (initialState.state === TaskStates.FAILED) {
        return { status: 'failed', reason: 'task_already_failed' };
    }
    return undefined;
}
