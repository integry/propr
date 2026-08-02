import logger from '../utils/logger.js';
import {
    NotificationSystemProjection,
    notificationSystemProjection,
    type SystemStatusSnapshot
} from './notificationSystemProjection.js';

export const DEFAULT_NOTIFICATION_SYSTEM_CHECK_INTERVAL_MS = 30 * 1000;

function positiveIntegerEnv(name: string, fallback: number): number {
    const raw = process.env[name];
    if (raw === undefined || raw.trim() === '') return fallback;
    const value = Number(raw);
    if (Number.isSafeInteger(value) && value > 0) return value;
    logger.warn({ name, value: raw }, 'Ignoring invalid notification timing configuration');
    return fallback;
}

export function getNotificationSystemCheckIntervalMs(): number {
    return positiveIntegerEnv(
        'NOTIFICATION_SYSTEM_CHECK_INTERVAL_MS',
        DEFAULT_NOTIFICATION_SYSTEM_CHECK_INTERVAL_MS
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
    acquireLease?: () => Promise<boolean | NotificationProjectionLease>;
}

/** Samples installation health independently from dashboard polling. */
export class NotificationSystemSampler {
    private readonly getSnapshot: () => Promise<SystemStatusSnapshot>;
    private readonly projector: Pick<NotificationSystemProjection, 'projectSnapshot'>;
    private readonly intervalMs: number;
    private readonly acquireLease?: () => Promise<boolean | NotificationProjectionLease>;
    private timer: NodeJS.Timeout | null = null;
    private activeRun: Promise<boolean> | null = null;

    constructor(options: NotificationSystemSamplerOptions) {
        this.getSnapshot = options.getSnapshot;
        this.projector = options.projector ?? notificationSystemProjection;
        this.intervalMs = options.intervalMs ?? getNotificationSystemCheckIntervalMs();
        this.acquireLease = options.acquireLease;
        if (!Number.isSafeInteger(this.intervalMs) || this.intervalMs <= 0) {
            throw new TypeError('intervalMs must be a positive safe integer');
        }
    }

    start(): void {
        if (this.timer) return;
        void this.runOnce();
        this.timer = setInterval(() => { void this.runOnce(); }, this.intervalMs);
        this.timer.unref();
        logger.info({ intervalMs: this.intervalMs }, 'Notification system-health sampler started');
    }

    async runOnce(): Promise<boolean> {
        if (this.activeRun) return false;
        const run = this.executeRun();
        this.activeRun = run;
        try {
            return await run;
        } finally {
            if (this.activeRun === run) this.activeRun = null;
        }
    }

    async stop(): Promise<void> {
        if (this.timer) {
            clearInterval(this.timer);
            this.timer = null;
        }
        await this.activeRun;
        logger.info('Notification system-health sampler stopped');
    }

    private async executeRun(): Promise<boolean> {
        let lease: NotificationProjectionLease | undefined;
        let renewalTimer: NodeJS.Timeout | undefined;
        try {
            if (this.acquireLease) {
                const acquired = await this.acquireLease();
                if (acquired === false) return false;
                if (typeof acquired === 'object') {
                    lease = acquired;
                    renewalTimer = setInterval(() => {
                        void lease!.renew().catch((error) => logger.warn({
                            error: error instanceof Error ? error.message : String(error)
                        }, 'Failed to renew notification system-health lease'));
                    }, lease.renewalIntervalMs ?? Math.max(1000, Math.floor(this.intervalMs / 2)));
                    renewalTimer.unref();
                }
            }
            const snapshot = await this.getSnapshot();
            if (lease && !await lease.renew()) return false;
            await this.projector.projectSnapshot(snapshot);
            return true;
        } catch (error) {
            logger.warn({
                error: error instanceof Error ? error.message : String(error)
            }, 'Failed to sample system health for notifications');
            return false;
        } finally {
            if (renewalTimer) clearInterval(renewalTimer);
            if (lease) {
                try { await lease.release(); }
                catch (error) {
                    logger.warn({
                        error: error instanceof Error ? error.message : String(error)
                    }, 'Failed to release notification system-health lease');
                }
            }
        }
    }
}
