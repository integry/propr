import logger from '../../utils/logger.js';
import type { FlyLogLine, FlyLogPage, FlyMachinesClient } from './flyMachinesApi.js';
import { parseFlyLogLine } from './flyMachinesLaunch.js';

/** Log pages read per poll at most; the rest of a backlog waits for the next poll. */
const MAX_LOG_PAGES_PER_POLL = 20;

/** Resolves after `ms`, or early when `signal` aborts (never rejects). */
export function pause(ms: number, signal?: AbortSignal): Promise<void> {
    return new Promise(resolve => {
        const timer = setTimeout(done, ms);
        function done(): void { clearTimeout(timer); signal?.removeEventListener('abort', done); resolve(); }
        signal?.addEventListener('abort', done, { once: true });
    });
}

/** True when `settled` settles (resolves or rejects) within `ms`, false once `ms` passed. */
export async function settlesWithin(settled: Promise<unknown>, ms: number): Promise<boolean> {
    let timer: NodeJS.Timeout | undefined;
    const expired = new Promise<false>(resolve => { timer = setTimeout(() => resolve(false), ms); });
    try {
        return await Promise.race([settled.then(() => true, () => true), expired]);
    } finally {
        clearTimeout(timer);
    }
}

/**
 * When polling must give way to termination handling: the run is cancelled,
 * or a deadline passed. `signal` aborts the requests in flight; `due()`
 * rechecks the deadline at once. `dispose()` once the poll is over.
 */
export interface PollInterrupt {
    signal: AbortSignal;
    due(): boolean;
    dispose(): void;
}

/**
 * Due once `cancel` aborts or `until` passed on the run's clock `now`: at
 * every `due()`, and by a timer at least every `recheckMs`, so a request in
 * flight is aborted when the deadline passes.
 */
export function pollInterrupt(cancel: AbortSignal, until: number, now: () => number, recheckMs: number): PollInterrupt {
    const expired = new AbortController();
    const signal = AbortSignal.any([cancel, expired.signal]);
    let timer: NodeJS.Timeout | undefined;
    const due = (): boolean => {
        if (!signal.aborted && now() >= until) expired.abort();
        return signal.aborted;
    };
    const recheck = (): void => {
        const remaining = until - now();
        if (remaining <= 0) expired.abort();
        if (signal.aborted) return;
        timer = setTimeout(recheck, Math.min(remaining, recheckMs));
        timer.unref();
    };
    recheck();
    return { signal, due, dispose: () => clearTimeout(timer) };
}

export interface FlyLogSink {
    /** A line of the agent's output, in order. */
    output(stream: 'stdout' | 'stderr', text: string, timestamp: string): void;
    /** The exit status the launcher logged. */
    exit(code: number): void;
}

/**
 * A run's output as the launcher mirrors it to the console, read from the
 * logs API page by page while the agent runs: the live view (the exact
 * output is read from the capture files once it finished).
 */
export class FlyLogStream {
    private token?: string;
    private warned = false;

    constructor(private readonly client: FlyMachinesClient, private readonly runName: string, private readonly sink: FlyLogSink) {}

    /**
     * Streams the pages written since the last poll. Gives way to termination
     * handling: stops between pages, and aborts the page in flight, once
     * `interrupt` is due (the run is cancelled, or the run deadline or the end
     * of a stop window passed). What it did not read stays after the last
     * token for a later poll, and in the capture files. A logs API failure is
     * logged once; the run goes on without the live view.
     */
    async poll(machineId: string, interrupt: PollInterrupt): Promise<void> {
        for (let pages = 0; pages < MAX_LOG_PAGES_PER_POLL; pages++) {
            if (interrupt.due()) return;
            let page: FlyLogPage;
            try {
                page = await this.client.logs(machineId, this.token, { signal: interrupt.signal });
            } catch (error) {
                if (!interrupt.signal.aborted && !this.warned) {
                    logger.warn({ run: this.runName, machine: machineId, error: (error as Error).message }, 'Fly logs unavailable; the run output is read from the Machine when it finishes');
                    this.warned = true;
                }
                return;
            }
            if (page.nextToken) this.token = page.nextToken;
            for (const line of page.lines) this.dispatch(line);
            if (page.lines.length === 0 || !page.nextToken) return;
        }
    }

    private dispatch(line: FlyLogLine): void {
        const parsed = parseFlyLogLine(line.message);
        if (!parsed) return;
        if ('exitCode' in parsed) { this.sink.exit(parsed.exitCode); return; }
        this.sink.output(parsed.stream, parsed.text, line.timestamp || new Date().toISOString());
    }
}
