import type { Redis } from 'ioredis';
import { logger } from '@propr/core';
import { createFollowupGateEvaluator, getSystemBotUsernames, isSystemFollowupComment, refuseGatedComment, type FollowupGateEvaluator } from '@propr/core';

/** The follow-up assignment gate as polling intake applies it, with the refused comments it remembers. */

interface GateContext {
    owner: string;
    repo: string;
    correlationId: string;
}

interface GatedComment {
    id: number;
    body: string | null;
    user: { id: number; login: string };
}

/**
 * How long polling remembers a comment the assignment gate refused. Polling
 * reads a pull request's whole comment history every time, and a refused
 * comment never gets the bot's `✓` reply that marks a handled one, so without
 * this it would be gated again on every poll and queued once its author was
 * assigned. Remembering it drops it, as a webhook delivery does.
 */
export const REFUSED_COMMENT_TTL_SECONDS = 30 * 24 * 60 * 60;

export interface RefusedComment {
    owner: string;
    repo: string;
    prNumber: number;
    commentId: number;
}

export function refusedCommentKey({ owner, repo, prNumber, commentId }: RefusedComment): string {
    return `pr-comment-refused:${owner}:${repo}:${prNumber}:${commentId}`;
}

export async function rememberRefusedComment(redisClient: Redis, comment: RefusedComment): Promise<void> {
    await redisClient.setex(refusedCommentKey(comment), REFUSED_COMMENT_TTL_SECONDS, Date.now().toString());
}

export async function wasRefused(redisClient: Redis, comment: RefusedComment): Promise<boolean> {
    return Boolean(await redisClient.get(refusedCommentKey(comment)));
}

/**
 * The follow-up assignment gate for one pull request, shared by every comment
 * on it: the setting and the live assignees are read at most once per poll,
 * and each refused author is reported once. A comment refused because its
 * author is not assigned is remembered, so later polls skip it rather than ask
 * the gate again; one refused because the assignees could not be read is not.
 */
export function createPollingGate(prNumber: number, commentContext: GateContext, redisClient: Redis) {
    const { owner, repo, correlationId } = commentContext;
    const pullRequest = { repoOwner: owner, repoName: repo, pullRequestNumber: prNumber };
    let evaluator: Promise<FollowupGateEvaluator> | null = null;
    const refused = new Set<string>();
    const systemBotUsernames = getSystemBotUsernames();

    return async function mayFollowUp(comment: GatedComment): Promise<boolean> {
        evaluator ??= createFollowupGateEvaluator(pullRequest);
        const authorLogin = comment.user.login;
        // ProPR's own comments can reach here (e.g. when its login is in
        // GITHUB_USER_WHITELIST), so classify them exactly as the webhook does.
        const systemAuthored = isSystemFollowupComment(authorLogin, comment.body, systemBotUsernames);
        const decision = await (await evaluator).decide({ authorId: comment.user.id, authorLogin, systemAuthored });
        if (decision.allowed) return true;
        // An unreadable assignment is ProPR's outage, not a verdict on the
        // author: leave the comment unremembered so the next poll asks again.
        if (decision.reason !== 'author_not_assigned') return false;
        try {
            await rememberRefusedComment(redisClient, { owner, repo, prNumber, commentId: comment.id });
        } catch (error) {
            // Not remembered: the next poll asks the gate about it again.
            logger.withCorrelation(correlationId).warn({ pullRequestNumber: prNumber, commentId: comment.id, error: (error as Error).message }, 'Failed to record a refused PR comment');
        }
        if (!refused.has(authorLogin.toLowerCase())) {
            refused.add(authorLogin.toLowerCase());
            await refuseGatedComment(
                { ...pullRequest, authorLogin, commentId: comment.id, decision },
                { redisClient, correlatedLogger: logger.withCorrelation(correlationId) },
            );
        }
        return false;
    };
}
