import { Queue } from 'bullmq';
import type { RedisOptions } from 'ioredis';
import { createClient, type RedisClientType } from 'redis';
import {
  AGENT_RUNTIME_BUILD_QUEUE_NAME,
  buildRedisRuntimeConfig,
  generateCorrelationId,
  isNotificationTimerDelay,
  logger,
  withNotificationDeadline,
} from '@propr/core';

const NOTIFICATION_REDIS_OPERATION_TIMEOUT_MS = 5_000;
const MIN_NOTIFICATION_REDIS_LEASE_TTL_MS = 3_000;
const SHUTDOWN_TASK_TIMEOUT_MS = 10_000;

export interface ShutdownTask {
  name: string;
  close: () => Promise<unknown>;
}

export interface RedisRuntimeConfig {
  url: string;
  options: RedisOptions;
}

export interface ServerRedisResources {
  redisClient: RedisClientType;
  taskQueue: Queue;
  runtimeBuildQueue: Queue;
}

function buildRedisUrlFromOptions(options: RedisOptions): string {
  const protocol = options.tls ? 'rediss' : 'redis';
  const host = options.host || 'redis';
  const port = options.port || 6379;
  const credentials = options.username
    ? `${encodeURIComponent(options.username)}:${encodeURIComponent(options.password || '')}@`
    : options.password ? `:${encodeURIComponent(options.password)}@` : '';
  const database = typeof options.db === 'number' ? `/${options.db}` : '';
  return `${protocol}://${credentials}${host}:${port}${database}`;
}

export function getRedisRuntimeConfig(): RedisRuntimeConfig {
  const runtimeConfig = buildRedisRuntimeConfig();
  return {
    url: runtimeConfig.url || buildRedisUrlFromOptions(runtimeConfig.options),
    options: { ...runtimeConfig.options }
  };
}

/** Session storage inherits the complete runtime Redis URL unless explicitly overridden. */
export function getSessionRedisRuntimeConfig(): RedisRuntimeConfig {
  const runtimeConfig = getRedisRuntimeConfig();
  if (process.env.SESSION_REDIS_URL) {
    return { ...runtimeConfig, url: process.env.SESSION_REDIS_URL };
  }
  const url = new URL(runtimeConfig.url);
  if (process.env.SESSION_REDIS_HOST) url.hostname = process.env.SESSION_REDIS_HOST;
  if (process.env.SESSION_REDIS_PORT) url.port = process.env.SESSION_REDIS_PORT;
  return { ...runtimeConfig, url: url.toString() };
}

export function getSessionRedisClientOptions(
  connectTimeoutMs?: number
): Parameters<typeof createClient>[0] {
  const runtimeConfig = getSessionRedisRuntimeConfig();
  const tls = new URL(runtimeConfig.url).protocol === 'rediss:';
  const socket = connectTimeoutMs === undefined && !tls ? undefined : {
    ...(connectTimeoutMs === undefined ? {} : { connectTimeout: connectTimeoutMs }),
    ...(tls ? {
      tls: true,
      rejectUnauthorized: process.env.REDIS_TLS_REJECT_UNAUTHORIZED !== 'false',
    } : {}),
  };
  return {
    url: runtimeConfig.url,
    ...(socket === undefined ? {} : { socket }),
  };
}

/** Creates the Redis client shared by Express sessions and restart recovery. */
export function createSessionRedisClient(connectTimeoutMs?: number) {
  return createClient(getSessionRedisClientOptions(connectTimeoutMs));
}

export async function closeResources(tasks: ShutdownTask[]): Promise<void> {
  const results = await Promise.allSettled(tasks.map(async ({ name, close }) =>
    withNotificationDeadline(close(), SHUTDOWN_TASK_TIMEOUT_MS, `closing ${name}`)
  ));
  results.forEach((result, index) => {
    if (result.status === 'rejected') {
      logger.error({
        resource: tasks[index].name,
        error: result.reason instanceof Error ? result.reason.message : String(result.reason),
      }, 'Failed to close server resource');
    }
  });
}

function createDemoTaskQueue(): Queue {
  return {
    add: async () => { throw new Error('Task queue is disabled in demo mode'); },
    close: async () => undefined,
    getWaitingCount: async () => 0,
    getActiveCount: async () => 0,
    getCompletedCount: async () => 0,
    getFailedCount: async () => 0,
    getDelayedCount: async () => 0,
    getJob: async () => null,
  } as unknown as Queue;
}

export async function initializeServerRedis(
  demoMode: boolean,
  runtimeConfig: RedisRuntimeConfig
): Promise<ServerRedisResources> {
  if (demoMode) {
    const { createDemoRedisClient } = await import('./demoMode.js');
    return {
      redisClient: createDemoRedisClient(),
      taskQueue: createDemoTaskQueue(),
      runtimeBuildQueue: createDemoTaskQueue(),
    };
  }
  const redisClient = createClient({ url: runtimeConfig.url });
  redisClient.on('error', (error) => logger.error({
    error: error instanceof Error ? error.message : String(error),
  }, 'API Redis client error'));
  let taskQueue: Queue | undefined;
  let runtimeBuildQueue: Queue | undefined;
  try {
    await redisClient.connect();
    const connection = { ...runtimeConfig.options };
    taskQueue = new Queue(
      process.env.GITHUB_ISSUE_QUEUE_NAME || 'github-issue-processor',
      { connection }
    );
    runtimeBuildQueue = new Queue(AGENT_RUNTIME_BUILD_QUEUE_NAME, { connection });
    await runtimeBuildQueue.setGlobalConcurrency(1);
    return { redisClient: redisClient as RedisClientType, taskQueue, runtimeBuildQueue };
  } catch (error) {
    await Promise.allSettled([
      ...(runtimeBuildQueue ? [runtimeBuildQueue.close()] : []),
      ...(taskQueue ? [taskQueue.close()] : []),
    ]);
    if (redisClient.isOpen) {
      try { await redisClient.quit(); } catch { await redisClient.disconnect().catch(() => undefined); }
    }
    throw error;
  }
}

export function createNotificationProjectionLease(
  redisClient: RedisClientType,
  name: string,
  ttlMs: number,
  operationTimeoutMs = NOTIFICATION_REDIS_OPERATION_TIMEOUT_MS
): () => Promise<boolean | {
  renew: () => Promise<boolean>;
  release: () => Promise<void>;
  renewalIntervalMs: number;
}> {
  if (!isNotificationTimerDelay(operationTimeoutMs)) {
    throw new TypeError('notification Redis operation timeout must be a schedulable positive integer');
  }
  if (!isNotificationTimerDelay(ttlMs) || ttlMs < MIN_NOTIFICATION_REDIS_LEASE_TTL_MS) {
    throw new TypeError(
      `notification Redis lease TTL must be at least ${MIN_NOTIFICATION_REDIS_LEASE_TTL_MS}ms`
    );
  }
  const key = `notification:projection-lease:${name}`;
  const acquireScript = "return redis.call('SET', KEYS[1], ARGV[1], 'PX', ARGV[2], 'NX') and 1 or 0";
  const renewScript = "if redis.call('GET', KEYS[1]) == ARGV[1] then redis.call('PEXPIRE', KEYS[1], ARGV[2]); return 1 end return 0";
  const releaseScript = "if redis.call('GET', KEYS[1]) == ARGV[1] then redis.call('DEL', KEYS[1]); return 1 end return 0";
  return async () => {
    const owner = `${process.pid}:${generateCorrelationId()}`;
    const releaseOwner = async (message: string): Promise<void> => {
      try {
        await withNotificationDeadline(redisClient.eval(releaseScript, {
          keys: [key], arguments: [owner]
        }), operationTimeoutMs, `releasing ${name} notification projection lease`);
      } catch (error) {
        logger.warn({ name, error: error instanceof Error ? error.message : String(error) }, message);
      }
    };
    const acquisition = redisClient.eval(acquireScript, {
      keys: [key], arguments: [owner, String(ttlMs)]
    });
    try {
      const acquired = await withNotificationDeadline(
        acquisition,
        operationTimeoutMs,
        `acquiring ${name} notification projection lease`
      );
      if (Number(acquired) !== 1) return false;
      return {
        renewalIntervalMs: Math.max(1000, Math.floor(ttlMs / 3)),
        renew: async () => {
          try {
            const renewed = await withNotificationDeadline(redisClient.eval(renewScript, {
              keys: [key], arguments: [owner, String(ttlMs)]
            }), operationTimeoutMs, `renewing ${name} notification projection lease`);
            return Number(renewed) === 1;
          } catch (error) {
            logger.warn({ name, error: error instanceof Error ? error.message : String(error) },
              'Could not renew notification projection lease');
            return false;
          }
        },
        release: () => releaseOwner('Could not release notification projection lease')
      };
    } catch (error) {
      logger.warn({ name, error: error instanceof Error ? error.message : String(error) },
        'Could not acquire notification projection lease');
      // node-redis commands cannot be cancelled once queued. If this command
      // completes after our deadline and did acquire the key, release that late
      // owner instead of leaving an unseen lock until its TTL expires.
      void acquisition.then((acquired) => Number(acquired) === 1
        ? releaseOwner('Could not release late notification projection lease acquisition')
        : undefined, () => undefined);
      return false;
    }
  };
}
