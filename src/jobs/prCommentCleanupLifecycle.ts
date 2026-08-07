import type { Logger } from 'pino';

interface JobCleanupLifecycleOptions {
    cleanup: (beforeRelease: () => Promise<void>) => Promise<void>;
    stopHeartbeat: () => Promise<void>;
    correlatedLogger: Logger;
    preserveJobOutcome: boolean;
    recoverPreservedFailure?: (failure: unknown) => Promise<void>;
}

/** Stops the heartbeat at lease release while preserving an already-committed job outcome. */
export async function runJobCleanupLifecycle(options: JobCleanupLifecycleOptions): Promise<void> {
    const {
        cleanup, stopHeartbeat, correlatedLogger,
        preserveJobOutcome, recoverPreservedFailure,
    } = options;
    let heartbeatStopped = false;
    let heartbeatStopPromise: Promise<void> | null = null;
    const stopHeartbeatOnce = async (): Promise<void> => {
        if (heartbeatStopped) return;
        heartbeatStopPromise ??= stopHeartbeat()
            .then(() => { heartbeatStopped = true; })
            .finally(() => {
                if (!heartbeatStopped) heartbeatStopPromise = null;
            });
        await heartbeatStopPromise;
    };
    let failure: unknown;
    try { await cleanup(stopHeartbeatOnce); }
    catch (error) {
        failure = error;
        if (preserveJobOutcome) {
            correlatedLogger.warn(
                { error: (error as Error).message },
                'Cleanup finalization failed after the job outcome was committed; allowing the lease to expire without retrying the job',
            );
        }
    }
    try { await stopHeartbeatOnce(); }
    catch (error) {
        failure ??= error;
        if (preserveJobOutcome) {
            correlatedLogger.warn(
                { error: (error as Error).message },
                'Heartbeat cleanup failed after the job outcome was committed; preserving the completed job result',
            );
        }
    }
    if (!failure) return;
    if (!preserveJobOutcome) throw failure;
    if (!recoverPreservedFailure) throw failure;
    try {
        await recoverPreservedFailure(failure);
    } catch (recoveryError) {
        correlatedLogger.error(
            { error: (recoveryError as Error).message },
            'Could not persist cleanup recovery after a committed job outcome',
        );
        throw new AggregateError(
            [failure, recoveryError],
            'Committed job cleanup failed without a durable recovery job',
        );
    }
}
