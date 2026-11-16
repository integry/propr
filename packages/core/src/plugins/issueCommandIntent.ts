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
 * intake carries this record into the job it queues instead of ordinary work.
 * It claims the record first, marking it `queued` before its add
 * (`claimPendingIssueCommand`), and puts it back to `pending` when no job
 * carrying the command is stored after all (`carryClaimedIssueCommand`). The
 * command's own enqueue deletes the record once its job is stored. The
 * `queued` mark is a reservation, not evidence that a job exists: a claim
 * interrupted before its add, or one that could not be put back, leaves it
 * behind, so a `queued` record is reconciled against the stored job before it
 * is taken as started, and is claimed again once its lease has run out
 * (`reconcileQueuedIssueCommand`).
 *
 * Whether an attempt's command runs or is reported as not started is decided
 * once, per attempt token, by its fate (`issueCommandFateKey`): `retired` when
 * ProPR gives the command up, `carried` when a dispatcher starts a job
 * carrying it. Each is written atomically with the record checks and change it
 * depends on, and neither is written over the other. A refusal deletes the
 * comment's pending record and retires its token (`retireIssueCommandIntent`),
 * so a label path that read the record before that cannot claim it, and a job
 * that already holds the token (an add whose outcome was unknown, a claim put
 * back) runs without the command: its dispatcher reads the fate before it
 * starts the work (`settleDispatchedIssueCommand`) and marks the token
 * `carried`, after which no refusal reports that command as not started and
 * no label event claims it again. An attempt that withdraws its own record
 * retires its token the same way (`withdrawIssueCommandIntent`).
 *
 * The command's own release can fail after its job is queued. The job itself
 * is then the durable evidence: it names the record's token
 * (`pluginCommandIntent`), and its dispatcher marks the record `queued`
 * before it starts the work, retrying the job while it cannot. So a record
 * still `pending` when a later label event reads it was never carried into
 * running work, and a queued job still carrying it holds the issue's job ID.
 */
export interface IssueCommandIntent {
  state: 'pending' | 'queued';
  commentId: number;
  /** The GitHub user who ran the command; the task belongs to them. */
  userId: string;
  /**
   * Whether accepting the command consumes a seat: the classification of the
   * command's author, kept so recovery through the processing label (applied
   * by ProPR's bot) reports the same as the command's own intake would have.
   * Absent in records written before it was recorded.
   */
  seatConsumed?: boolean;
  pluginCommand: PluginCommandRun;
  /** Distinguishes this attempt's record from a later one for the same issue. */
  token: string;
  /**
   * When the label path claimed the record (`queued`), the start of its claim
   * lease: a claim whose job is not stored once the lease has run out was
   * abandoned by a process that stopped between the claim and its add (or
   * could not put it back), and is reclaimed. Absent on a pending record and
   * on one a dispatcher settled.
   */
  claimedAt?: number;
}

/** Lives as long as the comment claim, the window in which a redelivery is handled. */
export const ISSUE_COMMAND_INTENT_TTL_SECONDS = 86400;
/**
 * Far longer than the record: a job holding the token reads its fate when it
 * is dispatched, which only a queue stalled for days would put off this long.
 */
export const ISSUE_COMMAND_FATE_TTL_SECONDS = 7 * 86400;
/**
 * How long a label-path claim is taken as still in flight while no job carries
 * it: the claim's add (with its Redis retries) and read-back take seconds, and
 * the label path's own dedupe window is 30 seconds.
 */
export const ISSUE_COMMAND_CLAIM_LEASE_MS = 60_000;

/**
 * The intent record scripts, exported for test doubles. Each runs atomically.
 * KEYS[1] is the issue's record; KEYS[2], where used, the attempt token's fate.
 */
export const ISSUE_COMMAND_INTENT_SCRIPTS = {
  /** Deletes the record only while it still holds ARGV[1]. */
  releaseIfUnchanged: "if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('del', KEYS[1]) else return 0 end",
  /** Replaces the record's value with ARGV[2], keeping its expiry, only while it still holds ARGV[1]. */
  replaceIfUnchanged: "if redis.call('get', KEYS[1]) == ARGV[1] then redis.call('set', KEYS[1], ARGV[2], 'KEEPTTL') return 1 else return 0 end",
  /**
   * Gives up the command of the record ARGV[1]: while the record still holds
   * it and no dispatcher has started a job carrying its token, deletes it (or
   * puts back ARGV[2] when given) and retires the token for ARGV[3] seconds.
   * Resolves 1 when retired, -1 when the token was carried, 0 when the record
   * changed.
   */
  retire: "if redis.call('get', KEYS[1]) ~= ARGV[1] then return 0 end "
    + "if redis.call('get', KEYS[2]) == 'carried' then return -1 end "
    + "if ARGV[2] == '' then redis.call('del', KEYS[1]) else redis.call('set', KEYS[1], ARGV[2], 'KEEPTTL') end "
    + "redis.call('set', KEYS[2], 'retired', 'EX', ARGV[3]) return 1",
  /**
   * Label-path claim: marks the pending record ARGV[1] as ARGV[2] (its
   * `queued` form), keeping its expiry, while it is unchanged and its token
   * has no fate yet: a retired token was given up, and a carried one has
   * already started. Resolves 1 when claimed, -1 when the token has a fate, 0
   * when the record changed.
   */
  claim: "if redis.call('exists', KEYS[2]) == 1 then return -1 end "
    + "if redis.call('get', KEYS[1]) ~= ARGV[1] then return 0 end "
    + "redis.call('set', KEYS[1], ARGV[2], 'KEEPTTL') return 1",
  /**
   * Dispatcher settlement: unless the token is retired, marks it `carried` for
   * ARGV[3] seconds, first marking the pending record ARGV[1] (when given) as
   * ARGV[2] while it is unchanged. Resolves 1 when carried, -1 when retired, 0
   * when the record changed.
   */
  settle: "if redis.call('get', KEYS[2]) == 'retired' then return -1 end "
    + "if ARGV[1] ~= '' then if redis.call('get', KEYS[1]) ~= ARGV[1] then return 0 end redis.call('set', KEYS[1], ARGV[2], 'KEEPTTL') end "
    + "redis.call('set', KEYS[2], 'carried', 'EX', ARGV[3]) return 1",
} as const;

export interface StoredIssueCommandIntent {
  intent: IssueCommandIntent;
  /** The stored value, the ownership token of conditional updates. */
  raw: string;
}

export function issueCommandIntentKey(owner: string, repo: string, number: number): string {
  return `issue:plugin-command-intent:${owner}:${repo}:${number}`;
}

/** Whether the attempt token of the issue's record `key` was given up (`retired`) or started (`carried`). */
export function issueCommandFateKey(key: string, token: string): string {
  return `${key}:fate:${token}`;
}

/**
 * The fate of the attempt token of the issue's record `key`: `carried` once a
 * dispatcher has started a job carrying its command, `retired` once ProPR gave
 * the command up, null while it has neither. A record still `pending` whose
 * token is carried stands for a started command: the label path's claim was
 * put back after an add that stored the job but reported a failure
 * (`carryClaimedIssueCommand`), and that command must not start again.
 */
export async function issueCommandTokenFate(redis: Pick<Redis, 'get'>, key: string, token: string): Promise<'carried' | 'retired' | null> {
  const fate = await redis.get(issueCommandFateKey(key, token));
  return fate === 'carried' || fate === 'retired' ? fate : null;
}

/** The record without its claim lease, the form of a pending or dispatcher-settled record. */
function withoutClaimLease<T extends { claimedAt?: number }>(intent: T): Omit<T, 'claimedAt'> {
  const unleased = { ...intent };
  delete unleased.claimedAt;
  return unleased;
}

/** The stored value of a pending record, known before it is written so a failed write can still be withdrawn. */
export function pendingIssueCommandIntent(intent: Omit<IssueCommandIntent, 'state'>): string {
  return JSON.stringify({ ...withoutClaimLease(intent), state: 'pending' } satisfies IssueCommandIntent);
}

/** The settled (`queued`) form a dispatcher writes: its token's fate is written in the same step, so it needs no lease. */
function queuedIssueCommandIntent(intent: IssueCommandIntent): string {
  return JSON.stringify({ ...withoutClaimLease(intent), state: 'queued' } satisfies IssueCommandIntent);
}

/** The `queued` form the label path writes when it claims the record, leased from `claimedAt`. */
function claimedIssueCommandIntent(intent: IssueCommandIntent, claimedAt: number): string {
  return JSON.stringify({ ...intent, state: 'queued', claimedAt } satisfies IssueCommandIntent);
}

/** Records the pending command `raw` (see `pendingIssueCommandIntent`) for the issue, replacing any earlier record. */
export async function recordIssueCommandIntent(redis: Pick<Redis, 'set'>, key: string, raw: string): Promise<void> {
  await redis.set(key, raw, 'EX', ISSUE_COMMAND_INTENT_TTL_SECONDS);
}

function isIntent(value: unknown): value is IssueCommandIntent {
  const intent = value as Partial<IssueCommandIntent> | null;
  return !!intent && (intent.state === 'pending' || intent.state === 'queued') && typeof intent.commentId === 'number'
    && typeof intent.userId === 'string' && typeof intent.token === 'string'
    && (intent.seatConsumed === undefined || typeof intent.seatConsumed === 'boolean')
    && (intent.claimedAt === undefined || typeof intent.claimedAt === 'number')
    && !!intent.pluginCommand && typeof intent.pluginCommand.instruction === 'string';
}

function parseIntent(raw: string): IssueCommandIntent | null {
  let parsed: unknown;
  try { parsed = JSON.parse(raw); } catch { return null; }
  return isIntent(parsed) ? parsed : null;
}

export async function readIssueCommandIntent(redis: Pick<Redis, 'get'>, key: string): Promise<StoredIssueCommandIntent | null> {
  const raw = await redis.get(key);
  const intent = raw ? parseIntent(raw) : null;
  return intent && raw ? { intent, raw } : null;
}

/** Deletes the record only while it is still the one the caller read or wrote. */
export async function releaseIssueCommandIntent(redis: Pick<Redis, 'eval'>, key: string, raw: string): Promise<void> {
  await redis.eval(ISSUE_COMMAND_INTENT_SCRIPTS.releaseIfUnchanged, 1, key, raw);
}

/** Runs the `retire` script; see there. */
async function retireRecord(redis: Pick<Redis, 'eval'>, key: string, raw: string, replacement: string | null): Promise<'retired' | 'carried' | 'changed'> {
  const token = parseIntent(raw)?.token;
  if (!token) throw new Error(`The plugin command intent ${key} holds no attempt token`);
  const result = await redis.eval(ISSUE_COMMAND_INTENT_SCRIPTS.retire, 2, key, issueCommandFateKey(key, token), raw, replacement ?? '', String(ISSUE_COMMAND_FATE_TTL_SECONDS));
  return result === 1 ? 'retired' : result === -1 ? 'carried' : 'changed';
}

/**
 * Withdraws the caller's record of a command that was not started, putting
 * back the record it replaced (if any), only while the caller's is unchanged:
 * the replaced record may be another command's, still pending or already
 * queued, and stays that command's evidence. The caller's token is retired in
 * the same step, so a job a label path or an add with an unknown outcome
 * queued with it runs without the command. A token a dispatcher has already
 * carried keeps its record.
 */
export async function withdrawIssueCommandIntent(redis: Pick<Redis, 'eval'>, key: string, raw: string, replaced: StoredIssueCommandIntent | null): Promise<void> {
  await retireRecord(redis, key, raw, replaced?.raw ?? null);
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

/**
 * Durable evidence that a job carries a claimed command, read from the issue
 * queue: the data of the job stored under the issue's deterministic job ID
 * (null or undefined when there is none).
 */
export interface IssueCommandJobEvidence {
  storedJobData: () => Promise<unknown>;
}

/** Whether the stored issue job names the record's attempt token, i.e. carries its command. */
export function issueJobCarriesToken(stored: unknown, token: string): boolean {
  const data = stored as { pluginCommandIntent?: unknown } | null | undefined;
  return !!data && data.pluginCommandIntent === token;
}

/**
 * What a `queued` record stands for. `started`: a job carries its command
 * (the token has a fate, or the stored issue job names it). `in_flight`: no
 * job is stored yet, but the claim's lease has not run out, so its label path
 * may still be adding one. `abandoned`: no job is stored and the lease has run
 * out (or the record has none): the claim was interrupted after it was
 * written, or could not be put back, and nothing carries the command.
 */
export type QueuedIssueCommandVerdict = 'started' | 'in_flight' | 'abandoned';

/**
 * Reconciles a `queued` record against the evidence that a job carries it,
 * before it is treated as started (see `QueuedIssueCommandVerdict`). The
 * record's state is a reservation: it was written before the add it stands
 * for, so on its own it is no evidence that a job exists.
 */
export async function reconcileQueuedIssueCommand(
  redis: Pick<Redis, 'get'>, key: string, intent: IssueCommandIntent, evidence: IssueCommandJobEvidence,
): Promise<QueuedIssueCommandVerdict> {
  if (await issueCommandTokenFate(redis, key, intent.token)) return 'started';
  if (issueJobCarriesToken(await evidence.storedJobData(), intent.token)) return 'started';
  return intent.claimedAt !== undefined && Date.now() - intent.claimedAt < ISSUE_COMMAND_CLAIM_LEASE_MS ? 'in_flight' : 'abandoned';
}

/** A pending command label-triggered intake has claimed for the job it queues. */
export interface ClaimedIssueCommand {
  key: string;
  /** The record as it was pending, put back when no job carrying it is stored. */
  intent: IssueCommandIntent;
  pendingRaw: string;
  /** The claimed (`queued`) record. */
  claimedRaw: string;
}

/** Bounds the re-reads when the record changes between a read and its conditional update. */
const SETTLE_ATTEMPTS = 5;

/** The label path's view of the issue's command record; see `claimPendingIssueCommand`. */
export type IssueCommandClaim =
  | { status: 'claimed'; claimed: ClaimedIssueCommand }
  /**
   * `none`: no command to carry, the label queues ordinary work. `in_flight`:
   * another label path's claim is still adding its job, this label must queue
   * nothing.
   */
  | { status: 'none' | 'in_flight'; claimed: null };

/**
 * The issue's pending command, claimed for label-triggered intake to queue in
 * place of ordinary work. The record is marked `queued` before the job is
 * added, in one step with the check that its token has no fate: a refusal
 * that retired it first leaves nothing to claim, so the label queues ordinary
 * work, and a refusal after the claim finds the command started. A token a
 * dispatcher has carried (its claim was put back after an add that stored
 * the job but failed) is not claimed again either.
 *
 * A record already `queued` is reconciled against the job evidence first
 * (`reconcileQueuedIssueCommand`): one no job carries whose lease has run out
 * was abandoned by an interrupted claim and is claimed again; one whose lease
 * is still running is `in_flight`, so this label queues nothing rather than
 * command-less work; one a job carries is `none`, like a released record.
 */
export async function claimPendingIssueCommand(
  redis: Pick<Redis, 'get' | 'eval'>, issue: { repoOwner: string; repoName: string; number: number }, evidence: IssueCommandJobEvidence,
): Promise<IssueCommandClaim> {
  const key = issueCommandIntentKey(issue.repoOwner, issue.repoName, issue.number);
  for (let attempt = 0; attempt < SETTLE_ATTEMPTS; attempt++) {
    const stored = await readIssueCommandIntent(redis, key);
    if (!stored) return { status: 'none', claimed: null };
    if (stored.intent.state === 'queued') {
      const verdict = await reconcileQueuedIssueCommand(redis, key, stored.intent, evidence);
      if (verdict !== 'abandoned') return { status: verdict === 'started' ? 'none' : 'in_flight', claimed: null };
    }
    const claimedRaw = claimedIssueCommandIntent(stored.intent, Date.now());
    const result = await redis.eval(ISSUE_COMMAND_INTENT_SCRIPTS.claim, 2, key, issueCommandFateKey(key, stored.intent.token), stored.raw, claimedRaw);
    if (result === 1) return { status: 'claimed', claimed: { key, intent: stored.intent, pendingRaw: pendingIssueCommandIntent(stored.intent), claimedRaw } };
    if (result === -1) return { status: 'none', claimed: null };
    // The record changed since it was read: read it again.
  }
  throw new Error(`The plugin command intent ${key} kept changing while it was claimed`);
}

/** The job fields that make a label-triggered issue job carry the claimed command. */
export function issueCommandJobFields(claimed: ClaimedIssueCommand | null): { userId?: string; pluginCommand?: PluginCommandRun; pluginCommandIntent?: string } {
  return claimed ? { userId: claimed.intent.userId, pluginCommand: claimed.intent.pluginCommand, pluginCommandIntent: claimed.intent.token } : {};
}

/** The dispatcher's verdict on the command its job carries. */
export type IssueCommandSettlement = 'carried' | 'retired';

/**
 * Called by the issue dispatcher before it starts a job carrying a command.
 * Resolves `retired` when ProPR gave the command up (it was reported as not
 * started, or its attempt withdrew it): the job must then run without it.
 * Otherwise marks the token `carried`, so no refusal reports the command as
 * not started from now on, and marks the issue's record `queued` while it is
 * still the pending record the job names, so no later label event attaches
 * that command to other work; a record that is gone, already `queued`, or now
 * another command's is left as it is. Rejects when the fate or record cannot
 * be read or updated; the dispatcher then fails this attempt before starting
 * anything, and its retry settles.
 */
export async function settleDispatchedIssueCommand(
  redis: Pick<Redis, 'get' | 'eval'>,
  job: { repoOwner: string; repoName: string; number: number; pluginCommandIntent?: string },
): Promise<IssueCommandSettlement> {
  const token = job.pluginCommandIntent;
  if (!token) return 'carried';
  const key = issueCommandIntentKey(job.repoOwner, job.repoName, job.number);
  for (let attempt = 0; attempt < SETTLE_ATTEMPTS; attempt++) {
    const stored = await readIssueCommandIntent(redis, key);
    const pending = stored?.intent.token === token && stored.intent.state === 'pending' ? stored : null;
    const result = await redis.eval(ISSUE_COMMAND_INTENT_SCRIPTS.settle, 2, key, issueCommandFateKey(key, token),
      pending?.raw ?? '', pending ? queuedIssueCommandIntent(pending.intent) : '', String(ISSUE_COMMAND_FATE_TTL_SECONDS));
    if (result === -1) return 'retired';
    if (result === 1) return 'carried';
    // The record changed since it was read: read it again.
  }
  throw new Error(`The plugin command intent ${key} kept changing while it was settled`);
}

/**
 * Called before ProPR reports a comment's command as not started: deletes the
 * issue's record while it is still that comment's pending one and retires its
 * token in the same step, so neither a label event that read the record
 * before nor a job that already holds the token runs a command ProPR refused.
 * Another comment's record is left as it is. Resolves `started` when the
 * record is that comment's `queued` one and a job carries it or a claim of it
 * is still in flight (`reconcileQueuedIssueCommand`), or its token was
 * already carried: a label event claimed the command, or a dispatcher started
 * it, since the caller last read it, so it must not be reported as not
 * started. A `queued` record whose claim was abandoned is retired like a
 * pending one. Rejects when the record cannot be read or deleted, before
 * anything is reported.
 */
export async function retireIssueCommandIntent(redis: Pick<Redis, 'get' | 'eval'>, key: string, commentId: number, evidence: IssueCommandJobEvidence): Promise<'not_started' | 'started'> {
  for (let attempt = 0; attempt < SETTLE_ATTEMPTS; attempt++) {
    const stored = await readIssueCommandIntent(redis, key);
    if (stored?.intent.commentId !== commentId) return 'not_started';
    if (stored.intent.state === 'queued' && await reconcileQueuedIssueCommand(redis, key, stored.intent, evidence) !== 'abandoned') return 'started';
    const outcome = await retireRecord(redis, key, stored.raw, null);
    if (outcome !== 'changed') return outcome === 'retired' ? 'not_started' : 'started';
    // The record changed since it was read: read it again.
  }
  throw new Error(`The plugin command intent ${key} kept changing while it was retired`);
}

/**
 * Adds the label-triggered job (`job.add`) meant to carry the claimed
 * command, then keeps the claim only once the job stored under the ID (read
 * by `job.storedJobData`) is the one queued. An add whose ID is taken keeps
 * the existing job, which then runs without the command, and an add or read
 * that fails leaves it unknown: the record is then put back to `pending`
 * while it is still the claim, so a later label event can carry it. A job
 * that holds it nonetheless (an add whose outcome was unknown) runs it only
 * if no refusal retires it first. Resolves whether the queued job carries the
 * claimed command. A put-back that fails leaves the claim `queued` without a
 * job; it is reclaimed once its lease runs out (`claimPendingIssueCommand`).
 */
export async function carryClaimedIssueCommand(
  redis: Pick<Redis, 'eval'>, claimed: ClaimedIssueCommand | null,
  job: { add: () => Promise<unknown>; queued: { correlationId?: string; pluginCommand?: PluginCommandRun }; storedJobData: () => Promise<unknown> },
  log: Pick<Logger, 'info' | 'warn'>,
): Promise<boolean> {
  if (!claimed) {
    await job.add();
    return false;
  }
  const context = { key: claimed.key, commentId: claimed.intent.commentId };
  let carried = false;
  try {
    await job.add();
    carried = issueJobCarriesCommand(await job.storedJobData(), job.queued);
    if (carried) log.info({ ...context, command: claimed.intent.pluginCommand.command }, 'Queued the plugin command whose own enqueue failed');
    else log.warn(context, 'The issue job ID is held by other work; the plugin command stays pending');
  } finally {
    if (!carried) {
      await redis.eval(ISSUE_COMMAND_INTENT_SCRIPTS.replaceIfUnchanged, 1, claimed.key, claimed.claimedRaw, claimed.pendingRaw).catch((error: unknown) => {
        log.warn({ ...context, error: (error as Error).message }, 'Could not put the claimed plugin command back to pending; it is reclaimed once its lease runs out');
      });
    }
  }
  return carried;
}
