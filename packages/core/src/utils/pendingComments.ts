import type { Redis } from 'ioredis';
import type { UnprocessedComment } from '../queue/taskQueue.types.js';

/** Identity is namespaced because issue and review comments have independent ID sequences. */
export function getUnprocessedCommentIdentity(comment: UnprocessedComment): string {
    const revision = comment.updatedAt ?? comment.createdAt ?? '';
    return `${comment.type}:${comment.id}:${revision}`;
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
        seen[commentType .. ':' .. tostring(value.id) .. ':' .. revision] = true
    end
end

local missing = {}
for index = 1, #ARGV, 2 do
    local identity = ARGV[index]
    if not seen[identity] then
        table.insert(missing, ARGV[index + 1])
        seen[identity] = true
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
    const args = uniqueComments.flatMap(comment => [
        getUnprocessedCommentIdentity(comment),
        JSON.stringify(comment),
    ]);
    return Number(await redisClient.eval(RESTORE_PENDING_COMMENTS_SCRIPT, 1, pendingCommentsKey, ...args));
}
