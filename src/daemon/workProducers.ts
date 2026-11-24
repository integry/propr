/**
 * The daemon's own work producers (issue #3770): the periodic sweeps that
 * queue jobs, create agent runs or act on GitHub (schedules, retries,
 * recovery, auto-merge, merge conflicts). An idle drain pauses them before
 * its last check, and waits for a run in progress, so that no daemon sweep
 * can add work after the check while the rest of the control plane stops.
 * A drain that aborts resumes them.
 */

/** Starts one producer and returns its stop: clear its timer, then wait for a run in progress. */
export type StartWorkProducer = () => () => Promise<void>;

export interface DaemonWorkProducers {
    /** Register and start (unless paused: then it starts on resume). */
    add(name: string, start: StartWorkProducer): void;
    /** Stop every producer; resolves with the ones whose run in progress did not finish within `timeoutMs`. */
    pause(timeoutMs: number): Promise<string[]>;
    /** Start them again, each once its earlier run has finished, so two runs never overlap. */
    resume(): void;
    /** The daemon's close: stop every producer and wait for runs in progress. */
    stop(): Promise<void>;
}

interface Entry {
    name: string;
    start: StartWorkProducer;
    stop: (() => Promise<void>) | null;
    /** The stop in progress (or done) since the last pause. */
    stopping: Promise<void>;
}

export function createDaemonWorkProducers(log: { error(details: object, message: string): void }): DaemonWorkProducers {
    const entries: Entry[] = [];
    let state: 'running' | 'paused' | 'closed' = 'running';
    const stopEntry = (entry: Entry): Promise<void> => {
        const stop = entry.stop;
        entry.stop = null;
        if (stop) entry.stopping = Promise.all([entry.stopping, stop().catch(() => undefined)]).then(() => undefined);
        return entry.stopping;
    };
    return {
        add(name, start) {
            entries.push({ name, start, stop: state === 'running' ? start() : null, stopping: Promise.resolve() });
        },
        async pause(timeoutMs) {
            if (state === 'running') state = 'paused';
            const running = new Set(entries.map(entry => entry.name));
            const stopped = Promise.all(entries.map(entry => stopEntry(entry).then(() => { running.delete(entry.name); })));
            let timer: NodeJS.Timeout | undefined;
            await Promise.race([stopped, new Promise(resolve => { timer = setTimeout(resolve, timeoutMs); })]);
            clearTimeout(timer);
            return [...running];
        },
        resume() {
            if (state !== 'paused') return;
            state = 'running';
            for (const entry of entries) {
                void entry.stopping.then(() => {
                    if (state === 'running' && !entry.stop) entry.stop = entry.start();
                }).catch((error: unknown) => {
                    log.error({ producer: entry.name, error: (error as Error).message }, 'Could not restart a daemon sweep after an aborted idle drain');
                });
            }
        },
        async stop() {
            state = 'closed';
            await Promise.all(entries.map(stopEntry));
        },
    };
}
