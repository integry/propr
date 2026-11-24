/**
 * Pure configuration and shutdown-ordering helpers for the all-in-one entry
 * (src/allInOne.ts). Kept free of service imports so they can be tested
 * without Redis, SQLite or Docker.
 */

/**
 * Where the repository indexing worker runs in all-in-one mode:
 * - `inline`   (default) in the same Node process as daemon/worker/api;
 * - `separate` in its own process/container (`npm run indexing-worker`);
 * - `off`      not at all (repository context indexing is unavailable).
 */
export type IndexingMode = 'off' | 'inline' | 'separate';

export const INDEXING_MODES: readonly IndexingMode[] = ['off', 'inline', 'separate'];

export function resolveIndexingMode(value: string | undefined): IndexingMode {
    const normalized = (value ?? '').trim().toLowerCase();
    if (normalized === '') return 'inline';
    if ((INDEXING_MODES as readonly string[]).includes(normalized)) return normalized as IndexingMode;
    throw new Error(`PROPR_INDEXING must be one of ${INDEXING_MODES.join(', ')} (got "${value}")`);
}

/**
 * Fill the environment defaults the composed process needs before the API
 * module is imported (it validates FRONTEND_URL and autostarts at import).
 * Explicit operator values always win. Returns the keys that were defaulted.
 */
export function prepareAllInOneEnvironment(env: NodeJS.ProcessEnv): string[] {
    const defaulted: string[] = [];
    const setDefault = (name: string, value: string): void => {
        if (env[name] !== undefined) return;
        env[name] = value;
        defaulted.push(name);
    };
    // The composer starts the API itself, after migrations and with its own
    // signal handling; the module must not start a second server on import.
    env.PROPR_API_DISABLE_AUTOSTART = '1';
    // Same-origin UI: the API serves the bundle, so there is no UI container.
    if (env.PROPR_UI_DIST_DIR === undefined) setDefault('PROPR_SERVE_UI', '1');
    const apiPort = env.DASHBOARD_API_PORT || '4000';
    setDefault('FRONTEND_URL', env.API_PUBLIC_URL || `http://localhost:${apiPort}`);
    return defaulted;
}

export interface ShutdownStep {
    name: string;
    close: () => Promise<unknown>;
}

/**
 * Close components strictly in order, continuing past failures so one
 * component cannot keep the rest (and their Redis/SQLite handles) open.
 * Returns the names of steps that failed.
 */
export async function runShutdownSequence(
    steps: readonly ShutdownStep[],
    log: { info(message: string): void; error(message: string, error: unknown): void },
    onStep?: (name: string) => void,
): Promise<string[]> {
    const failed: string[] = [];
    for (const step of steps) {
        try {
            onStep?.(step.name);
            log.info(`all-in-one: closing ${step.name}`);
            await step.close();
        } catch (error) {
            failed.push(step.name);
            log.error(`all-in-one: failed to close ${step.name}`, error);
        }
    }
    return failed;
}

/** Components the all-in-one process starts, by role. */
export type ComponentRole = 'daemon' | 'worker' | 'indexing' | 'api';

/**
 * Shutdown order (start order differs):
 * 1. stop intake first, so no new GitHub events become jobs;
 * 2. drain the indexing worker, which does not own the egress proxies;
 * 3. drain the main worker; its sweeper then closes every egress proxy in the
 *    process, which is why it goes after indexing;
 * 4. close the API (HTTP, Socket.IO, sessions) last so the UI keeps reporting
 *    state while jobs drain.
 */
export const SHUTDOWN_ORDER: readonly ComponentRole[] = ['daemon', 'indexing', 'worker', 'api'] as const;

/**
 * One startup step. `role` steps return the started component's close handle;
 * other steps (status maintenance, ...) only take effect and return nothing.
 */
export interface StartupStage {
    name: string;
    role?: ComponentRole;
    /**
     * `signal` aborts when shutdown begins. A stage that can wait indefinitely
     * (the worker waits for agent image readiness) must give up on it, or
     * shutdown, which waits for the stage still starting, never completes.
     */
    run: (signal: AbortSignal) => Promise<{ close(): Promise<unknown> } | void>;
}

export interface ComponentSupervisor {
    /** True once close() was called; no further stage starts after that. */
    readonly closing: boolean;
    /** What close() is waiting on right now (a stage still starting, or a shutdown step); null before or after. */
    readonly pendingStep: string | null;
    /**
     * Run stages in order. Stops before the next stage once shutdown began and
     * resolves false; a stage still starting when shutdown begins is awaited by
     * close() and its component closed with the rest. A stage that fails after
     * shutdown began is logged instead of rethrown, so it cannot abort the
     * drain. Resolves true when every stage ran.
     */
    run(stages: readonly StartupStage[]): Promise<boolean>;
    /**
     * Idempotent: aborts the startup signal, waits (at most `startupWaitMs`)
     * for in-flight startup, then closes in SHUTDOWN_ORDER followed by `finalSteps`. A stage still starting
     * after that wait is left behind: some never finish (the worker waits for
     * an agent image that may never become ready), and the stop must not wait
     * on them.
     */
    close(): Promise<string[]>;
}

/** How long close() waits for a component that is still starting. */
export const DEFAULT_STARTUP_WAIT_MS = 10_000;

type SupervisorLog = { info(message: string): void; error(message: string, error: unknown): void };

/**
 * Coordinates component startup with shutdown, so a termination signal that
 * arrives mid-startup neither misses a component that finishes starting while
 * shutdown runs nor lets startup go on to start more components.
 */
export function createComponentSupervisor(options: {
    log: SupervisorLog;
    /** Steps after every component closed (the shared task queue). */
    finalSteps?: () => Promise<readonly ShutdownStep[]> | readonly ShutdownStep[];
    startupWaitMs?: number;
}): ComponentSupervisor {
    const handles: Partial<Record<ComponentRole, ShutdownStep>> = {};
    let inFlight: { name: string; settled: Promise<unknown> } | undefined;
    let closing: Promise<string[]> | undefined;
    let pendingStep: string | null = null;
    const startupWaitMs = options.startupWaitMs ?? DEFAULT_STARTUP_WAIT_MS;

    /** Resolves true once the stage still starting settled, false when the wait ran out first. */
    const waitForInFlight = async (): Promise<boolean> => {
        if (!inFlight) return true;
        const { name, settled } = inFlight;
        pendingStep = `${name} (still starting)`;
        let timer: NodeJS.Timeout | undefined;
        const finished = await Promise.race([
            settled.then(() => true),
            new Promise<false>(resolve => { timer = setTimeout(() => resolve(false), startupWaitMs); }),
        ]);
        clearTimeout(timer);
        if (!finished) options.log.info(`all-in-one: ${name} did not finish starting within ${Math.round(startupWaitMs / 1000)}s; closing the components that started without it`);
        return finished;
    };
    const startupAbort = new AbortController();

    const supervisor: ComponentSupervisor = {
        get closing() {
            return closing !== undefined;
        },
        get pendingStep() {
            return pendingStep;
        },
        async run(stages) {
            for (const stage of stages) {
                if (closing) {
                    options.log.info(`all-in-one: shutdown in progress, not starting ${stage.name}`);
                    return false;
                }
                const started = stage.run(startupAbort.signal).then(handle => {
                    // Registered even when shutdown began meanwhile: close() waits for
                    // this promise before it builds its sequence.
                    if (stage.role && handle) handles[stage.role] = { name: stage.name, close: () => handle.close() };
                });
                inFlight = { name: stage.name, settled: started.catch(() => undefined) };
                try {
                    await started;
                } catch (error) {
                    if (!closing) throw error;
                    options.log.error(`all-in-one: ${stage.name} failed to start during shutdown`, error);
                    return false;
                } finally {
                    inFlight = undefined;
                }
            }
            return !closing;
        },
        close() {
            closing ??= (async () => {
                startupAbort.abort(new Error('all-in-one shutdown'));
                await waitForInFlight();
                const steps = SHUTDOWN_ORDER
                    .map(role => handles[role])
                    .filter((step): step is ShutdownStep => step !== undefined);
                steps.push(...(await options.finalSteps?.() ?? []));
                const failed = await runShutdownSequence(steps, options.log, name => { pendingStep = name; });
                pendingStep = null;
                return failed;
            })();
            return closing;
        },
    };
    return supervisor;
}

/** Default drain budget: Fly's stop_config timeout (60s) minus a margin. */
export const DEFAULT_SHUTDOWN_TIMEOUT_MS = 50_000;

/** PROPR_SHUTDOWN_TIMEOUT_MS, in ms (1s to 1h); the default otherwise. */
export function resolveShutdownTimeoutMs(value: string | undefined): number {
    const normalized = (value ?? '').trim();
    if (normalized === '') return DEFAULT_SHUTDOWN_TIMEOUT_MS;
    const ms = Number(normalized);
    if (!Number.isInteger(ms) || ms < 1_000 || ms > 3_600_000) {
        throw new Error(`PROPR_SHUTDOWN_TIMEOUT_MS must be a whole number of milliseconds from 1000 to 3600000 (got "${value}")`);
    }
    return ms;
}

/** How long an idle exit waits for the host to accept its stop before it exits 1 instead. */
export const DEFAULT_HOST_STOP_TIMEOUT_MS = 10_000;

/**
 * Stops the host the process runs in, not only the process. On a
 * multi-container Fly Machine an exit 0 of the app container leaves Redis and
 * any sidecar running, so the Machine stays started: unreachable, and billed.
 * Resolves once the host accepted the stop; rejects when it refused or did not
 * answer within `timeoutMs`.
 */
export type HostStop = (timeoutMs: number) => Promise<void>;

export interface BoundedExitCall {
    /** An idle stop's arranged wake (epoch ms): the process exits by then, and exits 1 when the close reaches it. */
    exitBy?: number | null;
    /**
     * Idle exit only: stop the whole host before exiting 0. A host that does
     * not accept the stop, or not before `exitBy`, makes the exit 1, so the
     * supervisor starts the control plane again instead of leaving it stopped
     * inside a running host.
     */
    stopHost?: HostStop | null;
    /** A termination signal. During the host stop it means the host is stopping this process: the stop was accepted. */
    signal?: string;
    /**
     * An idle stop (not a termination signal). Its close reaching the relative deadline exits 1 without a host stop:
     * components close in order and the API closes last, so while an earlier close hangs the API still answers, and
     * a request or Connect wake ping it acknowledged then may come after the activity read in the exit. A SIGTERM
     * close reaching that deadline still exits 0, as the supervisor stopping it expects.
     */
    idle?: boolean;
    /**
     * Idle exit only: the start of the idle period the stop was decided on (epoch ms). A request the API saw after it
     * (one the quiesced API turned away with `Retry-After` included) is a client about to retry: read again once the
     * close is over (the API no longer admits requests) and before the host is asked to stop, it makes the exit 1,
     * so the supervisor starts the control plane for that retry instead of leaving it stopped.
     */
    activitySince?: number | null;
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, what: string): Promise<T> {
    let timer: NodeJS.Timeout | undefined;
    return Promise.race([
        promise,
        new Promise<never>((_resolve, reject) => { timer = setTimeout(() => reject(new Error(`${what} did not finish within ${timeoutMs} ms`)), timeoutMs); }),
    ]).finally(() => clearTimeout(timer));
}

/**
 * The all-in-one exit: close every component, then exit. Bounded: a close
 * that is still running at `deadlineMs` (a component that never finishes
 * starting, a connection that never drains) no longer keeps the process up;
 * it is logged by name and the process exits 0, as a supervisor stop (Fly,
 * systemd) expects. An idle stop's close exits 1 then instead, without asking
 * the host to stop (see {@link BoundedExitCall.idle}). A close that completes with
 * failed steps exits 1. The caller may ask for a higher code (an idle stop
 * called off exits 1, so an on-failure supervisor starts the process again).
 *
 * `exitBy` (epoch ms; an idle stop's arranged wake) is an absolute limit on
 * top: the process exits by then, and reaching it before the close is over
 * exits with at least 1, since that wake reached a process still running and
 * the supervisor must start it instead. An idle exit with `stopHost` asks the
 * host to stop before it exits 0 (see {@link BoundedExitCall.stopHost}); a
 * request the API saw since the idle period began, read once the close is
 * over, makes it exit 1 instead (see {@link BoundedExitCall.activitySince}). Logs
 * are flushed (bounded, and for an exit before `exitBy` only for the time left
 * until then) before exiting. Calling the returned function again does
 * nothing, except that a signal during the host stop counts as its acceptance.
 */
export function createBoundedExit(options: {
    close: () => Promise<string[]>;
    exit: (code: number) => void;
    pendingStep: () => string | null;
    log: { info(message: string): void; error(message: string, error?: unknown): void };
    flush?: (timeoutMs?: number) => Promise<void>;
    deadlineMs?: number;
    hostStopTimeoutMs?: number;
    /** The last request the API in this process saw (epoch ms, 0 for none), for {@link BoundedExitCall.activitySince}. */
    lastActivityAt?: () => number;
}): (exitCode?: number, call?: BoundedExitCall) => void {
    const deadlineMs = options.deadlineMs ?? DEFAULT_SHUTDOWN_TIMEOUT_MS;
    const hostStopTimeoutMs = options.hostStopTimeoutMs ?? DEFAULT_HOST_STOP_TIMEOUT_MS;
    let exiting = false;
    let signalledHostStop: ((signal: string) => void) | null = null;
    return (exitCode = 0, call = {}) => {
        if (exiting) {
            if (call.signal) signalledHostStop?.(call.signal);
            return;
        }
        exiting = true;
        const exitBy = call.exitBy ?? null;
        const untilExitBy = exitBy === null ? Number.POSITIVE_INFINITY : Math.max(0, exitBy - Date.now());

        /** An idle exit after a request reached the API since the idle period began: the client's retry needs the instance up. */
        const activityAfterIdle = (code: number): number => {
            const since = call.activitySince ?? null;
            if (code !== 0 || since === null || !options.lastActivityAt) return code;
            let last: number;
            try {
                last = options.lastActivityAt();
            } catch {
                last = Number.POSITIVE_INFINITY;
            }
            if (!(last > since)) return code;
            options.log.error(`all-in-one: a request reached the API while the idle stop was closing${Number.isFinite(last) ? ` (at ${new Date(last).toISOString()})` : ''}; exiting with code 1 so the supervisor starts the control plane again for its retry`);
            return 1;
        };

        /** Step before the exit of an idle stop: the whole host stops, or the exit is 1. */
        const stopHost = async (code: number): Promise<number> => {
            const stop = call.stopHost;
            if (code !== 0 || !stop) return code;
            const timeoutMs = Math.min(hostStopTimeoutMs, exitBy === null ? Number.POSITIVE_INFINITY : exitBy - Date.now());
            if (timeoutMs <= 0) {
                options.log.error('all-in-one: the wake arranged for the idle stop came before the host was asked to stop; exiting with code 1 so the supervisor starts it again');
                return 1;
            }
            const signalled = new Promise<string>(resolve => { signalledHostStop = resolve; });
            try {
                const how = await withTimeout(Promise.race([stop(timeoutMs).then(() => 'accepted'), signalled]), timeoutMs, 'the host stop');
                options.log.info(how === 'accepted'
                    ? 'all-in-one: the host accepted the idle stop; exiting with code 0'
                    : `all-in-one: ${how} received while the host was asked to stop; exiting with code 0`);
                return 0;
            } catch (error) {
                options.log.error('all-in-one: the host did not accept the idle stop; exiting with code 1 so the supervisor starts the control plane again instead of leaving it stopped inside a running host', error);
                return 1;
            } finally {
                signalledHostStop = null;
            }
        };

        let done = false;
        const finish = (closeCode: number): void => {
            if (done) return;
            done = true;
            clearTimeout(deadline);
            // Read here, once the close is over: requests reach the API until its shutdown stage, after the last check
            // the daemon made, and the earlier closes may have taken most of the allowance.
            void stopHost(activityAfterIdle(closeCode)).then(async code => {
                const flushFor = code === 0 && exitBy !== null ? Math.max(0, Math.min(1_000, exitBy - Date.now())) : undefined;
                await (options.flush?.(flushFor) ?? Promise.resolve()).catch(() => undefined);
                // The flush got the time left until the wake, and may have used all of it: an exit 0 at or after the wake
                // would leave the process stopped for good, so the wake is checked once more right before the exit.
                if (code === 0 && exitBy !== null && Date.now() >= exitBy) {
                    options.log.error('all-in-one: the wake arranged for the idle stop came while the logs were flushed; exiting with code 1 so the supervisor starts it again');
                    options.exit(1);
                    return;
                }
                options.exit(code);
            });
        };
        // Not unref'd: the process exits through here, not when the event loop empties.
        const deadline = setTimeout(() => {
            if (untilExitBy <= deadlineMs) {
                options.log.error(`all-in-one: still shutting down when the wake arranged for the idle stop came (still closing: ${options.pendingStep() ?? 'unknown'}); exiting with code 1 so the supervisor starts it again`);
                finish(Math.max(1, exitCode));
                return;
            }
            if (call.idle) {
                // The close is not over, so the API may still be answering: a request or wake ping it acknowledges
                // while the host stop or the log flush runs would come after any activity read here. Exit 1, no host stop.
                options.log.error(`all-in-one: the idle stop did not finish closing within ${formatMs(deadlineMs)} (still closing: ${options.pendingStep() ?? 'unknown'}); exiting with code 1 without stopping the host, so the supervisor starts the control plane again for any request it served meanwhile`);
                finish(Math.max(1, exitCode));
                return;
            }
            options.log.error(`all-in-one: shutdown did not finish within ${formatMs(deadlineMs)} (still closing: ${options.pendingStep() ?? 'unknown'}); exiting anyway`);
            finish(exitCode);
        }, Math.min(deadlineMs, untilExitBy));
        options.close().then(
            failed => {
                const late = exitBy !== null && Date.now() >= exitBy;
                const code = Math.max(failed.length > 0 || late ? 1 : 0, exitCode);
                options.log.info(`all-in-one: shutdown complete (exit ${code})`);
                finish(code);
            },
            error => {
                options.log.error('all-in-one: shutdown failed', error);
                finish(Math.max(1, exitCode));
            },
        );
    };
}

function formatMs(ms: number): string {
    return ms % 1000 === 0 ? `${ms / 1000}s` : `${ms} ms`;
}

export interface ShutdownSignalOptions {
    /** The bounded exit for a termination signal (see {@link createBoundedExit}). */
    stop: (signal: 'SIGINT' | 'SIGTERM') => void;
    log: { info(message: string): void; warn(message: string): void };
    exit: (code: number) => void;
    /** Signal registration; `process.on` in production. */
    on: (signal: 'SIGINT' | 'SIGTERM', handler: () => void) => void;
}

/**
 * SIGINT/SIGTERM drain the process through the bounded exit. A second signal
 * exits 1 at once. A signal during an idle stop goes to that stop, which is
 * already exiting (and, while it waits for the host to stop, takes the signal
 * as the host stopping it).
 */
export function installShutdownSignalHandlers(options: ShutdownSignalOptions): void {
    let signalled = false;
    for (const signal of ['SIGINT', 'SIGTERM'] as const) {
        options.on(signal, () => {
            if (signalled) {
                options.log.warn(`all-in-one received a second ${signal}; exiting immediately`);
                options.exit(1);
                return;
            }
            signalled = true;
            options.log.info(`all-in-one received ${signal}, shutting down gracefully...`);
            options.stop(signal);
        });
    }
}
