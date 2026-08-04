import logger from '../utils/logger.js';
import {
    MAX_NOTIFICATION_TIMER_DELAY_MS,
    isNotificationTimerDelay
} from './notificationSchedulerTiming.js';

export interface NotificationProjectionLease {
    renew(): Promise<boolean>;
    release(): Promise<void>;
    renewalIntervalMs?: number;
}

interface NotificationLeaseRunContext {
    hasLease: boolean;
    renewLease(): Promise<boolean>;
    shouldContinue(): boolean;
}

interface NotificationLeaseRunOptions<T> {
    acquireLease?: () => Promise<boolean | NotificationProjectionLease>;
    fallbackRenewalIntervalMs: number;
    generationIsCurrent: () => boolean;
    label: string;
    signal: AbortSignal;
    skippedValue: T;
    work: (context: NotificationLeaseRunContext) => Promise<T>;
}

/** Runs one generation behind a renewable, abort-aware, replica-fenced lease. */
export async function runWithNotificationLease<T>(
    options: NotificationLeaseRunOptions<T>
): Promise<T> {
    let lease: NotificationProjectionLease | undefined;
    let renewalTimer: NodeJS.Timeout | undefined;
    let renewalInFlight: Promise<boolean> | null = null;
    let releaseInFlight: Promise<void> | null = null;
    let leaseLost = false;
    let runValid = true;
    const releaseLease = (): Promise<void> => {
        if (releaseInFlight) return releaseInFlight;
        const currentLease = lease;
        lease = undefined;
        if (!currentLease) return Promise.resolve();
        releaseInFlight = currentLease.release().catch((error) => {
            logger.warn({ error: error instanceof Error ? error.message : String(error) },
                `Failed to release ${options.label} lease`);
        });
        return releaseInFlight;
    };
    const renewLease = (): Promise<boolean> => {
        const currentLease = lease;
        if (!currentLease || leaseLost || options.signal.aborted) {
            return Promise.resolve(!leaseLost && !options.signal.aborted);
        }
        if (renewalInFlight) return renewalInFlight;
        const renewal = (async () => {
            try {
                if (!await currentLease.renew()) leaseLost = true;
            } catch (error) {
                leaseLost = true;
                logger.warn({ error: error instanceof Error ? error.message : String(error) },
                    `Failed to renew ${options.label} lease`);
            }
            return !leaseLost;
        })();
        renewalInFlight = renewal;
        void renewal.then(() => {
            if (renewalInFlight === renewal) renewalInFlight = null;
        });
        return renewal;
    };
    const cancelRemainingWork = (): void => {
        runValid = false;
        if (renewalTimer) clearInterval(renewalTimer);
        renewalTimer = undefined;
        void releaseLease();
    };
    const shouldContinue = (): boolean => runValid && !leaseLost
        && !options.signal.aborted && options.generationIsCurrent();
    options.signal.addEventListener('abort', cancelRemainingWork, { once: true });
    try {
        if (options.acquireLease) {
            const acquired = await options.acquireLease();
            if (acquired === false) return options.skippedValue;
            if (typeof acquired === 'object') {
                lease = acquired;
                if (options.signal.aborted) return options.skippedValue;
                const configuredInterval = lease.renewalIntervalMs
                    ?? options.fallbackRenewalIntervalMs;
                if (!isNotificationTimerDelay(configuredInterval)) {
                    throw new TypeError('notification lease renewal interval is not schedulable');
                }
                const renewalIntervalMs = Math.min(
                    MAX_NOTIFICATION_TIMER_DELAY_MS,
                    configuredInterval
                );
                renewalTimer = setInterval(() => { void renewLease(); }, renewalIntervalMs);
                renewalTimer.unref();
            }
        }
        if (!shouldContinue()) return options.skippedValue;
        return await options.work({
            hasLease: lease !== undefined,
            renewLease,
            shouldContinue
        });
    } finally {
        runValid = false;
        options.signal.removeEventListener('abort', cancelRemainingWork);
        if (renewalTimer) clearInterval(renewalTimer);
        await releaseLease();
    }
}
