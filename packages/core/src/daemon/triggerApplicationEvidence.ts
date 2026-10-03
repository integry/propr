import type { PaginatedOctokitInstance } from '../auth/githubAuth.js';
import { getAuthenticatedOctokit } from '../auth/githubAuth.js';
import { withRetry, retryConfigs } from '../utils/retryHandler.js';

export interface TriggerActor {
    login: string;
    userId: string;
}

// Trigger evidence from the issue timeline. `staleSinceApplied` is true when a
// stale marker (`<trigger>-processing` or any `-cancelled`) was applied after
// the most recent trigger application, i.e. the trigger has not been reapplied
// since that work started or was cancelled. `staleMarkedAt` is the time of the
// most recent such marker seen before the application. `orderingUnverified`
// is true when the application was found only after skipping unscanned
// timeline pages, so a marker between it and the scanned window may be
// missed; the actor is still usable, but it is not proof of renewed intent.
// `appliedMarkerUnseen` is true when a stale marker the caller reports as
// currently applied has no visible application in the scanned timeline (not
// yet visible, or only visible before a later removal), so the timeline cannot
// order the trigger application after it.
export interface TriggerEvidence {
    actor: TriggerActor | null;
    staleSinceApplied: boolean;
    staleMarkedAt?: string;
    orderingUnverified?: boolean;
    appliedMarkerUnseen?: boolean;
}

interface TimelineEvent {
    event: string;
    actor?: { id: number; login: string } | null;
    label?: { name: string };
    created_at?: string;
}

const LABEL_APPLIER_TIMELINE_PAGE_SIZE = 100;
const LABEL_APPLIER_TIMELINE_MAX_PAGES_DEFAULT = 5;

// Page budget for the recent-timeline scan. Operators with very long-lived
// issues can raise LABEL_APPLIER_TIMELINE_MAX_PAGES to widen the window in
// which the trigger label event can be found (at the cost of more API calls).
function labelApplierTimelineMaxPages(): number {
    const raw = Number.parseInt(process.env.LABEL_APPLIER_TIMELINE_MAX_PAGES ?? '', 10);
    return Number.isInteger(raw) && raw > 0 ? raw : LABEL_APPLIER_TIMELINE_MAX_PAGES_DEFAULT;
}

/** Labels that keep an issue with `trigger` out of discovery until the trigger is reapplied. */
export function staleTriggerMarkers(trigger: string, triggers: string[]): string[] {
    return [`${trigger}-processing`, ...triggers.map(label => `${label}-cancelled`)];
}

export function hasStaleTriggerLabels(labels: string[], trigger: string, triggers: string[]): boolean {
    return staleTriggerMarkers(trigger, triggers).some(label => labels.includes(label));
}

interface TimelineScan {
    actor: TriggerActor | null;
    staleSinceApplied: boolean;
    staleMarkedAt?: string;
    // Currently applied stale markers whose latest timeline event is not yet seen.
    pendingMarkers: Set<string>;
    appliedMarkerUnseen: boolean;
}

// Walks one page backwards. Returns true once the application and the latest
// event of every currently applied marker are known.
function scanTimelineEvents(events: TimelineEvent[], targetLabels: string[], staleMarkers: string[], scan: TimelineScan): boolean {
    for (let i = events.length - 1; i >= 0; i--) {
        const ev = events[i];
        if ((ev.event !== 'labeled' && ev.event !== 'unlabeled') || !ev.label?.name) continue;
        const name = ev.label.name.toLowerCase();
        if (scan.pendingMarkers.delete(name) && ev.event === 'unlabeled') {
            // The timeline ends with this marker removed, but the issue has
            // it applied: its current application is not visible yet.
            scan.appliedMarkerUnseen = true;
        }
        if (scan.actor || ev.event !== 'labeled') continue;
        if (staleMarkers.includes(name)) {
            scan.staleSinceApplied = true;
            scan.staleMarkedAt ??= ev.created_at;
        } else if (targetLabels.includes(name) && ev.actor?.login && Number.isSafeInteger(ev.actor.id)) {
            scan.actor = { login: ev.actor.login, userId: String(ev.actor.id) };
        }
        if (scan.actor && scan.pendingMarkers.size === 0) return true;
    }
    return Boolean(scan.actor) && scan.pendingMarkers.size === 0;
}

function evidenceFromScan(scan: TimelineScan, orderingUnverified: boolean): TriggerEvidence {
    const appliedMarkerUnseen = scan.appliedMarkerUnseen || scan.pendingMarkers.size > 0;
    return {
        actor: scan.actor,
        staleSinceApplied: scan.staleSinceApplied,
        ...(scan.staleMarkedAt ? { staleMarkedAt: scan.staleMarkedAt } : {}),
        ...(scan.actor && orderingUnverified ? { orderingUnverified: true } : {}),
        ...(appliedMarkerUnseen ? { appliedMarkerUnseen: true } : {}),
    };
}

function lastPageFromLinkHeader(linkHeader: string | undefined): number | null {
    if (!linkHeader) return null;
    const lastLink = linkHeader.split(',').find(part => part.includes('rel="last"'));
    const page = lastLink?.match(/[?&]page=(\d+)/)?.[1];
    return page ? Number.parseInt(page, 10) : null;
}

/**
 * Look up who most recently applied one of the given labels by walking the
 * issue timeline backwards, and whether a stale marker was applied after it.
 * Returns a `null` actor when the labeler cannot be determined (event pruned,
 * legacy response without an ID, etc.). API errors propagate.
 *
 * Callers MUST treat a `null` actor as "actor unknown" and fail closed when the
 * actor is required for whitelist authorization or restoration.
 *
 * Trade-off: because we use the *most recent* labeled event, a
 * non-whitelisted user who toggles the label after a whitelisted user
 * will block processing (fail-closed). This is safe but means an
 * adversary can suppress processing by repeatedly toggling the label.
 * The mitigation is branch-protection rules on who can apply labels.
 */
export async function readTriggerApplicationEvidence(opts: {
    octokit: PaginatedOctokitInstance;
    owner: string;
    repo: string;
    issueNumber: number;
    targetLabels: string[];
    staleMarkers: string[];
    /** Stale markers the current issue has applied; each must be visibly ordered before the application. */
    appliedMarkers?: string[];
}): Promise<TriggerEvidence> {
    const { octokit, owner, repo, issueNumber } = opts;
    const targetLabels = opts.targetLabels.map(l => l.toLowerCase());
    const staleMarkers = opts.staleMarkers.map(l => l.toLowerCase());
    const scan: TimelineScan = {
        actor: null,
        staleSinceApplied: false,
        pendingMarkers: new Set((opts.appliedMarkers ?? []).map(l => l.toLowerCase()).filter(l => staleMarkers.includes(l))),
        appliedMarkerUnseen: false,
    };
    const firstPage = await octokit.request('GET /repos/{owner}/{repo}/issues/{issue_number}/timeline', {
        owner, repo, issue_number: issueNumber, per_page: LABEL_APPLIER_TIMELINE_PAGE_SIZE, page: 1
    });
    const lastPage = lastPageFromLinkHeader(firstPage.headers.link) ?? 1;
    if (lastPage === 1) {
        scanTimelineEvents(firstPage.data as TimelineEvent[], targetLabels, staleMarkers, scan);
        return evidenceFromScan(scan, false);
    }

    const firstRecentPage = Math.max(2, lastPage - labelApplierTimelineMaxPages() + 1);
    for (let page = lastPage; page >= firstRecentPage; page--) {
        const response = await octokit.request('GET /repos/{owner}/{repo}/issues/{issue_number}/timeline', {
            owner, repo, issue_number: issueNumber, per_page: LABEL_APPLIER_TIMELINE_PAGE_SIZE, page
        });
        if (scanTimelineEvents(response.data as TimelineEvent[], targetLabels, staleMarkers, scan)) return evidenceFromScan(scan, false);
    }
    // The recent-page window starts at page 2, but page 1 is already in hand —
    // search it too so a label event near the start of a short multi-page
    // timeline (e.g. 2–5 pages) is still found. When pages between 1 and the
    // window were skipped, a stale marker may lie in that gap, so an
    // application found on page 1 cannot establish ordering after it, and a
    // marker event found on page 1 may have been superseded inside the gap.
    const gap = firstRecentPage > 2;
    const foundInWindow = scan.actor !== null;
    const pendingBeforeGap = scan.pendingMarkers.size;
    scanTimelineEvents(firstPage.data as TimelineEvent[], targetLabels, staleMarkers, scan);
    if (gap && pendingBeforeGap > 0) scan.appliedMarkerUnseen = true;
    return evidenceFromScan(scan, gap && !foundInWindow);
}

type IssueRef = { owner: string; repo: string; issueNumber: number };

/**
 * Current state and labels of an issue. Delayed label deliveries carry old
 * labels, so admission reads exclusion markers from here, never the payload.
 */
export async function readCurrentIssueLabels(
    { owner, repo, issueNumber }: IssueRef,
    octokit?: PaginatedOctokitInstance,
): Promise<{ open: boolean; labels: string[] }> {
    const client = octokit ?? await getAuthenticatedOctokit();
    const issue = await withRetry(() => client.request('GET /repos/{owner}/{repo}/issues/{issue_number}', { owner, repo, issue_number: issueNumber }),
        retryConfigs.githubApi, 'read_trigger_labels');
    const data = issue.data as { state?: string; labels?: Array<string | { name?: string }> };
    const labels = (data.labels ?? []).map(label => typeof label === 'string' ? label : label.name ?? '');
    return { open: data.state !== 'closed', labels };
}

/**
 * Fresh evidence for a trigger webhook. Delayed deliveries carry old labels,
 * so stale status is read from the current issue, never the payload alone.
 * `evidence` is null when the current issue has no stale markers.
 */
export async function readCurrentTriggerEvidence(
    { owner, repo, issueNumber }: IssueRef,
    trigger: string,
    triggers: string[],
): Promise<{ labels: string[]; evidence: TriggerEvidence | null }> {
    const octokit = await getAuthenticatedOctokit();
    const { labels } = await readCurrentIssueLabels({ owner, repo, issueNumber }, octokit);
    if (!hasStaleTriggerLabels(labels, trigger, triggers)) return { labels, evidence: null };
    const evidence = await withRetry(() => readTriggerApplicationEvidence({
        octokit, owner, repo, issueNumber, targetLabels: [trigger], staleMarkers: staleTriggerMarkers(trigger, triggers),
        appliedMarkers: labels,
    }), retryConfigs.githubApi, 'read_trigger_timeline');
    return { labels, evidence };
}
