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
