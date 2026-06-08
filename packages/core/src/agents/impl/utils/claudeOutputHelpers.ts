import type { TokenUsage } from '../../types.js';
import type { ExecutionResult } from '../../../claude/docker/dockerExecutor.js';
import type { UsageTrackingMetrics } from './usageTrackingWrapper.js';

const GENERIC_CLAUDE_RESULT_TEXTS = new Set(['task completed.', 'task completed']);

export function getTextFromClaudeContent(content: unknown): string {
    if (!Array.isArray(content)) return '';
    return content
        .map(block => {
            if (block && typeof block === 'object' && 'type' in block && (block as { type?: unknown }).type === 'text') {
                const text = (block as { text?: unknown }).text;
                return typeof text === 'string' ? text : '';
            }
            return '';
        })
        .filter(Boolean)
        .join('\n')
        .trim();
}

export function getLastAssistantText(conversationLog: Array<{ type?: string; message?: Record<string, unknown> }>): string {
    for (let index = conversationLog.length - 1; index >= 0; index--) {
        const entry = conversationLog[index];
        if (entry?.type !== 'assistant') continue;
        const text = getTextFromClaudeContent(entry.message?.content);
        if (text) return text;
    }
    return '';
}

export function getClaudeAnalysisText(claudeOutput: { finalResult?: { result?: string } | null; conversationLog: Array<{ type?: string; message?: Record<string, unknown> }> }): string {
    const resultText = (claudeOutput.finalResult?.result || '').trim();
    const assistantText = getLastAssistantText(claudeOutput.conversationLog);
    if (resultText && !GENERIC_CLAUDE_RESULT_TEXTS.has(resultText.toLowerCase())) {
        return resultText;
    }
    return assistantText || resultText;
}

export interface PersistLogsParams {
    result: ExecutionResult;
    prompt: string;
    issueRef: { number: number; repoOwner: string; repoName: string };
    modelUsed: string;
    isRetry: boolean;
    retryReason?: string;
    executionTime: number;
    correctedTokenUsage: TokenUsage | undefined;
    taskId?: string;
    prNumber?: number;
    usageMetrics?: UsageTrackingMetrics | null;
}
