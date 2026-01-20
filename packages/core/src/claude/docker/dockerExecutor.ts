import { spawn, execSync, SpawnOptions, ChildProcess } from 'child_process';
import fs from 'fs';
import logger from '../../utils/logger.js';

export interface ExecutionResult {
    stdout: string;
    stderr: string;
    exitCode: number | null;
    messageTimestamps: Map<string, string>;
}

export interface DockerCommandOptions {
    timeout?: number;
    cwd?: string;
    onSessionId?: (sessionId: string, conversationId?: string) => void;
    onContainerId?: (containerId: string, containerName: string) => void;
    worktreePath?: string;
    stdinData?: string; // Data to pipe to stdin
    extraMounts?: string[]; // Additional volume mounts (e.g., ['/host/path:/container/path:rw'])
    extraEnvVars?: Record<string, string>; // Additional environment variables
    taskId?: string; // Task ID for abort signal checking
}

interface JsonLineMessage {
    type?: string;
    message?: {
        id?: string;
        model?: string;
    };
    session_id?: string;
    conversation_id?: string;
}

const CLAUDE_DOCKER_IMAGE: string = process.env.CLAUDE_DOCKER_IMAGE || 'claude-code-processor:latest';

/**
 * Forcefully stops a Docker container by ID
 * First attempts graceful stop (SIGTERM), then forcefully kills if necessary
 * @param containerId - The Docker container ID to stop
 * @param timeoutSeconds - Seconds to wait before force killing (default: 10)
 * @returns Object with success status and any error message
 */
export async function stopDockerContainer(
    containerId: string,
    timeoutSeconds: number = 10
): Promise<{ success: boolean; error?: string; alreadyStopped?: boolean }> {
    if (!containerId) {
        return { success: false, error: 'No container ID provided' };
    }

    logger.info({ containerId, timeoutSeconds }, 'Attempting to stop Docker container');

    try {
        // First check if container exists and is running
        try {
            const statusOutput = execSync(
                `/usr/bin/docker inspect --format='{{.State.Running}}' ${containerId}`,
                { encoding: 'utf8', timeout: 5000 }
            ).trim();

            if (statusOutput === 'false') {
                logger.info({ containerId }, 'Container is already stopped');
                return { success: true, alreadyStopped: true };
            }
        } catch (inspectError) {
            const err = inspectError as Error;
            if (err.message.includes('No such container') || err.message.includes('No such object')) {
                logger.info({ containerId }, 'Container no longer exists');
                return { success: true, alreadyStopped: true };
            }
            // Container exists but inspection failed, proceed with stop attempt
            logger.debug({ containerId, error: err.message }, 'Container inspection failed, proceeding with stop');
        }

        // Attempt graceful stop with timeout
        try {
            execSync(
                `/usr/bin/docker stop --time=${timeoutSeconds} ${containerId}`,
                { encoding: 'utf8', timeout: (timeoutSeconds + 5) * 1000 }
            );
            logger.info({ containerId }, 'Docker container stopped gracefully');
            return { success: true };
        } catch (stopError) {
            const err = stopError as Error;
            logger.warn({ containerId, error: err.message }, 'Graceful stop failed, attempting force kill');
        }

        // Force kill if graceful stop failed
        try {
            execSync(
                `/usr/bin/docker kill ${containerId}`,
                { encoding: 'utf8', timeout: 10000 }
            );
            logger.info({ containerId }, 'Docker container force killed');
            return { success: true };
        } catch (killError) {
            const err = killError as Error;
            // If container is already gone, treat as success
            if (err.message.includes('No such container') || err.message.includes('is not running')) {
                logger.info({ containerId }, 'Container already stopped or removed');
                return { success: true, alreadyStopped: true };
            }
            logger.error({ containerId, error: err.message }, 'Failed to kill Docker container');
            return { success: false, error: err.message };
        }
    } catch (error) {
        const err = error as Error;
        logger.error({ containerId, error: err.message }, 'Error stopping Docker container');
        return { success: false, error: err.message };
    }
}

/**
 * Clears the abort signal for a task from Redis
 * @param taskId - The task ID to clear abort signal for
 */
export async function clearAbortSignal(taskId: string): Promise<void> {
    try {
        const Redis = await import('ioredis');
        const redis = new Redis.default({
            host: process.env.REDIS_HOST || 'redis',
            port: parseInt(process.env.REDIS_PORT || '6379', 10)
        });
        await redis.del(`worker:abort:${taskId}`);
        await redis.quit();
        logger.debug({ taskId }, 'Cleared abort signal from Redis');
    } catch (error) {
        const err = error as Error;
        logger.warn({ taskId, error: err.message }, 'Failed to clear abort signal');
    }
}

// Mapping from agent types to their Dockerfiles
const AGENT_DOCKERFILES: Record<string, string> = {
    'claude': 'Dockerfile.claude',
    'codex': 'Dockerfile.codex',
    'gemini': 'Dockerfile.gemini'
};

async function checkAbortSignal(taskId: string): Promise<boolean> {
    try {
        const Redis = await import('ioredis');
        const redis = new Redis.default({
            host: process.env.REDIS_HOST || 'redis',
            port: parseInt(process.env.REDIS_PORT || '6379', 10)
        });
        const abortSignal = await redis.get(`worker:abort:${taskId}`);
        await redis.quit();
        return abortSignal !== null;
    } catch {
        return false;
    }
}

export function executeDockerCommand(
    command: string,
    args: string[],
    options: DockerCommandOptions = {}
): Promise<ExecutionResult> {
    return new Promise((resolve, reject) => {
        const { timeout = 300000, cwd, onSessionId, onContainerId, worktreePath, stdinData, taskId } = options;

        let executablePath: string = command;
        if (command === 'docker') {
            const possiblePaths: string[] = [
                '/usr/bin/docker',
                '/usr/local/bin/docker',
                '/bin/docker'
            ];

            let found = false;
            for (const dockerPath of possiblePaths) {
                try {
                    if (fs.existsSync(dockerPath)) {
                        fs.accessSync(dockerPath, fs.constants.X_OK);
                        executablePath = dockerPath;
                        found = true;
                        logger.debug({ dockerPath }, 'Found docker executable');
                        break;
                    }
                } catch {
                    // Continue to next path
                }
            }

            if (!found) {
                executablePath = 'docker';
                logger.debug('Using docker from PATH');
            }
        }

        const spawnOptions: SpawnOptions = {
            stdio: [stdinData ? 'pipe' : 'ignore', 'pipe', 'pipe'],
            env: process.env
        };

        if (cwd && fs.existsSync(cwd)) {
            spawnOptions.cwd = cwd;
        } else if (cwd) {
            logger.warn({ cwd }, 'Working directory does not exist, spawning from current directory');
        }

        const child: ChildProcess = spawn(executablePath, args, spawnOptions);

        // Write stdin data if provided (for large prompts)
        if (stdinData && child.stdin) {
            child.stdin.write(stdinData);
            child.stdin.end();
            logger.debug({ stdinDataLength: stdinData.length }, 'Wrote prompt data to stdin');
        }

        let stdout = '';
        let stderr = '';
        let timedOut = false;
        let aborted = false;
        let sessionIdDetected = false;
        let containerIdDetected = false;
        let detectedContainerId: string | null = null;
        const messageTimestamps = new Map<string, string>();

        const timeoutHandle = setTimeout(() => {
            timedOut = true;
            child.kill('SIGTERM');

            setTimeout(() => {
                if (!child.killed) {
                    child.kill('SIGKILL');
                }
            }, 5000);
        }, timeout);

        // Poll for abort signal if taskId is provided
        let abortCheckInterval: ReturnType<typeof setInterval> | null = null;
        if (taskId) {
            abortCheckInterval = setInterval(async () => {
                const shouldAbort = await checkAbortSignal(taskId);
                if (shouldAbort && !aborted && !child.killed) {
                    aborted = true;
                    logger.info({ taskId, containerId: detectedContainerId }, 'Abort signal detected, terminating execution');

                    // Stop the Docker container if we have a container ID
                    if (detectedContainerId) {
                        logger.info({ taskId, containerId: detectedContainerId }, 'Stopping Docker container due to abort signal');
                        const stopResult = await stopDockerContainer(detectedContainerId, 5);
                        if (stopResult.success) {
                            logger.info({ taskId, containerId: detectedContainerId, alreadyStopped: stopResult.alreadyStopped }, 'Docker container stopped successfully');
                        } else {
                            logger.error({ taskId, containerId: detectedContainerId, error: stopResult.error }, 'Failed to stop Docker container');
                        }
                    }

                    // Also kill the spawn process
                    child.kill('SIGTERM');
                    setTimeout(() => {
                        if (!child.killed) {
                            child.kill('SIGKILL');
                        }
                    }, 5000);

                    // Clear the abort signal from Redis
                    await clearAbortSignal(taskId);
                }
            }, 2000); // Check every 2 seconds
        }

        if (command === 'docker' && args[0] === 'run' && worktreePath) {
            setTimeout(async () => {
                if (!containerIdDetected) {
                    try {
                        const containersOutput = execSync(
                            `/usr/bin/docker ps --filter "volume=${worktreePath}" --format "{{.ID}}:{{.Names}}" --latest`,
                            { encoding: 'utf8', timeout: 5000 }
                        ).trim();

                        if (containersOutput) {
                            const [containerId, containerName] = containersOutput.split(':');
                            containerIdDetected = true;
                            detectedContainerId = containerId;
                            if (onContainerId) {
                                onContainerId(containerId, containerName);
                            }
                            logger.debug({
                                containerId,
                                containerName,
                                worktreePath
                            }, 'Detected Docker container ID for Claude execution');
                        }
                    } catch (err) {
                        const error = err as Error;
                        logger.debug({ error: error.message }, 'Failed to detect container ID');
                    }
                }
            }, 2000);
        }

        child.stdout?.on('data', (data: Buffer) => {
            const chunk = data.toString();
            const receiveTimestamp = new Date().toISOString();
            stdout += chunk;

            const lines = chunk.split('\n');
            for (const line of lines) {
                if (line.trim()) {
                    try {
                        const jsonLine: JsonLineMessage = JSON.parse(line);

                        if (jsonLine.type === 'assistant' || jsonLine.type === 'user') {
                            const messageKey = jsonLine.message?.id ||
                                `${jsonLine.type}-${JSON.stringify(jsonLine).substring(0, 100)}`;
                            messageTimestamps.set(messageKey, receiveTimestamp);
                        }

                        if (!sessionIdDetected && onSessionId && jsonLine.session_id) {
                            sessionIdDetected = true;
                            onSessionId(jsonLine.session_id, jsonLine.conversation_id);
                        }
                    } catch {
                        // Not JSON, skip
                    }
                }
            }
        });

        child.stderr?.on('data', (data: Buffer) => {
            stderr += data.toString();
        });

        child.on('close', (exitCode: number | null) => {
            clearTimeout(timeoutHandle);
            if (abortCheckInterval) {
                clearInterval(abortCheckInterval);
            }

            if (timedOut) {
                reject(new Error(`Command timed out after ${timeout}ms`));
                return;
            }

            if (aborted) {
                reject(new Error(`Execution aborted by user request`));
                return;
            }

            resolve({
                exitCode,
                stdout,
                stderr,
                messageTimestamps
            });
        });

        child.on('error', (error: Error) => {
            clearTimeout(timeoutHandle);
            if (abortCheckInterval) {
                clearInterval(abortCheckInterval);
            }
            reject(error);
        });
    });
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
 * @param dockerImage - The expected Docker image name (e.g., 'codex-cli:latest')
 * @returns true if image exists or was built successfully, false otherwise
 */
export async function ensureAgentDockerImage(agentType: string, dockerImage: string): Promise<boolean> {
    const dockerfile = AGENT_DOCKERFILES[agentType];

    if (!dockerfile) {
        logger.error({ agentType, dockerImage }, 'Unknown agent type, cannot determine Dockerfile');
        return false;
    }

    logger.info({ agentType, dockerImage, dockerfile }, 'Ensuring agent Docker image exists...');

    try {
        // Check if image already exists
        const checkResult = await executeDockerCommand('docker', [
            'images', '-q', dockerImage
        ]);

        if (checkResult.stdout.trim()) {
            logger.info({ agentType, dockerImage }, 'Agent Docker image already exists');
            return true;
        }

        // Image doesn't exist, build it
        logger.info({ agentType, dockerImage, dockerfile }, 'Building agent Docker image...');

        const buildResult = await executeDockerCommand('docker', [
            'build',
            '-f', dockerfile,
            '-t', dockerImage,
            '.'
        ], {
            timeout: 600000 // 10 minute timeout for build
        });

        if (buildResult.exitCode === 0) {
            logger.info({ agentType, dockerImage }, 'Agent Docker image built successfully');
            return true;
        } else {
            logger.error({
                agentType,
                dockerImage,
                dockerfile,
                exitCode: buildResult.exitCode,
                stderr: buildResult.stderr
            }, 'Failed to build agent Docker image');
            return false;
        }

    } catch (error) {
        const err = error as Error;
        logger.error({
            agentType,
            dockerImage,
            dockerfile,
            error: err.message
        }, 'Error ensuring agent Docker image');
        return false;
    }
}

