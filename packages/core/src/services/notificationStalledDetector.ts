import { MAX_CANONICAL_TIMESTAMP_EPOCH_MS } from '@propr/shared';
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
    const name = 'NOTIFICATION_STALLED_AFTER_MS';
    const stalledAfterMs = positiveIntegerEnv(name, DEFAULT_NOTIFICATION_STALLED_AFTER_MS);
    if (Date.now() - stalledAfterMs >= -MAX_CANONICAL_TIMESTAMP_EPOCH_MS) {
        return stalledAfterMs;
    }
    logger.warn({ name, value: process.env[name] },
        'Ignoring notification stall threshold outside the supported Date range');
    return DEFAULT_NOTIFICATION_STALLED_AFTER_MS;
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
    timeoutRetryDelayMs?: number;
    now?: () => string | number | Date;
    acquireLease?: () => Promise<boolean | NotificationProjectionLease>;
}

const MAX_DETACHED_STALLED_RUNS = 2;

export class NotificationStalledDetector {
    private readonly projector: Pick<NotificationProjectionService, 'detectStalledActivities'>
        & Partial<Pick<NotificationProjectionService, 'reconcileTerminalTransitions'>>;
    private readonly stalledAfterMs: number;
    private readonly intervalMs: number;
    private readonly operationTimeoutMs: number;
    private readonly drainTimeoutMs: number;
    private readonly timeoutRetryDelayMs: number;
    private readonly now: () => string | number | Date;
    private readonly acquireLease?: () => Promise<boolean | NotificationProjectionLease>;
    private timer: NodeJS.Timeout | null = null;
    private activeRun: Promise<number> | null = null;
    private activeRunAbortController: AbortController | null = null;
    private readonly expiredRuns = new Set<Promise<number>>();
    private replacementNotBefore = 0;
    private consecutiveTimeouts = 0;
    private runGeneration = 0;

    constructor(options: NotificationStalledDetectorOptions = {}) {
        this.projector = options.projector ?? notificationProjectionService;
        this.stalledAfterMs = options.stalledAfterMs ?? getNotificationStalledAfterMs();
        this.intervalMs = options.intervalMs ?? getNotificationStalledCheckIntervalMs();
        this.operationTimeoutMs = options.operationTimeoutMs ?? DEFAULT_NOTIFICATION_OPERATION_TIMEOUT_MS;
        this.drainTimeoutMs = options.drainTimeoutMs ?? DEFAULT_NOTIFICATION_SHUTDOWN_DRAIN_MS;
        this.timeoutRetryDelayMs = options.timeoutRetryDelayMs ?? this.intervalMs;
        this.now = options.now ?? (() => new Date());
        this.acquireLease = options.acquireLease;
        const nowMs = new Date(this.now()).getTime();
        if (!Number.isSafeInteger(this.stalledAfterMs) || this.stalledAfterMs <= 0
            || !Number.isFinite(nowMs)
            || nowMs - this.stalledAfterMs < -MAX_CANONICAL_TIMESTAMP_EPOCH_MS) {
            throw new TypeError('stalledAfterMs must produce a supported Date cutoff');
        }
        for (const [name, value] of [
            ['intervalMs', this.intervalMs],
            ['operationTimeoutMs', this.operationTimeoutMs],
            ['drainTimeoutMs', this.drainTimeoutMs],
            ['timeoutRetryDelayMs', this.timeoutRetryDelayMs]
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
        if (this.activeRun
            || this.expiredRuns.size >= MAX_DETACHED_STALLED_RUNS
            || Date.now() < this.replacementNotBefore) return 0;
        const abortController = new AbortController();
        const run = this.executeRun(this.runGeneration, abortController.signal);
        this.activeRun = run;
        this.activeRunAbortController = abortController;
        void run.then(
            () => { this.clearActiveRun(run); },
            () => { this.clearActiveRun(run); }
        );
        try {
            const completed = await withNotificationDeadline(
                run,
                this.operationTimeoutMs,
                'notification stalled-activity run',
                () => this.expireActiveRun(run, abortController)
            );
            this.consecutiveTimeouts = 0;
            this.replacementNotBefore = 0;
            return completed;
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
        const unfinishedRuns = [
            ...(this.activeRun ? [this.activeRun] : []),
            ...this.expiredRuns,
        ];
        if (unfinishedRuns.length > 0 && !await settlesWithin(
            Promise.allSettled(unfinishedRuns),
            this.drainTimeoutMs
        )) {
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
        this.expiredRuns.add(run);
        void run.then(
            () => this.expiredRuns.delete(run),
            () => this.expiredRuns.delete(run)
        );
        this.consecutiveTimeouts++;
        const multiplier = 2 ** Math.min(10, this.consecutiveTimeouts - 1);
        const retryDelayMs = Math.min(
            MAX_NOTIFICATION_TIMER_DELAY_MS,
            this.timeoutRetryDelayMs * multiplier
        );
        this.replacementNotBefore = Date.now() + retryDelayMs;
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
