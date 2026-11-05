import { randomUUID } from 'node:crypto';
import type { Redis } from 'ioredis';
import { getAuthenticatedOctokit } from '../auth/githubAuth.js';
import { lastPageFromLinkHeader, staleTriggerMarkers } from '../daemon/triggerApplicationEvidence.js';
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

type TimelineEvent = { event?: string; label?: { name?: string } };

/** Walks the recent timeline backwards until `decide` returns a verdict; false when none is reached. */
async function scanRecentTimeline(target: CleanupTarget, decide: (event: TimelineEvent) => boolean | undefined): Promise<boolean> {
    const client = await getAuthenticatedOctokit();
    const read = (page: number) => withRetry(() => client.request('GET /repos/{owner}/{repo}/issues/{issue_number}/timeline', {
        owner: target.repoOwner, repo: target.repoName, issue_number: target.number, per_page: 100, page,
    }) as Promise<{ headers: { link?: string }; data: TimelineEvent[] }>, retryConfigs.githubApi, 'read_closure_timeline');
    const first = await read(1);
    const last = lastPageFromLinkHeader(first.headers.link) ?? 1;
    // Pages are scanned contiguously from the end, so no event is skipped.
    for (let page = last; page >= Math.max(1, last - 4); page--) {
        const events = (page === 1 ? first : await read(page)).data;
        for (let i = events.length - 1; i >= 0; i--) {
            const verdict = decide(events[i]);
            if (verdict !== undefined) return verdict;
        }
    }
    // The deciding event is outside the scanned window, so nothing can be ordered.
    return false;
}

const labeledAny = (event: TimelineEvent, labels: string[]) => event.event === 'labeled'
    && labels.some(label => label.toLowerCase() === event.label?.name?.toLowerCase());

/** The trigger most recently applied after the issue's latest closure in the recent timeline, if any. */
export async function triggerAppliedSinceClosure(target: CleanupTarget, triggers: string[]): Promise<string | undefined> {
    let applied: string | undefined;
    await scanRecentTimeline(target, event => {
        if (event.event === 'closed') return false;
        applied = triggers.find(trigger => labeledAny(event, [trigger]));
        return applied ? true : undefined;
    });
    return applied;
}

/**
 * Whether one of `markers` was applied after the latest application of
 * `triggers`. Only then does discovery treat the marker as an exclusion rather
 * than as stale status the trigger application supersedes.
 */
export function markerAppliedSinceTrigger(target: CleanupTarget, triggers: string[], markers: string[]): Promise<boolean> {
    return scanRecentTimeline(target, event => labeledAny(event, markers) || (labeledAny(event, triggers) ? false : undefined));
}

/**
 * Discovery verdict of a settled obligation. `renewedTrigger` is the trigger
 * whose application after the closure renewed intent; the new job records it.
 */
export type CleanupVerdict = { idle: boolean; renewedTrigger?: string };
/** A verdict retires the obligation; `marker` is the exclusion still owed. */
export type CleanupStep = CleanupVerdict | { marker: string; applied: boolean };

/** What a retained closure obligation requires of an open issue with `labels`, from fresh timeline evidence. */
export async function openIssueCleanupStep(target: CleanupTarget, triggers: string[], labels: string[]): Promise<CleanupStep> {
    const present = triggers.filter(trigger => labels.includes(trigger));
    // Without a trigger, only applying one renews intent. Restoration never
    // clears `-done`, so a completion marker keeps discovery idle on its own.
    if (!present.length || triggers.some(trigger => labels.includes(`${trigger}-done`))) return { idle: true };
    const renewedTrigger = await triggerAppliedSinceClosure(target, present);
    if (renewedTrigger) return { idle: false, renewedTrigger };
    // `-processing`/`-cancelled` exclude only when applied after the trigger's
    // latest application; an earlier one (e.g. a running sibling's marker that
    // a pre-closure reapplication supersedes) lets restoration readmit the issue.
    const markers = [...new Set(present.flatMap(trigger => staleTriggerMarkers(trigger, triggers)))].filter(label => labels.includes(label));
    if (markers.length && await markerAppliedSinceTrigger(target, present, markers)) return { idle: true };
    const marker = `${target.triggeringLabel ?? present[0]}-cancelled`;
    return { marker, applied: labels.includes(marker) };
}
