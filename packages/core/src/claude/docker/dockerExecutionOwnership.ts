import type { ChildProcess } from 'node:child_process';
import { AsyncLocalStorage } from 'node:async_hooks';
import { teardownDockerExecution } from './dockerContainerControl.js';

interface ExecutionOwnershipContext {
    signal: AbortSignal;
    /** One-way identifier for the PR attempt that owns this container. */
    attemptGeneration?: string;
}

export interface SpawnedExecutionState {
    aborted: { value: boolean };
    containerId: { value: string | null };
    teardownPromise: Promise<void> | null;
}

export interface DockerExecutionState extends SpawnedExecutionState {
    timedOut: boolean;
    sessionIdDetected: boolean;
    containerIdDetected: boolean;
}

export class ExecutionAbortedError extends Error {
    constructor(message: string = 'Execution aborted by user request') {
        super(message);
        this.name = 'ExecutionAbortedError';
    }
}

export function createDockerExecutionState(): DockerExecutionState {
    return {
        timedOut: false,
        aborted: { value: false },
        sessionIdDetected: false,
        containerIdDetected: false,
        containerId: { value: null },
        teardownPromise: null,
    };
}

export function getExecutionAbortError(signal?: AbortSignal): Error | null {
    if (!signal?.aborted) return null;
    return signal.reason instanceof Error ? signal.reason : new ExecutionAbortedError();
}

interface AbortSpawnedExecutionOptions {
    namedContainer: string | null;
    scheduleForceKill: (child: ChildProcess) => void;
    taskId?: string;
    attemptGeneration?: string;
}

const executionOwnershipContext = new AsyncLocalStorage<ExecutionOwnershipContext>();

function waitForChildTermination(child: ChildProcess): Promise<void> {
    if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
    return new Promise(resolve => {
        child.once('exit', () => resolve());
    });
}

export function runWithExecutionAbortSignal<T>(
    signal: AbortSignal,
    operation: () => Promise<T>,
    attemptGeneration?: string,
): Promise<T> {
    return executionOwnershipContext.run({ signal, attemptGeneration }, operation);
}

export function getExecutionOwnershipContext(): ExecutionOwnershipContext | undefined {
    return executionOwnershipContext.getStore();
}

export function abortSpawnedExecution(
    child: ChildProcess,
    state: SpawnedExecutionState,
    options: AbortSpawnedExecutionOptions,
): Promise<void> {
    if (state.aborted.value) return state.teardownPromise ?? Promise.resolve();
    state.aborted.value = true;
    const teardownOptions = {
        taskId: options.taskId,
        attemptGeneration: options.attemptGeneration,
        containerId: state.containerId.value,
        containerName: options.namedContainer,
    };
    const hasGenerationFence = Boolean(options.taskId && options.attemptGeneration);
    const childTermination = hasGenerationFence ? waitForChildTermination(child) : null;
    child.kill('SIGTERM');
    options.scheduleForceKill(child);
    state.teardownPromise = (async () => {
        await teardownDockerExecution(teardownOptions);
        if (childTermination) {
            await childTermination;
            // Once SIGTERM or the fallback SIGKILL has ended `docker run`, use
            // a fresh observation window to catch its last creation-race work.
            await teardownDockerExecution(teardownOptions);
        }
    })();
    return state.teardownPromise;
}

export function addTaskAttemptLabelsToDockerArgs(
    args: string[],
    taskId: string | undefined,
    attemptGeneration: string | undefined,
): string[] {
    if (args[0] !== 'run' || !taskId) return args;
    return [
        'run',
        '--label', `propr.task.id=${taskId}`,
        ...(attemptGeneration
            ? ['--label', `propr.task.attempt-generation=${attemptGeneration}`]
            : []),
        ...args.slice(1),
    ];
}

export function resolveExecutionArgs(
    command: string,
    args: string[],
    taskId: string | undefined,
    attemptGeneration: string | undefined,
): string[] {
    return command === 'docker'
        ? addTaskAttemptLabelsToDockerArgs(args, taskId, attemptGeneration)
        : args;
}

export function getDockerRunContainerName(args: string[]): string | null {
    const nameIndex = args.indexOf('--name');
    return nameIndex >= 0 && args[nameIndex + 1] ? args[nameIndex + 1] : null;
}
