import type { Redis } from 'ioredis';
import { logger } from '@propr/core';
import { createFollowupGateEvaluator, getSystemBotUsernames, isSystemFollowupComment, refuseGatedComment, rememberRefusedComment, type FollowupGateEvaluator } from '@propr/core';

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
 * The follow-up assignment gate for one pull request, shared by every comment
 * on it: the setting and the live assignees are read at most once per poll,
 * and each refused author is reported once. A comment refused because its
 * author is not assigned is remembered in the record webhook intake shares, so
 * later polls and webhook redeliveries skip it rather than ask the gate again;
 * one refused because the assignees could not be read is not. A refusal that
 * cannot be recorded is not definitive: it posts no notice, and the next poll
 * asks the gate again.
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
            // Not remembered, so not definitive: tell nobody it was refused,
            // and let the next poll ask the gate about it again.
            logger.withCorrelation(correlationId).warn({ pullRequestNumber: prNumber, commentId: comment.id, error: (error as Error).message }, 'Failed to record a refused PR comment');
            return false;
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
