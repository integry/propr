/**
 * API routes for agent CLI version management.
 * Provides endpoints for fetching available versions, building images, and cleanup.
 */

import { Request, Response } from 'express';
import {
    getAvailableVersions,
    resolveVersion,
    computeContentHash,
    generateAgentBundleImageTag,
    getAgentCliVersionMatrix,
    getDefaultAgentCliVersionMatrix,
    AGENT_IMAGE_NAME,
    validateAgentType,
    ensureAgentBundleImage,
    cleanupUnusedAgentImages,
    listAgentImages,
    loadAgents,
} from '@propr/core';
import type { AgentType, CliVersionType, AgentConfig } from '@propr/core';

const VALID_CLI_VERSION_TYPES: CliVersionType[] = ['default', 'tag', 'specific', 'custom'];

function isValidCliVersionType(versionType: unknown): versionType is CliVersionType {
    return typeof versionType === 'string' && VALID_CLI_VERSION_TYPES.includes(versionType as CliVersionType);
}

interface AgentVersionRouteDeps {
    getAvailableVersions: typeof getAvailableVersions;
    resolveVersion: typeof resolveVersion;
    ensureAgentBundleImage: typeof ensureAgentBundleImage;
    cleanupUnusedAgentImages: typeof cleanupUnusedAgentImages;
    listAgentImages: typeof listAgentImages;
    loadAgents: typeof loadAgents;
}

/**
 * Creates the agent version management routes.
 *
 * @internal deps exists for route tests; production callers should use the
 * default service wiring.
 */
export function createAgentVersionRoutes(deps: Partial<AgentVersionRouteDeps> = {}) {
    const versionService = {
        getAvailableVersions,
        resolveVersion,
        ensureAgentBundleImage,
        cleanupUnusedAgentImages,
        listAgentImages,
        loadAgents,
        ...deps
    };

    /**
     * GET /api/agents/versions/:agentType
     * Returns available versions for an agent type including npm tags and recent versions.
     */
    async function getVersions(req: Request, res: Response): Promise<void> {
        try {
            const { agentType } = req.params;

            const validation = validateAgentType(agentType);
            if (!validation.ok) {
                res.status(400).json({ error: validation.error });
                return;
            }

            const versions = await versionService.getAvailableVersions(validation.agentType);
            res.json(versions);
        } catch (error) {
            const err = error as Error;
            console.error('Error in /api/agents/versions/:agentType GET:', err);
            res.status(500).json({ error: 'Failed to fetch available versions', details: err.message });
        }
    }

    /**
     * POST /api/agents/:agentId/build-image
     * Triggers a Docker build for a specific agent configuration.
     * Request body can include:
     * - cliVersionType: 'default' | 'tag' | 'specific' | 'custom'
     * - cliVersion: string (version spec based on type)
     */
    async function buildImage(req: Request, res: Response): Promise<void> {
        try {
            const { agentId } = req.params;
            const { cliVersionType, cliVersion } = req.body;

            // Load agents to find the one we're building for
            const agents = await versionService.loadAgents();
            const agent = agents.find((a: AgentConfig) => a.id === agentId);

            if (!agent) {
                res.status(404).json({ error: `Agent not found: ${agentId}` });
                return;
            }

            const agentType = agent.type as AgentType;

            // Resolve the CLI version
            const effectiveVersionType: CliVersionType = cliVersionType || agent.cliVersionType || 'default';
            const effectiveVersionSpec = cliVersion || agent.cliVersion;

            let resolvedVersion: string;
            try {
                resolvedVersion = await versionService.resolveVersion(agentType, effectiveVersionType, effectiveVersionSpec);
            } catch (resolveError) {
                res.status(400).json({
                    error: 'Failed to resolve version',
                    details: (resolveError as Error).message
                });
                return;
            }

            const versions = getAgentCliVersionMatrix(agents);
            versions[agentType] = resolvedVersion;
            const contentHash = computeContentHash();

            // Build the image
            const result = await versionService.ensureAgentBundleImage(versions, contentHash);

            if (result.success) {
                res.json({
                    success: true,
                    imageTag: result.imageTag,
                    cliVersion: resolvedVersion,
                    contentHash
                });
            } else {
                res.status(500).json({
                    success: false,
                    error: result.error || 'Build failed',
                    imageTag: result.imageTag
                });
            }
        } catch (error) {
            const err = error as Error;
            console.error('Error in /api/agents/:agentId/build-image POST:', err);
            res.status(500).json({ error: 'Failed to build image', details: err.message });
        }
    }

    /**
     * DELETE /api/agents/:agentType/images/cleanup
     * Triggers cleanup of unused Docker images for an agent type.
     */
    async function cleanupImages(req: Request, res: Response): Promise<void> {
        try {
            const { agentType } = req.params;

            const validation = validateAgentType(agentType);
            if (!validation.ok) {
                res.status(400).json({ error: validation.error });
                return;
            }
            const agents = await versionService.loadAgents();
            const tagsInUse = new Set<string>();
            for (const agent of agents) {
                const prefix = `${AGENT_IMAGE_NAME}:`;
                if (agent.dockerImage.startsWith(prefix)) tagsInUse.add(agent.dockerImage.slice(prefix.length));
            }
            tagsInUse.add(generateAgentBundleImageTag(getDefaultAgentCliVersionMatrix(), computeContentHash()).slice(`${AGENT_IMAGE_NAME}:`.length));

            // Perform cleanup
            const deletedCount = await versionService.cleanupUnusedAgentImages(tagsInUse);

            res.json({
                success: true,
                deletedCount,
                tagsKept: Array.from(tagsInUse)
            });
        } catch (error) {
            const err = error as Error;
            console.error('Error in /api/agents/:agentType/images/cleanup DELETE:', err);
            res.status(500).json({ error: 'Failed to cleanup images', details: err.message });
        }
    }

    /**
     * GET /api/agents/:agentType/images
     * Lists all Docker images for an agent type.
     */
    async function listImages(req: Request, res: Response): Promise<void> {
        try {
            const { agentType } = req.params;

            const validation = validateAgentType(agentType);
            if (!validation.ok) {
                res.status(400).json({ error: validation.error });
                return;
            }
            const tags = await versionService.listAgentImages();

            res.json({
                agentType: validation.agentType,
                images: tags.map((tag: string) => ({
                    tag,
                    fullName: `${AGENT_IMAGE_NAME}:${tag}`
                }))
            });
        } catch (error) {
            const err = error as Error;
            console.error('Error in /api/agents/:agentType/images GET:', err);
            res.status(500).json({ error: 'Failed to list images', details: err.message });
        }
    }

    /**
     * POST /api/agents/resolve-version
     * Resolves a version specification to an actual semver version.
     */
    async function resolveVersionEndpoint(req: Request, res: Response): Promise<void> {
        try {
            const { agentType, versionType, versionSpec } = req.body;

            const validation = validateAgentType(agentType);
            if (!validation.ok) {
                res.status(400).json({ error: validation.error });
                return;
            }
            const type = validation.agentType;

            if (!isValidCliVersionType(versionType)) {
                res.status(400).json({ error: `Invalid version type: ${versionType}` });
                return;
            }

            const resolved = await versionService.resolveVersion(
                type,
                versionType,
                versionSpec
            );

            res.json({
                agentType: type,
                versionType,
                versionSpec,
                resolved
            });
        } catch (error) {
            const err = error as Error;
            res.status(400).json({ error: 'Failed to resolve version', details: err.message });
        }
    }

    /**
     * GET /api/agents/:agentType/image-tag
     * Generates the Docker image tag for a given version configuration.
     */
    async function getImageTag(req: Request, res: Response): Promise<void> {
        try {
            const { agentType } = req.params;
            const { versionType, versionSpec } = req.query;

            const validation = validateAgentType(agentType);
            if (!validation.ok) {
                res.status(400).json({ error: validation.error });
                return;
            }

            const type = validation.agentType;
            const effectiveVersionType = (versionType as CliVersionType) || 'default';
            if (!isValidCliVersionType(effectiveVersionType)) {
                res.status(400).json({ error: `Invalid version type: ${effectiveVersionType}` });
                return;
            }

            // Resolve version
            const resolved = await versionService.resolveVersion(type, effectiveVersionType, versionSpec as string);

            const agents = await versionService.loadAgents();
            const versions = getAgentCliVersionMatrix(agents);
            versions[type] = resolved;
            const contentHash = computeContentHash();
            const imageTag = generateAgentBundleImageTag(versions, contentHash);

            res.json({
                agentType: type,
                versionType: effectiveVersionType,
                versionSpec: versionSpec || null,
                resolvedVersion: resolved,
                contentHash,
                imageTag
            });
        } catch (error) {
            const err = error as Error;
            res.status(400).json({ error: 'Failed to generate image tag', details: err.message });
        }
    }

    return {
        getVersions,
        buildImage,
        cleanupImages,
        listImages,
        resolveVersionEndpoint,
        getImageTag
    };
}
