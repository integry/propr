import type { Logger } from 'pino';
import path from 'path';
import fs from 'fs-extra';
import { AttachmentService } from '@gitfix/core';

/**
 * Parses markdown content for remote image URLs, downloads them to the local worktree,
 * and replaces the URLs with relative local paths.
 *
 * This allows the AI agent to process images even in restricted network environments.
 * If an image fails to download, the original remote URL is preserved.
 *
 * @param content - The markdown content containing image references
 * @param worktreeRoot - The root path of the worktree to save images to
 * @param logger - Logger instance for debugging/warnings
 * @param authToken - Optional authentication token for GitHub URLs
 * @returns The content with remote image URLs replaced with local relative paths
 */
export async function localizeContentImages(content: string, worktreeRoot: string, logger: Logger, authToken?: string): Promise<string> {
    if (!content) return content;

    // Match markdown image syntax: ![alt text](url)
    // Only matches http:// and https:// URLs
    const imageRegex = /!\[(.*?)\]\((https?:\/\/[^)]+)\)/g;
    const matches = [...content.matchAll(imageRegex)];

    if (matches.length === 0) return content;

    const assetsDir = path.join(worktreeRoot, '.gitfix', 'assets');
    await fs.ensureDir(assetsDir);

    let newContent = content;

    for (const match of matches) {
        const [fullMatch, alt, url] = match;
        try {
            const localPath = await AttachmentService.downloadRemoteImage(url, assetsDir, logger, authToken);
            const relativePath = path.relative(worktreeRoot, localPath);
            // Replace only this specific occurrence by reconstructing the image syntax
            const newImageSyntax = `![${alt}](${relativePath})`;
            newContent = newContent.replace(fullMatch, newImageSyntax);
            logger.info({ url, localPath: relativePath }, 'Successfully localized remote image');
        } catch (e) {
            // If download fails, keep the original URL
            logger.warn({ url, error: (e as Error).message }, 'Failed to localize image, keeping remote URL');
        }
    }

    return newContent;
}
