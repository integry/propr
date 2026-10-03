/**
 * Authoritative goal creation contract shared by the REST API, MCP, web UI
 * and CLI. Every surface that starts a goal validates against these values so
 * accepted options cannot drift between entry points.
 */

export const GOAL_LAUNCH_STRATEGIES = ['direct', 'orchestrate'] as const;
export type GoalLaunchStrategy = typeof GOAL_LAUNCH_STRATEGIES[number];

export const GOAL_REPOSITORY_PATTERN = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
export const GOAL_OBJECTIVE_MAX_LENGTH = 65_536;
export const GOAL_BASE_BRANCH_MAX_LENGTH = 255;

/** Inclusive bounds for the agent-enforced parallel implementation task limit. */
export const MIN_GOAL_PARALLEL_TASKS = 1;
export const MAX_GOAL_PARALLEL_TASKS = 32;

/** Direct goals target a checkpoint cadence; orchestrated goals reject one. */
export const DEFAULT_GOAL_CHECKPOINT_INTERVAL_MINUTES = 15;
export const MIN_GOAL_CHECKPOINT_INTERVAL_MINUTES = 5;
export const MAX_GOAL_CHECKPOINT_INTERVAL_MINUTES = 120;

/** Machine-readable description of creation options for capability discovery. */
export const GOAL_CREATION_CONTRACT = {
  startsWork: true,
  launchStrategies: GOAL_LAUNCH_STRATEGIES,
  objectiveMaxCharacters: GOAL_OBJECTIVE_MAX_LENGTH,
  baseBranchMaxCharacters: GOAL_BASE_BRANCH_MAX_LENGTH,
  maxParallelTasks: { min: MIN_GOAL_PARALLEL_TASKS, max: MAX_GOAL_PARALLEL_TASKS },
  checkpointIntervalMinutes: {
    min: MIN_GOAL_CHECKPOINT_INTERVAL_MINUTES,
    max: MAX_GOAL_CHECKPOINT_INTERVAL_MINUTES,
    default: DEFAULT_GOAL_CHECKPOINT_INTERVAL_MINUTES,
    launchStrategies: ['direct'],
  },
  ultrafix: { supported: true, default: false, grantsMerge: false },
  delivery: 'draft-pull-request',
} as const;

function isIntegerInRange(value: unknown, min: number, max: number): boolean {
  return Number.isSafeInteger(value) && Number(value) >= min && Number(value) <= max;
}

export function isValidGoalParallelTasks(value: unknown): value is number {
  return isIntegerInRange(value, MIN_GOAL_PARALLEL_TASKS, MAX_GOAL_PARALLEL_TASKS);
}

export function isValidGoalCheckpointInterval(value: unknown): value is number {
  return isIntegerInRange(value, MIN_GOAL_CHECKPOINT_INTERVAL_MINUTES, MAX_GOAL_CHECKPOINT_INTERVAL_MINUTES);
}

/**
 * Validate goal creation fields. Returns a user-facing error, or null when the
 * request satisfies the contract. Agent/model support is checked separately
 * against the live goal capabilities.
 */
export function validateGoalCreationOptions(body: Record<string, unknown>): string | null {
  if (typeof body.repository !== 'string' || !GOAL_REPOSITORY_PATTERN.test(body.repository)) return 'repository must be in owner/repo format';
  if (typeof body.objective !== 'string' || body.objective.trim().length < 1 || body.objective.length > GOAL_OBJECTIVE_MAX_LENGTH) return 'objective is required';
  if (!GOAL_LAUNCH_STRATEGIES.includes(body.launchStrategy as GoalLaunchStrategy)) return 'launchStrategy must be direct or orchestrate';
  if (typeof body.agentId !== 'string' || !body.agentId) return 'agentId is required';
  if (typeof body.model !== 'string' || !body.model) return 'model is required';
  if (body.baseBranch != null && (typeof body.baseBranch !== 'string' || body.baseBranch.length > GOAL_BASE_BRANCH_MAX_LENGTH)) return 'baseBranch is invalid';
  if (body.maxParallelTasks != null && !isValidGoalParallelTasks(body.maxParallelTasks)) {
    return `maxParallelTasks must be an integer from ${MIN_GOAL_PARALLEL_TASKS} to ${MAX_GOAL_PARALLEL_TASKS}`;
  }
  if (body.ultrafix != null && typeof body.ultrafix !== 'boolean') return 'ultrafix must be a boolean';
  return validateGoalCheckpointInterval(body);
}

export function validateGoalCheckpointInterval(body: Record<string, unknown>): string | null {
  if (body.checkpointIntervalMinutes == null) return null;
  if (body.launchStrategy !== 'direct') return 'checkpointIntervalMinutes only applies to direct goals';
  if (!isValidGoalCheckpointInterval(body.checkpointIntervalMinutes)) {
    return `checkpointIntervalMinutes must be an integer from ${MIN_GOAL_CHECKPOINT_INTERVAL_MINUTES} to ${MAX_GOAL_CHECKPOINT_INTERVAL_MINUTES}`;
  }
  return null;
}
