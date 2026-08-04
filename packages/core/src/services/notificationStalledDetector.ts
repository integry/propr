import logger from '../utils/logger.js';
import {
    NotificationProjectionService,
    notificationProjectionService
} from './notificationProjectionService.js';
import {
    DEFAULT_NOTIFICATION_OPERATION_TIMEOUT_MS,
    DEFAULT_NOTIFICATION_SHUTDOWN_DRAIN_MS
} from './notificationSystemSampler.js';
import {
    MAX_NOTIFICATION_TIMER_DELAY_MS,
    isNotificationTimerDelay,
    settlesWithin,
    withNotificationDeadline
} from './notificationSchedulerTiming.js';
import {
    runWithNotificationLease,
    type NotificationProjectionLease
} from './notificationLeaseRunner.js';

export const DEFAULT_NOTIFICATION_STALLED_AFTER_MS = 30 * 60 * 1000;
export const DEFAULT_NOTIFICATION_STALLED_CHECK_INTERVAL_MS = 60 * 1000;

function positiveIntegerEnv(name: string, fallback: number, timerDelay = false): number {
    const raw = process.env[name];
    if (raw === undefined || raw.trim() === '') return fallback;
    const value = Number(raw);
    if (timerDelay
        ? isNotificationTimerDelay(value)
        : Number.isSafeInteger(value) && value > 0) return value;
    logger.warn({ name, value: raw }, 'Ignoring invalid notification timing configuration');
    return fallback;
}

export function getNotificationStalledAfterMs(): number {
    return positiveIntegerEnv('NOTIFICATION_STALLED_AFTER_MS', DEFAULT_NOTIFICATION_STALLED_AFTER_MS);
}

export function getNotificationStalledCheckIntervalMs(): number {
    return positiveIntegerEnv(
        'NOTIFICATION_STALLED_CHECK_INTERVAL_MS',
        DEFAULT_NOTIFICATION_STALLED_CHECK_INTERVAL_MS,
        true
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
        if (!Number.isSafeInteger(this.stalledAfterMs) || this.stalledAfterMs <= 0) {
            throw new TypeError('stalledAfterMs must be a positive safe integer');
        }
        for (const [name, value] of [
            ['intervalMs', this.intervalMs],
            ['operationTimeoutMs', this.operationTimeoutMs],
            ['drainTimeoutMs', this.drainTimeoutMs]
        ] as const) {
            if (!isNotificationTimerDelay(value)) {
                throw new TypeError(
                    `${name} must be between 1 and ${MAX_NOTIFICATION_TIMER_DELAY_MS} milliseconds`
                );
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
        // The abort signal fences any remaining writes, but an arbitrary projector
        // or SQLite call may not be cancellable. Keep this concurrency slot occupied
        // until the underlying promise actually settles so repeated deadlines cannot
        // accumulate orphaned work.
    }

    private async executeRun(runGeneration: number, signal: AbortSignal): Promise<number> {
        try {
            return await runWithNotificationLease({
                acquireLease: this.acquireLease,
                fallbackRenewalIntervalMs: Math.max(1000, Math.floor(this.intervalMs / 2)),
                generationIsCurrent: () => runGeneration === this.runGeneration,
                label: 'notification stalled-activity',
                signal,
                skippedValue: 0,
                work: async ({ hasLease, renewLease, shouldContinue }) => {
                    if (hasLease && !await renewLease()) return 0;
                    if (this.projector.reconcileTerminalTransitions) {
                        await this.projector.reconcileTerminalTransitions(shouldContinue);
                    }
                    if (!shouldContinue()) return 0;
                    return this.projector.detectStalledActivities(
                        this.stalledAfterMs,
                        this.now(),
                        shouldContinue
                    );
                }
            });
        } catch (error) {
            logger.warn({ error: error instanceof Error ? error.message : String(error) },
                'Failed to detect stalled notification activity');
            return 0;
        }
    }
}
