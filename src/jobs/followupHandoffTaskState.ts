import type { FollowupHandoffRecord } from './followupHandoffStore.js';
import type { HandoffStateManager, HandoffTaskStates, LoggerLike, ResumeOutcome } from './followupHandoffResumeTypes.js';

/** Task-state readings shared by handoff recovery and the automatic release of stuck holds. */

interface TaskStateDeps { stateManager: HandoffStateManager; taskStates: HandoffTaskStates }

/**
 * Whether the attempt behind a handoff is over: completed, failed, cancelled,
 * or with no task state at all. A missing state counts as ended on purpose:
 * the record expired or was purged, so nothing can still be running the
 * attempt, and the handoff's own hold reason stays the evidence of what it
 * was (which is why a cancelled_by_user hold withdraws its claims by reason,
 * not only by task state).
 */
export async function taskAttemptEnded(deps: TaskStateDeps, taskId: string): Promise<boolean> {
    const state = (await deps.stateManager.getTaskState(taskId))?.state;
    const { COMPLETED, FAILED, CANCELLED } = deps.taskStates;
    return !state || [COMPLETED, FAILED, CANCELLED].includes(state);
}

/**
 * A publication_failed attempt whose task is not over has its queue retry
 * scheduled or running: that retry re-implements the request and takes the
 * attempt over once its worktree is gone. Rebuilding and publishing the failed
 * attempt meanwhile would duplicate the retry's work, and overwriting the
 * reason with worktree_lost would hide the attempt from the retry's takeover.
 * Returns the outcome that leaves the record untouched, or null.
 */
export async function pendingRetryHold(record: FollowupHandoffRecord, deps: TaskStateDeps & { log: LoggerLike }): Promise<ResumeOutcome | null> {
    if (record.status_reason !== 'publication_failed') return null;
    const state = (await deps.stateManager.getTaskState(record.task_id))?.state;
    const { COMPLETED, FAILED, CANCELLED } = deps.taskStates;
    if (state === undefined || [COMPLETED, FAILED, CANCELLED].includes(state)) return null;
    deps.log.info({ taskId: record.task_id, repository: record.repository, pullRequest: record.pull_request },
        'A failed follow-up attempt lost its worktree while its retry is pending; leaving it for the retry to take over');
    return { outcome: 'retry_pending' };
}
