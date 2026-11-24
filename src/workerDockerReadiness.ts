/**
 * Waits for the Docker API before the worker prepares agent images.
 *
 * On Fly with `--legacy-docker` the app container no longer waits for the
 * docker sidecar to be healthy: after a wake from an idle stop dockerd took
 * ~34 s to listen, and the Fly proxy failed the waking request with 503
 * because the API was not up yet. The API now starts at once and only the
 * worker waits here, so a daemon still booting is not taken for a failed image
 * build (which would spend the registry's retry budget and open its circuit).
 *
 * Opt-in through PROPR_DOCKER_STARTUP_WAIT_SECONDS (set by `propr deploy fly
 * --legacy-docker`); unset or 0 skips the wait. When the deadline passes the
 * worker continues and the registry's own recovery takes over, as before.
 */

import { execFile } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export const DOCKER_STARTUP_WAIT_ENV = 'PROPR_DOCKER_STARTUP_WAIT_SECONDS';
const MAX_WAIT_SECONDS = 3600;
const PROBE_TIMEOUT_MS = 5_000;
export const DOCKER_STARTUP_POLL_MS = 1_000;

interface ReadinessLogger {
    info(details: object, message: string): void;
    warn(details: object, message: string): void;
}

export interface DockerStartupWaitDeps {
    logger: ReadinessLogger;
    env?: NodeJS.ProcessEnv;
    signal?: AbortSignal;
    /** Resolves when the Docker API answers; rejects otherwise. */
    probe?: () => Promise<void>;
    sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
    now?: () => number;
}

/** Seconds to wait, or 0 when the wait is off. Invalid values turn it off with a warning. */
export function resolveDockerStartupWaitSeconds(env: NodeJS.ProcessEnv, logger: ReadinessLogger): number {
    const raw = env[DOCKER_STARTUP_WAIT_ENV]?.trim();
    if (!raw) return 0;
    const seconds = Number(raw);
    if (!/^\d+$/.test(raw) || !Number.isSafeInteger(seconds) || seconds > MAX_WAIT_SECONDS) {
        logger.warn({ value: raw }, `${DOCKER_STARTUP_WAIT_ENV} must be a whole number of seconds from 0 to ${MAX_WAIT_SECONDS}; not waiting for Docker`);
        return 0;
    }
    return seconds;
}

async function probeDockerApi(env: NodeJS.ProcessEnv): Promise<void> {
    const { stdout } = await execFileAsync('docker', ['version', '--format', '{{.Server.Version}}'], { env, timeout: PROBE_TIMEOUT_MS });
    if (!stdout.trim()) throw new Error('Docker API returned no server version');
}

/**
 * Returns true once the Docker API answers, false when the wait is off or its
 * deadline passed. Rejects only when `signal` aborts (supervisor shutdown).
 */
export async function waitForDockerApiAtStartup(deps: DockerStartupWaitDeps): Promise<boolean> {
    const env = deps.env ?? process.env;
    const { logger, signal } = deps;
    const seconds = resolveDockerStartupWaitSeconds(env, logger);
    if (seconds === 0) return false;
    const probe = deps.probe ?? (() => probeDockerApi(env));
    const sleep = deps.sleep ?? ((ms: number, s?: AbortSignal) => delay(ms, undefined, { signal: s }));
    const now = deps.now ?? Date.now;
    const startedAt = now();
    const deadline = startedAt + seconds * 1000;
    let lastError = '';
    for (let attempt = 1; ; attempt += 1) {
        signal?.throwIfAborted();
        try {
            await probe();
            if (attempt > 1) logger.info({ waitedMs: now() - startedAt, attempts: attempt }, 'Docker API is reachable; preparing agent images');
            return true;
        } catch (error) {
            lastError = (error as Error).message;
        }
        if (attempt === 1) logger.info({ timeoutSeconds: seconds, error: lastError }, 'Waiting for the Docker API before preparing agent images');
        if (now() + DOCKER_STARTUP_POLL_MS > deadline) {
            logger.warn({ waitedMs: now() - startedAt, attempts: attempt, error: lastError }, 'Docker API still unreachable; continuing worker startup');
            return false;
        }
        await sleep(DOCKER_STARTUP_POLL_MS, signal);
    }
}
