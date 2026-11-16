import type { Redis } from 'ioredis';
import type { Logger } from 'pino';
import type { PluginCommandRun } from './pluginCommands.js';

/**
 * A plugin command accepted on an issue, kept until a job carrying it is
 * queued or the command is given up.
 *
 * The command publishes the issue's processing label before it queues its
 * job, and that label's webhook can start the issue's work on its own. If the
 * command's own enqueue fails after the label is on the issue, the label
 * webhook (or a redelivery of it) is what starts the task, so label-triggered
 * intake reads this record and queues the command-bearing job instead of an
 * ordinary one. The record is only released as carried on evidence that such
 * a job was queued: the command's own enqueue deletes it, and the label path
 * marks it `queued` so a redelivery of the same comment does not reply that a
 * task is already running.
 *
 * Either release can fail after the job is queued. The job itself is then the
 * durable evidence: it names the record's token (`pluginCommandIntent`), and
 * its dispatcher marks the record `queued` before it starts the work, retrying
 * the job while it cannot (`settleDispatchedIssueCommand`). So a record still
 * `pending` when a later label event reads it was never carried into running
 * work, and a queued job still carrying it holds the issue's job ID.
 *
 * A command that no label of its own can start is given up instead, so no
 * later, independent label event runs it: ProPR retires a comment's pending
 * record before it replies that the command was not started
 * (`retireIssueCommandIntent`), and an attempt whose label GitHub refused, or
 * that requested none, withdraws the record it wrote. Only a label the command
 * may have published keeps its record pending past a failed attempt.
 */
export interface IssueCommandIntent {
  state: 'pending' | 'queued';
  commentId: number;
  /** The GitHub user who ran the command; the task belongs to them. */
  userId: string;
  pluginCommand: PluginCommandRun;
  /** Distinguishes this attempt's record from a later one for the same issue. */
  token: string;
}

/** Lives as long as the comment claim, the window in which a redelivery is handled. */
export const ISSUE_COMMAND_INTENT_TTL_SECONDS = 86400;

/** Deletes a key only while it still holds the caller's value. */
const RELEASE_IF_UNCHANGED_SCRIPT = "if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('del', KEYS[1]) else return 0 end";
/** Replaces a key's value, keeping its expiry, only while it still holds the caller's value. */
const REPLACE_IF_UNCHANGED_SCRIPT = "if redis.call('get', KEYS[1]) == ARGV[1] then redis.call('set', KEYS[1], ARGV[2], 'KEEPTTL') return 1 else return 0 end";

export interface StoredIssueCommandIntent {
  intent: IssueCommandIntent;
  /** The stored value, the ownership token of conditional updates. */
  raw: string;
}

export function issueCommandIntentKey(owner: string, repo: string, number: number): string {
  return `issue:plugin-command-intent:${owner}:${repo}:${number}`;
}

/** The stored value of a pending record, known before it is written so a failed write can still be withdrawn. */
export function pendingIssueCommandIntent(intent: Omit<IssueCommandIntent, 'state'>): string {
  return JSON.stringify({ ...intent, state: 'pending' } satisfies IssueCommandIntent);
}

/** Records the pending command `raw` (see `pendingIssueCommandIntent`) for the issue, replacing any earlier record. */
export async function recordIssueCommandIntent(redis: Pick<Redis, 'set'>, key: string, raw: string): Promise<void> {
  await redis.set(key, raw, 'EX', ISSUE_COMMAND_INTENT_TTL_SECONDS);
}

function isIntent(value: unknown): value is IssueCommandIntent {
  const intent = value as Partial<IssueCommandIntent> | null;
  return !!intent && (intent.state === 'pending' || intent.state === 'queued') && typeof intent.commentId === 'number'
    && typeof intent.userId === 'string' && typeof intent.token === 'string'
    && !!intent.pluginCommand && typeof intent.pluginCommand.instruction === 'string';
}

export async function readIssueCommandIntent(redis: Pick<Redis, 'get'>, key: string): Promise<StoredIssueCommandIntent | null> {
  const raw = await redis.get(key);
  if (!raw) return null;
  let parsed: unknown;
  try { parsed = JSON.parse(raw); } catch { return null; }
  return isIntent(parsed) ? { intent: parsed, raw } : null;
}

/** Deletes the record only while it is still the one the caller read or wrote. */
export async function releaseIssueCommandIntent(redis: Pick<Redis, 'eval'>, key: string, raw: string): Promise<void> {
  await redis.eval(RELEASE_IF_UNCHANGED_SCRIPT, 1, key, raw);
}

/**
 * Withdraws the caller's record of a command that was not started, putting
 * back the record it replaced (if any), only while the caller's is unchanged:
 * the replaced record may be another command's, still pending or already
 * queued, and stays that command's evidence.
 */
export async function withdrawIssueCommandIntent(redis: Pick<Redis, 'eval'>, key: string, raw: string, replaced: StoredIssueCommandIntent | null): Promise<void> {
  if (replaced) await redis.eval(REPLACE_IF_UNCHANGED_SCRIPT, 1, key, raw, replaced.raw);
  else await releaseIssueCommandIntent(redis, key, raw);
}

/**
 * Whether the job stored under the issue's deterministic ID is the one the
 * caller queued, carrying its command. Adding a job whose ID is taken keeps
 * the existing job and its data (for example a delayed retry of the issue's
 * ordinary task), so a successful add is no evidence on its own.
 */
export function issueJobCarriesCommand(stored: unknown, queued: { correlationId?: string; pluginCommand?: PluginCommandRun }): boolean {
  const data = stored as { correlationId?: unknown; pluginCommand?: unknown } | null | undefined;
  return !!data && !!queued.pluginCommand && !!queued.correlationId && data.correlationId === queued.correlationId
    && JSON.stringify(data.pluginCommand) === JSON.stringify(queued.pluginCommand);
}

/** Marks a pending record as carried by a queued job, only while it is unchanged. Resolves whether it did. */
export async function markIssueCommandIntentQueued(redis: Pick<Redis, 'eval'>, key: string, stored: StoredIssueCommandIntent): Promise<boolean> {
  return 1 === await redis.eval(REPLACE_IF_UNCHANGED_SCRIPT, 1, key, stored.raw, JSON.stringify({ ...stored.intent, state: 'queued' } satisfies IssueCommandIntent));
}

export interface PendingIssueCommand extends StoredIssueCommandIntent {
  key: string;
}

/** The issue's pending command, for label-triggered intake to queue in place of ordinary work. */
export async function readPendingIssueCommand(redis: Pick<Redis, 'get'>, owner: string, repo: string, number: number): Promise<PendingIssueCommand | null> {
  const key = issueCommandIntentKey(owner, repo, number);
  const stored = await readIssueCommandIntent(redis, key);
  return stored?.intent.state === 'pending' ? { ...stored, key } : null;
}

/** The job fields that make a label-triggered issue job carry the pending command. */
export function issueCommandJobFields(pending: PendingIssueCommand | null): { userId?: string; pluginCommand?: PluginCommandRun; pluginCommandIntent?: string } {
  return pending ? { userId: pending.intent.userId, pluginCommand: pending.intent.pluginCommand, pluginCommandIntent: pending.intent.token } : {};
}

/** Bounds the re-reads when the record changes between a read and its conditional update. */
const SETTLE_ATTEMPTS = 5;

/**
 * Called by the issue dispatcher before it starts a job carrying a command:
 * marks the issue's record `queued` while it is still the pending record the
 * job names, so no later label event attaches that command to other work. A
 * record that is gone, already `queued`, or now another command's is left as
 * it is. Rejects when the record cannot be read or updated; the dispatcher
 * then fails this attempt before starting anything, and its retry settles.
 */
export async function settleDispatchedIssueCommand(
  redis: Pick<Redis, 'get' | 'eval'>,
  job: { repoOwner: string; repoName: string; number: number; pluginCommandIntent?: string },
): Promise<void> {
  const token = job.pluginCommandIntent;
  if (!token) return;
  const key = issueCommandIntentKey(job.repoOwner, job.repoName, job.number);
  for (let attempt = 0; attempt < SETTLE_ATTEMPTS; attempt++) {
    const stored = await readIssueCommandIntent(redis, key);
    if (!stored || stored.intent.token !== token || stored.intent.state !== 'pending') return;
    // The record changed since it was read: read it again.
    if (await markIssueCommandIntentQueued(redis, key, stored)) return;
  }
  throw new Error(`The plugin command intent ${key} kept changing while it was settled`);
}

/**
 * Called before ProPR reports a comment's command as not started: deletes the
 * issue's record while it is still that comment's pending one, so no later
 * label event attaches a command ProPR refused to other work. Another
 * comment's record is left as it is. Resolves `started` when the record is
 * that comment's `queued` one: a label event queued the command since the
 * caller last read it, so it must not be reported as not started. Rejects
 * when the record cannot be read or deleted, before anything is reported.
 */
export async function retireIssueCommandIntent(redis: Pick<Redis, 'get' | 'eval'>, key: string, commentId: number): Promise<'not_started' | 'started'> {
  for (let attempt = 0; attempt < SETTLE_ATTEMPTS; attempt++) {
    const stored = await readIssueCommandIntent(redis, key);
    if (stored?.intent.commentId !== commentId) return 'not_started';
    if (stored.intent.state === 'queued') return 'started';
    // The record changed since it was read: read it again.
    if (1 === await redis.eval(RELEASE_IF_UNCHANGED_SCRIPT, 1, key, stored.raw)) return 'not_started';
  }
  throw new Error(`The plugin command intent ${key} kept changing while it was retired`);
}

/**
 * After adding the job meant to carry the pending command: marks the command
 * started, but only once the job stored under the ID (read by
 * `job.storedJobData`) is the one queued. An add whose ID is taken keeps the
 * existing job, which then runs without the command, so the command stays
 * pending.
 */
export async function settlePendingIssueCommand(
  redis: Pick<Redis, 'eval'>, pending: PendingIssueCommand | null,
  job: { queued: { correlationId?: string; pluginCommand?: PluginCommandRun }; storedJobData: () => Promise<unknown> },
  log: Pick<Logger, 'info' | 'warn'>,
): Promise<void> {
  if (!pending) return;
  if (!issueJobCarriesCommand(await job.storedJobData(), job.queued)) {
    log.warn({ key: pending.key, commentId: pending.intent.commentId }, 'The issue job ID is held by other work; the plugin command stays pending');
    return;
  }
  log.info({ key: pending.key, commentId: pending.intent.commentId, command: pending.intent.pluginCommand.command }, 'Queued the plugin command whose own enqueue failed');
  // A failure here is recovered by the job's dispatcher, which settles the record it names.
  await markIssueCommandIntentQueued(redis, pending.key, pending).catch((error: unknown) => {
    log.warn({ key: pending.key, error: (error as Error).message }, 'Could not mark the plugin command intent as queued; the job\'s dispatcher settles it');
  });
}
