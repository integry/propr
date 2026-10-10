import { logger, retryPendingEpicMergeProgress } from '@propr/core';

export const EPIC_MERGE_PROGRESS_RETRY_INTERVAL_MS = 60_000;

/**
 * Retries epic merge progress updates whose plan read or GitHub write failed.
 * The final child merge has no successor to refresh them otherwise. The sweep
 * uses the webhook handler's own Redis client, which records them.
 */
export function scheduleEpicMergeProgressRetrySweep(
    intervalMs: number = EPIC_MERGE_PROGRESS_RETRY_INTERVAL_MS,
    retry: typeof retryPendingEpicMergeProgress = retryPendingEpicMergeProgress,
): NodeJS.Timeout {
    let running = false;
    const sweep = async (): Promise<void> => {
        if (running) return;
        running = true;
        try {
            await retry();
        } catch (error) {
            logger.warn({ error: (error as Error).message }, 'Epic merge progress retry sweep failed');
        } finally {
            running = false;
        }
    };
    const interval = setInterval(() => { void sweep(); }, intervalMs);
    interval.unref?.();
    return interval;
}
