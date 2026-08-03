import logger from '../utils/logger.js';
import {
    NotificationSystemProjection,
    notificationSystemProjection,
    type SystemStatusSnapshot
} from './notificationSystemProjection.js';
import { settlesWithin, withNotificationDeadline } from './notificationSchedulerTiming.js';

export const DEFAULT_NOTIFICATION_SYSTEM_CHECK_INTERVAL_MS = 30 * 1000;
export const DEFAULT_NOTIFICATION_SYSTEM_STARTUP_GRACE_MS = 2 * 60 * 1000;
export const DEFAULT_NOTIFICATION_OPERATION_TIMEOUT_MS = 10 * 1000;
export const DEFAULT_NOTIFICATION_SHUTDOWN_DRAIN_MS = 5 * 1000;

function positiveIntegerEnv(name: string, fallback: number): number {
    const raw = process.env[name];
    if (raw === undefined || raw.trim() === '') return fallback;
    const value = Number(raw);
    if (Number.isSafeInteger(value) && value > 0) return value;
    logger.warn({ name, value: raw }, 'Ignoring invalid notification timing configuration');
    return fallback;
}

function nonNegativeIntegerEnv(name: string, fallback: number): number {
    const raw = process.env[name];
    if (raw === undefined || raw.trim() === '') return fallback;
    const value = Number(raw);
    if (Number.isSafeInteger(value) && value >= 0) return value;
    logger.warn({ name, value: raw }, 'Ignoring invalid notification timing configuration');
    return fallback;
}

export function getNotificationSystemCheckIntervalMs(): number {
    return positiveIntegerEnv(
        'NOTIFICATION_SYSTEM_CHECK_INTERVAL_MS',
        DEFAULT_NOTIFICATION_SYSTEM_CHECK_INTERVAL_MS
    );
}

export function getNotificationSystemStartupGraceMs(): number {
    return nonNegativeIntegerEnv(
        'NOTIFICATION_SYSTEM_STARTUP_GRACE_MS',
        DEFAULT_NOTIFICATION_SYSTEM_STARTUP_GRACE_MS
    );
}

export interface NotificationProjectionLease {
    renew(): Promise<boolean>;
    release(): Promise<void>;
    renewalIntervalMs?: number;
}

export interface NotificationSystemSamplerOptions {
    getSnapshot: () => Promise<SystemStatusSnapshot>;
    projector?: Pick<NotificationSystemProjection, 'projectSnapshot'>;
    intervalMs?: number;
    startupGraceMs?: number;
    operationTimeoutMs?: number;
    drainTimeoutMs?: number;
    acquireLease?: () => Promise<boolean | NotificationProjectionLease>;
}

/** Samples installation health independently from dashboard polling. */
export class NotificationSystemSampler {
    private readonly getSnapshot: () => Promise<SystemStatusSnapshot>;
    private readonly projector: Pick<NotificationSystemProjection, 'projectSnapshot'>;
    private readonly intervalMs: number;
    private readonly startupGraceMs: number;
    private readonly operationTimeoutMs: number;
    private readonly drainTimeoutMs: number;
    private readonly acquireLease?: () => Promise<boolean | NotificationProjectionLease>;
    private startupTimer: NodeJS.Timeout | null = null;
    private intervalTimer: NodeJS.Timeout | null = null;
    private activeRun: Promise<boolean> | null = null;
    private runGeneration = 0;

    constructor(options: NotificationSystemSamplerOptions) {
        this.getSnapshot = options.getSnapshot;
        this.projector = options.projector ?? notificationSystemProjection;
        this.intervalMs = options.intervalMs ?? getNotificationSystemCheckIntervalMs();
        this.startupGraceMs = options.startupGraceMs ?? getNotificationSystemStartupGraceMs();
        this.operationTimeoutMs = options.operationTimeoutMs ?? DEFAULT_NOTIFICATION_OPERATION_TIMEOUT_MS;
        this.drainTimeoutMs = options.drainTimeoutMs ?? DEFAULT_NOTIFICATION_SHUTDOWN_DRAIN_MS;
        this.acquireLease = options.acquireLease;
        for (const [name, value, allowZero] of [
            ['intervalMs', this.intervalMs, false],
            ['startupGraceMs', this.startupGraceMs, true],
            ['operationTimeoutMs', this.operationTimeoutMs, false],
            ['drainTimeoutMs', this.drainTimeoutMs, false]
        ] as const) {
            if (!Number.isSafeInteger(value) || (allowZero ? value < 0 : value <= 0)) {
                throw new TypeError(`${name} must be ${allowZero ? 'a non-negative' : 'a positive'} safe integer`);
            }
        }
    }

    start(): void {
        if (this.startupTimer || this.intervalTimer) return;
        this.startupTimer = setTimeout(() => {
            this.startupTimer = null;
            void this.runOnce();
            this.intervalTimer = setInterval(() => { void this.runOnce(); }, this.intervalMs);
            this.intervalTimer.unref();
        }, this.startupGraceMs);
        this.startupTimer.unref();
        logger.info({
            intervalMs: this.intervalMs,
            startupGraceMs: this.startupGraceMs
        }, 'Notification system-health sampler started');
    }

    async runOnce(): Promise<boolean> {
        if (this.activeRun) return false;
        const run = this.executeRun(this.runGeneration);
        this.activeRun = run;
        void run.then(
            () => { if (this.activeRun === run) this.activeRun = null; },
            () => { if (this.activeRun === run) this.activeRun = null; }
        );
        try {
            return await withNotificationDeadline(
                run,
                this.operationTimeoutMs,
                'notification system-health run'
            );
        } catch (error) {
            logger.warn({ error: error instanceof Error ? error.message : String(error) },
                'Failed to sample system health for notifications');
            return false;
        }
    }

    async stop(): Promise<void> {
        this.runGeneration++;
        if (this.startupTimer) clearTimeout(this.startupTimer);
        if (this.intervalTimer) clearInterval(this.intervalTimer);
        this.startupTimer = null;
        this.intervalTimer = null;
        const activeRun = this.activeRun;
        if (activeRun && !await settlesWithin(activeRun, this.drainTimeoutMs)) {
            logger.warn({ drainTimeoutMs: this.drainTimeoutMs },
                'Notification system-health sampler stopped with unfinished work');
        }
        logger.info('Notification system-health sampler stopped');
    }

    private async executeRun(runGeneration: number): Promise<boolean> {
        let lease: NotificationProjectionLease | undefined;
        let renewalTimer: NodeJS.Timeout | undefined;
        let renewalInFlight: Promise<boolean> | null = null;
        let leaseLost = false;
        let runValid = true;
        const renewLease = (): Promise<boolean> => {
            if (!lease || leaseLost) return Promise.resolve(!leaseLost);
            if (renewalInFlight) return renewalInFlight;
            const renewal = (async () => {
                try {
                    const renewed = await lease.renew();
                    if (!renewed) leaseLost = true;
                } catch (error) {
                    leaseLost = true;
                    logger.warn({ error: error instanceof Error ? error.message : String(error) },
                        'Failed to renew notification system-health lease');
                }
                return !leaseLost;
            })();
            renewalInFlight = renewal;
            void renewal.then(() => {
                if (renewalInFlight === renewal) renewalInFlight = null;
            });
            return renewal;
        };
        try {
            if (this.acquireLease) {
                const acquired = await this.acquireLease();
                if (acquired === false) return false;
                if (typeof acquired === 'object') {
                    lease = acquired;
                    renewalTimer = setInterval(() => { void renewLease(); },
                        lease.renewalIntervalMs ?? Math.max(1000, Math.floor(this.intervalMs / 2)));
                    renewalTimer.unref();
                }
            }
            const snapshot = await this.getSnapshot();
            if (lease && !await renewLease()) return false;
            await this.projector.projectSnapshot(
                snapshot,
                [],
                () => runValid && !leaseLost && runGeneration === this.runGeneration
            );
            return !leaseLost && runGeneration === this.runGeneration;
        } catch (error) {
            logger.warn({ error: error instanceof Error ? error.message : String(error) },
                'Failed to sample system health for notifications');
            return false;
        } finally {
            runValid = false;
            if (renewalTimer) clearInterval(renewalTimer);
            if (renewalInFlight) await renewalInFlight;
            if (lease) {
                try {
                    await lease.release();
                } catch (error) {
                    logger.warn({ error: error instanceof Error ? error.message : String(error) },
                        'Failed to release notification system-health lease');
                }
            }
        }
    }
}
