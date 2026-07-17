/**
 * Version service for managing agent CLI versions.
 * Handles version resolution, content hashing, and available versions retrieval.
 */

import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import logger from '../../utils/logger.js';
import type { AgentConfig, AgentType } from '../types.js';
import { AGENT_TYPES } from '../constants.js';
import type { AvailableVersionsResponse, CliVersionType } from './types.js';
import {
    AGENT_CLI_PACKAGES,
    AGENT_CLI_TAGS,
    AGENT_DEFAULT_VERSIONS,
    AGENT_BUNDLE_CONTENT_FILES,
    AGENT_IMAGE_NAME
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
const INSTALLER_AGENT_TYPES = new Set<AgentType>(['antigravity']);

export type AgentCliVersionMatrix = Record<AgentType, string>;

export function getDefaultAgentCliVersionMatrix(): AgentCliVersionMatrix {
    return { ...AGENT_DEFAULT_VERSIONS };
}

export function getAgentCliVersionMatrix(
    agents: Array<Pick<AgentConfig, 'type' | 'cliVersionResolved'> & Partial<Pick<AgentConfig, 'enabled'>>>
): AgentCliVersionMatrix {
    const versions = getDefaultAgentCliVersionMatrix();
    const configured = new Map<AgentType, string>();
    for (const agent of agents) {
        if (agent.enabled === false) continue;
        const version = agent.cliVersionResolved || AGENT_DEFAULT_VERSIONS[agent.type];
        const existing = configured.get(agent.type);
        if (existing && existing !== version) {
            throw new Error(
                `All ${agent.type} agents must use the same CLI version in the unified image; configured ${existing} and ${version}`
            );
        }
        configured.set(agent.type, version);
        versions[agent.type] = version;
    }
    return versions;
}

export function getAgentBundleVersionHash(versions: AgentCliVersionMatrix): string {
    const serialized = AGENT_TYPES.map(type => `${type}=${versions[type]}`).join('\n');
    return crypto.createHash('sha256').update(serialized).digest('hex').slice(0, 12);
}

function validatePyPiCustomVersion(versionSpec: string, packageName: string): string | Promise<string> {
    const trimmedVersionSpec = versionSpec.trim();
    if (!trimmedVersionSpec) {
        throw new Error('Version spec required');
    }
    if (!trimmedVersionSpec.includes('@') && !trimmedVersionSpec.includes('://') && !/\.(?:whl|tar\.gz)$/i.test(trimmedVersionSpec)) {
        return resolvePyPiVersionSpec(packageName, trimmedVersionSpec);
    }
    logger.debug({ packageName, versionSpec: trimmedVersionSpec }, 'Using custom PyPI install spec');
    return trimmedVersionSpec;
}

function resolvePyPiTag(agentType: AgentType, packageName: string, versionSpec: string): Promise<string> | string {
    if (!AGENT_CLI_TAGS[agentType].includes(versionSpec)) {
        throw new Error(`Unknown tag '${versionSpec}' for PyPI-backed package ${packageName}`);
    }
    return versionSpec === 'latest' ? getLatestPyPiVersion(packageName) : AGENT_DEFAULT_VERSIONS[agentType];
}

function resolveInstallerVersion(agentType: AgentType, versionType: CliVersionType, versionSpec?: string): string {
    if (versionType === 'default') {
        return AGENT_DEFAULT_VERSIONS[agentType];
    }
    if (!versionSpec) {
        throw new Error('Version spec required');
    }
    const trimmedVersionSpec = versionSpec.trim();
    if (!trimmedVersionSpec) {
        throw new Error('Version spec required');
    }
    if (versionType !== 'tag') {
        throw new Error(`Installer-backed CLI ${AGENT_CLI_PACKAGES[agentType]} only supports the latest version`);
    }
    if (!AGENT_CLI_TAGS[agentType].includes(trimmedVersionSpec)) {
        throw new Error(`Unknown tag '${trimmedVersionSpec}' for installer-backed CLI ${AGENT_CLI_PACKAGES[agentType]}`);
    }
    return trimmedVersionSpec;
}

export function getDockerTagComponent(value: string): string {
    const trimmed = value.trim();
    const normalized = trimmed.replace(/[^A-Za-z0-9_.-]/g, '-').replace(/^[.-]+/, '').slice(0, 96);
    const tagBase = normalized || 'custom';
    if (tagBase === trimmed && tagBase.length <= 96) {
        return tagBase;
    }
    const hash = crypto.createHash('sha256').update(trimmed).digest('hex').slice(0, 12);
    return `${tagBase.slice(0, 83)}-${hash}`;
}

/**
 * Resolves a version specification to an actual semver version.
 *
 * @param agentType - The agent type (claude, codex, antigravity, vibe)
 * @param versionType - How the version is specified
 * @param versionSpec - The version specification (tag name, version number, or custom input)
 * @returns The resolved semver version
 */
export async function resolveVersion(
    agentType: AgentType,
    versionType: CliVersionType,
    versionSpec?: string
): Promise<string> {
    const packageName = AGENT_CLI_PACKAGES[agentType];

    if (INSTALLER_AGENT_TYPES.has(agentType)) {
        return resolveInstallerVersion(agentType, versionType, versionSpec);
    }

    if (PYPI_AGENT_TYPES.has(agentType)) {
        switch (versionType) {
            case 'default':
                return AGENT_DEFAULT_VERSIONS[agentType];
            case 'tag':
                if (!versionSpec) {
                    throw new Error('Version spec required for tag type');
                }
                return resolvePyPiTag(agentType, packageName, versionSpec);
            case 'specific':
                if (!versionSpec) {
                    throw new Error('Version spec required');
                }
                return resolvePyPiVersionSpec(packageName, versionSpec);
            case 'custom':
                if (!versionSpec) {
                    throw new Error('Version spec required');
                }
                return validatePyPiCustomVersion(versionSpec, packageName);
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
    const packageName = AGENT_CLI_PACKAGES[agentType];
    const defaultVersion = AGENT_DEFAULT_VERSIONS[agentType];
    const tagNames = AGENT_CLI_TAGS[agentType];

    try {
        if (INSTALLER_AGENT_TYPES.has(agentType)) {
            return {
                agentType,
                packageName,
                defaultVersion,
                availableTags: tagNames.map(tag => ({
                    tag,
                    version: tag === 'latest' ? 'latest' : defaultVersion
                })),
                recentVersions: []
            };
        }

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
const PROJECT_ROOT = process.env.PROPR_ROOT
    || (fs.existsSync(path.join(process.cwd(), 'Dockerfile.agent')) ? process.cwd() : '/usr/src/app');

/**
 * Computes a content hash for the Docker build files of an agent.
 * This hash changes when any of the Dockerfile or script files change.
 *
 * @param agentType - The agent type
 * @param basePath - Base path where Dockerfiles are located (defaults to project root)
 * @returns First 6 characters of SHA256 hash
 */
export function computeContentHash(_agentType?: AgentType, basePath: string = PROJECT_ROOT): string {
    const files = AGENT_BUNDLE_CONTENT_FILES;
    const hash = crypto.createHash('sha256');

    for (const file of files) {
        const filePath = path.join(basePath, file);
        try {
            if (fs.existsSync(filePath)) {
                const content = fs.readFileSync(filePath, 'utf-8');
                hash.update(content);
            } else {
                logger.warn({ file }, 'Agent bundle content file not found, skipping in hash');
            }
        } catch (error) {
            const err = error as Error;
            logger.warn({ file, error: err.message }, 'Failed to read agent bundle content file');
        }
    }

    const fullHash = hash.digest('hex');
    return fullHash.substring(0, 6);
}

export function generateAgentBundleImageTag(
    versions: AgentCliVersionMatrix,
    contentHash: string
): string {
    return `${AGENT_IMAGE_NAME}:bundle-${getAgentBundleVersionHash(versions)}-${contentHash}`;
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
    AGENT_CLI_PACKAGES,
    AGENT_CLI_TAGS,
    AGENT_DEFAULT_VERSIONS,
    AGENT_BUNDLE_CONTENT_FILES,
    AGENT_IMAGE_NAME
};

export type { CliVersionType, AvailableVersionsResponse };
