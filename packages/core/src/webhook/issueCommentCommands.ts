import type { IssueCommentEvent } from '@octokit/webhooks-types';
import { randomUUID } from 'node:crypto';
import type { Redis } from 'ioredis';
import logger, { generateCorrelationId } from '../utils/logger.js';
import { filterCommentByAuthor, checkCommentIgnore } from '../utils/commentFilters.js';
import type { DeliveryDisposition } from '../intake/routingWebSocketProtocol.js';
import type { IssueJobData } from '../queue/taskQueue.types.js';
import { resolveCommentPluginCommand } from '../plugins/pluginCommands.js';
import {
  issueCommandIntentKey, issueJobCarriesCommand, pendingIssueCommandIntent, readIssueCommandIntent, recordIssueCommandIntent,
  releaseIssueCommandIntent, retireIssueCommandIntent, withdrawIssueCommandIntent, type StoredIssueCommandIntent,
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
 */
export interface IssueCommandDependencies {
  redis: Pick<Redis, 'get' | 'set' | 'del' | 'eval'>;
  github?: () => Promise<{ request(route: string, parameters: Record<string, unknown>): Promise<unknown> }>;
  /**
   * Adds a job to the issue queue, then resolves to the data of the job stored
   * under `jobId` (null when there is none): an add whose ID is taken keeps
   * the existing job.
   */
  enqueue?: (data: IssueJobData, jobId: string) => Promise<Partial<IssueJobData> | null>;
  /** Whether a parent job for the issue is already active, waiting or delayed for a retry. */
  hasQueuedIssueJob?: (repoOwner: string, repoName: string, number: number) => Promise<boolean>;
  primaryLabels?: () => Promise<string[]>;
  ignoreKeywords?: () => Promise<string[]>;
}

const DEDUPE_TTL_SECONDS = 30;
const CLAIM_TTL_SECONDS = 86400;
/** Deletes a key only while it still holds the caller's reservation token. */
const RELEASE_OWNED_SCRIPT = "if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('del', KEYS[1]) else return 0 end";

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
  const resolution = await resolveCommentPluginCommand({ body: comment.body, repository, target: 'issue', author });
  if (resolution.status === 'none') return IGNORED;

  // The trigger access rules of comment commands.
  if (filterCommentByAuthor(author, comment.user.type ?? null, correlationId).shouldFilter) return { status: 'ignored', reason: 'filtered_author' };
  if (checkCommentIgnore(comment.body, await (deps.ignoreKeywords ?? defaultIgnoreKeywords)(), correlationId).shouldIgnore) return { status: 'ignored', reason: 'ignore_keyword' };

  const claimKey = `issue-comment-command:${owner}:${repo}:${issue.number}:${comment.id}`;
  if (await deps.redis.set(claimKey, Date.now().toString(), 'EX', CLAIM_TTL_SECONDS, 'NX') !== 'OK') return { status: 'ignored', reason: 'duplicate_delivery' };
  const dedupeKey = `issue:dedup:${owner}:${repo}:${issue.number}`;
  const intentKey = issueCommandIntentKey(owner, repo, issue.number);
  // Set only once this attempt holds the issue's dedupe window, so a failure
  // releases that window and an immediate redelivery can start the task.
  let dedupeToken: string | null = null;
  // The record this attempt wrote, while a failure must decide its fate, and
  // the record it replaced. The record outlives a failure only while the label
  // this attempt requested may be on the issue: only that label's webhook can
  // still carry it into a job.
  let recorded: string | null = null;
  let earlier: StoredIssueCommandIntent | null = null;
  let labelMayBePublished = false;
  const alreadyStarted = (): DeliveryDisposition => {
    log.info({ repository, issueNumber: issue.number, commentId: comment.id }, 'Plugin command already started through its processing label');
    return { status: 'ignored', reason: 'duplicate_delivery' };
  };
  try {
    const github = await (deps.github ?? defaultGitHub)();
    const reply = (text: string) => github.request('POST /repos/{owner}/{repo}/issues/{issue_number}/comments', { owner, repo, issue_number: issue.number, body: `@${author} ${text}` });
    // Reports the command as not started. Its own pending record, left by an
    // earlier attempt whose label could still start it, is retired first, so
    // no later label event runs a command ProPR refused, nor a job a label
    // event queued with it before the refusal. A command a label event
    // claimed, or a dispatcher started, meanwhile is not reported.
    const refuse = async (text: string, reason: string): Promise<DeliveryDisposition> => {
      if (await retireIssueCommandIntent(deps.redis, intentKey, comment.id) === 'started') return alreadyStarted();
      await reply(text);
      return { status: 'ignored', reason };
    };
    if (resolution.status === 'refused') {
      log.info({ repository, issueNumber: issue.number, plugin: resolution.pluginId, command: resolution.command }, 'Plugin command refused');
      return await refuse(resolution.message, 'plugin_command_refused');
    }
    const { run } = resolution;
    // An earlier attempt for this comment published the label and failed to
    // queue; the label's webhook then queued the job carrying this command.
    earlier = await readIssueCommandIntent(deps.redis, intentKey);
    if (earlier?.intent.state === 'queued' && earlier.intent.commentId === comment.id) return alreadyStarted();
    const primaryLabels = await (deps.primaryLabels ?? defaultPrimaryLabels)();
    // New work starts with the first label; work started through any configured
    // label family makes the issue busy.
    const [triggeringLabel] = primaryLabels;
    if (!triggeringLabel) throw new Error('No primary processing label is configured');
    const labels = issue.labels?.map(label => label.name) ?? [];
    const lifecycle = lifecycleLabels(primaryLabels);
    const busy = labels.find(label => lifecycle.includes(label));
    const token = `${correlationId}:${randomUUID()}`;
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
    // issue's work without this attempt.
    const userId = String(payload.sender.id);
    const intentValue = pendingIssueCommandIntent({ commentId: comment.id, userId, pluginCommand: run, token });
    recorded = intentValue;
    await recordIssueCommandIntent(deps.redis, intentKey, intentValue);
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
    const jobId = `issue-${owner}-${repo}-${issue.number}`;
    const stored = await (deps.enqueue ?? defaultEnqueue)(data, jobId);
    if (!stored) throw new Error(`The issue job ${jobId} was not found after queueing it`);
    if (!issueJobCarriesCommand(stored, data)) {
      // The ID belongs to work queued since the busy check, which runs without
      // this command: refuse it. The record it replaced is put back when it is
      // another comment's; this comment's own earlier record is not, since the
      // command is now reported as not started.
      log.info({ repository, issueNumber: issue.number, commentId: comment.id, jobId }, 'Plugin command not started: the issue job ID is held by other work');
      await withdrawIssueCommandIntent(deps.redis, intentKey, intentValue, earlier?.intent.commentId === comment.id ? null : earlier);
      recorded = null;
      await deps.redis.eval(RELEASE_OWNED_SCRIPT, 1, dedupeKey, token);
      dedupeToken = null;
      return await refuse(`/${run.command} was not started: a ProPR task for this issue is already starting or running. Run the command again when it has finished.`, 'job_already_queued');
    }
    recorded = null;
    // The queued job carries the command; a later label event must not. When
    // this release fails, the job's dispatcher settles the record it names.
    await releaseIssueCommandIntent(deps.redis, intentKey, intentValue).catch((err: unknown) => {
      log.warn({ repository, issueNumber: issue.number, err }, 'Could not release the plugin command intent of a queued task; the job\'s dispatcher settles it');
    });
    log.info({ repository, issueNumber: issue.number, commentId: comment.id, plugin: run.pluginId, command: run.command }, `Plugin command /${run.command} started an implementation task`);
    return { status: 'accepted', billing: { seatConsumed: !/\[bot\]$/i.test(author) } };
  } catch (error) {
    // This attempt created no task: release what it reserved so a redelivery
    // is handled afresh. The dedupe window is released only while it is still
    // this attempt's, never one a later label event or command has taken. The
    // command intent is kept while the label this attempt requested may be on
    // the issue: that label makes label-triggered intake queue the command,
    // not command-less work. Without such a label (GitHub refused it, it was
    // never requested, or the failure came first) no label event is this
    // command's, so the record is withdrawn, putting back the one it replaced.
    const releases = await Promise.allSettled([
      ...(dedupeToken ? [deps.redis.eval(RELEASE_OWNED_SCRIPT, 1, dedupeKey, dedupeToken)] : []),
      ...(recorded && !labelMayBePublished ? [withdrawIssueCommandIntent(deps.redis, intentKey, recorded, earlier)] : []),
      deps.redis.del(claimKey),
    ]);
    for (const release of releases) {
      if (release.status === 'rejected') log.warn({ repository, issueNumber: issue.number, err: release.reason }, 'Could not release a plugin command reservation');
    }
    throw error;
  }
}
