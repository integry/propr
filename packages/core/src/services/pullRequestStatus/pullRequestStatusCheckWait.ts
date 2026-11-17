import type { Redis } from 'ioredis';
import logger from '../../utils/logger.js';
import { clearPRHeadObservation, NO_CI_GRACE_MS, observePRHead, readPRHeadObservation } from '../../webhook/checkRunHelpers.js';

/**
 * Whether checks may still appear on a pull request head that GitHub reports
 * none for. Right after a push GitHub has created no check run for the new
 * head yet, which reads exactly like a repository without CI; the status must
 * not call such a head ready, nor hold a review score given for an older head
 * against it, while its checks have not started.
 *
 * The rule (no repository setting):
 * - a head that reports a check run or a commit status has checks; this marks
 *   the repository as one that reports checks (kept CHECKS_SEEN_TTL_MS);
 * - a head that reports none waits for them from the moment ProPR first saw it
 *   without any (the auto-merge path's head observation, observePRHead):
 *   CHECKS_EXPECTED_WAIT_MS in a repository that reported checks before, and
 *   NO_CI_GRACE_MS (the auto-merge no-CI grace) in one that never did;
 * - once that wait is over the head has no CI, and is judged without checks.
 *
 * The record lives in Redis (shared with the auto-merge path); this process
 * keeps its own copy for when Redis is absent or fails, so a wait is never
 * longer than its bound plus a restart. No GitHub request is made here.
 */

/** How long a head without checks waits for them in a repository whose heads reported checks before. */
export const CHECKS_EXPECTED_WAIT_MS = 10 * 60_000;
/** How long a repository stays known to report checks after a head last reported one. */
const CHECKS_SEEN_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const CHECKS_SEEN_KEY_PREFIX = 'propr:pr-status:checks-seen';

/** Reads always; records only with a store that can write (the MCP reads pass a read-only one). */
export type CheckWaitStore = Pick<Redis, 'get'> & Partial<Pick<Redis, 'set' | 'del'>>;

const localObservations = new Map<string, { sha: string; observedAt: number }>();
const localChecksSeen = new Map<string, number>();

function repositoryKey(repository: string): string {
    return repository.toLowerCase();
}

function headKey(repository: string, prNumber: number): string {
    return `${repositoryKey(repository)}#${prNumber}`;
}

function checksSeenKey(repository: string): string {
    return `${CHECKS_SEEN_KEY_PREFIX}:${repositoryKey(repository)}`;
}

function writable(store: CheckWaitStore | null | undefined): store is Pick<Redis, 'get' | 'set' | 'del'> {
    return !!store && typeof store.set === 'function' && typeof store.del === 'function';
}

async function rememberChecks(store: CheckWaitStore | null | undefined, head: CheckWaitHead, now: number): Promise<void> {
    localChecksSeen.set(repositoryKey(head.repository), now);
    localObservations.delete(headKey(head.repository, head.prNumber));
    if (!writable(store)) return;
    const [owner, repoName] = head.repository.split('/');
    try {
        await store.set(checksSeenKey(head.repository), String(now), 'PX', CHECKS_SEEN_TTL_MS);
        // As in getCiMergeReadiness: a later return to an earlier head without checks waits afresh.
        await clearPRHeadObservation(store, { owner, repoName, prNumber: head.prNumber });
    } catch (error) {
        logger.debug({ repository: head.repository, error: (error as Error).message }, 'Could not record that the repository reports checks');
    }
}

function localObservation(head: CheckWaitHead, now: number): number {
    const key = headKey(head.repository, head.prNumber);
    const local = localObservations.get(key);
    if (local?.sha === head.headSha) return local.observedAt;
    localObservations.set(key, { sha: head.headSha, observedAt: now });
    return now;
}

/**
 * When ProPR first saw the head without checks. A read-only store (the MCP
 * reads) never records it in Redis: a head it has no record of is recorded in
 * this process instead, so repeated reads still see the wait run out.
 */
async function observedWithoutChecks(store: CheckWaitStore | null | undefined, head: CheckWaitHead, now: number): Promise<number> {
    if (!store) return localObservation(head, now);
    const [owner, repoName] = head.repository.split('/');
    const target = { owner, repoName, prNumber: head.prNumber, headSha: head.headSha };
    try {
        if (writable(store)) return await observePRHead(store, target, now);
        return await readPRHeadObservation(store, target) ?? localObservation(head, now);
    } catch (error) {
        logger.debug({ repository: head.repository, prNumber: head.prNumber, error: (error as Error).message }, 'Could not read the head observation; this process keeps its own');
        return localObservation(head, now);
    }
}

async function repositoryReportedChecks(store: CheckWaitStore | null | undefined, repository: string, now: number): Promise<boolean> {
    const local = localChecksSeen.get(repositoryKey(repository));
    if (local !== undefined && now - local < CHECKS_SEEN_TTL_MS) return true;
    if (!store) return false;
    try {
        return Boolean(await store.get(checksSeenKey(repository)));
    } catch {
        return false;
    }
}

export interface CheckWaitHead {
    repository: string;
    prNumber: number;
    headSha: string;
    /** GitHub listed at least one check run or commit status for the head; null when the checks could not be read completely. */
    reported: boolean | null;
}

/**
 * How much longer the status waits for the head's checks to appear: null when
 * it does not wait (the head has checks, its checks could not be read, or the
 * wait is over).
 */
export async function headChecksWaitMs(store: CheckWaitStore | null | undefined, head: CheckWaitHead, now: number): Promise<number | null> {
    if (head.reported === null) return null;
    if (head.reported) {
        await rememberChecks(store, head, now);
        return null;
    }
    const [observedAt, expected] = await Promise.all([
        observedWithoutChecks(store, head, now),
        repositoryReportedChecks(store, head.repository, now),
    ]);
    const left = observedAt + (expected ? CHECKS_EXPECTED_WAIT_MS : NO_CI_GRACE_MS) - now;
    return left > 0 ? left : null;
}

/** Test hook: forgets what this process recorded. */
export function resetPullRequestCheckWaitForTests(): void {
    localObservations.clear();
    localChecksSeen.clear();
}
