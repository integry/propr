import type { Logger } from 'pino';
import path from 'path';
import fs from 'fs-extra';
import { AttachmentService } from '@gitfix/core';

/**
 * Extracts a map of original image URLs to their signed versions from HTML content.
 * GitHub's body_html contains <img> tags with signed URLs that include JWT tokens.
 *
 * @param bodyHtml - The HTML content from GitHub API (body_html field)
 * @returns A map from asset ID to signed URL
 */
function extractSignedImageUrls(bodyHtml: string): Map<string, string> {
    const signedUrls = new Map<string, string>();
    if (!bodyHtml) return signedUrls;

    // Match <img> tags and extract src attribute
    // GitHub user-attachments in HTML look like: <img src="https://private-user-images.githubusercontent.com/...?jwt=...">
    const imgRegex = /<img[^>]+src=["']([^"']+)["'][^>]*>/gi;
    const matches = [...bodyHtml.matchAll(imgRegex)];

    for (const match of matches) {
        const signedUrl = match[1];
        // Extract the asset ID from the URL path (the UUID part)
        // URLs look like: https://private-user-images.githubusercontent.com/829273/530851717-da68c2cf-1ec4-4eca-a27f-1172e36c62ad.png?jwt=...
        // We want to extract: da68c2cf-1ec4-4eca-a27f-1172e36c62ad
        const assetIdMatch = signedUrl.match(/([a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})/i);
        if (assetIdMatch) {
            signedUrls.set(assetIdMatch[1].toLowerCase(), signedUrl);
        }
    }

    return signedUrls;
}

/**
 * Gets a signed URL for a GitHub user-attachment if available.
 *
 * @param url - The original image URL
 * @param signedUrls - Map of asset IDs to signed URLs
 * @param logger - Logger for debugging
 * @returns The signed URL if found, otherwise the original URL
 */
function getSignedUrlIfAvailable(url: string, signedUrls: Map<string, string>, logger: Logger): string {
    // For GitHub user-attachments, try to find a signed URL
    if (url.includes('github.com/user-attachments/assets/') || url.includes('private-user-images.githubusercontent.com')) {
        // Extract asset ID from the URL
        const assetIdMatch = url.match(/([a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})/i);
        if (assetIdMatch) {
            const signedUrl = signedUrls.get(assetIdMatch[1].toLowerCase());
            if (signedUrl) {
                logger.debug({ originalUrl: url, signedUrl }, 'Using signed URL for GitHub user-attachment');
                return signedUrl;
            } else {
                logger.warn({ url, assetId: assetIdMatch[1] }, 'No signed URL found for GitHub user-attachment');
            }
        }
    }
    return url;
}

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
 * @param bodyHtml - Optional HTML content from GitHub API with signed image URLs
 * @param issueOrPrId - Optional issue or PR number for organizing assets in subdirectories (for cleanup when closed/merged)
 * @returns The content with remote image URLs replaced with local relative paths
 */
export async function localizeContentImages(content: string, worktreeRoot: string, logger: Logger, bodyHtml?: string, issueOrPrId?: number): Promise<string> {
    if (!content) return content;

    // Store assets in a subdirectory identified by issue/PR ID for easy cleanup when closed/merged
    const assetsDir = issueOrPrId
        ? path.join(worktreeRoot, '.gitfix', 'assets', String(issueOrPrId))
        : path.join(worktreeRoot, '.gitfix', 'assets');
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

    // Extract signed URLs from HTML for GitHub user-attachments
    const signedUrls = extractSignedImageUrls(bodyHtml || '');
    logger.debug({ signedUrlCount: signedUrls.size }, 'Extracted signed URLs from body_html');

    // Process markdown images
    for (const match of markdownMatches) {
        const [fullMatch, alt, url] = match;
        try {
            const downloadUrl = getSignedUrlIfAvailable(url, signedUrls, logger);

            // Download using signed URL (no auth needed) or original URL
            const localPath = await AttachmentService.downloadRemoteImage(downloadUrl, assetsDir, logger);
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
            const downloadUrl = getSignedUrlIfAvailable(url, signedUrls, logger);

            const localPath = await AttachmentService.downloadRemoteImage(downloadUrl, assetsDir, logger);
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

/**
 * Cleans up cached assets for a specific issue or PR.
 * Should be called when a PR is merged/closed or an issue is closed.
 *
 * @param worktreeRoot - The root path of the worktree containing assets
 * @param issueOrPrId - The issue or PR number whose assets should be removed
 * @param logger - Logger instance for debugging/warnings
 */
export async function cleanupIssueAssets(worktreeRoot: string, issueOrPrId: number, logger: Logger): Promise<void> {
    const assetsDir = path.join(worktreeRoot, '.gitfix', 'assets', String(issueOrPrId));

    try {
        const exists = await fs.pathExists(assetsDir);
        if (exists) {
            await fs.remove(assetsDir);
            logger.info({ issueOrPrId, assetsDir }, 'Successfully cleaned up cached assets for issue/PR');
        } else {
            logger.debug({ issueOrPrId, assetsDir }, 'No cached assets found for issue/PR');
        }
    } catch (e) {
        logger.warn({ issueOrPrId, assetsDir, error: (e as Error).message }, 'Failed to clean up cached assets');
    }
}
