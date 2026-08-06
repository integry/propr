import type { Job } from 'bullmq';
import type { Logger } from 'pino';
import type { Redis } from 'ioredis';
import type { CommentJobData } from '@propr/core';
import { formatActionableFindings, gatherUnprocessedReviewComments } from './reviewCommentGatherer.js';
import type { AIReviewComment, ActionableFinding, ReviewSuggestion } from './reviewCommentGatherer.js';

export interface FixFindingSelection {
    actionableIds: Set<string> | null;
    includedSuggestionIds: Set<string>;
    remainingInstructions: string;
}

/**
 * Parse `/fix F1 F3` and `/fix include S2` selectors from a dedicated leading
 * clause. Extra instructions can follow on a new line or after a semicolon.
 * Finding-like tokens in ordinary instruction prose are left untouched.
 */
export function parseFixFindingSelection(instructions: string): FixFindingSelection {
    const trimmedInstructions = instructions.trim();
    const clauseEnd = trimmedInstructions.search(/[;\r\n]/);
    const selectorClause = (clauseEnd === -1
        ? trimmedInstructions
        : trimmedInstructions.slice(0, clauseEnd)).trim();
    const selectorTokens = selectorClause.replace(/,/g, ' ').split(/\s+/).filter(Boolean);
    const selectedIds = new Set<string>();
    const includedSuggestionIds = new Set<string>();
    let validSelectorClause = selectorTokens.length > 0;

    for (let index = 0; validSelectorClause && index < selectorTokens.length;) {
        const token = selectorTokens[index];
        if (/^F\d+$/i.test(token)) {
            selectedIds.add(token.toUpperCase());
            index += 1;
            continue;
        }
        if (/^include$/i.test(token)) {
            index += 1;
            const suggestionStart = index;
            while (index < selectorTokens.length && /^S\d+$/i.test(selectorTokens[index])) {
                includedSuggestionIds.add(selectorTokens[index].toUpperCase());
                index += 1;
            }
            validSelectorClause = index > suggestionStart;
            continue;
        }
        validSelectorClause = false;
    }

    if (!validSelectorClause) {
        selectedIds.clear();
        includedSuggestionIds.clear();
    }

    const remainingInstructions = validSelectorClause
        ? (clauseEnd === -1 ? '' : trimmedInstructions.slice(clauseEnd + 1).trim())
        : trimmedInstructions;
    return {
        actionableIds: selectedIds.size > 0 ? selectedIds : null,
        includedSuggestionIds,
        remainingInstructions,
    };
}

export function selectReviewFeedback(
    comments: AIReviewComment[],
    selection: FixFindingSelection,
): AIReviewComment[] {
    const hasExplicitSelector = selection.actionableIds !== null || selection.includedSuggestionIds.size > 0;
    const candidateComments = hasExplicitSelector && comments.length > 0
        ? [comments.reduce((latest, comment) => {
            const timeDifference = new Date(comment.created_at).getTime() - new Date(latest.created_at).getTime();
            return timeDifference > 0 || (timeDifference === 0 && comment.id > latest.id) ? comment : latest;
        })]
        : comments;

    return candidateComments.map(comment => {
        const actionableFindings = selection.actionableIds
            ? comment.actionableFindings.filter(finding => selection.actionableIds!.has(finding.id))
            : comment.actionableFindings;
        const suggestions = comment.suggestions.filter(suggestion => selection.includedSuggestionIds.has(suggestion.id));
        return {
            ...comment,
            body: formatActionableFindings(actionableFindings),
            actionableFindings,
            suggestions,
        };
    }).filter(comment => comment.actionableFindings.length > 0 || comment.suggestions.length > 0);
}

export async function prepareFixReviewFeedback(params: {
    job: Job<CommentJobData>;
    allComments: Array<{ id: number; body: string | null; user: { login: string; type?: string }; created_at: string }>;
    repoOwner: string;
    repoName: string;
    pullRequestNumber: number;
    redisClient: Redis;
    correlatedLogger: Logger;
}): Promise<{
    isFixMode: boolean;
    fixSelection: FixFindingSelection;
    selectedReviewComments: AIReviewComment[];
    reviewCommentsSection: string;
}> {
    const { job, allComments, repoOwner, repoName, pullRequestNumber, redisClient, correlatedLogger } = params;
    const emptySelection = { actionableIds: null, includedSuggestionIds: new Set<string>(), remainingInstructions: '' };
    if (job.data.commandMode !== 'fix') {
        return { isFixMode: false, fixSelection: emptySelection, selectedReviewComments: [], reviewCommentsSection: '' };
    }

    const unprocessedReviewComments = await gatherUnprocessedReviewComments(allComments, {
        repoOwner, repoName, pullRequestNumber, redisClient, correlatedLogger,
    });
    // Automated Ultrafix always selects all F# blockers and never suggestions.
    const fixSelection = job.data.ultrafixMeta
        ? { ...emptySelection, remainingInstructions: job.data.commandInstructions || '' }
        : parseFixFindingSelection(job.data.commandInstructions || '');
    const selectedReviewComments = selectReviewFeedback(unprocessedReviewComments, fixSelection);
    return {
        isFixMode: true,
        fixSelection,
        selectedReviewComments,
        reviewCommentsSection: formatReviewCommentsSection(selectedReviewComments, unprocessedReviewComments),
    };
}

function formatActionableRecord(finding: ActionableFinding, commentId: number): string {
    return [
        `### ${finding.id}: ${finding.title}`,
        `- **Source review comment:** ${commentId}`,
        `- **Violated requirement:** ${finding.violatedRequirement}`,
        `- **Changed-code evidence:** ${finding.evidence}`,
        `- **Why introduced by this PR:** ${finding.introducedByPRExplanation}`,
        `- **Minimum necessary correction:** ${finding.minimumCorrection}`,
    ].join('\n');
}

function formatAuthorizedSuggestion(suggestion: ReviewSuggestion, commentId: number): string {
    return [
        `### ${suggestion.id}: ${suggestion.title}`,
        `- **Source review comment:** ${commentId}`,
        `- **Explicitly authorized summary:** ${suggestion.summary}`,
    ].join('\n');
}

export function formatReviewCommentsSection(
    selectedComments: AIReviewComment[],
    allComments: AIReviewComment[] = selectedComments,
): string {
    const actionable = selectedComments.flatMap(comment =>
        comment.actionableFindings.map(finding => formatActionableRecord(finding, comment.id)),
    );
    const authorizedSuggestions = selectedComments.flatMap(comment =>
        comment.suggestions.map(suggestion => formatAuthorizedSuggestion(suggestion, comment.id)),
    );
    const allSuggestionIds = [...new Set(allComments.flatMap(comment => comment.suggestions.map(suggestion => suggestion.id)))];
    const selectedSuggestionIds = new Set(selectedComments.flatMap(comment => comment.suggestions.map(suggestion => suggestion.id)));
    const informationalIds = allSuggestionIds.filter(id => !selectedSuggestionIds.has(id));

    const lines = ['**Selected Review Finding Records:**', ''];
    if (actionable.length > 0) {
        const ids = selectedComments.flatMap(comment => comment.actionableFindings.map(finding => finding.id));
        lines.push(`Address actionable finding${ids.length === 1 ? '' : 's'} ${ids.join(', ')} only.`, '', ...actionable);
    } else {
        lines.push('No actionable findings were selected.');
    }
    if (authorizedSuggestions.length > 0) {
        lines.push('', '**Explicitly Authorized Suggestions:**', '', ...authorizedSuggestions);
    }
    lines.push('', 'Do not implement any suggestion that is not explicitly authorized above.');
    if (informationalIds.length > 0) {
        lines.push(`Informational suggestion IDs (autoFix: false): ${informationalIds.join(', ')}.`);
    }
    return lines.join('\n');
}
