import { spawn, execSync, SpawnOptions, ChildProcess } from 'child_process';
import fs from 'fs';
import { AsyncLocalStorage } from 'node:async_hooks';
import { Redis } from 'ioredis';
import logger from '../../utils/logger.js';
import {
    abortSpawnedExecution,
    getExecutionOwnershipContext,
    resolveExecutionArgs,
} from './dockerExecutionOwnership.js';

export { stopDockerContainer } from './dockerContainerControl.js';
export {
    addTaskAttemptLabelsToDockerArgs,
    runWithExecutionAbortSignal,
} from './dockerExecutionOwnership.js';


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
    onSessionId?: (sessionId: string, conversationId?: string) => void; onContainerId?: (containerId: string, containerName: string) => void;
    extraMounts?: string[]; extraEnvVars?: Record<string, string>; streamExtraOutput?: () => string;
    /** Cancels the spawned process and its Docker container when the protected execution loses ownership. */
    signal?: AbortSignal;
}

interface JsonLineMessage { type?: string; message?: { id?: string; model?: string; }; session_id?: string; conversation_id?: string; }

interface AbortCheckerOptions {
    taskId: string;
    plannerAbortKey: string;
    child: ChildProcess;
    state: {
        aborted: { value: boolean };
        containerId: { value: string | null };
        teardownPromise: Promise<void> | null;
    };
    namedContainer: string | null;
    attemptGeneration?: string;
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

function resolveDockerPath(command: string): string {
    if (command !== 'docker') return command;
    const paths = ['/usr/bin/docker', '/usr/local/bin/docker', '/bin/docker'];
    for (const p of paths) {
        try { if (fs.existsSync(p)) { fs.accessSync(p, fs.constants.X_OK); logger.debug({ dockerPath: p }, 'Found docker executable'); return p; } } catch { /* continue */ }
    }
    logger.debug('Using docker from PATH');
    return 'docker';
}

const PLANNER_ABORT_LOOKUP_FAILURE_LIMIT = 2;

function scheduleForceKill(child: ChildProcess): void {
    const timer = setTimeout(() => {
        if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    }, 5000);
    timer.unref();
}

/**
 * Planner cancellation fails closed after sustained Redis unavailability. One
 * isolated read failure is tolerated because the next two-second poll can
 * recover; any successful read resets the consecutive-failure count.
 */
export function shouldTerminateAfterAbortLookupFailure(plannerAbortKey: string, consecutiveFailures: number): boolean {
    return plannerAbortKey.includes(':run:') && consecutiveFailures >= PLANNER_ABORT_LOOKUP_FAILURE_LIMIT;
}

function setupAbortChecker({ taskId, plannerAbortKey, child, state, namedContainer, attemptGeneration }: AbortCheckerOptions): AbortCheckerHandle {
    const redis = createAbortRedis();
    let pollInFlight = false;
    let active = true;
    let consecutiveLookupFailures = 0;
    let closePromise: Promise<void> | null = null;
    const terminateExecution = async (message: string): Promise<void> => {
        if (state.aborted.value) return;
        logger.info({ taskId, containerId: state.containerId.value || namedContainer }, message);
        await abortSpawnedExecution(
            child,
            state,
            { namedContainer, scheduleForceKill, taskId, attemptGeneration },
        );
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
 * Finds a running agent container by its exact task label and, when supplied,
 * its attempt-generation label. Name suffixes are intentionally excluded:
 * they are not unique enough to authorize a destructive container stop.
 */
export async function findRunningDockerContainerForTask(taskId: string, attemptGenerationOrExecutor?: string | typeof executeDockerCommand, executor: typeof executeDockerCommand = executeDockerCommand): Promise<RunningTaskContainer | null> {
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
            'ps',
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
    if (executionSignal?.aborted) {
        return Promise.reject(executionSignal.reason instanceof Error
            ? executionSignal.reason
            : new ExecutionAbortedError());
    }
    return new Promise((resolve, reject) => {
        const { timeout = 300000, cwd, onSessionId, onContainerId, worktreePath, stdinData, taskId, streamToRedis, streamStderrToRedis, streamExtraOutput, stripAnsi, preserveOutputOnTimeout = false } = options;
        const executionArgs = resolveExecutionArgs(command, args, taskId, ownershipContext?.attemptGeneration);
        const executablePath = resolveDockerPath(command);
        const namedContainer = command === 'docker' ? getDockerRunContainerName(executionArgs) : null;
        const child = spawnCommandProcess(executablePath, executionArgs, cwd, stdinData);

        let stdout = '', stderr = '';
        const state = {
            timedOut: false,
            aborted: { value: false },
            sessionIdDetected: false,
            containerIdDetected: false,
            containerId: { value: null as string | null },
            teardownPromise: null as Promise<void> | null,
        };
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
            executionSignal?.removeEventListener('abort', abortForExecutionSignal);
            if (abortChecker) await abortChecker.close();
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
                reject(executionSignal?.aborted && executionSignal.reason instanceof Error
                    ? executionSignal.reason
                    : new ExecutionAbortedError());
                return;
            }
            resolve({ exitCode, stdout, stderr, messageTimestamps });
        });
        child.on('error', async (error: Error) => {
            clearTimeout(timeoutHandle);
            executionSignal?.removeEventListener('abort', abortForExecutionSignal);
            if (abortChecker) await abortChecker.close();
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
