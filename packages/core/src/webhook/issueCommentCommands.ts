import type { IssueCommentEvent } from '@octokit/webhooks-types';
import { randomUUID } from 'node:crypto';
import type { Redis } from 'ioredis';
import logger, { generateCorrelationId } from '../utils/logger.js';
import { filterCommentByAuthor, checkCommentIgnore } from '../utils/commentFilters.js';
import type { DeliveryDisposition } from '../intake/routingWebSocketProtocol.js';
import type { IssueJobData } from '../queue/taskQueue.types.js';
import { resolveCommentPluginCommand } from '../plugins/pluginCommands.js';

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
 * command-less dispatch. Access follows the comment trigger rules: the author
 * filters (allowlist, blocklist, bots) and the ignore keywords.
 */
export interface IssueCommandDependencies {
  redis: Pick<Redis, 'set' | 'del' | 'eval'>;
  github?: () => Promise<{ request(route: string, parameters: Record<string, unknown>): Promise<unknown> }>;
  /** Adds a job to the issue queue. */
  enqueue?: (data: IssueJobData, jobId: string) => Promise<void>;
  /** Whether a parent job for the issue is already active or waiting. */
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

async function defaultGitHub() {
  const { getAuthenticatedOctokit } = await import('../auth/githubAuth.js');
  return await getAuthenticatedOctokit() as unknown as { request(route: string, parameters: Record<string, unknown>): Promise<unknown> };
}
async function defaultEnqueue(data: IssueJobData, jobId: string): Promise<void> {
  const { getIssueQueue } = await import('../queue/taskQueue.js');
  await (await getIssueQueue()).add('processGitHubIssue', data, { jobId, attempts: 3, backoff: { type: 'exponential', delay: 2000 }, removeOnComplete: true, removeOnFail: true });
}
async function defaultHasQueuedIssueJob(repoOwner: string, repoName: string, number: number): Promise<boolean> {
  const { getIssueQueue } = await import('../queue/taskQueue.js');
  const queue = await getIssueQueue();
  const jobs = [...await queue.getActive(), ...await queue.getWaiting()];
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
  // Set only once this attempt holds the issue's dedupe window, so a failure
  // releases that window and an immediate redelivery can start the task.
  let dedupeToken: string | null = null;
  try {
    const github = await (deps.github ?? defaultGitHub)();
    const reply = (text: string) => github.request('POST /repos/{owner}/{repo}/issues/{issue_number}/comments', { owner, repo, issue_number: issue.number, body: `@${author} ${text}` });
    if (resolution.status === 'refused') {
      log.info({ repository, issueNumber: issue.number, plugin: resolution.pluginId, command: resolution.command }, 'Plugin command refused');
      await reply(resolution.message);
      return { status: 'ignored', reason: 'plugin_command_refused' };
    }
    const { run } = resolution;
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
      await reply(busy
        ? `/${run.command} was not started: this issue already has the ${busy} label. Remove it to start a new task.`
        : `/${run.command} was not started: a ProPR task for this issue is already starting or running. Run the command again when it has finished.`);
      return { status: 'ignored', reason: 'job_already_queued' };
    }
    dedupeToken = token;
    if (!labels.includes(triggeringLabel)) {
      await github.request('POST /repos/{owner}/{repo}/issues/{issue_number}/labels', { owner, repo, issue_number: issue.number, labels: [triggeringLabel] });
    }
    const data: IssueJobData = {
      repoOwner: owner, repoName: repo, number: issue.number, userId: String(payload.sender.id), triggeringLabel,
      correlationId: generateCorrelationId(), pluginCommand: run,
    };
    await (deps.enqueue ?? defaultEnqueue)(data, `issue-${owner}-${repo}-${issue.number}`);
    log.info({ repository, issueNumber: issue.number, commentId: comment.id, plugin: run.pluginId, command: run.command }, `Plugin command /${run.command} started an implementation task`);
    return { status: 'accepted', billing: { seatConsumed: !/\[bot\]$/i.test(author) } };
  } catch (error) {
    // This attempt created no task: release what it reserved so a redelivery
    // is handled afresh. The dedupe window is released only while it is still
    // this attempt's, never one a later label event or command has taken.
    const releases = await Promise.allSettled([
      ...(dedupeToken ? [deps.redis.eval(RELEASE_OWNED_SCRIPT, 1, dedupeKey, dedupeToken)] : []),
      deps.redis.del(claimKey),
    ]);
    for (const release of releases) {
      if (release.status === 'rejected') log.warn({ repository, issueNumber: issue.number, err: release.reason }, 'Could not release a plugin command reservation');
    }
    throw error;
  }
}
