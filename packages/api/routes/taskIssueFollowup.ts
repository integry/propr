import type { Knex } from 'knex';
import type { Redis } from 'ioredis';
import {
  getAuthenticatedOctokit, getIssueQueue, loadPrimaryProcessingLabels, parseSlashCommand,
  safeRemoveLabel, generateCorrelationId, logger, findIssueSubmission, submissionRetryAdmissibleAt,
  reserveIssueRetryRequest, reportIssueRetryPublication, settleIssueRetryRequest, hasUnresolvedIssueRetryRequest, triggerLabelEvents,
  type IssueRetryRequest, type TriggerHistory, type TriggerLabelEvent,
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

const clock = (deps: IssueFollowupDeps) => deps.now ?? Date.now;

/** Waits a bounded time for `time`, reporting whether it has arrived. */
async function waitUntil(deps: IssueFollowupDeps, time: number): Promise<boolean> {
  const now = clock(deps);
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

/**
 * Adds the trigger; undefined when GitHub may still apply it. Only a refusal
 * GitHub answered proves no write: a lost or timed-out write can land after a
 * read that does not show it yet.
 */
async function addTrigger(octokit: Octokit, input: IssueFollowupInput, trigger: string): Promise<boolean | undefined> {
  try {
    await octokit.request('POST /repos/{owner}/{repo}/issues/{issue_number}/labels', {
      owner: input.owner, repo: input.repo, issue_number: input.issueNumber, labels: [trigger],
    });
    return true;
  } catch (error) {
    const status = (error as { status?: unknown }).status;
    console.warn(`[followup] Adding '${trigger}' to #${input.issueNumber} failed (${status ?? 'no response'}): ${(error as Error).message}`);
    if (await triggerPresent(octokit, input, trigger)) return true;
    return typeof status === 'number' && status >= 400 && status < 500 ? false : undefined;
  }
}

/** Re-applies the trigger; undefined when GitHub may have applied it without confirming. */
async function reapplyTrigger(context: Parameters<typeof safeRemoveLabel>[0] & { octokit: Octokit }, input: IssueFollowupInput, present: boolean, trigger: string): Promise<boolean | undefined> {
  // A failed removal publishes no trigger event, so nothing can start from it.
  if (present && !await safeRemoveLabel(context, trigger)) return false;
  return addTrigger(context.octokit, input, trigger);
}

/** The trigger history, whose latest event is the one after which the request's own trigger is the first its identity labels. */
async function triggerBaseline(octokit: Octokit, input: IssueFollowupInput, triggers: string[]): Promise<{ events: TriggerLabelEvent[]; afterEventId: string | null } | null> {
  try {
    const events = await triggerLabelEvents(octokit, { repoOwner: input.owner, repoName: input.repo, number: input.issueNumber }, new Set(triggers));
    const latest = events.at(-1);
    return { events, afterEventId: latest?.id === undefined ? null : String(latest.id) };
  } catch (error) {
    console.warn(`[followup] Could not read the trigger history of #${input.issueNumber}: ${(error as Error).message}`);
    return null;
  }
}

/** Posts the request; the trigger is labelled with the same credentials, so its event names the same actor. */
async function postRequest(octokit: Octokit, input: IssueFollowupInput, body: string): Promise<{ commentId: number; actorId: number | null }> {
  const { data: comment } = await octokit.request('POST /repos/{owner}/{repo}/issues/{issue_number}/comments', {
    owner: input.owner, repo: input.repo, issue_number: input.issueNumber, body,
  });
  return { commentId: comment.id, actorId: typeof comment.user?.id === 'number' ? comment.user.id : null };
}

const issueKeyOf = (input: IssueFollowupInput) => ({ repoOwner: input.owner, repoName: input.repo, number: input.issueNumber });

/**
 * Claims the label-event window the relabel's webhook shares, so it does not
 * queue a second run without the requesting user. Refuses, releasing it,
 * while an earlier request's trigger write may still land: that request keeps
 * its requester and instructions until it does or cannot, and a second
 * request then could not be told apart from it.
 */
async function claimRetryWindow(input: IssueFollowupInput, history: TriggerHistory, { dedupeKey, correlationId }: { dedupeKey: string; correlationId: string }): Promise<FollowupResult | null> {
  if (!await input.redis.set(dedupeKey, correlationId, 'EX', 30, 'NX')) {
    return refused(409, `A run for issue #${input.issueNumber} was just requested. Refresh the task before retrying.`);
  }
  let unresolved: boolean;
  try {
    unresolved = await hasUnresolvedIssueRetryRequest(input.redis, issueKeyOf(input), history);
  } catch (error) {
    await input.redis.del(dedupeKey);
    throw error;
  }
  if (!unresolved) return null;
  await input.redis.del(dedupeKey);
  return refused(409, `An earlier retry of issue #${input.issueNumber} may still start. Inspect the issue and try again in a few minutes.`);
}

/** Holds the request pending its trigger write; false when it cannot be held. */
async function holdRequest(input: IssueFollowupInput, request: IssueRetryRequest, events: TriggerLabelEvent[]): Promise<boolean> {
  try {
    return await reserveIssueRetryRequest(input.redis, issueKeyOf(input), request, { events, now: request.requestedAt });
  } catch (error) {
    console.warn(`[followup] Could not record the retry request: ${(error as Error).message}`);
    return false;
  }
}

/**
 * Lets recovery adopt the held request once its trigger write was applied or
 * may still be; still pending, a late trigger runs without it rather than
 * risk another's. A write GitHub refused published no trigger of the
 * request; releasing it is cleanup, as a failed release leaves it pending.
 */
async function recordTriggerOutcome(input: IssueFollowupInput, request: IssueRetryRequest, applied: boolean | undefined): Promise<void> {
  if (applied === false) {
    await settleIssueRetryRequest(input.redis, issueKeyOf(input), request).catch(() => undefined);
    return;
  }
  await reportIssueRetryPublication(input.redis, issueKeyOf(input), request).catch((error: Error) => {
    console.warn(`[followup] Could not report the retry trigger as published: ${error.message}`);
  });
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

  const baseline = await triggerBaseline(octokit, input, triggers);
  if (!baseline) {
    return refused(502, `Issue #${issueNumber}'s label history could not be read, so the retry could not be tied to its trigger. Try again.`);
  }

  const correlationId = generateCorrelationId();
  const dedupeKey = `issue:dedup:${owner}:${repo}:${issueNumber}`;
  const unclaimed = await claimRetryWindow(input, { events: baseline.events, now: clock(deps)() }, { dedupeKey, correlationId });
  if (unclaimed) return unclaimed;

  let commentId: number;
  let actorId: number | null;
  try {
    ({ commentId, actorId } = await postRequest(octokit, input, body));
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
  // It is bound to the trigger it publishes, so if releasing it fails a
  // later, independent trigger cannot adopt it.
  const retryRequest: IssueRetryRequest = { requesterId: userId, commentId, requestedAt: clock(deps)(), afterEventId: baseline.afterEventId, actorId, publication: 'pending' };
  if (!await holdRequest(input, retryRequest, baseline.events)) {
    await redis.del(dedupeKey);
    return notStarted();
  }

  const jobId = `issue-${owner}-${repo}-${issueNumber}`;
  const unconfirmed = (message: string): FollowupResult => ({ status: 202, body: { success: false, state: 'unknown', jobId, ...posted, message } });

  const context = { octokit, owner, repo, issueNumber, logger: logger.withCorrelation(correlationId) };
  const applied = await reapplyTrigger(context, input, labels.includes(trigger), trigger);
  await recordTriggerOutcome(input, retryRequest, applied);
  if (applied === undefined) {
    // GitHub may have applied the trigger or may still apply it, and its
    // relabel delivery or polling recovers the run; the held request keeps
    // its requester and instructions for that trigger only.
    return unconfirmed(`Comment posted, but whether the '${trigger}' label was applied could not be confirmed, so the retry may still start. Inspect issue #${issueNumber} before retrying.`);
  }
  if (!applied) {
    // GitHub refused the write, so no trigger of this request exists.
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
