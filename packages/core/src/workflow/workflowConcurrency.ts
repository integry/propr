import { randomUUID } from 'node:crypto';
import type { Redis } from 'ioredis';

// One shared admission decision across workers, branches, issues and PR follow-ups.
// Every active run participates, including repositories without a workflow file.
export const ACQUIRE_WORKFLOW_SLOT = `
local now = tonumber(redis.call('TIME')[1])
local expired = redis.call('ZRANGEBYSCORE', KEYS[1], '-inf', now)
for _, member in ipairs(expired) do redis.call('HDEL', KEYS[2], member) end
redis.call('ZREMRANGEBYSCORE', KEYS[1], '-inf', now)
local limit = tonumber(ARGV[2])
for _, value in ipairs(redis.call('HVALS', KEYS[2])) do
    local other = tonumber(value)
    if other > 0 and (limit == 0 or other < limit) then limit = other end
end
if limit > 0 and redis.call('ZCARD', KEYS[1]) >= limit then return 0 end
redis.call('ZADD', KEYS[1], now + 120, ARGV[1])
redis.call('HSET', KEYS[2], ARGV[1], ARGV[2])
redis.call('EXPIRE', KEYS[1], 180)
redis.call('EXPIRE', KEYS[2], 180)
return 1
`;

export async function withRepositoryWorkflowSlot<T>(options: {
    redis: Redis;
    repository: string;
    limit?: number;
    checkCancelled: () => Promise<void>;
    onLeaseError: (error: unknown) => void;
}, execute: () => Promise<T>): Promise<T> {
    const key = `propr:workflow:slots:{${options.repository.toLowerCase()}}`;
    const limitsKey = `${key}:limits`;
    const token = randomUUID();
    while (true) {
        await options.checkCancelled();
        if (await options.redis.eval(ACQUIRE_WORKFLOW_SLOT, 2, key, limitsKey, token, options.limit ?? 0) === 1) break;
        await new Promise(resolve => setTimeout(resolve, 1000));
    }
    const heartbeat = setInterval(() => {
        void options.redis.eval(`
            if redis.call('ZSCORE', KEYS[1], ARGV[1]) then
                redis.call('ZADD', KEYS[1], tonumber(redis.call('TIME')[1]) + 120, ARGV[1])
                redis.call('EXPIRE', KEYS[1], 180)
                redis.call('EXPIRE', KEYS[2], 180)
            end`, 2, key, limitsKey, token).catch(options.onLeaseError);
    }, 30_000);
    heartbeat.unref();
    try { return await execute(); }
    finally {
        clearInterval(heartbeat);
        await options.redis.eval(`redis.call('ZREM', KEYS[1], ARGV[1]); redis.call('HDEL', KEYS[2], ARGV[1])`, 2, key, limitsKey, token)
            .catch(options.onLeaseError);
    }
}
