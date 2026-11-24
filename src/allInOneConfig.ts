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
): Promise<string[]> {
    const failed: string[] = [];
    for (const step of steps) {
        try {
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
    /**
     * Run stages in order. Stops before the next stage once shutdown began and
     * resolves false; a stage still starting when shutdown begins is awaited by
     * close() and its component closed with the rest. A stage that fails after
     * shutdown began is logged instead of rethrown, so it cannot abort the
     * drain. Resolves true when every stage ran.
     */
    run(stages: readonly StartupStage[]): Promise<boolean>;
    /**
     * Idempotent: aborts the startup signal, waits for in-flight startup, then
     * closes in SHUTDOWN_ORDER followed by `finalSteps`.
     */
    close(): Promise<string[]>;
}

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
}): ComponentSupervisor {
    const handles: Partial<Record<ComponentRole, ShutdownStep>> = {};
    let inFlight: Promise<unknown> | undefined;
    let closing: Promise<string[]> | undefined;
    const startupAbort = new AbortController();

    const supervisor: ComponentSupervisor = {
        get closing() {
            return closing !== undefined;
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
                inFlight = started.catch(() => undefined);
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
                await inFlight;
                const steps = SHUTDOWN_ORDER
                    .map(role => handles[role])
                    .filter((step): step is ShutdownStep => step !== undefined);
                steps.push(...(await options.finalSteps?.() ?? []));
                return runShutdownSequence(steps, options.log);
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

export interface ShutdownSignalOptions {
    close: () => Promise<string[]>;
    /** Exit after this long even if the drain has not finished. */
    timeoutMs: number;
    log: { info(message: string): void; warn(message: string): void; error(message: string): void };
    exit: (code: number) => void;
    /** Signal registration; `process.on` in production. */
    on: (signal: 'SIGINT' | 'SIGTERM', handler: () => void) => void;
}

/**
 * SIGINT/SIGTERM drain the process and exit: 0 when every component closed,
 * 1 when one failed to close, and 0 when the drain outlives `timeoutMs`. A
 * termination signal is a requested stop, so an overrun still exits 0: under
 * an on-failure restart policy (Fly idle shutdown) a non-zero code would
 * restart the Machine that was asked to stop. The deadline timer is unref'd so
 * it never keeps an otherwise finished process alive. A second signal exits 1
 * at once.
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
            const deadline = setTimeout(() => {
                options.log.error(`all-in-one: shutdown did not finish within ${options.timeoutMs} ms; exiting`);
                options.exit(0);
            }, options.timeoutMs);
            deadline.unref?.();
            void options.close().then(
                failed => options.exit(failed.length > 0 ? 1 : 0),
                () => options.exit(1),
            ).finally(() => clearTimeout(deadline));
        });
    }
}
