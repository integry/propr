/**
 * Token usage aggregation and correction utilities.
 *
 * This module handles the aggregation of token usage from conversation logs
 * and corrects potentially incomplete token usage reports from Claude CLI.
 */

import logger from '../../../utils/logger.js';
import { TokenUsage } from '../../types.js';
import { ConversationLogEntry } from '../../../claude/claudeHelpers.js';

/**
 * Aggregates token usage from all messages in the conversation log.
 *
 * The Claude CLI sometimes reports only the last turn's usage rather than
 * the cumulative usage across the entire conversation. This function manually
 * iterates through all messages to calculate the total token usage.
 *
 * Note: We process ALL entries (not just assistant entries) because usage
 * data may be attached to various message types. Message IDs are used for
 * deduplication to prevent double-counting.
 *
 * @param conversationLog - Array of conversation log entries from Claude output
 * @returns Aggregated TokenUsage object with totals from all messages
 */
export function aggregateTokensFromConversationLog(
    conversationLog: ConversationLogEntry[]
): TokenUsage {
    const aggregated: TokenUsage = {
        input_tokens: 0,
        output_tokens: 0,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 0
    };

    let foundCount = 0;
    const seenIds = new Set<string>(); // Deduplicate by message ID (per Claude docs, same ID = same usage)

    for (const entry of conversationLog) {
        // Check both message?.usage and entry.usage (root level)
        // Claude CLI sometimes stores usage at the root of the entry instead of nested in message
        const message = entry.message as { id?: string; usage?: TokenUsage } | undefined;
        const entryWithUsage = entry as { usage?: TokenUsage };
        const usage = message?.usage || entryWithUsage.usage;

        if (usage) {
            // Deduplicate by message ID to avoid double-counting
            const msgId = message?.id;
            if (msgId && seenIds.has(msgId)) {
                continue;
            }
            if (msgId) {
                seenIds.add(msgId);
            }

            foundCount++;
            aggregated.input_tokens = (aggregated.input_tokens || 0) + (usage.input_tokens || 0);
            aggregated.output_tokens = (aggregated.output_tokens || 0) + (usage.output_tokens || 0);
            aggregated.cache_creation_input_tokens =
                (aggregated.cache_creation_input_tokens || 0) + (usage.cache_creation_input_tokens || 0);
            aggregated.cache_read_input_tokens =
                (aggregated.cache_read_input_tokens || 0) + (usage.cache_read_input_tokens || 0);
        }
    }

    const totalTokens = (aggregated.input_tokens || 0) +
        (aggregated.output_tokens || 0) +
        (aggregated.cache_creation_input_tokens || 0) +
        (aggregated.cache_read_input_tokens || 0);

    // Log at info level when we find significant token usage to help debug
    if (totalTokens > 0) {
        logger.info({
            conversationLogLength: conversationLog.length,
            messagesWithUsage: foundCount,
            aggregatedInputTokens: aggregated.input_tokens,
            aggregatedCacheRead: aggregated.cache_read_input_tokens,
            aggregatedCacheCreation: aggregated.cache_creation_input_tokens,
            aggregatedOutputTokens: aggregated.output_tokens,
            totalTokens
        }, 'Token aggregation from conversation log');
    } else {
        logger.debug({
            conversationLogLength: conversationLog.length,
            messagesWithUsage: foundCount
        }, 'Token aggregation found no usage data');
    }

    return aggregated;
}

/**
 * Returns the better token usage between reported and aggregated values.
 *
 * This function compares the reported token usage from Claude CLI against
 * the manually aggregated usage from conversation logs. If the aggregated
 * total is higher (indicating the reported value was incomplete), it returns
 * the aggregated usage instead.
 *
 * @param reported - Token usage as reported by Claude CLI
 * @param conversationLog - Full conversation log to aggregate from
 * @returns The higher of reported or aggregated token usage
 */
export function getCorrectedTokenUsage(
    reported: TokenUsage | undefined,
    conversationLog: ConversationLogEntry[]
): TokenUsage | undefined {
    const aggregated = aggregateTokensFromConversationLog(conversationLog);

    // Include cache tokens in totals for proper comparison
    const aggregatedTotal = (aggregated.input_tokens || 0) +
                           (aggregated.cache_creation_input_tokens || 0) +
                           (aggregated.cache_read_input_tokens || 0) +
                           (aggregated.output_tokens || 0);
    const reportedTotal = (reported?.input_tokens || 0) +
                         (reported?.cache_creation_input_tokens || 0) +
                         (reported?.cache_read_input_tokens || 0) +
                         (reported?.output_tokens || 0);

    logger.debug({
        reportedInputTokens: reported?.input_tokens,
        reportedCacheRead: reported?.cache_read_input_tokens,
        reportedCacheCreation: reported?.cache_creation_input_tokens,
        reportedOutputTokens: reported?.output_tokens,
        reportedTotal,
        aggregatedInputTokens: aggregated.input_tokens,
        aggregatedCacheRead: aggregated.cache_read_input_tokens,
        aggregatedCacheCreation: aggregated.cache_creation_input_tokens,
        aggregatedOutputTokens: aggregated.output_tokens,
        aggregatedTotal
    }, 'Token usage comparison');

    if (aggregatedTotal > reportedTotal) {
        logger.debug('Using aggregated token usage (higher than reported)');
        return aggregated;
    }

    return reported;
}

/**
 * Ensures the initial prompt is included in the conversation log.
 *
 * The Claude CLI's stream output often omits the stdin prompt, leading to
 * incomplete logs. This function prepends the initial user prompt if it's
 * not already present in the conversation log.
 *
 * @param conversationLog - Existing conversation log from Claude output
 * @param prompt - The initial prompt that was passed to Claude via stdin
 * @returns Updated conversation log with the initial prompt included
 */
export function ensurePromptInConversationLog(
    conversationLog: ConversationLogEntry[],
    prompt: string
): ConversationLogEntry[] {
    // If the first entry is already a user message, assume the prompt is included
    if (conversationLog.length > 0 && conversationLog[0].type === 'user') {
        return conversationLog;
    }

    // Prepend the initial prompt as a user message
    const initialPromptEntry: ConversationLogEntry = {
        type: 'user',
        message: { id: 'initial-prompt' },
        timestamp: new Date().toISOString(),
        content: [{ type: 'text', text: prompt }]
    };

    return [initialPromptEntry, ...conversationLog];
}
