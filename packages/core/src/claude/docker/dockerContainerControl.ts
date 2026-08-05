import { execFile } from 'node:child_process';
import logger from '../../utils/logger.js';

const DOCKER_PATH = '/usr/bin/docker';
const CONTAINER_IDENTIFIER_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/;
const MAX_STOP_TIMEOUT_SECONDS = 300;
const DEFAULT_CREATION_RACE_ATTEMPTS = 10;
const DEFAULT_CREATION_RACE_RETRY_MS = 250;
const DEFAULT_TEARDOWN_DEADLINE_MS = 4000;
const MAX_TEARDOWN_DEADLINE_MS = 10000;

function validateStopRequest(containerId: string, timeoutSeconds: number): string | undefined {
    if (!containerId) return 'No container ID provided';
    if (!CONTAINER_IDENTIFIER_PATTERN.test(containerId)) return 'Invalid Docker container identifier';
    if (!Number.isInteger(timeoutSeconds)
        || timeoutSeconds < 0
        || timeoutSeconds > MAX_STOP_TIMEOUT_SECONDS) {
        return `Docker stop timeout must be an integer between 0 and ${MAX_STOP_TIMEOUT_SECONDS} seconds`;
    }
    return undefined;
}

function runDocker(args: string[], timeout: number): Promise<string> {
    return new Promise((resolve, reject) => {
        execFile(
            DOCKER_PATH,
            args,
            { encoding: 'utf8', timeout, maxBuffer: 1024 * 1024 },
            (error, stdout, stderr) => {
                if (!error) {
                    resolve(stdout);
                    return;
                }
                const detail = (stderr || stdout || error.message).trim();
                reject(new Error(detail || error.message, { cause: error }));
            },
        );
    });
}

function waitForRetry(delayMs: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, delayMs));
}

async function removeStoppedContainer(containerId: string): Promise<{ success: boolean; error?: string }> {
    try {
        await runDocker(['rm', '-f', containerId], 10000);
        return { success: true };
    } catch (error) {
        const message = (error as Error).message;
        if (message.includes('No such container') || message.includes('No such object')) {
            return { success: true };
        }
        return { success: false, error: message };
    }
}

async function forceRemoveContainer(containerId: string): Promise<{ success: boolean; error?: string }> {
    try {
        await runDocker(['kill', containerId], 10000);
        const removed = await removeStoppedContainer(containerId);
        if (removed.success) logger.info({ containerId }, 'Docker container force killed and removed');
        else logger.error({ containerId, error: removed.error }, 'Docker container was killed but could not be removed');
        return removed;
    } catch (killError) {
        const message = (killError as Error).message;
        if (message.includes('No such container')) {
            logger.info({ containerId }, 'Container already removed');
            return { success: true };
        }
        if (message.includes('is not running')) {
            const removed = await removeStoppedContainer(containerId);
            if (removed.success) logger.info({ containerId }, 'Removed container that stopped during termination');
            return removed;
        }
        logger.error({ containerId, error: message }, 'Failed to force kill Docker container');
        return { success: false, error: message };
    }
}

export interface DockerExecutionTeardownOptions {
    taskId?: string;
    attemptGeneration?: string;
    containerId?: string | null;
    containerName?: string | null;
    attempts?: number;
    retryDelayMs?: number;
    deadlineMs?: number;
}

async function findExecutionContainers(
    options: DockerExecutionTeardownOptions,
    timeoutMs: number,
): Promise<Set<string> | null> {
    const containers = new Set<string>();
    if (options.taskId && options.attemptGeneration) {
        try {
            const output = await runDocker([
                'ps', '-aq',
                '--filter', `label=propr.task.id=${options.taskId}`,
                '--filter', `label=propr.task.attempt-generation=${options.attemptGeneration}`,
            ], timeoutMs);
            for (const id of output.split('\n').map(value => value.trim()).filter(Boolean)) {
                containers.add(id);
            }
            return containers;
        } catch (error) {
            logger.debug({
                taskId: options.taskId,
                attemptGeneration: options.attemptGeneration,
                error: (error as Error).message,
            }, 'Could not inspect Docker containers while closing an aborted execution');
            return null;
        }
    }
    if (options.containerId) containers.add(options.containerId);
    if (options.containerName) containers.add(options.containerName);
    return containers;
}

async function removeExecutionContainers(containers: Set<string>, deadline: number): Promise<void> {
    for (const container of containers) {
        if (!CONTAINER_IDENTIFIER_PATTERN.test(container)) continue;
        const removalBudgetMs = Math.min(2000, deadline - Date.now());
        if (removalBudgetMs <= 0) break;
        try {
            await runDocker(['rm', '-f', container], removalBudgetMs);
        } catch (error) {
            const message = (error as Error).message;
            if (!message.includes('No such container') && !message.includes('No such object')) {
                logger.warn({ containerId: container, error: message }, 'Failed to remove Docker container after execution ownership loss');
            }
        }
    }
}

/**
 * Removes every container belonging to an aborted execution, retrying long
 * enough to cover the window in which `docker run` has reached the daemon but
 * the container has not appeared in `docker ps` yet.
 */
export async function teardownDockerExecution(
    options: DockerExecutionTeardownOptions,
): Promise<void> {
    const attempts = Math.max(1, Math.min(20, options.attempts ?? DEFAULT_CREATION_RACE_ATTEMPTS));
    const retryDelayMs = Math.max(0, Math.min(1000, options.retryDelayMs ?? DEFAULT_CREATION_RACE_RETRY_MS));
    const deadlineMs = Math.max(100, Math.min(
        MAX_TEARDOWN_DEADLINE_MS,
        options.deadlineMs ?? DEFAULT_TEARDOWN_DEADLINE_MS,
    ));
    const deadline = Date.now() + deadlineMs;
    const hasGenerationFence = Boolean(options.taskId && options.attemptGeneration);
    if (!hasGenerationFence && !options.containerId && !options.containerName) return;

    for (let attempt = 0; attempt < attempts; attempt++) {
        const inspectionBudgetMs = Math.min(1000, deadline - Date.now());
        if (inspectionBudgetMs <= 0) break;
        const containers = await findExecutionContainers(options, inspectionBudgetMs);
        // Retrying a failed daemon query only multiplies the abort delay.
        if (!containers) break;
        await removeExecutionContainers(containers, deadline);
        // A retry is useful only while the generation-labelled container may
        // still be racing with creation. Once discovered, teardown is done.
        if (containers.size > 0) break;

        if (attempt + 1 < attempts && retryDelayMs > 0) {
            const remainingMs = deadline - Date.now();
            if (remainingMs <= 0) break;
            await waitForRetry(Math.min(retryDelayMs, remainingMs));
        }
    }
}

/** Gracefully stops a Docker container, then force-kills it when necessary. */
export async function stopDockerContainer(
    containerId: string,
    timeoutSeconds: number = 10,
): Promise<{ success: boolean; error?: string }> {
    const validationError = validateStopRequest(containerId, timeoutSeconds);
    if (validationError) return { success: false, error: validationError };

    logger.info({ containerId, timeoutSeconds }, 'Attempting to stop Docker container');
    try {
        let statusOutput: string | undefined;
        try {
            statusOutput = (await runDocker([
                'inspect', '--type', 'container', '--format', '{{.State.Status}}', containerId,
            ], 5000)).trim();
        } catch (checkError) {
            if ((checkError as Error).message.includes('No such')) {
                logger.info({ containerId }, 'Container no longer exists');
                return { success: true };
            }
            logger.debug({ containerId, error: (checkError as Error).message }, 'Could not check container status, attempting stop anyway');
        }
        // Restarting and paused containers are still live resources. Remove
        // terminal/non-started containers so deterministic names are reusable.
        if (statusOutput && /^(exited|dead|created)$/iu.test(statusOutput)) {
            const removed = await removeStoppedContainer(containerId);
            if (removed.success) {
                logger.info({ containerId, status: statusOutput }, 'Removed abandoned non-running container');
                return { success: true };
            }
            logger.error({ containerId, status: statusOutput, error: removed.error }, 'Failed to remove abandoned non-running container');
            return removed;
        }

        try {
            await runDocker(
                ['stop', '-t', String(timeoutSeconds), containerId],
                (timeoutSeconds + 5) * 1000,
            );
            const removed = await removeStoppedContainer(containerId);
            if (removed.success) logger.info({ containerId }, 'Docker container stopped and removed gracefully');
            else logger.error({ containerId, error: removed.error }, 'Docker container stopped but could not be removed');
            return removed;
        } catch (stopError) {
            logger.warn({ containerId, error: (stopError as Error).message }, 'Graceful stop failed, attempting force kill');
            return await forceRemoveContainer(containerId);
        }
    } catch (error) {
        const message = (error as Error).message;
        logger.error({ containerId, error: message }, 'Error stopping Docker container');
        return { success: false, error: message };
    }
}
