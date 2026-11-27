import type { AgentExecutionResult } from '../../types.js';
import type { ExecutionResult } from '../../../claude/docker/dockerExecutor.js';
import type { PiThinkingLevel } from '../../../config/configManagerReasoning.js';
import { resolveAgentTerminationReason } from '../../termination.js';
import type { UsageTrackingMetrics } from './usageTrackingWrapper.js';
import { buildPiFailureMessage, isSuccessfulPiResult, parsePiOutput, type ParsedPiOutput } from './piOutputParser.js';

/** The ProPR level reported for a run: Pi's thinking level when it is one ProPR also names. */
export function reportedPiReasoningLevel(level: PiThinkingLevel | null | undefined): AgentExecutionResult['reasoningLevel'] {
    return level && level !== 'off' && level !== 'minimal' ? level : undefined;
}

export interface PiExecutionResultInput {
    result: Pick<ExecutionResult, 'stdout' | 'stderr' | 'exitCode' | 'timedOut'> & Partial<Pick<ExecutionResult, 'costCapExceeded' | 'watchdogTrip'>>;
    /** The ProPR model id; it keeps labels and pricing, the provider's id is kept beside it. */
    modelUsed: string;
    thinkingLevel?: PiThinkingLevel | null;
    prompt?: string;
    executionTimeMs: number;
    usageMetrics?: UsageTrackingMetrics | null;
}

/** Turns one finished `pi -p --mode json` container run into the agent result ProPR records. */
export function buildPiExecutionResult(input: PiExecutionResultInput): { response: AgentExecutionResult; parsed: ParsedPiOutput } {
    const { result, modelUsed, thinkingLevel, prompt, executionTimeMs, usageMetrics } = input;
    const parsed = parsePiOutput(result.stdout);
    const terminationReason = resolveAgentTerminationReason({ timedOut: result.timedOut, costCapExceeded: result.costCapExceeded, watchdogTrip: result.watchdogTrip, error: parsed.error || result.stderr });
    const success = isSuccessfulPiResult(result.exitCode, parsed) && !terminationReason;
    const reasoningLevel = reportedPiReasoningLevel(thinkingLevel);
    const response: AgentExecutionResult = {
        success,
        executionTimeMs,
        exitCode: result.exitCode,
        rawOutput: result.stdout,
        logs: result.stdout + (result.stderr ? `\n\nSTDERR:\n${result.stderr}` : ''),
        modelUsed,
        ...(parsed.providerModel && { providerModel: parsed.providerModel }),
        ...(reasoningLevel && { reasoningLevel }),
        modifiedFiles: [],
        commitMessage: null,
        summary: parsed.summary,
        ...(prompt !== undefined && { prompt }),
        sessionId: parsed.sessionId,
        conversationLog: parsed.conversationLog,
        error: success ? undefined : buildPiFailureMessage(result, parsed),
        terminationReason,
        tokenUsage: parsed.tokenUsage,
        // Only a total every response reported from the provider replaces ProPR pricing.
        ...(parsed.costUsd !== undefined && { cost: parsed.costUsd, providerCostUsd: parsed.costUsd }),
        usageMetrics: usageMetrics ?? undefined,
    };
    return { response, parsed };
}
