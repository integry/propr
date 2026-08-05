import type { ChildProcess } from 'node:child_process';
import { AsyncLocalStorage } from 'node:async_hooks';
import { teardownDockerExecution } from './dockerContainerControl.js';

interface ExecutionOwnershipContext {
    signal: AbortSignal;
    /** One-way identifier for the PR attempt that owns this container. */
    attemptGeneration?: string;
}

interface SpawnedExecutionState {
    aborted: { value: boolean };
    containerId: { value: string | null };
    teardownPromise: Promise<void> | null;
}

interface AbortSpawnedExecutionOptions {
    namedContainer: string | null;
    scheduleForceKill: (child: ChildProcess) => void;
    taskId?: string;
    attemptGeneration?: string;
}

const executionOwnershipContext = new AsyncLocalStorage<ExecutionOwnershipContext>();

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
    child.kill('SIGTERM');
    options.scheduleForceKill(child);
    state.teardownPromise = teardownDockerExecution({
        taskId: options.taskId,
        attemptGeneration: options.attemptGeneration,
        containerId: state.containerId.value,
        containerName: options.namedContainer,
    });
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
