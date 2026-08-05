import { execFile } from 'node:child_process';
import logger from '../../utils/logger.js';

const DOCKER_PATH = '/usr/bin/docker';
const CONTAINER_IDENTIFIER_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/;
const MAX_STOP_TIMEOUT_SECONDS = 300;

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
