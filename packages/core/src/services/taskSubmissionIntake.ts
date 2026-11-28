import type { Knex } from 'knex';
import { db } from '../db/connection.js';
import type { IssueJobData } from '../queue/taskQueue.types.js';
import { acquireDispatchLock, findIssueSubmission, type TaskSubmission } from './taskSubmissionService.js';

/**
 * A submission's intake is the issue job the submission route enqueues once
 * its trigger is published: the matrix dispatcher, which runs no task of its
 * own. It can fail before the dispatcher is even entered, as when worktree
 * admission refuses it, so neither the dispatcher nor any task records it.
 */
export const SUBMISSION_INTAKE_JOB_NAME = 'processGitHubIssue';
/** The attempts the route gives its intake job; exhausting them ends the intake. */
export const SUBMISSION_INTAKE_ATTEMPTS = 3;

export const submissionIntakeJobId = (owner: string, repo: string, issueNumber: number): string => `issue-${owner}-${repo}-${issueNumber}`;

/** The queue's view of the intake job, by its ID. */
export type IntakeJobState =
  | { state: 'absent' }
  | { state: 'live'; timestamp: number }
  | { state: 'completed'; timestamp: number }
  | { state: 'failed'; timestamp: number; reason: string };

export interface IntakeFailureEvidence {
  /** The job instance, by its creation time, whose last failure was recorded. */
  timestamp: number;
  failures: number;
  reason: string;
}

export interface SubmissionIntakeEvidence {
  job(jobId: string): Promise<IntakeJobState>;
  /**
   * The recorded failures of the latest intake job instance that ran for the
   * submission, or null when none are recorded. A job instance is identified
   * by its creation time; every failed attempt of it is recorded once.
   */
  failures(submission: TaskSubmission): Promise<IntakeFailureEvidence | null>;
}

/** How an intake ended: the last attempt's error, and how many attempts failed, when known. */
export interface IntakeFailure { reason: string; attempts?: number }

/** Drops trailing periods and whitespace with a linear scan; an anchored regex backtracks on long runs. */
const trimTrailingPunctuation = (text: string): string => {
  let end = text.length;
  while (end > 0 && (text[end - 1] === '.' || /\s/.test(text.charAt(end - 1)))) end -= 1;
  return text.slice(0, end);
};

const intakeFailureMessage = ({ reason, attempts }: IntakeFailure) =>
  `Implementation did not start${attempts && attempts > 1 ? ` after ${attempts} attempts` : ''}: ${trimTrailingPunctuation(reason)}. `
  + 'Once the cause is fixed, Retry agent starts this same issue again without creating another.';

/**
 * Records an intake that ended before any task, fenced on the submission
 * still waiting on it: queued, not dispatched, without a task and without a
 * retry claiming it. A dispatch receipt, an associated task or a concurrent
 * retry leaves the submission as it is.
 */
export async function recordSubmissionIntakeFailure(database: Knex, id: string, failure: IntakeFailure): Promise<boolean> {
  const updated = await database('task_submissions')
    .where({ id, state: 'queued', dispatch_complete: false })
    .whereNull('task_id').whereNull('latest_task_id').whereNull('dispatch_claim')
    .update({ state: 'failed', error: intakeFailureMessage(failure) });
  return Number(updated) === 1;
}

/** A submission whose intake may have ended unrecorded: queued, undispatched, task-less and unclaimed. */
export const awaitingIntake = (row: TaskSubmission): boolean =>
  row.state === 'queued' && !row.dispatch_complete && !row.task_id && !row.latest_task_id && !row.dispatch_claim && Boolean(row.issue_number);

export type IntakeSettlement = 'recorded' | 'unchanged' | 'busy';

/**
 * Records the failure `establish` reads from the queue, holding the
 * submission's dispatch lock throughout. Evidence read before the lock may
 * predate a retry that restored the submission to queued with a new intake;
 * under the lock no retry can, so the submission is re-read and the evidence
 * read again. While a retry or another settlement holds the lock, the
 * submission is left as it is: a later read reconciles it.
 */
async function settleSubmissionIntake(database: Knex, id: string, establish: () => Promise<IntakeFailure | null>): Promise<IntakeSettlement> {
  const release = await acquireDispatchLock(database, id);
  if (!release) return 'busy';
  try {
    const row = await database<TaskSubmission>('task_submissions').where({ id }).first();
    if (!row || !awaitingIntake(row)) return 'unchanged';
    const failure = await establish();
    return failure && await recordSubmissionIntakeFailure(database, id, failure) ? 'recorded' : 'unchanged';
  } finally { await release(); }
}

export type IntakeFinalization = 'ignored' | 'retrying' | 'superseded' | IntakeSettlement;

interface FinalizableJob {
  id?: string;
  name: string;
  data: IssueJobData;
  timestamp: number;
  finishedOn?: number | null;
  attemptsMade: number;
}

export interface IntakeFinalizerDeps {
  database?: Knex;
  findSubmission?: (issue: IssueJobData, database: Knex) => Promise<TaskSubmission | undefined>;
  /** The queue's current job under the failed job's ID, which may be a newer delivery. */
  job(jobId: string): Promise<IntakeJobState>;
}

/**
 * Settles a submission whose intake job failed for good. BullMQ sets
 * `finishedOn` only when it moves the job to failed rather than to its retry,
 * so an attempt it will retry, however it failed, leaves the submission
 * queued. A newer delivery under the same job ID, live or finished, is the
 * submission's intake now, and decides it instead.
 */
export async function finalizeSubmissionIntakeFailure(job: FinalizableJob | undefined, error: Error, deps: IntakeFinalizerDeps): Promise<IntakeFinalization> {
  if (!job?.id || job.name !== SUBMISSION_INTAKE_JOB_NAME || job.data?.isChildJob || !job.data?.repoOwner || !job.data.repoName || !job.data.number) return 'ignored';
  if (typeof job.finishedOn !== 'number') return 'retrying';
  const database = deps.database ?? db;
  const submission = await (deps.findSubmission ?? findIssueSubmission)(job.data, database);
  if (!submission || !awaitingIntake(submission)) return 'ignored';
  const jobId = job.id;
  const { timestamp, attemptsMade } = job;
  const establish = async (): Promise<IntakeFailure | null> => {
    const current = await deps.job(jobId);
    const superseded = current.state !== 'absent' && (current.state !== 'failed' || current.timestamp !== timestamp);
    return superseded ? null : { reason: error.message, attempts: attemptsMade };
  };
  if (!await establish()) return 'superseded';
  return settleSubmissionIntake(database, submission.id, establish);
}

/**
 * Checks a submission still waiting on its intake against the queue, so one
 * whose intake ended unrecorded, including before this check existed, can be
 * retried. Only an established outcome settles it: the intake job failed for
 * good, or it is gone and every attempt of its latest instance is recorded
 * failed. A live, delayed or completed job, or an absent one without that
 * record, leaves it queued, whatever its age or the absence of a task.
 */
export async function reconcileSubmissionIntake(database: Knex, row: TaskSubmission, evidence: SubmissionIntakeEvidence): Promise<TaskSubmission> {
  if (!awaitingIntake(row)) return row;
  const [owner, repo] = row.repository.split('/');
  const jobId = submissionIntakeJobId(owner, repo, row.issue_number!);
  const establish = async (): Promise<IntakeFailure | null> => {
    const current = await evidence.job(jobId);
    if (current.state === 'failed') return { reason: current.reason };
    if (current.state !== 'absent') return null;
    const failures = await evidence.failures(row);
    if (!failures || failures.failures < SUBMISSION_INTAKE_ATTEMPTS) return null;
    // A delivery added while the log was read is the intake now.
    return (await evidence.job(jobId)).state === 'absent' ? { reason: failures.reason, attempts: failures.failures } : null;
  };
  if (!await establish() || await settleSubmissionIntake(database, row.id, establish) !== 'recorded') return row;
  return (await database<TaskSubmission>('task_submissions').where({ id: row.id }).first()) ?? row;
}

interface IntakeQueue {
  getJob(jobId: string): Promise<{ timestamp: number; failedReason?: string; getState(): Promise<string> } | undefined | null>;
  client: Promise<unknown> | unknown;
}

interface FailureLogClient {
  zrangebyscore(key: string, min: number | string, max: number | string, ...args: Array<string | number>): Promise<string[]>;
}

const FAILURE_LOG = 'metrics:ai:log:v1';
// The log is shared by every job; it is read in pages from the submission's creation on.
export const FAILURE_LOG_PAGE = 5000;

const createdAt = (row: TaskSubmission & { created_at?: string | number | Date }) => {
  const value = row.created_at;
  if (value instanceof Date) return value.getTime();
  if (typeof value === 'number') return value;
  // SQLite's CURRENT_TIMESTAMP is UTC without a zone.
  const parsed = typeof value === 'string' ? Date.parse(/[zZ]|[+-]\d\d:?\d\d$/.test(value) ? value : `${value.replace(' ', 'T')}Z`) : NaN;
  return Number.isFinite(parsed) ? parsed : 0;
};

/**
 * Reads the intake's evidence through the issue queue: the job by its ID, and
 * the failed attempts the worker records for each job, by correlation, which
 * the route's intake job carries as the submission's ID.
 */
export function queueSubmissionIntakeEvidence(queueOf: () => IntakeQueue | Promise<IntakeQueue>): SubmissionIntakeEvidence {
  return {
    async job(jobId) {
      const job = await (await queueOf()).getJob(jobId);
      if (!job) return { state: 'absent' };
      const state = await job.getState();
      if (state === 'failed') return { state: 'failed', timestamp: job.timestamp, reason: job.failedReason || 'The intake job failed' };
      if (state === 'completed') return { state: 'completed', timestamp: job.timestamp };
      // Unknown means removed between the read and its state: not established.
      return state === 'unknown' ? { state: 'absent' } : { state: 'live', timestamp: job.timestamp };
    },
    async failures(row) {
      const client = await (await queueOf()).client as FailureLogClient;
      // A minute's margin covers clock skew between the API and the worker host.
      const from = Math.max(0, createdAt(row) - 60_000);
      let latest: IntakeFailureEvidence | null = null;
      // An entry added below the offset meanwhile shifts the next page onto one already read.
      const counted = new Set<string>();
      for (let offset = 0; ; offset += FAILURE_LOG_PAGE) {
        const entries = await client.zrangebyscore(FAILURE_LOG, from, '+inf', 'LIMIT', offset, FAILURE_LOG_PAGE);
        for (const entry of entries) {
          let parsed: { correlationId?: string; status?: string; timestamp?: number; error?: string };
          try { parsed = JSON.parse(entry); } catch { continue; }
          if (parsed.correlationId !== row.id || parsed.status !== 'failed' || typeof parsed.timestamp !== 'number' || counted.has(entry)) continue;
          counted.add(entry);
          if (!latest || parsed.timestamp > latest.timestamp) latest = { timestamp: parsed.timestamp, failures: 0, reason: parsed.error || 'The intake job failed' };
          if (parsed.timestamp === latest.timestamp) latest.failures++;
        }
        if (entries.length < FAILURE_LOG_PAGE) return latest;
      }
    },
  };
}
