import type { Redis } from 'ioredis';
import { logger } from '@propr/core';

export const NO_CHANGE_COMPLETION_RECOVERY_INTERVAL_MS = 5 * 60_000;

/**
 * Periodically finishes no-change completions whose plan-status write (or
 * trigger cleanup, or comment) failed, so the epic queue advances even when no
 * other job for that issue ever arrives. Uses the daemon's own Redis client.
 */
export function scheduleNoChangeCompletionRecoverySweep(
    redisClient: Redis,
    intervalMs: number = NO_CHANGE_COMPLETION_RECOVERY_INTERVAL_MS,
): NodeJS.Timeout {
    let running = false;
    const sweep = async (): Promise<void> => {
        if (running) return;
        running = true;
        try {
            // Lazy: keeps the issue-job modules out of the daemon's static import graph.
            const { recoverNoChangeCompletions } = await import('../jobs/noChangeCompletionRecovery.js');
            const replayed = await recoverNoChangeCompletions({ store: redisClient });
            if (replayed) logger.info({ replayed }, 'Recovered retained no-change completions');
        } catch (error) {
            logger.warn({ error: (error as Error).message }, 'No-change completion recovery sweep failed');
        } finally {
            running = false;
        }
    };
    const interval = setInterval(() => { void sweep(); }, intervalMs);
    interval.unref?.();
    return interval;
}
