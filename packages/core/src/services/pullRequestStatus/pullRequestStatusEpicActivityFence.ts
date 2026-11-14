import type { Redis } from 'ioredis';
import logger from '../../utils/logger.js';
import { pullRequestBodyKey, PullRequestBodyLockLostError, type PullRequestBodyLease } from './pullRequestBodyLock.js';
import type { EpicStatusFacts } from './pullRequestStatus.js';

/**
 * Orders the activity snapshots the status passes of one epic write to its
 * progress comment (syncEpicProgressCommentForStatus). A pass reads the
 * epic's facts under the epic's body lock, releases it, and then waits for
 * the epic's progress lease, which the merge progress update may hold. A
 * later pass can read newer facts and take the lease first; the lease
 * serializes the writes but not the facts they came from, so the first pass
 * would write its older activity over the newer one. Each pass therefore
 * claims a sequence number while it still holds the body lock (the facts
 * reads of two passes never interleave under it), and under the lease an
 * activity snapshot is written only when no higher sequence has been
 * written (or found current) before it.
 *
 * Kept in Redis, like the leases; a process without one (tests) orders nothing.
 */

/** Claims and fences need eval (the scripts below). */
export type EpicActivityFenceRedis = Pick<Redis, 'eval'>;

/**
 * A pass's place among the epic's activity reads. `sequence` null: the pass
 * is `unfenced` when Redis could not order it (it writes as before this
 * ordering existed), and `unordered` when the body lock lapsed before the
 * sequence was claimed, so its facts may be older than a later pass's: it
 * writes nothing and asks for a fresh update.
 */
export type EpicActivitySnapshot = { sequence: number } | { sequence: null; reason: 'unfenced' | 'unordered' };

export const UNFENCED_EPIC_ACTIVITY_SNAPSHOT: EpicActivitySnapshot = { sequence: null, reason: 'unfenced' };
export const UNORDERED_EPIC_ACTIVITY_SNAPSHOT: EpicActivitySnapshot = { sequence: null, reason: 'unordered' };

/** An epic without an update this long starts its sequence again (and drops its fence with it). */
const FENCE_TTL_MS = 7 * 24 * 60 * 60_000;

/**
 * KEYS[1] the sequence counter, KEYS[2] the fence; ARGV[1] the TTL. A counter
 * that starts again (expired, or first use) takes the fence with it, so a
 * fence left from the previous sequence cannot reject every new snapshot.
 */
export const EPIC_ACTIVITY_CLAIM_SCRIPT = `local sequence = redis.call('INCR', KEYS[1])
if sequence == 1 then redis.call('DEL', KEYS[2]) end
redis.call('PEXPIRE', KEYS[1], ARGV[1])
return sequence`;

/** KEYS[1] the fence, ARGV[1] a sequence: 1 when a higher sequence was already written. */
export const EPIC_ACTIVITY_SUPERSEDED_SCRIPT = `local fence = tonumber(redis.call('GET', KEYS[1]) or '0')
if fence > tonumber(ARGV[1]) then return 1 end
return 0`;

/** KEYS[1] the fence, ARGV[1] the sequence written, ARGV[2] the TTL: the fence only ever moves up. */
export const EPIC_ACTIVITY_ADVANCE_SCRIPT = `local fence = tonumber(redis.call('GET', KEYS[1]) or '0')
if fence >= tonumber(ARGV[1]) then return 0 end
redis.call('SET', KEYS[1], ARGV[1], 'PX', ARGV[2])
return 1`;

function sequenceKey(repository: string, prNumber: number): string {
    return `propr:pr-status:epic-activity-seq:${pullRequestBodyKey(repository, prNumber)}`;
}

function fenceKey(repository: string, prNumber: number): string {
    return `propr:pr-status:epic-activity-fence:${pullRequestBodyKey(repository, prNumber)}`;
}

/**
 * Claims the next sequence of the epic's activity reads. Call while holding
 * the epic's body lock, after the facts are read, and confirm the lock is
 * still held right after (a lock lost before the claim leaves the order of
 * this read and a later pass's unknown: UNORDERED_EPIC_ACTIVITY_SNAPSHOT).
 * Unfenced when there is no Redis or the claim fails: the write then runs
 * unordered, as every write did before, rather than not at all.
 */
export async function claimEpicActivitySnapshot(
    redis: EpicActivityFenceRedis | null, repository: string, prNumber: number,
): Promise<EpicActivitySnapshot> {
    if (!redis) return UNFENCED_EPIC_ACTIVITY_SNAPSHOT;
    try {
        const sequence = Number(await redis.eval(EPIC_ACTIVITY_CLAIM_SCRIPT, 2, sequenceKey(repository, prNumber), fenceKey(repository, prNumber), String(FENCE_TTL_MS)));
        return Number.isFinite(sequence) && sequence > 0 ? { sequence } : UNFENCED_EPIC_ACTIVITY_SNAPSHOT;
    } catch (error) {
        logger.debug({ repository, prNumber, error: (error as Error).message }, 'Could not order the epic activity read; its comment update runs unordered');
        return UNFENCED_EPIC_ACTIVITY_SNAPSHOT;
    }
}

/**
 * Where an open epic's facts read stands among the epic's activity reads
 * (claimEpicActivitySnapshot), for the status pass (syncUnderBodyLock): claimed
 * while the body lock, under which the facts were read, is still held. A lock
 * lost before the claim leaves the order unknown (unordered), and the comment
 * write is left to a fresh update. Unfenced for a pull request that is no
 * open epic with a progress comment to update.
 */
export async function orderEpicActivityRead(
    redis: EpicActivityFenceRedis | null, target: { repository: string; prNumber: number }, epic: EpicStatusFacts | null, lease: PullRequestBodyLease,
): Promise<EpicActivitySnapshot> {
    if (!epic?.progress || !epic.epicBranch) return UNFENCED_EPIC_ACTIVITY_SNAPSHOT;
    const snapshot = await claimEpicActivitySnapshot(redis, target.repository, target.prNumber);
    if (snapshot.sequence === null) return snapshot;
    try {
        await lease.assertHeld();
    } catch (error) {
        if (!(error instanceof PullRequestBodyLockLostError)) throw error;
        return UNORDERED_EPIC_ACTIVITY_SNAPSHOT;
    }
    return snapshot;
}

/**
 * Whether a snapshot with a higher sequence was already written to (or found
 * current in) the epic's progress comment, so `snapshot` must not be written.
 * Call under the epic's progress lease, before the write. A fence that cannot
 * be read does not reject the write (unfenced, as above).
 */
export async function isEpicActivitySnapshotSuperseded(
    redis: EpicActivityFenceRedis | null, repository: string, prNumber: number, snapshot: EpicActivitySnapshot,
): Promise<boolean> {
    if (!redis || snapshot.sequence === null) return false;
    try {
        return Number(await redis.eval(EPIC_ACTIVITY_SUPERSEDED_SCRIPT, 1, fenceKey(repository, prNumber), String(snapshot.sequence))) === 1;
    } catch (error) {
        logger.debug({ repository, prNumber, error: (error as Error).message }, 'Could not read the epic activity fence; the comment update runs unordered');
        return false;
    }
}

/**
 * Records that `snapshot` is reflected in the epic's progress comment
 * (written, found current, or found not applicable to the comment as it is).
 * Call under the epic's progress lease, after the write. Never throws.
 */
export async function advanceEpicActivityFence(
    redis: EpicActivityFenceRedis | null, repository: string, prNumber: number, snapshot: EpicActivitySnapshot,
): Promise<void> {
    if (!redis || snapshot.sequence === null) return;
    try {
        await redis.eval(EPIC_ACTIVITY_ADVANCE_SCRIPT, 1, fenceKey(repository, prNumber), String(snapshot.sequence), String(FENCE_TTL_MS));
    } catch (error) {
        logger.debug({ repository, prNumber, error: (error as Error).message }, 'Could not advance the epic activity fence');
    }
}
