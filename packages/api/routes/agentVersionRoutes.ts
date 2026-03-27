/**
 * API routes for agent CLI version management.
 * Provides endpoints for fetching available versions, building images, and cleanup.
 */

import { Request, Response } from 'express';
import {
    getAvailableVersions,
    resolveVersion,
    computeContentHash,
    generateImageTag,
    AGENT_NPM_PACKAGES,
    AGENT_DEFAULT_VERSIONS,
    ensureVersionedAgentImage,
    cleanupUnusedAgentImages,
    listAgentImages,
    loadAgents
} from '@propr/core';
import type { AgentType, CliVersionType, AgentConfig } from '@propr/core';

/**
 * Creates the agent version management routes.
 */
export function createAgentVersionRoutes() {
    /**
     * GET /api/agents/versions/:agentType
     * Returns available versions for an agent type including npm tags and recent versions.
     */
    async function getVersions(req: Request, res: Response): Promise<void> {
        try {
            const { agentType } = req.params;

            // Validate agent type
            if (!['claude', 'codex', 'gemini'].includes(agentType)) {
                res.status(400).json({ error: `Invalid agent type: ${agentType}` });
                return;
            }

            const versions = await getAvailableVersions(agentType as AgentType);
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
            const agents = await loadAgents();
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
                resolvedVersion = await resolveVersion(agentType, effectiveVersionType, effectiveVersionSpec);
            } catch (resolveError) {
                res.status(400).json({
                    error: 'Failed to resolve version',
                    details: (resolveError as Error).message
                });
                return;
            }

            // Compute content hash
            const contentHash = computeContentHash(agentType);

            // Build the image
            const result = await ensureVersionedAgentImage(agentType, resolvedVersion, contentHash);

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

            // Validate agent type
            if (!['claude', 'codex', 'gemini'].includes(agentType)) {
                res.status(400).json({ error: `Invalid agent type: ${agentType}` });
                return;
            }

            // Get all agent configs to determine which versions are in use
            const agents = await loadAgents();
            const versionsInUse = new Set<string>();

            // Add default version
            versionsInUse.add(AGENT_DEFAULT_VERSIONS[agentType as AgentType]);

            // Add resolved versions from configs
            for (const agent of agents) {
                if (agent.type === agentType && agent.cliVersionResolved) {
                    versionsInUse.add(agent.cliVersionResolved);
                }
            }

            // Perform cleanup
            const deletedCount = await cleanupUnusedAgentImages(agentType, versionsInUse);

            res.json({
                success: true,
                deletedCount,
                versionsKept: Array.from(versionsInUse)
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

            // Validate agent type
            if (!['claude', 'codex', 'gemini'].includes(agentType)) {
                res.status(400).json({ error: `Invalid agent type: ${agentType}` });
                return;
            }

            const tags = await listAgentImages(agentType);

            res.json({
                agentType,
                images: tags.map((tag: string) => ({
                    tag,
                    fullName: `${getImageName(agentType)}:${tag}`
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

            // Validate agent type
            if (!['claude', 'codex', 'gemini'].includes(agentType)) {
                res.status(400).json({ error: `Invalid agent type: ${agentType}` });
                return;
            }

            const resolved = await resolveVersion(
                agentType as AgentType,
                versionType as CliVersionType,
                versionSpec
            );

            res.json({
                agentType,
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

            // Validate agent type
            if (!['claude', 'codex', 'gemini'].includes(agentType)) {
                res.status(400).json({ error: `Invalid agent type: ${agentType}` });
                return;
            }

            const type = agentType as AgentType;
            const effectiveVersionType = (versionType as CliVersionType) || 'default';

            // Resolve version
            const resolved = await resolveVersion(type, effectiveVersionType, versionSpec as string);

            // Compute content hash
            const contentHash = computeContentHash(type);

            // Generate tag
            const imageTag = generateImageTag(type, resolved, contentHash);

            res.json({
                agentType,
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

/**
 * Helper to get the Docker image name for an agent type.
 */
function getImageName(agentType: string): string {
    const imageNames: Record<string, string> = {
        claude: 'claude-code-processor',
        codex: 'codex-cli',
        gemini: 'gemini-cli'
    };
    return imageNames[agentType] || agentType;
}
