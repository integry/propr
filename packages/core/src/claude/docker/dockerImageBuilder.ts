import fs from 'fs';
import path from 'path';
import logger from '../../utils/logger.js';
import { DEFAULT_AGENT_DOCKER_IMAGES } from '../../agents/constants.js';
import {
    type AgentCliVersionMatrix,
    AGENT_IMAGE_NAME,
    computeContentHash,
    generateAgentBundleImageTag,
    getDefaultAgentCliVersionMatrix
} from '../../agents/version/versionService.js';
import { executeDockerCommand } from './dockerExecutor.js';

const PROJECT_ROOT = process.env.PROPR_ROOT
    || (fs.existsSync(path.join(process.cwd(), 'Dockerfile.agent')) ? process.cwd() : '/usr/src/app');
const AGENT_DOCKERFILE = 'Dockerfile.agent';
const SAFE_BUILD_VERSION = /^[0-9A-Za-z][0-9A-Za-z.!+_-]*$/;
const pendingImagePreparations = new Map<string, Promise<VersionedImageBuildResult>>();

export interface VersionedImageBuildResult {
    success: boolean;
    imageTag: string;
    error?: string;
}

function validateVersionMatrix(versions: AgentCliVersionMatrix): void {
    for (const [type, version] of Object.entries(versions)) {
        if (type === 'antigravity' && version === 'latest') continue;
        if (type === 'vibe') {
            if (!version.trim() || /[\r\n\0]/.test(version)) {
                throw new Error(`Unsupported Vibe CLI install spec for image build: ${version}`);
            }
            continue;
        }
        if (!SAFE_BUILD_VERSION.test(version)) {
            throw new Error(`Unsupported ${type} CLI version for image build: ${version}`);
        }
    }
}

function bundleBuildArgs(versions: AgentCliVersionMatrix): string[] {
    validateVersionMatrix(versions);
    return [
        '--build-arg', `CLAUDE_CLI_VERSION=${versions.claude}`,
        '--build-arg', `CODEX_CLI_VERSION=${versions.codex}`,
        '--build-arg', `ANTIGRAVITY_CLI_VERSION=${versions.antigravity}`,
        '--build-arg', `OPENCODE_CLI_VERSION=${versions.opencode}`,
        '--build-arg', `VIBE_CLI_VERSION=${versions.vibe}`
    ];
}

export async function agentDockerImageExists(image: string): Promise<boolean> {
    const result = await executeDockerCommand('docker', ['images', '-q', image]);
    return result.exitCode === 0 && Boolean(result.stdout.trim());
}

async function pullImage(image: string): Promise<boolean> {
    const result = await executeDockerCommand('docker', ['pull', image], { timeout: 10 * 60 * 1000 });
    return result.exitCode === 0;
}

async function buildBundle(
    imageTag: string,
    versions: AgentCliVersionMatrix,
    basePath: string
): Promise<VersionedImageBuildResult> {
    const dockerfile = path.join(basePath, AGENT_DOCKERFILE);
    if (!fs.existsSync(dockerfile)) {
        return { success: false, imageTag, error: `Unified agent Dockerfile not found: ${dockerfile}` };
    }

    logger.info({ imageTag, versions, dockerfile }, 'Building unified agent Docker image...');
    const result = await executeDockerCommand('docker', [
        'build',
        '-f', dockerfile,
        ...bundleBuildArgs(versions),
        '-t', imageTag,
        basePath
    ], { timeout: 20 * 60 * 1000 });

    if (result.exitCode !== 0) {
        const error = `Build failed with exit code ${result.exitCode}: ${result.stderr}`;
        logger.error({ imageTag, versions, error }, 'Failed to build unified agent image');
        return { success: false, imageTag, error };
    }
    logger.info({ imageTag, versions }, 'Unified agent Docker image built successfully');
    return { success: true, imageTag };
}

function scheduleBundleImageCleanup(imageTag: string): void {
    const tag = imageTag.startsWith(`${AGENT_IMAGE_NAME}:`)
        ? imageTag.slice(`${AGENT_IMAGE_NAME}:`.length)
        : imageTag;
    setImmediate(() => {
        Promise.all([
            import('./dockerImageManager.js'),
            import('../../config/configManager.js')
        ])
            .then(async ([{ cleanupUnusedAgentImages }, { loadAgents }]) => {
                const tagsInUse = new Set([tag]);
                const prefix = `${AGENT_IMAGE_NAME}:`;
                // The default-agent bundle (used when no agents are configured)
                // is never referenced by a config, so keep it explicitly.
                const defaultBundleTag = generateAgentBundleImageTag(getDefaultAgentCliVersionMatrix(), computeContentHash());
                tagsInUse.add(defaultBundleTag.slice(prefix.length));
                for (const agent of await loadAgents()) {
                    if (agent.dockerImage.startsWith(prefix)) {
                        tagsInUse.add(agent.dockerImage.slice(prefix.length));
                    }
                }
                // Cleanup runs after best-effort pull/build paths and keeps the
                // tag this build just produced. Docker builds are serialized by
                // the worker in normal operation; if an operator launches
                // concurrent manual bundle builds, unconfigured tags may still
                // be eligible for cleanup until a config references them.
                await cleanupUnusedAgentImages(tagsInUse);
            })
            .catch(error => {
                logger.debug({ imageTag, error: (error as Error).message }, 'Agent image cleanup after build failed');
            });
    });
}

async function prepareAgentBundleImage(
    versions: AgentCliVersionMatrix,
    contentHash: string,
    basePath: string,
    imageTag: string,
): Promise<VersionedImageBuildResult> {
    logger.info({ imageTag, versions, contentHash }, 'Ensuring unified agent Docker image exists...');

    try {
        if (await agentDockerImageExists(imageTag)) return { success: true, imageTag };
        if (await pullImage(imageTag)) return { success: true, imageTag };
        const built = await buildBundle(imageTag, versions, basePath);
        if (built.success) scheduleBundleImageCleanup(imageTag);
        return built;
    } catch (error) {
        const message = (error as Error).message;
        logger.error({ imageTag, versions, error: message }, 'Error ensuring unified agent image');
        return { success: false, imageTag, error: message };
    }
}

/**
 * Pulls or builds one bundle tag at most once per process at a time. Registry
 * refreshes can arrive concurrently (HTTP requests, config notifications, and
 * startup), but they must all await the same Docker operation.
 */
export function ensureAgentBundleImage(
    versions: AgentCliVersionMatrix,
    contentHash: string,
    basePath: string = PROJECT_ROOT
): Promise<VersionedImageBuildResult> {
    const imageTag = generateAgentBundleImageTag(versions, contentHash);
    const pending = pendingImagePreparations.get(imageTag);
    if (pending) return pending;

    const preparation = prepareAgentBundleImage(versions, contentHash, basePath, imageTag)
        .finally(() => {
            pendingImagePreparations.delete(imageTag);
        });
    pendingImagePreparations.set(imageTag, preparation);
    return preparation;
}

/** Ensures a directly configured image such as propr/agent:latest is available. */
export async function ensureAgentDockerImage(_agentType: string, dockerImage: string): Promise<boolean> {
    const pending = pendingImagePreparations.get(dockerImage);
    if (pending) return (await pending).success;

    const preparation = (async (): Promise<VersionedImageBuildResult> => {
        try {
            if (await agentDockerImageExists(dockerImage)) return { success: true, imageTag: dockerImage };
            if (await pullImage(dockerImage)) return { success: true, imageTag: dockerImage };
            const versions = getDefaultAgentCliVersionMatrix();
            return buildBundle(dockerImage, versions, PROJECT_ROOT);
        } catch (error) {
            logger.error({ dockerImage, error: (error as Error).message }, 'Error ensuring agent Docker image');
            return { success: false, imageTag: dockerImage, error: (error as Error).message };
        }
    })().finally(() => {
        pendingImagePreparations.delete(dockerImage);
    });
    pendingImagePreparations.set(dockerImage, preparation);
    return (await preparation).success;
}

export async function buildClaudeDockerImage(): Promise<boolean> {
    return ensureAgentDockerImage('claude', DEFAULT_AGENT_DOCKER_IMAGES.claude);
}
