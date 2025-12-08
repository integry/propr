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

export function estimateTokens(text: string): number {
    if (!text) return 0;
    return Math.ceil(text.length / 4);
}
