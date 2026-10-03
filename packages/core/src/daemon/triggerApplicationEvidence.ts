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
// most recent such marker seen before the application.
export interface TriggerEvidence {
    actor: TriggerActor | null;
    staleSinceApplied: boolean;
    staleMarkedAt?: string;
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

function findTriggerEvidenceInEvents(events: TimelineEvent[], targetLabels: string[], staleMarkers: string[], acc: Omit<TriggerEvidence, 'actor'>): TriggerEvidence {
    let { staleSinceApplied, staleMarkedAt } = acc;
    for (let i = events.length - 1; i >= 0; i--) {
        const ev = events[i];
        if (ev.event !== 'labeled' || !ev.label?.name) continue;
        const name = ev.label.name.toLowerCase();
        if (staleMarkers.includes(name)) {
            staleSinceApplied = true;
            staleMarkedAt ??= ev.created_at;
        } else if (targetLabels.includes(name) && ev.actor?.login && Number.isSafeInteger(ev.actor.id)) {
            return { actor: { login: ev.actor.login, userId: String(ev.actor.id) }, staleSinceApplied, staleMarkedAt };
        }
    }
    return { actor: null, staleSinceApplied, staleMarkedAt };
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
}): Promise<TriggerEvidence> {
    const { octokit, owner, repo, issueNumber } = opts;
    const targetLabels = opts.targetLabels.map(l => l.toLowerCase());
    const staleMarkers = opts.staleMarkers.map(l => l.toLowerCase());
    const firstPage = await octokit.request('GET /repos/{owner}/{repo}/issues/{issue_number}/timeline', {
        owner, repo, issue_number: issueNumber, per_page: LABEL_APPLIER_TIMELINE_PAGE_SIZE, page: 1
    });
    const lastPage = lastPageFromLinkHeader(firstPage.headers.link) ?? 1;
    let acc: Omit<TriggerEvidence, 'actor'> = { staleSinceApplied: false };
    if (lastPage === 1) {
        return findTriggerEvidenceInEvents(firstPage.data as TimelineEvent[], targetLabels, staleMarkers, acc);
    }

    const firstRecentPage = Math.max(2, lastPage - labelApplierTimelineMaxPages() + 1);
    for (let page = lastPage; page >= firstRecentPage; page--) {
        const response = await octokit.request('GET /repos/{owner}/{repo}/issues/{issue_number}/timeline', {
            owner, repo, issue_number: issueNumber, per_page: LABEL_APPLIER_TIMELINE_PAGE_SIZE, page
        });
        const evidence = findTriggerEvidenceInEvents(response.data as TimelineEvent[], targetLabels, staleMarkers, acc);
        if (evidence.actor) return evidence;
        acc = evidence;
    }
    // The recent-page window starts at page 2, but page 1 is already in hand —
    // search it too so a label event near the start of a short multi-page
    // timeline (e.g. 2–5 pages) is still found.
    return findTriggerEvidenceInEvents(firstPage.data as TimelineEvent[], targetLabels, staleMarkers, acc);
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
    }), retryConfigs.githubApi, 'read_trigger_timeline');
    return { labels, evidence };
}
