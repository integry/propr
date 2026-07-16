import { spawn, execSync, SpawnOptions, ChildProcess } from 'child_process';
import fs from 'fs';
import { Redis } from 'ioredis';
import logger from '../../utils/logger.js';


export interface ExecutionResult { stdout: string; stderr: string; exitCode: number | null; messageTimestamps: Map<string, string>; }

export interface DockerCommandOptions {
    timeout?: number; cwd?: string; worktreePath?: string; stdinData?: string; taskId?: string; streamToRedis?: boolean; streamStderrToRedis?: boolean; stripAnsi?: boolean;
    onSessionId?: (sessionId: string, conversationId?: string) => void; onContainerId?: (containerId: string, containerName: string) => void;
    extraMounts?: string[]; extraEnvVars?: Record<string, string>; streamExtraOutput?: () => string;
}

interface JsonLineMessage { type?: string; message?: { id?: string; model?: string; }; session_id?: string; conversation_id?: string; }

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

async function checkAbortSignal(taskId: string): Promise<boolean> {
    try {
        const redis = new Redis({
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
        const redis = new Redis({ host: process.env.REDIS_HOST || 'redis', port: parseInt(process.env.REDIS_PORT || '6379', 10) });
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

function getDockerRunContainerName(args: string[]): string | null {
    const nameIndex = args.indexOf('--name');
    if (nameIndex >= 0 && args[nameIndex + 1]) return args[nameIndex + 1];
    return null;
}

export function executeDockerCommand(command: string, args: string[], options: DockerCommandOptions = {}): Promise<ExecutionResult> {
    return new Promise((resolve, reject) => {
        const { timeout = 300000, cwd, onSessionId, onContainerId, worktreePath, stdinData, taskId, streamToRedis, streamStderrToRedis, streamExtraOutput, stripAnsi } = options;
        const executablePath = resolveDockerPath(command);
        const namedContainer = command === 'docker' ? getDockerRunContainerName(args) : null;
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
        const timeoutHandle = setTimeout(() => {
            state.timedOut = true;
            const containerToStop = state.containerId.value || namedContainer;
            if (containerToStop) {
                void stopDockerContainer(containerToStop, 10).then((stopResult) => {
                    if (!stopResult.success) {
                        logger.warn({ containerId: containerToStop, error: stopResult.error }, 'Failed to stop Docker container after timeout');
                    }
                });
            }
            child.kill('SIGTERM');
            setTimeout(() => { if (!child.killed) child.kill('SIGKILL'); }, 5000);
        }, timeout);
        const abortCheckInterval = taskId ? setupAbortChecker(taskId, state.aborted, child, state.containerId) : null;

        const getRedisOutput = () => {
            const primaryOutput = streamStderrToRedis ? `${stderr}${stdout ? `\n${stdout}` : ''}` : stdout;
            let extraOutput = '';
            if (streamExtraOutput) {
                try { extraOutput = streamExtraOutput(); }
                catch (err) { logger.debug({ error: (err as Error).message }, 'Failed to read extra streaming output'); }
            }
            return extraOutput ? `${primaryOutput}${primaryOutput ? '\n' : ''}${extraOutput}` : primaryOutput;
        };
        const redisState = { client: null as Redis | null, interval: null as ReturnType<typeof setInterval> | null, lastLen: 0 };
        if (streamToRedis && taskId) initRedisStreaming(taskId, stripAnsi, getRedisOutput, redisState);
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
            await cleanupRedisStreaming(redisState, taskId, stripAnsi, getRedisOutput());
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

function initRedisStreaming(taskId: string, stripAnsi: boolean | undefined, getStdout: () => string, state: { client: Redis | null; interval: ReturnType<typeof setInterval> | null; lastLen: number }): void {
    (async () => {
        try {
            state.client = new Redis({ host: process.env.REDIS_HOST || 'redis', port: parseInt(process.env.REDIS_PORT || '6379', 10) });
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

async function cleanupRedisStreaming(state: { client: Redis | null; interval: ReturnType<typeof setInterval> | null }, taskId: string | undefined, stripAnsi: boolean | undefined, stdout: string): Promise<void> {
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

// Re-export image builder functions for backward compatibility
export { buildClaudeDockerImage, ensureAgentBundleImage, ensureAgentDockerImage } from './dockerImageBuilder.js';
export type { VersionedImageBuildResult } from './dockerImageBuilder.js';
