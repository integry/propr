/**
 * Drives idle shutdown (issue #3770): on every tick it resolves the setting,
 * collects the signals, evaluates them and publishes the result for
 * `/api/status`, `propr check` and the Web UI. Once the instance has been idle
 * for the configured window it re-checks one last time and hands over to the
 * owner's drain-and-exit routine.
 *
 * With the setting off it still publishes a status (so operators can see what
 * would keep the instance awake) but never stops anything.
 */

import {
    IDLE_LAST_SHUTDOWN_REDIS_KEY,
    IDLE_LAST_WAKE_REDIS_KEY,
    IDLE_STATUS_REDIS_KEY,
    type IdleShutdownConfig,
    type IdleShutdownRecord,
    type IdleShutdownStatus,
    type IdleWakeRecord,
} from '@propr/shared';
import { evaluateIdle, IdleClock, type IdleEvaluation, type IdleSignals } from './idleDetector.js';

export const DEFAULT_IDLE_CHECK_INTERVAL_MS = 30_000;
/** The published status outlives a few missed ticks, then disappears with the daemon. */
export const IDLE_STATUS_TTL_SECONDS = 120;

interface StatusRedis {
    set(key: string, value: string, mode: 'EX', seconds: number): Promise<unknown>;
    get(key: string): Promise<string | null>;
}

export interface IdleShutdownRequest {
    evaluation: IdleEvaluation;
    idleSince: number;
    idleForMs: number;
    config: IdleShutdownConfig;
}

export interface IdleShutdownControllerOptions {
    redis: StatusRedis;
    resolveConfig: () => Promise<IdleShutdownConfig>;
    collect: () => Promise<IdleSignals>;
    /** Drain and exit. Resolves `false` when the drain found new work and the instance keeps running. */
    onIdle: (request: IdleShutdownRequest) => Promise<boolean>;
    now?: () => number;
    intervalMs?: number;
    log?: { info(obj: object, msg: string): void; warn(obj: object, msg: string): void };
}

function parseRecord<T>(raw: string | null): T | null {
    if (!raw) return null;
    try {
        return JSON.parse(raw) as T;
    } catch {
        return null;
    }
}

export class IdleShutdownController {
    private readonly now: () => number;
    private readonly clock: IdleClock;
    private timer: NodeJS.Timeout | null = null;
    private running: Promise<void> | null = null;
    private shuttingDown = false;
    private stopped = false;
    private lastConfig: IdleShutdownConfig | null = null;

    constructor(private readonly options: IdleShutdownControllerOptions) {
        this.now = options.now ?? Date.now;
        this.clock = new IdleClock(this.now());
    }

    start(): void {
        if (this.timer || this.stopped) return;
        this.timer = setInterval(() => { void this.tick(); }, this.options.intervalMs ?? DEFAULT_IDLE_CHECK_INTERVAL_MS);
        this.timer.unref?.();
        void this.tick();
    }

    async stop(): Promise<void> {
        this.stopped = true;
        if (this.timer) clearInterval(this.timer);
        this.timer = null;
        // Called from inside the drain (the owner's close), the tick in progress is the caller.
        if (!this.shuttingDown) await this.running;
    }

    /** One evaluation; overlapping calls share the run in progress. */
    tick(): Promise<void> {
        if (this.shuttingDown || this.stopped) return Promise.resolve();
        this.running ??= this.runTick()
            .catch((error: unknown) => {
                this.options.log?.warn({ error: (error as Error).message }, 'Idle shutdown check failed; staying up');
            })
            .finally(() => { this.running = null; });
        return this.running;
    }

    private async runTick(): Promise<void> {
        let config: IdleShutdownConfig;
        try {
            config = await this.options.resolveConfig();
        } catch (error) {
            // An unreadable setting keeps the last known value (or off).
            this.options.log?.warn({ error: (error as Error).message }, 'Idle shutdown: could not read the setting');
            config = this.lastConfig ?? { enabled: false, afterMs: 0, source: 'default', warnings: [] };
        }
        if (this.lastConfig?.enabled !== config.enabled || this.lastConfig?.afterMs !== config.afterMs) {
            this.options.log?.info({ enabled: config.enabled, afterMs: config.afterMs, source: config.source }, 'Idle shutdown setting');
            this.clock.reset();
        }
        this.lastConfig = config;
        const signals = await this.options.collect();
        const now = this.now();
        const evaluation = evaluateIdle(signals, { now, windowMs: config.afterMs });
        const idleSince = config.enabled ? this.clock.observe(evaluation.idle, now, signals.lastActivityAt) : null;
        await this.publish(config, evaluation, idleSince, now);
        if (config.enabled && idleSince !== null && this.clock.isDue(now, config.afterMs)) {
            await this.shutdownIfStillIdle(config, idleSince);
        }
    }

    /** Re-collect right before stopping: the last tick may be up to one interval old. */
    private async shutdownIfStillIdle(config: IdleShutdownConfig, idleSince: number): Promise<void> {
        const now = this.now();
        const signals = await this.options.collect();
        const evaluation = evaluateIdle(signals, { now, windowMs: config.afterMs });
        if (!evaluation.idle || (signals.lastActivityAt ?? 0) > idleSince) {
            this.clock.reset();
            return;
        }
        this.shuttingDown = true;
        const request = { evaluation, idleSince, idleForMs: now - idleSince, config };
        this.options.log?.info({ idleForMs: request.idleForMs, nextDueAt: evaluation.nextDueAt }, 'Idle shutdown: instance idle, draining');
        let stopped = false;
        try {
            stopped = await this.options.onIdle(request);
        } finally {
            if (!stopped) {
                // The drain found new work: stay up and start the idle period over.
                this.shuttingDown = false;
                this.clock.reset();
            }
        }
    }

    private async publish(config: IdleShutdownConfig, evaluation: IdleEvaluation, idleSince: number | null, now: number): Promise<void> {
        const [lastShutdown, lastWake] = await Promise.all([
            this.options.redis.get(IDLE_LAST_SHUTDOWN_REDIS_KEY).then(parseRecord<IdleShutdownRecord>).catch(() => null),
            this.options.redis.get(IDLE_LAST_WAKE_REDIS_KEY).then(parseRecord<IdleWakeRecord>).catch(() => null),
        ]);
        const status: IdleShutdownStatus = {
            enabled: config.enabled,
            afterMs: config.afterMs,
            source: config.source,
            idle: evaluation.idle,
            idleSince: idleSince === null ? null : new Date(idleSince).toISOString(),
            shutdownAt: idleSince === null ? null : new Date(idleSince + config.afterMs).toISOString(),
            blockers: evaluation.blockers,
            nextDueAt: evaluation.nextDueAt === null ? null : new Date(evaluation.nextDueAt).toISOString(),
            checkedAt: new Date(now).toISOString(),
            lastShutdown,
            lastWake,
        };
        await this.options.redis.set(IDLE_STATUS_REDIS_KEY, JSON.stringify(status), 'EX', IDLE_STATUS_TTL_SECONDS).catch(() => undefined);
    }
}
