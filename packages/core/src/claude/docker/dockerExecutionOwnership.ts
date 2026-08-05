import type { ChildProcess } from 'node:child_process';
import { AsyncLocalStorage } from 'node:async_hooks';
import logger from '../../utils/logger.js';
import { stopDockerContainer } from './dockerContainerControl.js';

interface ExecutionOwnershipContext {
    signal: AbortSignal;
    /** One-way identifier for the PR attempt that owns this container. */
    attemptGeneration?: string;
}

interface SpawnedExecutionState {
    aborted: { value: boolean };
    containerId: { value: string | null };
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
    namedContainer: string | null,
    scheduleForceKill: (child: ChildProcess) => void,
): void {
    if (state.aborted.value || child.killed) return;
    state.aborted.value = true;
    const containerToStop = state.containerId.value || namedContainer;
    if (containerToStop) {
        void stopDockerContainer(containerToStop, 10).then(stopResult => {
            if (!stopResult.success) {
                logger.warn({ containerId: containerToStop, error: stopResult.error }, 'Failed to stop Docker container after execution ownership loss');
            }
        });
    }
    child.kill('SIGTERM');
    scheduleForceKill(child);
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
