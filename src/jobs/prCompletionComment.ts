import type { ClaudeCodeResponse } from '@propr/core';
import type { UnprocessedComment } from '@propr/core';
import { buildMetricsSection } from './prCommentJobUtils.js';
import { buildAttributionLine, buildSlashCommandsBlock } from '../shared/slashCommandsBlock.js';
import { buildWorkEvidenceMarker } from '../shared/workEvidenceMarker.js';

/** Filter out ultrafix synthetic comments (author='propr-ultrafix' or id=0) */
function filterRealComments(comments: UnprocessedComment[]): UnprocessedComment[] {
    return comments.filter(c => c.author !== 'propr-ultrafix' && c.id !== 0);
}

/** Build the processing comment IDs suffix, or empty string if no real comments */
function buildCommentIdsSuffix(comments: UnprocessedComment[]): string {
    const real = filterRealComments(comments);
    if (real.length === 0) return '';
    return `_Processing comment ID${real.length > 1 ? 's' : ''}: ${real.map(c => String(c.id) + '✓').join(', ')}_`;
}

export interface CommentContext {
    changesSummary: string;
    commitMessage: string;
    llm: string | null | undefined;
    authorsText: string;
    undoContext?: UndoLinkContext;
    taskUrl?: string;
    consumedReviewCommentIds?: number[];
}

export interface UndoLinkContext {
    repoOwner: string;
    repoName: string;
    prNumber: number;
    branchName: string;
    instructionCommentId: number;
}

interface CommitResult {
    commitHash: string;
}

interface ConversationTextBlock {
    type?: string;
    text?: string;
}

interface ConversationMessage {
    type?: string;
    message?: {
        content?: ConversationTextBlock[];
    };
}

function buildUndoLink(undoContext: UndoLinkContext, commitHash: string): string {
    const webUiUrl = process.env.WEB_UI_URL || process.env.FRONTEND_URL || 'https://gitfix.dev';
    const { repoOwner, repoName, prNumber, branchName, instructionCommentId } = undoContext;

    const params = new URLSearchParams({
        repo: repoName,
        owner: repoOwner,
        pr: String(prNumber),
        commit: commitHash,
        commentId: String(instructionCommentId),
        branch: branchName
    });

    return `${webUiUrl}/revert?${params.toString()}`;
}

function isDryCodeSummary(text: string): boolean {
    const trimmed = text.trim();
    if (!trimmed) return true;
    const lines = trimmed.split('\n').map(line => line.trim()).filter(Boolean);
    if (lines.some(line => /^[\w./-]+:$/.test(line))) return true;
    if (lines.some(line => /^output:$/i.test(line))) return true;
    if (lines.length <= 4 && lines.some(line => /^[\w./-]+:\d+/.test(line))) return true;
    if (lines.length <= 3 && lines.some(line => /^(print|return|const|let|var|if|def|class)\b/.test(line))) return true;
    return false;
}

function isSummaryEntry(text: string): boolean {
    const lower = text.trim().toLowerCase();
    return lower.includes('summary of changes')
        || lower.includes('implementation summary')
        || lower.startsWith('summary:')
        || lower.startsWith('the change is complete')
        || lower.startsWith('implementation complete')
        || lower.startsWith('completed ');
}

function textFromConversationMessage(message: ConversationMessage): string | null {
    if (message.type !== 'assistant' || !Array.isArray(message.message?.content)) return null;
    const text = message.message.content
        .filter(block => block.type === 'text' && typeof block.text === 'string')
        .map(block => block.text!.trim())
        .filter(Boolean)
        .join('\n\n')
        .trim();
    return text || null;
}

function getLatestUsefulConversationSummary(claudeResult: ClaudeCodeResponse): string | null {
    const conversationLog = (claudeResult.conversationLog || []) as ConversationMessage[];
    const assistantTexts = conversationLog
        .map(textFromConversationMessage)
        .filter((text): text is string => Boolean(text));

    for (let index = assistantTexts.length - 1; index >= 0; index--) {
        if (!isSummaryEntry(assistantTexts[index])) continue;
        const summaryThread = assistantTexts
            .slice(index)
            .filter(text => !isDryCodeSummary(text) || isSummaryEntry(text))
            .join('\n\n')
            .trim();
        if (summaryThread) return summaryThread;
    }

    for (const text of [...assistantTexts].reverse()) {
        if (!isDryCodeSummary(text)) return text;
    }
    return null;
}

function getCompletionSummary(claudeResult: ClaudeCodeResponse, commitMessage: string, changesSummary: string): string {
    const commitBody = commitMessage.split('\n\n').slice(1).join('\n\n').trim();
    const primarySummary = (claudeResult.summary || claudeResult.finalResult?.result || changesSummary || '').trim();
    const conversationSummary = getLatestUsefulConversationSummary(claudeResult);

    if (conversationSummary && (isDryCodeSummary(primarySummary) || isSummaryEntry(conversationSummary))) return conversationSummary;
    if (primarySummary && !isDryCodeSummary(primarySummary)) return primarySummary;

    return conversationSummary
        || primarySummary
        || commitBody
        || changesSummary;
}

export async function buildCompletionComment(
    commitResult: CommitResult | null,
    unprocessedComments: UnprocessedComment[],
    commentContext: CommentContext,
    claudeResult: ClaudeCodeResponse
): Promise<string> {
    const { changesSummary, commitMessage, llm, authorsText, undoContext, taskUrl, consumedReviewCommentIds } = commentContext;

    const cleanBody = (text: string) => {
        return text
            .replace(/^(PR|Comment by|Model):.*/gm, '')
            .replace(/\n{3,}/g, '\n\n')
            .trim();
    };

    if (commitResult) {
        let prCommentBody = `✅ **Applied the requested follow-up changes** in commit ${commitResult.commitHash.substring(0, 7)}\n\n`;

        if (unprocessedComments.length > 1) {
            prCommentBody += `Processed ${unprocessedComments.length} comments:\n`;
            unprocessedComments.forEach((comment, index) => {
                prCommentBody += `- Comment ${index + 1} by @${comment.author} (ID: ${String(comment.id)}✓)\n`;
            });
            prCommentBody += '\n';
        }

        if (consumedReviewCommentIds && consumedReviewCommentIds.length > 0) {
            prCommentBody += `> Addressed ${consumedReviewCommentIds.length} AI review comment${consumedReviewCommentIds.length > 1 ? 's' : ''} (IDs: ${consumedReviewCommentIds.join(', ')})\n\n`;
        }

        const contentToShow = getCompletionSummary(claudeResult, commitMessage, changesSummary);
        if (contentToShow) {
            prCommentBody += `## Summary of Changes\n\n${cleanBody(contentToShow)}\n\n`;
        }

        prCommentBody += await buildMetricsSection(claudeResult, llm, authorsText, false);

        if (undoContext) {
            const undoLink = buildUndoLink(undoContext, commitResult.commitHash);
            prCommentBody += `\n\n[Undo Changes](${undoLink})`;
            if (taskUrl) {
                prCommentBody += ` • [View Task Execution](${taskUrl})`;
            }
        } else if (taskUrl) {
            prCommentBody += `\n\n[View Task Execution](${taskUrl})`;
        }

        prCommentBody += `\n\n---\n`;
        prCommentBody += buildSlashCommandsBlock();
        prCommentBody += `${buildAttributionLine()}\n`;
        prCommentBody += buildCommentIdsSuffix(unprocessedComments);
        const completedEvidence = buildWorkEvidenceMarker('completed', filterRealComments(unprocessedComments).map(comment => comment.id));
        if (completedEvidence) prCommentBody += `\n${completedEvidence}`;

        return prCommentBody;
    } else {
        let noChangesBody = `ℹ️ **Analyzed the follow-up request** by ${authorsText}\n\n`;

        if (changesSummary) {
            noChangesBody += `## Analysis Summary\n\n${cleanBody(changesSummary)}\n\n`;
        }

        noChangesBody += `No code changes were necessary based on the current state of the branch.\n\n`;
        noChangesBody += await buildMetricsSection(claudeResult, llm, authorsText, true);

        if (taskUrl) {
            noChangesBody += `\n\n[View Task Execution](${taskUrl})`;
        }

        noChangesBody += `\n\n---\n`;
        noChangesBody += buildSlashCommandsBlock();
        noChangesBody += `${buildAttributionLine()}\n`;
        noChangesBody += buildCommentIdsSuffix(unprocessedComments);
        const completedEvidence = buildWorkEvidenceMarker('completed', filterRealComments(unprocessedComments).map(comment => comment.id));
        if (completedEvidence) noChangesBody += `\n${completedEvidence}`;

        return noChangesBody;
    }
}
