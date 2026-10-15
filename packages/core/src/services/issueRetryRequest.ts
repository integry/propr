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
 * A request whose trigger was dispatched or never published therefore cannot
 * be adopted by a later, independent trigger even when releasing it failed.
 */
export interface IssueRetryRequest {
  requesterId: string;
  commentId: number;
  requestedAt: number;
  afterEventId: string | null;
  actorId: number | null;
}

export interface TriggerLabelEvent { id?: number; event: string; created_at?: string; label?: { name: string }; actor?: { id?: number } }

interface IssueKey { repoOwner: string; repoName: string; number: number }
type RetryRequestRedis = Pick<Redis, 'get' | 'setex' | 'eval'>;
type Octokit = Pick<Awaited<ReturnType<typeof getAuthenticatedOctokit>>, 'request'>;

// Outlasts webhook redelivery and the polling fallback for the trigger label.
const RETRY_REQUEST_TTL_SECONDS = 24 * 60 * 60;
// A trigger write whose response was lost lands within this; a first trigger
// after it is not the request's, so a request that was never published expires.
const PUBLICATION_WINDOW_MS = 10 * 60 * 1000;
const SETTLE_SCRIPT = `
if redis.call('GET', KEYS[1]) == ARGV[1] then
    return redis.call('DEL', KEYS[1])
end
return 0
`;

const retryRequestKey = (issue: IssueKey) => `issue:retry-request:${issue.repoOwner}:${issue.repoName}:${issue.number}`;
const serialize = (request: IssueRetryRequest) => JSON.stringify({
  requesterId: request.requesterId, commentId: request.commentId, requestedAt: request.requestedAt,
  afterEventId: request.afterEventId, actorId: request.actorId,
});

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

export async function rememberIssueRetryRequest(redis: RetryRequestRedis, issue: IssueKey, request: IssueRetryRequest): Promise<void> {
  await redis.setex(retryRequestKey(issue), RETRY_REQUEST_TTL_SECONDS, serialize(request));
}

export async function findIssueRetryRequest(redis: RetryRequestRedis, issue: IssueKey): Promise<IssueRetryRequest | null> {
  const raw = await redis.get(retryRequestKey(issue));
  if (!raw) return null;
  try {
    const { requesterId, commentId, requestedAt, afterEventId, actorId } = JSON.parse(raw) as Partial<IssueRetryRequest>;
    if (typeof requesterId !== 'string' || typeof commentId !== 'number' || typeof requestedAt !== 'number') return null;
    return {
      requesterId, commentId, requestedAt,
      afterEventId: typeof afterEventId === 'string' ? afterEventId : null,
      actorId: typeof actorId === 'number' ? actorId : null,
    };
  } catch {
    return null;
  }
}

/**
 * Whether the trigger a delivery dispatches is the one the request published.
 * Without a resolved trigger the delivery dispatches the issue's latest one.
 */
export async function isRetryRequestTrigger(
  issue: IssueKey,
  request: IssueRetryRequest,
  triggerEventId: string | undefined,
  { getOctokit = getAuthenticatedOctokit, processingLabels = loadPrimaryProcessingLabels }: { getOctokit?: () => Promise<Octokit>; processingLabels?: () => Promise<string[]> } = {},
): Promise<boolean> {
  const events = await triggerLabelEvents(await getOctokit(), issue, new Set(await processingLabels()));
  const published = retryRequestTrigger(request, events);
  const delivered = triggerEventId ?? (events.at(-1)?.id === undefined ? undefined : String(events.at(-1)!.id));
  return published !== null && published === delivered;
}

/** Releases the request only if it is still the one held, so a newer request survives. */
export async function settleIssueRetryRequest(redis: RetryRequestRedis, issue: IssueKey, request: IssueRetryRequest): Promise<void> {
  await redis.eval(SETTLE_SCRIPT, 1, retryRequestKey(issue), serialize(request));
}
