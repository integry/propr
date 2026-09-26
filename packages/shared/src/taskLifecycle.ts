/**
 * Canonical lifecycle states exposed by the task API.
 *
 * Keep queue-waiting states distinct from worker execution states: operators
 * need to see work that has been accepted but has not started executing yet.
 */
export const TASK_LIFECYCLE_STATES = [
  'pending',
  'queued',
  'processing',
  'claude_execution',
  'post_processing',
  'completed',
  'failed',
  'cancelled',
] as const;

export type TaskLifecycleState = typeof TASK_LIFECYCLE_STATES[number];

/** All non-terminal task states, in lifecycle order. */
export const ACTIVE_TASK_LIFECYCLE_STATES = [
  'pending',
  'queued',
  'processing',
  'claude_execution',
  'post_processing',
] as const satisfies readonly TaskLifecycleState[];

