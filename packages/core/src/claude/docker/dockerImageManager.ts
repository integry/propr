import logger from '../../utils/logger.js';
import { executeDockerCommand } from './dockerExecutor.js';
import { AGENT_IMAGE_NAME } from '../../agents/version/types.js';


/**
 * Lists all unified agent Docker image tags.
 *
 * @returns Array of image tags (e.g., ['2.1.77-a3f2b1', '2.1.76-b4c3d2'])
 */
export async function listAgentImages(): Promise<string[]> {
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
        logger.warn({ error: (error as Error).message }, 'Failed to list agent images');
        return [];
    }
}

/**
 * Cleans up unused unified agent Docker images.
 * Keeps images that are currently in use by agent configs and the default version.
 *
 * @param tagsInUse - Set of image tags currently in use (optional, will be fetched if not provided)
 * @returns Number of images deleted
 */
export async function cleanupUnusedAgentImages(
    tagsInUse?: Set<string>
): Promise<number> {
    try {
        // Get all image tags for this agent
        const allTags = await listAgentImages();

        if (allTags.length === 0) {
            return 0;
        }

        // If versionsInUse not provided, don't delete anything (safe default)
        if (!tagsInUse || tagsInUse.size === 0) {
            logger.debug('No versions specified to keep, skipping cleanup');
            return 0;
        }

        // Always keep 'latest' tag
        const tagsToKeep = new Set(tagsInUse);
        tagsToKeep.add('latest');

        let deletedCount = 0;

        for (const tag of allTags) {
            if (tagsToKeep.has(tag)) {
                continue;
            }

            // Delete the image
            const fullImageName = `${AGENT_IMAGE_NAME}:${tag}`;
            logger.info({ imageTag: fullImageName }, 'Deleting unused agent Docker image');

            try {
                await executeDockerCommand('docker', ['rmi', fullImageName]);
                deletedCount++;
                logger.info({ imageTag: fullImageName }, 'Deleted unused agent Docker image');
            } catch (deleteError) {
                // Image might be in use by a container, skip
                logger.debug({
                    imageTag: fullImageName,
                    error: (deleteError as Error).message
                }, 'Could not delete image (may be in use)');
            }
        }

        logger.info({ deletedCount }, 'Cleanup completed');
        return deletedCount;

    } catch (error) {
        logger.error({ error: (error as Error).message }, 'Failed to cleanup unused agent images');
        return 0;
    }
}
