export function getUsageStats(claudeResult) {
    let inputTokens = 0;
    let outputTokens = 0;

    if (claudeResult?.conversationLog) {
        claudeResult.conversationLog.forEach(msg => {
            if (msg.message?.usage) {
                const usage = msg.message.usage;
                inputTokens += (usage.input_tokens || 0);
                inputTokens += (usage.cache_creation_input_tokens || 0);
                inputTokens += (usage.cache_read_input_tokens || 0);
                outputTokens += (usage.output_tokens || 0);
            }
        });
    }

    return {
        inputTokens,
        outputTokens,
        totalTokens: inputTokens + outputTokens
    };
}
