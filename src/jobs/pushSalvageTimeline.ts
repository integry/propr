import { TaskStates } from '@propr/core';
import type { PushSalvageEvent, WorkerStateManager } from '@propr/core';
import type { Logger } from 'pino';

type TimelineStateManager = Pick<WorkerStateManager, 'getTaskState' | 'updateTaskState'>;

/** Records which salvage rung handled a failed push as its own task timeline entry.
 * The entry keeps the task's current state, so the pipeline position is unchanged. */
export function recordPushSalvageEvent(stateManager: TimelineStateManager, taskId: string, log?: Pick<Logger, 'warn'>) {
    return async (event: PushSalvageEvent): Promise<void> => {
        try {
            const current = await stateManager.getTaskState(taskId);
            const terminal: string[] = [TaskStates.COMPLETED, TaskStates.FAILED, TaskStates.CANCELLED];
            if (!current || terminal.includes(current.state)) return;
            await stateManager.updateTaskState(taskId, current.state, {
                reason: event.summary,
                historyMetadata: { pushSalvage: event, description: event.summary },
            });
        } catch (error) {
            log?.warn({ taskId, error: (error as Error).message }, 'Failed to record push salvage timeline event');
        }
    };
}
