import type { Redis } from 'ioredis';
import type { Logger } from 'pino';
import type { ContinuationResult } from '../jobs/ultrafixLoopContinuation.js';

interface DeferredIdentity {
    owner: string;
    repo: string;
    pr: number;
}

export interface UltrafixDeferredSweepDeps {
    listKeys: (redis: Redis) => Promise<string[]>;
    parseKey: (key: string) => DeferredIdentity | null;
    resume: (identity: DeferredIdentity, redis: Redis, logger: Logger) => Promise<ContinuationResult>;
    createLogger: () => Logger;
    warn: (error: Error) => void;
}

export async function sweepDeferredUltrafixContinuations(
    redisClient: Redis,
    deps: UltrafixDeferredSweepDeps,
): Promise<void> {
    try {
        const keys = await deps.listKeys(redisClient);
        for (const key of keys) {
            const parsed = deps.parseKey(key);
            if (!parsed) continue;
            const log = deps.createLogger();
            const result = await deps.resume(parsed, redisClient, log);
            if (result.continued) {
                log.info({ ...parsed, result }, 'Ultrafix deferred continuation resumed by daemon sweep');
            }
        }
    } catch (error) {
        deps.warn(error as Error);
    }
}

export async function scheduleUltrafixDeferredSweep(
    redisClient: Redis,
    deps: UltrafixDeferredSweepDeps,
    intervalMs = 60_000,
): Promise<NodeJS.Timeout> {
    await sweepDeferredUltrafixContinuations(redisClient, deps);
    const interval = setInterval(
        () => { void sweepDeferredUltrafixContinuations(redisClient, deps); },
        intervalMs,
    );
    interval.unref();
    return interval;
}
