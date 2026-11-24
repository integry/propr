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
    run: () => Promise<{ close(): Promise<unknown> } | void>;
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
     * Idempotent: waits (at most `startupWaitMs`) for in-flight startup, then
     * closes in SHUTDOWN_ORDER followed by `finalSteps`. A stage still starting
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
                const started = stage.run().then(handle => {
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

/** Hard limit on the whole all-in-one stop (signal or idle shutdown) before the process exits anyway. */
export const DEFAULT_SHUTDOWN_DEADLINE_MS = 30_000;

/**
 * The all-in-one exit: close every component, then exit. Bounded: a close
 * that is still running at `deadlineMs` (a component that never finishes
 * starting, a connection that never drains) no longer keeps the process up;
 * it is logged by name and the process exits 0, as a supervisor stop (Fly,
 * systemd) and an idle shutdown both expect. A close that completes with
 * failed steps exits 1. Logs are flushed (bounded) before exiting. Calling the
 * returned function again does nothing.
 */
export function createBoundedExit(options: {
    close: () => Promise<string[]>;
    exit: (code: number) => void;
    pendingStep: () => string | null;
    log: { info(message: string): void; error(message: string, error?: unknown): void };
    flush?: () => Promise<void>;
    deadlineMs?: number;
}): () => void {
    const deadlineMs = options.deadlineMs ?? DEFAULT_SHUTDOWN_DEADLINE_MS;
    let exiting = false;
    return () => {
        if (exiting) return;
        exiting = true;
        let done = false;
        const finish = (code: number): void => {
            if (done) return;
            done = true;
            clearTimeout(deadline);
            void (options.flush?.() ?? Promise.resolve()).catch(() => undefined).finally(() => options.exit(code));
        };
        // Not unref'd: the process exits through here, not when the event loop empties.
        const deadline = setTimeout(() => {
            options.log.error(`all-in-one: shutdown did not finish within ${Math.round(deadlineMs / 1000)}s (still closing: ${options.pendingStep() ?? 'unknown'}); exiting anyway`);
            finish(0);
        }, deadlineMs);
        options.close().then(
            failed => {
                options.log.info(`all-in-one: shutdown complete (exit ${failed.length > 0 ? 1 : 0})`);
                finish(failed.length > 0 ? 1 : 0);
            },
            error => {
                options.log.error('all-in-one: shutdown failed', error);
                finish(1);
            },
        );
    };
}
