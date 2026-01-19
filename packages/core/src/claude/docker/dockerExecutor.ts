import { spawn, execSync, SpawnOptions, ChildProcess } from 'child_process';
import fs from 'fs';
import logger from '../../utils/logger.js';

export interface ExecutionResult {
    stdout: string;
    stderr: string;
    exitCode: number | null;
    messageTimestamps: Map<string, string>;
}

/**
 * Represents a single input to write to stdin with a delay.
 * Used for interactive sessions where inputs need to be timed.
 */
export interface InputSequenceItem {
    text: string;      // The text to write to stdin (include \n for Enter key)
    delayMs: number;   // Delay before writing this input (ms)
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
    inputSequence?: InputSequenceItem[]; // For interactive sessions: sequence of inputs with delays
    keepStdinOpen?: boolean; // Keep stdin open after writing inputSequence (for long-running interactive sessions)
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
        const { timeout = 300000, cwd, onSessionId, onContainerId, worktreePath, stdinData, taskId, inputSequence, keepStdinOpen } = options;

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

        // Determine if we need stdin pipe based on stdinData OR inputSequence
        const needsStdinPipe = !!stdinData || (inputSequence && inputSequence.length > 0);

        const spawnOptions: SpawnOptions = {
            stdio: [needsStdinPipe ? 'pipe' : 'ignore', 'pipe', 'pipe'],
            env: process.env
        };

        if (cwd && fs.existsSync(cwd)) {
            spawnOptions.cwd = cwd;
        } else if (cwd) {
            logger.warn({ cwd }, 'Working directory does not exist, spawning from current directory');
        }

        const child: ChildProcess = spawn(executablePath, args, spawnOptions);

        // Handle input: either single stdinData or interactive inputSequence
        if (inputSequence && inputSequence.length > 0 && child.stdin) {
            // Interactive mode: write inputs with delays
            logger.debug({ inputCount: inputSequence.length }, 'Starting interactive input sequence...');

            const processInputs = async () => {
                for (const input of inputSequence) {
                    await new Promise(resolve => setTimeout(resolve, input.delayMs));

                    if (child.stdin?.writable) {
                        child.stdin.write(input.text);
                        logger.debug({ input: input.text.trim() }, 'Sent interactive input');
                    } else {
                        logger.warn('Child stdin not writable, skipping input');
                    }
                }

                if (!keepStdinOpen) {
                    child.stdin?.end();
                    logger.debug('Closed stdin after input sequence');
                }
            };

            processInputs().catch(err => {
                logger.error({ error: err }, 'Error processing input sequence');
            });
        } else if (stdinData && child.stdin) {
            // Standard mode: write once and close
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
                    logger.info({ taskId }, 'Abort signal detected, terminating execution');
                    child.kill('SIGTERM');
                    setTimeout(() => {
                        if (!child.killed) {
                            child.kill('SIGKILL');
                        }
                    }, 5000);
                }
            }, 2000); // Check every 2 seconds
        }

        if (command === 'docker' && args[0] === 'run' && onContainerId && worktreePath) {
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
                            onContainerId(containerId, containerName);
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

