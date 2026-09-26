import {
    ACTIVITY_UPDATE,
    type ActivityChange,
    type ActivityUpdatePayload,
    type DraftUpdatePayload,
    type IndexingUpdatePayload,
    type QueueStatsUpdatePayload,
    type TaskUpdatePayload,
} from '@propr/shared';

/**
 * Derives the general activity envelope from the lifecycle events the backend
 * already publishes.
 *
 * Consumers declare an interest (`domain`, and optionally `change`) instead of
 * matching worker state strings, so a surface does not have to learn every
 * producer's vocabulary - and a new producer does not have to touch every
 * surface that reacts to it. The envelope deliberately carries no projection:
 * it says what changed, and each surface re-reads its own endpoint, which stays
 * the single owner of its permission check.
 */

const TERMINAL_TASK_CHANGES: Record<string, ActivityChange> = {
    completed: 'completed',
    failed: 'failed',
    cancelled: 'cancelled',
};

function taskChange(state: string): ActivityChange {
    const normalized = state.toLowerCase();
    const terminal = TERMINAL_TASK_CHANGES[normalized];
    if (terminal) return terminal;
    if (normalized === 'pending' || normalized === 'queued') return 'created';
    return 'started';
}

export function activityFromTaskUpdate(payload: TaskUpdatePayload): ActivityUpdatePayload {
    const change = taskChange(payload.state);
    return {
        eventType: ACTIVITY_UPDATE,
        domain: 'task',
        change,
        repository: payload.repository,
        subjectId: payload.taskId,
        terminal: Object.values(TERMINAL_TASK_CHANGES).includes(change),
        occurredAt: payload.timestamp,
    };
}

export function activityFromDraftUpdate(payload: DraftUpdatePayload): ActivityUpdatePayload | null {
    // Only a status transition changes what the plan surfaces show; the
    // per-step progress of a generation run is published on its own event.
    if (!payload.draftStatus) return null;
    const change: ActivityChange = payload.draftStatus === 'failed'
        ? 'failed'
        : payload.draftStatus === 'merged'
            ? 'completed'
            : payload.draftStatus === 'draft' || payload.draftStatus === 'generating'
                ? 'created'
                : 'updated';
    return {
        eventType: ACTIVITY_UPDATE,
        domain: 'plan',
        change,
        subjectId: payload.draftId,
        terminal: change === 'completed' || change === 'failed',
        occurredAt: payload.timestamp,
    };
}

export function activityFromIndexingUpdate(payload: IndexingUpdatePayload): ActivityUpdatePayload {
    // Per-file and per-directory counters are `progress`, so a consumer that
    // only cares whether indexing is running can ignore the churn and still be
    // told when a run starts, finishes or fails.
    const change: ActivityChange = payload.phase === 'completed'
        ? 'completed'
        : payload.phase === 'failed'
            ? 'failed'
            : payload.phase === 'files' || payload.phase === 'directories'
                ? 'progress'
                : 'started';
    return {
        eventType: ACTIVITY_UPDATE,
        domain: 'indexing',
        change,
        repository: payload.repository,
        terminal: change === 'completed' || change === 'failed',
        occurredAt: payload.timestamp,
    };
}

export function activityFromQueueStatsUpdate(payload: QueueStatsUpdatePayload): ActivityUpdatePayload {
    return {
        eventType: ACTIVITY_UPDATE,
        domain: 'queue',
        change: 'updated',
        terminal: false,
        occurredAt: payload.timestamp,
    };
}

/**
 * Instance health moved.
 *
 * No run lifecycle event says that a worker or the daemon stopped, Redis went
 * away or an agent stopped answering, so the health surfaces cannot be kept
 * fresh by deriving this from the events above: it is published by
 * `systemHealthWatcher`, which compares the status snapshot itself. The
 * envelope carries no subject, so a consumer that suppresses repeats per
 * subject still reacts to every health change.
 */
export function activityFromHealthChange(occurredAt: string): ActivityUpdatePayload {
    return {
        eventType: ACTIVITY_UPDATE,
        domain: 'health',
        change: 'updated',
        terminal: false,
        occurredAt,
    };
}
