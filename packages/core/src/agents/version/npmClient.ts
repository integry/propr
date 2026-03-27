/**
 * NPM Registry API client for fetching package version information.
 */

import logger from '../../utils/logger.js';
import type { NpmPackageInfo } from './types.js';

const NPM_REGISTRY_URL = 'https://registry.npmjs.org';

// Cache for NPM responses (5 minute TTL)
const npmCache = new Map<string, { data: NpmPackageInfo; expiry: number }>();
const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

/**
 * Fetches package info from the NPM registry.
 * Results are cached for 5 minutes.
 *
 * @param packageName - The NPM package name (e.g., '@anthropic-ai/claude-code')
 * @returns Package info including versions and dist-tags
 */
export async function fetchNpmPackageInfo(packageName: string): Promise<NpmPackageInfo> {
    const now = Date.now();

    // Check cache
    const cached = npmCache.get(packageName);
    if (cached && cached.expiry > now) {
        logger.debug({ packageName }, 'Using cached NPM package info');
        return cached.data;
    }

    // Fetch from registry
    const encodedName = encodeURIComponent(packageName).replace('%40', '@');
    const url = `${NPM_REGISTRY_URL}/${encodedName}`;

    logger.debug({ packageName, url }, 'Fetching NPM package info');

    try {
        const response = await fetch(url, {
            headers: {
                'Accept': 'application/json'
            }
        });

        if (!response.ok) {
            throw new Error(`NPM registry returned ${response.status}: ${response.statusText}`);
        }

        const data = await response.json() as NpmPackageInfo;

        // Cache the result
        npmCache.set(packageName, {
            data,
            expiry: now + CACHE_TTL_MS
        });

        logger.info({
            packageName,
            versionCount: Object.keys(data.versions || {}).length,
            distTags: Object.keys(data['dist-tags'] || {})
        }, 'Fetched NPM package info');

        return data;
    } catch (error) {
        const err = error as Error;
        logger.error({ packageName, error: err.message }, 'Failed to fetch NPM package info');
        throw error;
    }
}

/**
 * Gets the dist-tags for a package (e.g., latest, stable, next).
 *
 * @param packageName - The NPM package name
 * @returns Map of tag name to version
 */
export async function getDistTags(packageName: string): Promise<Record<string, string>> {
    const info = await fetchNpmPackageInfo(packageName);
    return info['dist-tags'] || {};
}

/**
 * Gets the most recent versions of a package, sorted by publish date.
 *
 * @param packageName - The NPM package name
 * @param count - Number of recent versions to return (default: 10)
 * @returns Array of version info sorted by publish date (newest first)
 */
export async function getRecentVersions(
    packageName: string,
    count: number = 10
): Promise<Array<{ version: string; publishedAt: string }>> {
    const info = await fetchNpmPackageInfo(packageName);

    const time = info.time || {};
    const versions = Object.keys(info.versions || {});

    // Filter out special entries in time (like 'created', 'modified')
    const versionTimes = versions
        .filter(v => time[v])
        .map(version => ({
            version,
            publishedAt: time[version]
        }))
        .sort((a, b) => new Date(b.publishedAt).getTime() - new Date(a.publishedAt).getTime())
        .slice(0, count);

    return versionTimes;
}

/**
 * Resolves a version spec (tag or version number) to an actual semver version.
 *
 * @param packageName - The NPM package name
 * @param versionSpec - A dist-tag (like 'latest') or a semver version
 * @returns The resolved semver version
 */
export async function resolveVersionSpec(
    packageName: string,
    versionSpec: string
): Promise<string> {
    const info = await fetchNpmPackageInfo(packageName);

    // Check if it's a dist-tag
    const distTags = info['dist-tags'] || {};
    if (distTags[versionSpec]) {
        logger.debug({ packageName, versionSpec, resolved: distTags[versionSpec] }, 'Resolved dist-tag to version');
        return distTags[versionSpec];
    }

    // Check if it's a valid version
    const versions = info.versions || {};
    if (versions[versionSpec]) {
        return versionSpec;
    }

    throw new Error(`Version '${versionSpec}' not found for package '${packageName}'`);
}

/**
 * Clears the NPM cache. Useful for testing or forcing a refresh.
 */
export function clearNpmCache(): void {
    npmCache.clear();
    logger.debug('Cleared NPM cache');
}
