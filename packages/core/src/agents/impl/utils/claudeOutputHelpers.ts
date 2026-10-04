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

function hasToolResult(content: unknown): boolean {
    return Array.isArray(content) && content.some(block =>
        !!block && typeof block === 'object' && (block as { type?: unknown }).type === 'tool_result');
}

/**
 * The text of the final answer: every assistant text block after the last
 * tool result, in order. When a reply reaches the model's output-token limit,
 * Claude Code has the model continue in a new message, and the result line
 * then carries only that last message. Joining without a separator restores a
 * reply that was cut mid-token, such as a large JSON plan.
 */
export function getFinalAnswerText(conversationLog: Array<{ type?: string; message?: Record<string, unknown> }>): string {
    let start = 0;
    conversationLog.forEach((entry, index) => {
        if (entry?.type === 'user' && hasToolResult(entry.message?.content)) start = index + 1;
    });
    const parts: string[] = [];
    const seen = new Set<string>();
    for (const entry of conversationLog.slice(start)) {
        if (entry?.type !== 'assistant' || !Array.isArray(entry.message?.content)) continue;
        const messageId = typeof entry.message?.id === 'string' ? entry.message.id : '';
        (entry.message.content as unknown[]).forEach((block, blockIndex) => {
            if (!block || typeof block !== 'object' || (block as { type?: unknown }).type !== 'text') return;
            const text = (block as { text?: unknown }).text;
            if (typeof text !== 'string' || !text) return;
            // Stream output can repeat a message's content; count each block once.
            const key = messageId ? `${messageId}:${blockIndex}:${text.length}` : '';
            if (key && seen.has(key)) return;
            if (key) seen.add(key);
            parts.push(text);
        });
    }
    return parts.join('').trim();
}

export function getClaudeAnalysisText(claudeOutput: { finalResult?: { result?: string } | null; conversationLog: Array<{ type?: string; message?: Record<string, unknown> }> }): string {
    const resultText = (claudeOutput.finalResult?.result || '').trim();
    const assistantText = getLastAssistantText(claudeOutput.conversationLog);
    if (resultText && !GENERIC_CLAUDE_RESULT_TEXTS.has(resultText.toLowerCase())) {
        // The result line holds only the last message; prefer the whole
        // answer when the result is its continued tail.
        const finalAnswer = getFinalAnswerText(claudeOutput.conversationLog);
        return finalAnswer.length > resultText.length && finalAnswer.endsWith(resultText) ? finalAnswer : resultText;
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
    reasoningLevel?: string;
    usageMetrics?: UsageTrackingMetrics | null;
    metadata?: Record<string, unknown>;
}
