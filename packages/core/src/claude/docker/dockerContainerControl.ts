import { execSync } from 'node:child_process';
import logger from '../../utils/logger.js';

/** Gracefully stops a Docker container, then force-kills it when necessary. */
export async function stopDockerContainer(
    containerId: string,
    timeoutSeconds: number = 10,
): Promise<{ success: boolean; error?: string }> {
    if (!containerId) return { success: false, error: 'No container ID provided' };

    logger.info({ containerId, timeoutSeconds }, 'Attempting to stop Docker container');
    try {
        try {
            const statusOutput = execSync(
                `/usr/bin/docker ps -a --filter "id=${containerId}" --format "{{.Status}}"`,
                { encoding: 'utf8', timeout: 5000 },
            ).trim();
            if (!statusOutput) {
                logger.info({ containerId }, 'Container no longer exists');
                return { success: true };
            }
            if (!statusOutput.includes('Up')) {
                logger.info({ containerId, status: statusOutput }, 'Container is already stopped');
                return { success: true };
            }
        } catch (checkError) {
            logger.debug({ containerId, error: (checkError as Error).message }, 'Could not check container status, attempting stop anyway');
        }

        try {
            execSync(`/usr/bin/docker stop -t ${timeoutSeconds} ${containerId}`, {
                encoding: 'utf8',
                timeout: (timeoutSeconds + 5) * 1000,
            });
            logger.info({ containerId }, 'Docker container stopped gracefully');
            return { success: true };
        } catch (stopError) {
            logger.warn({ containerId, error: (stopError as Error).message }, 'Graceful stop failed, attempting force kill');
            try {
                execSync(`/usr/bin/docker kill ${containerId}`, {
                    encoding: 'utf8',
                    timeout: 10000,
                });
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
