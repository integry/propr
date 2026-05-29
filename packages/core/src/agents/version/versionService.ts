/**
 * Version service for managing agent CLI versions.
 * Handles version resolution, content hashing, and available versions retrieval.
 */

import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import logger from '../../utils/logger.js';
import type { AgentType } from '../types.js';
import type { AvailableVersionsResponse, CliVersionType } from './types.js';
import {
    AGENT_NPM_PACKAGES,
    AGENT_NPM_TAGS,
    AGENT_DEFAULT_VERSIONS,
    AGENT_IMAGE_NAMES,
    DOCKER_CONTENT_FILES
} from './types.js';
import {
    getDistTags,
    getRecentVersions,
    resolveVersionSpec
} from './npmClient.js';
import {
    getLatestPyPiVersion,
    getRecentPyPiVersions,
    resolvePyPiVersionSpec
} from './pypiClient.js';

const PYPI_AGENT_TYPES = new Set<AgentType>(['vibe']);

/**
 * Resolves a version specification to an actual semver version.
 *
 * @param agentType - The agent type (claude, codex, gemini)
 * @param versionType - How the version is specified
 * @param versionSpec - The version specification (tag name, version number, or custom input)
 * @returns The resolved semver version
 */
export async function resolveVersion(
    agentType: AgentType,
    versionType: CliVersionType,
    versionSpec?: string
): Promise<string> {
    const packageName = AGENT_NPM_PACKAGES[agentType];

    if (PYPI_AGENT_TYPES.has(agentType)) {
        switch (versionType) {
            case 'default':
                return AGENT_DEFAULT_VERSIONS[agentType];
            case 'tag':
                if (!versionSpec) {
                    throw new Error('Version spec required for tag type');
                }
                if (!AGENT_NPM_TAGS[agentType].includes(versionSpec)) {
                    throw new Error(`Unknown tag '${versionSpec}' for PyPI-backed package ${packageName}`);
                }
                return resolvePyPiVersionSpec(packageName, versionSpec);
            case 'specific':
                if (!versionSpec) {
                    throw new Error('Version spec required');
                }
                return resolvePyPiVersionSpec(packageName, versionSpec);
            case 'custom':
                if (!versionSpec) {
                    throw new Error('Version spec required');
                }
                return versionSpec.trim();
            default:
                logger.warn({ agentType, versionType }, 'Unknown version type, using default');
                return AGENT_DEFAULT_VERSIONS[agentType];
        }
    }

    switch (versionType) {
        case 'default':
            return AGENT_DEFAULT_VERSIONS[agentType];

        case 'tag':
            if (!versionSpec) {
                throw new Error('Version spec required for tag type');
            }
            return resolveVersionSpec(packageName, versionSpec);

        case 'specific':
        case 'custom':
            if (!versionSpec) {
                throw new Error('Version spec required');
            }
            // For specific/custom, try to resolve (validates it exists)
            return resolveVersionSpec(packageName, versionSpec);

        default:
            logger.warn({ agentType, versionType }, 'Unknown version type, using default');
            return AGENT_DEFAULT_VERSIONS[agentType];
    }
}

/**
 * Gets all available versions for an agent type.
 * Returns tags with their resolved versions and recent specific versions.
 *
 * @param agentType - The agent type
 * @returns Available versions response
 */
export async function getAvailableVersions(agentType: AgentType): Promise<AvailableVersionsResponse> {
    const packageName = AGENT_NPM_PACKAGES[agentType];
    const defaultVersion = AGENT_DEFAULT_VERSIONS[agentType];
    const tagNames = AGENT_NPM_TAGS[agentType];

    try {
        if (PYPI_AGENT_TYPES.has(agentType)) {
            const [latestVersion, recentVersions] = await Promise.all([
                getLatestPyPiVersion(packageName),
                getRecentPyPiVersions(packageName, 10)
            ]);

            return {
                agentType,
                packageName,
                defaultVersion,
                availableTags: tagNames.map(tag => ({
                    tag,
                    version: tag === 'latest' ? latestVersion : defaultVersion
                })),
                recentVersions
            };
        }

        // Fetch tags and recent versions in parallel
        const [distTags, recentVersions] = await Promise.all([
            getDistTags(packageName),
            getRecentVersions(packageName, 10)
        ]);

        // Map tag names to their versions
        const availableTags = tagNames
            .filter(tag => distTags[tag])
            .map(tag => ({
                tag,
                version: distTags[tag]
            }));

        return {
            agentType,
            packageName,
            defaultVersion,
            availableTags,
            recentVersions
        };
    } catch (error) {
        const err = error as Error;
        logger.error({ agentType, packageName, error: err.message }, 'Failed to get available versions');

        // Return minimal response with just defaults on error
        return {
            agentType,
            packageName,
            defaultVersion,
            availableTags: [],
            recentVersions: []
        };
    }
}

// Default project root - can be overridden via environment variable
// In Docker container, the app root is /usr/src/app but cwd may be /usr/src/app/packages/api
const PROJECT_ROOT = process.env.PROPR_ROOT || '/usr/src/app';

/**
 * Computes a content hash for the Docker build files of an agent.
 * This hash changes when any of the Dockerfile or script files change.
 *
 * @param agentType - The agent type
 * @param basePath - Base path where Dockerfiles are located (defaults to project root)
 * @returns First 6 characters of SHA256 hash
 */
export function computeContentHash(agentType: AgentType, basePath: string = PROJECT_ROOT): string {
    const files = DOCKER_CONTENT_FILES[agentType];
    const hash = crypto.createHash('sha256');

    for (const file of files) {
        const filePath = path.join(basePath, file);
        try {
            if (fs.existsSync(filePath)) {
                const content = fs.readFileSync(filePath, 'utf-8');
                hash.update(content);
            } else {
                logger.warn({ agentType, file }, 'Docker content file not found, skipping in hash');
            }
        } catch (error) {
            const err = error as Error;
            logger.warn({ agentType, file, error: err.message }, 'Failed to read Docker content file');
        }
    }

    const fullHash = hash.digest('hex');
    return fullHash.substring(0, 6);
}

/**
 * Generates the Docker image tag for a specific version and content hash.
 *
 * @param agentType - The agent type
 * @param cliVersion - The CLI version
 * @param contentHash - The content hash (6 chars)
 * @returns Docker image tag (e.g., 'propr-claude:2.1.77-a3f2b1')
 */
export function generateImageTag(agentType: AgentType, cliVersion: string, contentHash: string): string {
    const imageName = AGENT_IMAGE_NAMES[agentType];
    return `${imageName}:${cliVersion}-${contentHash}`;
}

/**
 * Gets the effective CLI version for an agent configuration.
 * Returns the resolved version if available, otherwise resolves it.
 *
 * @param agentType - The agent type
 * @param cliVersionType - The version type from config
 * @param cliVersion - The version spec from config
 * @param cliVersionResolved - The previously resolved version from config
 * @returns The effective CLI version to use
 */
export async function getEffectiveCliVersion(
    agentType: AgentType,
    cliVersionType?: CliVersionType,
    cliVersion?: string,
    cliVersionResolved?: string
): Promise<string> {
    // If already resolved, use that
    if (cliVersionResolved) {
        return cliVersionResolved;
    }

    // Resolve based on type
    const effectiveType = cliVersionType || 'default';
    return resolveVersion(agentType, effectiveType, cliVersion);
}

// Re-export types and constants for convenience
export {
    AGENT_NPM_PACKAGES,
    AGENT_NPM_TAGS,
    AGENT_DEFAULT_VERSIONS,
    AGENT_IMAGE_NAMES,
    DOCKER_CONTENT_FILES
};

export type { CliVersionType, AvailableVersionsResponse };
