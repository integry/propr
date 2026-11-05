import { getActiveRunCostCap, type RunCostExecution } from '../../budget/runCostGuardContext.js';
import { RunCostCapExceededError } from '../../budget/runCostCap.js';
import type { DockerCommandOptions, ExecutionResult } from './dockerExecutor.js';

/** Agent containers spend toward their run's cap; other commands and exempt containers do not. */
export function isChargeableExecution(command: string, args: string[], options: Pick<DockerCommandOptions, 'costCapExempt'>): boolean {
    return command === 'docker' && args[0] === 'run' && !options.costCapExempt;
}

/**
 * Null when no cap applies; otherwise resolves once the run's cap admitted the
 * container, with the refusal message when its budget is already used up.
 */
export function admitCostExecution(command: string, args: string[], options: Pick<DockerCommandOptions, 'costCapExempt'>): Promise<string | null> | null {
    const costCap = isChargeableExecution(command, args, options) ? getActiveRunCostCap() : undefined;
    if (!costCap) return null;
    return costCap.admit().then(() => null, error => {
        if (error instanceof RunCostCapExceededError) return error.message;
        throw error;
    });
}

/** Registers an agent container with its run's spend cap; refused once the run was stopped at its cap. */
export function registerCostExecution(
    command: string,
    args: string[],
    options: Pick<DockerCommandOptions, 'model' | 'costCapExempt'>,
    stop: (message: string) => void,
): { execution: RunCostExecution | null } | { refusal: string } {
    if (!isChargeableExecution(command, args, options)) return { execution: null };
    try {
        return { execution: getActiveRunCostCap()?.beginExecution(stop, options.model) ?? null };
    } catch (error) {
        if (error instanceof RunCostCapExceededError) return { refusal: error.message };
        throw error;
    }
}

/** A refused container never started: it ends with the spend-cap outcome and no output. */
export function refuseCostExecution(message: string, preserveOutput: boolean): Promise<ExecutionResult> {
    return new Promise((resolve, reject) => settleCostCapStop(message, { exitCode: null, stdout: '', stderr: '', messageTimestamps: new Map() },
        { preserveOutput, resolve, reject }));
}

/** A run stopped at its spend cap ends like a timeout: partial output when the caller can publish it. */
export function settleCostCapStop(
    message: string,
    result: ExecutionResult,
    settle: { preserveOutput: boolean; resolve: (result: ExecutionResult) => void; reject: (error: Error) => void },
): void {
    const { preserveOutput, resolve, reject } = settle;
    if (!preserveOutput) {
        reject(new RunCostCapExceededError(message));
        return;
    }
    const stderr = result.stderr.trim() ? `${result.stderr.trimEnd()}\n${message}` : message;
    resolve({ ...result, stderr, costCapExceeded: true });
}
