import type { Knex } from 'knex';
import type { GoalJobData } from '@propr/core';
import { GOAL_CONTINUE_INPUT, db, executeDockerCommand, getIssueQueue, goalJobId, logger } from '@propr/core';

interface RecoverableGoal {
    goal_id: string;
    current_task_id: string;
    repository: string;
    objective: string;
    worktree_path: string | null;
    session_id: string | null;
    started_at: string | null;
    run_generation: number;
}

interface RecoveryJob {
    getState?(): Promise<string>;
    remove?(): Promise<unknown>;
}

export interface GoalRecoveryQueue {
    getJob(id: string): Promise<RecoveryJob | undefined | null>;
    add(name: string, data: GoalJobData, options: { jobId: string }): Promise<unknown>;
}

async function isRunningGoalContainer(taskId: string): Promise<boolean> {
    try {
        const result = await executeDockerCommand('docker', [
            'ps', '--filter', `label=propr.task.id=${taskId}`, '--format', '{{.ID}}',
        ], { timeout: 10_000 });
        // An unavailable Docker daemon cannot prove the execution is dead. Be
        // conservative to preserve duplicate-execution fencing.
        return result.exitCode !== 0 || result.stdout.trim().length > 0;
    } catch (error) {
        logger.warn({ taskId, error: (error as Error).message }, 'Could not inspect goal container liveness; skipping recovery');
        return true;
    }
}

export async function recoverNonterminalGoals(options: {
    database?: Knex;
    queue?: GoalRecoveryQueue;
    isTaskContainerLive?: (taskId: string) => Promise<boolean>;
} = {}): Promise<{ recovered: number; skippedWithoutSession: number }> {
    const database = options.database ?? db;
    const queue = options.queue ?? await getIssueQueue() as unknown as GoalRecoveryQueue;
    const isTaskContainerLive = options.isTaskContainerLive ?? isRunningGoalContainer;
    const goals = await database('goals')
        .where({ desired_state: 'running' })
        .whereNull('result_state') as RecoverableGoal[];
    let recovered = 0;
    let skippedWithoutSession = 0;

    for (const goal of goals) {
        const id = goalJobId(goal.goal_id, goal.run_generation);
        const existing = await queue.getJob(id);
        const existingState = await existing?.getState?.();
        if (existing && existingState && !['completed', 'failed'].includes(existingState)) continue;
        if (await isTaskContainerLive(goal.current_task_id)) continue;

        // Once a worktree has been allocated, recovery is only allowed after the
        // provider identity was durably observed by the early-session callback.
        if (goal.started_at && !goal.session_id) {
            skippedWithoutSession++;
            logger.warn({ goalId: goal.goal_id }, 'Skipped goal crash recovery because no provider session was persisted');
            continue;
        }

        if (existing && ['completed', 'failed'].includes(existingState || '') && existing.remove) {
            await existing.remove();
        }
        const [repoOwner, repoName] = goal.repository.split('/');
        await queue.add('processGoal', {
            goalId: goal.goal_id,
            taskId: goal.current_task_id,
            repoOwner,
            repoName,
            generation: goal.run_generation,
            input: goal.session_id ? GOAL_CONTINUE_INPUT : `/goal ${goal.objective}`,
            recovery: Boolean(goal.session_id),
        }, { jobId: id });
        recovered++;
    }
    return { recovered, skippedWithoutSession };
}
