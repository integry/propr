import type { Logger } from 'pino';
import type { Redis } from 'ioredis';
import { generateCorrelationId, logger } from '@propr/core';
import { sweepUltrafixResumeCandidates } from '../jobs/ultrafixLoopContinuation.js';

/** Same cadence as the API server's sweep; the per-PR resume claim serializes the two. */
export const ULTRAFIX_RESUME_SWEEP_INTERVAL_MS = 60_000;

type Sweep = typeof sweepUltrafixResumeCandidates;

/**
 * Re-run due Ultrafix retry obligations and deferred reviews, so a daemon
 * running without the API server (and with PR polling off) still recovers a
 * loop whose last wake-up could not settle it, without waiting for a webhook.
 */
export async function runUltrafixResumeSweep(redisClient: Redis, sweep: Sweep = sweepUltrafixResumeCandidates): Promise<void> {
    try {
        const outcomes = await sweep(redisClient, () => logger.withCorrelation(generateCorrelationId()) as unknown as Logger);
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
    const tick = (): void => {
        if (running) return;
        running = runUltrafixResumeSweep(redisClient, options.sweep).finally(() => { running = null; });
    };
    tick();
    const interval = setInterval(tick, options.intervalMs ?? ULTRAFIX_RESUME_SWEEP_INTERVAL_MS);
    interval.unref?.();
    return interval;
}
