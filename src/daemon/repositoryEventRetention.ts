import { db, logger, pruneRepositoryEvents, REPOSITORY_EVENT_RETENTION_DAYS } from '@propr/core';

/**
 * Prune repository journal events older than the retention window (30 days),
 * recording each repository's new floor so a reader can tell an expired
 * cursor from an empty result. Runs with the daemon's hourly maintenance sweep.
 */
export async function sweepRepositoryEvents(options: { now?: () => number } = {}): Promise<number> {
    try {
        const { deleted, floors } = await pruneRepositoryEvents(db, { olderThanDays: REPOSITORY_EVENT_RETENTION_DAYS, now: options.now });
        if (deleted > 0) logger.info({ deleted, floors }, 'Pruned expired repository events');
        return deleted;
    } catch (error) {
        logger.warn({ error: (error as Error).message }, 'Failed to prune repository events');
        return 0;
    }
}
