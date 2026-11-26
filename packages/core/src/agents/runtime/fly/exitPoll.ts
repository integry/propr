import { setTimeout as delay } from 'node:timers/promises';
import { pollBackoff, type MachinesApi } from './api.js';
import { helper } from './launch.js';
import { afterInstall, lastProbeOutcome, POLL_FAILURE_TOLERANCE } from './startInstalls.js';

/** The worker's view of a Fly agent Machine: the wrapper's atomic status, polled until the agent exits. */

interface ExitPollCallbacks {
    bootDeadline: number;
    /** The start gate's window after an install: the wrapper opens a fresh one when it reports ready. */
    bootTimeout: number;
    /** Latest time the start-time installs (runtime packages, then package MCP servers) may still be running; the boot deadline without either. */
    installDeadline: number;
    start(machine: string): Promise<boolean>;
    activity(): void;
    readUsage(id: string): Promise<boolean>;
}

export async function probe(api: MachinesApi, id: string, signal: AbortSignal) {
    const res = await api.exec(id, [...helper, 'probe'], signal).catch(() => undefined);
    return res?.exit_code === 0 && /^(ready|running|installing|install-failed|exited (\d{1,3}))\n(\d+)$/.exec(res.stdout.trim());
}

const probeState = (status: Awaited<ReturnType<typeof probe>>) => status ? status[1] : undefined;

/** Poll the atomic status and consume new usage when a cap is active.
 * Changing byte counts are activity for the stall watchdog. */
export async function waitForExit(api: MachinesApi, id: string, forced: AbortSignal, { bootDeadline, bootTimeout, installDeadline, start, activity, readUsage }: ExitPollCallbacks) {
    let deadline = bootDeadline;
    let installed = false;
    let failures = 0;
    let retryUsage = false;
    let previousSize = -1;
    while (!forced.aborted) {
        const remaining = deadline - Date.now();
        if (remaining <= 0) return;
        const status = await probe(api, id, AbortSignal.any([forced, AbortSignal.timeout(remaining)]));
        let retry = !status;
        const state = probeState(status);
        if (state === 'install-failed') return state;
        if (state === 'installing') {
            // The wrapper bounds the install itself; keep polling while it reports progress.
            installed = true;
            deadline = Math.max(deadline, Math.min(Date.now() + POLL_FAILURE_TOLERANCE, installDeadline));
        } else if (state === 'ready') {
            // Not just the few seconds left past the last install probe.
            deadline = afterInstall(deadline, installed, bootTimeout);
            installed = false;
            if (Date.now() >= deadline) return;
            retry = !await start(id);
        } else if (status) {
            if (status[2] !== undefined) return Number(status[2]);
            const bytes = Number(status[3]);
            const changed = bytes !== previousSize;
            if (changed) activity();
            previousSize = bytes;
            if ((changed || retryUsage) && !forced.aborted) retryUsage = !await readUsage(id);
            retry = retryUsage;
            deadline = Date.now() + POLL_FAILURE_TOLERANCE;
        } else if (!forced.aborted && Date.now() >= deadline) return;
        if (!retry) failures = 0;
        const interval = retry ? pollBackoff(failures++) : 500;
        await delay(Math.min(interval, Math.max(0, deadline - Date.now())), undefined, { signal: forced }).catch(() => {});
    }
    // The grace period may expire between polls, after the clone transport
    // has finished publishing its bundle. Check before forcing deletion.
    const last = await probe(api, id, AbortSignal.timeout(1500));
    return lastProbeOutcome(last);
}

