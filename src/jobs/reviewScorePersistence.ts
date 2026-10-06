import type { Logger } from 'pino';
import type { Knex } from 'knex';
import { db, recordReviewScores, type ReviewScoreInput } from '@propr/core';
import { parseStructuredReview } from './reviewOutputParser.js';

interface ScoredReviewResult {
    assignment: { agentAlias: string; model: string; physicalAgentAlias?: string; physicalModel?: string };
    analysisResult: { success: boolean; response: string; modelUsed?: string };
}

export interface ReviewScoreContext {
    repository: string;
    pullRequestNumber: number;
    taskId: string;
    headSha?: string | null;
    /** The Ultrafix history metadata of the cycle; absent for a plain `/review`. */
    ultrafix?: { ultrafixCycle?: unknown; ultrafixGoal?: unknown };
}

const positiveInteger = (value: unknown): number | null => {
    const number = typeof value === 'string' && value.trim() ? Number(value) : value;
    return typeof number === 'number' && Number.isSafeInteger(number) && number > 0 ? number : null;
};

/**
 * One row per reviewer whose response parsed into a valid scored review.
 * Failed or unparseable reviews have no score, so they write nothing. The
 * score is the parser's, which caps a review that still lists blockers at 6,
 * the same score the published comment and the Ultrafix goal check use.
 */
export function buildReviewScoreInputs(
    results: readonly ScoredReviewResult[], context: ReviewScoreContext, createdAt = new Date(),
): ReviewScoreInput[] {
    return results.flatMap(result => {
        if (!result.analysisResult.success) return [];
        const review = parseStructuredReview(result.analysisResult.response);
        if (review.status === 'invalid' || review.score === null) return [];
        return [{
            repository: context.repository,
            prNumber: context.pullRequestNumber,
            taskId: context.taskId,
            reviewerAgent: result.assignment.physicalAgentAlias || result.assignment.agentAlias || null,
            reviewerModel: result.analysisResult.modelUsed || result.assignment.physicalModel || result.assignment.model || null,
            score: review.score,
            blockerCount: review.actionableFindings.length,
            suggestionCount: review.suggestions.length,
            source: context.ultrafix ? 'ultrafix' as const : 'review' as const,
            cycleNumber: context.ultrafix ? positiveInteger(context.ultrafix.ultrafixCycle) : null,
            goal: context.ultrafix ? positiveInteger(context.ultrafix.ultrafixGoal) : null,
            headSha: context.headSha ?? null,
            createdAt,
        }];
    });
}

/** Persist parsed scores. Analytics are best effort and never fail the review. */
export async function persistReviewScores(
    results: readonly ScoredReviewResult[], context: ReviewScoreContext, logger: Logger, database: Knex = db,
): Promise<number> {
    const inputs = buildReviewScoreInputs(results, context);
    if (inputs.length === 0) return 0;
    try {
        return await recordReviewScores(database, inputs);
    } catch (error) {
        logger.warn({ error: (error as Error).message, taskId: context.taskId, pullRequestNumber: context.pullRequestNumber },
            'Failed to persist review scores');
        return 0;
    }
}
