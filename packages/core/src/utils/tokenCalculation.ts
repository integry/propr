import Anthropic from '@anthropic-ai/sdk';
import { getEncoding, Tiktoken } from "js-tiktoken";

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
 * Per Claude documentation, the result message contains authoritative cumulative usage.
 * This function prefers tokenUsage (from result message) over conversation log aggregation.
 *
 * Total input includes: input_tokens + cache_creation_input_tokens + cache_read_input_tokens
 */
export function getUsageStats(claudeResult: ClaudeResult | null): UsageStats {
    let inputTokens = 0;
    let outputTokens = 0;

    // Prefer the result message's cumulative tokenUsage (authoritative)
    if (claudeResult?.tokenUsage) {
        const usage = claudeResult.tokenUsage;
        // Total input = base input + cache tokens (per Claude billing docs)
        inputTokens = (usage.input_tokens ?? 0) +
                      (usage.cache_creation_input_tokens ?? 0) +
                      (usage.cache_read_input_tokens ?? 0);
        outputTokens = usage.output_tokens ?? 0;
    } else if (claudeResult?.conversationLog) {
        // Fallback: aggregate from conversation log (deduplicate by message ID)
        const seenIds = new Set<string>();
        claudeResult.conversationLog.forEach(msg => {
            const msgObj = msg.message as { id?: string; usage?: MessageUsage } | undefined;
            if (msgObj?.usage) {
                // Skip if we've already counted this message ID
                if (msgObj.id && seenIds.has(msgObj.id)) {
                    return;
                }
                if (msgObj.id) {
                    seenIds.add(msgObj.id);
                }
                const usage = msgObj.usage;
                inputTokens += (usage.input_tokens ?? 0);
                inputTokens += (usage.cache_creation_input_tokens ?? 0);
                inputTokens += (usage.cache_read_input_tokens ?? 0);
                outputTokens += (usage.output_tokens ?? 0);
            }
        });
    }

    return {
        inputTokens,
        outputTokens,
        totalTokens: inputTokens + outputTokens
    };
}

/**
 * Get detailed token usage stats including separate cache token counts.
 * Use this when you need to calculate costs with provider-specific cache pricing.
 */
export function getDetailedUsageStats(claudeResult: ClaudeResult | null): DetailedUsageStats {
    let inputTokens = 0;
    let outputTokens = 0;
    let cacheCreationTokens = 0;
    let cacheReadTokens = 0;

    if (claudeResult?.tokenUsage) {
        const usage = claudeResult.tokenUsage;
        inputTokens = usage.input_tokens ?? 0;
        outputTokens = usage.output_tokens ?? 0;
        cacheCreationTokens = usage.cache_creation_input_tokens ?? 0;
        cacheReadTokens = usage.cache_read_input_tokens ?? 0;
    } else if (claudeResult?.conversationLog) {
        const seenIds = new Set<string>();
        claudeResult.conversationLog.forEach(msg => {
            const msgObj = msg.message as { id?: string; usage?: MessageUsage } | undefined;
            if (msgObj?.usage) {
                if (msgObj.id && seenIds.has(msgObj.id)) {
                    return;
                }
                if (msgObj.id) {
                    seenIds.add(msgObj.id);
                }
                const usage = msgObj.usage;
                inputTokens += usage.input_tokens ?? 0;
                outputTokens += usage.output_tokens ?? 0;
                cacheCreationTokens += usage.cache_creation_input_tokens ?? 0;
                cacheReadTokens += usage.cache_read_input_tokens ?? 0;
            }
        });
    }

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
export async function countTokens(text: string, model: string = 'claude-sonnet-4-5'): Promise<number> {
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
