/**
 * Per-agent capacity for merge-conflict resolution. The job holds the PR lock
 * and has created its task row, but has posted nothing yet: a default agent at
 * its ceiling defers the job here, and the lock is released while it waits.
 */
import type { Job } from 'bullmq';
import type { Logger } from 'pino';
import { AgentRegistry, type AgentCapacityJobContext, type MergeConflictJobData, type WorkerStateManager } from '@propr/core';
import { admitAgentCapacity, checkJobAgentCapacity, isAgentCapacityRefusal, persistAgentCapacityDeferral } from './agentCapacityDeferral.js';
import { resolveDefaultAgentAndModel } from './prCommentAgentUtils.js';

export async function checkMergeConflictAgentCapacity(job: Job<MergeConflictJobData>, options: {
    taskId: string; stateManager: WorkerStateManager; correlatedLogger: Logger;
}): Promise<AgentCapacityJobContext | undefined> {
    let request: { agentAlias: string; model: string };
    try {
        const registry = AgentRegistry.getInstance();
        await registry.ensureInitialized();
        const { resolvedAlias, resolvedModel } = await resolveDefaultAgentAndModel(registry, options.correlatedLogger);
        request = { agentAlias: resolvedAlias, model: resolvedModel };
    } catch {
        return undefined; // The resolver step reports an unusable default agent, as before.
    }
    try {
        const context = await checkJobAgentCapacity(job, [request]);
        await admitAgentCapacity(job);
        return context;
    } catch (error) {
        if (!isAgentCapacityRefusal(error)) return undefined;
        await persistAgentCapacityDeferral({ job, error, ...options });
        throw error;
    }
}
