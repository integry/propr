import { randomUUID } from 'node:crypto';
import type { Redis } from 'ioredis';
import { getAuthenticatedOctokit } from '../auth/githubAuth.js';
import { lastPageFromLinkHeader } from '../daemon/triggerApplicationEvidence.js';
import { withRetry, retryConfigs } from '../utils/retryHandler.js';

/** Issue coordinates the obligation is retained for. */
interface CleanupTarget { repoOwner: string; repoName: string; number: number; kind: 'issue' | 'pr'; triggeringLabel?: string }

// Closure cancellations whose `-cancelled` exclusion is not yet on GitHub. A
// queued request has no `-processing` label, so until the marker is published
// nothing else keeps a reopened issue out of discovery.
export const WITHDRAWAL_CLEANUP_KEY = 'intent:withdrawal-cleanup';
export type CleanupRedis = Pick<Redis, 'sadd' | 'srem' | 'smembers'>;
export interface RetainedCleanup { redis: CleanupRedis; member: string }

export async function retainWithdrawalCleanup(redis: CleanupRedis, target: CleanupTarget, reason: string): Promise<RetainedCleanup | undefined> {
    if (target.kind !== 'issue' || reason !== 'cancelled_issue_closed') return undefined;
    // Unique per cancellation, so a concurrent no-op cannot release another's obligation.
    const member = JSON.stringify({ repoOwner: target.repoOwner, repoName: target.repoName, number: target.number,
        ...(target.triggeringLabel ? { triggeringLabel: target.triggeringLabel } : {}), id: randomUUID() });
    await redis.sadd(WITHDRAWAL_CLEANUP_KEY, member);
    return { redis, member };
}

export async function releaseWithdrawalCleanup(cleanup: RetainedCleanup | undefined): Promise<void> {
    if (cleanup) await cleanup.redis.srem(WITHDRAWAL_CLEANUP_KEY, cleanup.member);
}

/** Whether a trigger was applied after the issue's latest closure in the recent timeline. */
export async function triggerAppliedSinceClosure(target: CleanupTarget, triggers: string[]): Promise<boolean> {
    const client = await getAuthenticatedOctokit();
    const read = (page: number) => withRetry(() => client.request('GET /repos/{owner}/{repo}/issues/{issue_number}/timeline', {
        owner: target.repoOwner, repo: target.repoName, issue_number: target.number, per_page: 100, page,
    }) as Promise<{ headers: { link?: string }; data: Array<{ event?: string; label?: { name?: string } }> }>, retryConfigs.githubApi, 'read_closure_timeline');
    const first = await read(1);
    const last = lastPageFromLinkHeader(first.headers.link) ?? 1;
    // Pages are scanned contiguously from the end, so no closure is skipped.
    for (let page = last; page >= Math.max(1, last - 4); page--) {
        const events = (page === 1 ? first : await read(page)).data;
        for (let i = events.length - 1; i >= 0; i--) {
            if (events[i].event === 'closed') return false;
            if (events[i].event === 'labeled' && triggers.includes(events[i].label?.name ?? '')) return true;
        }
    }
    // The closure is outside the scanned window, so renewal cannot be ordered after it.
    return false;
}
