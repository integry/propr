/**
 * Docker execution result processing utilities.
 *
 * This module handles the transformation of raw Docker execution results
 * into structured AgentExecutionResult objects.
 */

import { AgentExecutionResult, TokenUsage } from '../../types.js';
import { ExecutionResult } from '../../../claude/docker/dockerExecutor.js';
import { parseStreamJsonOutput } from '../../../claude/claudeHelpers.js';
import { getDefaultModel } from '../../../config/modelAliases.js';
import { getCorrectedTokenUsage, ensurePromptInConversationLog } from './tokenUtils.js';

/**
 * Result of processing a Docker execution result.
 */
export interface ProcessedDockerResult {
    /** The transformed agent execution result */
    response: AgentExecutionResult;
    /** Token usage after correction (may differ from reported usage) */
    correctedTokenUsage: TokenUsage | undefined;
    /** The model that was actually used for execution */
    modelUsed: string;
}

/**
 * Processes a Docker execution result and builds the agent response.
 *
 * This function:
 * 1. Parses the stream JSON output from Claude CLI
 * 2. Determines the actual model used
 * 3. Ensures the initial prompt is in the conversation log
 * 4. Corrects token usage if the reported values are incomplete
 * 5. Builds the final AgentExecutionResult
 *
 * @param result - Raw execution result from Docker
 * @param prompt - The prompt that was passed to Claude
 * @param effectiveModel - The model that was requested
 * @param executionTime - Total execution time in milliseconds
 * @returns ProcessedDockerResult containing the response and metadata
 */
export function processDockerResult(
    result: ExecutionResult,
    prompt: string,
    effectiveModel: string,
    executionTime: number
): ProcessedDockerResult {
    const claudeOutput = parseStreamJsonOutput(result);

    // Determine the actual model used (from output or fallback to requested/default)
    const modelUsed = claudeOutput.model || effectiveModel || getDefaultModel();

    // Ensure the initial prompt is included in the conversation log
    const fullConversationLog = ensurePromptInConversationLog(
        claudeOutput.conversationLog,
        prompt
    );

    // Get corrected token usage (aggregated if reported is incomplete)
    const correctedTokenUsage = getCorrectedTokenUsage(
        claudeOutput.tokenUsage,
        fullConversationLog
    );

    // Build the agent execution response
    const response: AgentExecutionResult = {
        success: claudeOutput.success,
        executionTimeMs: executionTime,
        logs: result.stderr || '',
        exitCode: result.exitCode,
        rawOutput: result.stdout,
        sessionId: claudeOutput.sessionId ?? undefined,
        conversationId: claudeOutput.conversationId,
        modelUsed,
        cost: claudeOutput.finalResult?.total_cost_usd || claudeOutput.finalResult?.cost_usd,
        modifiedFiles: [],
        commitMessage: null,
        summary: claudeOutput.finalResult?.result ?? undefined,
        prompt,
        conversationLog: fullConversationLog,
        tokenUsage: correctedTokenUsage
    };

    return {
        response,
        correctedTokenUsage,
        modelUsed
    };
}
