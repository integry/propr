import type { ReplacementCause } from './policy.js';
import type { TaskReplacementDependencies } from './service.js';
import type { FailureNoticeRecord, LineageAttempt, ReplaceableTask, ReplacementDispatchRecord } from './store.js';

export const REPLACEMENT_JOB_NAME = 'processGitHubIssue';
export const TERMINAL_STATES = new Set(['completed', 'failed', 'cancelled']);

/**
 * The delivery obligation of a claimed replacement: the original's decision stays
 * `pending` until the queue has the job and the replacement was announced.
 */
export interface ReplacementDelivery {
    confirmDispatched(
        task: ReplaceableTask,
        cause: ReplacementCause,
        dispatch: ReplacementDispatchRecord,
        options: { timestamp: string; announceState: string | null },
    ): Promise<void>;
    /** Redelivers (or resolves) a claim an interrupted dispatch left pending. */
    resumeClaimed(originalTaskId: string, cause: ReplacementCause, dispatch: ReplacementDispatchRecord): Promise<boolean>;
    awaitingDelivery(taskId: string): Promise<boolean>;
}

export function createReplacementDelivery(
    deps: TaskReplacementDependencies,
    helpers: {
        now(): Date;
        /**
         * Releases the original's decision as skipped, then records why and publishes its
         * held-back failure; the follow-up stays recoverable until it was delivered.
         */
        releaseSkipped(
            task: ReplaceableTask,
            state: 'skipped',
            fields: Omit<FailureNoticeRecord, 'id' | 'publish' | 'recordedAt'>,
            lineage?: LineageAttempt[],
        ): Promise<void>;
    },
): ReplacementDelivery {
    const { now, releaseSkipped } = helpers;

    /**
     * Records a replacement whose queue delivery is confirmed, announces it, and only
     * then releases the original's pending decision: until then recovery repeats these
     * steps, so the timeline event is recorded once and the announcement is idempotent.
     */
    async function confirmDispatched(
        task: ReplaceableTask,
        cause: ReplacementCause,
        dispatch: ReplacementDispatchRecord,
        { timestamp, announceState }: { timestamp: string; announceState: string | null },
    ): Promise<void> {
        const { replacementTaskId, attemptNumber, remainingBudgetUsd, failure } = dispatch;
        await deps.store.appendEvent({
            taskId: task.taskId, event: 'replacement.dispatched', reason: `Replacement attempt ${attemptNumber} dispatched`, timestamp,
            once: true,
            metadata: {
                cause,
                replacementTaskId,
                attemptNumber,
                maxReplacements: dispatch.maxReplacements,
                ...(task.branchName ? { branch: task.branchName } : {}),
                ...(remainingBudgetUsd === undefined ? {} : { remainingBudgetUsd }),
                ...(failure ? { failure } : {}),
            },
        });
        // The "replacement started" card supersedes the original's held-back failure.
        if (announceState) await deps.publishTaskUpdate?.({
            taskId: replacementTaskId,
            state: announceState,
            repository: task.repository,
            ...(task.issueNumber ? { issueNumber: task.issueNumber } : {}),
            timestamp,
            metadata: { replacesTaskId: task.taskId, attemptNumber, replacementCause: cause, replacementStarted: true },
        });
        await deps.store.setState(task.taskId, 'dispatched');
        deps.logger?.info({ taskId: task.taskId, replacementTaskId, attemptNumber, cause }, 'Dispatched task replacement attempt');
    }

    /**
     * Releases a claim whose replacement only a reconciler ended: nothing shows the
     * queue ever ran it, so the original's held-back failure is published instead.
     */
    async function releaseNotStarted(task: ReplaceableTask, cause: ReplacementCause, dispatch: ReplacementDispatchRecord): Promise<void> {
        await releaseSkipped(task, 'skipped', {
            cause, reason: 'replacement_not_started', replacementTaskId: dispatch.replacementTaskId, attemptNumber: dispatch.attemptNumber,
        });
        deps.logger?.warn({ taskId: task.taskId, replacementTaskId: dispatch.replacementTaskId, cause },
            'Claimed replacement attempt was finalized by reconciliation before it started');
    }

    /**
     * Redelivers a replacement claimed by an interrupted dispatch, under its persisted
     * task and job IDs. Re-adding an existing job ID is a no-op in the queue, so this
     * is safe when the earlier delivery did reach it.
     */
    async function resumeClaimed(originalTaskId: string, cause: ReplacementCause, dispatch: ReplacementDispatchRecord): Promise<boolean> {
        const [task, replacement] = await Promise.all([
            deps.store.loadTask(originalTaskId),
            deps.store.loadTask(dispatch.replacementTaskId),
        ]);
        if (!task || task.replacedByTaskId !== dispatch.replacementTaskId || !replacement) return false;
        const state = replacement.latestState;
        if (state === 'pending') {
            try {
                await deps.enqueue(REPLACEMENT_JOB_NAME, dispatch.jobData, dispatch.jobId);
            } catch (error) {
                // Stays pending; the next sweep retries the same identity.
                deps.logger?.warn({ taskId: task.taskId, replacementTaskId: dispatch.replacementTaskId, error: (error as Error).message },
                    'Failed to redeliver claimed replacement attempt');
                return false;
            }
        } else if (!await deps.store.hasRunTransition(replacement.taskId)) {
            // A reconciler's terminal state is no evidence that the queue received the job.
            await releaseNotStarted(task, cause, dispatch);
            return true;
        }
        // A replacement that progressed past its queued state was delivered; announce it unless it already ended.
        const announceState = state && !TERMINAL_STATES.has(state) ? state : null;
        await confirmDispatched(task, cause, dispatch, { timestamp: now().toISOString(), announceState });
        return true;
    }

    return {
        confirmDispatched,
        resumeClaimed,

        async awaitingDelivery(taskId) {
            const replacement = await deps.store.loadTask(taskId);
            if (!replacement?.replacesTaskId) return false;
            const original = await deps.store.loadTask(replacement.replacesTaskId);
            return original?.replacedByTaskId === taskId
                && original.replacementState === 'pending'
                && original.replacementRequest?.dispatch?.replacementTaskId === taskId;
        },
    };
}
