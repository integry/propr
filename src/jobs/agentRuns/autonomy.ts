/**
 * What happens to an agent run once its report is stored, by autonomy mode.
 * The mode only decides whether and when the acting step runs; all judgment
 * about what to do lives in that step's agent.
 *
 * - dry_run: the report is the whole result, so the run completes.
 * - preview: the run waits in `awaiting_approval` and its owner is told in the Inbox.
 * - auto: the run moves straight to `acting` and the action phase is enqueued,
 *   unless the cost gate holds an unattended run back: it then waits in
 *   `awaiting_approval` with the reason, so a human can approve it later.
 */

import {
    createAgentRunCostGate,
    createNotificationEvent,
    enqueueAgentRunActionOrFail,
    logger,
    transitionAgentRun,
    type AgentRunGate,
    type StoredAgentRun,
} from '@propr/core';

export interface AdvanceAfterReportDeps {
    transitionRun?: typeof transitionAgentRun;
    /** Enqueues the action phase of an `acting` run, failing the run when that is impossible. */
    startActing?: (run: StoredAgentRun) => Promise<StoredAgentRun>;
    /** Tells the owner a preview report waits for review; best-effort. */
    notifyAwaitingApproval?: (run: StoredAgentRun) => Promise<void>;
    /** Usage gate consulted before an `auto` acting step starts. */
    gate?: AgentRunGate;
}

let defaultGate: AgentRunGate | undefined;

function lowerFirst(text: string): string {
    return text.charAt(0).toLowerCase() + text.slice(1);
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
        gate = defaultGate ??= createAgentRunCostGate(),
    }: AdvanceAfterReportDeps = {},
): Promise<StoredAgentRun | null> {
    const awaitApproval = async (skipReason?: string): Promise<StoredAgentRun | null> => {
        const waiting = await transitionRun(run.id, ['report_ready'], 'awaiting_approval', skipReason ? { skipReason } : {});
        if (waiting) {
            // The run already waits for its owner; a lost Inbox item must not undo that.
            await notifyAwaitingApproval(waiting).catch(error => {
                logger.warn({ runId: run.id, err: error }, 'Could not notify the owner that an agent report awaits approval');
            });
        }
        return waiting;
    };
    switch (run.autonomyMode) {
        case 'dry_run':
            return transitionRun(run.id, ['report_ready'], 'completed');
        case 'preview':
            return awaitApproval();
        case 'auto': {
            // Unattended acting spends tokens with nobody watching; over the usage
            // threshold it waits for a human instead (`manual` runs always proceed).
            const decision = run.definitionSnapshot
                ? await gate({ definition: run.definitionSnapshot, trigger: run.trigger, triggerSource: run.triggerSource, run })
                : null;
            if (decision && decision.action !== 'proceed') {
                logger.info({ runId: run.id, action: decision.action, reason: decision.reason }, 'Agent run acting step paused by the cost gate');
                return awaitApproval(`Acting paused: ${lowerFirst(decision.reason)}`);
            }
            const acting = await transitionRun(run.id, ['report_ready'], 'acting');
            return acting ? startActing(acting) : null;
        }
    }
}
