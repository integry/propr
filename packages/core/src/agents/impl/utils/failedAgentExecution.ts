/**
 * Records agent executions that end without a result the job layer will see.
 *
 * A run that hits a usage limit throws out of `executeTask`, so no caller ever
 * receives a result to pass to `recordLLMMetrics`; the turns it consumed before
 * the limit would go unrecorded. A run that throws for any other reason is
 * returned as a failed result, which callers do record, but it never reached
 * the agent's own log persistence. These helpers give both paths their rows.
 */

import { randomUUID } from 'node:crypto';
import logger from '../../../utils/logger.js';
import { recordLLMMetrics } from '../../../utils/llmMetrics.js';
import type { ClaudeResult } from '../../../utils/llmMetrics.types.js';
import { persistLlmLog, createLlmLogFromAnalysis, buildTaskWorkRef, resolveTaskLogAttribution } from '../../../utils/llmLogger.js';
import type { ReasoningLevel } from '@propr/shared';
import type { AgentExecutionResult, AgentTaskOptions } from '../../types.js';
import type { UsageLimitError } from '../../../claude/claudeHelpers.js';
import { getCorrectedTokenUsage, ensurePromptInConversationLog } from './tokenUtils.js';

/** Recording must never hold a failing run; an unreachable store is waited on this long at most. */
const RECORD_TIMEOUT_MS = 10_000;

export type FailedExecutionOptions = Pick<AgentTaskOptions, 'issueRef' | 'taskId' | 'prNumber' | 'metadata' | 'isRetry' | 'retryReason'>;

/** Assigns the result an execution id if it has none, and returns it. */
export function assignExecutionId(result: { executionId?: string }): string {
    result.executionId ??= randomUUID();
    return result.executionId;
}

async function bounded(work: Promise<unknown>, what: string): Promise<void> {
    let timer: NodeJS.Timeout | undefined;
    try {
        await Promise.race([
            work,
            new Promise<void>(resolve => {
                timer = setTimeout(() => {
                    logger.warn({ timeoutMs: RECORD_TIMEOUT_MS }, `Timed out recording ${what}; continuing`);
                    resolve();
                }, RECORD_TIMEOUT_MS);
                timer.unref?.();
            }),
        ]);
    } catch (error) {
        logger.warn({ error: (error as Error).message }, `Failed to record ${what}`);
    } finally {
        if (timer) clearTimeout(timer);
    }
}

interface FailedResultContext {
    model: string;
    executionTimeMs: number;
    reasoningLevel?: ReasoningLevel;
}

/**
 * A usage-limited run as a failed result: the turns, tokens and cost the
 * stream showed before the limit (none when it showed nothing), the limit as
 * the error, and a fresh execution id.
 */
export function usageLimitExecutionResult(
    error: UsageLimitError, context: FailedResultContext & { prompt?: string },
): AgentExecutionResult {
    const observed = error.partialOutput;
    const streamed = observed?.conversationLog ?? [];
    const conversationLog = context.prompt ? ensurePromptInConversationLog(streamed, context.prompt) : streamed;
    const finalResult = observed?.finalResult;
    return {
        executionId: assignExecutionId({}),
        success: false,
        error: error.rawErrorMessage ? `${error.message} ${error.rawErrorMessage}` : error.message,
        executionTimeMs: context.executionTimeMs,
        logs: error.message,
        modifiedFiles: [], commitMessage: null, summary: undefined,
        modelUsed: observed?.model || context.model || 'unknown',
        providerModel: observed?.model || undefined,
        ...(context.reasoningLevel && { reasoningLevel: context.reasoningLevel }),
        sessionId: observed?.sessionId ?? undefined,
        conversationId: observed?.conversationId,
        conversationLog,
        tokenUsage: getCorrectedTokenUsage(observed?.tokenUsage, conversationLog),
        cost: finalResult?.total_cost_usd || finalResult?.cost_usd || undefined,
    };
}

/**
 * A run that threw as a failed result. When the agent had already produced a
 * result before a later step threw, its tokens, cost and identity are kept: the
 * spend happened even though the run failed.
 */
export function failedExecutionResult(
    error: Error, context: FailedResultContext & { completed?: AgentExecutionResult },
): AgentExecutionResult {
    const { completed } = context;
    return {
        ...(completed && {
            sessionId: completed.sessionId, conversationId: completed.conversationId,
            conversationLog: completed.conversationLog, tokenUsage: completed.tokenUsage, cost: completed.cost,
            providerModel: completed.providerModel, prompt: completed.prompt,
        }),
        executionId: completed?.executionId ?? assignExecutionId({}),
        success: false, error: error.message, executionTimeMs: context.executionTimeMs,
        logs: (error as { stderr?: string }).stderr || error.message,
        modifiedFiles: [], commitMessage: null, summary: undefined,
        modelUsed: completed?.modelUsed ?? context.model,
        ...((context.reasoningLevel ?? completed?.reasoningLevel) && { reasoningLevel: context.reasoningLevel ?? completed?.reasoningLevel }),
    };
}

/** The failed run's `llm_logs` row, as the agent writes for a run that completed. */
export async function persistFailedExecutionLog(
    result: AgentExecutionResult, options: FailedExecutionOptions, agentAlias: string,
): Promise<void> {
    const { issueRef, taskId, prNumber, metadata, isRetry = false, retryReason } = options;
    const repository = `${issueRef.repoOwner}/${issueRef.repoName}`;
    await bounded(persistLlmLog(createLlmLogFromAnalysis({
        ...resolveTaskLogAttribution(metadata, buildTaskWorkRef(taskId, issueRef.number, repository, prNumber), {
            isRetry, retryReason, conversationId: result.conversationId,
        }),
        modelUsed: result.modelUsed,
        executionTimeMs: result.executionTimeMs,
        success: false,
        tokenUsage: result.tokenUsage,
        error: result.error ?? 'Execution failed',
        sessionId: result.sessionId,
        draftId: taskId,
        repository,
        agentAlias,
        reasoningLevel: result.reasoningLevel,
    })), 'failed agent execution log');
}

/** The `ClaudeResult` shape `recordLLMMetrics` reads, from an agent result. */
export function agentResultToMetricsResult(result: AgentExecutionResult): ClaudeResult {
    return {
        executionId: result.executionId,
        model: result.modelUsed,
        success: result.success,
        executionTime: result.executionTimeMs,
        sessionId: result.sessionId,
        conversationId: result.conversationId,
        conversationLog: result.conversationLog,
        error: result.error,
        tokenUsage: result.tokenUsage,
        finalResult: result.cost ? { total_cost_usd: result.cost } : null,
    };
}

/**
 * Records a run no caller will record: its log row and its one execution row,
 * failed, with whatever tokens and cost the stream showed (zero when none).
 * The result keeps its execution id, so any later record of it is a no-op.
 */
export async function recordUnreturnedFailedExecution(
    result: AgentExecutionResult, options: FailedExecutionOptions, agentAlias: string,
): Promise<void> {
    assignExecutionId(result);
    await persistFailedExecutionLog(result, options, agentAlias);
    const { issueRef, taskId, prNumber, metadata } = options;
    const correlationId = typeof metadata?.correlationId === 'string' ? metadata.correlationId : undefined;
    await bounded(recordLLMMetrics(agentResultToMetricsResult(result), issueRef, {
        jobType: prNumber ? 'pr_comment' : 'issue',
        correlationId,
        taskId: taskId ?? null,
        reasoningLevel: result.reasoningLevel,
    }), 'failed agent execution metrics');
}
