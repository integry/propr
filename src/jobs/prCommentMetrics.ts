import type { ClaudeCodeResponse, ClaudeResult } from '@propr/core';
import { getDetailedUsageStats, calculateCostWithCachePricing } from '@propr/core';
import type { DetailedUsageStats } from '@propr/core';
import { getModelName, getModelPricing, getOpenRouterId, getDefaultModel, formatSubscriptionUsage } from '@propr/core';

function formatDuration(ms: number): string {
    const seconds = Math.floor(ms / 1000);
    const m = Math.floor(seconds / 60);
    const s = seconds % 60;
    if (m === 0) return `${s}s`;
    return `${m}m ${s}s`;
}

async function calculateCost(
    claudeResult: ClaudeCodeResponse,
    detailedStats: DetailedUsageStats,
    modelId: string | null | undefined
): Promise<number | undefined | null> {
    // Calculate cost using OpenRouter pricing with cache-aware multipliers
    const cost = claudeResult.finalResult?.cost_usd || (claudeResult.finalResult as { total_cost_usd?: number } | null)?.total_cost_usd;

    if ((cost === 0 || cost == null) && detailedStats.totalTokens > 0 && modelId) {
        try {
            const openRouterId = getOpenRouterId(modelId);
            const pricing = await getModelPricing(openRouterId);
            if (pricing) {
                return calculateCostWithCachePricing(modelId, detailedStats, pricing);
            }
        } catch {
            // Fall back to finalResult.cost_usd if pricing lookup fails
        }
    }
    return cost;
}

export async function buildMetricsSection(
    claudeResult: ClaudeCodeResponse,
    llm: string | null | undefined,
    authorsText: string,
    isAnalysis = false
): Promise<string> {
    const modelId = claudeResult.model || llm || getDefaultModel() || 'unknown';
    const modelDisplayName = getModelName(modelId);
    const executionTime = claudeResult.executionTime ? formatDuration(claudeResult.executionTime) : null;
    const numTurns = (claudeResult.finalResult as { num_turns?: number } | null)?.num_turns;

    const detailedStats = getDetailedUsageStats({ conversationLog: claudeResult.conversationLog as ClaudeResult['conversationLog'] });
    const { totalInputWithCache: inputTokens, outputTokens, totalTokens } = detailedStats;

    const cost = await calculateCost(claudeResult, detailedStats, modelId);

    let section = `\n---\n`;
    section += `### 🤖 ${isAnalysis ? 'Analysis' : 'Implementation'} Details\n\n`;

    section += `* **Model:** ${modelDisplayName}\n`;
    if (!isAnalysis) section += `* **Requested By:** ${authorsText}\n`;
    if (numTurns) section += `* **Turns:** ${numTurns}\n`;
    if (executionTime) section += `* **Time:** ${executionTime}\n`;
    if (totalTokens > 0) section += `* **Tokens:** ${totalTokens.toLocaleString()} (${inputTokens.toLocaleString()} in / ${outputTokens.toLocaleString()} out)\n`;
    if (cost != null && cost > 0) section += `* **Cost:** $${cost.toFixed(2)}\n`;

    const subscriptionUsage = formatSubscriptionUsage((claudeResult as unknown as Record<string, unknown>).usageMetrics as Parameters<typeof formatSubscriptionUsage>[0]);
    if (subscriptionUsage) section += `* **Subscription usage:** ${subscriptionUsage}\n`;

    return section;
}
