import type { Knex } from 'knex';
import { db } from '../db/connection.js';
import { getAuthenticatedOctokit } from '../auth/githubAuth.js';
import { loadPrimaryProcessingLabels } from '../config/configManager.js';
import type { TaskSubmission } from './taskSubmissionService.js';

export interface SubmissionRetry { eventId: string }
interface LabelEvent { id?: number; event: string; created_at?: string; label?: { name: string }; actor?: { id: number } }

function timestampMillis(value: unknown): number {
  if (value instanceof Date) return value.getTime();
  if (typeof value === 'number') return value;
  if (typeof value !== 'string') return NaN;
  const timestamp = value.trim().replace(' ', 'T');
  return Date.parse(/(?:Z|[+-]\d{2}:?\d{2})$/i.test(timestamp) ? timestamp : `${timestamp}Z`);
}

async function latestProcessingLabelEvent(
  submission: TaskSubmission,
  triggers: Set<string>,
  getOctokit: typeof getAuthenticatedOctokit,
): Promise<LabelEvent | undefined> {
  const [owner, repo] = submission.repository.split('/');
  const octokit = await getOctokit();
  let event: LabelEvent | undefined;
  for (let page = 1; ; page++) {
    const { data } = await octokit.request('GET /repos/{owner}/{repo}/issues/{issue_number}/timeline', {
      owner, repo, issue_number: submission.issue_number!, per_page: 100, page,
    });
    for (const item of data as LabelEvent[]) {
      if (item.event === 'labeled' && item.label && triggers.has(item.label.name)) event = item;
    }
    if (data.length < 100) break;
  }
  return event;
}

/** Capture the initial trigger, or recognize a fresh trigger after terminal work. */
export async function resolveTaskSubmissionRetry(
  submission: TaskSubmission,
  database: Knex = db,
  getOctokit = getAuthenticatedOctokit,
  processingLabels = loadPrimaryProcessingLabels,
): Promise<SubmissionRetry | null> {
  if (!submission.dispatch_complete) {
    const event = await latestProcessingLabelEvent(submission, new Set(await processingLabels()), getOctokit);
    return event?.id ? { eventId: String(event.id) } : null;
  }
  const taskId = submission.latest_task_id || submission.task_id;
  if (!taskId) return null;
  const latest = await database('task_history').where({ task_id: taskId }).orderBy('history_id', 'desc').first('state', 'timestamp');
  if (!latest || !['completed', 'failed', 'cancelled'].includes(String(latest.state).toLowerCase())) return null;
  const terminalTime = timestampMillis(latest.timestamp);
  if (!Number.isFinite(terminalTime)) return null;
  const triggers = new Set(await processingLabels());
  const event = await latestProcessingLabelEvent(submission, triggers, getOctokit);
  const eventTime = timestampMillis(event?.created_at);
  // GitHub truncates event times to seconds. Within the terminal second,
  // a different consumed identity distinguishes a relabel from redelivery.
  const terminalSecond = Math.floor(terminalTime / 1000) * 1000;
  if (!event?.id || String(event.id) === submission.retry_event_id
    || !Number.isFinite(eventTime) || eventTime < terminalSecond
    || (eventTime <= terminalTime && !submission.retry_event_id)) return null;
  return { eventId: String(event.id) };
}
