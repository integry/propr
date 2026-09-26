const PULL_REQUEST_TASK_TYPES = new Set(['pr-comment', 'review', 'merge_conflict']);

/**
 * Whether a persisted task acts on a pull request whose number lives in the
 * task's issue_number column.
 *
 * Historical PR-comment tasks were persisted as type "issue" before the worker
 * began storing their explicit task type, so their ID prefix is the only
 * durable signal left for those rows.
 */
export function isPullRequestTask(task: { task_id: unknown; task_type: unknown }): boolean {
  const taskId = String(task.task_id ?? '');
  return PULL_REQUEST_TASK_TYPES.has(String(task.task_type))
    || taskId.startsWith('pr-comment-')
    || taskId.startsWith('pr-comments-');
}
