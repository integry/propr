import type { AgentWatchdogTrip } from './agentActivityWatchdog.js';
import type { ExecutionResult } from './dockerExecutor.js';

interface Settle { resolve: (result: ExecutionResult) => void; reject: (error: Error) => void }

function appendStopMessage(stderr: string, message: string): string {
    return stderr.trim() ? `${stderr.trimEnd()}\n${message}` : message;
}

/** Deadline stop: partial output is kept for callers that publish it. */
export function settleTimeoutStop(timeoutMs: number, result: ExecutionResult, preserveOutput: boolean, { resolve, reject }: Settle): void {
    const message = `Command timed out after ${timeoutMs}ms`;
    if (!preserveOutput) { reject(new Error(message)); return; }
    resolve({ ...result, stderr: appendStopMessage(result.stderr, message), timedOut: true, timeoutMs });
}

/** Like a deadline stop: partial output is kept for callers that publish it. */
export function settleWatchdogStop(trip: AgentWatchdogTrip, result: ExecutionResult, preserveOutput: boolean, { resolve, reject }: Settle): void {
    if (!preserveOutput) { reject(new Error(trip.message)); return; }
    resolve({ ...result, stderr: appendStopMessage(result.stderr, trip.message), watchdogTrip: trip });
}
