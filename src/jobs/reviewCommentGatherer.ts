/**
 * Gathers unprocessed AI review comments from a PR for inclusion in /fix prompts.
 *
 * When /fix runs it should automatically pick up AI review comments that:
 *   - Are still present on the PR (not deleted).
 *   - Have not already been consumed by a prior successful /fix run.
 *
 * Consumed comment IDs are tracked in a Redis set keyed per-PR so that a later
 * /fix does not repeatedly reapply the same review feedback.
 */

import type { Logger } from 'pino';
import type { Redis } from 'ioredis';
import { getProcessedReviewCommentsKey } from '@propr/core';
import { isReviewComment } from './reviewCommentFormatter.js';

export interface AIReviewComment {
    id: number;
    body: string;
    author: string;
    created_at: string;
}

interface PRComment {
    id: number;
    body: string | null;
    user: { login: string; type?: string };
    created_at: string;
}

interface GatherOptions {
    repoOwner: string;
    repoName: string;
    pullRequestNumber: number;
    redisClient: Redis;
    correlatedLogger: Logger;
}

/**
 * Scan all PR comments and return AI review comments that have not yet been
 * processed by a prior /fix run.
 */
export async function gatherUnprocessedReviewComments(
    allComments: PRComment[],
    options: GatherOptions,
): Promise<AIReviewComment[]> {
    const { repoOwner, repoName, pullRequestNumber, redisClient, correlatedLogger } = options;

    // 1. Filter to AI review comments using the structured marker.
    const aiReviewComments = allComments.filter(c => c.body && isReviewComment(c.body));

    if (aiReviewComments.length === 0) {
        correlatedLogger.debug({ pullRequestNumber }, 'No AI review comments found on PR');
        return [];
    }

    // 2. Load the set of already-processed review comment IDs from Redis.
    const redisKey = getProcessedReviewCommentsKey(repoOwner, repoName, pullRequestNumber);
    let processedIds: Set<string>;
    try {
        const members = await redisClient.smembers(redisKey);
        processedIds = new Set(members);
    } catch (err) {
        correlatedLogger.warn({ error: (err as Error).message }, 'Failed to load processed review comment IDs from Redis, treating all as unprocessed');
        processedIds = new Set();
    }

    // 3. Return only comments not yet processed.
    const unprocessed: AIReviewComment[] = [];
    for (const comment of aiReviewComments) {
        if (processedIds.has(String(comment.id))) {
            correlatedLogger.debug({ pullRequestNumber, commentId: comment.id }, 'AI review comment already processed, skipping');
            continue;
        }
        // Skip error review comments (they have error="true" in the marker)
        if (comment.body!.includes('error="true"')) {
            continue;
        }
        unprocessed.push({
            id: comment.id,
            body: comment.body!,
            author: comment.user.login,
            created_at: comment.created_at,
        });
    }

    correlatedLogger.info(
        { pullRequestNumber, totalReviewComments: aiReviewComments.length, unprocessedCount: unprocessed.length },
        'Gathered unprocessed AI review comments for /fix',
    );

    return unprocessed;
}

/**
 * Mark the given review comment IDs as processed so subsequent /fix runs skip them.
 * Uses a Redis set with a 30-day TTL.
 */
export async function markReviewCommentsProcessed(
    commentIds: number[],
    options: Pick<GatherOptions, 'repoOwner' | 'repoName' | 'pullRequestNumber' | 'redisClient' | 'correlatedLogger'>,
): Promise<void> {
    if (commentIds.length === 0) return;

    const { repoOwner, repoName, pullRequestNumber, redisClient, correlatedLogger } = options;
    const redisKey = getProcessedReviewCommentsKey(repoOwner, repoName, pullRequestNumber);
    const TTL_SECONDS = 30 * 24 * 3600; // 30 days

    try {
        await redisClient.sadd(redisKey, ...commentIds.map(String));
        await redisClient.expire(redisKey, TTL_SECONDS);
        correlatedLogger.info(
            { pullRequestNumber, count: commentIds.length, commentIds },
            'Marked AI review comments as processed',
        );
    } catch (err) {
        correlatedLogger.warn({ error: (err as Error).message }, 'Failed to mark review comments as processed in Redis');
    }
}
