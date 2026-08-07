import { spawn, execSync, SpawnOptions, ChildProcess } from 'child_process';
import fs from 'fs';
import { Redis } from 'ioredis';
import logger from '../../utils/logger.js';
import {
    abortSpawnedExecution,
    createDockerExecutionState,
    ExecutionAbortedError,
    getExecutionAbortError,
    getDockerRunContainerName,
    getExecutionOwnershipContext,
    resolveExecutionArgs,
} from './dockerExecutionOwnership.js';
import {
    plannerAbortSignalKeyForTask,
    scheduleForceKill,
    setupAbortChecker,
} from './dockerAbortController.js';

export { stopDockerContainer } from './dockerContainerControl.js';
export {
    addTaskAttemptLabelsToDockerArgs,
    ExecutionAbortedError,
    runWithExecutionAbortSignal,
} from './dockerExecutionOwnership.js';
export {
    buildPlannerAbortSignalKey,
    checkAbortSignal,
    clearWorkerAbortSignal,
    plannerAbortSignalKeyForTask,
    runWithPlannerAbortContext,
    shouldTerminateAfterAbortLookupFailure,
} from './dockerAbortController.js';
export type { AbortRedisClient, AbortRedisFactory } from './dockerAbortController.js';


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
export type LegacyTaskContainerLiveness = 'running' | 'not_found' | 'unavailable';

export interface DockerCommandOptions {
    timeout?: number; cwd?: string; worktreePath?: string; stdinData?: string; taskId?: string; streamToRedis?: boolean; streamStderrToRedis?: boolean; stripAnsi?: boolean;
    /** Resolve with buffered output on timeout so implementation jobs can publish partial work. */
    preserveOutputOnTimeout?: boolean;
    onSessionId?: (sessionId: string, conversationId?: string) => void | Promise<void>; onContainerId?: (containerId: string, containerName: string) => void | Promise<void>;
    extraMounts?: string[]; extraEnvVars?: Record<string, string>; streamExtraOutput?: () => string;
    /** Cancels the spawned process and its Docker container when the protected execution loses ownership. */
    signal?: AbortSignal;
}

interface JsonLineMessage { type?: string; message?: { id?: string; model?: string; }; session_id?: string; conversation_id?: string; }

// ANSI escape code regex for stripping terminal formatting (constructed dynamically to avoid control char lint errors)
const ANSI_REGEX = new RegExp('[' + String.fromCharCode(0x1b) + String.fromCharCode(0x9b) + '][[()#;?]*(?:[0-9]{1,4}(?:;[0-9]{0,4})*)?[0-9A-ORZcf-nqry=><]', 'g');

function stripAnsiCodes(text: string): string {
    return text.replace(ANSI_REGEX, '');
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

/**
 * Finds an agent container in any lifecycle state by its exact task label and,
 * when supplied, its attempt-generation label. Name suffixes are intentionally excluded:
 * they are not unique enough to authorize a destructive container stop.
 */
export async function findTaskContainer(taskId: string, attemptGenerationOrExecutor?: string | typeof executeDockerCommand, executor: typeof executeDockerCommand = executeDockerCommand): Promise<RunningTaskContainer | null> {
    const attemptGeneration = typeof attemptGenerationOrExecutor === 'string'
        ? attemptGenerationOrExecutor
        : undefined;
    const commandExecutor = typeof attemptGenerationOrExecutor === 'function'
        ? attemptGenerationOrExecutor
        : executor;
    const filters = attemptGeneration ? [
        '--filter', `label=propr.task.id=${taskId}`,
        '--filter', `label=propr.task.attempt-generation=${attemptGeneration}`,
    ] : ['--filter', `label=propr.task.id=${taskId}`];

    try {
        const result = await commandExecutor('docker', [
            'ps', '-a',
            ...filters,
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

/** Backward-compatible name; lookup now uses exact task labels, not name suffixes. */
export const findRunningDockerContainerForTask = findTaskContainer;

/**
 * Checks for a possibly-live pre-label container by the legacy task suffix.
 * This result is a liveness hint only and must never authorize a stop: two
 * unrelated task IDs can share the same final eight characters.
 */
export async function inspectLegacyDockerContainerLivenessForTask(taskId: string, executor: typeof executeDockerCommand = executeDockerCommand): Promise<LegacyTaskContainerLiveness> {
    const shortTaskId = taskId.slice(-8);
    if (!shortTaskId) return 'not_found';
    const escapedSuffix = shortTaskId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    try {
        const result = await executor('docker', ['ps', '--filter', `name=${escapedSuffix}$`, '--format', '{{.ID}}:{{.Names}}'], { timeout: 10000 });
        if (result.exitCode !== 0) {
            logger.warn({ taskId, stderr: result.stderr }, 'Failed to inspect legacy Docker container liveness for task');
            return 'unavailable';
        }
        return result.stdout.split('\n').some(line => line.trim()) ? 'running' : 'not_found';
    } catch (error) {
        logger.warn({ taskId, error: (error as Error).message }, 'Failed to inspect legacy Docker container liveness for task');
        return 'unavailable';
    }
}

function spawnCommandProcess(
    executablePath: string,
    args: string[],
    cwd: string | undefined,
    stdinData: string | undefined,
): ChildProcess {
    const spawnOptions: SpawnOptions = { stdio: [stdinData ? 'pipe' : 'ignore', 'pipe', 'pipe'], env: process.env };
    if (cwd && fs.existsSync(cwd)) spawnOptions.cwd = cwd;
    else if (cwd) logger.warn({ cwd }, 'Working directory does not exist, spawning from current directory');

    const child = spawn(executablePath, args, spawnOptions);
    if (stdinData && child.stdin) {
        child.stdin.on('error', (err) => { logger.warn({ error: err.message, code: (err as NodeJS.ErrnoException).code }, 'Stdin write error'); });
        child.stdin.write(stdinData);
        child.stdin.end();
        logger.debug({ stdinDataLength: stdinData.length }, 'Wrote prompt data to stdin');
    }
    return child;
}

export function executeDockerCommand(command: string, args: string[], options: DockerCommandOptions = {}): Promise<ExecutionResult> {
    const ownershipContext = getExecutionOwnershipContext();
    const executionSignal = options.signal ?? ownershipContext?.signal;
    const initialAbortError = getExecutionAbortError(executionSignal);
    if (initialAbortError) return Promise.reject(initialAbortError);
    return new Promise((resolve, reject) => {
        const { timeout = 300000, cwd, onSessionId, onContainerId, worktreePath, stdinData, taskId, streamToRedis, streamStderrToRedis, streamExtraOutput, stripAnsi, preserveOutputOnTimeout = false } = options;
        const executionArgs = resolveExecutionArgs(command, args, taskId, ownershipContext?.attemptGeneration);
        const executablePath = resolveDockerPath(command);
        const namedContainer = command === 'docker' ? getDockerRunContainerName(executionArgs) : null;
        const child = spawnCommandProcess(executablePath, executionArgs, cwd, stdinData);

        let stdout = '', stderr = '';
        const state = createDockerExecutionState();
        let callbackFailure: unknown;
        const pendingCallbacks = new Set<Promise<void>>();
        let containerDetectionTimer: ReturnType<typeof setTimeout> | null = null;
        const messageTimestamps = new Map<string, string>();
        const abortForExecutionSignal = (): void => {
            void abortSpawnedExecution(
                child,
                state,
                {
                    namedContainer,
                    scheduleForceKill,
                    taskId,
                    attemptGeneration: ownershipContext?.attemptGeneration,
                },
            );
        };
        const failFromCallback = (error: unknown): void => {
            if (callbackFailure !== undefined) return;
            callbackFailure = error;
            void abortSpawnedExecution(
                child,
                state,
                {
                    namedContainer,
                    scheduleForceKill,
                    taskId,
                    attemptGeneration: ownershipContext?.attemptGeneration,
                },
            );
        };
        const invokeExecutionCallback = (callback: () => void | Promise<void>): void => {
            const callbackPromise = Promise.resolve().then(callback).catch(failFromCallback);
            pendingCallbacks.add(callbackPromise);
            void callbackPromise.finally(() => pendingCallbacks.delete(callbackPromise));
        };
        executionSignal?.addEventListener('abort', abortForExecutionSignal, { once: true });
        const timeoutHandle = setTimeout(() => {
            state.timedOut = true;
            abortForExecutionSignal();
        }, timeout);
        const plannerAbortKey = taskId ? plannerAbortSignalKeyForTask(taskId) : null;
        const abortChecker = taskId && plannerAbortKey
            ? setupAbortChecker({
                taskId,
                plannerAbortKey,
                child,
                state,
                namedContainer,
                attemptGeneration: ownershipContext?.attemptGeneration,
            })
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
        const redisState = { client: null as Redis | null, interval: null as ReturnType<typeof setInterval> | null, lastLen: 0 };
        if (streamToRedis && taskId) initRedisStreaming(taskId, stripAnsi, getRedisOutput, redisState);
        if (command === 'docker' && args[0] === 'run' && worktreePath) {
            containerDetectionTimer = detectContainerId(
                worktreePath,
                state,
                onContainerId,
                invokeExecutionCallback,
            );
        }

        child.stdout?.on('data', (data: Buffer) => {
            const chunk = data.toString(), ts = new Date().toISOString();
            stdout += chunk;
            for (const line of chunk.split('\n')) {
                if (!line.trim()) continue;
                try {
                    const j: JsonLineMessage = JSON.parse(line);
                    if (j.type === 'assistant' || j.type === 'user') messageTimestamps.set(j.message?.id || `${j.type}-${JSON.stringify(j).substring(0, 100)}`, ts);
                    if (!state.sessionIdDetected && onSessionId && j.session_id) {
                        state.sessionIdDetected = true;
                        invokeExecutionCallback(() => onSessionId(j.session_id!, j.conversation_id));
                    }
                } catch { /* skip */ }
            }
        });
        child.stderr?.on('data', (data: Buffer) => { stderr += data.toString(); });

        child.on('close', async (exitCode: number | null) => {
            clearTimeout(timeoutHandle);
            if (containerDetectionTimer) clearTimeout(containerDetectionTimer);
            executionSignal?.removeEventListener('abort', abortForExecutionSignal);
            if (abortChecker) await abortChecker.close();
            await Promise.allSettled([...pendingCallbacks]);
            if (state.teardownPromise) await state.teardownPromise;
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
            if (state.aborted.value) {
                reject(callbackFailure ?? getExecutionAbortError(executionSignal) ?? new ExecutionAbortedError());
                return;
            }
            if (callbackFailure !== undefined) {
                reject(callbackFailure);
                return;
            }
            resolve({ exitCode, stdout, stderr, messageTimestamps });
        });
        child.on('error', async (error: Error) => {
            clearTimeout(timeoutHandle);
            if (containerDetectionTimer) clearTimeout(containerDetectionTimer);
            executionSignal?.removeEventListener('abort', abortForExecutionSignal);
            if (abortChecker) await abortChecker.close();
            await Promise.allSettled([...pendingCallbacks]);
            if (state.teardownPromise) await state.teardownPromise;
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

function detectContainerId(
    worktreePath: string,
    state: { containerIdDetected: boolean; containerId: { value: string | null } },
    onContainerId?: (containerId: string, containerName: string) => void | Promise<void>,
    invokeCallback?: (callback: () => void | Promise<void>) => void,
): ReturnType<typeof setTimeout> {
    return setTimeout(() => {
        if (state.containerIdDetected) return;
        try {
            const out = execSync(`/usr/bin/docker ps --filter "volume=${worktreePath}" --format "{{.ID}}:{{.Names}}" --latest`, { encoding: 'utf8', timeout: 5000 }).trim();
            if (out) {
                const [id, name] = out.split(':');
                state.containerIdDetected = true;
                state.containerId.value = id;
                if (onContainerId && invokeCallback) invokeCallback(() => onContainerId(id, name));
                logger.debug({ containerId: id, containerName: name, worktreePath }, 'Detected Docker container ID');
            }
        } catch (err) { logger.debug({ error: (err as Error).message }, 'Failed to detect container ID'); }
    }, 2000);
}

// Re-export image builder functions for backward compatibility
export { buildClaudeDockerImage, ensureAgentBundleImage, ensureAgentDockerImage } from './dockerImageBuilder.js';
export type { VersionedImageBuildResult } from './dockerImageBuilder.js';
