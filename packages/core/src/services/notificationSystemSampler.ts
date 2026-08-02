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

export interface NotificationSystemSamplerOptions {
    getSnapshot: () => Promise<SystemStatusSnapshot>;
    projector?: Pick<NotificationSystemProjection, 'projectSnapshot'>;
    intervalMs?: number;
    acquireLease?: () => Promise<boolean>;
}

/** Samples installation health independently from dashboard polling. */
export class NotificationSystemSampler {
    private readonly getSnapshot: () => Promise<SystemStatusSnapshot>;
    private readonly projector: Pick<NotificationSystemProjection, 'projectSnapshot'>;
    private readonly intervalMs: number;
    private readonly acquireLease?: () => Promise<boolean>;
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
        try {
            if (this.acquireLease && !await this.acquireLease()) return false;
            const snapshot = await this.getSnapshot();
            await this.projector.projectSnapshot(snapshot);
            return true;
        } catch (error) {
            logger.warn({
                error: error instanceof Error ? error.message : String(error)
            }, 'Failed to sample system health for notifications');
            return false;
        }
    }
}
