import type { Redis } from 'ioredis';
import { createHash } from 'node:crypto';
import type { UnprocessedComment } from '../queue/taskQueue.types.js';

export function getUnprocessedCommentRevisionIdentity(
    comment: Pick<UnprocessedComment, 'body' | 'createdAt' | 'updatedAt' | 'type' | 'revisionIdentity'>,
): string {
    if (comment.revisionIdentity) return comment.revisionIdentity;
    const revision = comment.updatedAt ?? comment.createdAt ?? '';
    const bodyDigest = createHash('sha256').update(`${comment.type}\0${comment.body}`).digest('hex').slice(0, 12);
    return `${revision}:${bodyDigest}`;
}

/** Identity is namespaced because issue and review comments have independent ID sequences. */
export function getUnprocessedCommentIdentity(comment: UnprocessedComment): string {
    return `${comment.type}:${comment.id}:${getUnprocessedCommentRevisionIdentity(comment)}`;
}

/** Preserve first-seen order and the complete first payload for each comment revision. */
export function dedupeUnprocessedComments(comments: UnprocessedComment[]): UnprocessedComment[] {
    const seen = new Set<string>();
    return comments.filter(comment => {
        const identity = getUnprocessedCommentIdentity(comment);
        if (seen.has(identity)) return false;
        seen.add(identity);
        return true;
    });
}

const RESTORE_PENDING_COMMENTS_SCRIPT = `
local existing = redis.call('LRANGE', KEYS[1], 0, -1)
local seen = {}
for _, raw in ipairs(existing) do
    local ok, value = pcall(cjson.decode, raw)
    if ok and value then
        local commentType = value.type or 'issue'
        local revision = value.updatedAt or value.createdAt or ''
        local legacyIdentity = commentType .. ':' .. tostring(value.id) .. ':' .. revision .. ':' .. (value.body or '')
        seen[legacyIdentity] = true
        if value.revisionIdentity then
            seen[commentType .. ':' .. tostring(value.id) .. ':' .. value.revisionIdentity] = true
        end
    end
end

local missing = {}
for index = 1, #ARGV, 3 do
    local identity = ARGV[index]
    local legacyIdentity = ARGV[index + 1]
    if not seen[identity] and not seen[legacyIdentity] then
        table.insert(missing, ARGV[index + 2])
        seen[identity] = true
        seen[legacyIdentity] = true
    end
end

for index = #missing, 1, -1 do
    redis.call('LPUSH', KEYS[1], missing[index])
end
if #missing > 0 then redis.call('EXPIRE', KEYS[1], 3600) end
return #missing
`;

/**
 * Atomically restore comments to the head of the pending list without adding a
 * second copy during retry/redelivery. Existing pending arrivals retain order.
 */
export async function restorePendingCommentsIdempotently(
    redisClient: Redis,
    pendingCommentsKey: string,
    comments: UnprocessedComment[],
): Promise<number> {
    const uniqueComments = dedupeUnprocessedComments(comments);
    if (uniqueComments.length === 0) return 0;
    const args = uniqueComments.flatMap(comment => {
        const revisionIdentity = getUnprocessedCommentRevisionIdentity(comment);
        const revision = comment.updatedAt ?? comment.createdAt ?? '';
        return [
            `${comment.type}:${comment.id}:${revisionIdentity}`,
            `${comment.type}:${comment.id}:${revision}:${comment.body}`,
            JSON.stringify({ ...comment, revisionIdentity }),
        ];
    });
    return Number(await redisClient.eval(RESTORE_PENDING_COMMENTS_SCRIPT, 1, pendingCommentsKey, ...args));
}
