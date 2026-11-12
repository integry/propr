import type { IssueJobData } from '@propr/core';
import type { ReplacementCause } from './policy.js';
import type { ReplayJobData, TaskReplacementStore } from './store.js';

/** The escalated selection of a replacement attempt and its timeline event. */
export interface ReplacementEscalation {
    jobData: Pick<IssueJobData, 'agentAlias' | 'modelName' | 'reasoningLevel' | 'implementationEscalation'>;
    event: { reason: string; metadata: Record<string, unknown> };
}

export type EscalateReplacement = (replay: ReplayJobData, cause: ReplacementCause) => Promise<ReplacementEscalation | null>;

/**
 * Moves the replay one step up the escalation ladder in place. An escalation
 * failure never blocks the replacement: it reruns the failed attempt's selection.
 */
export async function escalateReplay(
    escalate: EscalateReplacement | undefined, replay: ReplayJobData, cause: ReplacementCause,
    logger?: { warn(object: Record<string, unknown>, message: string): void },
): Promise<ReplacementEscalation | null> {
    if (!escalate) return null;
    try {
        const escalation = await escalate(replay, cause);
        if (!escalation) return null;
        Object.assign(replay, escalation.jobData);
        if (!escalation.jobData.reasoningLevel) delete replay.reasoningLevel;
        return escalation;
    } catch (error) {
        logger?.warn({ cause, error: (error as Error).message }, 'Could not escalate the replacement; it keeps the failed attempt\'s model and effort');
        return null;
    }
}

/** Records the escalation on the failed attempt, whose timeline shows why its replacement runs higher. */
export async function recordReplacementEscalation(
    store: Pick<TaskReplacementStore, 'appendEvent'>, escalation: ReplacementEscalation | null,
    entry: { taskId: string; replacementTaskId: string; attemptNumber: number; timestamp: string },
): Promise<void> {
    if (!escalation) return;
    await store.appendEvent({
        taskId: entry.taskId, event: 'task.escalation', reason: escalation.event.reason, timestamp: entry.timestamp, once: true,
        metadata: { ...escalation.event.metadata, replacementTaskId: entry.replacementTaskId, attemptNumber: entry.attemptNumber },
    });
}
