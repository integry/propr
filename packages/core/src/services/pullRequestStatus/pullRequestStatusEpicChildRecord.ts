import { createHash } from 'node:crypto';
import type { Redis } from 'ioredis';
import logger from '../../utils/logger.js';
import { pullRequestBodyKey } from './pullRequestBodyLock.js';
import { describeChildStatus } from './pullRequestStatusBlock.js';
import type { PullRequestStatus } from './pullRequestStatus.js';

/**
 * The status each sub-PR's own status sync last computed, as its epic reads
 * it (epicChildStatusFingerprint). A sub-PR's block and title cannot always
 * show a change of its status: with prTitleStatus off and a body too full for
 * even the compact block, the sync writes nothing to GitHub, so neither the
 * written block nor the sub-PR's GitHub update time follows the change. The
 * record follows it anyway: the sync signals the epic whenever the recorded
 * status changes (syncEpicSideOfStatus), and an epic keeps a sub-PR status it
 * read earlier only while that status agrees with the record
 * (planEpicChildReads).
 *
 * Shared through Redis by every process that maintains the status; kept in
 * this process only when it has no Redis (tests).
 */

/** Records are swapped atomically (eval). */
export type EpicChildStatusRecordRedis = Pick<Redis, 'eval'>;
/** The epic reads them with get. */
export type EpicChildStatusRecordReader = Pick<Redis, 'get'>;
/** Recorded statuses by sub-PR (null: none recorded); null when they could not be read. */
export type EpicChildStatusRecords = ReadonlyMap<number, string | null> | null;

/** Refreshed by every sync of the sub-PR; a sub-PR unsynced this long has no record, as before its first sync. */
const RECORD_TTL_MS = 24 * 60 * 60_000;
const MAX_LOCAL_RECORDS = 5_000;

/** Records ARGV[1]; 0 when it is the status already recorded, 1 when it differs or none was. */
export const EPIC_CHILD_STATUS_SWAP_SCRIPT = `local previous = redis.call('GET', KEYS[1])
redis.call('SET', KEYS[1], ARGV[1], 'PX', ARGV[2])
if previous == ARGV[1] then return 0 end
return 1`;

const localRecords = new Map<string, string>();

function recordKey(repository: string, prNumber: number): string {
    return `propr:pr-status:epic-child:${pullRequestBodyKey(repository, prNumber)}`;
}

/**
 * What an epic reads of a sub-PR's status: its state and activity
 * (computeEpicStatus) and its description in the epic's block and progress
 * comment (describeChildStatus). Statuses with the same fingerprint leave the
 * epic unchanged; null is a closed or merged sub-PR.
 */
export function epicChildStatusFingerprint(status: PullRequestStatus | null): string {
    const read = status === null
        ? ['closed']
        : [status.state, status.detail.activity ?? '', describeChildStatus(status, 'block'), describeChildStatus(status, 'comment')];
    return createHash('sha256').update(JSON.stringify(read)).digest('hex').slice(0, 32);
}

/**
 * Records the status a sub-PR's sync computed; true when it differs from the
 * one recorded before (or none was), and its epic must be updated. Never
 * throws: a record that cannot be written counts as a change, so the epic is
 * signalled rather than left behind.
 */
export async function recordEpicChildStatus(
    redis: EpicChildStatusRecordRedis | null, repository: string, prNumber: number, status: PullRequestStatus | null,
): Promise<boolean> {
    const key = recordKey(repository, prNumber);
    const fingerprint = epicChildStatusFingerprint(status);
    if (!redis) {
        const changed = localRecords.get(key) !== fingerprint;
        localRecords.delete(key);
        localRecords.set(key, fingerprint);
        while (localRecords.size > MAX_LOCAL_RECORDS) localRecords.delete(localRecords.keys().next().value as string);
        return changed;
    }
    try {
        return Number(await redis.eval(EPIC_CHILD_STATUS_SWAP_SCRIPT, 1, key, fingerprint, String(RECORD_TTL_MS))) !== 0;
    } catch (error) {
        logger.debug({ repository, prNumber, error: (error as Error).message }, 'Could not record the sub-PR status; its epic is signalled');
        return true;
    }
}

/**
 * The recorded statuses of `prNumbers`. Null when they could not be read: an
 * epic then keeps none of the statuses it read earlier.
 */
export async function readEpicChildStatusRecords(
    redis: EpicChildStatusRecordReader | null | undefined, repository: string, prNumbers: number[],
): Promise<EpicChildStatusRecords> {
    if (!redis) return new Map(prNumbers.map(number => [number, localRecords.get(recordKey(repository, number)) ?? null]));
    try {
        const values = await Promise.all(prNumbers.map(async number => await redis.get(recordKey(repository, number))));
        return new Map(prNumbers.map((number, index) => [number, values[index] ?? null]));
    } catch (error) {
        logger.debug({ repository, error: (error as Error).message }, 'Could not read the recorded sub-PR statuses; the kept ones are read again');
        return null;
    }
}

/** Test hook: forgets the statuses recorded in this process. */
export function resetEpicChildStatusRecordsForTests(): void {
    localRecords.clear();
}
