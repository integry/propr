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
}

interface UsageStats {
    inputTokens: number;
    outputTokens: number;
    totalTokens: number;
}

export function getUsageStats(claudeResult: ClaudeResult | null): UsageStats {
    let inputTokens = 0;
    let outputTokens = 0;

    if (claudeResult?.conversationLog) {
        claudeResult.conversationLog.forEach(msg => {
            if (msg.message?.usage) {
                const usage = msg.message.usage;
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

// Anthropic client singleton for accurate token counting and lightweight LLM calls
let anthropicClient: Anthropic | null = null;

/**
 * Returns a shared Anthropic client instance.
 * Used for token counting and lightweight LLM operations.
 */
export function getAnthropicClient(): Anthropic {
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
