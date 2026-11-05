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

async function processingLabelEvents(
  submission: TaskSubmission,
  triggers: Set<string>,
  getOctokit: typeof getAuthenticatedOctokit,
  retained: Array<string | null | undefined> = [],
): Promise<TriggerLabelEvent[]> {
  const [repoOwner, repoName] = submission.repository.split('/');
  return triggerLabelEvents(await getOctokit(), { repoOwner, repoName, number: submission.issue_number! }, triggers, [submission.retry_event_id, ...retained]);
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

/**
 * The trigger events, oldest first, the submission admits as a fresh run:
 * any before its initial dispatch, and afterwards those after the latest
 * consumed trigger that a retry of its terminal work admits. A history that
 * does not show the consumed trigger admits none: it may predate it, as a
 * stale read does, so none of its events is known to come after it.
 */
export async function admittedSubmissionTriggers(submission: TaskSubmission, events: TriggerLabelEvent[], database: Knex = db): Promise<TriggerLabelEvent[]> {
  if (!submission.dispatch_complete) return events;
  const terminalTime = await terminalMillis(submission, database);
  if (terminalTime === null) return [];
  const consumed = submission.retry_event_id ? events.findIndex(event => String(event.id) === submission.retry_event_id) : -1;
  if (submission.retry_event_id && consumed === -1) return [];
  const unconsumed = events.slice(consumed + 1);
  // GitHub truncates event times to seconds. Within the terminal second,
  // a different consumed identity distinguishes a relabel from redelivery.
  const terminalSecond = Math.floor(terminalTime / 1000) * 1000;
  return unconsumed.filter(event => {
    const eventTime = timestampMillis(event.created_at);
    return event.id && String(event.id) !== submission.retry_event_id && Number.isFinite(eventTime) && eventTime >= terminalSecond
      && (eventTime > terminalTime || Boolean(submission.retry_event_id));
  });
}

/**
 * The trigger events of the submission's issue, oldest first, read afresh, with its consumed trigger and the
 * triggers `retained` names, such as an accepted run's receipt, however they are labelled now.
 */
export async function submissionTriggerEvents(
  submission: TaskSubmission,
  getOctokit = getAuthenticatedOctokit,
  processingLabels = loadPrimaryProcessingLabels,
  retained: Array<string | null | undefined> = [],
): Promise<TriggerLabelEvent[]> {
  return processingLabelEvents(submission, new Set(await processingLabels()), getOctokit, retained);
}

/** Capture the initial trigger, or recognize a fresh trigger after terminal work. */
export async function resolveTaskSubmissionRetry(
  submission: TaskSubmission,
  database: Knex = db,
  getOctokit = getAuthenticatedOctokit,
  processingLabels = loadPrimaryProcessingLabels,
): Promise<SubmissionRetry | null> {
  const events = await processingLabelEvents(submission, new Set(await processingLabels()), getOctokit);
  const latest = events.at(-1);
  if (!submission.dispatch_complete) return latest?.id ? { eventId: String(latest.id) } : null;
  return latest && (await admittedSubmissionTriggers(submission, events, database)).at(-1) === latest ? { eventId: String(latest.id) } : null;
}
