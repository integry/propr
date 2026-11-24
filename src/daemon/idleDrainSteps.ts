import type { IdleWakeHint } from '@propr/shared';
import {
    beforeIdleDeadline,
    buildIdleWakeHint,
    connectReplaySince,
    logger,
    needsConnectReplay,
    readIdleWakeHint,
    resolveIdleWakeHintPath,
    withdrawIdleShutdownIntent,
    writeIdleWakeHint,
} from '@propr/core';
import type { IdleDrainContext, IdleRoutingIntake } from './idleShutdown.js';
import { recordAbortedDrainReplay, recordDrainReplayObligation, requestOwedReplay, withHintFile } from './idleReplayObligation.js';

/** `PROPR_IDLE_SCHEDULED_WAKE=external`: the operator's own scheduler starts the instance from the wake hint file. */
export function hasExternalScheduledWake(env: NodeJS.ProcessEnv = process.env): boolean {
    return (env.PROPR_IDLE_SCHEDULED_WAKE ?? '').trim().toLowerCase() === 'external';
}

/** Why nothing would start a stopped instance for its scheduled work; null when Connect or an external scheduler would. */
export function scheduledWakeMissing(connect: boolean, external: boolean): string | null {
    if (connect || external) return null;
    return 'nothing would wake the stopped instance for it (no Connect intake; set PROPR_IDLE_SCHEDULED_WAKE=external only if your own scheduler starts the instance at the wake hint file\'s nextDueAt)';
}

/** A drain step that ends the drain before the stop request is stored: the instance keeps running. */
export class DrainAbort extends Error {
    constructor(message: string, readonly details: object = {}) { super(message); }
}

/** Step 1: whether Connect acknowledged the wake hint (bounded by the drain deadline). */
export async function connectAcceptsWakeHint(routing: IdleRoutingIntake, nextDueAt: string | null, drainBy: number): Promise<boolean> {
    const answered = await beforeIdleDeadline(routing.sendWakeHint(nextDueAt), drainBy).catch(() => ({ ok: false as const }));
    if (!answered.ok || !answered.value) {
        logger.warn({ nextDueAt }, 'Idle shutdown aborted: Connect did not acknowledge the wake hint, so nothing would wake the instance or replay its deliveries; staying up');
        return false;
    }
    logger.info({ nextDueAt }, 'Idle shutdown: Connect accepted the wake hint');
    return true;
}

/**
 * Step 4: write the hint for this stop, keeping the cursor of a replay an
 * earlier stop still owes; otherwise this stop's replay runs from when its
 * intake disconnected (`intakeStoppedAt`), not from `shutdownAt`. The record
 * this drain wrote before disconnecting owes exactly that: it is replaced.
 */
export function persistStopHint(
    ctx: IdleDrainContext,
    progress: Pick<IdleDrainProgress, 'abandoned'>,
    input: Omit<Parameters<typeof buildIdleWakeHint>[0], 'shutdownAt' | 'pendingReplaySince'>,
): Promise<IdleWakeHint> {
    return withHintFile(async () => {
        const previous = await (ctx.readHint ?? readIdleWakeHint)().catch(() => null);
        const carried = needsConnectReplay(previous) ? connectReplaySince(previous) : null;
        const own = typeof input.intakeStoppedAt === 'number' ? new Date(input.intakeStoppedAt).toISOString() : null;
        const next = buildIdleWakeHint({ ...input, shutdownAt: Date.now(), pendingReplaySince: carried === own ? null : carried });
        // The drain gave up on this write (its deadline passed) and was restored without it: a stop hint written now
        // would make the next plain start look like a wake. Not written; one already under way is marked consumed.
        if (progress.abandoned) return next;
        await (ctx.writeHint ?? writeIdleWakeHint)(next);
        if (progress.abandoned) {
            const consumed = { ...next, wokeAt: new Date().toISOString() };
            await (ctx.writeHint ?? writeIdleWakeHint)(consumed);
            return consumed;
        }
        return next;
    });
}

/** What an idle drain has changed so far, before the stop request is stored: what an abort must undo. */
export interface IdleDrainProgress {
    intentId: string;
    /** When Connect intake was disconnected (taken before the disconnect): the replay cursor for this drain. */
    intakeStoppedAt: number | null;
    /** The disconnect did not finish by the drain deadline: reconnecting could race it, so intake cannot be restored. */
    disconnectPending: boolean;
    hintWritten: IdleWakeHint | null;
    producersPaused: boolean;
    /**
     * The drain aborted (set before its restoration starts). A preparation step left running past the drain deadline
     * checks this after its awaited work and must not apply its change: the restoration has already run without it.
     */
    abandoned: boolean;
}

/**
 * Step 2, Connect intake: record the replay owed from now on, then disconnect.
 * The relay caches what arrives from the disconnect on, so the cursor is taken
 * before it, and the obligation must be on disk before it too: the Redis
 * intent holds no cursor and is cleared at startup, and reconnecting alone
 * does not replay. Returns when intake was disconnected (null without Connect
 * intake), or the error that kept it connected. `progress` records the
 * disconnect as pending from the moment it starts.
 */
export async function disconnectIntakeOwingReplay(ctx: IdleDrainContext, progress: IdleDrainProgress): Promise<number | null | Error> {
    if (!ctx.routing) return null;
    const disconnectAt = Date.now();
    try {
        await recordDrainReplayObligation(disconnectAt, { readHint: ctx.readHint, writeHint: ctx.writeHint });
    } catch (error) {
        return error instanceof Error ? error : new Error(String(error));
    }
    // The drain gave up waiting for that record and restored itself (with intake still connected): disconnecting now
    // would leave the running instance without intake and nothing to reconnect it. The record stays: it only makes
    // a later start ask for a replay, whose duplicates are dropped by delivery ID.
    if (progress.abandoned) return new Error('the drain was abandoned before intake disconnected');
    // From here an abort owes the replay and must reconnect, even if the stop below never finishes.
    progress.intakeStoppedAt = disconnectAt;
    progress.disconnectPending = true;
    await ctx.routing.stop();
    progress.disconnectPending = false;
    return disconnectAt;
}

/**
 * An aborted drain, before the stop request was stored: withdraw the drain
 * request, reconnect Connect intake (asking for the replay owed), and resume
 * the daemon's sweeps. Every step is bounded by `restoreBy`: Redis or the disk
 * going away must not keep intake disconnected and the sweeps paused (the
 * request expires on its own). Returns why intake could not be restored (the
 * caller exits 1 so the supervisor starts it again), or null.
 */
export async function restoreAbortedDrain(ctx: IdleDrainContext, progress: IdleDrainProgress, restoreBy: number): Promise<string | null> {
    const withdrawn = await beforeIdleDeadline(withdrawIdleShutdownIntent(ctx.redis, progress.intentId).catch(() => undefined), restoreBy);
    if (!withdrawn.ok) logger.warn({ intentId: progress.intentId }, 'Idle shutdown: withdrawing the drain request did not finish in time; resuming anyway');
    let unrestored: string | null = null;
    if (progress.disconnectPending) unrestored = 'Connect intake was still disconnecting';
    else if (progress.intakeStoppedAt !== null && ctx.routing) {
        const resumed = await beforeIdleDeadline(resumeIntakeOwingReplay(ctx, progress, restoreBy), restoreBy).catch((error: Error) => error);
        if (resumed instanceof Error) unrestored = `Connect intake did not reconnect (${resumed.message})`;
        else if (!resumed.ok) unrestored = 'Connect intake did not reconnect in time';
    } else if (progress.hintWritten) {
        // The hint file must not make the next plain start look like a wake.
        await beforeIdleDeadline((ctx.writeHint ?? writeIdleWakeHint)({ ...progress.hintWritten, wokeAt: new Date().toISOString() }).catch(() => undefined), restoreBy);
    }
    if (progress.producersPaused) ctx.producers?.resume();
    return unrestored;
}

/**
 * An aborted drain that had disconnected Connect intake: the replay owed for
 * the disconnection was recorded before it (marked aborted now, and recorded
 * again if the file lost it), then reconnect and ask for that replay. The relay only replays on request, so
 * reconnecting alone would leave the deliveries cached while draining behind.
 */
async function resumeIntakeOwingReplay(ctx: IdleDrainContext, progress: IdleDrainProgress, restoreBy: number): Promise<void> {
    const routing = ctx.routing!;
    const intakeStoppedAt = progress.intakeStoppedAt!;
    const { hintWritten } = progress;
    const io = { readHint: ctx.readHint, writeHint: ctx.writeHint };
    const fallback = hintWritten ?? buildIdleWakeHint({ shutdownAt: intakeStoppedAt, reason: 'idle shutdown aborted', idleForMs: 0, nextDue: [], connect: true, intakeStoppedAt });
    let owed: IdleWakeHint = fallback;
    try {
        // A hint already written for this stop holds the obligation; it must not make the next plain start look like a wake.
        const recording = (async () => {
            const next = hintWritten ? { ...hintWritten, wokeAt: new Date().toISOString() } : await recordAbortedDrainReplay(intakeStoppedAt, io);
            if (hintWritten) await withHintFile(() => (ctx.writeHint ?? writeIdleWakeHint)(next));
            return next;
        })();
        // Bounded (half the restoration's allowance): a hung disk must not keep intake from reconnecting.
        const recorded = await beforeIdleDeadline(recording, Date.now() + Math.max(0, restoreBy - Date.now()) / 2);
        if (!recorded.ok) throw new Error('recording it did not finish in time');
        owed = recorded.value;
    } catch (error) {
        // Still asked for below; only a restart before the relay answers would lose it.
        owed = fallback;
        logger.warn({ error: (error as Error).message, file: resolveIdleWakeHintPath() }, 'Idle shutdown: could not record the Connect replay owed for the aborted drain');
    }
    await routing.start();
    void requestOwedReplay(routing, owed, io).catch(() => undefined);
}
