import type { Redis } from 'ioredis';
import { getMergeConflictSweepIntervalMs, getRepos, logger, sweepConflictedPullRequests } from '@propr/core';

/**
 * Safety net for merge-conflict auto-resolution: polling intake never sees push
 * events, and webhook deliveries can be missed. Only repositories whose effective
 * setting is on cost GitHub calls. Returns the stop: clears the timer and waits
 * for a run in progress.
 */
export function scheduleMergeConflictSweep(intakeMode: string, redisClient: Redis): () => Promise<void> {
    const intervalMs = getMergeConflictSweepIntervalMs(intakeMode);
    let running: Promise<void> | null = null;
    const sweep = (): void => {
        if (running) return;
        running = (async () => {
            try {
                await sweepConflictedPullRequests({ repositories: getRepos(), redisClient });
            } catch (error) {
                logger.error({ error: (error as Error).message }, 'Merge conflict sweep failed');
            }
        })().finally(() => { running = null; });
    };
    logger.info({ intakeMode, intervalMs }, 'Scheduled merge conflict sweep');
    const interval = setInterval(sweep, intervalMs);
    return async () => {
        clearInterval(interval);
        await running;
    };
}
