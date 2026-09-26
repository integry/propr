import type { Logger } from 'pino';
import type { UnprocessedComment } from '@propr/core';
import { getPendingPrCommentsKey } from '@propr/core';
import type { Redis } from 'ioredis';

export { applyPendingCommentCommandContext } from './prCommentCommandContext.js';

export function parsePendingComment(commentJson: string, correlatedLogger: Logger): UnprocessedComment | null {
    try {
        return JSON.parse(commentJson) as UnprocessedComment;
    } catch (parseError) {
        correlatedLogger.warn({ error: (parseError as Error).message }, 'Failed to parse pending comment');
        return null;
    }
}

export function processPendingComments(commentsToProcess: UnprocessedComment[], pendingComments: string[], correlatedLogger: Logger): void {
    for (const commentJson of pendingComments) {
        const pendingComment = parsePendingComment(commentJson, correlatedLogger);
        if (pendingComment && !commentsToProcess.some(c => c.id === pendingComment.id)) {
            commentsToProcess.push(pendingComment);
        }
    }
}

export interface PendingCommentPickup {
    commentsToProcess: UnprocessedComment[];
    pickedUpComments: UnprocessedComment[];
}

const CLAIM_PENDING_COMMENTS_SCRIPT = `
local comments = redis.call('lrange', KEYS[1], 0, -1)
if #comments > 0 then redis.call('del', KEYS[1]) end
return comments
`;

async function claimPendingCommentJson(redisClient: Redis, pendingCommentsKey: string): Promise<string[]> {
    if (typeof redisClient.eval === 'function') {
        return await redisClient.eval(CLAIM_PENDING_COMMENTS_SCRIPT, 1, pendingCommentsKey) as string[];
    }
    // Lightweight test clients may not implement eval. Production uses the
    // atomic script above so two contenders cannot claim the same list.
    const pendingComments = await redisClient.lrange(pendingCommentsKey, 0, -1);
    if (pendingComments.length > 0) await redisClient.del(pendingCommentsKey);
    return pendingComments;
}

export async function pickUpPendingCommentsWithClaim(commentsToProcess: UnprocessedComment[], options: { repoOwner: string; repoName: string; pullRequestNumber: number; correlatedLogger: Logger; redisClient: Redis }): Promise<PendingCommentPickup> {
    const { repoOwner, repoName, pullRequestNumber, correlatedLogger, redisClient } = options;
    const pendingCommentsKey = getPendingPrCommentsKey(repoOwner, repoName, pullRequestNumber);
    const originalCommentIds = new Set(commentsToProcess.map(comment => comment.id));
    try {
        const pendingComments = await claimPendingCommentJson(redisClient, pendingCommentsKey);
        if (pendingComments.length > 0) {
            processPendingComments(commentsToProcess, pendingComments, correlatedLogger);
            correlatedLogger.info({ pullRequestNumber, pendingCount: pendingComments.length, totalCount: commentsToProcess.length }, 'Picked up pending comments from Redis');
        }
    } catch (redisError) {
        correlatedLogger.warn({ error: (redisError as Error).message }, 'Failed to fetch pending comments from Redis');
    }
    return {
        commentsToProcess,
        pickedUpComments: commentsToProcess.filter(comment => !originalCommentIds.has(comment.id)),
    };
}

export async function pickUpPendingComments(commentsToProcess: UnprocessedComment[], options: { repoOwner: string; repoName: string; pullRequestNumber: number; correlatedLogger: Logger; redisClient: Redis }): Promise<UnprocessedComment[]> {
    return (await pickUpPendingCommentsWithClaim(commentsToProcess, options)).commentsToProcess;
}

const RESTORE_PENDING_COMMENTS_SCRIPT = `
local existing = redis.call('lrange', KEYS[1], 0, -1)
local ids = {}
for _, value in ipairs(existing) do
    local ok, comment = pcall(cjson.decode, value)
    if ok and comment.id ~= nil then ids[tostring(comment.id)] = true end
end
for index = #ARGV, 2, -1 do
    local ok, comment = pcall(cjson.decode, ARGV[index])
    local id = ok and comment.id ~= nil and tostring(comment.id) or nil
    if not id or not ids[id] then
        redis.call('lpush', KEYS[1], ARGV[index])
        if id then ids[id] = true end
    end
end
redis.call('expire', KEYS[1], tonumber(ARGV[1]))
return redis.call('llen', KEYS[1])
`;

/** Return claimed comments to the head of the shared list once per comment ID. */
export async function restorePendingComments(comments: UnprocessedComment[], options: { repoOwner: string; repoName: string; pullRequestNumber: number; redisClient: Redis }): Promise<void> {
    if (comments.length === 0) return;
    const { repoOwner, repoName, pullRequestNumber, redisClient } = options;
    const pendingCommentsKey = getPendingPrCommentsKey(repoOwner, repoName, pullRequestNumber);
    const uniqueComments = comments.filter((comment, index) =>
        comments.findIndex(candidate => candidate.id === comment.id) === index);
    const serializedComments = uniqueComments.map(comment => JSON.stringify(comment));
    if (typeof redisClient.eval === 'function') {
        await redisClient.eval(RESTORE_PENDING_COMMENTS_SCRIPT, 1, pendingCommentsKey, 3600, ...serializedComments);
        return;
    }
    const existingJson = typeof redisClient.lrange === 'function'
        ? await redisClient.lrange(pendingCommentsKey, 0, -1)
        : [];
    const existingIds = new Set(existingJson
        .map(value => parsePendingComment(value, { warn: () => undefined } as unknown as Logger)?.id)
        .filter((id): id is number => id !== undefined));
    const missing = uniqueComments.filter(comment => !existingIds.has(comment.id));
    if (missing.length > 0) {
        await redisClient.lpush(pendingCommentsKey, ...missing.map(comment => JSON.stringify(comment)).reverse());
    }
    await redisClient.expire(pendingCommentsKey, 3600);
}
