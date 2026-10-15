import type { Knex } from 'knex';
import type { Redis } from 'ioredis';
import {
  getAuthenticatedOctokit, getIssueQueue, loadPrimaryProcessingLabels, parseSlashCommand,
  safeAddLabel, safeRemoveLabel, generateCorrelationId, logger, findIssueSubmission, submissionRetryAdmissibleAt,
  rememberIssueRetryRequest, settleIssueRetryRequest,
} from '@propr/core';
import { enqueueIssueImplementationJob } from './planIssueHelpers.js';

export interface IssueFollowupDeps {
  processingLabels?: typeof loadPrimaryProcessingLabels;
  enqueueIssue?: typeof enqueueIssueImplementationJob;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

export interface IssueFollowupInput {
  task: { task_id: string; replay_job_data?: unknown };
  owner: string;
  repo: string;
  issueNumber: number;
  body: string;
  userId: string;
  redis: Redis;
}

export interface FollowupResult {
  status: number;
  body: Record<string, unknown>;
}

interface IssueData {
  state?: string;
  pull_request?: unknown;
  labels?: Array<{ name?: string } | string>;
}

type Octokit = Awaited<ReturnType<typeof getAuthenticatedOctokit>>;

// Bounds the wait for the retry second when the database clock runs ahead.
const MAX_ADMISSION_WAIT_MS = 2000;

const refused = (status: number, error: string): FollowupResult => ({ status, body: { error } });

function recordedTrigger(replay: unknown): string | undefined {
  try {
    const data = typeof replay === 'string' ? JSON.parse(replay) as { triggeringLabel?: unknown } : replay as { triggeringLabel?: unknown } | null;
    return typeof data?.triggeringLabel === 'string' ? data.triggeringLabel : undefined;
  } catch {
    return undefined;
  }
}

/** The trigger the failed run was admitted with, while it is still configured. */
function retryTrigger(task: IssueFollowupInput['task'], labels: string[], triggers: string[]): string | undefined {
  const recorded = recordedTrigger(task.replay_job_data);
  if (recorded && triggers.includes(recorded)) return recorded;
  return triggers.find(label => labels.includes(label)) ?? triggers[0];
}

async function issueRunPending(owner: string, repo: string, issueNumber: number): Promise<boolean> {
  const queue = await getIssueQueue();
  const jobs = (await Promise.all([queue.getActive(), queue.getWaiting(), queue.getDelayed()])).flat();
  return jobs.some(job => {
    const data = job?.data as { repoOwner?: string; repoName?: string; number?: number } | undefined;
    return job?.name === 'processGitHubIssue' && data?.repoOwner === owner && data.repoName === repo && Number(data.number) === issueNumber;
  });
}

/** A submission-backed issue only reruns on a trigger event its dispatcher admits as a retry. */
async function retryAdmissibleAt(db: Knex, owner: string, repo: string, issueNumber: number): Promise<number | null> {
  const submission = await findIssueSubmission({ repoOwner: owner, repoName: repo, number: issueNumber }, db);
  return submission ? submissionRetryAdmissibleAt(submission, db) : 0;
}

/** Waits a bounded time for `time`, reporting whether it has arrived. */
async function waitUntil(deps: IssueFollowupDeps, time: number): Promise<boolean> {
  const now = deps.now ?? Date.now;
  const wait = Math.min(time - now(), MAX_ADMISSION_WAIT_MS);
  if (wait > 0) await (deps.sleep ?? (ms => new Promise<void>(resolve => setTimeout(resolve, ms))))(wait);
  return now() >= time;
}

/**
 * Whether a trigger write the label helper reported as failed landed anyway:
 * a lost response does not mean GitHub refused it. Undefined when the issue
 * cannot be read to tell.
 */
async function triggerPresent(octokit: Octokit, input: IssueFollowupInput, trigger: string): Promise<boolean | undefined> {
  try {
    const { data } = await octokit.request('GET /repos/{owner}/{repo}/issues/{issue_number}/labels', {
      owner: input.owner, repo: input.repo, issue_number: input.issueNumber, per_page: 100,
    }) as { data: Array<{ name?: string } | string> };
    return data.some(label => (typeof label === 'string' ? label : label.name) === trigger);
  } catch (error) {
    console.warn(`[followup] Could not confirm the retry trigger on #${input.issueNumber}: ${(error as Error).message}`);
    return undefined;
  }
}

/** Re-applies the trigger; undefined when GitHub may have applied it without confirming. */
async function reapplyTrigger(context: Parameters<typeof safeAddLabel>[0] & { octokit: Octokit }, input: IssueFollowupInput, present: boolean, trigger: string): Promise<boolean | undefined> {
  // A failed removal publishes no trigger event, so nothing can start from it.
  if (present && !await safeRemoveLabel(context, trigger)) return false;
  return await safeAddLabel(context, trigger) || triggerPresent(context.octokit, input, trigger);
}

async function checkRetryable(db: Knex, input: IssueFollowupInput): Promise<FollowupResult | null> {
  const { task, issueNumber } = input;
  if (parseSlashCommand(input.body)) {
    return refused(400, `Pull request commands need a pull request, and issue #${issueNumber} has none yet. Send a plain request to retry the implementation.`);
  }
  const latest = await db('task_history').where({ task_id: task.task_id }).orderBy('history_id', 'desc').first('state') as { state?: string } | undefined;
  const state = String(latest?.state ?? 'unknown').toLowerCase();
  if (state !== 'failed') {
    return refused(409, `A follow-up on issue #${issueNumber} retries a failed implementation. This run is ${state}.`);
  }
  if (await issueRunPending(input.owner, input.repo, issueNumber)) {
    return refused(409, `A run for issue #${issueNumber} is already queued or running. Refresh the task before retrying.`);
  }
  return null;
}

/**
 * Retries a failed issue-only implementation through the issue execution
 * path: the request is posted on the issue (the run reads issue comments as
 * its prompt context), the trigger label is re-applied so submission-backed
 * issues record a fresh trigger, and the issue job is queued for the
 * requesting user. The issue's model labels keep the original selection.
 */
export async function postIssueFollowup(db: Knex, deps: IssueFollowupDeps, input: IssueFollowupInput): Promise<FollowupResult> {
  const { task, owner, repo, issueNumber, userId, redis } = input;
  const body = input.body.trim();
  const refusal = await checkRetryable(db, input);
  if (refusal) return refusal;

  const octokit = await getAuthenticatedOctokit();
  const { data: issue } = await octokit.request('GET /repos/{owner}/{repo}/issues/{issue_number}', {
    owner, repo, issue_number: issueNumber,
  }) as { data: IssueData };
  if (issue.pull_request) return refused(409, `#${issueNumber} is a pull request, not the task's issue.`);
  if (issue.state !== 'open') return refused(409, `Issue #${issueNumber} is closed. Reopen it before retrying.`);
  const admissibleAt = await retryAdmissibleAt(db, owner, repo, issueNumber);
  if (admissibleAt === null) {
    return refused(409, `Issue #${issueNumber}'s latest run is not recorded as finished, so a new trigger would not start a run. Refresh the task before retrying.`);
  }
  const labels = (issue.labels ?? []).map(label => typeof label === 'string' ? label : label.name ?? '');
  const triggers = await (deps.processingLabels ?? loadPrimaryProcessingLabels)();
  const trigger = retryTrigger(task, labels, triggers);
  if (!trigger) return refused(409, 'No processing label is configured, so the issue cannot be retried.');
  if (labels.includes(`${trigger}-done`) || labels.includes(`${trigger}-cancelled`)) {
    return refused(409, `Issue #${issueNumber} is marked ${labels.includes(`${trigger}-done`) ? 'done' : 'cancelled'}; remove that label before retrying.`);
  }

  // Re-applying records a trigger after the failure; an already present label
  // would emit no event, and submission-backed issues only rerun on a new one.
  // GitHub stamps that event to the second, so it must land after the
  // failure's second for the dispatcher to tell it from the initial trigger.
  // Waiting before posting means a refusal leaves no partial follow-up.
  if (!await waitUntil(deps, admissibleAt)) {
    return refused(409, `Issue #${issueNumber}'s failure is recorded later than this server's clock, so a new trigger would not start a run yet. Try again in a few seconds.`);
  }

  // Shares the label-event window, so the relabel's webhook does not queue a
  // second run without the requesting user.
  const correlationId = generateCorrelationId();
  const dedupeKey = `issue:dedup:${owner}:${repo}:${issueNumber}`;
  if (!await redis.set(dedupeKey, correlationId, 'EX', 30, 'NX')) {
    return refused(409, `A run for issue #${issueNumber} was just requested. Refresh the task before retrying.`);
  }

  let commentId: number;
  try {
    const { data: comment } = await octokit.request('POST /repos/{owner}/{repo}/issues/{issue_number}/comments', {
      owner, repo, issue_number: issueNumber, body,
    });
    commentId = comment.id;
  } catch (error) {
    await redis.del(dedupeKey);
    throw error;
  }
  console.log(`[followup] Posted retry request (ID: ${commentId}) to ${owner}/${repo}#${issueNumber}`);
  const posted = { posted: true, commentId, sourceTaskId: task.task_id, intent: 'issue', issueNumber };

  const notStarted = (): FollowupResult => ({ status: 202, body: { success: false, state: 'failed', ...posted,
    message: `Comment posted, but the retry could not be started. Make sure issue #${issueNumber} has the '${trigger}' label, then try again.` } });

  // Held before the trigger is published: a relabel delivery that recovers a
  // failed enqueue carries neither the requester nor the comment to exempt.
  const issueKey = { repoOwner: owner, repoName: repo, number: issueNumber };
  const retryRequest = { requesterId: userId, commentId };
  try {
    await rememberIssueRetryRequest(redis, issueKey, retryRequest);
  } catch (error) {
    console.warn(`[followup] Could not record the retry request: ${(error as Error).message}`);
    await redis.del(dedupeKey);
    return notStarted();
  }

  const jobId = `issue-${owner}-${repo}-${issueNumber}`;
  const unconfirmed = (message: string): FollowupResult => ({ status: 202, body: { success: false, state: 'unknown', jobId, ...posted, message } });

  const context = { octokit, owner, repo, issueNumber, logger: logger.withCorrelation(correlationId) };
  const applied = await reapplyTrigger(context, input, labels.includes(trigger), trigger);
  if (applied === undefined) {
    // GitHub may have applied the trigger, whose relabel delivery or polling
    // recovers the run; the held request keeps its requester and instructions.
    return unconfirmed(`Comment posted, but whether the '${trigger}' label was applied could not be confirmed, so the retry may still start. Inspect issue #${issueNumber} before retrying.`);
  }
  if (!applied) {
    await settleIssueRetryRequest(redis, issueKey, retryRequest).catch(() => undefined);
    await redis.del(dedupeKey);
    return notStarted();
  }

  try {
    await (deps.enqueueIssue ?? enqueueIssueImplementationJob)({ owner, repo, issueNumber, userId, retryRequesterId: userId, retryCommentId: commentId, triggeringLabel: trigger, correlationId });
  } catch (error) {
    // The queue may have accepted the job before failing; the trigger label
    // stays for polling, and the held request lets that recovery run it.
    console.warn(`[followup] Issue retry dispatch failed: ${(error as Error).message}`);
    return unconfirmed('Comment posted, but submission could not be confirmed. Inspect the comment and any job receipt before retrying.');
  }
  return { status: 202, body: { success: true, state: 'queued', jobId, ...posted, message: `Retry queued on issue #${issueNumber}.` } };
}
