import type { IdleWakeHint } from '@propr/shared';
import {
    connectReplaySince,
    isPendingIdleWake,
    logger,
    readIdleWakeHint,
    resolveIdleWakeHintPath,
    writeIdleWakeHint,
    type RoutingWebSocketIntakeService,
} from '@propr/core';

/**
 * The Connect replay obligation (issue #3770). Once an idle drain disconnects
 * Connect intake, the relay caches deliveries for the instance; they are
 * recovered only by a replay the relay acknowledges. The obligation lives in
 * the wake hint file (`connectReplay: 'pending'` plus its cursor) until then,
 * whether the drain ends in a stop (the next start asks) or is aborted (the
 * daemon asks as soon as intake reconnects).
 */

/**
 * The wake hint file is read and rewritten by the drain and by wake recovery,
 * both in this process: one at a time, so neither replaces what the other
 * just wrote from a stale read.
 */
let hintFileTurn: Promise<unknown> = Promise.resolve();
export function withHintFile<T>(work: () => Promise<T>): Promise<T> {
    const run = hintFileTurn.then(work, work);
    hintFileTurn = run.catch(() => undefined);
    return run;
}

/** How the hint file is read and written (injectable for tests). */
export interface HintIo {
    readHint?: () => Promise<IdleWakeHint | null>;
    writeHint?: (hint: IdleWakeHint) => Promise<void>;
}

export function hintFileIo(file: string): Required<HintIo> {
    return { readHint: () => readIdleWakeHint(file), writeHint: hint => writeIdleWakeHint(hint, file) };
}

/**
 * Rewrite the hint file from what it holds now: `update(current)`, or leave
 * it when that returns null. Recovery runs alongside the idle controller, so
 * a later stop may have replaced the hint recovery started from.
 */
export async function updateHint(io: HintIo, update: (current: IdleWakeHint) => IdleWakeHint | null): Promise<void> {
    await withHintFile(async () => {
        const current = await (io.readHint ?? readIdleWakeHint)();
        const next = current ? update(current) : null;
        if (next) await (io.writeHint ?? writeIdleWakeHint)(next);
    });
}

/** The relay accepted the replay `since` that `accepted` owed: release that obligation only. */
export function recordAcceptedReplay(io: HintIo, accepted: IdleWakeHint, since: string): Promise<void> {
    return updateHint(io, current => (current.shutdownAt === accepted.shutdownAt
        ? { ...current, connectReplay: 'accepted', replaySince: undefined }
        // A later stop replaced the hint meanwhile: its own replay (since its intake stopped) is still owed.
        : (current.replaySince === since ? { ...current, replaySince: undefined } : null)),
    );
}

/**
 * An aborted drain disconnected intake at `intakeStoppedAt`: record that the
 * deliveries cached since then are owed. A replay already owed keeps its
 * earlier cursor; an unconsumed wake keeps its wake fields. Returns the hint
 * now holding the obligation.
 */
export function recordAbortedDrainReplay(intakeStoppedAt: number, io: HintIo = {}): Promise<IdleWakeHint> {
    return withHintFile(async () => {
        const current = await (io.readHint ?? readIdleWakeHint)().catch(() => null);
        if (current?.connectReplay === 'pending') return current;
        const stoppedIso = new Date(intakeStoppedAt).toISOString();
        const next: IdleWakeHint = isPendingIdleWake(current)
            ? { ...current, connectReplay: 'pending', replaySince: stoppedIso }
            : {
                version: 1,
                shutdownAt: stoppedIso,
                reason: 'idle shutdown aborted',
                idleForMs: 0,
                nextDueAt: null,
                nextDue: [],
                // Not a stop: the next start must not count as a wake.
                wokeAt: new Date().toISOString(),
                connectReplay: 'pending',
                intakeStoppedAt: stoppedIso,
            };
        await (io.writeHint ?? writeIdleWakeHint)(next);
        return next;
    });
}

/**
 * Ask the reconnecting relay for the replay `owed` holds, and release the
 * obligation only once it acknowledges. Not awaited by the drain: the request
 * waits for the next connection. A refusal, or a stop before an answer, leaves
 * it pending in the file (a later drain carries the cursor; the next start asks).
 */
export async function requestOwedReplay(
    routing: Pick<RoutingWebSocketIntakeService, 'requestReplay'>,
    owed: IdleWakeHint,
    io: HintIo = {},
): Promise<boolean> {
    const since = connectReplaySince(owed);
    if (!(await routing.requestReplay(since))) {
        logger.warn({ since }, 'Connect did not accept the replay of deliveries cached during the aborted idle drain; it stays pending');
        return false;
    }
    logger.info({ since }, 'Connect accepted the replay of deliveries cached during the aborted idle drain');
    await recordAcceptedReplay(io, owed, since).catch((error: Error) => {
        logger.warn({ error: error.message, file: resolveIdleWakeHintPath() }, 'Could not record the accepted replay in the idle wake hint');
    });
    return true;
}
