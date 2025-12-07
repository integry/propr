import type { Logger } from 'pino';
import { resolveModelAlias } from '../config/modelAliases.ts';
import type { Label } from '@octokit/webhooks-types';

export type CommentEventType = 'issue_comment' | 'pull_request_review_comment';

const DEFAULT_MODEL_LABEL_PATTERN = '^llm-claude-(.+)$';

export function extractLlmFromKeywords(commentBody: string, keywords: string[]): string | null {
    for (const keyword of keywords) {
        const llmMatch = commentBody.match(new RegExp(`${keyword.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}:([\\w.-]+)`));
        if (llmMatch) {
            const resolved = resolveModelAlias(llmMatch[1]);
            if (resolved) return resolved;
        }
    }
    return null;
}

export function stripKeywordsFromBody(body: string, keywords: string[]): string {
    let result = body;
    for (const keyword of keywords) {
        const escapedKeyword = keyword.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        result = result.replace(new RegExp(`${escapedKeyword}(:\\w+)?`, 'g'), '');
    }
    return result.trim();
}

export function buildCodeContext(comment: { path?: string; line?: number | null; diff_hunk?: string }): string[] {
    const codeContext: string[] = [];
    if (comment.path) codeContext.push(`File: ${comment.path}`);
    if (comment.line) codeContext.push(`Line: ${comment.line}`);
    if (comment.diff_hunk) {
        codeContext.push('Code context:', '```diff', comment.diff_hunk, '```');
    }
    return codeContext;
}

export function isReviewComment(comment: { pull_request_review_id?: number }, eventType: CommentEventType): boolean {
    return !!comment.pull_request_review_id || eventType === 'pull_request_review_comment';
}

export function extractLlmFromLabels(
    prLabels: Label[],
    modelLabelPattern: string,
    prNumber: number,
    correlatedLogger: Logger
): string | null {
    const modelLabelRegex = new RegExp(modelLabelPattern || DEFAULT_MODEL_LABEL_PATTERN);
    for (const label of prLabels) {
        const labelName = typeof label === 'string' ? label : label.name;
        const match = labelName.match(modelLabelRegex);
        if (match) {
            const resolved = resolveModelAlias(match[1]);
            correlatedLogger.debug({ pullRequestNumber: prNumber, label: labelName, resolvedModel: resolved }, 'Extracted model from PR label (webhook)');
            return resolved;
        }
    }
    return null;
}
