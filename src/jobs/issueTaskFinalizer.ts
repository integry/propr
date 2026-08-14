import {
    TaskStates,
    taskStateExpectation,
    type TaskStateData,
    type WorkerStateManager,
} from '@propr/core';
import { sanitizeErrorMessage } from './errorSanitizer.js';

type IssueTaskStateStore = Pick<
    WorkerStateManager,
    'getTaskState' | 'updateTaskStateIfCurrentDetailed'
>;

export async function finalizeSkippedIssueTask(
    taskId: string,
    reason: unknown,
    stateManager: IssueTaskStateStore,
    expectedState: TaskStateData,
): Promise<'cancelled' | 'unchanged'> {
    const terminalStates = new Set<string>([TaskStates.COMPLETED, TaskStates.FAILED, TaskStates.CANCELLED]);
    if (terminalStates.has(expectedState.state)) {
        return 'unchanged';
    }
    const safeReason = sanitizeErrorMessage(
        typeof reason === 'string' && reason.trim() ? reason : 'Issue no longer qualifies for processing',
    );
    const updated = await stateManager.updateTaskStateIfCurrentDetailed(
        taskId,
        taskStateExpectation(expectedState),
        TaskStates.CANCELLED,
        {
            reason: `Issue processing skipped: ${safeReason}`,
            historyMetadata: {
                cancelledBy: 'label_guard',
                skipReason: safeReason,
            },
        },
    );
    if (updated) return 'cancelled';

    // A retry or concurrent completion won the compare-and-set. Observing it is
    // enough: never overwrite a newer or terminal attempt.
    await stateManager.getTaskState(taskId);
    return 'unchanged';
}
