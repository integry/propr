import logger from '../../utils/logger.js';
import { executeDockerCommand } from './dockerExecutor.js';
import { AGENT_IMAGE_NAME } from '../../agents/version/types.js';


/**
 * Lists all Docker images for a specific agent type.
 *
 * @param agentType - The agent type
 * @returns Array of image tags (e.g., ['2.1.77-a3f2b1', '2.1.76-b4c3d2'])
 */
export async function listAgentImages(agentType: string): Promise<string[]> {
    try {
        const result = await executeDockerCommand('docker', [
            'images', AGENT_IMAGE_NAME, '--format', '{{.Tag}}'
        ]);

        const tags = result.stdout
            .trim()
            .split('\n')
            .filter(tag => tag && tag !== '<none>');

        return tags;
    } catch (error) {
        logger.warn({ agentType, error: (error as Error).message }, 'Failed to list agent images');
        return [];
    }
}

/**
 * Cleans up unused Docker images for an agent type.
 * Keeps images that are currently in use by agent configs and the default version.
 *
 * @param agentType - The agent type
 * @param versionsInUse - Set of version strings currently in use (optional, will be fetched if not provided)
 * @returns Number of images deleted
 */
export async function cleanupUnusedAgentImages(
    agentType: string,
    tagsInUse?: Set<string>
): Promise<number> {
    try {
        // Get all image tags for this agent
        const allTags = await listAgentImages(agentType);

        if (allTags.length === 0) {
            return 0;
        }

        // If versionsInUse not provided, don't delete anything (safe default)
        if (!tagsInUse || tagsInUse.size === 0) {
            logger.debug({ agentType }, 'No versions specified to keep, skipping cleanup');
            return 0;
        }

        // Always keep 'latest' tag
        tagsInUse.add('latest');

        let deletedCount = 0;

        for (const tag of allTags) {
            if (tagsInUse.has(tag)) {
                continue;
            }

            // Delete the image
            const fullImageName = `${AGENT_IMAGE_NAME}:${tag}`;
            logger.info({ agentType, imageTag: fullImageName }, 'Deleting unused agent Docker image');

            try {
                await executeDockerCommand('docker', ['rmi', fullImageName]);
                deletedCount++;
                logger.info({ agentType, imageTag: fullImageName }, 'Deleted unused agent Docker image');
            } catch (deleteError) {
                // Image might be in use by a container, skip
                logger.debug({
                    agentType,
                    imageTag: fullImageName,
                    error: (deleteError as Error).message
                }, 'Could not delete image (may be in use)');
            }
        }

        logger.info({ agentType, deletedCount }, 'Cleanup completed');
        return deletedCount;

    } catch (error) {
        logger.error({ agentType, error: (error as Error).message }, 'Failed to cleanup unused agent images');
        return 0;
    }
}
