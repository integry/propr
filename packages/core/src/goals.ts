export type GoalDesiredState = 'running' | 'paused' | 'cancelled';
export type GoalResultState = 'completed' | 'failed' | 'cancelled';

export const GOAL_CONTINUE_INPUT = 'Continue working toward the goal.';

/** The first provider input is intentionally not decorated with ProPR prompts. */
export function buildNativeGoalCommand(objective: string): string {
    return `/goal ${objective}`;
}

export function goalJobId(goalId: string, generation: number): string {
    return `goal-${goalId}-${generation}`;
}

export function buildGoalPolicyEnvironment(options: {
    maxParallelTasks?: number | null;
    ultrafix?: boolean | null;
}): Record<string, string> {
    const environment: Record<string, string> = { PROPR_EXECUTION_MODE: 'goal' };
    if (options.maxParallelTasks != null) {
        environment.PROPR_GOAL_MAX_PARALLEL_TASKS = String(options.maxParallelTasks);
    }
    if (options.ultrafix != null) {
        environment.PROPR_GOAL_ULTRAFIX = options.ultrafix ? 'enabled' : 'disabled';
    }
    return environment;
}
