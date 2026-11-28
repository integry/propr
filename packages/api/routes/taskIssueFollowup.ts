import type { Knex } from 'knex';
import type { Redis } from 'ioredis';
import {
  getAuthenticatedOctokit, getIssueQueue, loadPrimaryProcessingLabels, parseSlashCommand,
  safeRemoveLabel, generateCorrelationId, logger, findIssueSubmission, submissionRetryAdmissibleAt,
  reserveIssueRetryRequest, beginIssueRetryPublication, releaseIssueRetryReservation, recordIssueRetryPublication, restartIssueRetryPublication,
  retryRequestTrigger, triggerLabelEvents, redisRetryOutcomeEvidence, reconcileIssueRetryOutcomes, issueRetryPublicationOpen, queueRetryRunEvidence,
  type IssueRetryRequest, type TriggerHistory, type TriggerLabelEvent,
} from '@propr/core';
import { enqueueIssueImplementationJob } from './planIssueHelpers.js';

export interface IssueFollowupDeps {
  processingLabels?: typeof loadPrimaryProcessingLabels;
  enqueueIssue?: typeof enqueueIssueImplementationJob;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  /** Retries recording a trigger write's outcome after this request returns, until `attempt` reports it recorded. */
  retryLater?: (attempt: () => Promise<boolean>) => void;
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
// How an outcome that could not be recorded is retried: the first pause, the longest, and for how long.
const OUTCOME_RETRY = { firstMs: 5000, maxMs: 5 * 60 * 1000, forMs: 24 * 60 * 60 * 1000 };
// How many times a trigger add GitHub answered without an event of the request's own is written.
const TRIGGER_WRITES = 2;
// Deletes the label-event claim only while it is still the releasing request's.
const RELEASE_CLAIM = "if redis.call('GET', KEYS[1]) == ARGV[1] then return redis.call('DEL', KEYS[1]) end return 0";

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

/**
 * When a submission-backed issue's dispatcher admits a new trigger event as a
 * retry, and the latest trigger it consumed.
 */
async function retryAdmission(db: Knex, owner: string, repo: string, issueNumber: number): Promise<{ admissibleAt: number | null; consumedEventId: string | null }> {
  const submission = await findIssueSubmission({ repoOwner: owner, repoName: repo, number: issueNumber }, db);
  if (!submission) return { admissibleAt: 0, consumedEventId: null };
  return { admissibleAt: await submissionRetryAdmissibleAt(submission, db), consumedEventId: submission.retry_event_id ?? null };
}

const clock = (deps: IssueFollowupDeps) => deps.now ?? Date.now;
const issueKeyOf = (input: IssueFollowupInput) => ({ repoOwner: input.owner, repoName: input.repo, number: input.issueNumber });

/** Waits a bounded time for `time`, reporting whether it has arrived. */
async function waitUntil(deps: IssueFollowupDeps, time: number): Promise<boolean> {
  const now = clock(deps);
  const wait = Math.min(time - now(), MAX_ADMISSION_WAIT_MS);
  if (wait > 0) await (deps.sleep ?? (ms => new Promise<void>(resolve => setTimeout(resolve, ms))))(wait);
  return now() >= time;
}

/**
 * The request's own trigger event: the first trigger its GitHub identity
 * labelled after its baseline within its publication interval, by the rules
 * recovery uses. A trigger someone else applied, or one applied before its
 * write began, is not its publication. Null when it has none, and undefined
 * when the history cannot be read to tell.
 */
async function ownTrigger(octokit: Octokit, input: IssueFollowupInput, request: IssueRetryRequest, triggers: string[]): Promise<string | null | undefined> {
  try {
    return retryRequestTrigger(request, await triggerLabelEvents(octokit, issueKeyOf(input), new Set(triggers)));
  } catch (error) {
    console.warn(`[followup] Could not confirm the retry trigger on #${input.issueNumber}: ${(error as Error).message}`);
    return undefined;
  }
}

/**
 * Writes the trigger; undefined when GitHub may still apply it, or applied it
 * without an event of the request's own, and 'lapsed' when the write was no
 * longer the issue's open publication, or its window had closed, once the
 * first removal completed, so no add was attempted and no trigger of the
 * request exists: a later request may hold the issue, and a trigger added
 * then would run without this request. Each write first removes the trigger
 * as the issue has it now, not as it was read before the comment was posted:
 * adding a present label succeeds but publishes no event. A refusal of the
 * first write GitHub answered proves no write of the request, whoever else
 * labels the issue meanwhile. Otherwise only the request's own trigger in the
 * history confirms a write: a lost or timed-out one can land after a read
 * that does not show it yet, and a success without one was a no-op, because
 * someone applied the trigger between the removal and the add, so it is
 * written again while the write is still the issue's open publication; a
 * later request that took the issue over owns the trigger then.
 */
async function addTrigger(db: Knex, context: PublishContext, request: IssueRetryRequest, now: () => number): Promise<boolean | undefined | 'lapsed'> {
  const { input, octokit, trigger, triggers } = context;
  const labelContext = { octokit, owner: input.owner, repo: input.repo, issueNumber: input.issueNumber, logger: logger.withCorrelation(context.correlationId) };
  for (let write = 1; ; write++) {
    if (write > 1 && !await issueRetryPublicationOpen(db, request).catch(() => false)) return undefined;
    // A removal publishes no trigger event; one that fails before the first add leaves no write of the request.
    if (!await safeRemoveLabel(labelContext, trigger)) return write === 1 ? false : undefined;
    // The removal may have taken long enough for the window to close, or for a later request to take the issue
    // over; the add is attempted only while the write is still the issue's open publication. Only the add itself
    // can still race GitHub.
    if (!await issueRetryPublicationOpen(db, request, now).catch(() => false)) {
      console.warn(`[followup] Retry request ${request.id}'s publication on #${input.issueNumber} lapsed before '${trigger}' was added; not adding it`);
      return write === 1 ? 'lapsed' : undefined;
    }
    try {
      await octokit.request('POST /repos/{owner}/{repo}/issues/{issue_number}/labels', {
        owner: input.owner, repo: input.repo, issue_number: input.issueNumber, labels: [trigger],
      });
    } catch (error) {
      const status = (error as { status?: unknown }).status;
      console.warn(`[followup] Adding '${trigger}' to #${input.issueNumber} failed (${status ?? 'no response'}): ${(error as Error).message}`);
      if (write === 1 && typeof status === 'number' && status >= 400 && status < 500) return false;
      return typeof await ownTrigger(octokit, input, request, triggers) === 'string' ? true : undefined;
    }
    const own = await ownTrigger(octokit, input, request, triggers);
    if (typeof own === 'string') return true;
    if (own === undefined || write === TRIGGER_WRITES) return undefined;
    console.warn(`[followup] Adding '${trigger}' to #${input.issueNumber} published no event of the request's own; writing it again`);
  }
}

/** Releases the label-event claim unless it expired and a later request holds it; otherwise it expires on its own. */
async function releaseClaim(redis: Redis, dedupeKey: string, correlationId: string): Promise<void> {
  try {
    await redis.eval(RELEASE_CLAIM, 1, dedupeKey, correlationId);
  } catch (error) {
    console.warn(`[followup] Could not release ${dedupeKey}: ${(error as Error).message}`);
  }
}

const outcomeEvidence = (redis: Redis) => redisRetryOutcomeEvidence(() => redis);

/**
 * The trigger history, whose latest trigger is the one after which the request's own trigger is the first its
 * identity labels. It keeps the receipts `retained` names whatever their label now, as dispatch reads it, to
 * order triggers against them; a receipt kept only to order on is never the baseline.
 */
async function triggerBaseline(
  octokit: Octokit, input: IssueFollowupInput, triggers: string[], retained: Array<string | null> = [],
): Promise<{ events: TriggerLabelEvent[]; afterEventId: string | null } | null> {
  try {
    const events = await triggerLabelEvents(octokit, issueKeyOf(input), new Set(triggers), retained);
    const latest = events.filter(event => !event.orderingOnly).at(-1);
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

/**
 * Claims the label-event window the relabel's webhook shares, so it does not
 * queue a second run without the requesting user, and reserves the issue for
 * the request before anything of it is posted. While an earlier request may
 * still be owed a run, that request keeps its requester, instructions and
 * trigger until it runs or cannot, and a second request could not be told
 * apart from it: the claim refuses, releasing the window, unless the earlier
 * request is stranded, which it keeps the window to restart.
 */
async function claimRetry(
  db: Knex, input: IssueFollowupInput, history: TriggerHistory,
  { dedupeKey, correlationId, request, refresh }: {
    dedupeKey: string; correlationId: string; request: Pick<IssueRetryRequest, 'requesterId' | 'requestedAt' | 'afterEventId'>;
    /** Reads the trigger history afresh, keeping the receipts it is given, to order a dispatch receipt recorded since `history`. */
    refresh: (retained: Array<string | null | undefined>) => Promise<TriggerLabelEvent[]>;
  },
): Promise<FollowupResult | { reserved: IssueRetryRequest } | { stranded: IssueRetryRequest }> {
  if (!await input.redis.set(dedupeKey, correlationId, 'EX', 30, 'NX')) {
    return refused(409, `A run for issue #${input.issueNumber} was just requested. Refresh the task before retrying.`);
  }
  // An earlier request's outcome that its process could not record is recorded first, so
  // a refused write releases its request and an applied one is not taken for unknown; and
  // one whose run the queue accepted is recorded consumed, so it is neither restarted nor
  // taken for owed, however its receipt was lost and whichever trigger it published.
  const stores = { database: db, evidence: outcomeEvidence(input.redis), runs: queueRetryRunEvidence(() => getIssueQueue()) };
  const reconciled = await reconcileIssueRetryOutcomes(stores, issueKeyOf(input), history, refresh).then(() => true, (error: Error) => {
    console.warn(`[followup] Could not reconcile earlier retry outcomes of #${input.issueNumber}: ${error.message}`);
    return false;
  });
  let reservation: Awaited<ReturnType<typeof reserveIssueRetryRequest>>;
  try {
    reservation = await reserveIssueRetryRequest(db, issueKeyOf(input), request, history);
  } catch (error) {
    await releaseClaim(input.redis, dedupeKey, correlationId);
    console.warn(`[followup] Could not record the retry request: ${(error as Error).message}`);
    return refused(503, `The retry of issue #${input.issueNumber} could not be recorded, so nothing was posted. Try again.`);
  }
  if ('reserved' in reservation) return reservation;
  // Only a request the queue's records were read for, and show no accepted run of, is restarted:
  // a record that could not be read may be its run's, which a restart would run again.
  if (reservation.stranded && reconciled) return { stranded: reservation.owed };
  await releaseClaim(input.redis, dedupeKey, correlationId);
  if (reservation.stranded) {
    return refused(503, `Whether the earlier retry of issue #${input.issueNumber} already ran could not be checked, so it was not restarted. Try again.`);
  }
  return refused(409, `An earlier retry of issue #${input.issueNumber} may still start. Inspect the issue and try again in a few minutes.`);
}

/** Retries `attempt` with growing pauses, without holding the process open, until it succeeds or a day has passed. */
function retryInBackground(attempt: () => Promise<boolean>): void {
  const deadline = Date.now() + OUTCOME_RETRY.forMs;
  const schedule = (pause: number) => {
    setTimeout(() => {
      void attempt().then(done => {
        if (!done && Date.now() + pause < deadline) schedule(Math.min(pause * 2, OUTCOME_RETRY.maxMs));
      });
    }, pause).unref();
  };
  schedule(OUTCOME_RETRY.firstMs);
}

/**
 * Records the trigger write's outcome for recovery: `possible` once it was
 * applied or may still be, or a refusal, which published no trigger of the
 * request and releases it. Until it is recorded the outcome is unknown, and
 * recovery defers the request's trigger rather than run it with or without the
 * request; so an outcome that cannot be recorded now is kept as durable
 * evidence of this write, which a delivery's dispatch or a later follow-up
 * records once this process is gone or its job exhausted, and is retried after
 * the response. Reports whether it was recorded, and whether a later request
 * superseded the write: it took over the issue once the write could no longer land.
 */
async function recordTriggerOutcome(
  db: Knex, deps: IssueFollowupDeps, { request, applied, redis }: { request: IssueRetryRequest; applied: boolean | undefined; redis: Redis },
): Promise<{ recorded: boolean; superseded: boolean }> {
  const publication = applied === false ? 'refused' : 'possible';
  const evidence = outcomeEvidence(redis);
  let kept = false;
  // Whether the write is still the issue's open publication; null when it could not be recorded.
  const record = async (): Promise<boolean | null> => {
    try {
      const open = await recordIssueRetryPublication(db, request, publication, clock(deps)());
      if (kept) await evidence.clear(request).catch(() => undefined);
      return open;
    } catch (error) {
      console.warn(`[followup] Could not record the retry trigger of #${request.id} as ${publication}: ${(error as Error).message}`);
      kept ||= await evidence.save(request, publication).then(() => true, (saveError: Error) => {
        console.warn(`[followup] Could not keep the retry trigger outcome of #${request.id}: ${saveError.message}`);
        return false;
      });
      return null;
    }
  };
  const open = await record();
  if (open !== null) return { recorded: true, superseded: !open };
  (deps.retryLater ?? retryInBackground)(async () => await record() !== null);
  return { recorded: false, superseded: false };
}

/**
 * Begins the trigger write: records the request with its comment while its
 * reservation is still its own, before anything on the issue is changed. Its
 * publication window opens then, not when it was reserved, so time spent
 * posting it does not make its own trigger look like another's; and its
 * baseline is the trigger history read then, not before the comment was
 * posted, so a trigger another flow of the app's identity labelled while it
 * was posted, even in the second the write begins, is not taken for its own.
 * The read-back and dispatch match the trigger against the same recorded
 * baseline and window. Otherwise, why it was not begun: the history cannot
 * be read, or the reservation was released meanwhile, when a later request
 * may hold the issue and its trigger, so nothing of it must be touched.
 */
async function beginPublication(
  db: Knex, deps: IssueFollowupDeps, context: Pick<PublishContext, 'input' | 'octokit' | 'trigger' | 'triggers'>,
  { reservation, posted }: { reservation: IssueRetryRequest; posted: Pick<IssueRetryRequest, 'commentId' | 'actorId'> },
): Promise<IssueRetryRequest | string> {
  const { issueNumber } = context.input;
  const baseline = await triggerBaseline(context.octokit, context.input, context.triggers);
  if (!baseline) return `Issue #${issueNumber}'s label history could not be read, so the retry could not be tied to its trigger. Try again.`;
  const begun = await beginIssueRetryPublication(db, reservation, { ...posted, afterEventId: baseline.afterEventId }, clock(deps)()).catch((error: Error) => {
    console.warn(`[followup] Could not record the retry request: ${error.message}`);
    return null;
  });
  return begun ?? `Make sure issue #${issueNumber} has the '${context.trigger}' label, then try again.`;
}

/**
 * What became of a request's trigger write and run: queued, refused by
 * GitHub, superseded by a later request, or unknown because the write, the
 * job or the outcome's record could not be confirmed; and whether the outcome
 * was recorded.
 */
type PublishOutcome = 'queued' | 'refused' | 'lapsed' | 'superseded' | 'unconfirmed' | 'unsubmitted' | 'unrecorded';
interface Published { outcome: PublishOutcome; recorded: boolean }
const outcomeState = (outcome: PublishOutcome) => outcome === 'queued' ? 'queued' : outcome === 'refused' || outcome === 'lapsed' ? 'failed' : 'unknown';

interface PublishContext {
  input: IssueFollowupInput;
  octokit: Octokit;
  trigger: string;
  triggers: string[];
  dedupeKey: string;
  correlationId: string;
}

/**
 * Points to the restart a later follow-up makes: if an unrecorded outcome
 * stays unrecorded, the request is stranded once its write can no longer land.
 */
const strandedHint = ({ outcome, recorded }: Published) => recorded || outcome === 'refused' || outcome === 'lapsed' || outcome === 'superseded' ? ''
  : ' If it has not started in about ten minutes, follow up again to restart it.';

/**
 * Writes the request's trigger, records the write's outcome and, once its own
 * trigger confirmed the write, queues the request's run for its requester.
 * The job is queued only then, so while the outcome is unrecorded it is also
 * evidence its dispatch records it from, for this write only. A write a later
 * request superseded leaves the issue to that request. A write that lapsed
 * before its first add published nothing, which is recorded as a refusal
 * would be, unless a later request holds the issue.
 */
async function publishRetry(db: Knex, deps: IssueFollowupDeps, context: PublishContext, request: IssueRetryRequest): Promise<Published> {
  const { input, trigger } = context;
  const added = await addTrigger(db, context, request, clock(deps));
  const applied = added === 'lapsed' ? false : added;
  const { recorded, superseded } = await recordTriggerOutcome(db, deps, { request, applied, redis: input.redis });
  if (added === 'lapsed') {
    await releaseClaim(input.redis, context.dedupeKey, context.correlationId);
    return { outcome: 'lapsed', recorded };
  }
  if (superseded) return { outcome: 'superseded', recorded };
  // GitHub may have applied the trigger or may still apply it, and its
  // relabel delivery or polling recovers the run; the held request keeps
  // its requester and instructions for that trigger only.
  if (applied === undefined) return { outcome: 'unconfirmed', recorded };
  if (!applied) {
    // GitHub refused the write, so no trigger of this request exists.
    await releaseClaim(input.redis, context.dedupeKey, context.correlationId);
    return { outcome: 'refused', recorded };
  }
  try {
    await (deps.enqueueIssue ?? enqueueIssueImplementationJob)({
      owner: input.owner, repo: input.repo, issueNumber: input.issueNumber, userId: request.requesterId,
      retryRequesterId: request.requesterId, retryCommentId: request.commentId!, retryPublishedAt: request.publishedAt!,
      triggeringLabel: trigger, correlationId: context.correlationId,
    });
  } catch (error) {
    // The queue may have accepted the job before failing; the trigger label
    // stays for polling, and the held request lets that recovery run it once
    // its outcome is recorded.
    console.warn(`[followup] Issue retry dispatch failed: ${(error as Error).message}`);
    return { outcome: 'unsubmitted', recorded };
  }
  return { outcome: recorded ? 'queued' : 'unrecorded', recorded };
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
  const { admissibleAt, consumedEventId } = await retryAdmission(db, owner, repo, issueNumber);
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

  // Read as dispatch reads it, keeping the submission's consumed trigger however it is labelled now.
  const baseline = await triggerBaseline(octokit, input, triggers, [consumedEventId]);
  if (!baseline) {
    return refused(502, `Issue #${issueNumber}'s label history could not be read, so the retry could not be tied to its trigger. Try again.`);
  }

  const correlationId = generateCorrelationId();
  const dedupeKey = `issue:dedup:${owner}:${repo}:${issueNumber}`;
  // Reserved before anything is posted or published: a relabel delivery that
  // recovers a failed enqueue carries neither the requester nor the comment to
  // exempt, and it is bound to the trigger it publishes, so a later,
  // independent trigger cannot adopt it.
  const requestedAt = clock(deps)();
  const claimed = await claimRetry(db, input, { events: baseline.events, now: requestedAt, consumedEventId },
    { dedupeKey, correlationId, request: { requesterId: userId, requestedAt, afterEventId: baseline.afterEventId },
      refresh: retained => triggerLabelEvents(octokit, issueKeyOf(input), new Set(triggers), [consumedEventId, ...retained]) });
  if ('status' in claimed) return claimed;
  const publishing = { input, octokit, trigger, triggers, dedupeKey, correlationId };
  if ('stranded' in claimed) return restartRetry(db, deps, publishing, claimed.stranded);
  const reservation = claimed.reserved;
  const abandon = async () => {
    await releaseIssueRetryReservation(db, reservation).catch(() => undefined);
    await releaseClaim(redis, dedupeKey, correlationId);
  };

  let commentId: number;
  let actorId: number | null;
  try {
    ({ commentId, actorId } = await postRequest(octokit, input, body));
  } catch (error) {
    await abandon();
    throw error;
  }
  console.log(`[followup] Posted retry request (ID: ${commentId}) to ${owner}/${repo}#${issueNumber}`);
  const posted = { posted: true, commentId, sourceTaskId: task.task_id, intent: 'issue', issueNumber };

  const notStarted = (reason: string): FollowupResult => ({
    status: 202, body: { success: false, state: 'failed', ...posted, message: `Comment posted, but the retry could not be started. ${reason}` },
  });

  const retryRequest = await beginPublication(db, deps, publishing, { reservation, posted: { commentId, actorId } });
  if (typeof retryRequest === 'string') {
    await abandon();
    return notStarted(retryRequest);
  }

  const jobId = `issue-${owner}-${repo}-${issueNumber}`;
  const published = await publishRetry(db, deps, publishing, retryRequest);
  const { outcome } = published;
  if (outcome === 'refused') return notStarted(`Make sure issue #${issueNumber} has the '${trigger}' label, then try again.`);
  if (outcome === 'lapsed') {
    return notStarted(`Its publication lapsed before the '${trigger}' label was added, because it took too long or a later retry took the issue over, so no label was added. Inspect issue #${issueNumber} before retrying.`);
  }
  if (outcome === 'queued') return { status: 202, body: { success: true, state: 'queued', jobId, ...posted, message: `Retry queued on issue #${issueNumber}.` } };
  const messages: Record<typeof outcome, string> = {
    superseded: `Comment posted, but a later retry of issue #${issueNumber} took the issue over before this one's '${trigger}' label was recorded, so this request may not start. Inspect issue #${issueNumber} before retrying.`,
    unconfirmed: `Comment posted, but whether the '${trigger}' label was applied could not be confirmed, so the retry may still start. Inspect issue #${issueNumber} before retrying.`,
    unsubmitted: 'Comment posted, but submission could not be confirmed. Inspect the comment and any job receipt before retrying.',
    unrecorded: `Comment posted and the retry submitted, but its '${trigger}' label could not be recorded yet, so it starts once that record is saved. Inspect issue #${issueNumber} before retrying.`,
  };
  return { status: 202, body: { success: false, state: 'unknown', jobId, ...posted, message: messages[outcome] + strandedHint(published) } };
}

/**
 * Restarts a stranded earlier request instead of posting the new one: its
 * trigger write's outcome was lost and the write can no longer land, so no
 * delivery can tell whether the trigger it may have published is its own.
 * A fresh trigger write, after a fresh baseline, is; the request runs on it
 * for its own requester with its own instructions, and the new follow-up is
 * refused so its author can send it once that run finishes.
 */
async function restartRetry(db: Knex, deps: IssueFollowupDeps, context: PublishContext, request: IssueRetryRequest): Promise<FollowupResult> {
  const { input, trigger, dedupeKey } = context;
  const { issueNumber } = input;
  const earlier = `Issue #${issueNumber}'s earlier retry (comment ${request.commentId}) was never confirmed to start`;
  const receipt = (state: ReturnType<typeof outcomeState>, message: string): FollowupResult => ({ status: 202, body: {
    success: false, state: 'refused', posted: false, commentId: request.commentId, sourceTaskId: input.task.task_id, intent: 'issue', issueNumber,
    ...(state === 'failed' ? {} : { jobId: `issue-${input.owner}-${input.repo}-${issueNumber}` }),
    restartedRequest: { state, commentId: request.commentId },
    message: `${message} Your new message was not posted${state === 'failed' ? '.' : '; send it again once that run finishes.'}`,
  } });
  console.log(`[followup] Restarting stranded retry request ${request.id} (comment ${request.commentId}) on ${input.owner}/${input.repo}#${issueNumber}`);

  // The restart's baseline is read just before it is recorded, so a trigger
  // another flow of the app's identity labelled since the follow-up began,
  // which a delivery may already have consumed, is not taken for its own.
  const baseline = await triggerBaseline(context.octokit, input, context.triggers);
  if (!baseline) {
    await releaseClaim(input.redis, dedupeKey, context.correlationId);
    return receipt('failed', `${earlier}, and issue #${issueNumber}'s label history could not be read, so it could not be restarted. Try again.`);
  }
  // The restart is recorded before anything on the issue is changed, and only
  // while the request is as it was read; otherwise it is left as it is.
  const restarted = await restartIssueRetryPublication(db, request, baseline.afterEventId, clock(deps)()).catch((error: Error) => {
    console.warn(`[followup] Could not record the restart of retry request ${request.id}: ${error.message}`);
    return null;
  });
  if (!restarted) {
    await releaseClaim(input.redis, dedupeKey, context.correlationId);
    return receipt('failed', `${earlier}, and it could not be restarted. Try again.`);
  }

  const published = await publishRetry(db, deps, context, restarted);
  const messages: Record<PublishOutcome, string> = {
    queued: `${earlier}, so it was restarted and queued with its original instructions for its original requester.`,
    refused: `${earlier}, and GitHub refused the restart's '${trigger}' label, so it is still waiting. Make sure the label can be applied, then follow up again.`,
    lapsed: `${earlier}, and its restart lapsed before its '${trigger}' label was added, because it took too long or a later retry took the issue over, so no label was added.`,
    superseded: `${earlier}, and a later retry took the issue over while it was restarted.`,
    unconfirmed: `${earlier}, so it was restarted with its original instructions, but whether its '${trigger}' label was applied could not be confirmed.`,
    unsubmitted: `${earlier}, so it was restarted with its original instructions, but its submission could not be confirmed.`,
    unrecorded: `${earlier}, so it was restarted with its original instructions and submitted, but its '${trigger}' label could not be recorded yet.`,
  };
  return receipt(outcomeState(published.outcome), messages[published.outcome] + strandedHint(published));
}
