import fs from 'fs';
import path from 'path';
import logger from '../../utils/logger.js';
import { AGENT_DEFAULT_VERSIONS, AGENT_IMAGE_NAMES } from '../../agents/version/types.js';
import { getDockerTagComponent } from '../../agents/version/versionService.js';
import type { AgentType } from '../../agents/types.js';
import { executeDockerCommand } from './dockerExecutor.js';

// Mapping from agent types to their Dockerfiles
const AGENT_DOCKERFILES: Record<string, string> = {
    'claude': 'Dockerfile.claude',
    'codex': 'Dockerfile.codex',
    'antigravity': 'Dockerfile.antigravity',
    'vibe': 'Dockerfile.vibe'
};

const CLAUDE_DOCKER_IMAGE: string = process.env.CLAUDE_DOCKER_IMAGE || 'propr/agent-claude:latest';

// Default project root - can be overridden via environment variable
// In Docker container, the app root is /usr/src/app but cwd may be /usr/src/app/packages/api
const PROJECT_ROOT = process.env.PROPR_ROOT || '/usr/src/app';

function getAgentBaseImage(): string {
    return process.env.AGENT_BASE_IMAGE
        || process.env.PROPR_AGENT_BASE_IMAGE
        || `propr/agent-base:${process.env.AGENT_BASE_TAG || process.env.PROPR_AGENT_BASE_TAG || process.env.PROPR_IMAGE_VERSION || 'latest'}`;
}

function getAgentBuildArgs(agentType: string, dockerImage: string): string[] {
    const buildArgs = ['--build-arg', `BASE_IMAGE=${getAgentBaseImage()}`];
    if (!(agentType in AGENT_DEFAULT_VERSIONS)) return buildArgs;
    const fallbackVersion = AGENT_DEFAULT_VERSIONS[agentType as AgentType];
    if (agentType === 'antigravity') {
        return [...buildArgs, '--build-arg', `CLI_VERSION=${fallbackVersion}`];
    }
    const imageTag = dockerImage.includes(':') ? dockerImage.split(':').pop() : undefined;
    const cliVersion = !imageTag || imageTag === 'latest' ? fallbackVersion : imageTag.split('-')[0] || fallbackVersion;
    return [...buildArgs, '--build-arg', `CLI_VERSION=${cliVersion}`];
}

export async function buildClaudeDockerImage(): Promise<boolean> {
    logger.info({ image: CLAUDE_DOCKER_IMAGE }, 'Building Claude Code Docker image...');

    try {
        const checkResult = await executeDockerCommand('docker', [
            'images', '-q', CLAUDE_DOCKER_IMAGE
        ]);

        if (checkResult.stdout.trim()) {
            logger.info({ image: CLAUDE_DOCKER_IMAGE }, 'Docker image already exists');
            return true;
        }

        const buildResult = await executeDockerCommand('docker', [
            'build',
            '-f', 'Dockerfile.claude',
            '-t', CLAUDE_DOCKER_IMAGE,
            '.'
        ], {
            timeout: 600000
        });

        if (buildResult.exitCode === 0) {
            logger.info({ image: CLAUDE_DOCKER_IMAGE }, 'Docker image built successfully');
            return true;
        } else {
            logger.error({
                image: CLAUDE_DOCKER_IMAGE,
                exitCode: buildResult.exitCode,
                stderr: buildResult.stderr
            }, 'Failed to build Docker image');
            return false;
        }

    } catch (error) {
        const err = error as Error;
        logger.error({
            image: CLAUDE_DOCKER_IMAGE,
            error: err.message
        }, 'Error building Docker image');
        return false;
    }
}

/**
 * Ensures an agent's Docker image exists, building it if necessary.
 * This is called when agents are registered to ensure their images are ready.
 *
 * @param agentType - The type of agent ('claude', 'codex', 'antigravity', 'vibe')
 * @param dockerImage - The expected Docker image name (e.g., 'propr/agent-codex:latest')
 * @returns true if image exists or was built successfully, false otherwise
 */
export async function ensureAgentDockerImage(agentType: string, dockerImage: string): Promise<boolean> {
    logger.info({ agentType, dockerImage }, 'Ensuring agent Docker image exists...');

    try {
        // Already cached locally?
        const checkResult = await executeDockerCommand('docker', ['images', '-q', dockerImage]);
        if (checkResult.stdout.trim()) {
            logger.info({ agentType, dockerImage }, 'Agent Docker image already exists');
            return true;
        }

        // Not cached — try pulling from a registry. In production this is the
        // only path that works since the build context (Dockerfile + source)
        // isn't available inside the worker container.
        logger.info({ agentType, dockerImage }, 'Pulling agent Docker image from registry...');
        const pullResult = await executeDockerCommand('docker', ['pull', dockerImage], { timeout: 600000 });
        if (pullResult.exitCode === 0) {
            logger.info({ agentType, dockerImage }, 'Agent Docker image pulled');
            return true;
        }
        logger.warn({
            agentType,
            dockerImage,
            stderr: pullResult.stderr
        }, 'Agent Docker image pull failed; will try local build as fallback');

        // Fallback: build from source. Only works in dev where the repo is mounted.
        const dockerfile = AGENT_DOCKERFILES[agentType];
        if (!dockerfile) {
            logger.error({ agentType, dockerImage }, 'Unknown agent type and pull failed');
            return false;
        }
        if (!fs.existsSync(dockerfile)) {
            logger.error({
                agentType,
                dockerImage,
                dockerfile
            }, 'Pull failed and Dockerfile not available for local build — ensure the image is published or run from a dev checkout');
            return false;
        }

        logger.info({ agentType, dockerImage, dockerfile }, 'Building agent Docker image locally...');
        const buildResult = await executeDockerCommand('docker', [
            'build',
            '-f', dockerfile,
            ...getAgentBuildArgs(agentType, dockerImage),
            '-t', dockerImage,
            '.'
        ], { timeout: 600000 });

        if (buildResult.exitCode === 0) {
            logger.info({ agentType, dockerImage }, 'Agent Docker image built successfully');
            return true;
        }
        logger.error({
            agentType,
            dockerImage,
            dockerfile,
            exitCode: buildResult.exitCode,
            stderr: buildResult.stderr
        }, 'Failed to build agent Docker image');
        return false;

    } catch (error) {
        const err = error as Error;
        logger.error({ agentType, dockerImage, error: err.message }, 'Error ensuring agent Docker image');
        return false;
    }
}

/**
 * Result from building a versioned Docker image.
 */
export interface VersionedImageBuildResult {
    success: boolean;
    imageTag: string;
    error?: string;
}

/**
 * Ensures a versioned agent Docker image exists, building it if necessary.
 * The image tag format is: {imageName}:{cliVersion}-{contentHash}
 */
export async function ensureVersionedAgentImage(
    agentType: string,
    cliVersion: string,
    contentHash: string,
    basePath: string = PROJECT_ROOT
): Promise<VersionedImageBuildResult> {
    const dockerfileName = AGENT_DOCKERFILES[agentType];

    if (!dockerfileName) {
        return { success: false, imageTag: '', error: `Unknown agent type: ${agentType}` };
    }

    const dockerfile = path.join(basePath, dockerfileName);
    const imageName = AGENT_IMAGE_NAMES[agentType as AgentType];
    if (!imageName) {
        return { success: false, imageTag: '', error: `Unknown agent type: ${agentType}` };
    }

    const imageTag = `${imageName}:${getDockerTagComponent(cliVersion)}-${contentHash}`;

    logger.info({ agentType, imageTag, cliVersion, contentHash, dockerfile }, 'Ensuring versioned agent Docker image exists...');

    try {
        // Check if image already exists
        const checkResult = await executeDockerCommand('docker', [
            'images', '-q', imageTag
        ]);

        if (checkResult.stdout.trim()) {
            logger.info({ agentType, imageTag }, 'Versioned Docker image already exists');
            return { success: true, imageTag };
        }

        // Image doesn't exist, build it with CLI_VERSION build arg
        logger.info({ agentType, imageTag, cliVersion, dockerfile, basePath }, 'Building versioned agent Docker image...');

        const buildResult = await executeDockerCommand('docker', [
            'build',
            '-f', dockerfile,
            '--build-arg', `CLI_VERSION=${cliVersion}`,
            '--build-arg', `BASE_IMAGE=${getAgentBaseImage()}`,
            '-t', imageTag,
            basePath
        ], {
            timeout: 600000 // 10 minute timeout for build
        });

        if (buildResult.exitCode !== 0) {
            logger.error({ agentType, imageTag, cliVersion, dockerfile, exitCode: buildResult.exitCode, stderr: buildResult.stderr }, 'Failed to build versioned agent Docker image');
            return { success: false, imageTag, error: `Build failed with exit code ${buildResult.exitCode}: ${buildResult.stderr}` };
        }
        logger.info({ agentType, imageTag, cliVersion }, 'Versioned agent Docker image built successfully');
        const versionsToKeep = new Set<string>([cliVersion, `${cliVersion}-${contentHash}`]);
        import('./dockerImageManager.js').then(m =>
            m.cleanupUnusedAgentImages(agentType, versionsToKeep)
        ).catch(err => {
            logger.warn({ agentType, error: (err as Error).message }, 'Background cleanup failed');
        });
        return { success: true, imageTag };
    } catch (error) {
        const err = error as Error;
        logger.error({ agentType, imageTag, cliVersion, dockerfile, error: err.message }, 'Error ensuring versioned agent Docker image');
        return { success: false, imageTag, error: err.message };
    }
}
