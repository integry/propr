import type { Redis } from 'ioredis';
import type { Logger } from 'pino';
import { hasPullRequestMerged, type PullRequestMergeStateRedisLike } from './prMergeState.js';

type LookupFailureBehavior = 'continue' | 'skip' | 'throw';
type LogLike = Pick<Logger, 'info' | 'warn'>;

export async function shouldSkipEnqueueForMergedPullRequest(params: {
  redisClient: Redis;
  repository: string;
  prNumber: number;
  log: LogLike;
  mergedMessage: string;
  lookupFailureMessage: string;
  lookupFailureBehavior?: LookupFailureBehavior;
}): Promise<boolean> {
  const {
    redisClient,
    repository,
    prNumber,
    log,
    mergedMessage,
    lookupFailureMessage,
    lookupFailureBehavior = 'throw',
  } = params;

  try {
    const merged = await hasPullRequestMerged(createPullRequestMergeRedisAdapter(redisClient), repository, prNumber);
    if (merged) {
      log.info({ repository, prNumber }, mergedMessage);
    }
    return merged;
  } catch (error) {
    log.warn({
      repository,
      prNumber,
      error: (error as Error).message,
    }, lookupFailureMessage);

    if (lookupFailureBehavior === 'continue') {
      return false;
    }
    if (lookupFailureBehavior === 'skip') {
      return true;
    }
    throw error;
  }
}

function createPullRequestMergeRedisAdapter(redisClient: Redis): PullRequestMergeStateRedisLike {
  return {
    get: (key: string) => redisClient.get(key),
    set: (key: string, value: string, options?: { EX?: number }) => (
      options?.EX !== undefined
        ? redisClient.set(key, value, 'EX', options.EX)
        : redisClient.set(key, value)
    ),
    setex: (key: string, seconds: number, value: string) => redisClient.setex(key, seconds, value),
  };
}
