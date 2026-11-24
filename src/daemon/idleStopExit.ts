import type { IdleShutdownRecord } from '@propr/shared';
import { beforeIdleDeadline, closeConnection, logger } from '@propr/core';
import { flushLogs } from '../shared/flushLogs.js';
import type { IdleDrainContext } from './idleShutdown.js';

/** The composed process's coordinated close of every component; see {@link IdleDrainContext.stopProcess}. */
export type IdleStopProcess = (exitCode: number, options?: { exitBy: number | null }) => void;

const toIso = (ms: number | null): string | null => (ms === null ? null : new Date(ms).toISOString());

/**
 * Step 7: the daemon itself, or (composed) the process's one coordinated
 * close of every component. An idle exit (0) must happen before `wakeAt`, the
 * wake arranged for the scheduled work: that wake would otherwise reach a
 * process still closing, which then stops for good. A close that reaches it
 * exits 1, so the supervisor starts the control plane for that work.
 */
export async function stopDaemonProcess(
    ctx: Pick<IdleDrainContext, 'stopProcess' | 'close' | 'exit'>,
    record: IdleShutdownRecord,
    options: { closeDeadlineMs: number; exitCode: number; wakeAt: number | null; flush?: (timeoutMs?: number) => Promise<void> },
): Promise<void> {
    const { closeDeadlineMs, exitCode, flush = flushLogs } = options;
    const exitBy = exitCode === 0 ? options.wakeAt : null;
    if (ctx.stopProcess) {
        // Bounded there: the composed close ends in process.exit within its own deadline, and exits 1 at `exitBy`.
        logger.info({ ...record, exitBy: toIso(exitBy) }, `Idle shutdown: closing every component of this process (exit ${exitCode})`);
        ctx.stopProcess(exitCode, { exitBy });
        return;
    }
    logger.info({ ...record, exitBy: toIso(exitBy) }, exitCode === 0 ? 'Idle shutdown: control plane stopped (exit 0)' : `Idle shutdown called off: closing the daemon (exit ${exitCode})`);
    // The stop is recorded and every process has stopped: a close that hangs or fails must not keep the daemon up.
    const closeBy = Date.now() + closeDeadlineMs;
    const closing = (async () => {
        await ctx.close();
        await closeConnection();
    })();
    const wakeBoundsClose = exitBy !== null && exitBy <= closeBy;
    const outcome = await beforeIdleDeadline(closing, wakeBoundsClose ? exitBy : closeBy).then(result => (result.ok ? 'closed' : 'deadline'), (error: unknown) => error);
    let code = exitCode;
    // A deadline reached at the wake counts as the wake itself: the timer may fire a millisecond before
    // Date.now() reads exitBy, and an exit 0 then would come with the close still running at the wake.
    if (exitBy !== null && ((outcome === 'deadline' && wakeBoundsClose) || Date.now() >= exitBy)) {
        code = 1;
        logger.error({ wakeAt: toIso(exitBy) }, 'Idle shutdown: the daemon was still closing when the wake arranged for the scheduled work came; exiting with code 1 so the supervisor starts it again');
    } else if (outcome === 'deadline') logger.error({ closeDeadlineMs }, 'Idle shutdown: the daemon did not finish closing in time; exiting anyway');
    else if (outcome !== 'closed') logger.error({ error: (outcome as Error)?.message }, 'Idle shutdown: the daemon close failed; exiting anyway');
    // An idle exit still comes before the wake: the flush gets only the time left until then.
    await flush(code === 0 && exitBy !== null ? Math.max(0, Math.min(1_000, exitBy - Date.now())) : undefined).catch(() => undefined);
    // The flush may have used all of that time: checked once more right before the exit, since an exit 0 at or
    // after the wake would leave the daemon stopped for good.
    if (code === 0 && exitBy !== null && Date.now() >= exitBy) {
        code = 1;
        logger.error({ wakeAt: toIso(exitBy) }, 'Idle shutdown: the wake arranged for the scheduled work came while the logs were flushed; exiting with code 1 so the supervisor starts the daemon again');
    }
    ctx.exit(code);
}
