import type { IssueCommentEvent } from '@octokit/webhooks-types';
import { randomUUID } from 'node:crypto';
import type { Redis } from 'ioredis';
import logger, { generateCorrelationId } from '../utils/logger.js';
import { filterCommentByAuthor, checkCommentIgnore } from '../utils/commentFilters.js';
import { commentSeatConsumed } from './followupAssignmentGate.js';
import type { DeliveryDisposition } from '../intake/routingWebSocketProtocol.js';
import type { IssueJobData } from '../queue/taskQueue.types.js';
import { authorizeCommentPluginCommand, discardCommentPluginCommandWriteGrant, resolveCommentPluginCommand, type PluginCommandDelivery, type PluginCommandRun } from '../plugins/pluginCommands.js';
import { enqueueCommentPluginCommand, type PluginCommandContext } from '../plugins/pluginCommandDeliveries.js';
import {
  issueCommandIntentKey, issueJobCarriesCommand, pendingIssueCommandIntent, readIssueCommandIntent, recordIssueCommandIntent,
  reconcileIssueCommand, releaseIssueCommandIntent, retireIssueCommandIntent, withdrawIssueCommandIntent, type StoredIssueCommandIntent,
} from '../plugins/issueCommandIntent.js';

/**
 * Plugin commands in issue comments. ProPR has no built-in issue command, so
 * an issue comment is only ever acted on here when it is a `prompt` command an
 * enabled plugin contributes for issues of this repository; every other issue
 * comment keeps today's behaviour (ignored).
 *
 * The command starts an ordinary implementation task, the same one the
 * issue's processing label starts: the intake applies the first primary
 * processing label and queues the issue's matrix dispatch with the command's
 * instruction and library additions. The label-detection path's dedupe key is
 * taken first, so the label webhook that follows does not queue a second,
 * command-less dispatch. The command is also recorded as the issue's pending
 * command intent before the label is published: if the enqueue then fails,
 * the published label's webhook queues the job carrying the command instead
 * of ordinary work (see `issueCommandIntent.ts`). A command ProPR reports as
 * not started, or whose label GitHub refused, leaves no pending record for a
 * later label event to run, and its attempt token is retired, so a job that
 * already holds it runs without the command. Access follows the comment
 * trigger rules: the author filters (allowlist, blocklist, bots) and the
 * ignore keywords.
 *
 * The comment's claim is a lease while an attempt is processing it, and
 * becomes evidence that the comment was handled only once the attempt's
 * outcome is known: its job is queued, or its refusal is reported. A process
 * that stops in between leaves a claim that runs out, so the relay's
 * redelivery (which it makes because no ACK was sent) starts the command
 * afresh; while the claim runs, a redelivery is left unacknowledged, so it is
 * made again later. An attempt's own earlier record is reconciled against the
 * job evidence before it is replaced, and replaced only while unchanged, so
 * a command that was carried meanwhile is never started a second time. A
 * record the label path has claimed but no job carries yet is a reservation,
 * not a started command: while its lease runs, the delivery (whether it would
 * start or refuse the command) is left unacknowledged too, so it comes back
 * once the claim has either queued its job or run out, and a claim whose
 * process stopped is recovered without any new event.
 */
export interface IssueCommandDependencies {
  redis: Pick<Redis, 'get' | 'set' | 'eval'>;
  github?: () => Promise<{ request(route: string, parameters: Record<string, unknown>): Promise<unknown> }>;
  /**
   * Adds a job to the issue queue, then resolves to the data of the job stored
   * under `jobId` (null when there is none): an add whose ID is taken keeps
   * the existing job.
   */
  enqueue?: (data: IssueJobData, jobId: string) => Promise<Partial<IssueJobData> | null>;
  /** Whether a parent job for the issue is already active, waiting or delayed for a retry. */
  hasQueuedIssueJob?: (repoOwner: string, repoName: string, number: number) => Promise<boolean>;
  /** The data of the job stored under the issue's deterministic job ID, or null when there is none. */
  storedIssueJob?: (jobId: string) => Promise<Partial<IssueJobData> | null>;
  primaryLabels?: () => Promise<string[]>;
  ignoreKeywords?: () => Promise<string[]>;
}

const DEDUPE_TTL_SECONDS = 30;
/** How long a handled comment's claim answers redeliveries, the window in which GitHub or the relay redelivers one. */
const CLAIM_TTL_SECONDS = 86400;
/**
 * How long a comment's claim stands while its attempt is processing and no
 * outcome is recorded yet. Longer than an attempt takes (its GitHub sign-in,
 * label request and queue add with their retries take seconds), so a live
 * attempt is not taken for a stopped one; a stopped attempt's command waits
 * this long for the relay's redelivery to start it afresh.
 */
export const COMMENT_CLAIM_LEASE_SECONDS = 120;
/** Bounds the re-reads when the issue's command record changes between a read and the conditional write that depends on it. */
const RECORD_ATTEMPTS = 5;
/** Deletes a key only while it still holds the caller's reservation token. */
const RELEASE_OWNED_SCRIPT = "if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('del', KEYS[1]) else return 0 end";
/** Replaces a key's value with ARGV[2] for ARGV[3] seconds only while it still holds the caller's reservation token ARGV[1]. */
const REPLACE_OWNED_SCRIPT = "if redis.call('get', KEYS[1]) == ARGV[1] then redis.call('set', KEYS[1], ARGV[2], 'EX', ARGV[3]) return 1 else return 0 end";

/** The comment claim of an attempt still processing: it runs out with its lease. */
const processingClaim = (token: string) => `processing:${token}`;
/** The comment claim once the attempt's outcome is known: the redelivery evidence. */
const handledClaim = (token: string) => `handled:${token}`;
/** Whether a claim another delivery holds is still processing (a claim from before claims were leased counts as handled). */
const claimStillProcessing = (held: string | null) => held === null || held.startsWith('processing:');

/** The lifecycle labels of every configured processing label family. */
function lifecycleLabels(primaryLabels: string[]): string[] {
  return primaryLabels.flatMap(label => [`${label}-processing`, `${label}-done`, `${label}-cancelled`]);
}

/**
 * Whether GitHub answered the label request with a client error (4xx): it
 * refused the request, so the label was not applied. A network failure (which
 * Octokit reports as 500), a server error or no answer leaves it unknown.
 */
function labelRefused(error: unknown): boolean {
  const status = (error as { status?: unknown } | null)?.status;
  return typeof status === 'number' && status >= 400 && status < 500;
}

async function defaultGitHub() {
  const { getAuthenticatedOctokit } = await import('../auth/githubAuth.js');
  return await getAuthenticatedOctokit() as unknown as { request(route: string, parameters: Record<string, unknown>): Promise<unknown> };
}
async function defaultEnqueue(data: IssueJobData, jobId: string): Promise<Partial<IssueJobData> | null> {
  const { getIssueQueue } = await import('../queue/taskQueue.js');
  const queue = await getIssueQueue();
  await queue.add('processGitHubIssue', data, { jobId, attempts: 3, backoff: { type: 'exponential', delay: 2000 }, removeOnComplete: true, removeOnFail: true });
  // The returned job holds the data passed in even when the ID was taken; the stored job is read back.
  const job = await queue.getJob(jobId);
  return (job?.data as Partial<IssueJobData> | undefined) ?? null;
}
async function defaultStoredIssueJob(jobId: string): Promise<Partial<IssueJobData> | null> {
  const { getIssueQueue } = await import('../queue/taskQueue.js');
  const job = await (await getIssueQueue()).getJob(jobId);
  return (job?.data as Partial<IssueJobData> | undefined) ?? null;
}
async function defaultHasQueuedIssueJob(repoOwner: string, repoName: string, number: number): Promise<boolean> {
  const { getIssueQueue } = await import('../queue/taskQueue.js');
  const queue = await getIssueQueue();
  // A parent waiting out a retry backoff still owns the issue's deterministic job ID.
  const jobs = [...await queue.getActive(), ...await queue.getWaiting(), ...await queue.getDelayed()];
  return jobs.some(job => {
    const data = job.data as Partial<IssueJobData>;
    return job.name === 'processGitHubIssue' && data.repoOwner === repoOwner && data.repoName === repoName && data.number === number && !data.isChildJob;
  });
}
async function defaultPrimaryLabels(): Promise<string[]> {
  const { getPrimaryProcessingLabels, loadPrimaryProcessingLabelsFromConfig } = await import('../daemon/configLoader.js');
  if (!getPrimaryProcessingLabels().length) await loadPrimaryProcessingLabelsFromConfig();
  return getPrimaryProcessingLabels();
}
async function defaultIgnoreKeywords(): Promise<string[]> {
  const { loadFollowupIgnoreKeywords } = await import('../config/configManager.js');
  return loadFollowupIgnoreKeywords();
}

const IGNORED: DeliveryDisposition = { status: 'ignored', reason: 'not_pull_request_comment' };

/** Record a `handler` command's delivery to its plugin's handler. */
async function deliverHandlerCommand(delivery: PluginCommandDelivery, context: PluginCommandContext, log: ReturnType<typeof logger.withCorrelation>, seatConsumed: boolean): Promise<DeliveryDisposition> {
  const recorded = await enqueueCommentPluginCommand(delivery, context);
  log.info({ repository: context.repository, number: context.number, commentId: context.commentId, plugin: delivery.pluginId, command: delivery.command, recorded }, recorded
    ? `Plugin command /${delivery.command} queued for its handler` : `Plugin command /${delivery.command} was already queued, or its plugin is no longer enabled`);
  return recorded ? { status: 'accepted', billing: { seatConsumed } } : { status: 'ignored', reason: 'duplicate_delivery' };
}

/** Handle a created comment on an issue (not a pull request). */
// eslint-disable-next-line complexity -- the access, refusal and start steps of one command stay in reading order
export async function processIssueCommentCommand(payload: IssueCommentEvent, correlationId: string, deps: IssueCommandDependencies): Promise<DeliveryDisposition> {
  if (payload.action !== 'created' || payload.issue.pull_request) return IGNORED;
  const log = logger.withCorrelation(correlationId);
  const owner = payload.repository.owner.login;
  const repo = payload.repository.name;
  const repository = `${owner}/${repo}`;
  const { comment, issue } = payload;
  const author = comment.user.login;
  const matched = await resolveCommentPluginCommand({ body: comment.body, repository, target: 'issue', author, number: issue.number });
  if (matched.status === 'none') return IGNORED;

  // The trigger access rules of comment commands.
  if (filterCommentByAuthor(author, comment.user.type ?? null, correlationId).shouldFilter) return { status: 'ignored', reason: 'filtered_author' };
  if (checkCommentIgnore(comment.body, await (deps.ignoreKeywords ?? defaultIgnoreKeywords)(), correlationId).shouldIgnore) return { status: 'ignored', reason: 'ignore_keyword' };
  // A handler command starts no task: its delivery is recorded once per comment (a redelivery finds it recorded).
  if (matched.status === 'handler') return deliverHandlerCommand(matched.delivery, { repository, number: issue.number, target: 'issue', commentType: 'issue', actor: author, commentId: comment.id }, log, commentSeatConsumed(author, comment.user.type ?? null));

  // This attempt's token: its comment claim, the issue's dedupe window and
  // its command record are released or replaced only while they still hold it.
  const token = `${correlationId}:${randomUUID()}`;
  const claimKey = `issue-comment-command:${owner}:${repo}:${issue.number}:${comment.id}`;
  const claimValue = processingClaim(token);
  if (await deps.redis.set(claimKey, claimValue, 'EX', COMMENT_CLAIM_LEASE_SECONDS, 'NX') !== 'OK') {
    if (claimStillProcessing(await deps.redis.get(claimKey))) {
      // Not acknowledged: the relay redelivers it later, when the earlier
      // attempt has either recorded its outcome or stopped and its claim has run out.
      log.info({ repository, issueNumber: issue.number, commentId: comment.id }, 'Plugin command is still being processed by an earlier delivery; leaving the redelivery for later');
      throw new Error(`The plugin command in comment ${comment.id} is still being processed by an earlier delivery`);
    }
    return { status: 'ignored', reason: 'duplicate_delivery' };
  }
  // Records the outcome of this attempt on its claim: from now on a redelivery
  // of the comment is handled. A write that fails leaves the claim to run out
  // like a stopped attempt's; the caller then keeps the evidence a redelivery
  // reconciles instead.
  const markHandled = async (): Promise<boolean> => {
    try {
      return await deps.redis.eval(REPLACE_OWNED_SCRIPT, 1, claimKey, claimValue, handledClaim(token), String(CLAIM_TTL_SECONDS)) === 1;
    } catch (err) {
      log.warn({ repository, issueNumber: issue.number, commentId: comment.id, err }, 'Could not record the plugin command\'s outcome on its comment claim');
      return false;
    }
  };
  const handled = async (disposition: DeliveryDisposition): Promise<DeliveryDisposition> => {
    await markHandled();
    return disposition;
  };
  const dedupeKey = `issue:dedup:${owner}:${repo}:${issue.number}`;
  const intentKey = issueCommandIntentKey(owner, repo, issue.number);
  const jobId = `issue-${owner}-${repo}-${issue.number}`;
  // Whether a job carries a record: a record alone is a reservation, left
  // behind when the attempt or claim that wrote it was interrupted.
  const evidence = { storedJobData: () => (deps.storedIssueJob ?? defaultStoredIssueJob)(jobId) };
  // The classification of pull request comment commands: a GitHub App, one of
  // ProPR's own logins or a `[bot]` login consumes no seat.
  const seatConsumed = commentSeatConsumed(author, comment.user.type ?? null);
  // Set only once this attempt holds the issue's dedupe window, so a failure
  // releases that window and an immediate redelivery can start the task.
  let dedupeToken: string | null = null;
  // The record this attempt wrote, while a failure must decide its fate, and
  // the record a withdrawal puts back. The record outlives a failure only
  // while the label this attempt requested may be on the issue: only that
  // label's webhook can still carry it into a job.
  let recorded: string | null = null;
  let replaced: StoredIssueCommandIntent | null = null;
  let labelMayBePublished = false;
  // The authorized run, and whether its intent record (which carries the
  // run's write grant to a label-path job or this attempt's job) may have
  // been written. Until then nothing but this attempt holds the grant.
  let authorized: PluginCommandRun | undefined;
  let intentMayBeRecorded = false;
  const alreadyStarted = (): DeliveryDisposition => {
    log.info({ repository, issueNumber: issue.number, commentId: comment.id }, 'Plugin command already started through its processing label');
    return { status: 'ignored', reason: 'duplicate_delivery' };
  };
  // The label path's claim of this comment's command is still within its
  // lease and no job carries it: it may be queueing, or its process stopped.
  // Neither is known yet, so this delivery is not acknowledged: the relay
  // makes it again, and that attempt finds the job, or the claim run out and
  // the command its own to start or refuse. The claim this attempt holds is
  // released on the way out, so that redelivery is not blocked by it.
  const claimInFlight = (): Error => {
    log.info({ repository, issueNumber: issue.number, commentId: comment.id }, 'Plugin command is being queued by its processing label; leaving the delivery for later');
    return new Error(`The plugin command in comment ${comment.id} is being queued by the issue's processing label; it is settled by a later delivery`);
  };
  try {
    const github = await (deps.github ?? defaultGitHub)();
    const reply = (text: string) => github.request('POST /repos/{owner}/{repo}/issues/{issue_number}/comments', { owner, repo, issue_number: issue.number, body: `@${author} ${text}` });
    // Settled only now that this attempt holds the comment's claim: a redelivery
    // reads no write permission and creates no write grant.
    const resolution = await authorizeCommentPluginCommand(matched);
    // Reports the command as not started. Its own pending record, left by an
    // earlier attempt whose label could still start it, is retired first, so
    // no later label event runs a command ProPR refused, nor a job a label
    // event queued with it before the refusal. A command a label event
    // carried into a job, or a dispatcher started, meanwhile is not reported.
    // One a label event has claimed but not yet queued is neither reported
    // nor retired: the refusal waits for a later delivery, like the start.
    const refuse = async (text: string, reason: string): Promise<DeliveryDisposition> => {
      const fate = await retireIssueCommandIntent(deps.redis, intentKey, comment.id, evidence);
      if (fate === 'started') return await handled(alreadyStarted());
      if (fate === 'in_flight') throw claimInFlight();
      await reply(text);
      return await handled({ status: 'ignored', reason });
    };
    if (resolution.status === 'refused') {
      log.info({ repository, issueNumber: issue.number, plugin: resolution.pluginId, command: resolution.command }, 'Plugin command refused');
      return await refuse(resolution.message, 'plugin_command_refused');
    }
    const { run } = resolution;
    authorized = run;
    const primaryLabels = await (deps.primaryLabels ?? defaultPrimaryLabels)();
    // New work starts with the first label; work started through any configured
    // label family makes the issue busy.
    const [triggeringLabel] = primaryLabels;
    if (!triggeringLabel) throw new Error('No primary processing label is configured');
    const labels = issue.labels?.map(label => label.name) ?? [];
    const lifecycle = lifecycleLabels(primaryLabels);
    const busy = labels.find(label => lifecycle.includes(label));
    const userId = String(payload.sender.id);
    const intentValue = pendingIssueCommandIntent({ commentId: comment.id, userId, seatConsumed, pluginCommand: run, token });
    for (let attempt = 0; ; attempt++) {
      // An earlier attempt for this comment recorded the command and stopped
      // (before or after queueing its job), or published the label and failed
      // to queue, and the label's webhook then queued (or is queueing) the job
      // carrying the command. Its record is reconciled against the job
      // evidence whatever its state: a job that names its token, or a token a
      // dispatcher carried, is a started command, which must not be started a
      // second time. A record nothing carries is this attempt's to start
      // afresh: it is replaced below. A stale label-path claim is not put back
      // if this attempt fails too; this comment's own pending record is, since
      // the label it published may still carry it.
      const earlier = await readIssueCommandIntent(deps.redis, intentKey);
      replaced = earlier;
      if (earlier?.intent.commentId === comment.id) {
        const verdict = await reconcileIssueCommand(deps.redis, intentKey, earlier.intent, evidence);
        if (verdict === 'started') return await handled(alreadyStarted());
        // Nothing this attempt reserved yet needs releasing beyond its comment
        // claim, which the failure path releases.
        if (verdict === 'in_flight') throw claimInFlight();
        log.info({ repository, issueNumber: issue.number, commentId: comment.id, state: earlier.intent.state }, 'Plugin command recorded by an interrupted attempt and never queued; starting it afresh');
        if (earlier.intent.state === 'queued') replaced = null;
      }
      if (busy || await (deps.hasQueuedIssueJob ?? defaultHasQueuedIssueJob)(owner, repo, issue.number)
        || await deps.redis.set(dedupeKey, token, 'EX', DEDUPE_TTL_SECONDS, 'NX') !== 'OK') {
        return await refuse(busy
          ? `/${run.command} was not started: this issue already has the ${busy} label. Remove it to start a new task.`
          : `/${run.command} was not started: a ProPR task for this issue is already starting or running. Run the command again when it has finished.`,
        'job_already_queued');
      }
      dedupeToken = token;
      // Recorded before the label is published and kept if this attempt fails
      // once the label may be on the issue: that label may then start the
      // issue's work without this attempt. Written only over the record read
      // above: one that changed meanwhile (a label event claimed this comment's
      // command, a dispatcher settled it, or another command recorded its own)
      // is reconciled again, not overwritten.
      recorded = intentValue;
      intentMayBeRecorded = true;
      if (await recordIssueCommandIntent(deps.redis, intentKey, intentValue, earlier?.raw ?? null)) break;
      // The conditional write did not happen: the record does not name this attempt's run.
      intentMayBeRecorded = false;
      recorded = null;
      await deps.redis.eval(RELEASE_OWNED_SCRIPT, 1, dedupeKey, token);
      dedupeToken = null;
      if (attempt + 1 >= RECORD_ATTEMPTS) throw new Error(`The plugin command intent ${intentKey} kept changing while the command was recorded`);
      log.info({ repository, issueNumber: issue.number, commentId: comment.id }, 'The issue\'s plugin command record changed while the command was recorded; reconciling it again');
    }
    if (!labels.includes(triggeringLabel)) {
      labelMayBePublished = true;
      await github.request('POST /repos/{owner}/{repo}/issues/{issue_number}/labels', { owner, repo, issue_number: issue.number, labels: [triggeringLabel] })
        .catch((error: unknown) => {
          labelMayBePublished = !labelRefused(error);
          throw error;
        });
    }
    const data: IssueJobData = {
      repoOwner: owner, repoName: repo, number: issue.number, userId, triggeringLabel,
      correlationId: generateCorrelationId(), pluginCommand: run, pluginCommandIntent: token,
    };
    const stored = await (deps.enqueue ?? defaultEnqueue)(data, jobId);
    if (!stored) throw new Error(`The issue job ${jobId} was not found after queueing it`);
    if (!issueJobCarriesCommand(stored, data)) {
      // The ID belongs to work queued since the busy check, which runs without
      // this command: refuse it. The record it replaced is put back when it is
      // another comment's; this comment's own earlier record is not, since the
      // command is now reported as not started.
      log.info({ repository, issueNumber: issue.number, commentId: comment.id, jobId }, 'Plugin command not started: the issue job ID is held by other work');
      await withdrawIssueCommandIntent(deps.redis, intentKey, intentValue, replaced?.intent.commentId === comment.id ? null : replaced);
      recorded = null;
      await deps.redis.eval(RELEASE_OWNED_SCRIPT, 1, dedupeKey, token);
      dedupeToken = null;
      return await refuse(`/${run.command} was not started: a ProPR task for this issue is already starting or running. Run the command again when it has finished.`, 'job_already_queued');
    }
    recorded = null;
    // The queued job carries the command: the comment is handled, and a later
    // label event must not carry the command again. The record is released
    // once the claim records that outcome; while either write fails, the job
    // (which names the record) is the evidence, and its dispatcher settles the
    // record before it starts any work.
    if (await markHandled()) {
      await releaseIssueCommandIntent(deps.redis, intentKey, intentValue).catch((err: unknown) => {
        log.warn({ repository, issueNumber: issue.number, err }, 'Could not release the plugin command intent of a queued task; the job\'s dispatcher settles it');
      });
    }
    log.info({ repository, issueNumber: issue.number, commentId: comment.id, plugin: run.pluginId, command: run.command }, `Plugin command /${run.command} started an implementation task`);
    return { status: 'accepted', billing: { seatConsumed } };
  } catch (error) {
    // This attempt created no task, or must leave the command to a later
    // delivery: release what it reserved so a redelivery is handled afresh.
    // The dedupe window and the comment claim are released only while they
    // are still this attempt's, never ones a later label event, command or
    // redelivery has taken. The command intent is kept while
    // the label this attempt requested may be on the issue: that label makes
    // label-triggered intake queue the command, not command-less work. Without
    // such a label (GitHub refused it, it was never requested, or the failure
    // came first) no label event is this command's, so the record is
    // withdrawn, putting back the one it replaced.
    const releases = await Promise.allSettled([
      ...(dedupeToken ? [deps.redis.eval(RELEASE_OWNED_SCRIPT, 1, dedupeKey, dedupeToken)] : []),
      ...(recorded && !labelMayBePublished ? [withdrawIssueCommandIntent(deps.redis, intentKey, recorded, replaced)] : []),
      deps.redis.eval(RELEASE_OWNED_SCRIPT, 1, claimKey, claimValue),
    ]);
    for (const release of releases) {
      if (release.status === 'rejected') log.warn({ repository, issueNumber: issue.number, err: release.reason }, 'Could not release a plugin command reservation');
    }
    throw error;
  } finally {
    // A write grant created for a command that ended before its intent was
    // recorded (refused, already started elsewhere, or failed early) is
    // referenced by no record and no job: delete it. Once the record may
    // exist, a label-path or uncertain queue add may carry the grant, so it
    // is kept and expires on its own.
    if (authorized?.writeGrant && !intentMayBeRecorded) {
      await discardCommentPluginCommandWriteGrant(authorized).catch((err: unknown) => {
        log.warn({ repository, issueNumber: issue.number, plugin: authorized!.pluginId, command: authorized!.command, err }, 'Could not delete the unused write grant of a plugin command that did not start; it expires on its own');
      });
    }
  }
}
