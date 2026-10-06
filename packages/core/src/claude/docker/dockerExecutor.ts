import { captureWorkflowMarkers, withWorkflowExecutionDeadline } from '../../workflow/workflowExecution.js';
import { spawn, SpawnOptions, ChildProcess } from 'child_process';
import { StringDecoder } from 'node:string_decoder';
import fs from 'fs';
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
import { plannerAbortSignalKeyForTask, scheduleForceKill, setupAbortChecker } from './dockerAbortController.js';
import { BoundedDiagnosticTail, BoundedProviderRecordBuffer, boundedProviderOutput } from '../../agents/impl/utils/boundedProviderOutput.js';
import { inspectSessionMessageLine, SessionLineInspectionContext } from './dockerSessionOutput.js';
import { admitCostExecution, refuseCostExecution, registerCostExecution, settleCostCapStop } from './dockerCostCap.js';
import { startLiveOutputStreaming } from './dockerLiveOutputStreaming.js';
import { detectContainerId } from './dockerContainerDetection.js';
export { getDockerRootDir } from './dockerRootDir.js';

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
    /** Set when ProPR stopped the process because its run reached its spend cap. */
    costCapExceeded?: boolean;
}
export interface RunningTaskContainer { id: string; name: string; }
export type TaskContainerLiveness = 'running' | 'stopped' | 'not_found' | 'unavailable';
export interface TaskContainerInspection {
    liveness: TaskContainerLiveness;
    container: RunningTaskContainer | null;
}
export type LegacyTaskContainerLiveness = 'running' | 'not_found' | 'unavailable';

export interface DockerCommandOptions {
    timeout?: number; cwd?: string; worktreePath?: string; stdinData?: string; taskId?: string; streamToRedis?: boolean; streamStderrToRedis?: boolean; stripAnsi?: boolean;
    /** Resolve with buffered output on timeout or a spend-cap stop so implementation jobs can publish partial work. */
    preserveOutputOnTimeout?: boolean;
    onSessionId?: (sessionId: string, conversationId?: string) => void | Promise<void>; onContainerId?: (containerId: string, containerName: string) => void | Promise<void>;
    extraMounts?: string[]; extraEnvVars?: Record<string, string>; streamExtraOutput?: () => string;
    /** Cancels the spawned process and its Docker container when the protected execution loses ownership. */
    signal?: AbortSignal;
    /** Resolved model the agent runs, used to price streamed usage that does not name its model. */
    model?: string;
    /** A container that runs no agent and spends nothing (e.g. a usage probe): not counted toward, or refused by, the run's spend cap. */
    costCapExempt?: boolean;
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

const LIVE_CONTAINER_STATES = new Set(['running', 'paused', 'restarting']);
const STOPPED_CONTAINER_STATES = new Set(['created', 'exited', 'dead']);

/**
 * Inspects exact task-labelled containers without treating preserved stopped
 * containers as evidence that an agent is still executing. Unknown Docker
 * states and daemon failures remain unavailable so callers can fail closed.
 */
export async function inspectTaskContainerLivenessForTask(
    taskId: string,
    executor: typeof executeDockerCommand = executeDockerCommand,
): Promise<TaskContainerInspection> {
    try {
        const result = await executor('docker', [
            'ps', '-a',
            '--filter', `label=propr.task.id=${taskId}`,
            '--format', '{{.ID}}\t{{.Names}}\t{{.State}}',
        ], { timeout: 10000 });
        if (result.exitCode !== 0) {
            logger.warn({ taskId, stderr: result.stderr }, 'Failed to inspect Docker container liveness for task');
            return { liveness: 'unavailable', container: null };
        }

        let stoppedContainer: RunningTaskContainer | null = null;
        for (const line of result.stdout.split('\n').map(value => value.trim()).filter(Boolean)) {
            const [id, name, rawState, ...unexpected] = line.split('\t');
            const container = id && name ? { id, name } : null;
            const state = rawState?.trim().toLowerCase();
            if (!container || unexpected.length > 0 || !state) {
                logger.warn({ taskId, output: line }, 'Docker returned an unknown task container record');
                return { liveness: 'unavailable', container };
            }
            if (LIVE_CONTAINER_STATES.has(state)) return { liveness: 'running', container };
            if (!STOPPED_CONTAINER_STATES.has(state)) {
                logger.warn({ taskId, containerId: id, state }, 'Docker returned an unknown task container state');
                return { liveness: 'unavailable', container };
            }
            stoppedContainer ??= container;
        }
        return stoppedContainer
            ? { liveness: 'stopped', container: stoppedContainer }
            : { liveness: 'not_found', container: null };
    } catch (error) {
        logger.warn({ taskId, error: (error as Error).message }, 'Failed to inspect Docker container liveness for task');
        return { liveness: 'unavailable', container: null };
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
    const initialAbortError = getExecutionAbortError(executionSignal);
    if (initialAbortError) return Promise.reject(initialAbortError);
    // A chargeable container starts only once its run's cap admitted it: a run
    // whose recorded spend already reaches the cap launches nothing.
    const admission = admitCostExecution(command, args, options);
    if (!admission) return startDockerCommand(command, args, options, { ownershipContext, executionSignal });
    return admission.then(refusal => {
        if (refusal) return refuseCostExecution(refusal, options.preserveOutputOnTimeout ?? false);
        const abortError = getExecutionAbortError(executionSignal);
        if (abortError) throw abortError;
        return startDockerCommand(command, args, options, { ownershipContext, executionSignal });
    });
}

function startDockerCommand(
    command: string,
    args: string[],
    options: DockerCommandOptions,
    { ownershipContext, executionSignal }: { ownershipContext: ReturnType<typeof getExecutionOwnershipContext>; executionSignal: AbortSignal | undefined },
): Promise<ExecutionResult> {
    return new Promise((resolve, reject) => {
        const { timeout = 300000, cwd, onSessionId, onContainerId, worktreePath, stdinData, taskId, streamToRedis, streamStderrToRedis, streamExtraOutput, stripAnsi, preserveOutputOnTimeout = false, model, costCapExempt } = options;
        const executionArgs = resolveExecutionArgs(command, withWorkflowExecutionDeadline(command, args, timeout), taskId, ownershipContext?.attemptGeneration);
        const executablePath = resolveDockerPath(command);
        const namedContainer = command === 'docker' ? getDockerRunContainerName(executionArgs) : null;
        // Agent containers count toward their run's spend cap; reaching it stops
        // them like a timeout, so their partial work can still be published. Once
        // the run was stopped at its cap, a new agent container is refused before
        // it starts.
        let stopForCostCap: (message: string) => void = () => undefined;
        const costCap = registerCostExecution(command, args, { model, costCapExempt }, message => stopForCostCap(message));
        if ('refusal' in costCap) {
            refuseCostExecution(costCap.refusal, preserveOutputOnTimeout).then(resolve, reject);
            return;
        }
        const costExecution = costCap.execution;
        let child: ReturnType<typeof spawnCommandProcess>;
        try { child = spawnCommandProcess(executablePath, executionArgs, cwd, stdinData); } catch (error) {
            // A container that never started must not stay registered with the guard.
            void costExecution?.finish().catch(() => null);
            throw error;
        }

        let sessionLineBuffer = '';
        const stderrTail = new BoundedDiagnosticTail(), workflowMarkers = captureWorkflowMarkers(args);
        // Built on read only (it costs the whole bounded output), never per chunk.
        const stdoutBuffer = new BoundedProviderRecordBuffer();
        const readStdout = (): string => stdoutBuffer.output;
        const stdoutDecoder = new StringDecoder('utf8');
        const stderrDecoder = new StringDecoder('utf8');
        const state = createDockerExecutionState();
        let ownershipFailure: unknown;
        let hasOwnershipFailure = false;
        let processError: Error | undefined;
        let timeoutInitiatedAbort = false;
        let costCapStopMessage: string | null = null;
        const pendingCallbacks = new Set<Promise<void>>();
        let containerDetectionTimer: ReturnType<typeof setTimeout> | null = null;
        const messageTimestamps = new Map<string, string>();
        const abortExecution = (executionTimeout = false): void => {
            void abortSpawnedExecution(
                child,
                state,
                {
                    namedContainer,
                    scheduleForceKill,
                    // A command timeout belongs only to this subprocess. Using
                    // the task-generation fence here leaves a teardown sweep
                    // running for several seconds, which can kill the next
                    // analysis container started by the same task. Ownership
                    // loss and explicit cancellation still require the broad,
                    // generation-fenced cleanup below.
                    taskId: executionTimeout ? undefined : taskId,
                    attemptGeneration: executionTimeout ? undefined : ownershipContext?.attemptGeneration,
                },
            );
        };
        const preserveOwnershipFailure = (error: unknown): void => {
            if (hasOwnershipFailure) return;
            hasOwnershipFailure = true;
            ownershipFailure = error;
        };
        const abortForExecutionSignal = (): void => {
            preserveOwnershipFailure(getExecutionAbortError(executionSignal) ?? new ExecutionAbortedError());
            abortExecution();
        };
        const failFromCallback = (error: unknown): void => {
            preserveOwnershipFailure(error);
            abortExecution();
        };
        const warnFromLiveOutput = (error: Error): void => {
            logger.warn({ error: error.message, taskId }, 'Live output unavailable; continuing agent execution');
        };
        const invokeExecutionCallback = (callback: () => void | Promise<void>): void => {
            const callbackPromise = Promise.resolve().then(callback).catch(failFromCallback);
            pendingCallbacks.add(callbackPromise);
            void callbackPromise.finally(() => pendingCallbacks.delete(callbackPromise));
        };
        const sessionInspectionContext: SessionLineInspectionContext = {
            messageTimestamps,
            state,
            onSessionId,
            invokeExecutionCallback,
        };
        const inspectSessionLines = (chunk: string, timestamp: string, flush = false): void => {
            sessionLineBuffer = boundedProviderOutput(sessionLineBuffer + chunk);
            const lines = sessionLineBuffer.split('\n');
            const remainder = lines.pop() ?? '';
            sessionLineBuffer = flush ? '' : remainder;
            if (flush && remainder) lines.push(remainder);
            for (const line of lines) {
                inspectSessionMessageLine(line, timestamp, sessionInspectionContext);
                costExecution?.observeLine(line);
            }
        };
        // The guard evaluates asynchronously, so no stop arrives before this is set.
        stopForCostCap = message => {
            if (state.aborted.value) return;
            costCapStopMessage = message;
            abortExecution(true);
        };
        // Awaits the final evaluation, so usage streamed after the last periodic
        // check still ends the execution with the spend-cap outcome.
        const finishCostExecution = async (): Promise<void> => {
            const message = await costExecution?.finish().catch(() => null);
            if (message && !costCapStopMessage && !state.aborted.value) costCapStopMessage = message;
        };
        executionSignal?.addEventListener('abort', abortForExecutionSignal, { once: true });
        const timeoutHandle = setTimeout(() => {
            state.timedOut = true;
            timeoutInitiatedAbort = !state.aborted.value;
            abortExecution(true);
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

        const liveOutput = startLiveOutputStreaming({ taskId, streamToRedis, streamStderrToRedis, streamExtraOutput, stripAnsi, onOverflow: warnFromLiveOutput }, readStdout, () => stderrTail.value);
        if (command === 'docker' && args[0] === 'run' && worktreePath) {
            containerDetectionTimer = detectContainerId(
                worktreePath,
                state,
                onContainerId,
                invokeExecutionCallback,
            );
        }

        child.stdout?.on('data', (data: Buffer) => {
            const chunk = stdoutDecoder.write(data), ts = new Date().toISOString();
            stdoutBuffer.append(chunk);
            liveOutput?.stdout(chunk);
            inspectSessionLines(chunk, ts);
        });
        child.stderr?.on('data', (data: Buffer) => {
            const chunk = stderrDecoder.write(data);
            stderrTail.append(chunk);
            workflowMarkers?.append(chunk);
            liveOutput?.stderr(chunk);
        });

        child.on('close', async (exitCode: number | null) => {
            clearTimeout(timeoutHandle);
            const finalStdout = stdoutDecoder.end();
            if (finalStdout) stdoutBuffer.append(finalStdout);
            const finalStderr = stderrDecoder.end();
            stderrTail.append(finalStderr);
            const stderr = stderrTail.value;
            workflowMarkers?.finish(finalStderr);
            liveOutput?.stdout(finalStdout);
            liveOutput?.stderr(finalStderr);
            inspectSessionLines(finalStdout, new Date().toISOString(), true);
            if (containerDetectionTimer) clearTimeout(containerDetectionTimer);
            await finishCostExecution();
            if (abortChecker) await abortChecker.close();
            await Promise.allSettled([...pendingCallbacks]);
            if (state.teardownPromise) await state.teardownPromise;
            executionSignal?.removeEventListener('abort', abortForExecutionSignal);
            try { await liveOutput?.close(); }
            catch (error) { logger.warn({ error: (error as Error).message, taskId }, 'Failed to publish final live output'); }
            const executionAbortError = getExecutionAbortError(executionSignal);
            if (executionAbortError) preserveOwnershipFailure(executionAbortError);
            if (hasOwnershipFailure) {
                reject(ownershipFailure);
                return;
            }
            if (processError) { reject(processError); return; }
            if (costCapStopMessage) {
                settleCostCapStop(costCapStopMessage, { exitCode, stdout: readStdout(), stderr, messageTimestamps }, { preserveOutput: preserveOutputOnTimeout, resolve, reject });
                return;
            }
            if (state.aborted.value && !timeoutInitiatedAbort) {
                reject(new ExecutionAbortedError());
                return;
            }
            if (state.timedOut) {
                const timeoutMessage = `Command timed out after ${timeout}ms`;
                const timeoutStderr = stderr.trim() ? `${stderr.trimEnd()}\n${timeoutMessage}` : timeoutMessage;
                if (preserveOutputOnTimeout) {
                    resolve({ exitCode, stdout: readStdout(), stderr: timeoutStderr, messageTimestamps, timedOut: true, timeoutMs: timeout });
                } else {
                    reject(new Error(timeoutMessage));
                }
                return;
            }
            resolve({ exitCode, stdout: readStdout(), stderr, messageTimestamps });
        });
        child.on('error', async (error: Error) => {
            // close may run during cleanup; capture the process result before awaiting.
            processError = error;
            clearTimeout(timeoutHandle);
            inspectSessionLines('', new Date().toISOString(), true);
            if (containerDetectionTimer) clearTimeout(containerDetectionTimer);
            await finishCostExecution();
            executionSignal?.removeEventListener('abort', abortForExecutionSignal);
            if (abortChecker) await abortChecker.close();
            await Promise.allSettled([...pendingCallbacks]);
            if (state.teardownPromise) await state.teardownPromise;
            await liveOutput?.close().catch(() => undefined);
            reject(hasOwnershipFailure ? ownershipFailure : error);
        });
    });
}

export { agentDockerImageExists, buildClaudeDockerImage, ensureAgentBundleImage, ensureAgentDockerImage } from './dockerImageBuilder.js';
export type { VersionedImageBuildResult } from './dockerImageBuilder.js';
