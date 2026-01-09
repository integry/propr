import { Redis } from 'ioredis';

const REDIS_HOST = process.env.REDIS_HOST || '127.0.0.1';
const REDIS_PORT = parseInt(process.env.REDIS_PORT || '6379', 10);

const CANCELLATION_KEY_PREFIX = 'indexing:cancel:';
const CANCELLATION_TTL_SECONDS = 3600; // 1 hour TTL

let redisClient: Redis | null = null;

function getRedis(): Redis {
  if (!redisClient) {
    redisClient = new Redis({
      host: REDIS_HOST,
      port: REDIS_PORT,
      maxRetriesPerRequest: 3,
      lazyConnect: true,
    });
  }
  return redisClient;
}

function getCancellationKey(repository: string): string {
  return `${CANCELLATION_KEY_PREFIX}${repository}`;
}

/**
 * Request cancellation of an indexing job for a repository.
 * The worker will check this flag and stop processing.
 */
export async function requestIndexingCancellation(repository: string): Promise<void> {
  const redis = getRedis();
  const key = getCancellationKey(repository);
  await redis.set(key, '1', 'EX', CANCELLATION_TTL_SECONDS);
}

/**
 * Check if indexing has been cancelled for a repository.
 * Called by the worker during processing.
 */
export async function isIndexingCancelled(repository: string): Promise<boolean> {
  const redis = getRedis();
  const key = getCancellationKey(repository);
  const value = await redis.get(key);
  return value === '1';
}

/**
 * Clear the cancellation flag for a repository.
 * Called when indexing completes (success, failure, or cancellation).
 */
export async function clearIndexingCancellation(repository: string): Promise<void> {
  const redis = getRedis();
  const key = getCancellationKey(repository);
  await redis.del(key);
}

/**
 * Custom error thrown when indexing is cancelled by user.
 */
export class IndexingCancelledError extends Error {
  constructor(repository: string) {
    super(`Indexing cancelled by user for repository: ${repository}`);
    this.name = 'IndexingCancelledError';
  }
}
