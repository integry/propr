/**
 * Ultrafix CI wait notice hand-off
 *
 * When blocking checks settle, the "Ultrafix is waiting for CI" comment is
 * handed to the review that runs next. The review edits that comment in place
 * (starting, then complete) instead of posting a new one, so the PR does not
 * keep a stale waiting notice beside the review result.
 */

import type { Logger } from 'pino';
import type { Redis } from 'ioredis';

const CI_WAIT_NOTICE_KEY_PREFIX = 'ultrafix:ci-wait-notice';
const CI_WAIT_NOTICE_TTL_SECONDS = 24 * 60 * 60;

export interface UltrafixCiWaitNotice {
    commentId: number;
    headSha: string;
}

interface CommentOctokit {
    request: (route: string, params: Record<string, unknown>) => Promise<{ data: { id: number; html_url: string } }>;
}

export function getUltrafixCiWaitNoticeKey(owner: string, repo: string, pr: number): string {
    return `${CI_WAIT_NOTICE_KEY_PREFIX}:${owner}:${repo}:${pr}`;
}

/** Keep a settled wait's notice for the review that runs next. */
export async function stashUltrafixCiWaitNotice(
    redis: Redis, identity: { owner: string; repo: string; pr: number }, notice: UltrafixCiWaitNotice,
): Promise<void> {
    const key = getUltrafixCiWaitNoticeKey(identity.owner, identity.repo, identity.pr);
    await redis.set(key, JSON.stringify(notice), 'EX', CI_WAIT_NOTICE_TTL_SECONDS);
}

/** Claim the stashed notice once; later callers get null. */
export async function takeUltrafixCiWaitNotice(redis: Redis, owner: string, repo: string, pr: number): Promise<UltrafixCiWaitNotice | null> {
    const key = getUltrafixCiWaitNoticeKey(owner, repo, pr);
    const raw = await redis.get(key);
    if (!raw) return null;
    await redis.del(key);
    try {
        const notice = JSON.parse(raw) as UltrafixCiWaitNotice;
        return typeof notice.commentId === 'number' ? notice : null;
    } catch {
        return null;
    }
}

/**
 * Rewrite the stashed waiting notice with `body`. Returns the updated comment,
 * or null when there is no notice or it could not be edited (e.g. deleted), in
 * which case the caller posts a new comment as before.
 */
export async function adoptUltrafixCiWaitNotice(options: {
    octokit: CommentOctokit;
    redis: Redis;
    owner: string;
    repo: string;
    pr: number;
    body: string;
    correlatedLogger: Logger;
}): Promise<{ data: { id: number; html_url: string } } | null> {
    const { octokit, redis, owner, repo, pr, body, correlatedLogger } = options;
    let notice: UltrafixCiWaitNotice | null;
    try {
        notice = await takeUltrafixCiWaitNotice(redis, owner, repo, pr);
    } catch (error) {
        correlatedLogger.warn({ pullRequestNumber: pr, error: (error as Error).message }, 'Failed to load Ultrafix CI wait notice');
        return null;
    }
    if (!notice) return null;
    try {
        const updated = await octokit.request('PATCH /repos/{owner}/{repo}/issues/comments/{comment_id}', {
            owner, repo, comment_id: notice.commentId, body,
        });
        correlatedLogger.info({ pullRequestNumber: pr, commentId: notice.commentId }, 'Replaced Ultrafix CI wait notice with review comment');
        return { data: { id: updated.data.id, html_url: updated.data.html_url } };
    } catch (error) {
        correlatedLogger.warn(
            { pullRequestNumber: pr, commentId: notice.commentId, error: (error as Error).message },
            'Failed to replace Ultrafix CI wait notice; posting a new review comment',
        );
        return null;
    }
}

/**
 * Post a review's "Starting AI Code Review" comment. With `adoptWaitNotice`,
 * a stashed CI wait notice is rewritten instead of posting a new comment.
 */
export async function postReviewStartingComment(options: {
    octokit: CommentOctokit;
    redis: Redis;
    owner: string;
    repo: string;
    pr: number;
    body: string;
    adoptWaitNotice: boolean;
    correlatedLogger: Logger;
}): Promise<{ data: { id: number; html_url: string } }> {
    const { octokit, owner, repo, pr, body } = options;
    const adopted = options.adoptWaitNotice ? await adoptUltrafixCiWaitNotice(options) : null;
    return adopted ?? await octokit.request('POST /repos/{owner}/{repo}/issues/{issue_number}/comments', {
        owner, repo, issue_number: pr, body,
    });
}
