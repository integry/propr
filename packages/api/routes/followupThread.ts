import type { Knex } from 'knex';
import { isPullRequestTask } from './pullRequestTaskIdentity.js';

export interface FollowupTaskRecord {
  task_id: string;
  repository: string;
  issue_number: number;
  pr_number?: number | null;
  task_type: string;
}

/** The GitHub thread a plain follow-up on a task is posted to, as the task history reports it. */
export interface FollowupDestination {
  /** The task ID the destination was resolved for; a follow-up submitted for another ID may go elsewhere. */
  taskId: string;
  repository: string;
  kind: 'pull_request' | 'issue';
  number: number;
}

/**
 * Whether a follow-up continues work on a pull request. Without an explicit
 * target, a task that created a PR is followed up there; an implementation
 * task that never produced one is retried on its issue.
 */
export function followupTargetsPullRequest(task: FollowupTaskRecord, targetsPullRequest: boolean): boolean {
  return targetsPullRequest || Boolean(task.pr_number) || isPullRequestTask(task);
}

/**
 * Resolves the GitHub thread a follow-up comment is posted to. PR commands go
 * to the task's pull request; implementation tasks keep their source issue in
 * issue_number and the created PR in pr_number.
 */
export function resolveFollowupThread(task: FollowupTaskRecord, targetsPullRequest: boolean): { number?: number; error: string } {
  return followupTargetsPullRequest(task, targetsPullRequest)
    // PR comment tasks record their pull request as the issue number; other tasks must have a PR of their own.
    ? { number: task.pr_number ?? (isPullRequestTask(task) ? task.issue_number : undefined), error: 'Task does not have a valid GitHub pull request' }
    : { number: task.issue_number, error: 'Task does not have valid GitHub issue information' };
}

/**
 * Where a plain (untargeted) follow-up submitted for this task will be posted,
 * or null when the follow-up route would refuse it. Shared with that route so
 * the dialog names the thread the submission actually reaches.
 */
export function followupDestination(task: FollowupTaskRecord): FollowupDestination | null {
  const [owner, repo] = String(task.repository ?? '').split('/');
  const { number } = resolveFollowupThread(task, false);
  if (!owner || !repo || !Number.isSafeInteger(number) || (number as number) <= 0) return null;
  return {
    taskId: task.task_id,
    repository: `${owner}/${repo}`,
    kind: followupTargetsPullRequest(task, false) ? 'pull_request' : 'issue',
    number: number as number,
  };
}

/** The follow-up destination of a stored task; null without a row, as the follow-up route then refuses. */
export async function loadFollowupDestination(db: Knex, taskId: string): Promise<FollowupDestination | null> {
  try {
    const task = await db('tasks').where({ task_id: taskId }).first() as FollowupTaskRecord | undefined;
    return task ? followupDestination(task) : null;
  } catch (error) {
    console.warn(`[followup] Could not resolve the follow-up destination of ${taskId}: ${(error as Error).message}`);
    return null;
  }
}
