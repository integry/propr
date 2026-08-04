import logger from '../utils/logger.js';
import {
    NotificationSystemProjection,
    notificationSystemProjection,
    type SystemStatusSnapshot
} from './notificationSystemProjection.js';
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

export const DEFAULT_NOTIFICATION_SYSTEM_CHECK_INTERVAL_MS = 30 * 1000;
export const DEFAULT_NOTIFICATION_SYSTEM_STARTUP_GRACE_MS = 2 * 60 * 1000;
export const DEFAULT_NOTIFICATION_OPERATION_TIMEOUT_MS = 10 * 1000;
export const DEFAULT_NOTIFICATION_SHUTDOWN_DRAIN_MS = 5 * 1000;
export const MIN_NOTIFICATION_LEASE_RENEWAL_INTERVAL_MS = 1000;

export function getNotificationProjectionLeaseTtlMs(
    checkIntervalMs: number,
    operationTimeoutMs = DEFAULT_NOTIFICATION_OPERATION_TIMEOUT_MS
): number {
    for (const [name, value] of [
        ['checkIntervalMs', checkIntervalMs],
        ['operationTimeoutMs', operationTimeoutMs]
    ] as const) {
        if (!isNotificationTimerDelay(value)) {
            throw new TypeError(`${name} must be a schedulable positive integer`);
        }
    }
    return Math.min(MAX_NOTIFICATION_TIMER_DELAY_MS, Math.max(
        checkIntervalMs * 2,
        operationTimeoutMs * 2,
        MIN_NOTIFICATION_LEASE_RENEWAL_INTERVAL_MS * 3
    ));
}

function positiveIntegerEnv(name: string, fallback: number): number {
    const raw = process.env[name];
    if (raw === undefined || raw.trim() === '') return fallback;
    const value = Number(raw);
    if (isNotificationTimerDelay(value)) return value;
    logger.warn({ name, value: raw }, 'Ignoring invalid notification timing configuration');
    return fallback;
}

function nonNegativeIntegerEnv(name: string, fallback: number): number {
    const raw = process.env[name];
    if (raw === undefined || raw.trim() === '') return fallback;
    const value = Number(raw);
    if (isNotificationTimerDelay(value, true)) return value;
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

export interface NotificationSystemSamplerOptions {
    getSnapshot: () => Promise<SystemStatusSnapshot>;
    projector?: Pick<NotificationSystemProjection, 'projectSnapshot'>;
    intervalMs?: number;
    startupGraceMs?: number;
    operationTimeoutMs?: number;
    drainTimeoutMs?: number;
    timeoutRetryDelayMs?: number;
    acquireLease?: () => Promise<boolean | NotificationProjectionLease>;
}

const MAX_DETACHED_SYSTEM_RUNS = 2;

/** Samples installation health independently from dashboard polling. */
export class NotificationSystemSampler {
    private readonly getSnapshot: () => Promise<SystemStatusSnapshot>;
    private readonly projector: Pick<NotificationSystemProjection, 'projectSnapshot'>;
    private readonly intervalMs: number;
    private readonly startupGraceMs: number;
    private readonly operationTimeoutMs: number;
    private readonly drainTimeoutMs: number;
    private readonly timeoutRetryDelayMs: number;
    private readonly acquireLease?: () => Promise<boolean | NotificationProjectionLease>;
    private startupTimer: NodeJS.Timeout | null = null;
    private intervalTimer: NodeJS.Timeout | null = null;
    private activeRun: Promise<boolean> | null = null;
    private activeRunAbortController: AbortController | null = null;
    private readonly expiredRuns = new Set<Promise<boolean>>();
    private replacementNotBefore = 0;
    private consecutiveTimeouts = 0;
    private runGeneration = 0;

    constructor(options: NotificationSystemSamplerOptions) {
        this.getSnapshot = options.getSnapshot;
        this.projector = options.projector ?? notificationSystemProjection;
        this.intervalMs = options.intervalMs ?? getNotificationSystemCheckIntervalMs();
        this.startupGraceMs = options.startupGraceMs ?? getNotificationSystemStartupGraceMs();
        this.operationTimeoutMs = options.operationTimeoutMs ?? DEFAULT_NOTIFICATION_OPERATION_TIMEOUT_MS;
        this.drainTimeoutMs = options.drainTimeoutMs ?? DEFAULT_NOTIFICATION_SHUTDOWN_DRAIN_MS;
        this.timeoutRetryDelayMs = options.timeoutRetryDelayMs ?? this.intervalMs;
        this.acquireLease = options.acquireLease;
        for (const [name, value, allowZero] of [
            ['intervalMs', this.intervalMs, false],
            ['startupGraceMs', this.startupGraceMs, true],
            ['operationTimeoutMs', this.operationTimeoutMs, false],
            ['drainTimeoutMs', this.drainTimeoutMs, false],
            ['timeoutRetryDelayMs', this.timeoutRetryDelayMs, false]
        ] as const) {
            if (!isNotificationTimerDelay(value, allowZero)) {
                throw new TypeError(
                    `${name} must be a schedulable ${allowZero ? 'non-negative' : 'positive'} integer`
                );
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
        if (this.activeRun
            || this.expiredRuns.size >= MAX_DETACHED_SYSTEM_RUNS
            || Date.now() < this.replacementNotBefore) return false;
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
                'notification system-health run',
                () => this.expireActiveRun(run, abortController)
            );
            this.consecutiveTimeouts = 0;
            this.replacementNotBefore = 0;
            return completed;
        } catch (error) {
            logger.warn({ error: error instanceof Error ? error.message : String(error) },
                'Failed to sample system health for notifications');
            return false;
        }
    }

    async stop(): Promise<void> {
        this.runGeneration++;
        this.activeRunAbortController?.abort();
        if (this.startupTimer) clearTimeout(this.startupTimer);
        if (this.intervalTimer) clearInterval(this.intervalTimer);
        this.startupTimer = null;
        this.intervalTimer = null;
        const unfinishedRuns = [
            ...(this.activeRun ? [this.activeRun] : []),
            ...this.expiredRuns,
        ];
        if (unfinishedRuns.length > 0 && !await settlesWithin(
            Promise.allSettled(unfinishedRuns),
            this.drainTimeoutMs
        )) {
            logger.warn({ drainTimeoutMs: this.drainTimeoutMs },
                'Notification system-health sampler stopped with unfinished work');
        }
        logger.info('Notification system-health sampler stopped');
    }

    private clearActiveRun(run: Promise<boolean>): void {
        if (this.activeRun !== run) return;
        this.activeRun = null;
        this.activeRunAbortController = null;
    }

    private expireActiveRun(run: Promise<boolean>, abortController: AbortController): void {
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

    private async executeRun(runGeneration: number, signal: AbortSignal): Promise<boolean> {
        try {
            return await runWithNotificationLease({
                acquireLease: this.acquireLease,
                fallbackRenewalIntervalMs: Math.max(1000, Math.floor(this.intervalMs / 2)),
                generationIsCurrent: () => runGeneration === this.runGeneration,
                label: 'notification system-health',
                signal,
                skippedValue: false,
                work: async ({ hasLease, renewLease, shouldContinue }) => {
                    const snapshot = await this.getSnapshot();
                    if (!shouldContinue()) return false;
                    if (hasLease && !await renewLease()) return false;
                    await this.projector.projectSnapshot(snapshot, [], shouldContinue);
                    return shouldContinue();
                }
            });
        } catch (error) {
            logger.warn({ error: error instanceof Error ? error.message : String(error) },
                'Failed to sample system health for notifications');
            return false;
        }
    }
}
