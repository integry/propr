import type { Redis } from 'ioredis';
import {
    IDLE_LAST_SHUTDOWN_REDIS_KEY,
    IDLE_LAST_WAKE_REDIS_KEY,
    IDLE_SHUTDOWN_INTENT_REDIS_KEY,
    IDLE_WAKE_SIGNAL_REDIS_KEY,
    type IdleBlocker,
    type IdleShutdownRecord,
    type IdleWakeHint,
    type IdleWakeSource,
} from '@propr/shared';
import {
    IdleShutdownController,
    beforeIdleDeadline,
    buildIdleWakeRecord,
    classifyIdleWake,
    collectIdleSignals,
    connectReplaySince,
    db,
    evaluateIdle,
    issueIdleShutdownIntent,
    isIdleParticipantInThisProcess,
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
    type IdleEvaluation,
    type IdleParticipantRole,
    type IdleShutdownIntent,
    type IdleShutdownRequest,
    type IdleSignals,
    type IntentRedis,
    type RoutingWebSocketIntakeService,
} from '@propr/core';
import { flyMachineStopProblem } from '../flyMachineStop.js';
import { createDaemonIdleSources, createDaemonWorkSources } from './idleSignalSources.js';
import { stopDaemonProcess, type IdleStopProcess } from './idleStopExit.js';
import type { DaemonWorkProducers } from './workProducers.js';
import { DrainAbort, connectAcceptsWakeHint, disconnectIntakeOwingReplay, hasExternalScheduledWake, persistStopHint, restoreAbortedDrain, scheduledWakeMissing, type IdleDrainProgress } from './idleDrainSteps.js';

export { hasExternalScheduledWake, scheduledWakeMissing };
import {
    hintFileIo,
    recordAcceptedReplay,
    updateHint,
} from './idleReplayObligation.js';

/**
 * The daemon owns idle shutdown (issue #3770): it sees every shared signal,
 * owns Connect intake and the schedules, and so decides when the instance
 * may stop. Off by default; see `resolveIdleShutdownConfig`.
 *
 * Only the composed process (all-in-one) stops: its API, worker and indexing
 * worker exit with it, so a stop that is called off (exit 1) starts every one
 * of them again. A process outside it would exit 0 on its own and stay
 * stopped, so a standalone daemon, or a registration made outside the
 * process, keeps the instance awake (`separateProcessSignals`), and one that
 * appears while draining aborts the drain before anything is asked to stop.
 *
 * Drain order once idle (any failure before the stop request is stored in
 * step 5 restores intake and the daemon's sweeps and keeps the instance
 * running; steps 1 to 5 share one deadline, `drainTimeoutMs`, and a
 * restoration that cannot finish within the close's allowance exits 1):
 *   1. Connect intake: the relay must acknowledge the wake hint (it will wake
 *      the instance and replay cached deliveries). No acknowledgement, no stop.
 *   2. Quiesce the producers: pause the daemon's own sweeps (schedules,
 *      retries, recovery; a run in progress finishes first), record in the
 *      wake hint file the Connect replay owed from now on (before
 *      disconnecting, so a crash mid-drain keeps it; no record, no
 *      disconnect), stop Connect intake (in-flight deliveries finish and ACK)
 *      and ask every API process to stop admitting requests; each one waits
 *      for its requests in flight and acknowledges.
 *   3. Check again, now that nothing can add work. Without Connect intake
 *      nothing wakes the instance for scheduled work unless the operator's
 *      own scheduler reads the hint file (`PROPR_IDLE_SCHEDULED_WAKE=external`):
 *      without one, any scheduled work aborts.
 *   4. Write the wake hint file (the recovery marker and the wake schedule for
 *      other supervisors), replacing the record from step 2. A failed write
 *      aborts. A Connect replay an earlier wake still owes is carried over as
 *      the replay cursor.
 *   5. Ask every registered process (by generation: one that starts later is
 *      not asked) to stop, unless one registered outside this process or the
 *      time left before the arranged wake shrank below what step 3 allowed
 *      (both abort), and record the shutdown.
 *   6. Wait until each process has acknowledged the stop request (the request
 *      is stored, so a process that reconnects still gets it) or is confirmed
 *      stopped. With scheduled work, the stop must be over before the wake
 *      arranged for it (the Connect wake hint, the hint file's `nextDueAt`):
 *      unconfirmed by then (an acknowledgement read later does not count), or
 *      when the wait ends otherwise, the stop is called off (see
 *      `callOffStop`). Without, the daemon waits.
 *   7. Look for work once more: anything queued while the processes stopped,
 *      or due before the arranged wake, would be stranded, so the stop is
 *      called off instead, as it is when that check is not over in time for
 *      the close to end before the wake. Otherwise close every component
 *      together, through the process's one coordinated close (`stopProcess`),
 *      or (standalone) the daemon's own resources, flush logs and exit 0. The
 *      process must have exited by the arranged wake: a close still running
 *      then exits 1 instead, so the supervisor starts it for that work.
 */

/** Records kept for `/api/status` and the Web UI. */
const RECORD_TTL_SECONDS = 30 * 24 * 60 * 60;

export interface IdleDrainTimings {
    /** How long API processes get to confirm they are quiesced, and the daemon's sweeps to finish a run in progress. */
    quiesceTimeoutMs: number;
    /**
     * How long to wait for stop acknowledgements; null waits until confirmed (or the daemon is stopped). Either way
     * the wait ends early enough for the deregistration wait and the close to finish before the arranged wake.
     */
    stopConfirmTimeoutMs: number | null;
    /** How long to wait, after every acknowledgement, for processes to deregister. */
    deregisterWaitMs: number;
    pollMs: number;
    /**
     * Step 7: the time allowed for the close (the composed close has its own bound, of the same length by default);
     * standalone, how long the daemon's own close may take before it exits 0 anyway. Either way the exit comes no
     * later than the arranged wake, and reaching that wake first exits 1.
     */
    closeDeadlineMs: number;
    /**
     * Steps 1 to 5, before the stop request is stored: the whole drain must end within this, or it aborts (intake and
     * the sweeps restored). A drain step still pending then is not waited for; a restoration that cannot finish within
     * `closeDeadlineMs` exits 1 instead, so the supervisor starts the control plane again.
     */
    drainTimeoutMs: number;
}

export const DEFAULT_IDLE_DRAIN_TIMINGS: IdleDrainTimings = {
    quiesceTimeoutMs: 30_000,
    stopConfirmTimeoutMs: null,
    deregisterWaitMs: 30_000,
    pollMs: 1_000,
    closeDeadlineMs: 30_000,
    drainTimeoutMs: 120_000,
};


export type IdleRoutingIntake = Pick<RoutingWebSocketIntakeService, 'sendWakeHint' | 'stop' | 'start' | 'requestReplay'>;

export interface IdleDrainContext {
    redis: IntentRedis;
    routing: IdleRoutingIntake | null;
    collect: () => Promise<IdleSignals>;
    /** Step 7: only the signals that show work (see `createDaemonWorkSources`); defaults to `collect`. */
    collectWork?: () => Promise<IdleSignals>;
    /** The daemon's own sweeps: paused in step 2, resumed when the drain aborts. */
    producers?: Pick<DaemonWorkProducers, 'pause' | 'resume'>;
    writeHint?: (hint: IdleWakeHint) => Promise<void>;
    readHint?: () => Promise<IdleWakeHint | null>;
    /** The daemon's normal graceful close (timers, routing, Redis, queues). */
    close: () => Promise<void>;
    exit: (code: number) => void;
    /**
     * Composed process (all-in-one): the participants in this process only
     * acknowledged the stop; this runs the process's coordinated close of
     * every component (including the daemon) and exits with at least
     * `exitCode`, and with at least 1 when `exitBy` (epoch ms, the arranged
     * wake) comes before the exit. Replaces the daemon's own close and exit.
     */
    stopProcess?: IdleStopProcess;
    timings?: Partial<IdleDrainTimings>;
    /**
     * An external scheduler (`PROPR_IDLE_SCHEDULED_WAKE=external`) starts the instance at the hint file's `nextDueAt`.
     * Without it, and without Connect intake, nothing arranges a wake for scheduled work, so any keeps it running.
     */
    externalScheduledWake?: boolean;
    /** True once the daemon is shutting down for another reason (SIGTERM): stop waiting, do not exit here. */
    isCancelled?: () => boolean;
}

export interface DaemonIdleShutdownDeps {
    redis: Redis;
    intakeMode: string;
    getRoutingService: () => RoutingWebSocketIntakeService | null;
    /** See {@link IdleDrainContext.producers}. */
    producers?: Pick<DaemonWorkProducers, 'pause' | 'resume'>;
    /** The daemon's normal graceful close (timers, routing, Redis, queues). */
    close: () => Promise<void>;
    exit?: (code: number) => void;
    /** See {@link IdleDrainContext.stopProcess}. Given, the daemon runs in the composed process. */
    stopProcess?: IdleStopProcess;
    intervalMs?: number;
    timings?: Partial<IdleDrainTimings>;
    /** See {@link IdleDrainContext.externalScheduledWake}; defaults to {@link hasExternalScheduledWake}. */
    externalScheduledWake?: boolean;
}

export interface DaemonIdleShutdown {
    controller: IdleShutdownController;
    stop: () => Promise<void>;
}

const toIso = (ms: number | null): string | null => (ms === null ? null : new Date(ms).toISOString());

/**
 * Wait (bounded, by the absolute `deadline` too) until no participant from
 * `targets` remains registered: each has finished its graceful shutdown. With
 * `skipOwnProcess` (composed) the participants in this process deregister in
 * the coordinated close instead.
 */
async function waitForDeregistration(redis: IntentRedis, targets: Set<string>, options: { skipOwnProcess: boolean; deadline: number; pollMs: number }): Promise<string[]> {
    const { skipOwnProcess, deadline } = options;
    for (;;) {
        const read = await beforeIdleDeadline(listIdleParticipants(redis).catch(() => []), deadline);
        if (!read.ok) return [...targets];
        const remaining = read.value
            .filter(({ key, participant }) => targets.has(key) && !(skipOwnProcess && isIdleParticipantInThisProcess(key, participant?.startedAt ?? null)))
            .map(entry => entry.key);
        if (remaining.length === 0 || Date.now() >= deadline) return remaining;
        await new Promise(resolve => setTimeout(resolve, Math.min(options.pollMs, Math.max(0, deadline - Date.now()))));
    }
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

    // Steps 1 to 5 share one deadline: a step that never settles (a Redis command left pending, a hung disk) must
    // not keep intake disconnected and the sweeps paused while the controller waits inside this drain.
    const drainBy = Date.now() + timings.drainTimeoutMs;
    const bounded = <T>(work: Promise<T>) => beforeIdleDeadline(work, drainBy);

    // 1. With Connect intake the relay is the wake arrangement and the replay source: it must accept.
    if (routing && !(await connectAcceptsWakeHint(routing, nextDueAt, drainBy))) return false;

    const intent: IdleShutdownIntent = newIdleShutdownIntent('quiesce', reason);
    const progress: IdleDrainProgress = { intentId: intent.id, intakeStoppedAt: null, disconnectPending: false, hintWritten: null, producersPaused: false };
    const abort = async (message: string, details: object = {}): Promise<boolean> => {
        logger.info({ ...details, intentId: intent.id }, `Idle shutdown aborted: ${message}; staying up`);
        // The restoration gets the close's allowance; one that cannot finish exits 1.
        const unrestored = await restoreAbortedDrain(ctx, progress, Date.now() + timings.closeDeadlineMs);
        if (unrestored === null) return false;
        // Running with intake down would miss every delivery: restart instead (the replay owed is on disk).
        logger.error({ intentId: intent.id, reason: unrestored }, 'Idle shutdown: the aborted drain could not restore intake; exiting with code 1 so the supervisor starts the control plane again');
        const record: IdleShutdownRecord = { shutdownAt: new Date().toISOString(), reason, idleForMs: request.idleForMs, nextDueAt };
        if (!ctx.isCancelled?.()) await stopDaemonProcess(ctx, record, { closeDeadlineMs: timings.closeDeadlineMs, exitCode: 1, wakeAt: null });
        return true;
    };

    // 2. Quiesce every producer before the last check. The daemon's own sweeps first: a run in
    //    progress may still call the API, which turns requests away once it is quiesced.
    let prepared: PreparedStop;
    try {
        prepared = await quiesceAndPersist(request, ctx, { timings, progress, intent, reason, drainBy });
    } catch (error) {
        return error instanceof DrainAbort ? abort(error.message, error.details) : abort('the drain failed', { error: (error as Error).message });
    }
    const { wake, hint } = prepared;

    // 5. Store the stop request (6 waits for it), then the records for /api/status (informational).
    const record: IdleShutdownRecord = { shutdownAt: hint.shutdownAt, reason, idleForMs: request.idleForMs, nextDueAt: hint.nextDueAt };
    const stopRoles = ['api', 'worker', 'indexing_worker'] as const;
    let stopIntent: IdleShutdownIntent;
    try {
        // Only the generations registered now: a process that starts later is not asked to stop.
        const targets = await bounded(listIdleShutdownTargets(redis, stopRoles));
        if (!targets.ok) return abort('listing the processes to stop did not finish within the drain timeout', { drainTimeoutMs: timings.drainTimeoutMs });
        stopIntent = { ...intent, phase: 'stop', issuedAt: new Date().toISOString(), targets: targets.value };
        // Only this process's: one outside it would exit 0 on its own and stay stopped if the stop were called off.
        const outside = (stopIntent.targets ?? []).filter(target => !isIdleParticipantInThisProcess(target.key, target.startedAt)).map(target => target.key);
        if (outside.length > 0) return abort('a process outside this one registered while draining, and a called-off stop would leave it stopped', { outside });
        // Steps 4 and 5 took time too: the window checked in step 3 must still be there.
        if (stopWindowTooShort(wake, timings)) return abort('scheduled work is due too soon for the stop to finish before it', { nextDueAt: toIso(wake.wakeAt) });
        const stored = await bounded(issueIdleShutdownIntent(redis, stopIntent));
        // Still pending, the stop request may yet be stored and acknowledged: no longer safe to resume, so call it off.
        if (!stored.ok) return callOffStop(ctx, { intent: stopIntent, hint, record, wake, closeDeadlineMs: timings.closeDeadlineMs }, 'storing the stop request did not finish within the drain timeout', { drainTimeoutMs: timings.drainTimeoutMs });
    } catch (error) {
        return abort('could not record the stop request', { error: (error as Error).message });
    }
    // Informational, and bounded: Redis going away now must not keep the quiesced control plane up.
    const recordBy = Date.now() + timings.closeDeadlineMs;
    await beforeIdleDeadline(redis.set(IDLE_LAST_SHUTDOWN_REDIS_KEY, JSON.stringify(record), 'EX', RECORD_TTL_SECONDS).catch(() => undefined), recordBy);
    await beforeIdleDeadline(redis.del(IDLE_WAKE_SIGNAL_REDIS_KEY).catch(() => undefined), recordBy);

    // 6. Hear back from every process.
    logger.info({ ...record, file: resolveIdleWakeHintPath() }, 'Idle shutdown: stopping the control plane');
    return finishStop(ctx, { intent: stopIntent, roles: stopRoles, hint, record, wake }, timings);
}

interface PreparedStop { wake: StopWake; hint: IdleWakeHint }

/**
 * Steps 2 to 4, each bounded by the drain deadline (`drainBy`): quiesce the
 * producers and intake, check once more, and write the stop's hint. Throws
 * {@link DrainAbort} for anything that keeps the instance running.
 */
async function quiesceAndPersist(
    request: IdleShutdownRequest,
    ctx: IdleDrainContext,
    drain: { timings: IdleDrainTimings; progress: IdleDrainProgress; intent: IdleShutdownIntent; reason: string; drainBy: number },
): Promise<PreparedStop> {
    const { timings, progress, intent } = drain;
    const step = async <T>(name: string, work: Promise<T>, failure: string, details: object = {}): Promise<T> => {
        const result = await beforeIdleDeadline(work, drain.drainBy).catch((error: Error) => {
            throw new DrainAbort(failure, { ...details, error: error.message });
        });
        if (!result.ok) throw new DrainAbort(`${name} did not finish within the drain timeout`, { drainTimeoutMs: timings.drainTimeoutMs });
        return result.value;
    };
    if (ctx.producers) {
        progress.producersPaused = true;
        const running = await step('pausing the daemon sweeps', ctx.producers.pause(timings.quiesceTimeoutMs), 'the daemon sweeps could not be paused');
        if (running.length > 0) throw new DrainAbort('daemon sweeps did not finish their run in progress', { running });
    }
    await step('recording the drain request', issueIdleShutdownIntent(ctx.redis, intent), 'could not record the drain request');
    const disconnected = await beforeIdleDeadline(disconnectIntakeOwingReplay(ctx, progress), drain.drainBy);
    if (!disconnected.ok) throw new DrainAbort(`${progress.intakeStoppedAt === null ? 'recording the Connect replay owed for the drain' : 'disconnecting Connect intake'} did not finish within the drain timeout`, { drainTimeoutMs: timings.drainTimeoutMs });
    if (disconnected.value instanceof Error) {
        throw new DrainAbort('could not record the Connect replay owed for the drain, so intake stays connected', { error: disconnected.value.message, file: resolveIdleWakeHintPath() });
    }
    const intakeStoppedAt = disconnected.value;
    const quiesced = await step('waiting for API processes to quiesce', waitForIdleAcks(ctx.redis, intent, { roles: ['api'], timeoutMs: timings.quiesceTimeoutMs, pollMs: timings.pollMs }), 'could not read the quiesce acknowledgements');
    if (!quiesced.confirmed) throw new DrainAbort('API processes did not confirm they stopped admitting requests', { pending: quiesced.pending });

    // 3. Nothing can add work now: look once more.
    const recheck = await step('the last check for work', recheckBeforeStop(request, ctx, timings), 'the last check for work failed');
    if ('abort' in recheck) throw new DrainAbort(recheck.abort, recheck.details);
    const { after, wake } = recheck;

    // 4. The hint file is the recovery marker (and the wake schedule for other supervisors): no file, no stop.
    //    A replay still owed for an earlier stop stays owed: its cursor is carried into the new hint.
    const hint = await step(
        'writing the wake hint file',
        persistStopHint(ctx, { reason: drain.reason, idleForMs: request.idleForMs, nextDue: after.nextDue, connect: ctx.routing !== null, intakeStoppedAt }),
        'could not write the wake hint file',
        { file: resolveIdleWakeHintPath() },
    );
    progress.hintWritten = hint;
    return { wake, hint };
}

/** When the first wake arranged for a stop fires, and by when the stop must be confirmed for the rest of it to end before then. */
interface StopWake { wakeAt: number | null; confirmBy: number | null }
type Recheck = { after: IdleEvaluation; wake: StopWake } | { abort: string; details: object };
interface StopUnderWay { intent: IdleShutdownIntent; hint: IdleWakeHint; record: IdleShutdownRecord; wake: StopWake }

/**
 * Step 3. Also finds the first wake arranged for the stop: Connect's (one)
 * wake, and the hint file's next due work. Confirmed by `confirmBy`, the
 * (bounded) deregistration wait and close still end before it; a stop that
 * would not get as long for that as the quiesce did is not started.
 */
async function recheckBeforeStop(request: IdleShutdownRequest, ctx: IdleDrainContext, timings: IdleDrainTimings): Promise<Recheck> {
    const signals = await ctx.collect();
    const after = evaluateIdle(signals, { now: Date.now(), windowMs: request.config.afterMs });
    if (!after.idle || (signals.lastActivityAt ?? 0) > request.idleSince) {
        return { abort: 'work arrived while draining', details: { blockers: after.blockers, lastActivityAt: toIso(signals.lastActivityAt) } };
    }
    const hinted = ctx.routing ? request.evaluation.nextDueAt : null;
    if (ctx.routing && after.nextDueAt !== null && (hinted === null || after.nextDueAt < hinted)) {
        return { abort: 'scheduled work is due earlier than the wake hint Connect accepted', details: { nextDueAt: toIso(after.nextDueAt), hinted: toIso(hinted) } };
    }
    // A due time in the hint file is not a wake: only Connect's acknowledgement, or a scheduler the operator
    // configured to read that file, arranges one. Without either, scheduled work would be stranded.
    if (!ctx.routing && !ctx.externalScheduledWake && after.nextDueAt !== null) {
        return { abort: `scheduled work remains and ${scheduledWakeMissing(false, false)}`, details: { nextDueAt: toIso(after.nextDueAt) } };
    }
    const wakeAt = ctx.routing ? hinted : after.nextDueAt;
    const wake = { wakeAt, confirmBy: wakeAt === null ? null : wakeAt - timings.deregisterWaitMs - timings.closeDeadlineMs };
    if (stopWindowTooShort(wake, timings)) {
        return { abort: 'scheduled work is due too soon for the stop to finish before it', details: { nextDueAt: toIso(wakeAt) } };
    }
    return { after, wake };
}

/** Whether the stop would get less time to be confirmed than the quiesce had. */
function stopWindowTooShort(wake: StopWake, timings: IdleDrainTimings): boolean {
    return wake.confirmBy !== null && wake.confirmBy - Date.now() < timings.quiesceTimeoutMs;
}

/**
 * Steps 6 (after the stop request is stored) and 7. With a wake arranged,
 * every step works to an absolute deadline before it: the acknowledgements by
 * `confirmBy`, the last check by `decideBy` (so the close still gets its
 * allowance), and the exit by the wake itself.
 */
async function finishStop(ctx: IdleDrainContext, stop: StopUnderWay & { roles: readonly IdleParticipantRole[] }, timings: IdleDrainTimings): Promise<true> {
    const { wakeAt, confirmBy } = stop.wake;
    const decideBy = wakeAt === null ? null : wakeAt - timings.closeDeadlineMs;
    const callOff = (message: string, details: object) => callOffStop(ctx, { ...stop, closeDeadlineMs: timings.closeDeadlineMs }, message, details);
    let lastPendingLog = 0;
    const stopped = await waitForIdleAcks(ctx.redis, stop.intent, {
        roles: stop.roles,
        timeoutMs: earliest(timings.stopConfirmTimeoutMs, confirmBy === null ? null : Math.max(0, confirmBy - Date.now())),
        pollMs: timings.pollMs,
        isCancelled: ctx.isCancelled,
        onPending: pending => {
            if (Date.now() - lastPendingLog < 60_000) return;
            lastPendingLog = Date.now();
            logger.warn({ pending, callOffAt: toIso(confirmBy) }, `Idle shutdown: waiting for processes to acknowledge the stop request; ${confirmBy === null
                ? 'the daemon stays up until they do' : 'unconfirmed by callOffAt (before the wake arranged for the scheduled work), the stop is called off'}`);
        },
    });
    if (ctx.isCancelled?.()) return true;
    // An acknowledgement read after `confirmBy` is too late for the rest of the stop to end before the wake.
    const late = confirmBy !== null && Date.now() > confirmBy;
    if (!stopped.confirmed || late) {
        return callOff(`not every process acknowledged the stop ${late ? 'in time for the wake arranged for the scheduled work' : 'within the confirmation timeout'}`, { pending: stopped.pending, wakeAt: toIso(wakeAt) });
    }
    const remaining = await waitForDeregistration(ctx.redis, new Set(stop.intent.targets?.map(target => target.key)), {
        skipOwnProcess: ctx.stopProcess !== undefined, deadline: earliest(Date.now() + timings.deregisterWaitMs, decideBy)!, pollMs: timings.pollMs,
    });
    if (remaining.length > 0) logger.warn({ remaining }, 'Idle shutdown: processes acknowledged the stop but are still shutting down');

    // 7. The check in step 3 is older than the stop: work queued since, or due before the wake, would be left behind.
    const work = await beforeIdleDeadline((ctx.collectWork ?? ctx.collect)(), decideBy);
    if (ctx.isCancelled?.()) return true;
    if (!work.ok || (decideBy !== null && Date.now() > decideBy)) {
        return callOff('the last check for work did not finish in time for the close to end before the wake arranged for the scheduled work', { wakeAt: toIso(wakeAt) });
    }
    const stranded = strandedWork(work.value, wakeAt, Date.now());
    if (stranded.length > 0) return callOff('work arrived while the control plane was stopping', { blockers: stranded, wakeAt: toIso(wakeAt) });
    // Bounded even with no wake arranged: Redis going away now must not keep the stopped control plane up.
    await beforeIdleDeadline(ctx.redis.del(IDLE_SHUTDOWN_INTENT_REDIS_KEY).catch(() => undefined), earliest(Date.now() + timings.closeDeadlineMs, decideBy));
    await stopDaemonProcess(ctx, stop.record, { closeDeadlineMs: timings.closeDeadlineMs, exitCode: 0, wakeAt });
    return true;
}

function earliest(...times: Array<number | null>): number | null {
    const known = times.filter((time): time is number => time !== null);
    return known.length > 0 ? Math.min(...known) : null;
}

/** What a stop would strand: work queued or running, or scheduled before the wake arranged for it (or with none arranged). */
function strandedWork(signals: IdleSignals, wakeAt: number | null, now: number): IdleBlocker[] {
    const evaluation = evaluateIdle(signals, { now, windowMs: 0 });
    const next = evaluation.nextDueAt;
    if (next === null || next <= now || (wakeAt !== null && next >= wakeAt)) return evaluation.blockers;
    return [...evaluation.blockers, { signal: 'scheduled_work', detail: `scheduled work due at ${toIso(next)}, before the wake arranged for the stop` }];
}

/**
 * The stop cannot end as an idle stop: it was not confirmed in time for the
 * wake arranged for the next scheduled work (that wake would reach an
 * instance still stopping, and nothing would wake it again), or work arrived
 * while it ran. Call it off: the request is withdrawn (a process that has not
 * stopped keeps running), the hint no longer reads as a stop to wake from
 * (its Connect replay stays owed) and the daemon exits 1, so the on-failure
 * supervisor idle shutdown requires starts the control plane again at once.
 * That start runs what is due (missed slots coalesce) and asks for the replay.
 */
async function callOffStop(ctx: IdleDrainContext, stop: StopUnderWay & { closeDeadlineMs: number }, message: string, details: object): Promise<true> {
    logger.error({ ...details, intentId: stop.intent.id }, `Idle shutdown called off: ${message}; exiting with code 1 so the supervisor starts the control plane again`);
    // The clean-up talks to Redis and the disk, either of which may be the reason the stop is being called off. It
    // gets a bounded chance (the close's allowance), then the exit 1 goes ahead with it still outstanding: a stop
    // that cannot finish must reach the supervisor's restart, not stay quiesced with intake disconnected.
    const cleanUpBy = Date.now() + stop.closeDeadlineMs;
    const withdrawn = await beforeIdleDeadline(withdrawIdleShutdownIntent(ctx.redis, stop.intent.id).catch(() => undefined), cleanUpBy);
    if (!withdrawn.ok) logger.warn({ intentId: stop.intent.id, closeDeadlineMs: stop.closeDeadlineMs }, 'Idle shutdown: withdrawing the stop request did not finish in time; exiting anyway (the request expires on its own)');
    const wokeAt = new Date().toISOString();
    const marked = await beforeIdleDeadline(
        updateHint({ readHint: ctx.readHint, writeHint: ctx.writeHint }, current => (current.shutdownAt === stop.hint.shutdownAt ? { ...current, wokeAt } : null)).catch((error: Error) => {
            logger.warn({ error: error.message, file: resolveIdleWakeHintPath() }, 'Idle shutdown: could not mark the called-off stop in the wake hint file; the next start counts as a wake');
        }),
        cleanUpBy,
    );
    if (!marked.ok) logger.warn({ file: resolveIdleWakeHintPath() }, 'Idle shutdown: marking the called-off stop in the wake hint file did not finish in time; the next start counts as a wake');
    if (!ctx.isCancelled?.()) await stopDaemonProcess(ctx, stop.record, { closeDeadlineMs: stop.closeDeadlineMs, exitCode: 1, wakeAt: null });
    return true;
}

export function startDaemonIdleShutdown(deps: DaemonIdleShutdownDeps): DaemonIdleShutdown {
    // A drain request left by a daemon that died mid-drain must not stop the processes starting now.
    void deps.redis.del(IDLE_SHUTDOWN_INTENT_REDIS_KEY).catch(() => undefined);
    const externalScheduledWake = deps.externalScheduledWake ?? hasExternalScheduledWake();
    const sources = createDaemonIdleSources({
        redis: deps.redis,
        database: db,
        intakeMode: deps.intakeMode,
        composed: deps.stopProcess !== undefined,
        connectInFlight: () => deps.getRoutingService()?.getInFlightCount() ?? 0,
        connectIdleWakeSupport: () => deps.getRoutingService()?.getIdleWakeSupport() ?? null,
        hostStopProblem: () => flyMachineStopProblem(process.env),
        scheduledWakeMissing: () => scheduledWakeMissing(deps.getRoutingService() !== null, externalScheduledWake),
    });
    const collect = () => collectIdleSignals(sources);
    const workSources = createDaemonWorkSources({ redis: deps.redis, database: db });
    let cancelled = false;
    const controller = new IdleShutdownController({
        redis: deps.redis,
        resolveConfig: () => loadIdleShutdownConfig(),
        collect,
        onIdle: request => drainIdleControlPlane(request, {
            redis: deps.redis as unknown as IntentRedis,
            routing: deps.getRoutingService(),
            collect,
            collectWork: () => collectIdleSignals(workSources),
            producers: deps.producers,
            close: deps.close,
            exit: deps.exit ?? process.exit,
            stopProcess: deps.stopProcess,
            timings: deps.timings,
            externalScheduledWake,
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
