import { extractAgentReport } from './reportPrompt.js';
import type { AgentExecutionResult } from '@propr/core';

/** Errors of the report-run executor and the agent result they are derived from. */

function failureMessage(result: AgentExecutionResult): string {
    const detail = result.error?.trim() || (result.exitCode != null ? `exit code ${result.exitCode}` : '');
    return detail ? `Agent execution failed: ${detail}` : 'Agent execution failed';
}

export class AgentRunReportError extends Error {}

/**
 * A run's failure could not be persisted. Thrown out of the processor so the
 * delivery fails and BullMQ retries it, instead of resolving as if settled.
 */
export class AgentRunPersistenceError extends Error {
    constructor(runId: string, cause: unknown) {
        super(`Could not mark agent run ${runId} failed: ${(cause as Error)?.message ?? String(cause)}`, { cause });
        this.name = 'AgentRunPersistenceError';
    }
}

/**
 * A run's end is stored but its task could not be ended to match. Thrown out
 * of the processor so BullMQ retries, and the redelivery ends the task.
 */
export class AgentRunSettlementError extends Error {
    constructor(runId: string, taskId: string, cause: unknown) {
        super(`Could not end task ${taskId} of agent run ${runId}: ${(cause as Error)?.message ?? String(cause)}`, { cause });
        this.name = 'AgentRunSettlementError';
    }
}

export function reportFromResult(result: AgentExecutionResult): string {
    if (!result.success) throw new AgentRunReportError(failureMessage(result));
    const report = extractAgentReport(result);
    if (!report.trim()) throw new AgentRunReportError('The agent finished without a report');
    return report;
}
