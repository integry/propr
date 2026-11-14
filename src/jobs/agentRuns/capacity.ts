/**
 * Per-agent capacity for automation report and action runs. Both claim their
 * run (`queued → running`, or the action task on an `acting` run) before they
 * execute, and a claimed run cannot be handed back to the queue, so the
 * direct agent's ceiling is checked before the claim. A saturated agent defers
 * the job: the run stays unclaimed, the worker is released, and the job is
 * woken when the alias frees up (or by its backoff timer).
 */
import type { Job } from 'bullmq';
import type { Logger } from 'pino';
import type { AgentCapacityJobContext, AgentRunJobData, StoredAgentDefinition, WorkerStateManager } from '@propr/core';
import { admitAgentCapacity, checkJobAgentCapacity, isAgentCapacityRefusal, persistAgentCapacityDeferral } from '../agentCapacityDeferral.js';

/** Checks the resolved agent's ceiling; throws AgentCapacityError when it is full. */
export type AgentRunCapacityCheck = (job: Job<AgentRunJobData>, agent: { alias: string; model?: string }) => Promise<AgentCapacityJobContext | undefined>;

export const checkAgentRunCapacity: AgentRunCapacityCheck = async (job, { alias, model }) => {
    const context = await checkJobAgentCapacity(job, [{ agentAlias: alias, model }]);
    await admitAgentCapacity(job);
    return context;
};

/**
 * Runs before the claim. A saturated agent persists the deferral (timeline row
 * on the run's task, waiting-list entry) and rethrows the refusal for
 * `deferCapacityJob`. Anything else (an unknown agent, an exhausted synthetic
 * pool) is left to the existing post-claim path, which fails the run visibly.
 */
export async function checkAgentRunCapacityBeforeClaim(options: {
    job: Job<AgentRunJobData>; definition: StoredAgentDefinition; taskId: string; log: Logger;
    resolveAgent: (definition: StoredAgentDefinition, log: Logger) => Promise<{ alias: string; model?: string }>;
    check: AgentRunCapacityCheck;
    stateManager: unknown;
}): Promise<AgentCapacityJobContext | undefined> {
    const { job, definition, log } = options;
    let resolved: { alias: string; model?: string };
    try {
        resolved = await options.resolveAgent(definition, log);
    } catch {
        return undefined;
    }
    try {
        return await options.check(job, resolved);
    } catch (error) {
        if (!isAgentCapacityRefusal(error)) return undefined;
        await persistAgentCapacityDeferral({
            job, error, taskId: options.taskId, correlatedLogger: log,
            stateManager: options.stateManager as Pick<WorkerStateManager, 'getTaskState' | 'updateHistoryMetadata' | 'updateTaskStateIfCurrent'>,
        });
        throw error;
    }
}
