/**
 * Per-agent capacity for goal attempts. A claimed attempt cannot be handed back
 * to the queue, so the goal's direct agent is checked before
 * `claimGoalAttempt`: when it is at its ceiling the job is delayed (goal jobs
 * run with `attempts: 1`, and a deferral consumes none) and holds no claim
 * while it waits. Paused or cancelled goals are fenced out by the claim on
 * re-entry, as before.
 */
import type { Job } from 'bullmq';
import type { GoalJobData } from '@propr/core';
import { admitAgentCapacity, checkJobAgentCapacity, isAgentCapacityRefusal, persistAgentCapacityDeferral } from './agentCapacityDeferral.js';
import { fencedGoal } from './goalAttemptState.js';

export async function checkGoalAgentCapacity(job: Job<GoalJobData>): Promise<void> {
    if (!process.env.PROPR_AGENT_RUN_ALIAS_LIMITS?.trim()) return;
    const core = await import('@propr/core');
    if (!core.agentCapacityPolicyConfigured()) return;
    const goal = await fencedGoal(job.data);
    if (!goal) return; // The claim fence decides what happens to a superseded attempt.
    const registry = core.AgentRegistry.getInstance();
    await registry.ensureInitialized();
    const agent = registry.getAgentById(goal.agent_id) || registry.getAgentByAlias(goal.agent_alias);
    if (!agent) return; // Preparation reports a missing agent after the claim, as before.
    try {
        await checkJobAgentCapacity(job, [{ agentAlias: agent.config.alias }], { registry });
        await admitAgentCapacity(job);
    } catch (error) {
        if (!isAgentCapacityRefusal(error)) return;
        await persistAgentCapacityDeferral({
            job, error, taskId: job.data.taskId, stateManager: core.getStateManager(), correlatedLogger: core.logger.withCorrelation(job.data.goalId),
        });
        throw error;
    }
}
