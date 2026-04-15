import { spawn, execSync, SpawnOptions, ChildProcess } from 'child_process';
import fs from 'fs';
import path from 'path';
import logger from '../../utils/logger.js';

export interface ExecutionResult { stdout: string; stderr: string; exitCode: number | null; messageTimestamps: Map<string, string>; }

export interface DockerCommandOptions {
    timeout?: number; cwd?: string; worktreePath?: string; stdinData?: string; taskId?: string; streamToRedis?: boolean; stripAnsi?: boolean;
    onSessionId?: (sessionId: string, conversationId?: string) => void; onContainerId?: (containerId: string, containerName: string) => void;
    extraMounts?: string[]; extraEnvVars?: Record<string, string>;
}

interface JsonLineMessage { type?: string; message?: { id?: string; model?: string; }; session_id?: string; conversation_id?: string; }

const CLAUDE_DOCKER_IMAGE: string = process.env.CLAUDE_DOCKER_IMAGE || 'propr-claude:latest';

// ANSI escape code regex for stripping terminal formatting (constructed dynamically to avoid control char lint errors)
const ANSI_REGEX = new RegExp('[' + String.fromCharCode(0x1b) + String.fromCharCode(0x9b) + '][[()#;?]*(?:[0-9]{1,4}(?:;[0-9]{0,4})*)?[0-9A-ORZcf-nqry=><]', 'g');

function stripAnsiCodes(text: string): string {
    return text.replace(ANSI_REGEX, '');
}

/**
 * Custom error class for when task execution is aborted by user request.
 * This allows job processors to distinguish between aborts and other errors.
 */
export class ExecutionAbortedError extends Error {
    constructor(message: string = 'Execution aborted by user request') {
        super(message);
        this.name = 'ExecutionAbortedError';
    }
}

// Mapping from agent types to their Dockerfiles
const AGENT_DOCKERFILES: Record<string, string> = {
    'claude': 'Dockerfile.claude',
    'codex': 'Dockerfile.codex',
    'gemini': 'Dockerfile.gemini'
};

// Default project root - can be overridden via environment variable
// In Docker container, the app root is /usr/src/app but cwd may be /usr/src/app/packages/api
const PROJECT_ROOT = process.env.PROPR_ROOT || '/usr/src/app';

async function checkAbortSignal(taskId: string): Promise<boolean> {
    try {
        const Redis = await import('ioredis');
        const redis = new Redis.default({
            host: process.env.REDIS_HOST || 'redis',
            port: parseInt(process.env.REDIS_PORT || '6379', 10)
        });
        // Check both worker abort signal (for task execution) and planner abort signal (for plan generation)
        const [workerAbort, plannerAbort] = await Promise.all([
            redis.get(`worker:abort:${taskId}`),
            redis.get(`planner:abort:${taskId}`)
        ]);
        await redis.quit();
        return workerAbort !== null || plannerAbort !== null;
    } catch {
        return false;
    }
}

/**
 * Forcefully stops a Docker container by ID.
 * First attempts a graceful stop (SIGTERM), then forcefully kills (SIGKILL) if needed.
 * @param containerId - The Docker container ID to stop
 * @param timeoutSeconds - Timeout in seconds before force killing (default: 10)
 * @returns Object indicating success and any error message
 */
export async function stopDockerContainer(
    containerId: string,
    timeoutSeconds: number = 10
): Promise<{ success: boolean; error?: string }> {
    if (!containerId) {
        return { success: false, error: 'No container ID provided' };
    }

    logger.info({ containerId, timeoutSeconds }, 'Attempting to stop Docker container');

    try {
        // First check if the container exists and is running
        try {
            const statusOutput = execSync(
                `/usr/bin/docker ps -a --filter "id=${containerId}" --format "{{.Status}}"`,
                { encoding: 'utf8', timeout: 5000 }
            ).trim();

            if (!statusOutput) {
                logger.info({ containerId }, 'Container no longer exists');
                return { success: true }; // Container already removed, treat as success
            }

            if (!statusOutput.includes('Up')) {
                logger.info({ containerId, status: statusOutput }, 'Container is already stopped');
                return { success: true }; // Already stopped
            }
        } catch (checkErr) {
            // If we can't check status, try to stop anyway
            logger.debug({ containerId, error: (checkErr as Error).message }, 'Could not check container status, attempting stop anyway');
        }

        // Try graceful stop first with timeout
        try {
            execSync(`/usr/bin/docker stop -t ${timeoutSeconds} ${containerId}`, {
                encoding: 'utf8',
                timeout: (timeoutSeconds + 5) * 1000 // Add 5 seconds buffer for the command itself
            });
            logger.info({ containerId }, 'Docker container stopped gracefully');
            return { success: true };
        } catch (stopErr) {
            const stopError = stopErr as Error;
            logger.warn({ containerId, error: stopError.message }, 'Graceful stop failed, attempting force kill');

            // Force kill if graceful stop failed
            try {
                execSync(`/usr/bin/docker kill ${containerId}`, {
                    encoding: 'utf8',
                    timeout: 10000
                });
                logger.info({ containerId }, 'Docker container force killed');
                return { success: true };
            } catch (killErr) {
                const killError = killErr as Error;
                // Check if the error is because container doesn't exist
                if (killError.message.includes('No such container') || killError.message.includes('is not running')) {
                    logger.info({ containerId }, 'Container already stopped or removed');
                    return { success: true };
                }
                logger.error({ containerId, error: killError.message }, 'Failed to force kill Docker container');
                return { success: false, error: killError.message };
            }
        }
    } catch (error) {
        const err = error as Error;
        logger.error({ containerId, error: err.message }, 'Error stopping Docker container');
        return { success: false, error: err.message };
    }
}

/**
 * Clears the abort signal from Redis for a given task
 * @param taskId - The task ID to clear the abort signal for
 */
async function clearAbortSignal(taskId: string): Promise<void> {
    try {
        const Redis = await import('ioredis');
        const redis = new Redis.default({ host: process.env.REDIS_HOST || 'redis', port: parseInt(process.env.REDIS_PORT || '6379', 10) });
        await redis.del(`worker:abort:${taskId}`);
        await redis.quit();
        logger.debug({ taskId }, 'Cleared abort signal from Redis');
    } catch (err) {
        logger.warn({ taskId, error: (err as Error).message }, 'Failed to clear abort signal from Redis');
    }
}

function resolveDockerPath(command: string): string {
    if (command !== 'docker') return command;
    const paths = ['/usr/bin/docker', '/usr/local/bin/docker', '/bin/docker'];
    for (const p of paths) {
        try { if (fs.existsSync(p)) { fs.accessSync(p, fs.constants.X_OK); logger.debug({ dockerPath: p }, 'Found docker executable'); return p; } } catch { /* continue */ }
    }
    logger.debug('Using docker from PATH');
    return 'docker';
}

function setupAbortChecker(taskId: string, abortedRef: { value: boolean }, child: ChildProcess, containerIdRef: { value: string | null }): ReturnType<typeof setInterval> {
    return setInterval(async () => {
        const shouldAbort = await checkAbortSignal(taskId);
        if (shouldAbort && !abortedRef.value && !child.killed) {
            abortedRef.value = true;
            logger.info({ taskId, containerId: containerIdRef.value }, 'Abort signal detected, terminating execution');
            if (containerIdRef.value) {
                const stopResult = await stopDockerContainer(containerIdRef.value, 10);
                if (stopResult.success) logger.info({ taskId, containerId: containerIdRef.value }, 'Docker container stopped successfully on abort');
                else logger.warn({ taskId, containerId: containerIdRef.value, error: stopResult.error }, 'Failed to stop Docker container on abort');
            }
            child.kill('SIGTERM');
            setTimeout(() => { if (!child.killed) child.kill('SIGKILL'); }, 5000);
            await clearAbortSignal(taskId);
        }
    }, 2000);
}

export function executeDockerCommand(command: string, args: string[], options: DockerCommandOptions = {}): Promise<ExecutionResult> {
    return new Promise((resolve, reject) => {
        const { timeout = 300000, cwd, onSessionId, onContainerId, worktreePath, stdinData, taskId, streamToRedis, stripAnsi } = options;
        const executablePath = resolveDockerPath(command);
        const spawnOptions: SpawnOptions = { stdio: [stdinData ? 'pipe' : 'ignore', 'pipe', 'pipe'], env: process.env };
        if (cwd && fs.existsSync(cwd)) spawnOptions.cwd = cwd;
        else if (cwd) logger.warn({ cwd }, 'Working directory does not exist, spawning from current directory');

        const child: ChildProcess = spawn(executablePath, args, spawnOptions);
        if (stdinData && child.stdin) {
            child.stdin.on('error', (err) => { logger.warn({ error: err.message, code: (err as NodeJS.ErrnoException).code }, 'Stdin write error'); });
            child.stdin.write(stdinData);
            child.stdin.end();
            logger.debug({ stdinDataLength: stdinData.length }, 'Wrote prompt data to stdin');
        }

        let stdout = '', stderr = '';
        const state = { timedOut: false, aborted: { value: false }, sessionIdDetected: false, containerIdDetected: false, containerId: { value: null as string | null } };
        const messageTimestamps = new Map<string, string>();
        const timeoutHandle = setTimeout(() => { state.timedOut = true; child.kill('SIGTERM'); setTimeout(() => { if (!child.killed) child.kill('SIGKILL'); }, 5000); }, timeout);
        const abortCheckInterval = taskId ? setupAbortChecker(taskId, state.aborted, child, state.containerId) : null;

        const redisState = { client: null as InstanceType<typeof import('ioredis').default> | null, interval: null as ReturnType<typeof setInterval> | null, lastLen: 0 };
        if (streamToRedis && taskId) initRedisStreaming(taskId, stripAnsi, () => stdout, redisState);
        if (command === 'docker' && args[0] === 'run' && worktreePath) detectContainerId(worktreePath, state, onContainerId);

        child.stdout?.on('data', (data: Buffer) => {
            const chunk = data.toString(), ts = new Date().toISOString();
            stdout += chunk;
            for (const line of chunk.split('\n')) {
                if (!line.trim()) continue;
                try {
                    const j: JsonLineMessage = JSON.parse(line);
                    if (j.type === 'assistant' || j.type === 'user') messageTimestamps.set(j.message?.id || `${j.type}-${JSON.stringify(j).substring(0, 100)}`, ts);
                    if (!state.sessionIdDetected && onSessionId && j.session_id) { state.sessionIdDetected = true; onSessionId(j.session_id, j.conversation_id); }
                } catch { /* skip */ }
            }
        });
        child.stderr?.on('data', (data: Buffer) => { stderr += data.toString(); });

        child.on('close', async (exitCode: number | null) => {
            clearTimeout(timeoutHandle);
            if (abortCheckInterval) clearInterval(abortCheckInterval);
            await cleanupRedisStreaming(redisState, taskId, stripAnsi, stdout);
            if (state.timedOut) { reject(new Error(`Command timed out after ${timeout}ms`)); return; }
            if (state.aborted.value) { reject(new ExecutionAbortedError()); return; }
            resolve({ exitCode, stdout, stderr, messageTimestamps });
        });
        child.on('error', (error: Error) => {
            clearTimeout(timeoutHandle);
            if (abortCheckInterval) clearInterval(abortCheckInterval);
            if (redisState.interval) clearInterval(redisState.interval);
            if (redisState.client) redisState.client.quit().catch(() => {});
            reject(error);
        });
    });
}

function initRedisStreaming(taskId: string, stripAnsi: boolean | undefined, getStdout: () => string, state: { client: InstanceType<typeof import('ioredis').default> | null; interval: ReturnType<typeof setInterval> | null; lastLen: number }): void {
    (async () => {
        try {
            const Redis = await import('ioredis');
            state.client = new Redis.default({ host: process.env.REDIS_HOST || 'redis', port: parseInt(process.env.REDIS_PORT || '6379', 10) });
            const redisKey = `agent:output:${taskId}`;
            state.interval = setInterval(async () => {
                const stdout = getStdout();
                if (stdout.length > state.lastLen && state.client) {
                    try { await state.client.setex(redisKey, 3600, stripAnsi ? stripAnsiCodes(stdout) : stdout); state.lastLen = stdout.length; }
                    catch (err) { logger.debug({ error: (err as Error).message }, 'Failed to stream output to Redis'); }
                }
            }, 2000);
            logger.debug({ taskId, redisKey }, 'Started streaming output to Redis');
        } catch (err) { logger.warn({ error: (err as Error).message }, 'Failed to initialize Redis streaming'); }
    })();
}

async function cleanupRedisStreaming(state: { client: InstanceType<typeof import('ioredis').default> | null; interval: ReturnType<typeof setInterval> | null }, taskId: string | undefined, stripAnsi: boolean | undefined, stdout: string): Promise<void> {
    if (state.interval) clearInterval(state.interval);
    if (state.client && taskId) {
        try { await state.client.setex(`agent:output:${taskId}`, 3600, stripAnsi ? stripAnsiCodes(stdout) : stdout); await state.client.quit(); }
        catch (err) { logger.debug({ error: (err as Error).message }, 'Failed to cleanup Redis streaming'); }
    }
}

function detectContainerId(worktreePath: string, state: { containerIdDetected: boolean; containerId: { value: string | null } }, onContainerId?: (containerId: string, containerName: string) => void): void {
    setTimeout(() => {
        if (state.containerIdDetected) return;
        try {
            const out = execSync(`/usr/bin/docker ps --filter "volume=${worktreePath}" --format "{{.ID}}:{{.Names}}" --latest`, { encoding: 'utf8', timeout: 5000 }).trim();
            if (out) { const [id, name] = out.split(':'); state.containerIdDetected = true; state.containerId.value = id; if (onContainerId) onContainerId(id, name); logger.debug({ containerId: id, containerName: name, worktreePath }, 'Detected Docker container ID'); }
        } catch (err) { logger.debug({ error: (err as Error).message }, 'Failed to detect container ID'); }
    }, 2000);
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
 * @param agentType - The type of agent ('claude', 'codex', 'gemini')
 * @param dockerImage - The expected Docker image name (e.g., 'propr-codex:latest')
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
        return {
            success: false,
            imageTag: '',
            error: `Unknown agent type: ${agentType}`
        };
    }

    // Resolve dockerfile path relative to base path
    const dockerfile = path.join(basePath, dockerfileName);

    // Generate image tag
    const imageNames: Record<string, string> = {
        claude: 'propr-claude',
        codex: 'propr-codex',
        gemini: 'propr-gemini'
    };

    const imageName = imageNames[agentType];
    if (!imageName) {
        return {
            success: false,
            imageTag: '',
            error: `Unknown agent type: ${agentType}`
        };
    }

    const imageTag = `${imageName}:${cliVersion}-${contentHash}`;

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
            '--build-arg', 'BASE_TAG=latest',
            '-t', imageTag,
            basePath
        ], {
            timeout: 600000 // 10 minute timeout for build
        });

        if (buildResult.exitCode === 0) {
            logger.info({ agentType, imageTag, cliVersion }, 'Versioned agent Docker image built successfully');

            // Trigger cleanup of unused images in the background, preserving the just-built version
            const versionsToKeep = new Set<string>([cliVersion, `${cliVersion}-${contentHash}`]);
            import('./dockerImageManager.js').then(m =>
                m.cleanupUnusedAgentImages(agentType, versionsToKeep)
            ).catch(err => {
                logger.warn({ agentType, error: (err as Error).message }, 'Background cleanup failed');
            });

            return { success: true, imageTag };
        } else {
            logger.error({ agentType, imageTag, cliVersion, dockerfile, exitCode: buildResult.exitCode, stderr: buildResult.stderr }, 'Failed to build versioned agent Docker image');
            return { success: false, imageTag, error: `Build failed with exit code ${buildResult.exitCode}: ${buildResult.stderr}` };
        }

    } catch (error) {
        const err = error as Error;
        logger.error({ agentType, imageTag, cliVersion, dockerfile, error: err.message }, 'Error ensuring versioned agent Docker image');
        return { success: false, imageTag, error: err.message };
    }
}

