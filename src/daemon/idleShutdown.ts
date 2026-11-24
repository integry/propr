import type { Redis } from 'ioredis';
import {
    IDLE_LAST_SHUTDOWN_REDIS_KEY,
    IDLE_LAST_WAKE_REDIS_KEY,
    IDLE_SHUTDOWN_CHANNEL,
    IDLE_WAKE_SIGNAL_REDIS_KEY,
    type IdleShutdownRecord,
    type IdleWakeSource,
} from '@propr/shared';
import {
    IdleShutdownController,
    buildIdleWakeHint,
    buildIdleWakeRecord,
    classifyIdleWake,
    closeConnection,
    collectIdleSignals,
    db,
    evaluateIdle,
    isPendingIdleWake,
    loadIdleShutdownConfig,
    logger,
    readIdleWakeHint,
    resolveIdleWakeHintPath,
    writeIdleWakeHint,
    type IdleShutdownRequest,
    type RoutingWebSocketIntakeService,
} from '@propr/core';
import { createDaemonIdleSources } from './idleSignalSources.js';

/**
 * The daemon owns idle shutdown (issue #3770): it sees every shared signal,
 * owns Connect intake and the schedules, and so decides when the instance
 * may stop. Off by default; see `resolveIdleShutdownConfig`.
 *
 * Drain order once idle: send the wake hint to Connect while the socket is
 * open, stop intake (in-flight deliveries finish and ACK, the socket closes
 * with 1000), check once more that nothing arrived meanwhile, write the wake
 * hint file and shutdown record, tell the API and workers to exit, close the
 * daemon's own resources (queues, Redis, SQLite), flush logs and exit 0.
 */

/** Records kept for `/api/status` and the Web UI. */
const RECORD_TTL_SECONDS = 30 * 24 * 60 * 60;

export interface DaemonIdleShutdownDeps {
    redis: Redis;
    intakeMode: string;
    pollingIntervalMs: number;
    getRoutingService: () => RoutingWebSocketIntakeService | null;
    /** The daemon's normal graceful close (timers, routing, Redis, queues). */
    close: () => Promise<void>;
    exit?: (code: number) => void;
    intervalMs?: number;
}

export interface DaemonIdleShutdown {
    controller: IdleShutdownController;
    stop: () => Promise<void>;
}

function flushLogs(): Promise<void> {
    return new Promise(resolve => {
        const flush = (logger as unknown as { flush?: (cb?: (err?: Error) => void) => void }).flush;
        if (typeof flush !== 'function') return resolve();
        try {
            flush.call(logger, () => resolve());
        } catch {
            resolve();
        }
        setTimeout(resolve, 1_000).unref();
    });
}

async function drainAndExit(request: IdleShutdownRequest, deps: DaemonIdleShutdownDeps, collect: () => ReturnType<typeof collectIdleSignals>): Promise<boolean> {
    const nextDueAt = request.evaluation.nextDueAt === null ? null : new Date(request.evaluation.nextDueAt).toISOString();
    const routing = deps.getRoutingService();
    const reason = `idle for ${Math.round(request.idleForMs / 1000)}s`;
    if (routing) {
        const sent = routing.sendWakeHint(nextDueAt);
        logger.info({ nextDueAt, sent }, 'Idle shutdown: wake hint sent to Connect');
        await routing.stop();
    }
    // Deliveries ACKed during the drain may have queued work: look once more.
    const signals = await collect();
    const after = evaluateIdle(signals, { now: Date.now(), windowMs: request.config.afterMs });
    if (!after.idle || (signals.lastActivityAt ?? 0) > request.idleSince) {
        logger.info({ blockers: after.blockers }, 'Idle shutdown aborted: work arrived while draining');
        if (routing) await routing.start();
        return false;
    }
    const shutdownAt = Date.now();
    const hint = buildIdleWakeHint({ shutdownAt, reason, idleForMs: request.idleForMs, nextDue: after.nextDue });
    const record: IdleShutdownRecord = { shutdownAt: hint.shutdownAt, reason, idleForMs: request.idleForMs, nextDueAt: hint.nextDueAt };
    try {
        await writeIdleWakeHint(hint);
    } catch (error) {
        logger.warn({ error: (error as Error).message, file: resolveIdleWakeHintPath() }, 'Idle shutdown: could not write the wake hint file');
    }
    await deps.redis.set(IDLE_LAST_SHUTDOWN_REDIS_KEY, JSON.stringify(record), 'EX', RECORD_TTL_SECONDS).catch(() => undefined);
    await deps.redis.del(IDLE_WAKE_SIGNAL_REDIS_KEY).catch(() => undefined);
    await deps.redis.publish(IDLE_SHUTDOWN_CHANNEL, JSON.stringify({ shutdownAt: hint.shutdownAt, reason })).catch(() => undefined);
    logger.info({ ...record, file: resolveIdleWakeHintPath() }, 'Idle shutdown: stopping the control plane (exit 0)');
    await deps.close();
    await closeConnection();
    await flushLogs();
    (deps.exit ?? process.exit)(0);
    return true;
}

export function startDaemonIdleShutdown(deps: DaemonIdleShutdownDeps): DaemonIdleShutdown {
    const sources = createDaemonIdleSources({
        redis: deps.redis,
        database: db,
        intakeMode: deps.intakeMode,
        pollingIntervalMs: deps.pollingIntervalMs,
        connectInFlight: () => deps.getRoutingService()?.getInFlightCount() ?? 0,
    });
    const collect = () => collectIdleSignals(sources);
    const controller = new IdleShutdownController({
        redis: deps.redis,
        resolveConfig: () => loadIdleShutdownConfig(),
        collect,
        onIdle: request => drainAndExit(request, deps, collect),
        intervalMs: deps.intervalMs,
        log: logger,
    });
    controller.start();
    return { controller, stop: () => controller.stop() };
}

/** How long a wake waits for the API to report the request that woke the instance. */
export const WAKE_SIGNAL_WAIT_MS = 30_000;
const WAKE_SIGNAL_POLL_MS = 1_000;

async function waitForWakeSignal(redis: Redis, waitMs: number): Promise<IdleWakeSource | null> {
    const deadline = Date.now() + waitMs;
    for (;;) {
        const raw = await redis.get(IDLE_WAKE_SIGNAL_REDIS_KEY).catch(() => null);
        if (raw === 'http' || raw === 'connect_ping') return raw;
        if (Date.now() >= deadline) return null;
        await new Promise(resolve => setTimeout(resolve, WAKE_SIGNAL_POLL_MS).unref());
    }
}

/**
 * On start after an idle stop: ask Connect for deliveries cached while
 * stopped, name the wake source, record the cold start and mark the hint
 * consumed. Scheduled work that became due while stopped needs nothing extra:
 * the schedule sweeps run at startup and coalesce missed slots into one run.
 */
export async function recoverFromIdleWake(deps: {
    redis: Redis;
    routingService: RoutingWebSocketIntakeService | null;
    processStartedAt: number;
    waitMs?: number;
}): Promise<void> {
    const file = resolveIdleWakeHintPath();
    const hint = await readIdleWakeHint(file);
    if (!isPendingIdleWake(hint)) return;
    deps.routingService?.requestReplayOnConnect(hint.shutdownAt);
    const readyAt = Date.now();
    const apiSignal = await waitForWakeSignal(deps.redis, deps.waitMs ?? WAKE_SIGNAL_WAIT_MS);
    const source = classifyIdleWake({ hint, now: readyAt, apiSignal });
    const record = buildIdleWakeRecord({ hint, source, now: readyAt, processStartedAt: deps.processStartedAt });
    await deps.redis.set(IDLE_LAST_WAKE_REDIS_KEY, JSON.stringify(record), 'EX', RECORD_TTL_SECONDS).catch(() => undefined);
    await deps.redis.del(IDLE_WAKE_SIGNAL_REDIS_KEY).catch(() => undefined);
    const due = hint.nextDue.filter(item => item.dueAt <= readyAt);
    logger.info({ ...record, dueWhileStopped: due.map(item => item.detail) }, 'Woke from idle shutdown');
    await writeIdleWakeHint({ ...hint, wokeAt: record.wokeAt }, file).catch((error: Error) => {
        logger.warn({ error: error.message, file }, 'Could not mark the idle wake hint consumed');
    });
}
