import { randomUUID } from 'node:crypto';
import type { Redis } from 'ioredis';
import type { Knex } from 'knex';
import { db, handleError, logger, runScheduleTick, type ScheduleDependencies, type ScheduleTickResult } from '@propr/core';
import { createScheduleDependencies } from '../../packages/api/services/scheduledTaskDispatch.js';

export const SCHEDULE_TICK_LEASE_KEY = 'schedules:tick:lease';
const RELEASE = "if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('del', KEYS[1]) else return 0 end";

export interface ScheduledTaskTickOptions {
    redis: Pick<Redis, 'set' | 'eval'>;
    database?: Knex;
    dependencies?: ScheduleDependencies;
    leaseMs?: number;
    /** Replaces the scheduler pass; tests use it to observe the lease. */
    tick?: typeof runScheduleTick;
}

/**
 * One scheduler pass, run by whichever daemon holds the Redis lease. The lease
 * only avoids duplicate work; correctness does not depend on it, because each
 * slot is claimed in the database with the idempotency key
 * `schedule:<id>:<slot>`. Returns null when another daemon holds the lease.
 */
export async function runScheduledTaskTick(options: ScheduledTaskTickOptions): Promise<ScheduleTickResult | null> {
    const database = options.database ?? db;
    const token = randomUUID();
    const leaseMs = options.leaseMs ?? 5 * 60_000;
    if (await options.redis.set(SCHEDULE_TICK_LEASE_KEY, token, 'PX', leaseMs, 'NX') !== 'OK') return null;
    try {
        const result = await (options.tick ?? runScheduleTick)(database, options.dependencies ?? createScheduleDependencies(database));
        if (result.dispatched || result.skipped || result.missed || result.failed || result.reconciled) {
            logger.info({ ...result }, 'Scheduled task tick');
        }
        return result;
    } finally {
        await options.redis.eval(RELEASE, 1, SCHEDULE_TICK_LEASE_KEY, token).catch(() => undefined);
    }
}

/** Starts the scheduler loop. `SCHEDULE_TICK_INTERVAL_MS` (default 30s) sets its period; 0 disables it. */
export function startScheduledTaskLoop(redis: Pick<Redis, 'set' | 'eval'>): NodeJS.Timeout | null {
    const intervalMs = parseInt(process.env.SCHEDULE_TICK_INTERVAL_MS || '30000', 10);
    if (!Number.isFinite(intervalMs) || intervalMs <= 0) {
        logger.info('Scheduled tasks are disabled (SCHEDULE_TICK_INTERVAL_MS=0)');
        return null;
    }
    let running: Promise<unknown> | null = null;
    const tick = () => {
        if (running) return;
        running = runScheduledTaskTick({ redis })
            .catch(error => handleError(error, 'Scheduled task tick failed'))
            .finally(() => { running = null; });
    };
    tick();
    return setInterval(tick, intervalMs);
}
