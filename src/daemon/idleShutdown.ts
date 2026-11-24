import { hostname } from 'node:os';
import type { Redis } from 'ioredis';
import {
    IDLE_LAST_SHUTDOWN_REDIS_KEY,
    IDLE_LAST_WAKE_REDIS_KEY,
    IDLE_SHUTDOWN_INTENT_REDIS_KEY,
    IDLE_WAKE_SIGNAL_REDIS_KEY,
    type IdleShutdownRecord,
    type IdleWakeHint,
    type IdleWakeSource,
} from '@propr/shared';
import {
    IdleShutdownController,
    buildIdleWakeHint,
    buildIdleWakeRecord,
    classifyIdleWake,
    closeConnection,
    collectIdleSignals,
    connectReplaySince,
    db,
    evaluateIdle,
    issueIdleShutdownIntent,
    isPendingIdleWake,
    listIdleParticipants,
    listIdleShutdownTargets,
    loadIdleShutdownConfig,
    logger,
    needsConnectReplay,
    newIdleShutdownIntent,
    readIdleWakeHint,
    resolveIdleWakeHintPath,
    waitForIdleAcks,
    withdrawIdleShutdownIntent,
    writeIdleWakeHint,
    type IdleShutdownIntent,
    type IdleShutdownRequest,
    type IdleSignals,
    type IntentRedis,
    type RoutingWebSocketIntakeService,
} from '@propr/core';
import { flushLogs } from '../shared/flushLogs.js';
import { createDaemonIdleSources } from './idleSignalSources.js';
import {
    hintFileIo,
    recordAbortedDrainReplay,
    recordAcceptedReplay,
    recordDrainReplayObligation,
    requestOwedReplay,
    updateHint,
    withHintFile,
} from './idleReplayObligation.js';

/**
 * The daemon owns idle shutdown (issue #3770): it sees every shared signal,
 * owns Connect intake and the schedules, and so decides when the instance
 * may stop. Off by default; see `resolveIdleShutdownConfig`.
 *
 * Drain order once idle (any failure before step 6 restores intake and keeps
 * the instance running):
 *   1. Connect intake: the relay must acknowledge the wake hint (it will wake
 *      the instance and replay cached deliveries). No acknowledgement, no stop.
 *   2. Quiesce the producers: record in the wake hint file the Connect replay
 *      owed from now on (before disconnecting, so a crash mid-drain keeps it;
 *      no record, no disconnect), stop Connect intake (in-flight deliveries
 *      finish and ACK) and ask every API process to stop admitting requests;
 *      each one waits for its requests in flight and acknowledges.
 *   3. Check again, now that nothing can add work.
 *   4. Write the wake hint file (the recovery marker and the wake schedule for
 *      other supervisors), replacing the record from step 2. A failed write
 *      aborts. A Connect replay an earlier wake still owes is carried over as
 *      the replay cursor.
 *   5. Record the shutdown.
 *   6. Ask every registered process (by generation: one that starts later is
 *      not asked) to stop, and wait until each has acknowledged (the request
 *      is stored, so a process that reconnects still gets it) or is confirmed
 *      stopped. Unconfirmed, the daemon does not exit.
 *   7. Close the daemon's own resources, flush logs and exit 0. In a composed
 *      process (all-in-one) every component closes together instead, through
 *      the process's one coordinated close (`stopProcess`).
 */

/** Records kept for `/api/status` and the Web UI. */
const RECORD_TTL_SECONDS = 30 * 24 * 60 * 60;

export interface IdleDrainTimings {
    /** How long API processes get to confirm they are quiesced. */
    quiesceTimeoutMs: number;
    /** How long to wait for stop acknowledgements; null waits until confirmed (or the daemon is stopped). */
    stopConfirmTimeoutMs: number | null;
    /** How long to wait, after every acknowledgement, for processes to deregister. */
    deregisterWaitMs: number;
    pollMs: number;
    /** Step 7 (standalone): how long the daemon's own close may take before it exits 0 anyway. */
    closeDeadlineMs: number;
}

export const DEFAULT_IDLE_DRAIN_TIMINGS: IdleDrainTimings = {
    quiesceTimeoutMs: 30_000,
    stopConfirmTimeoutMs: null,
    deregisterWaitMs: 30_000,
    pollMs: 1_000,
    closeDeadlineMs: 30_000,
};

type IdleRoutingIntake = Pick<RoutingWebSocketIntakeService, 'sendWakeHint' | 'stop' | 'start' | 'requestReplay'>;

export interface IdleDrainContext {
    redis: IntentRedis;
    routing: IdleRoutingIntake | null;
    collect: () => Promise<IdleSignals>;
    writeHint?: (hint: IdleWakeHint) => Promise<void>;
    readHint?: () => Promise<IdleWakeHint | null>;
    /** The daemon's normal graceful close (timers, routing, Redis, queues). */
    close: () => Promise<void>;
    exit: (code: number) => void;
    /**
     * Composed process (all-in-one): the participants in this process only
     * acknowledged the stop; this runs the process's coordinated close of
     * every component (including the daemon) and exits. Replaces step 7.
     */
    stopProcess?: () => void;
    timings?: Partial<IdleDrainTimings>;
    /** True once the daemon is shutting down for another reason (SIGTERM): stop waiting, do not exit here. */
    isCancelled?: () => boolean;
}

export interface DaemonIdleShutdownDeps {
    redis: Redis;
    intakeMode: string;
    getRoutingService: () => RoutingWebSocketIntakeService | null;
    /** The daemon's normal graceful close (timers, routing, Redis, queues). */
    close: () => Promise<void>;
    exit?: (code: number) => void;
    /** See {@link IdleDrainContext.stopProcess}. */
    stopProcess?: () => void;
    intervalMs?: number;
    timings?: Partial<IdleDrainTimings>;
}

export interface DaemonIdleShutdown {
    controller: IdleShutdownController;
    stop: () => Promise<void>;
}

const toIso = (ms: number | null): string | null => (ms === null ? null : new Date(ms).toISOString());

/**
 * Wait (bounded) until no participant from `targets` remains registered: each
 * has finished its graceful shutdown. With `skipOwnProcess` (composed) the
 * participants in this process deregister in the coordinated close instead.
 */
async function waitForDeregistration(redis: IntentRedis, timings: IdleDrainTimings, targets: Set<string>, skipOwnProcess: boolean): Promise<string[]> {
    const deadline = Date.now() + timings.deregisterWaitMs;
    for (;;) {
        const remaining = (await listIdleParticipants(redis).catch(() => []))
            .filter(({ key, participant }) => targets.has(key) && !(skipOwnProcess && participant?.pid === process.pid && participant.host === hostname()))
            .map(entry => entry.key);
        if (remaining.length === 0 || Date.now() >= deadline) return remaining;
        await new Promise(resolve => setTimeout(resolve, timings.pollMs));
    }
}

/**
 * Step 4: write the hint for this stop, keeping the cursor of a replay an
 * earlier stop still owes; otherwise this stop's replay runs from when its
 * intake disconnected (`intakeStoppedAt`), not from `shutdownAt`. The record
 * this drain wrote before disconnecting owes exactly that: it is replaced.
 */
function persistStopHint(ctx: IdleDrainContext, input: Omit<Parameters<typeof buildIdleWakeHint>[0], 'shutdownAt' | 'pendingReplaySince'>): Promise<IdleWakeHint> {
    return withHintFile(async () => {
        const previous = await (ctx.readHint ?? readIdleWakeHint)().catch(() => null);
        const carried = needsConnectReplay(previous) ? connectReplaySince(previous) : null;
        const own = typeof input.intakeStoppedAt === 'number' ? new Date(input.intakeStoppedAt).toISOString() : null;
        const next = buildIdleWakeHint({ ...input, shutdownAt: Date.now(), pendingReplaySince: carried === own ? null : carried });
        await (ctx.writeHint ?? writeIdleWakeHint)(next);
        return next;
    });
}

/**
 * Step 2, Connect intake: record the replay owed from now on, then disconnect.
 * The relay caches what arrives from the disconnect on, so the cursor is taken
 * before it, and the obligation must be on disk before it too: the Redis
 * intent holds no cursor and is cleared at startup, and reconnecting alone
 * does not replay. Returns when intake was disconnected (null without Connect
 * intake), or the error that kept it connected.
 */
async function disconnectIntakeOwingReplay(ctx: IdleDrainContext): Promise<number | null | Error> {
    if (!ctx.routing) return null;
    const disconnectAt = Date.now();
    try {
        await recordDrainReplayObligation(disconnectAt, { readHint: ctx.readHint, writeHint: ctx.writeHint });
    } catch (error) {
        return error instanceof Error ? error : new Error(String(error));
    }
    await ctx.routing.stop();
    return disconnectAt;
}

/**
 * Drain and exit (see the module comment for the order). Resolves false when
 * the instance keeps running; true once the stop is under way.
 */
export async function drainIdleControlPlane(request: IdleShutdownRequest, ctx: IdleDrainContext): Promise<boolean> {
    const timings = { ...DEFAULT_IDLE_DRAIN_TIMINGS, ...ctx.timings };
    const { redis, routing } = ctx;
    const nextDueAt = toIso(request.evaluation.nextDueAt);
    const reason = `idle for ${Math.round(request.idleForMs / 1000)}s`;

    // 1. With Connect intake the relay is the wake arrangement and the replay source: it must accept.
    if (routing) {
        const accepted = await routing.sendWakeHint(nextDueAt);
        if (!accepted) {
            logger.warn({ nextDueAt }, 'Idle shutdown aborted: Connect did not acknowledge the wake hint, so nothing would wake the instance or replay its deliveries; staying up');
            return false;
        }
        logger.info({ nextDueAt }, 'Idle shutdown: Connect accepted the wake hint');
    }

    const intent: IdleShutdownIntent = newIdleShutdownIntent('quiesce', reason);
    /** When Connect intake was disconnected (taken before the disconnect): the replay cursor for this drain. */
    let intakeStoppedAt: number | null = null;
    let hintWritten: IdleWakeHint | null = null;
    const abort = async (message: string, details: object = {}): Promise<false> => {
        logger.info({ ...details, intentId: intent.id }, `Idle shutdown aborted: ${message}; staying up`);
        await withdrawIdleShutdownIntent(redis, intent.id).catch(() => undefined);
        if (intakeStoppedAt !== null && routing) await resumeIntakeOwingReplay(ctx, routing, intakeStoppedAt, hintWritten);
        // The hint file must not make the next plain start look like a wake.
        else if (hintWritten) await (ctx.writeHint ?? writeIdleWakeHint)({ ...hintWritten, wokeAt: new Date().toISOString() }).catch(() => undefined);
        return false;
    };

    // 2. Quiesce every producer before the last check.
    try {
        await issueIdleShutdownIntent(redis, intent);
    } catch (error) {
        return abort('could not record the drain request', { error: (error as Error).message });
    }
    const disconnected = await disconnectIntakeOwingReplay(ctx);
    if (disconnected instanceof Error) {
        return abort('could not record the Connect replay owed for the drain, so intake stays connected', { error: disconnected.message, file: resolveIdleWakeHintPath() });
    }
    intakeStoppedAt = disconnected;
    const quiesced = await waitForIdleAcks(redis, intent, { roles: ['api'], timeoutMs: timings.quiesceTimeoutMs, pollMs: timings.pollMs });
    if (!quiesced.confirmed) return abort('API processes did not confirm they stopped admitting requests', { pending: quiesced.pending });

    // 3. Nothing can add work now: look once more.
    const signals = await ctx.collect();
    const after = evaluateIdle(signals, { now: Date.now(), windowMs: request.config.afterMs });
    if (!after.idle || (signals.lastActivityAt ?? 0) > request.idleSince) {
        return abort('work arrived while draining', { blockers: after.blockers, lastActivityAt: toIso(signals.lastActivityAt) });
    }
    if (routing && after.nextDueAt !== null && (request.evaluation.nextDueAt === null || after.nextDueAt < request.evaluation.nextDueAt)) {
        return abort('scheduled work is due earlier than the wake hint Connect accepted', { nextDueAt: toIso(after.nextDueAt), hinted: nextDueAt });
    }

    // 4. The hint file is the recovery marker (and the wake schedule for other supervisors): no file, no stop.
    //    A replay still owed for an earlier stop stays owed: its cursor is carried into the new hint.
    let hint: IdleWakeHint;
    try {
        hint = await persistStopHint(ctx, { reason, idleForMs: request.idleForMs, nextDue: after.nextDue, connect: routing !== null, intakeStoppedAt });
        hintWritten = hint;
    } catch (error) {
        return abort('could not write the wake hint file', { error: (error as Error).message, file: resolveIdleWakeHintPath() });
    }

    // 5. Records for /api/status (informational).
    const record: IdleShutdownRecord = { shutdownAt: hint.shutdownAt, reason, idleForMs: request.idleForMs, nextDueAt: hint.nextDueAt };
    await redis.set(IDLE_LAST_SHUTDOWN_REDIS_KEY, JSON.stringify(record), 'EX', RECORD_TTL_SECONDS).catch(() => undefined);
    await redis.del(IDLE_WAKE_SIGNAL_REDIS_KEY).catch(() => undefined);

    // 6. Stop everything else, and hear back from every process.
    const stopRoles = ['api', 'worker', 'indexing_worker'] as const;
    let stopIntent: IdleShutdownIntent;
    try {
        // Only the generations registered now: a process that starts later is not asked to stop.
        stopIntent = { ...intent, phase: 'stop', issuedAt: new Date().toISOString(), targets: await listIdleShutdownTargets(redis, stopRoles) };
        await issueIdleShutdownIntent(redis, stopIntent);
    } catch (error) {
        return abort('could not record the stop request', { error: (error as Error).message });
    }
    logger.info({ ...record, file: resolveIdleWakeHintPath() }, 'Idle shutdown: stopping the control plane');
    let lastPendingLog = 0;
    const stopped = await waitForIdleAcks(redis, stopIntent, {
        roles: stopRoles,
        timeoutMs: timings.stopConfirmTimeoutMs,
        pollMs: timings.pollMs,
        isCancelled: ctx.isCancelled,
        onPending: pending => {
            if (Date.now() - lastPendingLog < 60_000) return;
            lastPendingLog = Date.now();
            logger.warn({ pending }, 'Idle shutdown: waiting for processes to acknowledge the stop request; the daemon stays up until they do');
        },
    });
    if (ctx.isCancelled?.()) return true;
    if (!stopped.confirmed) {
        logger.error({ pending: stopped.pending }, 'Idle shutdown: the stop request was not confirmed by every process; the daemon is not exiting');
        return true;
    }
    const remaining = await waitForDeregistration(redis, timings, new Set(stopIntent.targets?.map(target => target.key)), ctx.stopProcess !== undefined);
    if (remaining.length > 0) logger.warn({ remaining }, 'Idle shutdown: processes acknowledged the stop but are still shutting down');
    await redis.del(IDLE_SHUTDOWN_INTENT_REDIS_KEY).catch(() => undefined);
    await stopDaemonProcess(ctx, record, timings.closeDeadlineMs);
    return true;
}

/**
 * An aborted drain that had disconnected Connect intake: the replay owed for
 * the disconnection was recorded before it (marked aborted now, and recorded
 * again if the file lost it), then reconnect and ask for that replay. The relay only replays on request, so
 * reconnecting alone would leave the deliveries cached while draining behind.
 */
async function resumeIntakeOwingReplay(ctx: IdleDrainContext, routing: IdleRoutingIntake, intakeStoppedAt: number, hintWritten: IdleWakeHint | null): Promise<void> {
    const io = { readHint: ctx.readHint, writeHint: ctx.writeHint };
    let owed: IdleWakeHint;
    try {
        // A hint already written for this stop holds the obligation; it must not make the next plain start look like a wake.
        owed = hintWritten ? { ...hintWritten, wokeAt: new Date().toISOString() } : await recordAbortedDrainReplay(intakeStoppedAt, io);
        if (hintWritten) await withHintFile(() => (ctx.writeHint ?? writeIdleWakeHint)(owed));
    } catch (error) {
        // Still asked for below; only a restart before the relay answers would lose it.
        owed = hintWritten ?? buildIdleWakeHint({ shutdownAt: intakeStoppedAt, reason: 'idle shutdown aborted', idleForMs: 0, nextDue: [], connect: true, intakeStoppedAt });
        logger.warn({ error: (error as Error).message, file: resolveIdleWakeHintPath() }, 'Idle shutdown: could not record the Connect replay owed for the aborted drain');
    }
    await routing.start();
    void requestOwedReplay(routing, owed, io).catch(() => undefined);
}

/** Step 7: the daemon itself, or (composed) the process's one coordinated close of every component. */
async function stopDaemonProcess(ctx: IdleDrainContext, record: IdleShutdownRecord, closeDeadlineMs: number): Promise<void> {
    if (ctx.stopProcess) {
        // Bounded there: the composed close ends in process.exit within its own deadline.
        logger.info({ ...record }, 'Idle shutdown: closing every component of this process (exit 0)');
        ctx.stopProcess();
        return;
    }
    logger.info({ ...record }, 'Idle shutdown: control plane stopped (exit 0)');
    // The stop is recorded and every process has stopped: a close that hangs or fails must not keep the daemon up.
    let timer: NodeJS.Timeout | undefined;
    const closed = (async () => {
        await ctx.close();
        await closeConnection();
    })().then(() => 'closed' as const, (error: unknown) => error);
    const outcome = await Promise.race([closed, new Promise<'deadline'>(resolve => { timer = setTimeout(() => resolve('deadline'), closeDeadlineMs); })]);
    clearTimeout(timer);
    if (outcome === 'deadline') logger.error({ closeDeadlineMs }, 'Idle shutdown: the daemon did not finish closing in time; exiting anyway');
    else if (outcome !== 'closed') logger.error({ error: (outcome as Error)?.message }, 'Idle shutdown: the daemon close failed; exiting anyway');
    await flushLogs();
    ctx.exit(0);
}

export function startDaemonIdleShutdown(deps: DaemonIdleShutdownDeps): DaemonIdleShutdown {
    // A drain request left by a daemon that died mid-drain must not stop the processes starting now.
    void deps.redis.del(IDLE_SHUTDOWN_INTENT_REDIS_KEY).catch(() => undefined);
    const sources = createDaemonIdleSources({
        redis: deps.redis,
        database: db,
        intakeMode: deps.intakeMode,
        connectInFlight: () => deps.getRoutingService()?.getInFlightCount() ?? 0,
        connectIdleWakeSupport: () => deps.getRoutingService()?.getIdleWakeSupport() ?? null,
    });
    const collect = () => collectIdleSignals(sources);
    let cancelled = false;
    const controller = new IdleShutdownController({
        redis: deps.redis,
        resolveConfig: () => loadIdleShutdownConfig(),
        collect,
        onIdle: request => drainIdleControlPlane(request, {
            redis: deps.redis as unknown as IntentRedis,
            routing: deps.getRoutingService(),
            collect,
            close: deps.close,
            exit: deps.exit ?? process.exit,
            stopProcess: deps.stopProcess,
            timings: deps.timings,
            isCancelled: () => cancelled,
        }),
        intervalMs: deps.intervalMs,
        log: logger,
    });
    controller.start();
    return {
        controller,
        stop: () => {
            cancelled = true;
            return controller.stop();
        },
    };
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
 * On start after an idle stop: name the wake source, record the cold start
 * and mark the hint consumed; when the stop was made with Connect intake, get
 * the relay to accept the replay of deliveries cached while stopped. The
 * replay obligation stays in the hint file until the relay acknowledges it,
 * so a start where it does not (or without Connect intake) asks again on the
 * next start. Scheduled work that became due while stopped needs nothing
 * extra: the schedule sweeps run at startup and coalesce missed slots.
 */
export async function recoverFromIdleWake(deps: {
    redis: Redis;
    routingService: Pick<RoutingWebSocketIntakeService, 'requestReplay'> | null;
    processStartedAt: number;
    waitMs?: number;
}): Promise<void> {
    const file = resolveIdleWakeHintPath();
    let hint = await readIdleWakeHint(file);
    if (!hint) return;
    const since = needsConnectReplay(hint) ? connectReplaySince(hint) : null;
    const replay = since !== null && deps.routingService ? deps.routingService.requestReplay(since) : null;
    if (isPendingIdleWake(hint)) {
        const readyAt = Date.now();
        const apiSignal = await waitForWakeSignal(deps.redis, deps.waitMs ?? WAKE_SIGNAL_WAIT_MS);
        const source = classifyIdleWake({ hint, now: readyAt, apiSignal });
        const record = buildIdleWakeRecord({ hint, source, now: readyAt, processStartedAt: deps.processStartedAt });
        await deps.redis.set(IDLE_LAST_WAKE_REDIS_KEY, JSON.stringify(record), 'EX', RECORD_TTL_SECONDS).catch(() => undefined);
        await deps.redis.del(IDLE_WAKE_SIGNAL_REDIS_KEY).catch(() => undefined);
        const due = hint.nextDue.filter(item => item.dueAt <= readyAt);
        logger.info({ ...record, dueWhileStopped: due.map(item => item.detail) }, 'Woke from idle shutdown');
        const consumed: IdleWakeHint = { ...hint, wokeAt: record.wokeAt };
        hint = consumed;
        await updateHint(hintFileIo(file), current => (current.shutdownAt === consumed.shutdownAt ? { ...current, wokeAt: consumed.wokeAt } : null)).catch((error: Error) => {
            logger.warn({ error: error.message, file }, 'Could not mark the idle wake hint consumed');
        });
    }
    if (!needsConnectReplay(hint)) return;
    if (!replay) {
        logger.warn({ file }, 'Stopped idle with Connect intake, but Connect intake is not running: the replay of cached deliveries stays pending');
        return;
    }
    if (!(await replay)) {
        logger.warn({ since }, 'Connect did not accept the replay of deliveries cached while stopped; it stays pending and is requested again on the next start');
        return;
    }
    logger.info({ since }, 'Connect accepted the replay of deliveries cached while stopped');
    await recordAcceptedReplay(hintFileIo(file), hint, connectReplaySince(hint)).catch((error: Error) => {
        logger.warn({ error: error.message, file }, 'Could not record the accepted replay in the idle wake hint');
    });
}
