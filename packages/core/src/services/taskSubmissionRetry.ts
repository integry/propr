import type { Knex } from 'knex';
import { db } from '../db/connection.js';
import { getAuthenticatedOctokit } from '../auth/githubAuth.js';
import { loadPrimaryProcessingLabels } from '../config/configManager.js';
import type { TaskSubmission } from './taskSubmissionService.js';
import { triggerLabelEvents, type TriggerLabelEvent } from './issueRetryRequest.js';

export interface SubmissionRetry { eventId: string }

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
): Promise<TriggerLabelEvent | undefined> {
  const [repoOwner, repoName] = submission.repository.split('/');
  return (await triggerLabelEvents(await getOctokit(), { repoOwner, repoName, number: submission.issue_number! }, triggers)).at(-1);
}

async function terminalMillis(submission: TaskSubmission, database: Knex): Promise<number | null> {
  const taskId = submission.latest_task_id || submission.task_id;
  if (!taskId) return null;
  const latest = await database('task_history').where({ task_id: taskId }).orderBy('history_id', 'desc').first('state', 'timestamp');
  if (!latest || !['completed', 'failed', 'cancelled'].includes(String(latest.state).toLowerCase())) return null;
  const terminalTime = timestampMillis(latest.timestamp);
  return Number.isFinite(terminalTime) ? terminalTime : null;
}

/**
 * The earliest time a new trigger event is admitted as a retry of the
 * submission's terminal work, or null while none can be. GitHub truncates
 * event times to seconds, so without a consumed retry identity an event in
 * the terminal second is indistinguishable from the initial trigger.
 */
export async function submissionRetryAdmissibleAt(submission: TaskSubmission, database: Knex = db): Promise<number | null> {
  if (!submission.dispatch_complete) return 0;
  const terminalTime = await terminalMillis(submission, database);
  if (terminalTime === null) return null;
  const terminalSecond = Math.floor(terminalTime / 1000) * 1000;
  return submission.retry_event_id ? terminalSecond : terminalSecond + 1000;
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
  const terminalTime = await terminalMillis(submission, database);
  if (terminalTime === null) return null;
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
