import type { Knex } from 'knex';
import type { TaskSubmission } from '@propr/core';
import { redactSecrets } from './errorEnvelope.js';

export type SubmissionProgressStage = 'submitted' | 'issue_created' | 'queued' | 'running' | 'completed' | 'failed' | 'cancelled';

export interface SubmissionProgress {
  stage: SubmissionProgressStage;
  issue: { number: number; url: string } | null;
  task: { id: string; state: string | null; updatedAt: string | null; startedAt: string | null; failureReason: string | null } | null;
  pullRequest: { number: number; url: string; state: 'merged' | null } | null;
  next: string;
}

const QUEUED_STATES = new Set(['pending', 'queued']);
const RUNNING_STATES = new Set(['processing', 'claude_execution', 'post_processing']);
const TERMINAL_STAGES = new Set<SubmissionProgressStage>(['completed', 'failed', 'cancelled']);

/** Map the durable submission and newest task event onto the public progress contract. */
export function progressStage(
  submissionState: TaskSubmission['state'],
  taskState: string | null,
  hasTask = taskState !== null,
  hasPreparationError = false,
): SubmissionProgressStage {
  if (submissionState === 'failed' || (submissionState === 'prepared' && hasPreparationError)) return 'failed';
  if (hasTask) {
    if (QUEUED_STATES.has(taskState || '')) return 'queued';
    if (RUNNING_STATES.has(taskState || '')) return 'running';
    if (TERMINAL_STAGES.has(taskState as SubmissionProgressStage)) return taskState as SubmissionProgressStage;
  }
  if (submissionState === 'prepared' || submissionState === 'creating') return 'submitted';
  if (submissionState === 'issue_created') return 'issue_created';
  return 'queued';
}

function positiveInteger(value: unknown): number | null {
  const number = typeof value === 'number' ? value : Number(value);
  return Number.isSafeInteger(number) && number > 0 ? number : null;
}

function jsonObject(value: unknown): Record<string, unknown> {
  if (value && typeof value === 'object' && !Array.isArray(value)) return value as Record<string, unknown>;
  if (typeof value !== 'string') return {};
  try {
    const parsed: unknown = JSON.parse(value);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {};
  } catch { return {}; }
}

function timestamp(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  let normalized = value;
  if (typeof normalized === 'string' && /^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}(?:\.\d+)?$/.test(normalized)) {
    normalized = `${normalized.replace(' ', 'T')}Z`;
  }
  const date = new Date(normalized as string | number | Date);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function nextStep(stage: SubmissionProgressStage, hasPullRequest: boolean): string {
  switch (stage) {
    case 'submitted': return 'Poll again in ~30s; the submission is being prepared.';
    case 'issue_created': return 'Poll again in ~30s; the issue was created and dispatch is starting.';
    case 'queued': return 'Poll again in ~30s; the task is queued.';
    case 'running': return 'Poll again in ~30s; the agent is implementing.';
    case 'completed': return hasPullRequest ? 'The task completed; review the pull request.' : 'The task completed.';
    case 'failed': return 'The task failed; inspect the failure reason before retrying.';
    case 'cancelled': return 'The task was cancelled; start a new submission if work should continue.';
  }
}

/** Build retry-aware submission progress entirely from local durable state. */
export async function submissionProgress(db: Knex, row: TaskSubmission): Promise<SubmissionProgress> {
  const taskId = row.latest_task_id || row.task_id;
  const task = taskId ? await db('tasks').where({ task_id: taskId, repository: row.repository }).first(
    'task_id', 'pr_number', 'final_result', 'created_at',
    db.raw(`(SELECT state FROM task_history
      WHERE task_history.task_id = tasks.task_id ORDER BY history_id DESC LIMIT 1) AS state`),
    db.raw(`(SELECT timestamp FROM task_history
      WHERE task_history.task_id = tasks.task_id ORDER BY history_id DESC LIMIT 1) AS state_timestamp`),
    db.raw(`(SELECT reason FROM task_history
      WHERE task_history.task_id = tasks.task_id ORDER BY history_id DESC LIMIT 1) AS state_reason`),
    db.raw(`(SELECT MIN(timestamp) FROM task_history
      WHERE task_history.task_id = tasks.task_id
        AND state IN ('processing', 'claude_execution', 'post_processing')) AS started_at`),
  ) as Record<string, unknown> | undefined : undefined;

  const taskState = typeof task?.state === 'string' ? task.state : null;
  const stage = progressStage(row.state, taskState, !!task, Boolean(row.error));
  const finalResult = jsonObject(task?.final_result);
  const postProcessing = jsonObject(finalResult.postProcessing);
  const resultPullRequest = jsonObject(postProcessing.pr);
  const pullRequestNumber = positiveInteger(task?.pr_number) ?? positiveInteger(resultPullRequest.number);
  const merged = pullRequestNumber ? await db('notification_pull_request_state').where({
    repository: row.repository, pr_number: pullRequestNumber,
  }).whereNotNull('merged_at').first('merged_at') : undefined;
  const issueNumber = positiveInteger(row.issue_number);
  const issueUrl = row.issue_url || (issueNumber ? `https://github.com/${row.repository}/issues/${issueNumber}` : null);
  const pullRequest = pullRequestNumber ? {
    number: pullRequestNumber,
    url: `https://github.com/${row.repository}/pull/${pullRequestNumber}`,
    state: merged ? 'merged' as const : null,
  } : null;

  return {
    stage,
    issue: issueNumber && issueUrl ? { number: issueNumber, url: issueUrl } : null,
    task: task ? {
      id: String(task.task_id), state: taskState,
      updatedAt: timestamp(task.state_timestamp ?? task.created_at),
      startedAt: timestamp(task.started_at),
      failureReason: taskState === 'failed' && typeof task.state_reason === 'string'
        ? redactSecrets(task.state_reason) : null,
    } : null,
    pullRequest,
    next: nextStep(stage, !!pullRequest),
  };
}
