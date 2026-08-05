import { execFile } from 'node:child_process';
import logger from '../../utils/logger.js';

const DOCKER_PATH = '/usr/bin/docker';
const CONTAINER_IDENTIFIER_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/;
const MAX_STOP_TIMEOUT_SECONDS = 300;
const DEFAULT_CREATION_RACE_ATTEMPTS = 10;
const DEFAULT_CREATION_RACE_RETRY_MS = 250;

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

export interface DockerExecutionTeardownOptions {
    taskId?: string;
    attemptGeneration?: string;
    containerId?: string | null;
    containerName?: string | null;
    attempts?: number;
    retryDelayMs?: number;
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
    const hasGenerationFence = Boolean(options.taskId && options.attemptGeneration);
    if (!hasGenerationFence && !options.containerId && !options.containerName) return;

    for (let attempt = 0; attempt < attempts; attempt++) {
        const containers = new Set<string>();
        if (hasGenerationFence) {
            try {
                const output = await runDocker([
                    'ps', '-aq',
                    '--filter', `label=propr.task.id=${options.taskId}`,
                    '--filter', `label=propr.task.attempt-generation=${options.attemptGeneration}`,
                ], 5000);
                for (const id of output.split('\n').map(value => value.trim()).filter(Boolean)) {
                    containers.add(id);
                }
            } catch (error) {
                logger.debug({
                    taskId: options.taskId,
                    attemptGeneration: options.attemptGeneration,
                    error: (error as Error).message,
                }, 'Could not inspect Docker containers while closing an aborted execution');
            }
        } else {
            if (options.containerId) containers.add(options.containerId);
            if (options.containerName) containers.add(options.containerName);
        }

        for (const container of containers) {
            if (!CONTAINER_IDENTIFIER_PATTERN.test(container)) continue;
            try {
                await runDocker(['rm', '-f', container], 10000);
            } catch (error) {
                const message = (error as Error).message;
                if (!message.includes('No such container') && !message.includes('No such object')) {
                    logger.warn({ containerId: container, error: message }, 'Failed to remove Docker container after execution ownership loss');
                }
            }
        }

        if (attempt + 1 < attempts && retryDelayMs > 0) await waitForRetry(retryDelayMs);
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
        try {
            const statusOutput = (await runDocker([
                'inspect', '--type', 'container', '--format', '{{.State.Status}}', containerId,
            ], 5000)).trim();
            // Restarting and paused containers are still live resources. Only
            // Docker's known terminal/non-started states can skip termination.
            if (/^(exited|dead|created)$/iu.test(statusOutput)) {
                logger.info({ containerId, status: statusOutput }, 'Container is already stopped');
                return { success: true };
            }
        } catch (checkError) {
            if ((checkError as Error).message.includes('No such')) {
                logger.info({ containerId }, 'Container no longer exists');
                return { success: true };
            }
            logger.debug({ containerId, error: (checkError as Error).message }, 'Could not check container status, attempting stop anyway');
        }

        try {
            await runDocker(
                ['stop', '-t', String(timeoutSeconds), containerId],
                (timeoutSeconds + 5) * 1000,
            );
            logger.info({ containerId }, 'Docker container stopped gracefully');
            return { success: true };
        } catch (stopError) {
            logger.warn({ containerId, error: (stopError as Error).message }, 'Graceful stop failed, attempting force kill');
            try {
                await runDocker(['kill', containerId], 10000);
                logger.info({ containerId }, 'Docker container force killed');
                return { success: true };
            } catch (killError) {
                const message = (killError as Error).message;
                if (message.includes('No such container') || message.includes('is not running')) {
                    logger.info({ containerId }, 'Container already stopped or removed');
                    return { success: true };
                }
                logger.error({ containerId, error: message }, 'Failed to force kill Docker container');
                return { success: false, error: message };
            }
        }
    } catch (error) {
        const message = (error as Error).message;
        logger.error({ containerId, error: message }, 'Error stopping Docker container');
        return { success: false, error: message };
    }
}
