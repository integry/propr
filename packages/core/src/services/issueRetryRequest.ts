import type { Knex } from 'knex';
import type { Redis } from 'ioredis';
import { db } from '../db/connection.js';
import { getAuthenticatedOctokit } from '../auth/githubAuth.js';
import { loadPrimaryProcessingLabels } from '../config/configManager.js';

/**
 * The requester and posted instructions of a requested issue retry. The job
 * the route submits carries them, but a relabel delivery that recovers a
 * failed submission cannot, so they are held per issue until a dispatch has
 * carried them into the run.
 *
 * A held request belongs only to the trigger it published: the first trigger
 * the route's GitHub identity labels after `afterEventId` (the latest trigger
 * event before the request), within the publication window of `requestedAt`.
 * A request whose trigger was dispatched therefore cannot be adopted by a
 * later, independent trigger even when releasing it failed.
 *
 * A request is held `pending` before its trigger is written. The route then
 * records the write's outcome, durably and here: `possible` (applied, or not
 * refused) lets recovery adopt it, and a refusal makes it unadoptable. While
 * neither record exists the outcome is unknown, and recovery defers the
 * request's trigger rather than run it with or without the request.
 */
export interface IssueRetryRequest {
  requesterId: string;
  commentId: number;
  requestedAt: number;
  afterEventId: string | null;
  actorId: number | null;
  publication: 'pending' | 'possible';
}

/** The durable record of a request: its trigger write's outcome, and whether a dispatch consumed it. */
export interface IssueRetryRequestState { publication?: 'possible' | 'refused'; consumed: boolean }

export interface TriggerLabelEvent { id?: number; event: string; created_at?: string; label?: { name: string }; actor?: { id?: number } }

interface IssueKey { repoOwner: string; repoName: string; number: number }
type RetryRequestRedis = Pick<Redis, 'get' | 'eval'>;
type Octokit = Pick<Awaited<ReturnType<typeof getAuthenticatedOctokit>>, 'request'>;
interface TimelineDeps { getOctokit?: () => Promise<Octokit>; processingLabels?: () => Promise<string[]> }
/** The issue's trigger history as read at `now`. */
export interface TriggerHistory { events: TriggerLabelEvent[]; now: number }
interface SelectionDeps extends TimelineDeps { database?: Knex; now?: () => number }

/**
 * What a delivery runs for the issue's held requests: a request on its own
 * trigger, nothing of theirs (the delivery's own trigger runs without one), or
 * nothing at all while a request that may own an admitted trigger cannot be
 * reconciled yet. `latestTriggerEventId` is the latest trigger the run consumes.
 */
export type RetryRun =
  | { request: IssueRetryRequest; triggerEventId?: string; latestTriggerEventId?: string }
  | { request: null }
  | { deferred: IssueRetryRequest };

export interface RetryRunDelivery {
  /** The request a direct job names. */
  commentId?: number;
  /** The trigger events a submission admits as a fresh run; an issue-only run admits every one. */
  admitted?: (events: TriggerLabelEvent[]) => Promise<TriggerLabelEvent[]>;
}

// Outlasts webhook redelivery and the polling fallback for the trigger label.
const RETRY_REQUEST_TTL_SECONDS = 24 * 60 * 60;
// A trigger write whose response was lost lands within this; a first trigger
// after it is not the request's, so a request that was never published expires.
const PUBLICATION_WINDOW_MS = 10 * 60 * 1000;
// Outlasts the requests the durable records describe.
const STATE_RETENTION_MS = 2 * RETRY_REQUEST_TTL_SECONDS * 1000;
const STATES_TABLE = 'issue_retry_request_states';
const MAX_UPDATE_ATTEMPTS = 5;
// Replaces the issue's held requests only if they are still the ones read.
const REPLACE_SCRIPT = `
local held = redis.call('GET', KEYS[1]) or ''
if held ~= ARGV[1] then return 0 end
if ARGV[2] == '' then redis.call('DEL', KEYS[1]) else redis.call('SET', KEYS[1], ARGV[2], 'EX', ARGV[3]) end
return 1
`;

const retryRequestKey = (issue: IssueKey) => `issue:retry-request:${issue.repoOwner}:${issue.repoName}:${issue.number}`;
const serialize = (requests: IssueRetryRequest[]) => requests.length === 0 ? '' : JSON.stringify(requests.map(request => ({
  requesterId: request.requesterId, commentId: request.commentId, requestedAt: request.requestedAt,
  afterEventId: request.afterEventId, actorId: request.actorId, publication: request.publication,
})));

function parseRequest(value: Partial<IssueRetryRequest>): IssueRetryRequest | null {
  const { requesterId, commentId, requestedAt, afterEventId, actorId, publication } = value;
  if (typeof requesterId !== 'string' || typeof commentId !== 'number' || typeof requestedAt !== 'number') return null;
  return {
    requesterId, commentId, requestedAt,
    afterEventId: typeof afterEventId === 'string' ? afterEventId : null,
    actorId: typeof actorId === 'number' ? actorId : null,
    publication: publication === 'possible' ? 'possible' : 'pending',
  };
}

function parse(raw: string): IssueRetryRequest[] {
  try {
    const value = JSON.parse(raw) as unknown;
    return (Array.isArray(value) ? value : []).map(item => parseRequest(item as Partial<IssueRetryRequest>)).filter(item => item !== null);
  } catch {
    return [];
  }
}

/** Rewrites the issue's held requests unless `change` declines; false when it declined. */
async function updateRequests(
  redis: RetryRequestRedis,
  issue: IssueKey,
  change: (requests: IssueRetryRequest[]) => IssueRetryRequest[] | null,
): Promise<boolean> {
  const key = retryRequestKey(issue);
  for (let attempt = 0; attempt < MAX_UPDATE_ATTEMPTS; attempt++) {
    const raw = await redis.get(key) ?? '';
    const next = change(parse(raw));
    if (next === null) return false;
    const nextRaw = serialize(next);
    if (nextRaw === raw) return true;
    if (Number(await redis.eval(REPLACE_SCRIPT, 1, key, raw, nextRaw, String(RETRY_REQUEST_TTL_SECONDS))) === 1) return true;
  }
  throw new Error(`Retry requests for #${issue.number} kept changing`);
}

/** The issue's processing-label events, oldest first. */
export async function triggerLabelEvents(octokit: Octokit, issue: IssueKey, triggers: Set<string>): Promise<TriggerLabelEvent[]> {
  const events: TriggerLabelEvent[] = [];
  for (let page = 1; ; page++) {
    const { data } = await octokit.request('GET /repos/{owner}/{repo}/issues/{issue_number}/timeline', {
      owner: issue.repoOwner, repo: issue.repoName, issue_number: issue.number, per_page: 100, page,
    }) as { data: TriggerLabelEvent[] };
    events.push(...data.filter(item => item.event === 'labeled' && item.label && triggers.has(item.label.name)));
    if (data.length < 100) break;
  }
  return events;
}

/** The trigger event the request published, or null while none can be told apart as its own. */
export function retryRequestTrigger(request: IssueRetryRequest, events: TriggerLabelEvent[]): string | null {
  const start = request.afterEventId === null ? 0 : events.findIndex(event => String(event.id) === request.afterEventId) + 1;
  // Without its baseline the request's own trigger cannot be identified.
  if (start === 0 && request.afterEventId !== null) return null;
  const published = events.slice(start).find(event => request.actorId === null || event.actor?.id === request.actorId);
  const publishedAt = Date.parse(published?.created_at ?? '');
  if (!published?.id || !Number.isFinite(publishedAt) || publishedAt > request.requestedAt + PUBLICATION_WINDOW_MS) return null;
  return String(published.id);
}

/** Whether the request's trigger write may still land: none of its own is on the issue yet, within the publication window. */
function publicationUnresolved(request: IssueRetryRequest, events: TriggerLabelEvent[], now: number): boolean {
  return retryRequestTrigger(request, events) === null && now <= request.requestedAt + PUBLICATION_WINDOW_MS;
}

/** Requests still worth holding: unexpired, and either published or still able to be. */
function heldRequests(requests: IssueRetryRequest[], events: TriggerLabelEvent[], now: number): IssueRetryRequest[] {
  return requests.filter(request => now <= request.requestedAt + RETRY_REQUEST_TTL_SECONDS * 1000
    && (retryRequestTrigger(request, events) !== null || publicationUnresolved(request, events, now)));
}

/**
 * Whether an earlier request's trigger write may still land. A second request
 * then could not be told apart from it, so it waits for that outcome.
 */
export async function hasUnresolvedIssueRetryRequest(redis: RetryRequestRedis, issue: IssueKey, { events, now }: TriggerHistory): Promise<boolean> {
  return (await findIssueRetryRequests(redis, issue)).some(request => publicationUnresolved(request, events, now));
}

/**
 * Holds the request alongside earlier requests whose triggers were published,
 * unless an earlier publication is still unresolved. False when it is.
 */
export async function reserveIssueRetryRequest(
  redis: RetryRequestRedis, issue: IssueKey, request: IssueRetryRequest, { events, now }: TriggerHistory,
): Promise<boolean> {
  return updateRequests(redis, issue, requests => requests.some(held => publicationUnresolved(held, events, now))
    ? null
    : [...heldRequests(requests, events, now), { ...request, publication: 'pending' }]);
}

/** Lets recovery adopt the request: its trigger write was applied, or may still be. */
export async function reportIssueRetryPublication(redis: RetryRequestRedis, issue: IssueKey, request: IssueRetryRequest): Promise<void> {
  await updateRequests(redis, issue, requests => requests.map(held => held.commentId === request.commentId ? { ...held, publication: 'possible' } : held));
}

export async function findIssueRetryRequests(redis: RetryRequestRedis, issue: IssueKey): Promise<IssueRetryRequest[]> {
  const raw = await redis.get(retryRequestKey(issue));
  return raw ? parse(raw) : [];
}

/** Durably records the outcome of the request's trigger write, independently of the store holding the request. */
export async function recordIssueRetryPublication(
  database: Knex, request: Pick<IssueRetryRequest, 'commentId'>, publication: 'possible' | 'refused', now = Date.now(),
): Promise<void> {
  await database(STATES_TABLE).where('recorded_at', '<', now - STATE_RETENTION_MS).delete();
  await database(STATES_TABLE).insert({ comment_id: request.commentId, publication, recorded_at: now }).onConflict('comment_id').merge(['publication']);
}

/** Durably records that a dispatch carried the request into its run. */
export async function consumeIssueRetryRequest(database: Knex, request: Pick<IssueRetryRequest, 'commentId'>, now = Date.now()): Promise<void> {
  await database(STATES_TABLE).insert({ comment_id: request.commentId, consumed_at: now, recorded_at: now }).onConflict('comment_id').merge(['consumed_at']);
}

export async function issueRetryRequestStates(database: Knex, requests: Array<Pick<IssueRetryRequest, 'commentId'>>): Promise<Map<number, IssueRetryRequestState>> {
  if (requests.length === 0) return new Map();
  const rows = await database(STATES_TABLE).whereIn('comment_id', requests.map(request => request.commentId))
    .select('comment_id', 'publication', 'consumed_at') as Array<{ comment_id: number | string; publication: string | null; consumed_at: number | string | null }>;
  return new Map(rows.map(row => [Number(row.comment_id), {
    publication: row.publication === 'possible' || row.publication === 'refused' ? row.publication : undefined,
    consumed: row.consumed_at !== null,
  }]));
}

/**
 * Selects the run a delivery dispatches, by the same rules for a direct job
 * and a recovering relabel or poll. Held requests are served oldest first,
 * each only on its own trigger while that trigger is admitted and the request
 * unconsumed, so a newer, independent trigger does not strand one. A request
 * whose write GitHub refused is passed over. One whose outcome is unknown, or
 * whose trigger write may still land, defers the delivery: dispatching
 * another trigger would consume its trigger, and dispatching its own would
 * either drop its requester or adopt a request that may have been refused.
 *
 * A direct job names its request, which the route only enqueues once its
 * write was applied. An issue-only run consumes no trigger, so that job runs
 * its request whether or not the timeline shows the trigger yet.
 */
export async function selectRetryRun(
  issue: IssueKey,
  requests: IssueRetryRequest[],
  { commentId, admitted }: RetryRunDelivery,
  { getOctokit = getAuthenticatedOctokit, processingLabels = loadPrimaryProcessingLabels, database = db, now = Date.now }: SelectionDeps = {},
): Promise<RetryRun> {
  const at = now();
  const states = await issueRetryRequestStates(database, requests);
  const live = requests.filter(request => !states.get(request.commentId)?.consumed && at <= request.requestedAt + RETRY_REQUEST_TTL_SECONDS * 1000);
  const named = live.find(request => request.commentId === commentId);
  if (named && !admitted) return { request: named };
  if (live.length === 0) return { request: null };
  const events = await triggerLabelEvents(await getOctokit(), issue, new Set(await processingLabels()));
  const admissible = new Set((admitted ? await admitted(events) : events).map(event => String(event.id)));
  const latest = events.at(-1)?.id;
  for (const request of [...live].sort((a, b) => a.requestedAt - b.requestedAt)) {
    const publication = request === named || request.publication === 'possible' ? 'possible' : states.get(request.commentId)?.publication;
    const owed = owedRun(request, publication, { events, admissible, now: at });
    if (owed === 'defer') return { deferred: request };
    if (owed !== null) return { request, triggerEventId: owed, latestTriggerEventId: latest === undefined ? undefined : String(latest) };
  }
  return { request: null };
}

/**
 * The admitted trigger of its own a request is owed a run on, 'defer' while
 * its outcome is unknown or its trigger may still land, or null when it is
 * owed nothing by this delivery.
 */
function owedRun(
  request: IssueRetryRequest,
  publication: IssueRetryRequestState['publication'],
  { events, admissible, now }: TriggerHistory & { admissible: Set<string> },
): string | 'defer' | null {
  if (publication === 'refused') return null;
  const own = retryRequestTrigger(request, events);
  if (own !== null && admissible.has(own)) return publication === 'possible' ? own : 'defer';
  return own === null && now <= request.requestedAt + PUBLICATION_WINDOW_MS ? 'defer' : null;
}

/** Releases the request only; other requests held for the issue survive. */
export async function settleIssueRetryRequest(redis: RetryRequestRedis, issue: IssueKey, request: IssueRetryRequest): Promise<void> {
  await updateRequests(redis, issue, requests => requests.filter(held => held.commentId !== request.commentId));
}
