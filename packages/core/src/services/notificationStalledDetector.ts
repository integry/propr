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
    projector?: Pick<NotificationProjectionService, 'detectStalledActivities'>;
    stalledAfterMs?: number;
    intervalMs?: number;
    operationTimeoutMs?: number;
    drainTimeoutMs?: number;
    now?: () => string | number | Date;
    acquireLease?: () => Promise<boolean | NotificationProjectionLease>;
}

export class NotificationStalledDetector {
    private readonly projector: Pick<NotificationProjectionService, 'detectStalledActivities'>;
    private readonly stalledAfterMs: number;
    private readonly intervalMs: number;
    private readonly operationTimeoutMs: number;
    private readonly drainTimeoutMs: number;
    private readonly now: () => string | number | Date;
    private readonly acquireLease?: () => Promise<boolean | NotificationProjectionLease>;
    private timer: NodeJS.Timeout | null = null;
    private activeRun: Promise<number> | null = null;
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
        const run = this.executeRun(this.runGeneration);
        this.activeRun = run;
        try {
            return await run;
        } finally {
            if (this.activeRun === run) this.activeRun = null;
        }
    }

    async stop(): Promise<void> {
        this.runGeneration++;
        if (this.timer) clearInterval(this.timer);
        this.timer = null;
        const activeRun = this.activeRun;
        if (activeRun && !await settlesWithin(activeRun, this.drainTimeoutMs)) {
            logger.warn({ drainTimeoutMs: this.drainTimeoutMs },
                'Notification stalled-task detector stopped with unfinished work');
        }
        logger.info('Notification stalled-task detector stopped');
    }

    private async executeRun(runGeneration: number): Promise<number> {
        let lease: NotificationProjectionLease | undefined;
        let renewalTimer: NodeJS.Timeout | undefined;
        let renewalInFlight = false;
        let leaseLost = false;
        let runValid = true;
        const renewLease = async (): Promise<boolean> => {
            if (!lease || leaseLost || renewalInFlight) return !leaseLost;
            renewalInFlight = true;
            try {
                const renewed = await withNotificationDeadline(
                    lease.renew(), this.operationTimeoutMs, 'notification stalled-activity lease renewal'
                );
                if (!renewed) leaseLost = true;
            } catch (error) {
                leaseLost = true;
                logger.warn({ error: error instanceof Error ? error.message : String(error) },
                    'Failed to renew notification stalled-activity lease');
            } finally {
                renewalInFlight = false;
            }
            return !leaseLost;
        };
        try {
            if (this.acquireLease) {
                const acquired = await withNotificationDeadline(
                    this.acquireLease(), this.operationTimeoutMs, 'notification stalled-activity lease acquisition'
                );
                if (acquired === false) return 0;
                if (typeof acquired === 'object') {
                    lease = acquired;
                    renewalTimer = setInterval(() => { void renewLease(); },
                        lease.renewalIntervalMs ?? Math.max(1000, Math.floor(this.intervalMs / 2)));
                    renewalTimer.unref();
                }
            }
            if (lease && !await renewLease()) return 0;
            return await withNotificationDeadline(
                this.projector.detectStalledActivities(
                    this.stalledAfterMs,
                    this.now(),
                    () => runValid && !leaseLost && runGeneration === this.runGeneration
                ),
                this.operationTimeoutMs,
                'notification stalled-activity projection'
            );
        } catch (error) {
            logger.warn({ error: error instanceof Error ? error.message : String(error) },
                'Failed to detect stalled notification activity');
            return 0;
        } finally {
            runValid = false;
            if (renewalTimer) clearInterval(renewalTimer);
            if (lease) {
                try {
                    await withNotificationDeadline(
                        lease.release(), this.operationTimeoutMs, 'notification stalled-activity lease release'
                    );
                } catch (error) {
                    logger.warn({ error: error instanceof Error ? error.message : String(error) },
                        'Failed to release notification stalled-activity lease');
                }
            }
        }
    }
}
