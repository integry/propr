import { getExecutionAbortError } from './dockerExecutionOwnership.js';

/** One caller budget, including admission; teardown keeps its own bounded budget. */
export interface ExecutionDeadline {
    remaining(): number;
    stop(): void;
}

export function createExecutionDeadline(timeout: number, signal?: AbortSignal, ownershipSignal?: AbortSignal) {
    const signals = [signal, ownershipSignal].filter((signal): signal is AbortSignal => Boolean(signal));
    const ownerSignal = signals.length ? AbortSignal.any(signals) : undefined;
    const initialAbortError = getExecutionAbortError(ownerSignal);
    if (initialAbortError) throw initialAbortError;
    const expiresAt = performance.now() + timeout;
    const timeoutError = new Error(`Command timed out after ${timeout}ms`);
    const controller = new AbortController();
    const executionSignal = AbortSignal.any([...signals, controller.signal]);
    const timer = setTimeout(() => controller.abort(timeoutError), timeout);
    const deadline: ExecutionDeadline = {
        remaining() {
            const error = getExecutionAbortError(executionSignal);
            if (error) throw error;
            const remaining = Math.ceil(expiresAt - performance.now());
            if (remaining <= 0) throw timeoutError;
            return remaining;
        },
        stop() { clearTimeout(timer); },
    };
    return { deadline, executionSignal, timeoutError };
}
