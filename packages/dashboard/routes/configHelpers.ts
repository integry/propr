import { RedisClientType } from 'redis';

/**
 * Execute an operation with a Redis-based distributed lock.
 * This ensures only one config update can happen at a time for a given lock key.
 */
export async function withConfigLock(
  redisClient: RedisClientType,
  lockKey: string,
  operation: () => Promise<{ status: number; body: Record<string, unknown> }>
): Promise<{ status: number; body: Record<string, unknown> }> {
  const lockValue = `${Date.now()}-${Math.random()}`;
  const lockTimeout = 30;

  try {
    const acquired = await redisClient.set(lockKey, lockValue, {
      NX: true,
      EX: lockTimeout
    });

    if (!acquired) {
      return { status: 409, body: { error: 'Configuration is being updated. Please try again.' } };
    }

    try {
      return await operation();
    } finally {
      const currentLockValue = await redisClient.get(lockKey);
      if (currentLockValue === lockValue) {
        await redisClient.del(lockKey);
      }
    }
  } catch (error) {
    console.error(`Error in config operation with lock ${lockKey}:`, error);
    try {
      const currentLockValue = await redisClient.get(lockKey);
      if (currentLockValue === lockValue) {
        await redisClient.del(lockKey);
      }
    } catch (unlockError) {
      console.error('Error releasing lock:', unlockError);
    }
    return { status: 500, body: { error: 'Failed to update configuration' } };
  }
}
