import { startRunPipeline } from '../../agents/runtime/runPipeline.js';
import { extensionLaunchForRun } from '../../extensions/extensionLaunchContext.js';
import { assertNativeLogAdmission, type DiagnosticAgent } from '../../diagnostics/managedLogRuntime.js';
import { createExecutionDeadline, type ExecutionDeadline } from './dockerExecutionDeadline.js';
import { prepareAdmittedAgent, type AdmittedAgent, type AgentAdmissionExemption } from '../../agents/agentRunAdmission.js';
import { withWorkflowExecutionDeadline } from '../../workflow/workflowExecution.js';
import { spawn, SpawnOptions, ChildProcess } from 'child_process';
import fs from 'fs';
import logger from '../../utils/logger.js';
import {
    abortSpawnedExecution, createDockerExecutionState, ExecutionAbortedError,
    getExecutionAbortError, getDockerRunContainerName, getExecutionOwnershipContext, resolveExecutionArgs,
} from './dockerExecutionOwnership.js';
import { plannerAbortSignalKeyForTask, scheduleForceKill, setupAbortChecker } from './dockerAbortController.js';
import { admitCostExecution, refuseCostExecution, settleCostCapStop } from './dockerCostCap.js';
import { detectContainerId } from './dockerContainerDetection.js';
import type { AgentWatchdogTrip } from './agentActivityWatchdog.js';
import type { AgentRunComputeUsage } from '../../agents/runtime/computeUsage.js';
import type { ExecutionWatchdogOptions } from './dockerExecutionWatchdog.js';
import { settleTimeoutStop, settleWatchdogStop } from './dockerExecutionSettlement.js';
import { startWithNetworkPolicy, type NetworkPolicyOptions } from './dockerNetworkPolicy.js';
import { startsContainer, type AgentRunLaunch } from '../../agents/runtime/agentRunLaunch.js';
export { getDockerRootDir } from './dockerRootDir.js';

export { stopDockerContainer } from './dockerContainerControl.js';
export {
    addTaskAttemptLabelsToDockerArgs, ExecutionAbortedError, runWithExecutionAbortSignal,
} from './dockerExecutionOwnership.js';
export {
    buildPlannerAbortSignalKey, checkAbortSignal, clearWorkerAbortSignal,
    plannerAbortSignalKeyForTask, runWithPlannerAbortContext, shouldTerminateAfterAbortLookupFailure,
} from './dockerAbortController.js';
export type { AbortRedisClient, AbortRedisFactory } from './dockerAbortController.js';


export interface ExecutionResult {
    stdout: string;
    stderr: string;
    exitCode: number | null;
    messageTimestamps: Map<string, string>;
    /** Transport failure surfaced after the workspace has been retrieved. */
    outputIncomplete?: string;
    /** Set when ProPR stopped the process after its configured execution deadline. */
    timedOut?: boolean;
    timeoutMs?: number;
    /** Set when ProPR stopped the process because its run reached its spend cap. */
    costCapExceeded?: boolean;
    /** Set when the stall/degenerate-output watchdog stopped the process. */
    watchdogTrip?: AgentWatchdogTrip;
    /** What the agent's sandbox consumed; set by the agent runtime for agent runs only. */
    computeUsage?: AgentRunComputeUsage;
}
export interface RunningTaskContainer { id: string; name: string; }
export type TaskContainerLiveness = 'running' | 'stopped' | 'not_found' | 'unavailable';
export interface TaskContainerInspection {
    liveness: TaskContainerLiveness;
    container: RunningTaskContainer | null;
}
export type LegacyTaskContainerLiveness = 'running' | 'not_found' | 'unavailable';

/**
 * `watchdog` / `onWatchdogTrip` control the stall and degenerate-output
 * watchdog (see {@link startExecutionWatchdog}); it is on by default for
 * streamed agent runs that preserve partial output.
 */
export interface DockerCommandOptions extends Pick<ExecutionWatchdogOptions, 'watchdog' | 'onWatchdogTrip'>, NetworkPolicyOptions {
    diagnostics?: DiagnosticAgent;
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
    /** Explicitly identifies the selected agent launch, excluding helper containers. */
    extensionAgentLaunch?: boolean;
    /** Direct agent alias charged by physical admission (never a synthetic alias). */
    agentAlias?: string;
    /** Documented agent launch without a registered alias: charged to the global admission limit only. */
    agentAdmissionExemption?: AgentAdmissionExemption;
    /** Set by an agent runtime: the run spec this launch renders, and its output stream sink. */
    agentRun?: AgentRunLaunch;
}

/**
 * Finds an agent container in any lifecycle state by its exact task label and,
 * when supplied, its attempt-generation label. Name suffixes are intentionally excluded:
 * they are not unique enough to authorize a destructive container stop.
 */
export async function findTaskContainer(taskId: string, attemptGenerationOrExecutor?: string | typeof executeDockerCommand, executor: typeof executeDockerCommand = executeDockerCommand): Promise<RunningTaskContainer | null> {
    const attemptGeneration = typeof attemptGenerationOrExecutor === 'string' ? attemptGenerationOrExecutor : undefined;
    const commandExecutor = typeof attemptGenerationOrExecutor === 'function' ? attemptGenerationOrExecutor : executor;
    const filters = attemptGeneration ? [
        '--filter', `label=propr.task.id=${taskId}`,
        '--filter', `label=propr.task.attempt-generation=${attemptGeneration}`,
    ] : ['--filter', `label=propr.task.id=${taskId}`];

    try {
        const result = await commandExecutor('docker', ['ps', '-a', ...filters, '--format', '{{.ID}}:{{.Names}}'], { timeout: 10000 });
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
export async function inspectTaskContainerLivenessForTask(taskId: string, executor: typeof executeDockerCommand = executeDockerCommand): Promise<TaskContainerInspection> {
    try {
        const result = await executor('docker', [
            'ps', '-a', '--filter', `label=propr.task.id=${taskId}`,
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
    executablePath: string, args: string[],
    { cwd, stdinData, extraEnvVars, environment }: { cwd?: string; stdinData?: string; extraEnvVars?: Record<string, string>; environment?: NodeJS.ProcessEnv },
): ChildProcess {
    // Extra variables reach the container through `-e NAME`, keeping their values out of the argument list.
    const env = environment ?? (extraEnvVars && Object.keys(extraEnvVars).length > 0 ? { ...process.env, ...extraEnvVars } : process.env);
    const spawnOptions: SpawnOptions = { stdio: [stdinData ? 'pipe' : 'ignore', 'pipe', 'pipe'], env };
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

export async function executeDockerCommand(command: string, args: string[], options: DockerCommandOptions = {}): Promise<ExecutionResult> {
    const extensions = extensionLaunchForRun(command, args, options);
    if (extensions) {
        args = [args[0], ...extensions.mounts, ...args.slice(1)];
    }
    const ownershipContext = getExecutionOwnershipContext();
    const timeout = options.timeout ?? 300000;
    const { deadline, executionSignal, timeoutError } = createExecutionDeadline(timeout, options.signal, ownershipContext?.signal);
    try {
        // A chargeable container starts only once its run's cap admitted it.
        const admission = admitCostExecution(command, args, options);
        if (admission) {
            const refusal = await admission;
            deadline.remaining();
            if (refusal) return await refuseCostExecution(refusal, options.preserveOutputOnTimeout ?? false);
        }
        return await startWithNetworkPolicy(command, args, { executionSignal, networkPolicyExempt: options.networkPolicyExempt },
            runArgs => startDockerCommand(command, runArgs, options, { ownershipContext, executionSignal, deadline, timeoutError }));
    } catch (error) {
        if (error !== timeoutError) throw error;
        return await new Promise<ExecutionResult>((resolve, reject) => settleTimeoutStop(timeout,
            { exitCode: null, stdout: '', stderr: '', messageTimestamps: new Map() },
            options.preserveOutputOnTimeout ?? false, { resolve, reject }));
    } finally {
        deadline.stop();
    }
}

async function startDockerCommand(
    command: string, args: string[], options: DockerCommandOptions,
    { ownershipContext, executionSignal, deadline, timeoutError }: { ownershipContext: ReturnType<typeof getExecutionOwnershipContext>; executionSignal: AbortSignal | undefined; deadline: ExecutionDeadline; timeoutError: Error },
): Promise<ExecutionResult> {
    const containerLaunch = startsContainer(command, args, options);
    if (containerLaunch) assertNativeLogAdmission(options.diagnostics);
    const executionArgs = resolveExecutionArgs(command, args, options.taskId, ownershipContext?.attemptGeneration);
    const extensionValidationWindow = {};
    deadline.remaining();
    await extensionLaunchForRun(command, args, options)?.beforeLaunch(extensionValidationWindow, false);
    const admission = containerLaunch && !options.costCapExempt
        ? await prepareAdmittedAgent(executionArgs, {
            createArgs: async () => {
                await extensionLaunchForRun(command, args, options)?.beforeLaunch(extensionValidationWindow);
                return withWorkflowExecutionDeadline(command, executionArgs, deadline.remaining());
            },
            signal: executionSignal, taskId: options.taskId, extraEnvVars: options.extraEnvVars,
            agentAlias: options.agentAlias, exemption: options.agentAdmissionExemption, timeoutReason: timeoutError,
            cwd: options.cwd && fs.existsSync(options.cwd) ? options.cwd : undefined,
        })
        : null;
    try {
        const abortError = getExecutionAbortError(admission?.signal);
        if (abortError) throw abortError;
        await extensionLaunchForRun(command, args, options)?.beforeLaunch(extensionValidationWindow);
        const remainingMs = deadline.remaining();
        // Transfer the same budget to the subprocess timer. Keep timeout reporting
        // in terms of the caller's original limit and preserve partial output.
        deadline.stop();
        return await runDockerCommand(command, args, options, { ownershipContext, executionSignal: admission?.signal ?? executionSignal, admission, remainingMs });
    } finally {
        await admission?.finish();
    }
}

function runDockerCommand(
    command: string, args: string[], options: DockerCommandOptions,
    { ownershipContext, executionSignal, admission, remainingMs }: { ownershipContext: ReturnType<typeof getExecutionOwnershipContext>; executionSignal: AbortSignal | undefined; admission: AdmittedAgent | null; remainingMs: number },
): Promise<ExecutionResult> {
    // eslint-disable-next-line complexity -- subprocess capture, cancellation and settlement share one execution lifecycle
    return new Promise((resolve, reject) => {
        const { timeout = 300000, cwd, onContainerId, worktreePath, stdinData, extraEnvVars, taskId, preserveOutputOnTimeout = false } = options;
        const executionArgs = resolveExecutionArgs(command, withWorkflowExecutionDeadline(command, args, remainingMs), taskId, ownershipContext?.attemptGeneration);
        const executablePath = command;
        const namedContainer = options.agentRun?.spec.name ?? (command === 'docker' ? getDockerRunContainerName(executionArgs) : null);
        let child: ReturnType<typeof spawnCommandProcess>;
        const state = createDockerExecutionState();
        if (admission) state.containerId.value = admission.id;
        let ownershipFailure: unknown;
        let hasOwnershipFailure = false;
        let processError: Error | undefined;
        let timeoutInitiatedAbort = false;
        let costCapStopMessage: string | null = null;
        const pendingCallbacks = new Set<Promise<void>>();
        let containerDetectionTimer: ReturnType<typeof setTimeout> | null = null;
        const abortExecution = (executionTimeout = false): void => {
            void abortSpawnedExecution(child, state, {
                namedContainer, scheduleForceKill,
                // A command timeout belongs only to this subprocess. Using
                // the task-generation fence here leaves a teardown sweep
                // running for several seconds, which can kill the next
                // analysis container started by the same task. Ownership
                // loss and explicit cancellation still require the broad,
                // generation-fenced cleanup below.
                taskId: executionTimeout ? undefined : taskId,
                attemptGeneration: executionTimeout ? undefined : ownershipContext?.attemptGeneration,
            });
        };
        const stopForWatchdog = () => {
            // A run already being stopped (deadline, user, ownership) keeps that outcome.
            if (state.aborted.value || state.timedOut) return false;
            clearTimeout(timeoutHandle);
            timeoutInitiatedAbort = true;
            // Same subprocess-scoped stop path as the execution deadline.
            abortExecution(true);
            return true;
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
        const invokeExecutionCallback = (callback: () => void | Promise<void>): void => {
            const callbackPromise = Promise.resolve().then(callback).catch(failFromCallback);
            pendingCallbacks.add(callbackPromise);
            void callbackPromise.finally(() => pendingCallbacks.delete(callbackPromise));
        };
        const launch = startRunPipeline(options, {
            markerArgs: args, diagnosticArgs: admission?.args ?? executionArgs, createArgs: executionArgs,
            environment: { ...options.extraEnvVars, ...admission?.environment }, attempt: ownershipContext?.attemptGeneration,
            command, stopForWatchdog, stopForCostCap, invokeExecutionCallback,
        });
        if (launch.refusal) { launch.refusal.then(resolve, reject); return; }
        const { pipeline } = launch;
        const { watchdog } = pipeline;
        try { child = spawnCommandProcess(executablePath, admission?.args ?? executionArgs, { cwd, stdinData, extraEnvVars, environment: admission?.environment }); }
        catch (error) {
            pipeline.finishOutput();
            void pipeline.closeLive();
            void pipeline.finishCost()?.catch(() => null);
            throw error;
        }
        options.agentRun?.onSpawn?.();
        function stopForCostCap(message: string) {
            if (state.aborted.value) return;
            costCapStopMessage = message;
            abortExecution(true);
        }
        // Awaits the final evaluation, so usage streamed after the last periodic
        // check still ends the execution with the spend-cap outcome.
        const finishCostExecution = async (): Promise<void> => {
            const message = await pipeline.finishCost()?.catch(() => null);
            if (message && !costCapStopMessage && !state.aborted.value) costCapStopMessage = message;
        };
        executionSignal?.addEventListener('abort', abortForExecutionSignal, { once: true });
        const timeoutHandle = setTimeout(() => {
            if (watchdog.trip) return;
            state.timedOut = true;
            timeoutInitiatedAbort = !state.aborted.value;
            abortExecution(true);
        }, remainingMs);
        const plannerAbortKey = taskId ? plannerAbortSignalKeyForTask(taskId) : null;
        const abortChecker = taskId && plannerAbortKey
            ? setupAbortChecker({
                taskId, plannerAbortKey, child, state, namedContainer,
                attemptGeneration: ownershipContext?.attemptGeneration,
            })
            : null;

        const detectExecutionContainer = () => {
            if (admission) {
                // Admission already owns the immutable ID. A volume-based lookup
                // could pick a sibling execution sharing the same worktree.
                state.containerIdDetected = true;
                if (onContainerId) invokeExecutionCallback(() => onContainerId(admission.id, namedContainer ?? admission.id));
            } else if (startsContainer(command, args, options) && worktreePath) {
                containerDetectionTimer = detectContainerId(worktreePath, state, onContainerId, invokeExecutionCallback);
            }
        };
        detectExecutionContainer();

        child.stdout?.on('data', (data: Buffer) => pipeline.write('stdout', data));
        child.stderr?.on('data', (data: Buffer) => pipeline.write('stderr', data));

        const finishExecution = async (beforeAbortClose?: () => void) => {
            if (containerDetectionTimer) clearTimeout(containerDetectionTimer);
            await finishCostExecution();
            beforeAbortClose?.();
            await abortChecker?.close();
            await Promise.allSettled([...pendingCallbacks]);
            await state.teardownPromise;
        };
        child.on('close', async (exitCode: number | null) => {
            clearTimeout(timeoutHandle);
            pipeline.finishOutput();
            const result = pipeline.result(exitCode);
            await finishExecution();
            await watchdog.settled();
            executionSignal?.removeEventListener('abort', abortForExecutionSignal);
            await pipeline.closeLive();
            const executionAbortError = getExecutionAbortError(executionSignal);
            if (executionAbortError) preserveOwnershipFailure(executionAbortError);
            if (hasOwnershipFailure) { reject(ownershipFailure); return; }
            if (processError) { reject(processError); return; }
            if (costCapStopMessage) {
                settleCostCapStop(costCapStopMessage, result, { preserveOutput: preserveOutputOnTimeout, resolve, reject });
                return;
            }
            if (state.aborted.value && !timeoutInitiatedAbort) { reject(new ExecutionAbortedError()); return; }
            if (watchdog.trip) {
                settleWatchdogStop(watchdog.trip, result, preserveOutputOnTimeout, { resolve, reject });
                return;
            }
            if (state.timedOut) {
                settleTimeoutStop(timeout, result, preserveOutputOnTimeout, { resolve, reject });
                return;
            }
            resolve(result);
        });
        child.on('error', async (error: Error) => {
            // close may run during cleanup; capture the process result before awaiting.
            processError = error;
            clearTimeout(timeoutHandle);
            watchdog.stop();
            await finishExecution(() => executionSignal?.removeEventListener('abort', abortForExecutionSignal));
            await pipeline.closeLive();
            reject(hasOwnershipFailure ? ownershipFailure : error);
        });
    });
}

export { agentDockerImageExists, buildClaudeDockerImage, ensureAgentBundleImage, ensureAgentDockerImage } from './dockerImageBuilder.js';
export type { VersionedImageBuildResult } from './dockerImageBuilder.js';
