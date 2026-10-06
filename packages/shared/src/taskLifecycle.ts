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

/** User-facing explanations; unknown internal codes must never reach the UI. */
export function formatTaskTerminalReason(reason: string): string {
  switch (reason) {
    case 'cancelled_issue_closed': return 'Cancelled because the issue was closed.';
    case 'cancelled_label_removed': return 'Cancelled because the processing trigger label was removed.';
    case 'cancelled_pr_closed': return 'Cancelled because the pull request was closed without merging.';
    // `user_cancelled` is the legacy job-result code for the same stop.
    case 'cancelled_by_user': case 'user_cancelled': return 'Cancelled by a user.';
    case 'timed_out': return 'The task exceeded its time limit.';
    case 'cost_cap_exceeded': return 'The run was stopped because it reached its spend cap.';
    case 'pr_merged': return 'The pull request was merged.';
    default: return 'The task ended.';
  }
}

/** All non-terminal task states, in lifecycle order. */
export const ACTIVE_TASK_LIFECYCLE_STATES = [
  'pending',
  'queued',
  'processing',
  'claude_execution',
  'post_processing',
] as const satisfies readonly TaskLifecycleState[];

