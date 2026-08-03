import logger from '../utils/logger.js';
import {
    NotificationProjectionService,
    notificationProjectionService
} from './notificationProjectionService.js';
import {
    DEFAULT_NOTIFICATION_OPERATION_TIMEOUT_MS,
    DEFAULT_NOTIFICATION_SHUTDOWN_DRAIN_MS,
    type NotificationProjectionLease
} from './notificationSystemSampler.js';
import { settlesWithin, withNotificationDeadline } from './notificationSchedulerTiming.js';

export const DEFAULT_NOTIFICATION_STALLED_AFTER_MS = 30 * 60 * 1000;
export const DEFAULT_NOTIFICATION_STALLED_CHECK_INTERVAL_MS = 60 * 1000;

function positiveIntegerEnv(name: string, fallback: number): number {
    const raw = process.env[name];
    if (raw === undefined || raw.trim() === '') return fallback;
    const value = Number(raw);
    if (Number.isSafeInteger(value) && value > 0) return value;
    logger.warn({ name, value: raw }, 'Ignoring invalid notification timing configuration');
    return fallback;
}

export function getNotificationStalledAfterMs(): number {
    return positiveIntegerEnv('NOTIFICATION_STALLED_AFTER_MS', DEFAULT_NOTIFICATION_STALLED_AFTER_MS);
}

export function getNotificationStalledCheckIntervalMs(): number {
    return positiveIntegerEnv(
        'NOTIFICATION_STALLED_CHECK_INTERVAL_MS',
        DEFAULT_NOTIFICATION_STALLED_CHECK_INTERVAL_MS
    );
}

export interface NotificationStalledDetectorOptions {
    projector?: Pick<NotificationProjectionService, 'detectStalledActivities'>
        & Partial<Pick<NotificationProjectionService, 'reconcileTerminalTransitions'>>;
    stalledAfterMs?: number;
    intervalMs?: number;
    operationTimeoutMs?: number;
    drainTimeoutMs?: number;
    now?: () => string | number | Date;
    acquireLease?: () => Promise<boolean | NotificationProjectionLease>;
}

export class NotificationStalledDetector {
    private readonly projector: Pick<NotificationProjectionService, 'detectStalledActivities'>
        & Partial<Pick<NotificationProjectionService, 'reconcileTerminalTransitions'>>;
    private readonly stalledAfterMs: number;
    private readonly intervalMs: number;
    private readonly operationTimeoutMs: number;
    private readonly drainTimeoutMs: number;
    private readonly now: () => string | number | Date;
    private readonly acquireLease?: () => Promise<boolean | NotificationProjectionLease>;
    private timer: NodeJS.Timeout | null = null;
    private activeRun: Promise<number> | null = null;
    private activeRunAbortController: AbortController | null = null;
    private runGeneration = 0;

    constructor(options: NotificationStalledDetectorOptions = {}) {
        this.projector = options.projector ?? notificationProjectionService;
        this.stalledAfterMs = options.stalledAfterMs ?? getNotificationStalledAfterMs();
        this.intervalMs = options.intervalMs ?? getNotificationStalledCheckIntervalMs();
        this.operationTimeoutMs = options.operationTimeoutMs ?? DEFAULT_NOTIFICATION_OPERATION_TIMEOUT_MS;
        this.drainTimeoutMs = options.drainTimeoutMs ?? DEFAULT_NOTIFICATION_SHUTDOWN_DRAIN_MS;
        this.now = options.now ?? (() => new Date());
        this.acquireLease = options.acquireLease;
        for (const [name, value] of [
            ['stalledAfterMs', this.stalledAfterMs],
            ['intervalMs', this.intervalMs],
            ['operationTimeoutMs', this.operationTimeoutMs],
            ['drainTimeoutMs', this.drainTimeoutMs]
        ] as const) {
            if (!Number.isSafeInteger(value) || value <= 0) {
                throw new TypeError(`${name} must be a positive safe integer`);
            }
        }
    }

    start(): void {
        if (this.timer) return;
        void this.runOnce();
        this.timer = setInterval(() => { void this.runOnce(); }, this.intervalMs);
        this.timer.unref();
        logger.info({ stalledAfterMs: this.stalledAfterMs, intervalMs: this.intervalMs },
            'Notification stalled-task detector started');
    }

    async runOnce(): Promise<number> {
        if (this.activeRun) return 0;
        const abortController = new AbortController();
        const run = this.executeRun(this.runGeneration, abortController.signal);
        this.activeRun = run;
        this.activeRunAbortController = abortController;
        void run.then(
            () => { this.clearActiveRun(run); },
            () => { this.clearActiveRun(run); }
        );
        try {
            return await withNotificationDeadline(
                run,
                this.operationTimeoutMs,
                'notification stalled-activity run',
                () => this.expireActiveRun(run, abortController)
            );
        } catch (error) {
            logger.warn({ error: error instanceof Error ? error.message : String(error) },
                'Failed to detect stalled notification activity');
            return 0;
        }
    }

    async stop(): Promise<void> {
        this.runGeneration++;
        this.activeRunAbortController?.abort();
        if (this.timer) clearInterval(this.timer);
        this.timer = null;
        const activeRun = this.activeRun;
        if (activeRun && !await settlesWithin(activeRun, this.drainTimeoutMs)) {
            logger.warn({ drainTimeoutMs: this.drainTimeoutMs },
                'Notification stalled-task detector stopped with unfinished work');
        }
        logger.info('Notification stalled-task detector stopped');
    }

    private clearActiveRun(run: Promise<number>): void {
        if (this.activeRun !== run) return;
        this.activeRun = null;
        this.activeRunAbortController = null;
    }

    private expireActiveRun(run: Promise<number>, abortController: AbortController): void {
        abortController.abort();
        if (this.activeRun !== run) return;
        this.runGeneration++;
        this.activeRun = null;
        this.activeRunAbortController = null;
    }

    private async executeRun(runGeneration: number, signal: AbortSignal): Promise<number> {
        let lease: NotificationProjectionLease | undefined;
        let renewalTimer: NodeJS.Timeout | undefined;
        let renewalInFlight: Promise<boolean> | null = null;
        let leaseLost = false;
        let runValid = true;
        let releaseInFlight: Promise<void> | null = null;
        const renewLease = (): Promise<boolean> => {
            const currentLease = lease;
            if (!currentLease || leaseLost || signal.aborted) {
                return Promise.resolve(!leaseLost && !signal.aborted);
            }
            if (renewalInFlight) return renewalInFlight;
            const renewal = (async () => {
                try {
                    const renewed = await currentLease.renew();
                    if (!renewed) leaseLost = true;
                } catch (error) {
                    leaseLost = true;
                    logger.warn({ error: error instanceof Error ? error.message : String(error) },
                        'Failed to renew notification stalled-activity lease');
                }
                return !leaseLost;
            })();
            renewalInFlight = renewal;
            void renewal.then(() => {
                if (renewalInFlight === renewal) renewalInFlight = null;
            });
            return renewal;
        };
        const releaseLease = (): Promise<void> => {
            if (releaseInFlight) return releaseInFlight;
            const currentLease = lease;
            lease = undefined;
            if (!currentLease) return Promise.resolve();
            releaseInFlight = currentLease.release().catch((error) => {
                logger.warn({ error: error instanceof Error ? error.message : String(error) },
                    'Failed to release notification stalled-activity lease');
            });
            return releaseInFlight;
        };
        const cancelRemainingWork = (): void => {
            runValid = false;
            if (renewalTimer) clearInterval(renewalTimer);
            renewalTimer = undefined;
            void releaseLease();
        };
        signal.addEventListener('abort', cancelRemainingWork, { once: true });
        try {
            if (this.acquireLease) {
                const acquired = await this.acquireLease();
                if (acquired === false) return 0;
                if (typeof acquired === 'object') {
                    lease = acquired;
                    if (signal.aborted) return 0;
                    renewalTimer = setInterval(() => { void renewLease(); },
                        lease.renewalIntervalMs ?? Math.max(1000, Math.floor(this.intervalMs / 2)));
                    renewalTimer.unref();
                }
            }
            if (signal.aborted || runGeneration !== this.runGeneration) return 0;
            if (lease && !await renewLease()) return 0;
            const shouldContinue = () => runValid
                && !leaseLost
                && !signal.aborted
                && runGeneration === this.runGeneration;
            if (this.projector.reconcileTerminalTransitions) {
                await this.projector.reconcileTerminalTransitions(shouldContinue);
            }
            if (!shouldContinue()) return 0;
            return await this.projector.detectStalledActivities(
                this.stalledAfterMs,
                this.now(),
                shouldContinue
            );
        } catch (error) {
            logger.warn({ error: error instanceof Error ? error.message : String(error) },
                'Failed to detect stalled notification activity');
            return 0;
        } finally {
            runValid = false;
            signal.removeEventListener('abort', cancelRemainingWork);
            if (renewalTimer) clearInterval(renewalTimer);
            await releaseLease();
        }
    }
}
