import type { Redis } from 'ioredis';
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
 * A request is held `pending` before its trigger is written, and recovery only
 * adopts it once the route reports the write as `possible` (applied, or not
 * refused). A refused write needs no further write to stay unadoptable.
 */
export interface IssueRetryRequest {
  requesterId: string;
  commentId: number;
  requestedAt: number;
  afterEventId: string | null;
  actorId: number | null;
  publication: 'pending' | 'possible';
}

export interface TriggerLabelEvent { id?: number; event: string; created_at?: string; label?: { name: string }; actor?: { id?: number } }

interface IssueKey { repoOwner: string; repoName: string; number: number }
type RetryRequestRedis = Pick<Redis, 'get' | 'eval'>;
type Octokit = Pick<Awaited<ReturnType<typeof getAuthenticatedOctokit>>, 'request'>;
interface TimelineDeps { getOctokit?: () => Promise<Octokit>; processingLabels?: () => Promise<string[]> }
/** The issue's trigger history as read at `now`. */
export interface TriggerHistory { events: TriggerLabelEvent[]; now: number }
/** The trigger a delivery dispatches, when resolved, and the request a direct job names. */
export interface RetryDelivery { triggerEventId?: string; commentId?: number }

// Outlasts webhook redelivery and the polling fallback for the trigger label.
const RETRY_REQUEST_TTL_SECONDS = 24 * 60 * 60;
// A trigger write whose response was lost lands within this; a first trigger
// after it is not the request's, so a request that was never published expires.
const PUBLICATION_WINDOW_MS = 10 * 60 * 1000;
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

/**
 * The held request whose published trigger is the one a delivery dispatches;
 * without a resolved trigger, the issue's latest. A direct job names its own
 * request, which the route only enqueues once its write was applied; any other
 * delivery adopts only a request reported as possibly published.
 */
export async function retryRequestForTrigger(
  issue: IssueKey,
  requests: IssueRetryRequest[],
  { triggerEventId, commentId }: RetryDelivery,
  { getOctokit = getAuthenticatedOctokit, processingLabels = loadPrimaryProcessingLabels }: TimelineDeps = {},
): Promise<IssueRetryRequest | null> {
  const candidates = commentId === undefined
    ? requests.filter(request => request.publication === 'possible')
    : requests.filter(request => request.commentId === commentId);
  if (candidates.length === 0) return null;
  const events = await triggerLabelEvents(await getOctokit(), issue, new Set(await processingLabels()));
  const delivered = triggerEventId ?? (events.at(-1)?.id === undefined ? undefined : String(events.at(-1)!.id));
  return candidates.find(request => delivered !== undefined && retryRequestTrigger(request, events) === delivered) ?? null;
}

/** Releases the request only; other requests held for the issue survive. */
export async function settleIssueRetryRequest(redis: RetryRequestRedis, issue: IssueKey, request: IssueRetryRequest): Promise<void> {
  await updateRequests(redis, issue, requests => requests.filter(held => held.commentId !== request.commentId));
}
