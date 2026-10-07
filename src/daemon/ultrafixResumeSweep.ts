import type { Logger } from 'pino';
import type { Redis } from 'ioredis';
import { generateCorrelationId, logger } from '@propr/core';
import { sweepUltrafixResumeCandidates } from '../jobs/ultrafixLoopContinuation.js';

/**
 * Same cadence as the API server's sweep. Both take the shared sweep lease,
 * so with both running against one Redis only one of them sweeps per period.
 */
export const ULTRAFIX_RESUME_SWEEP_INTERVAL_MS = 60_000;

type Sweep = typeof sweepUltrafixResumeCandidates;

/**
 * Re-run due Ultrafix retry obligations and deferred reviews, so a daemon
 * running without the API server (and with PR polling off) still recovers a
 * loop whose last wake-up could not settle it, without waiting for a webhook.
 */
export async function runUltrafixResumeSweep(
    redisClient: Redis,
    sweep: Sweep = sweepUltrafixResumeCandidates,
    leaseMs: number = ULTRAFIX_RESUME_SWEEP_INTERVAL_MS,
): Promise<void> {
    try {
        const outcomes = await sweep(redisClient, () => logger.withCorrelation(generateCorrelationId()) as unknown as Logger, { leaseMs });
        for (const { prId, result } of outcomes) {
            if (result.continued) logger.info({ ...prId, result }, '[ultrafix] continuation resumed by daemon sweep');
        }
    } catch (error) {
        logger.warn({ error: (error as Error).message }, '[ultrafix] daemon resume sweep failed');
    }
}

/** Start the periodic sweep; a run still in progress is not overlapped by the next tick. */
export function scheduleUltrafixResumeSweep(
    redisClient: Redis,
    options: { intervalMs?: number; sweep?: Sweep } = {},
): NodeJS.Timeout {
    let running: Promise<void> | null = null;
    const intervalMs = options.intervalMs ?? ULTRAFIX_RESUME_SWEEP_INTERVAL_MS;
    const tick = (): void => {
        if (running) return;
        running = runUltrafixResumeSweep(redisClient, options.sweep, intervalMs).finally(() => { running = null; });
    };
    tick();
    const interval = setInterval(tick, intervalMs);
    interval.unref?.();
    return interval;
}
