export type GoalDesiredState = 'running' | 'paused' | 'cancelled';
export type GoalResultState = 'completed' | 'failed' | 'cancelled';
export const GOAL_LAUNCH_STRATEGIES = ['direct', 'orchestrate'] as const;
export type GoalLaunchStrategy = typeof GOAL_LAUNCH_STRATEGIES[number];

export const GOAL_CONTINUE_INPUT = 'Continue working toward the goal.';
export const CODEX_GOAL_OBJECTIVE_MAX_LENGTH = 4_000;
export const DEFAULT_GOAL_CHECKPOINT_INTERVAL_MINUTES = 15;
export const MIN_GOAL_CHECKPOINT_INTERVAL_MINUTES = 5;
export const MAX_GOAL_CHECKPOINT_INTERVAL_MINUTES = 120;

/** Codex measures goal objectives as Unicode code points, not UTF-16 units. */
export function codexGoalPromptValidationError(prompt: string): string | null {
    return Array.from(prompt).length > CODEX_GOAL_OBJECTIVE_MAX_LENGTH
        ? `Final Codex goal prompt must be at most ${CODEX_GOAL_OBJECTIVE_MAX_LENGTH} Unicode characters`
        : null;
}

const launchInstructions: Record<GoalLaunchStrategy, string> = {
    direct: [
        'Launch strategy — Agent implements directly:',
        'Implement the goal yourself in the prepared worktree. ProPR creates the draft PR before execution and owns all commits and pushes.',
        'Do not run git commit, git push, change branches, rewrite .git metadata, or create another implementation PR.',
        'Finish coherent provider turns as work progresses so ProPR can publish safe checkpoint commits to the draft PR.',
    ].join('\n'),
    orchestrate: [
        'Launch strategy — Agent orchestrates through ProPR:',
        'Drive delivery by deciding the decomposition and hierarchy yourself, creating GitHub issues, and starting and monitoring their implementation through ProPR.',
        'For a large delivery, organize the work into an epic PR and, when useful, sub-epic and issue PRs. You—not a ProPR planner—own every planning and hierarchy decision.',
    ].join('\n'),
};

/** Build the exact first input for the single provider-native goal session. */
export function buildNativeGoalCommand(options: {
    objective: string;
    launchStrategy: GoalLaunchStrategy;
    maxParallelTasks?: number | null;
    ultrafix?: boolean | null;
}): string {
    const parallelPolicy = options.maxParallelTasks == null
        ? 'Concurrency policy: No maximum parallel task count was selected. Decide and manage concurrency yourself; ProPR does not schedule a plan graph.'
        : `Concurrency policy: Run at most ${options.maxParallelTasks} implementation tasks in parallel. Decide what to parallelize and enforce this limit yourself; ProPR does not schedule a plan graph.`;
    const ultrafixPolicy = options.ultrafix
        ? 'Ultrafix policy: Enabled. Run Ultrafix as part of delivery before final completion.'
        : 'Ultrafix policy: Disabled. Do not run Ultrafix unless later steering input explicitly requests it.';
    const deliveryRequirements = options.launchStrategy === 'direct'
        ? [
            '- Finish with validated implementation files; ProPR publishes and validates the final checkpoint on its draft PR.',
            '- Report any GitHub artifact you intentionally create so ProPR can record it.',
        ]
        : [
            '- Finish with a draft PR containing the final implementation.',
            '- Track every GitHub issue and PR you create, validate that each artifact exists and is in the expected state, and report its URL so ProPR can record it.',
            '- Validate the final draft PR and its related artifacts before declaring the goal complete.',
        ];
    return [
        `/goal ${options.objective}`,
        '',
        launchInstructions[options.launchStrategy],
        parallelPolicy,
        ultrafixPolicy,
        'Delivery requirements:',
        ...deliveryRequirements,
    ].join('\n');
}

export function goalJobId(goalId: string, generation: number): string {
    return `goal-${goalId}-${generation}`;
}

export function goalAttemptLabel(generation: number, claimId: string): string {
    return `${generation}:${claimId}`;
}

export function buildGoalPolicyEnvironment(launchStrategy?: GoalLaunchStrategy): Record<string, string> {
    return {
        PROPR_EXECUTION_MODE: 'goal',
        ...(launchStrategy ? { PROPR_GOAL_LAUNCH_STRATEGY: launchStrategy } : {}),
    };
}
