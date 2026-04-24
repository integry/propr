import Anthropic from '@anthropic-ai/sdk';
import { getEncoding, Tiktoken } from "js-tiktoken";
import { getDefaultModel } from '../config/modelAliases.js';
import logger from './logger.js';

interface MessageUsage {
    input_tokens?: number;
    cache_creation_input_tokens?: number;
    cache_read_input_tokens?: number;
    output_tokens?: number;
}

interface Message {
    usage?: MessageUsage;
}

interface ConversationLogEntry {
    message?: Message;
}

export interface ClaudeResult {
    conversationLog?: ConversationLogEntry[];
    // The result message's cumulative usage (authoritative per Claude docs)
    tokenUsage?: MessageUsage;
}

interface UsageStats {
    inputTokens: number;
    outputTokens: number;
    totalTokens: number;
}

export interface DetailedUsageStats {
    inputTokens: number;           // Base input tokens (non-cached)
    outputTokens: number;
    cacheCreationTokens: number;   // Cache write tokens (1.25x for Claude)
    cacheReadTokens: number;       // Cache read tokens (0.1x for Claude)
    totalInputWithCache: number;   // Sum of all input tokens (for display)
    totalTokens: number;
}

export interface CachePricingMultipliers {
    cacheReadMultiplier: number;
    cacheCreationMultiplier: number;
}

/**
 * Get cache pricing multipliers based on the model/provider.
 * Different providers have different cache pricing structures:
 * - Claude: cache_read = 0.1x, cache_creation = 1.25x
 * - Gemini 2.5+: cache_read = 0.1x, cache_creation = 1.0x
 * - Gemini 2.0: cache_read = 0.25x, cache_creation = 1.0x
 * - OpenAI/Codex: cache_read = 0.25x, cache_creation = 1.0x
 */
export function getCachePricingMultipliers(model: string): CachePricingMultipliers {
    const lowerModel = model.toLowerCase();

    if (lowerModel.startsWith('claude')) {
        // Anthropic: 90% discount on cache reads, 25% premium on cache creation
        return { cacheReadMultiplier: 0.1, cacheCreationMultiplier: 1.25 };
    }

    if (lowerModel.startsWith('gemini')) {
        // Gemini 2.5+ gets 90% discount, older versions get 75%
        const is25OrNewer = lowerModel.includes('2.5') || lowerModel.includes('3');
        return {
            cacheReadMultiplier: is25OrNewer ? 0.1 : 0.25,
            cacheCreationMultiplier: 1.0
        };
    }

    if (lowerModel.startsWith('gpt') || lowerModel.includes('codex')) {
        // OpenAI/Codex: 75% discount on cache reads
        return { cacheReadMultiplier: 0.25, cacheCreationMultiplier: 1.0 };
    }

    // Default: no cache discount (treat cache tokens same as regular input)
    return { cacheReadMultiplier: 1.0, cacheCreationMultiplier: 1.0 };
}

/**
 * Get token usage stats from Claude result.
 *
 * This function computes both the reported token usage (from tokenUsage) and
 * the aggregated usage from the conversation log, then returns the higher value.
 * This prevents undercounting when Claude CLI only reports the last turn's usage.
 *
 * Total input includes: input_tokens + cache_creation_input_tokens + cache_read_input_tokens
 */
export function getUsageStats(claudeResult: ClaudeResult | null): UsageStats {
    let reportedInputTokens = 0;
    let reportedOutputTokens = 0;
    let aggregatedInputTokens = 0;
    let aggregatedOutputTokens = 0;

    // Get reported token usage from tokenUsage
    if (claudeResult?.tokenUsage) {
        const usage = claudeResult.tokenUsage;
        reportedInputTokens = (usage.input_tokens ?? 0) +
                              (usage.cache_creation_input_tokens ?? 0) +
                              (usage.cache_read_input_tokens ?? 0);
        reportedOutputTokens = usage.output_tokens ?? 0;
    }

    // Aggregate from conversation log (check both message?.usage and entry.usage)
    if (claudeResult?.conversationLog) {
        const seenIds = new Set<string>();
        claudeResult.conversationLog.forEach(msg => {
            const msgObj = msg.message as { id?: string; usage?: MessageUsage } | undefined;
            const entryWithUsage = msg as { usage?: MessageUsage };
            // Check both message?.usage and root-level entry.usage
            const usage = msgObj?.usage || entryWithUsage.usage;
            if (usage) {
                // Skip if we've already counted this message ID
                const msgId = msgObj?.id;
                if (msgId && seenIds.has(msgId)) {
                    return;
                }
                if (msgId) {
                    seenIds.add(msgId);
                }
                aggregatedInputTokens += (usage.input_tokens ?? 0);
                aggregatedInputTokens += (usage.cache_creation_input_tokens ?? 0);
                aggregatedInputTokens += (usage.cache_read_input_tokens ?? 0);
                aggregatedOutputTokens += (usage.output_tokens ?? 0);
            }
        });
    }

    // Return the higher of reported or aggregated to avoid undercounting
    const reportedTotal = reportedInputTokens + reportedOutputTokens;
    const aggregatedTotal = aggregatedInputTokens + aggregatedOutputTokens;

    const inputTokens = aggregatedTotal > reportedTotal ? aggregatedInputTokens : reportedInputTokens;
    const outputTokens = aggregatedTotal > reportedTotal ? aggregatedOutputTokens : reportedOutputTokens;

    return {
        inputTokens,
        outputTokens,
        totalTokens: inputTokens + outputTokens
    };
}

/**
 * Get detailed token usage stats including separate cache token counts.
 * Use this when you need to calculate costs with provider-specific cache pricing.
 *
 * This function computes both the reported token usage (from tokenUsage) and
 * the aggregated usage from the conversation log, then returns the higher value.
 * This prevents undercounting when Claude CLI only reports the last turn's usage.
 */
export function getDetailedUsageStats(claudeResult: ClaudeResult | null): DetailedUsageStats {
    let reportedInputTokens = 0;
    let reportedOutputTokens = 0;
    let reportedCacheCreationTokens = 0;
    let reportedCacheReadTokens = 0;

    let aggregatedInputTokens = 0;
    let aggregatedOutputTokens = 0;
    let aggregatedCacheCreationTokens = 0;
    let aggregatedCacheReadTokens = 0;

    // Get reported token usage from tokenUsage
    if (claudeResult?.tokenUsage) {
        const usage = claudeResult.tokenUsage;
        reportedInputTokens = usage.input_tokens ?? 0;
        reportedOutputTokens = usage.output_tokens ?? 0;
        reportedCacheCreationTokens = usage.cache_creation_input_tokens ?? 0;
        reportedCacheReadTokens = usage.cache_read_input_tokens ?? 0;
    }

    // Aggregate from conversation log (check both message?.usage and entry.usage)
    if (claudeResult?.conversationLog) {
        const seenIds = new Set<string>();
        claudeResult.conversationLog.forEach(msg => {
            const msgObj = msg.message as { id?: string; usage?: MessageUsage } | undefined;
            const entryWithUsage = msg as { usage?: MessageUsage };
            // Check both message?.usage and root-level entry.usage
            const usage = msgObj?.usage || entryWithUsage.usage;
            if (usage) {
                const msgId = msgObj?.id;
                if (msgId && seenIds.has(msgId)) {
                    return;
                }
                if (msgId) {
                    seenIds.add(msgId);
                }
                aggregatedInputTokens += usage.input_tokens ?? 0;
                aggregatedOutputTokens += usage.output_tokens ?? 0;
                aggregatedCacheCreationTokens += usage.cache_creation_input_tokens ?? 0;
                aggregatedCacheReadTokens += usage.cache_read_input_tokens ?? 0;
            }
        });
    }

    // Calculate totals for comparison
    const reportedTotal = reportedInputTokens + reportedOutputTokens +
                          reportedCacheCreationTokens + reportedCacheReadTokens;
    const aggregatedTotal = aggregatedInputTokens + aggregatedOutputTokens +
                            aggregatedCacheCreationTokens + aggregatedCacheReadTokens;

    // Use whichever is higher to avoid undercounting
    const useAggregated = aggregatedTotal > reportedTotal;

    const inputTokens = useAggregated ? aggregatedInputTokens : reportedInputTokens;
    const outputTokens = useAggregated ? aggregatedOutputTokens : reportedOutputTokens;
    const cacheCreationTokens = useAggregated ? aggregatedCacheCreationTokens : reportedCacheCreationTokens;
    const cacheReadTokens = useAggregated ? aggregatedCacheReadTokens : reportedCacheReadTokens;

    const totalInputWithCache = inputTokens + cacheCreationTokens + cacheReadTokens;

    return {
        inputTokens,
        outputTokens,
        cacheCreationTokens,
        cacheReadTokens,
        totalInputWithCache,
        totalTokens: totalInputWithCache + outputTokens
    };
}

/**
 * Calculate cost with proper cache pricing multipliers.
 * @param model - The model ID to determine provider-specific pricing
 * @param stats - Detailed usage stats with separate cache token counts
 * @param pricing - Base pricing (prompt and completion per token)
 * @returns Total cost in USD
 */
export function calculateCostWithCachePricing(
    model: string,
    stats: DetailedUsageStats,
    pricing: { prompt: number; completion: number }
): number {
    const { cacheReadMultiplier, cacheCreationMultiplier } = getCachePricingMultipliers(model);

    const inputCost = stats.inputTokens * pricing.prompt;
    const cacheCreationCost = stats.cacheCreationTokens * pricing.prompt * cacheCreationMultiplier;
    const cacheReadCost = stats.cacheReadTokens * pricing.prompt * cacheReadMultiplier;
    const outputCost = stats.outputTokens * pricing.completion;

    return inputCost + cacheCreationCost + cacheReadCost + outputCost;
}

// Anthropic client for accurate token counting via API
let anthropicClient: Anthropic | null = null;

function getAnthropicClient(): Anthropic {
    if (!anthropicClient) {
        anthropicClient = new Anthropic();
    }
    return anthropicClient;
}

// Cache the tiktoken encoder for fallback
let encoder: Tiktoken | null = null;

function getEncoder(): Tiktoken {
    if (!encoder) {
        encoder = getEncoding("cl100k_base");
    }
    return encoder!;
}

/**
 * Count tokens using Anthropic's official token counting API.
 * This is free and accurate, unlike tiktoken which can be off by 30%+ for code.
 * Falls back to tiktoken if the API call fails.
 */
export async function countTokens(text: string, model?: string): Promise<number> {
    if (!model) {
        const defaultModel = getDefaultModel();
        if (!defaultModel) {
            // Fall back to tiktoken estimation when no model is configured
            logger.warn('No default model configured for token counting - falling back to tiktoken estimation (may be inaccurate by 30%+)');
            return estimateTokens(text);
        }
        model = defaultModel;
    }
    if (!text) return 0;

    try {
        const response = await getAnthropicClient().messages.countTokens({
            model,
            messages: [{
                role: 'user',
                content: text
            }]
        });
        return response.input_tokens;
    } catch {
        // Fallback to tiktoken if API fails
        return estimateTokens(text);
    }
}

/**
 * Synchronous token estimation using tiktoken (cl100k_base).
 * Note: This can be inaccurate for code (up to 30%+ off).
 * Prefer countTokens() for accurate counts when possible.
 */
export function estimateTokens(text: string): number {
    if (!text) return 0;
    try {
        return getEncoder().encode(text).length;
    } catch {
        // Fallback if encoding fails - use conservative estimate for code
        return Math.ceil(text.length / 3.2);
    }
}
