import type { Logger } from 'pino';
import { resolveModelAlias } from '../config/modelAliases.js';
import type { Label } from '@octokit/webhooks-types';

export type CommentEventType = 'issue_comment' | 'pull_request_review_comment';

const DEFAULT_MODEL_LABEL_PATTERN = '^llm-(.+)$';

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

/**
 * Derive the label prefix from a MODEL_LABEL_PATTERN regex string.
 * For example, '^llm-(.+)$' → 'llm-', '^ai-model-(.+)$' → 'ai-model-'.
 *
 * Only supports patterns where the prefix is a simple literal (no regex
 * metacharacters) followed by a single capture group.  Patterns with
 * non-capturing groups, alternations, or other constructs are rejected
 * and the default 'llm-' prefix is returned.
 */
export function modelLabelPrefix(pattern: string): string {
    const clean = pattern.replace(/^\^/, '').replace(/\$$/, '');
    const idx = clean.indexOf('(');
    if (idx <= 0) return 'llm-';

    const prefix = clean.slice(0, idx);

    // Reject if the prefix contains regex metacharacters — it's not a simple literal.
    if (/[\\.*+?^${}()|[\]]/.test(prefix)) return 'llm-';

    return prefix;
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
