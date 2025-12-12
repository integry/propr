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

export function executeDockerCommand(
    command: string,
    args: string[],
    options: DockerCommandOptions = {}
): Promise<ExecutionResult> {
    return new Promise((resolve, reject) => {
        const { timeout = 300000, cwd, onSessionId, onContainerId, worktreePath, stdinData } = options;

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

            if (timedOut) {
                reject(new Error(`Command timed out after ${timeout}ms`));
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

