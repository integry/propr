import type { Redis } from 'ioredis';
import logger from '../../utils/logger.js';
import { pullRequestBodyKey } from './pullRequestBodyLock.js';
import { extractPullRequestStatusBlock, sameRenderedStatus, STATUS_TIMESTAMP_PATTERN, stripPullRequestStatusBlock } from './pullRequestStatusBlock.js';

/**
 * Pacing of status block edits. Every completed check changes the counts the
 * block shows, so a CI run of forty checks would edit the body forty times
 * within minutes. An edit that only moves check progress (counts, failed or
 * cancelled check names, runs a CI suspension cancelled) waits until COALESCE_MS have passed since the last
 * status edit of the pull request, and then writes the counts of that moment;
 * any other change (a new state, activity, reason, score or cycle) is written
 * at once. The last edit time is kept in this process and, when Redis is
 * available, shared with the other writers; the newer of the two counts.
 */
export type PullRequestStatusEditPacingRedis = Pick<Redis, 'get' | 'set'>;

const DEFAULT_COALESCE_MS = 30_000;
let coalesceMs = DEFAULT_COALESCE_MS;
const localEdits = new Map<string, number>();

/** Test hook: changes the coalescing window; null restores it. */
export function setPullRequestStatusEditCoalesceMsForTests(ms: number | null): void {
    coalesceMs = ms ?? DEFAULT_COALESCE_MS;
}

/** Test hook: forgets the edits recorded in this process. */
export function resetPullRequestStatusEditPacingForTests(): void {
    localEdits.clear();
}

function redisKey(key: string): string {
    return `propr:pr-status:edited-at:${key}`;
}

/** The parts of a status line that only report check progress, which a burst of check completions changes edit by edit. */
const CHECK_PROGRESS_PARTS = / · (?:checks: [^·]*|failed: [^·]*|cancelled: [^·]*|runs cancelled by ProPR: [^·]*)(?= · |$)/g;

function withoutCheckProgress(block: string): string {
    return block.replace(STATUS_TIMESTAMP_PATTERN, '').replace(/\r\n/g, '\n').split('\n').map(line => line.replace(CHECK_PROGRESS_PARTS, '')).join('\n');
}

/**
 * Whether `next` differs from `current` in check progress only: the same text
 * outside the block, and a block that says the same once its check counts,
 * failed or cancelled check names and update time are left out.
 */
export function onlyCheckProgressChanged(current: string, next: string): boolean {
    const [before, after] = [extractPullRequestStatusBlock(current), extractPullRequestStatusBlock(next)];
    if (before === null || after === null) return false;
    if (stripPullRequestStatusBlock(current) !== stripPullRequestStatusBlock(next)) return false;
    return withoutCheckProgress(before) === withoutCheckProgress(after);
}

async function readShared(redis: PullRequestStatusEditPacingRedis | null, key: string): Promise<number | null> {
    if (!redis) return null;
    try {
        const value = Number(await redis.get(redisKey(key)));
        return Number.isFinite(value) && value > 0 ? value : null;
    } catch (error) {
        logger.debug({ key, error: (error as Error).message }, 'Could not read the last pull request status edit');
        return null;
    }
}

/** How long an edit of check progress only waits (0: it may be written now). */
export async function statusEditWaitMs(
    redis: PullRequestStatusEditPacingRedis | null, repository: string, prNumber: number, now: number,
): Promise<number> {
    const key = pullRequestBodyKey(repository, prNumber);
    const edits = [localEdits.get(key) ?? null, await readShared(redis, key)].filter((at): at is number => at !== null);
    if (edits.length === 0) return 0;
    const wait = Math.max(...edits) + coalesceMs - now;
    // A recorded edit "in the future" is another clock's: it never holds an edit longer than one window.
    return wait > 0 ? Math.min(wait, coalesceMs) : 0;
}

/**
 * Whether the status sync writes `next` over `current` now. Bodies that say
 * the same status are not written. A change of check progress alone, without
 * a rename in the same write, waits for the coalescing window: the update
 * runs again after `paceInMs`. Any other change is written now.
 */
export async function decideStatusBodyEdit(
    redis: PullRequestStatusEditPacingRedis | null, target: { repository: string; prNumber: number },
    edit: { current: string; next: string; renames: boolean }, now: number,
): Promise<{ bodyChanged: boolean; paceInMs: number | null }> {
    const { current, next } = edit;
    if (next === current || sameRenderedStatus(next, current)) return { bodyChanged: false, paceInMs: null };
    if (edit.renames || !onlyCheckProgressChanged(current, next)) return { bodyChanged: true, paceInMs: null };
    const wait = await statusEditWaitMs(redis, target.repository, target.prNumber, now);
    return wait > 0 ? { bodyChanged: false, paceInMs: wait } : { bodyChanged: true, paceInMs: null };
}

/** Records a status edit of the pull request at `now`. Never throws: a lost record only costs one edit sooner. */
export async function recordStatusEdit(
    redis: PullRequestStatusEditPacingRedis | null, repository: string, prNumber: number, now: number,
): Promise<void> {
    const key = pullRequestBodyKey(repository, prNumber);
    localEdits.set(key, now);
    if (localEdits.size > 1_000) for (const [entry, at] of localEdits) if (at + coalesceMs <= now) localEdits.delete(entry);
    if (!redis) return;
    try {
        await redis.set(redisKey(key), String(now), 'PX', Math.max(coalesceMs * 2, 1_000));
    } catch (error) {
        logger.debug({ repository, prNumber, error: (error as Error).message }, 'Could not record the pull request status edit');
    }
}
