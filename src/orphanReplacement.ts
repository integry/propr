import { logger } from '@propr/core';
import type { PersistedTaskTerminalTransition } from './persistedTaskStateStore.js';
import { failedTaskTransition } from './taskReconciliationTransitions.js';
import { abortReason, deadlineWasExhausted, runWithinRemainingBudget } from './taskReconciliationBudget.js';
import type { TaskReplacementService } from './taskReplacement/service.js';

/** Replacement attempts for orphaned tasks (see src/taskReplacement). */
export type OrphanReplacementHandler = Pick<TaskReplacementService, 'prepare' | 'complete' | 'withdraw' | 'awaitingDelivery'>;

export const ORPHANED_TASK_MESSAGE = 'Task was orphaned after worker restart; no BullMQ job or running task container was found';
const ORPHAN_FINALIZER = 'orphan_reconciliation';

export interface OrphanFinalization {
    taskId: string;
    replacement?: OrphanReplacementHandler;
    deadline: number;
    signal: AbortSignal;
    /** Writes the failure; returns whether this run moved the task to it. */
    finalize(transition: PersistedTaskTerminalTransition): Promise<boolean>;
    /** Called when finalization is left to replacement recovery. */
    onDeferred(): void;
    onReplacementError(): void;
}

/**
 * Fails an orphaned task and dispatches its single infrastructure-lost
 * replacement. The decision is made (and durably marked pending, even when no
 * replacement is possible) before the failure is published, so the Inbox holds
 * back the failure alert; a decision interrupted after the failure is completed
 * by the replacement recovery sweep, which records the skip and its notices.
 *
 * A replacement whose queue delivery is unconfirmed may never have reached the
 * queue: it is left to replacement recovery, which owns its delivery obligation.
 */
export async function finalizeOrphan(input: OrphanFinalization): Promise<void> {
    const { taskId, replacement, deadline, signal } = input;
    if (replacement && await runWithinRemainingBudget(() => replacement.awaitingDelivery(taskId), deadline, signal)) {
        logger.info({ taskId }, 'Deferred orphaned replacement attempt until its queue delivery is resolved');
        input.onDeferred();
        return;
    }
    // Binds the decision to this run's failure: recovery never completes it after another writer's failure.
    const request = { taskId, cause: 'infra_lost' as const, error: ORPHANED_TASK_MESSAGE, finalizedBy: ORPHAN_FINALIZER };
    let plan: Awaited<ReturnType<OrphanReplacementHandler['prepare']>> | null = null;
    try {
        if (replacement) plan = await runWithinRemainingBudget(() => replacement.prepare(request), deadline, signal);
    } catch (error) {
        if (deadlineWasExhausted(error, signal) || signal.aborted) throw error;
        // The orphan is still failed; the replacement is decided again after finalization.
        logger.warn({ taskId, error: (error as Error).message }, 'Failed to prepare replacement for orphaned task');
    }
    const transition = failedTaskTransition(ORPHANED_TASK_MESSAGE, ORPHAN_FINALIZER);
    if (plan?.eligible) transition.metadata.replacement = 'pending';
    const finalized = await input.finalize(transition);
    // Another writer's failure pre-empted this one: withdraw its decision, eligible or not (recovery does if this fails).
    const pending = !finalized && plan && (plan.eligible || plan.reason !== null) ? plan.request : undefined;
    if (!replacement || (!finalized && !pending)) return;
    try {
        if (pending) {
            await runWithinRemainingBudget(() => replacement.withdraw(taskId, pending), deadline, signal);
            return;
        }
        const outcome = await runWithinRemainingBudget(() => replacement.complete(request), deadline, signal);
        logger.info({ taskId, outcome }, 'Handled replacement for orphaned task');
    } catch (error) {
        if (signal.aborted && !deadlineWasExhausted(error, signal)) throw abortReason(signal);
        logger.error({ taskId, error: (error as Error).message }, 'Failed to handle orphan replacement; recovery will retry it');
        input.onReplacementError();
    }
}
