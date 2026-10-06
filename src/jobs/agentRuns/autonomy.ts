/**
 * What happens to an agent run once its report is stored, by autonomy mode.
 * The mode only decides whether and when the acting step runs; all judgment
 * about what to do lives in that step's agent.
 *
 * - dry_run: the report is the whole result, so the run completes.
 * - preview: the run waits in `awaiting_approval` and its owner is told in the Inbox.
 * - auto: the run moves straight to `acting` and the action phase is enqueued.
 */

import {
    createNotificationEvent,
    enqueueAgentRunActionOrFail,
    logger,
    transitionAgentRun,
    type StoredAgentRun,
} from '@propr/core';

export interface AdvanceAfterReportDeps {
    transitionRun?: typeof transitionAgentRun;
    /** Enqueues the action phase of an `acting` run, failing the run when that is impossible. */
    startActing?: (run: StoredAgentRun) => Promise<StoredAgentRun>;
    /** Tells the owner a preview report waits for review; best-effort. */
    notifyAwaitingApproval?: (run: StoredAgentRun) => Promise<void>;
}

const REPOSITORY_PATTERN = /^[^/\s]+\/[^/\s]+$/;

/** Inbox item for a preview report. Agents without repositories have no task target, so they get none. */
export async function notifyAgentReportAwaitingApproval(
    run: StoredAgentRun,
    { createEvent = createNotificationEvent }: { createEvent?: typeof createNotificationEvent } = {},
): Promise<void> {
    const name = run.definitionSnapshot?.name ?? 'Agent';
    const repository = run.definitionSnapshot?.repositories[0];
    if (!repository || !REPOSITORY_PATTERN.test(repository) || !run.reportTaskId) {
        logger.info({ runId: run.id }, 'Agent run report awaits approval; no repository task to notify about');
        return;
    }
    await createEvent({
        deduplicationKey: `agent-run-awaiting-approval:${run.id}`,
        kind: 'task',
        severity: 'info',
        target: { type: 'task', repository, taskId: run.reportTaskId },
        title: `Agent ${name} report ready for review`,
        body: 'Read the report, then approve the acting step or reject it.',
        metadata: { event: 'agent_run.awaiting_approval', agentRunId: run.id, agentDefinitionId: run.definitionId },
    }, [{ userId: run.ownerId, pushEnabled: true }]);
}

/**
 * Move a `report_ready` run to its next state. Returns the updated run, or
 * null when the run was no longer `report_ready` (another process got there first).
 */
export async function advanceAfterReport(
    run: StoredAgentRun,
    {
        transitionRun = transitionAgentRun,
        startActing = acting => enqueueAgentRunActionOrFail(acting),
        notifyAwaitingApproval = notifyAgentReportAwaitingApproval,
    }: AdvanceAfterReportDeps = {},
): Promise<StoredAgentRun | null> {
    switch (run.autonomyMode) {
        case 'dry_run':
            return transitionRun(run.id, ['report_ready'], 'completed');
        case 'preview': {
            const waiting = await transitionRun(run.id, ['report_ready'], 'awaiting_approval');
            if (waiting) {
                // The run already waits for its owner; a lost Inbox item must not undo that.
                await notifyAwaitingApproval(waiting).catch(error => {
                    logger.warn({ runId: run.id, err: error }, 'Could not notify the owner that an agent report awaits approval');
                });
            }
            return waiting;
        }
        case 'auto': {
            const acting = await transitionRun(run.id, ['report_ready'], 'acting');
            return acting ? startActing(acting) : null;
        }
    }
}
