const MERGED_PR_KEY_PREFIX = 'pr-merged';
const MERGED_PR_KEY_TTL_SECONDS = 30 * 24 * 60 * 60;

type PullRequestMergeStateRedisLike = {
  get: (key: string) => Promise<string | null>;
  set?: (key: string, value: string, options?: { EX?: number }) => Promise<unknown>;
  setex?: (key: string, seconds: number, value: string) => Promise<unknown>;
};

export async function markPullRequestMerged(
  redisClient: PullRequestMergeStateRedisLike,
  repository: string,
  prNumber: number,
): Promise<void> {
  const key = getPullRequestMergedKey(repository, prNumber);
  const value = new Date().toISOString();

  if (typeof redisClient.setex === 'function') {
    await redisClient.setex(key, MERGED_PR_KEY_TTL_SECONDS, value);
    return;
  }

  if (typeof redisClient.set === 'function') {
    await redisClient.set(key, value, { EX: MERGED_PR_KEY_TTL_SECONDS });
    return;
  }

  throw new Error('Redis client does not support merged PR state writes');
}

export async function hasPullRequestMerged(
  redisClient: Pick<PullRequestMergeStateRedisLike, 'get'>,
  repository: string,
  prNumber: number,
): Promise<boolean> {
  return (await redisClient.get(getPullRequestMergedKey(repository, prNumber))) !== null;
}

function getPullRequestMergedKey(repository: string, prNumber: number): string {
  return `${MERGED_PR_KEY_PREFIX}:${repository}:${prNumber}`;
}
