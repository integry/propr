import { AsyncLocalStorage } from 'node:async_hooks';

/**
 * Kept free of pricing and database imports: the Docker executor and task
 * state transitions consult the active cap without loading either.
 */

export interface RunCostExecution {
    observeLine(line: string): void;
    /**
     * The execution ended; its consumption keeps counting toward the run.
     * Resolves after its final usage was evaluated against the cap, with the
     * stop message when the run reached its cap and null otherwise.
     */
    finish(): Promise<string | null>;
}

/** What agent executions and task-state transitions need from the active run's spend cap. */
export interface ActiveRunCostCap {
    readonly taskId: string;
    readonly exceeded: boolean;
    /** Registers an agent container; `stop` runs once if the run reaches its cap. Null when nothing is enforced. */
    beginExecution(stop: (message: string) => void, model?: string): RunCostExecution | null;
}

const activeGuard = new AsyncLocalStorage<ActiveRunCostCap>();

export function runWithActiveRunCostCap<T>(guard: ActiveRunCostCap, operation: () => Promise<T>): Promise<T> {
    return activeGuard.run(guard, operation);
}

export function getActiveRunCostCap(): ActiveRunCostCap | undefined {
    return activeGuard.getStore();
}

/**
 * The terminal reason a completed or failed transition of a run that was
 * stopped at its spend cap carries, when the caller did not name one.
 */
export function runCostCapTerminalReason(taskId: string, newState: string): 'cost_cap_exceeded' | undefined {
    if (newState !== 'completed' && newState !== 'failed') return undefined;
    const guard = activeGuard.getStore();
    return guard?.taskId === taskId && guard.exceeded ? 'cost_cap_exceeded' : undefined;
}
