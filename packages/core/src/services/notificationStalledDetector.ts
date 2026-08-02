import logger from '../utils/logger.js';
import {
    NotificationProjectionService,
    notificationProjectionService
} from './notificationProjectionService.js';

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
    return positiveIntegerEnv(
        'NOTIFICATION_STALLED_AFTER_MS',
        DEFAULT_NOTIFICATION_STALLED_AFTER_MS
    );
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
    now?: () => string | number | Date;
}

export class NotificationStalledDetector {
    private readonly projector: Pick<NotificationProjectionService, 'detectStalledActivities'>;
    private readonly stalledAfterMs: number;
    private readonly intervalMs: number;
    private readonly now: () => string | number | Date;
    private timer: NodeJS.Timeout | null = null;
    private running = false;

    constructor(options: NotificationStalledDetectorOptions = {}) {
        this.projector = options.projector ?? notificationProjectionService;
        this.stalledAfterMs = options.stalledAfterMs ?? getNotificationStalledAfterMs();
        this.intervalMs = options.intervalMs ?? getNotificationStalledCheckIntervalMs();
        this.now = options.now ?? (() => new Date());
        if (!Number.isSafeInteger(this.stalledAfterMs) || this.stalledAfterMs <= 0) {
            throw new TypeError('stalledAfterMs must be a positive safe integer');
        }
        if (!Number.isSafeInteger(this.intervalMs) || this.intervalMs <= 0) {
            throw new TypeError('intervalMs must be a positive safe integer');
        }
    }

    start(): void {
        if (this.timer) return;
        void this.runOnce();
        this.timer = setInterval(() => { void this.runOnce(); }, this.intervalMs);
        this.timer.unref();
        logger.info({
            stalledAfterMs: this.stalledAfterMs,
            intervalMs: this.intervalMs
        }, 'Notification stalled-task detector started');
    }

    async runOnce(): Promise<number> {
        if (this.running) return 0;
        this.running = true;
        try {
            return await this.projector.detectStalledActivities(this.stalledAfterMs, this.now());
        } catch (error) {
            logger.warn({
                error: error instanceof Error ? error.message : String(error)
            }, 'Failed to detect stalled notification activity');
            return 0;
        } finally {
            this.running = false;
        }
    }

    stop(): void {
        if (!this.timer) return;
        clearInterval(this.timer);
        this.timer = null;
        logger.info('Notification stalled-task detector stopped');
    }
}
