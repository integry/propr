import { execSync, ChildProcess } from 'child_process';
import { AsyncLocalStorage } from 'node:async_hooks';
import { Redis } from 'ioredis';
import logger from '../../utils/logger.js';
import {
    captureJsonLineMessages,
    cleanupRedisStreaming,
    createTaskProgressReporter,
    detectContainerId,
    initRedisStreaming,
    initTaskLivenessHeartbeat,
    spawnExecutionCommand,
    type RedisStreamingState
} from './dockerExecutionRuntime.js';

export interface ExecutionResult {
    stdout: string;
    stderr: string;
    exitCode: number | null;
    messageTimestamps: Map<string, string>;
    /** Set when ProPR stopped the process after its configured execution deadline. */
    timedOut?: boolean;
    timeoutMs?: number;
}
export interface RunningTaskContainer { id: string; name: string; }

export interface DockerCommandOptions {
    timeout?: number; cwd?: string; worktreePath?: string; stdinData?: string; taskId?: string; streamToRedis?: boolean; streamStderrToRedis?: boolean; stripAnsi?: boolean;
    /** Resolve with buffered output on timeout so implementation jobs can publish partial work. */
    preserveOutputOnTimeout?: boolean;
    onSessionId?: (sessionId: string, conversationId?: string) => void; onContainerId?: (containerId: string, containerName: string) => void;
    extraMounts?: string[]; extraEnvVars?: Record<string, string>; streamExtraOutput?: () => string;
}

interface AbortCheckerOptions {
    taskId: string;
    plannerAbortKey: string;
    abortedRef: { value: boolean };
    child: ChildProcess;
    containerIdRef: { value: string | null };
    namedContainer: string | null;
}

interface AbortCheckerHandle {
    close(): Promise<void>;
}

interface PlannerAbortContext {
    draftId: string;
    runId: string;
}

export interface AbortRedisClient {
    get(key: string): Promise<string | null>;
    del(key: string): Promise<unknown>;
    quit(): Promise<unknown>;
    disconnect(): void;
}

export type AbortRedisFactory = () => AbortRedisClient;

const plannerAbortContext = new AsyncLocalStorage<PlannerAbortContext>();

export function buildPlannerAbortSignalKey(draftId: string, runId?: string): string {
    return runId ? `planner:abort:${draftId}:run:${runId}` : `planner:abort:${draftId}`;
}

export function runWithPlannerAbortContext<T>(
    draftId: string,
    runId: string,
    operation: () => Promise<T>
): Promise<T> {
    return plannerAbortContext.run({ draftId, runId }, operation);
}

export function plannerAbortSignalKeyForTask(taskId: string): string {
    const context = plannerAbortContext.getStore();
    return context
        ? buildPlannerAbortSignalKey(context.draftId, context.runId)
        : buildPlannerAbortSignalKey(taskId);
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

function createAbortRedis(): AbortRedisClient {
    return new Redis({
        host: process.env.REDIS_HOST || 'redis',
        port: parseInt(process.env.REDIS_PORT || '6379', 10)
    });
}

async function closeAbortRedis(redis: AbortRedisClient): Promise<void> {
    try {
        await redis.quit();
    } catch {
        try { redis.disconnect(); } catch { /* best-effort fallback */ }
    }
}

export async function checkAbortSignal(
    taskId: string,
    plannerAbortKey: string,
    factory: AbortRedisFactory = createAbortRedis
): Promise<boolean> {
    const redis = factory();
    try {
        return await readAbortSignal(redis, taskId, plannerAbortKey);
    } catch (error) {
        throw new Error(`Abort state unavailable for task ${taskId}`, { cause: error });
    } finally {
        await closeAbortRedis(redis);
    }
}

async function readAbortSignal(redis: AbortRedisClient, taskId: string, plannerAbortKey: string): Promise<boolean> {
    // Check both worker abort signal (for task execution) and planner abort signal (for plan generation)
    const [workerAbort, plannerAbort] = await Promise.all([
        redis.get(`worker:abort:${taskId}`),
        redis.get(plannerAbortKey)
    ]);
    return workerAbort !== null || plannerAbort !== null;
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
 * Consumes only the worker abort signal for a given task. Planner abort
 * markers are versioned reconciliation records and must remain until expiry.
 * @param taskId - The task ID to clear the abort signal for
 */
export async function clearWorkerAbortSignal(
    taskId: string,
    factory: AbortRedisFactory = createAbortRedis
): Promise<void> {
    const redis = factory();
    try {
        await redis.del(`worker:abort:${taskId}`);
        logger.debug({ taskId }, 'Cleared worker abort signal from Redis');
    } catch (err) {
        logger.warn({ taskId, error: (err as Error).message }, 'Failed to clear worker abort signal from Redis');
    } finally {
        await closeAbortRedis(redis);
    }
}

async function clearWorkerAbortSignalWithClient(taskId: string, redis: AbortRedisClient): Promise<void> {
    try {
        await redis.del(`worker:abort:${taskId}`);
        logger.debug({ taskId }, 'Cleared worker abort signal from Redis');
    } catch (err) {
        logger.warn({ taskId, error: (err as Error).message }, 'Failed to clear worker abort signal from Redis');
    }
}

const PLANNER_ABORT_LOOKUP_FAILURE_LIMIT = 2;

/**
 * Planner cancellation fails closed after sustained Redis unavailability. One
 * isolated read failure is tolerated because the next two-second poll can
 * recover; any successful read resets the consecutive-failure count.
 */
export function shouldTerminateAfterAbortLookupFailure(plannerAbortKey: string, consecutiveFailures: number): boolean {
    return plannerAbortKey.includes(':run:') && consecutiveFailures >= PLANNER_ABORT_LOOKUP_FAILURE_LIMIT;
}

function setupAbortChecker({ taskId, plannerAbortKey, abortedRef, child, containerIdRef, namedContainer }: AbortCheckerOptions): AbortCheckerHandle {
    const redis = createAbortRedis();
    let pollInFlight = false;
    let active = true;
    let consecutiveLookupFailures = 0;
    let closePromise: Promise<void> | null = null;
    const terminateExecution = async (message: string): Promise<void> => {
        if (abortedRef.value || child.killed) return;
        abortedRef.value = true;
        const containerToStop = containerIdRef.value || namedContainer;
        logger.info({ taskId, containerId: containerToStop }, message);
        if (containerToStop) {
            const stopResult = await stopDockerContainer(containerToStop, 10);
            if (stopResult.success) logger.info({ taskId, containerId: containerToStop }, 'Docker container stopped successfully on abort');
            else logger.warn({ taskId, containerId: containerToStop, error: stopResult.error }, 'Failed to stop Docker container on abort');
        }
        child.kill('SIGTERM');
        setTimeout(() => { if (!child.killed) child.kill('SIGKILL'); }, 5000);
        // Clearing the worker marker is cleanup, so never delay termination on
        // a Redis connection that may be the reason this execution failed closed.
        await clearWorkerAbortSignalWithClient(taskId, redis);
    };
    const interval = setInterval(() => {
        if (pollInFlight) return;
        pollInFlight = true;
        void (async () => {
            const shouldAbort = await readAbortSignal(redis, taskId, plannerAbortKey);
            consecutiveLookupFailures = 0;
            if (shouldAbort) await terminateExecution('Abort signal detected, terminating execution');
        })().catch(async error => {
            if (!active) return;
            consecutiveLookupFailures += 1;
            logger.error({ taskId, plannerAbortKey, error: (error as Error).message }, 'Abort state unavailable; cancellation cannot be verified');
            if (shouldTerminateAfterAbortLookupFailure(plannerAbortKey, consecutiveLookupFailures)) {
                await terminateExecution('Planner abort state unavailable, terminating execution fail closed');
            }
        }).finally(() => { pollInFlight = false; });
    }, 2000);
    return {
        close: async () => {
            closePromise ??= (async () => {
                active = false;
                clearInterval(interval);
                await closeAbortRedis(redis);
            })();
            await closePromise;
        }
    };
}

function getDockerRunContainerName(args: string[]): string | null {
    const nameIndex = args.indexOf('--name');
    if (nameIndex >= 0 && args[nameIndex + 1]) return args[nameIndex + 1];
    return null;
}

/**
 * Finds a running agent container by the task-id suffix used by every agent
 * container name. This survives worker/Redis restarts because Docker remains
 * the source of truth for an execution that is still active.
 */
export async function findRunningDockerContainerForTask(
    taskId: string,
    executor: typeof executeDockerCommand = executeDockerCommand,
): Promise<RunningTaskContainer | null> {
    const shortTaskId = taskId.slice(-8);
    if (!shortTaskId) return null;
    const escapedSuffix = shortTaskId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

    try {
        const result = await executor('docker', [
            'ps',
            '--filter', `name=${escapedSuffix}$`,
            '--format', '{{.ID}}:{{.Names}}',
        ], { timeout: 10000 });
        if (result.exitCode !== 0) {
            logger.warn({ taskId, stderr: result.stderr }, 'Failed to inspect running Docker containers for task');
            return null;
        }

        const firstMatch = result.stdout.split('\n').map(line => line.trim()).find(Boolean);
        if (!firstMatch) return null;
        const separator = firstMatch.indexOf(':');
        if (separator < 1) return null;
        return { id: firstMatch.slice(0, separator), name: firstMatch.slice(separator + 1) };
    } catch (error) {
        logger.warn({ taskId, error: (error as Error).message }, 'Failed to inspect running Docker containers for task');
        return null;
    }
}

export function executeDockerCommand(command: string, args: string[], options: DockerCommandOptions = {}): Promise<ExecutionResult> {
    return new Promise((resolve, reject) => {
        const { timeout = 300000, cwd, onSessionId, onContainerId, worktreePath, stdinData, taskId, streamToRedis, streamStderrToRedis, streamExtraOutput, stripAnsi, preserveOutputOnTimeout = false } = options;
        const namedContainer = command === 'docker' ? getDockerRunContainerName(args) : null;
        const child = spawnExecutionCommand(command, args, { cwd, stdinData });

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
        const plannerAbortKey = taskId ? plannerAbortSignalKeyForTask(taskId) : null;
        const abortChecker = taskId && plannerAbortKey
            ? setupAbortChecker({ taskId, plannerAbortKey, abortedRef: state.aborted, child, containerIdRef: state.containerId, namedContainer })
            : null;

        const getRedisOutput = () => {
            const primaryOutput = streamStderrToRedis ? `${stderr}${stdout ? `\n${stdout}` : ''}` : stdout;
            let extraOutput = '';
            if (streamExtraOutput) {
                try { extraOutput = streamExtraOutput(); }
                catch (err) { logger.debug({ error: (err as Error).message }, 'Failed to read extra streaming output'); }
            }
            return extraOutput ? `${primaryOutput}${primaryOutput ? '\n' : ''}${extraOutput}` : primaryOutput;
        };
        const redisState: RedisStreamingState = {
            client: null,
            interval: null as ReturnType<typeof setInterval> | null,
            lastLen: 0
        };
        const livenessInterval = taskId ? initTaskLivenessHeartbeat(taskId) : null;
        const reportTaskProgress = taskId ? createTaskProgressReporter(taskId) : null;
        if (streamToRedis && taskId) initRedisStreaming(taskId, stripAnsi, getRedisOutput, redisState);
        if (command === 'docker' && args[0] === 'run' && worktreePath) detectContainerId(worktreePath, state, onContainerId);

        child.stdout?.on('data', (data: Buffer) => {
            const chunk = data.toString(), ts = new Date().toISOString();
            stdout += chunk;
            if (chunk.length > 0) reportTaskProgress?.();
            captureJsonLineMessages(chunk, ts, { state, messageTimestamps, onSessionId });
        });
        child.stderr?.on('data', (data: Buffer) => {
            const chunk = data.toString();
            stderr += chunk;
            if (chunk.length > 0) reportTaskProgress?.();
        });

        child.on('close', async (exitCode: number | null) => {
            clearTimeout(timeoutHandle);
            if (abortChecker) await abortChecker.close();
            if (livenessInterval) clearInterval(livenessInterval);
            await cleanupRedisStreaming(redisState, taskId, stripAnsi, getRedisOutput());
            if (state.timedOut) {
                const timeoutMessage = `Command timed out after ${timeout}ms`;
                const timeoutStderr = stderr.trim() ? `${stderr.trimEnd()}\n${timeoutMessage}` : timeoutMessage;
                if (preserveOutputOnTimeout) {
                    resolve({ exitCode, stdout, stderr: timeoutStderr, messageTimestamps, timedOut: true, timeoutMs: timeout });
                } else {
                    reject(new Error(timeoutMessage));
                }
                return;
            }
            if (state.aborted.value) { reject(new ExecutionAbortedError()); return; }
            resolve({ exitCode, stdout, stderr, messageTimestamps });
        });
        child.on('error', async (error: Error) => {
            clearTimeout(timeoutHandle);
            if (abortChecker) await abortChecker.close();
            if (livenessInterval) clearInterval(livenessInterval);
            if (redisState.interval) clearInterval(redisState.interval);
            if (redisState.client) redisState.client.quit().catch(() => {});
            reject(error);
        });
    });
}

// Re-export image builder functions for backward compatibility
export { buildClaudeDockerImage, ensureAgentBundleImage, ensureAgentDockerImage } from './dockerImageBuilder.js';
export type { VersionedImageBuildResult } from './dockerImageBuilder.js';
