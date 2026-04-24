import type { ClaudeCodeResponse } from '@propr/core';
import type { UnprocessedComment } from '@propr/core';
import { AgentRegistry, getModelShortName } from '@propr/core';
import { buildMetricsSection } from './prCommentJobUtils.js';

/**
 * Pick a random model label from all configured and enabled agents' supported models.
 * Returns a short display name suitable for a `/review <model>` suggestion.
 */
function getRandomReviewModelSuggestion(): string | null {
    try {
        const registry = AgentRegistry.getInstance();
        const agents = registry.getAllAgents();
        const models: string[] = [];
        for (const agent of agents) {
            if (agent.config.enabled) {
                for (const m of agent.config.supportedModels) {
                    models.push(m);
                }
            }
        }
        if (models.length === 0) return null;
        const chosen = models[Math.floor(Math.random() * models.length)];
        return getModelShortName(chosen);
    } catch {
        return null;
    }
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

        if (changesSummary) {
            const commitBody = commitMessage.split('\n\n').slice(1).join('\n\n').trim();
            const contentToShow = commitBody || changesSummary;
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
        const modelHint1 = getRandomReviewModelSuggestion();
        const reviewExample1 = modelHint1 ? `\`/review ${modelHint1}\`` : '`/review`';
        prCommentBody += `> 💡 **Tip:** Use ${reviewExample1} to request an AI code review with a specific model.\n\n`;
        prCommentBody += `_Processing comment ID${unprocessedComments.length > 1 ? 's' : ''}: ${unprocessedComments.map(c => String(c.id) + '✓').join(', ')}_`;

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
        const modelHint2 = getRandomReviewModelSuggestion();
        const reviewExample2 = modelHint2 ? `\`/review ${modelHint2}\`` : '`/review`';
        noChangesBody += `> 💡 **Tip:** Use ${reviewExample2} to request an AI code review with a specific model.\n\n`;
        noChangesBody += `_Processing comment ID${unprocessedComments.length > 1 ? 's' : ''}: ${unprocessedComments.map(c => String(c.id) + '✓').join(', ')}_`;

        return noChangesBody;
    }
}
