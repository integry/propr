/**
 * Refresh of a comment already waiting in a pull request's pending-comments
 * list. ProPR edits the head commit's CI-failure comment to add later failures;
 * when that comment is still waiting to be picked up, the waiting record must
 * carry the latest body, or the batch that claims it runs on the first failure
 * only.
 */
import type { Redis } from 'ioredis';
import { getPendingPrCommentsKey } from '../utils/constants.js';

/** Replaces the list element at an index only while it still holds the value that was read. */
const COMPARE_AND_SET_SCRIPT = `
local current = redis.call('lindex', KEYS[1], tonumber(ARGV[1]))
if current == ARGV[2] then
    redis.call('lset', KEYS[1], tonumber(ARGV[1]), ARGV[3])
    return 1
end
return 0
`;

const MAX_REFRESH_ATTEMPTS = 5;

export interface PendingCommentRevision {
    /** Body the pending record stores (markers and trigger keywords already stripped). */
    body: string;
    /** Body before keyword stripping, kept as the admission proof. */
    proofBody: string;
    agentAdmissionParent?: string;
    /** GitHub `updated_at` of this revision; an older revision never replaces a newer one. */
    updatedAt?: string;
}

/**
 * `updated` when the waiting record of `commentId` now holds `revision` (or a
 * newer one); `absent` when no record for it is waiting, or the list could not
 * be read or kept changing under the update. Only `updated` lets the caller
 * drop the edit: in every other case the edit must be handled normally, so a
 * concurrent claim of the list never loses the revision.
 */
export async function refreshPendingComment(
    redisClient: Redis,
    pr: { owner: string; repo: string; prNumber: number },
    commentId: number,
    revision: PendingCommentRevision,
): Promise<'updated' | 'absent'> {
    const key = getPendingPrCommentsKey(pr.owner, pr.repo, pr.prNumber);
    for (let attempt = 0; attempt < MAX_REFRESH_ATTEMPTS; attempt++) {
        let entries: string[];
        try {
            entries = await redisClient.lrange(key, 0, -1);
        } catch {
            return 'absent';
        }
        const index = entries.findIndex(entry => parseRecord(entry)?.id === commentId);
        if (index < 0) return 'absent';
        const current = entries[index];
        const record = parseRecord(current) as Record<string, unknown>;
        const storedAt = typeof record.updated_at === 'string' ? Date.parse(record.updated_at) : NaN;
        const incomingAt = revision.updatedAt ? Date.parse(revision.updatedAt) : NaN;
        // A late delivery of an older edit leaves the newer stored revision alone.
        if (Number.isFinite(storedAt) && Number.isFinite(incomingAt) && incomingAt < storedAt) return 'updated';
        const next = JSON.stringify({
            ...record,
            body: revision.body,
            agentAdmissionParentProof: revision.proofBody,
            // Recomputed from the new body; undefined drops a stale hint.
            agentAdmissionParent: revision.agentAdmissionParent,
            ...(revision.updatedAt ? { updated_at: revision.updatedAt } : {}),
        });
        try {
            if (await compareAndSet(redisClient, key, { index, current, next })) return 'updated';
        } catch {
            // Claimed (deleted) between the read and the write, or Redis failed: re-read.
        }
    }
    return 'absent';
}

function parseRecord(entry: string): { id?: unknown } | null {
    try {
        const parsed = JSON.parse(entry) as unknown;
        return parsed && typeof parsed === 'object' ? parsed as { id?: unknown } : null;
    } catch {
        return null;
    }
}

async function compareAndSet(redisClient: Redis, key: string, change: { index: number; current: string; next: string }): Promise<boolean> {
    const { index, current, next } = change;
    if (typeof redisClient.eval === 'function') {
        return Number(await redisClient.eval(COMPARE_AND_SET_SCRIPT, 1, key, index, current, next)) === 1;
    }
    // Lightweight test clients may not implement eval; production uses the script above.
    if (await redisClient.lindex(key, index) !== current) return false;
    await redisClient.lset(key, index, next);
    return true;
}
