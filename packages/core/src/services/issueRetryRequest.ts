import type { Redis } from 'ioredis';

/**
 * The requester and posted instructions of a requested issue retry. The job
 * the route submits carries them, but a relabel delivery that recovers a
 * failed submission cannot, so they are held per issue until a dispatch has
 * carried them into the run.
 */
export interface IssueRetryRequest { requesterId: string; commentId: number }

interface IssueKey { repoOwner: string; repoName: string; number: number }
type RetryRequestRedis = Pick<Redis, 'get' | 'setex' | 'eval'>;

// Outlasts webhook redelivery and the polling fallback for the trigger label.
const RETRY_REQUEST_TTL_SECONDS = 24 * 60 * 60;
const SETTLE_SCRIPT = `
if redis.call('GET', KEYS[1]) == ARGV[1] then
    return redis.call('DEL', KEYS[1])
end
return 0
`;

const retryRequestKey = (issue: IssueKey) => `issue:retry-request:${issue.repoOwner}:${issue.repoName}:${issue.number}`;
const serialize = (request: IssueRetryRequest) => JSON.stringify({ requesterId: request.requesterId, commentId: request.commentId });

export async function rememberIssueRetryRequest(redis: RetryRequestRedis, issue: IssueKey, request: IssueRetryRequest): Promise<void> {
  await redis.setex(retryRequestKey(issue), RETRY_REQUEST_TTL_SECONDS, serialize(request));
}

export async function findIssueRetryRequest(redis: RetryRequestRedis, issue: IssueKey): Promise<IssueRetryRequest | null> {
  const raw = await redis.get(retryRequestKey(issue));
  if (!raw) return null;
  try {
    const { requesterId, commentId } = JSON.parse(raw) as Partial<IssueRetryRequest>;
    return typeof requesterId === 'string' && typeof commentId === 'number' ? { requesterId, commentId } : null;
  } catch {
    return null;
  }
}

/** Releases the request only if it is still the one held, so a newer request survives. */
export async function settleIssueRetryRequest(redis: RetryRequestRedis, issue: IssueKey, request: IssueRetryRequest): Promise<void> {
  await redis.eval(SETTLE_SCRIPT, 1, retryRequestKey(issue), serialize(request));
}
