import type { Job } from 'bullmq';
import type { Logger } from 'pino';
import type { Redis } from 'ioredis';
import type { CommentJobData } from '@propr/core';
import { formatActionableFindings, gatherUnprocessedReviewComments } from './reviewCommentGatherer.js';
import type { AIReviewComment, ActionableFinding } from './reviewCommentGatherer.js';

export interface FixFindingSelection {
    actionableIds: Set<string> | null;
    remainingInstructions: string;
}

/**
 * Parse `/fix F1 F3` selectors from a leading clause.
 * Extra instructions can follow the selector directly, on a new line, or after
 * a semicolon. Finding-like tokens in ordinary instruction prose are left
 * untouched.
 */
export function parseFixFindingSelection(instructions: string): FixFindingSelection {
    const trimmedInstructions = instructions.trim();
    const clauseEnd = trimmedInstructions.search(/[;\r\n]/);
    const selectorClause = (clauseEnd === -1
        ? trimmedInstructions
        : trimmedInstructions.slice(0, clauseEnd)).trim();
    const selectorTokens = [...selectorClause.matchAll(/[^,\s]+/g)].map(match => ({
        value: match[0],
        start: match.index,
    }));
    const selectedIds = new Set<string>();
    let recognizedSelector = false;
    let attemptedSelector = false;
    let invalidSelector = false;
    let instructionsStart: number | null = null;

    for (let index = 0; index < selectorTokens.length;) {
        const token = selectorTokens[index].value;
        if (/^F\d+$/i.test(token)) {
            attemptedSelector = true;
            recognizedSelector = true;
            selectedIds.add(token.toUpperCase());
            index += 1;
            continue;
        }
        const isSuggestionSelector = /^S\d+$/i.test(token)
            || (/^include$/i.test(token) && /^S\d+$/i.test(selectorTokens[index + 1]?.value ?? ''));
        if (isSuggestionSelector) {
            // Suggestion selectors are invalid for `/fix`; fail the entire
            // selector closed even if an actionable ID preceded one.
            attemptedSelector = true;
            invalidSelector = true;
            instructionsStart = selectorTokens[index].start;
            break;
        }
        if (/^include$/i.test(token)) {
            attemptedSelector = true;
            instructionsStart = selectorTokens[index].start;
            break;
        }
        attemptedSelector ||= /^(?:F|S)\d/i.test(token);
        instructionsStart = selectorTokens[index].start;
        break;
    }

    const remainingInstructions = recognizedSelector
        ? (instructionsStart === null
            ? (clauseEnd === -1 ? '' : trimmedInstructions.slice(clauseEnd + 1).trim())
            : trimmedInstructions.slice(instructionsStart).trim())
        : trimmedInstructions;
    let actionableIds: Set<string> | null = null;
    if (invalidSelector || (attemptedSelector && !recognizedSelector)) {
        actionableIds = new Set<string>();
    } else if (selectedIds.size > 0) {
        actionableIds = selectedIds;
    }
    return {
        actionableIds,
        remainingInstructions,
    };
}

export function selectReviewFeedback(
    comments: AIReviewComment[],
    selection: FixFindingSelection,
): AIReviewComment[] {
    const hasExplicitSelector = selection.actionableIds !== null;
    const selectedCommentByFindingId = new Map<string, number>();
    if (hasExplicitSelector) {
        const newestFirst = [...comments].sort((left, right) =>
            new Date(right.created_at).getTime() - new Date(left.created_at).getTime()
            || right.id - left.id,
        );
        for (const comment of newestFirst) {
            for (const finding of comment.actionableFindings) {
                const id = finding.id.toUpperCase();
                if (selection.actionableIds!.has(id) && !selectedCommentByFindingId.has(id)) {
                    selectedCommentByFindingId.set(id, comment.id);
                }
            }
        }
    }

    return comments.map(comment => {
        const actionableFindings = selection.actionableIds
            ? comment.actionableFindings.filter(finding =>
                selectedCommentByFindingId.get(finding.id.toUpperCase()) === comment.id,
            )
            : comment.actionableFindings;
        return {
            ...comment,
            body: formatActionableFindings(actionableFindings),
            actionableFindings,
            suggestions: [],
        };
    }).filter(comment => comment.actionableFindings.length > 0);
}

/**
 * Selected comments are the authorization boundary for `/fix`: actionable
 * findings are authorized by default or by F# selector. Suggestions never
 * enter the automatic fix scope.
 */
export function hasAuthorizedFixFeedback(selectedComments: AIReviewComment[]): boolean {
    return selectedComments.some(comment => comment.actionableFindings.length > 0);
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
    const emptySelection: FixFindingSelection = { actionableIds: null, remainingInstructions: '' };
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
        reviewCommentsSection: formatReviewCommentsSection(selectedReviewComments),
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

export function formatReviewCommentsSection(
    selectedComments: AIReviewComment[],
): string {
    const actionable = selectedComments.flatMap(comment =>
        comment.actionableFindings.map(finding => formatActionableRecord(finding, comment.id)),
    );
    const lines = ['**Selected Review Finding Records:**', ''];
    if (actionable.length > 0) {
        const ids = selectedComments.flatMap(comment => comment.actionableFindings.map(finding => finding.id));
        lines.push(`Address actionable finding${ids.length === 1 ? '' : 's'} ${ids.join(', ')} only.`, '', ...actionable);
    } else {
        lines.push('No actionable findings were selected.');
    }
    lines.push('', 'Do not implement suggestions through `/fix`; they require a separate ordinary follow-up request.');
    return lines.join('\n');
}
