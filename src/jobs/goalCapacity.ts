/**
 * Per-agent capacity for goal attempts. A claimed attempt cannot be handed back
 * to the queue, so the goal's direct agent is checked before
 * `claimGoalAttempt`: when it is at its ceiling the job is delayed (goal jobs
 * run with `attempts: 1`, and a deferral consumes none) and holds no claim
 * while it waits. A delivery the claim would reject (a superseded attempt, a
 * paused or cancelled goal, an attempt already claimed) skips the check and
 * leaves its waiting lists, so the claim fence retires it at once instead of a
 * saturated agent delaying it again.
 */
import type { Job } from 'bullmq';
import type { GoalJobData } from '@propr/core';
import { admitAgentCapacity, checkJobAgentCapacity, isAgentCapacityRefusal, persistAgentCapacityDeferral } from './agentCapacityDeferral.js';
import { fencedGoal, type GoalRow } from './goalAttemptState.js';

/** The claim's own guards (`claimGoalAttempt`), beyond the attempt identity `fencedGoal` already matched. */
function claimable(goal: GoalRow | null): goal is GoalRow {
    return Boolean(goal && goal.desired_state === 'running' && !goal.claimed_at);
}

export async function checkGoalAgentCapacity(job: Job<GoalJobData>): Promise<void> {
    if (!process.env.PROPR_AGENT_RUN_ALIAS_LIMITS?.trim()) return;
    const core = await import('@propr/core');
    if (!core.agentCapacityPolicyConfigured()) return;
    const goal = await fencedGoal(job.data);
    if (!claimable(goal)) {
        // The claim fence decides what happens to this delivery; it no longer waits for capacity.
        await admitAgentCapacity(job);
        return;
    }
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
