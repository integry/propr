import type { Logger } from 'pino';
import path from 'path';
import fs from 'fs-extra';
import { AttachmentService } from '@gitfix/core';

/**
 * Parses markdown/HTML content for remote image URLs, downloads them to the local worktree,
 * and replaces the URLs with relative local paths.
 *
 * This allows the AI agent to process images even in restricted network environments.
 * If an image fails to download, the original remote URL is preserved.
 *
 * Supports both:
 * - Markdown image syntax: ![alt text](url)
 * - HTML img tags: <img src="url" ... />
 *
 * @param content - The markdown/HTML content containing image references
 * @param worktreeRoot - The root path of the worktree to save images to
 * @param logger - Logger instance for debugging/warnings
 * @param authToken - Optional authentication token for GitHub URLs
 * @returns The content with remote image URLs replaced with local relative paths
 */
export async function localizeContentImages(content: string, worktreeRoot: string, logger: Logger, authToken?: string): Promise<string> {
    if (!content) return content;

    const assetsDir = path.join(worktreeRoot, '.gitfix', 'assets');
    let newContent = content;

    // Match markdown image syntax: ![alt text](url)
    // Only matches http:// and https:// URLs
    const markdownImageRegex = /!\[(.*?)\]\((https?:\/\/[^)]+)\)/g;
    const markdownMatches = [...content.matchAll(markdownImageRegex)];

    // Match HTML img tags: <img ... src="url" ... />
    // Captures the full tag and the src URL
    const htmlImageRegex = /<img\s+[^>]*src=["'](https?:\/\/[^"']+)["'][^>]*\/?>/gi;
    const htmlMatches = [...content.matchAll(htmlImageRegex)];

    if (markdownMatches.length === 0 && htmlMatches.length === 0) return content;

    await fs.ensureDir(assetsDir);

    // Process markdown images
    for (const match of markdownMatches) {
        const [fullMatch, alt, url] = match;
        try {
            const localPath = await AttachmentService.downloadRemoteImage(url, assetsDir, logger, authToken);
            const relativePath = path.relative(worktreeRoot, localPath);
            // Replace only this specific occurrence by reconstructing the image syntax
            const newImageSyntax = `![${alt}](${relativePath})`;
            newContent = newContent.replace(fullMatch, newImageSyntax);
            logger.info({ url, localPath: relativePath }, 'Successfully localized remote markdown image');
        } catch (e) {
            // If download fails, keep the original URL
            logger.warn({ url, error: (e as Error).message }, 'Failed to localize markdown image, keeping remote URL');
        }
    }

    // Process HTML img tags
    for (const match of htmlMatches) {
        const [fullMatch, url] = match;
        try {
            const localPath = await AttachmentService.downloadRemoteImage(url, assetsDir, logger, authToken);
            const relativePath = path.relative(worktreeRoot, localPath);
            // Replace the src URL in the img tag while preserving other attributes
            const newImgTag = fullMatch.replace(url, relativePath);
            newContent = newContent.replace(fullMatch, newImgTag);
            logger.info({ url, localPath: relativePath }, 'Successfully localized remote HTML image');
        } catch (e) {
            // If download fails, keep the original URL
            logger.warn({ url, error: (e as Error).message }, 'Failed to localize HTML image, keeping remote URL');
        }
    }

    return newContent;
}
