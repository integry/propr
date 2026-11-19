import { logger, retryPendingCiInfrastructureReruns } from '@propr/core';

export const CI_INFRASTRUCTURE_RERUN_SWEEP_INTERVAL_MS = 60_000;

/**
 * Sends runner-problem re-runs that waited for their workflow run to finish.
 * The run's final check can complete before GitHub marks the run finished,
 * and then no further check event would send the re-run. The sweep uses the
 * webhook handler's own Redis client, which records them.
 */
export function scheduleCiInfrastructureRerunSweep(
    intervalMs: number = CI_INFRASTRUCTURE_RERUN_SWEEP_INTERVAL_MS,
    retry: () => Promise<unknown> = () => retryPendingCiInfrastructureReruns(),
): NodeJS.Timeout {
    let running = false;
    const sweep = async (): Promise<void> => {
        if (running) return;
        running = true;
        try {
            await retry();
        } catch (error) {
            logger.warn({ error: (error as Error).message }, 'Deferred runner-problem re-run sweep failed');
        } finally {
            running = false;
        }
    };
    const interval = setInterval(() => { void sweep(); }, intervalMs);
    interval.unref?.();
    return interval;
}
