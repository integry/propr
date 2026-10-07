import { AGENT_ACTION_SUMMARY_MAX_CHARS } from '@propr/shared';
import { AGENT_REPORT_TRUNCATED_MARKER, extractAgentReport } from './reportPrompt.js';
import { describeAgentTermination, resolveAgentTerminationReason, type AgentExecutionResult } from '@propr/core';

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

/** The final message of a finished agent execution; throws `AgentRunReportError` when there is none. */
function finalMessageFromResult(result: AgentExecutionResult, missing: string): string {
    // An execution the provider stopped early is not a finished result, even with text.
    const terminationReason = resolveAgentTerminationReason(result);
    if (terminationReason) throw new AgentRunReportError(`Agent execution stopped before completion: ${describeAgentTermination(terminationReason)}`);
    if (!result.success) throw new AgentRunReportError(failureMessage(result));
    const message = extractAgentReport(result);
    if (!message.trim()) throw new AgentRunReportError(missing);
    return message;
}

export function reportFromResult(result: AgentExecutionResult): string {
    return finalMessageFromResult(result, 'The agent finished without a report');
}

/** The acting step's summary of what it did, cut to the stored maximum. */
export function actionSummaryFromResult(result: AgentExecutionResult): string {
    const summary = finalMessageFromResult(result, 'The acting agent finished without a summary');
    if (summary.length <= AGENT_ACTION_SUMMARY_MAX_CHARS) return summary;
    return `${summary.slice(0, AGENT_ACTION_SUMMARY_MAX_CHARS).trimEnd()}\n${AGENT_REPORT_TRUNCATED_MARKER}`;
}
