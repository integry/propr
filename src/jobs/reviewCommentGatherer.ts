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

export interface PendingReviewState {
    /** Unprocessed AI review comments (boilerplate already stripped). */
    unprocessedComments: AIReviewComment[];
    /** The most recent valid review score (1–10), or null if none found. */
    latestScore: number | null;
    /** Whether any unprocessed review comments exist. */
    hasPendingReview: boolean;
}

interface PRComment {
    id: number;
    body: string | null;
    user: { login: string; type?: string };
    created_at: string;
}

export interface GatherOptions {
    repoOwner: string;
    repoName: string;
    pullRequestNumber: number;
    redisClient: Redis;
    correlatedLogger: Logger;
    /** Maximum age of review comments to include, in milliseconds. Defaults to 7 days. */
    maxAgeMs?: number;
}

/** Default max age: 7 days */
const DEFAULT_MAX_AGE_MS = 7 * 24 * 3600 * 1000;

/**
 * RegExp matching a "Score: N/10" line in the review body.
 * Accepts optional whitespace and the integer 1–10.
 */
const SCORE_RE = /Score:\s*(\d{1,2})\s*\/\s*10/;

/**
 * RegExp matching the error variant of the AI review marker.
 * Uses the structured marker format rather than a brittle substring check.
 */
const ERROR_MARKER_RE = /<!-- propr:ai-review [^>]*error="true"[^>]* -->/;

/**
 * Strip machine-readable markers and the /fix instruction tip from a review
 * comment body so the implementation prompt only contains actionable content.
 */
export function stripReviewBoilerplate(body: string): string {
    // Remove the HTML marker comment
    let cleaned = body.replace(/\n?<!-- propr:ai-review [^>]* -->/g, '');
    // Remove the /fix tip blockquote section
    cleaned = cleaned.replace(/\n?---\n> 💡 \*\*Tip:\*\* Comment `\/fix`[^\n]*(?:\n[^\n]*`\/fix[^\n]*)*/g, '');
    return cleaned.trimEnd();
}

/**
 * Scan all PR comments and return recent AI review comments that have not yet
 * been processed by a prior /fix run.
 *
 * "Recent" is defined by `maxAgeMs` (default 7 days) — older review comments
 * are excluded to keep the implementation prompt focused on current feedback.
 */
export async function gatherUnprocessedReviewComments(
    allComments: PRComment[],
    options: GatherOptions,
): Promise<AIReviewComment[]> {
    const { repoOwner, repoName, pullRequestNumber, redisClient, correlatedLogger, maxAgeMs = DEFAULT_MAX_AGE_MS } = options;

    const cutoff = Date.now() - maxAgeMs;

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

    // 3. Return only recent comments not yet processed.
    const unprocessed: AIReviewComment[] = [];
    for (const comment of aiReviewComments) {
        if (processedIds.has(String(comment.id))) {
            correlatedLogger.debug({ pullRequestNumber, commentId: comment.id }, 'AI review comment already processed, skipping');
            continue;
        }
        // Skip error review comments using the structured marker regex
        if (ERROR_MARKER_RE.test(comment.body!)) {
            continue;
        }
        // Skip comments older than the recency cutoff
        if (new Date(comment.created_at).getTime() < cutoff) {
            correlatedLogger.debug({ pullRequestNumber, commentId: comment.id }, 'AI review comment too old, skipping');
            continue;
        }
        unprocessed.push({
            id: comment.id,
            body: stripReviewBoilerplate(comment.body!),
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
 * Extract a numeric review score from a review comment body.
 * Looks for the "Score: N/10" pattern emitted by the review prompt.
 * Returns the integer score (1–10) or null if no valid score is found.
 */
export function extractReviewScore(body: string): number | null {
    const cleaned = stripReviewBoilerplate(body);
    const match = cleaned.match(SCORE_RE);
    if (!match) return null;
    const score = parseInt(match[1], 10);
    if (score < 1 || score > 10) return null;
    return score;
}

/**
 * Return the pending review state for orchestration (e.g. /ultrafix).
 *
 * This is a convenience wrapper around `gatherUnprocessedReviewComments` that
 * also extracts the latest usable review score from the unprocessed comments.
 * The most recent comment (by `created_at`) with a valid score wins.
 */
export async function getPendingReviewState(
    allComments: PRComment[],
    options: GatherOptions,
): Promise<PendingReviewState> {
    const unprocessedComments = await gatherUnprocessedReviewComments(allComments, options);

    // Walk comments newest-first to find the most recent valid score.
    let latestScore: number | null = null;
    const sorted = [...unprocessedComments].sort(
        (a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime(),
    );
    for (const comment of sorted) {
        const score = extractReviewScore(comment.body);
        if (score !== null) {
            latestScore = score;
            break;
        }
    }

    return {
        unprocessedComments,
        latestScore,
        hasPendingReview: unprocessedComments.length > 0,
    };
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
