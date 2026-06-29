import { Redis } from 'ioredis';
import type { Logger } from 'pino';
import type { PaginatedOctokitInstance } from '../auth/githubAuth.js';
import logger from '../utils/logger.js';
import { generateCorrelationId } from '../utils/logger.js';
import { handleError } from '../utils/errorHandler.js';
import { withRetry, retryConfigs } from '../utils/retryHandler.js';
import { getIssueQueue } from '../queue/taskQueue.js';
import { getPrimaryProcessingLabels, loadPrimaryProcessingLabelsFromConfig } from './configLoader.js';
import { getGithubUserWhitelist } from '../utils/userWhitelist.js';
import { isAuthorizedIssueTriggerActor } from './issueTriggerAuthorization.js';
import {
    acceptedDisposition,
    ignoredDisposition,
    isBotLogin,
    type DeliveryDisposition,
    type DetectedIssue,
} from '../webhook/webhookHandler.js';

export type { DetectedIssue };

// Cache resolved label-applier per issue to avoid N+1 timeline API calls on
// every poll cycle. Keyed by "owner/repo#number:updatedAt" so the entry is
// invalidated whenever the issue changes.
const labelApplierCache = new Map<string, string | null>();
const LABEL_APPLIER_CACHE_MAX = 500;
const LABEL_APPLIER_TIMELINE_PAGE_SIZE = 100;
const LABEL_APPLIER_TIMELINE_MAX_PAGES_DEFAULT = 5;

// Page budget for the recent-timeline scan. Operators with very long-lived
// issues can raise LABEL_APPLIER_TIMELINE_MAX_PAGES to widen the window in
// which the trigger label event can be found (at the cost of more API calls).
function labelApplierTimelineMaxPages(): number {
    const raw = Number.parseInt(process.env.LABEL_APPLIER_TIMELINE_MAX_PAGES ?? '', 10);
    return Number.isInteger(raw) && raw > 0 ? raw : LABEL_APPLIER_TIMELINE_MAX_PAGES_DEFAULT;
}

function getLabelApplierCacheKey(owner: string, repo: string, issueNumber: number, updatedAt: string): string {
    return `${owner}/${repo}#${issueNumber}:${updatedAt}`;
}

interface GitHubIssue {
    id: number;
    number: number;
    title: string;
    html_url: string;
    labels: Array<{ name: string } | string>;
    created_at: string;
    updated_at: string;
    pull_request?: unknown;
    user?: { login: string } | null;
}

interface GitHubSearchResponse {
    data: {
        items: GitHubIssue[];
    };
}

interface TimelineEvent {
    event: string;
    actor?: { login: string } | null;
    label?: { name: string };
}

function findLabelApplierInEvents(events: TimelineEvent[], normalizedTargetLabels: string[]): string | null {
    for (let i = events.length - 1; i >= 0; i--) {
        const ev = events[i];
        if (
            ev.event === 'labeled' &&
            ev.label?.name &&
            normalizedTargetLabels.includes(ev.label.name.toLowerCase()) &&
            ev.actor?.login
        ) {
            return ev.actor.login;
        }
    }
    return null;
}

function lastPageFromLinkHeader(linkHeader: string | undefined): number | null {
    if (!linkHeader) return null;
    const lastLink = linkHeader.split(',').find(part => part.includes('rel="last"'));
    const page = lastLink?.match(/[?&]page=(\d+)/)?.[1];
    return page ? Number.parseInt(page, 10) : null;
}

/**
 * Look up who most recently applied one of the given labels by walking the
 * issue timeline backwards. Returns the actor login, or `null` when the
 * labeler cannot be determined (API error, event pruned, etc.).
 *
 * Callers MUST treat `null` as "actor unknown" and fail closed (skip the
 * issue) rather than falling back to the issue author — otherwise an
 * attacker who applies the trigger label to a whitelisted user's issue
 * could bypass the whitelist whenever the timeline lookup fails.
 *
 * Trade-off: because we use the *most recent* labeled event, a
 * non-whitelisted user who toggles the label after a whitelisted user
 * will block processing (fail-closed). This is safe but means an
 * adversary can suppress processing by repeatedly toggling the label.
 * The mitigation is branch-protection rules on who can apply labels.
 */
async function resolveLabelApplier(opts: {
    octokit: PaginatedOctokitInstance;
    owner: string;
    repo: string;
    issueNumber: number;
    targetLabels: string[];
    log?: Logger;
}): Promise<string | null> {
    const { octokit, owner, repo, issueNumber, targetLabels } = opts;
    const normalizedTargetLabels = targetLabels.map(l => l.toLowerCase());
    // Let API errors propagate — the caller (resolveLabelApplierCached) decides
    // whether to cache the result. Errors must NOT be cached because the cache key
    // only rotates when the issue's updatedAt changes, which would stall the issue
    // indefinitely after a transient failure (rate limit, network blip).
    const firstPage = await octokit.request('GET /repos/{owner}/{repo}/issues/{issue_number}/timeline', {
        owner, repo, issue_number: issueNumber, per_page: LABEL_APPLIER_TIMELINE_PAGE_SIZE, page: 1
    });
    const lastPage = lastPageFromLinkHeader(firstPage.headers.link) ?? 1;
    if (lastPage === 1) {
        return findLabelApplierInEvents(firstPage.data as TimelineEvent[], normalizedTargetLabels);
    }

    const firstRecentPage = Math.max(2, lastPage - labelApplierTimelineMaxPages() + 1);
    for (let page = lastPage; page >= firstRecentPage; page--) {
        const response = await octokit.request('GET /repos/{owner}/{repo}/issues/{issue_number}/timeline', {
            owner, repo, issue_number: issueNumber, per_page: LABEL_APPLIER_TIMELINE_PAGE_SIZE, page
        });
        const actor = findLabelApplierInEvents(response.data as TimelineEvent[], normalizedTargetLabels);
        if (actor) return actor;
    }
    // The recent-page window starts at page 2, but page 1 is already in hand —
    // search it too so a label event near the start of a short multi-page
    // timeline (e.g. 2–5 pages) is still found.
    return findLabelApplierInEvents(firstPage.data as TimelineEvent[], normalizedTargetLabels);
}

async function resolveLabelApplierCached(opts: {
    octokit: PaginatedOctokitInstance;
    owner: string;
    repo: string;
    issueNumber: number;
    updatedAt: string;
    targetLabels: string[];
    log?: Logger;
}): Promise<string | null> {
    const cacheKey = getLabelApplierCacheKey(opts.owner, opts.repo, opts.issueNumber, opts.updatedAt);
    const cached = labelApplierCache.get(cacheKey);
    if (cached !== undefined) return cached;

    try {
        const result = await resolveLabelApplier(opts);
        // Only cache non-null results. A null from a successful timeline lookup
        // means the labeled event isn't visible yet (GitHub timeline eventual
        // consistency). Caching null would stall the issue until updatedAt
        // changes, since that's the only thing that rotates the cache key.
        if (result !== null) {
            // FIFO eviction — oldest-inserted key is dropped (not LRU).
            if (labelApplierCache.size >= LABEL_APPLIER_CACHE_MAX) {
                const first = labelApplierCache.keys().next().value;
                if (first !== undefined) labelApplierCache.delete(first);
            }
            labelApplierCache.set(cacheKey, result);
        }
        return result;
    } catch (err) {
        // Transient API error (rate limit, network blip). Return null (fail closed)
        // but do NOT cache so the issue is retried on the next poll cycle.
        opts.log?.warn(
            { owner: opts.owner, repo: opts.repo, issueNumber: opts.issueNumber, error: (err as Error).message },
            'Timeline API lookup failed — actor unknown, will skip issue (fail closed). Will retry on next poll.'
        );
        return null;
    }
}

export async function processDetectedIssue(issue: DetectedIssue, correlationId: string, redisClient: Redis): Promise<DeliveryDisposition> {
    const correlatedLogger: Logger = logger.withCorrelation(correlationId);
    const repoFullName = `${issue.repoOwner}/${issue.repoName}`;

    let primaryProcessingLabels = getPrimaryProcessingLabels();
    if (primaryProcessingLabels.length === 0) {
        await loadPrimaryProcessingLabelsFromConfig();
        primaryProcessingLabels = getPrimaryProcessingLabels();
    }

    const allExcludeLabels: string[] = [];
    for (const label of primaryProcessingLabels) {
        allExcludeLabels.push(`${label}-processing`);
        allExcludeLabels.push(`${label}-done`);
    }

    if (allExcludeLabels.some(excludeLabel => issue.labels.includes(excludeLabel))) {
        correlatedLogger.debug({ issueNumber: issue.number, repository: repoFullName }, 'Issue has exclude labels, skipping');
        return ignoredDisposition('issue_has_terminal_label');
    }

    // Check for processing labels BEFORE acquiring dedup lock
    // This ensures invalid events don't block subsequent valid events
    const triggeringLabel = primaryProcessingLabels.find(pl => issue.labels.includes(pl));

    if (!triggeringLabel) {
        correlatedLogger.info({
            issueNumber: issue.number,
            repository: repoFullName,
            issueLabels: issue.labels,
            expectedLabels: primaryProcessingLabels
        }, 'Issue does not have any primary processing label, skipping');
        return ignoredDisposition('no_processing_label');
    }

    // Enforce the user whitelist on the trigger actor (no-op when no whitelist is
    // configured). The configured GitHub App bot is also trusted for issue-label
    // triggers so app-driven label application can start work.
    if (!isAuthorizedIssueTriggerActor(issue.triggeredBy)) {
        correlatedLogger.warn({
            issueNumber: issue.number,
            repository: repoFullName,
            triggeredBy: issue.triggeredBy ?? null,
            source: issue.source
        }, issue.triggeredBy
            ? 'Trigger actor not in whitelist, skipping'
            : 'No triggeredBy on issue — skipping (fail closed). Check that all DetectedIssue producers populate triggeredBy.');
        return ignoredDisposition('user_not_allowed');
    }

    // Deduplicate rapid-fire webhook events (e.g., multiple labels added at once)
    // Use Redis SET NX with TTL to ensure only one job is queued per issue within the window
    // This runs AFTER label validation to prevent invalid events from blocking valid ones
    const dedupeKey = `issue:dedup:${issue.repoOwner}:${issue.repoName}:${issue.number}`;
    const dedupeTTL = 30; // seconds - enough time for label events to consolidate
    const acquired = await redisClient.set(dedupeKey, correlationId, 'EX', dedupeTTL, 'NX');

    if (!acquired) {
        correlatedLogger.debug({
            issueNumber: issue.number,
            repository: repoFullName,
            dedupeKey
        }, 'Issue processing already triggered recently, skipping duplicate');
        return ignoredDisposition('duplicate_delivery');
    }

    correlatedLogger.info({
        issueId: issue.id,
        issueNumber: issue.number,
        issueTitle: issue.title,
        issueUrl: issue.url,
        repository: repoFullName,
        labels: issue.labels,
        triggeringLabel: triggeringLabel
    }, 'Detected eligible issue');

    const queue = await getIssueQueue();
    const activeJobs = await queue.getActive();
    const waitingJobs = await queue.getWaiting();
    const existingJobs = [...activeJobs, ...waitingJobs];

    interface JobData {
        number?: number;
        repoOwner?: string;
        repoName?: string;
        isChildJob?: boolean;
    }

    const jobExists = existingJobs.some(job =>
        job.name === 'processGitHubIssue' &&
        (job.data as JobData).number === issue.number &&
        (job.data as JobData).repoOwner === issue.repoOwner &&
        (job.data as JobData).repoName === issue.repoName &&
        !(job.data as JobData).isChildJob
    );

    if (jobExists) {
        correlatedLogger.debug({ issueNumber: issue.number, repository: repoFullName }, 'A parent job for this issue is already active or waiting, skipping duplicate');
        return ignoredDisposition('job_already_queued');
    }

    correlatedLogger.info({
        issueId: issue.id,
        issueNumber: issue.number,
        repository: repoFullName,
        triggeringLabel: triggeringLabel
    }, 'Enqueueing parent job for matrix dispatch');

    try {
        const timestamp = Date.now();
        // Use consistent jobId without timestamp for deduplication - BullMQ will reject duplicates
        const jobId = `issue-${issue.repoOwner}-${issue.repoName}-${issue.number}`;
        const issueJob = {
            repoOwner: issue.repoOwner,
            repoName: issue.repoName,
            number: issue.number,
            triggeringLabel: triggeringLabel,
            correlationId: generateCorrelationId()
        };

        const addToQueueWithRetry = (): Promise<unknown> => withRetry(
            async () => (await getIssueQueue()).add('processGitHubIssue', issueJob, {
                jobId,
                attempts: 3,
                backoff: { type: 'exponential', delay: 2000 },
                removeOnComplete: true, // Allow new job with same ID after completion
                removeOnFail: true,     // Allow retry by re-adding label after failure
            }),
            { ...retryConfigs.redis, correlationId },
            `add_issue_to_queue_${issue.number}`
        );

        await addToQueueWithRetry();

        try {
            const activity = {
                id: `activity-${timestamp}-${issue.id}`,
                type: 'issue_created',
                timestamp: new Date().toISOString(),
                repository: repoFullName,
                issueNumber: issue.number,
                description: `New issue #${issue.number} detected for matrix processing`,
                status: 'info'
            };
            await redisClient.lpush('system:activity:log', JSON.stringify(activity));
            await redisClient.ltrim('system:activity:log', 0, 999);
        } catch (activityError) {
            const err = activityError as Error;
            correlatedLogger.warn({ error: err.message }, 'Failed to log activity');
        }

        correlatedLogger.info({
            jobId,
            issueNumber: issue.number,
            repository: repoFullName,
            issueCorrelationId: issueJob.correlationId
        }, 'Successfully added parent job to processing queue');
        return acceptedDisposition({ seatConsumed: !isBotLogin(issue.triggeredBy) });

    } catch (error) {
        handleError(error, `Failed to add issue ${issue.number} to queue`, { correlationId });
        throw error;
    }
}

export async function fetchIssuesForRepo(octokit: PaginatedOctokitInstance, repoFullName: string, correlationId: string): Promise<DetectedIssue[]> {
    const correlatedLogger: Logger = logger.withCorrelation(correlationId);
    const [owner, repo] = repoFullName.split('/');

    if (!owner || !repo) {
        correlatedLogger.warn({ repo: repoFullName }, 'Invalid repository format. Skipping.');
        return [];
    }

    const primaryProcessingLabels = getPrimaryProcessingLabels();
    const allExcludeLabels: string[] = [];
    for (const label of primaryProcessingLabels) {
        allExcludeLabels.push(`${label}-processing`);
        allExcludeLabels.push(`${label}-done`);
    }

    const fetchWithRetry = (): Promise<GitHubSearchResponse> => withRetry(
        async (): Promise<GitHubSearchResponse> => {
            const allIssues: GitHubIssue[] = [];

            for (const primaryLabel of primaryProcessingLabels) {
                const issues = await octokit.paginate('GET /repos/{owner}/{repo}/issues', {
                    owner,
                    repo,
                    state: 'open',
                    labels: primaryLabel,
                    per_page: 100,
                    sort: 'created',
                    direction: 'desc'
                }) as GitHubIssue[];

                for (const issue of issues) {
                    if (!allIssues.find(i => i.id === issue.id)) {
                        allIssues.push(issue);
                    }
                }
            }

            const filteredIssues = allIssues.filter(issue => {
                if (issue.pull_request) return false;

                const labelNames = issue.labels.map(label =>
                    typeof label === 'string' ? label : label.name
                );

                return !allExcludeLabels.some(excludeLabel => labelNames.includes(excludeLabel));
            });

            const pullRequestCount = allIssues.filter(issue => issue.pull_request).length;

            correlatedLogger.debug({
                repo: repoFullName,
                totalIssues: allIssues.length,
                pullRequests: pullRequestCount,
                filteredIssues: filteredIssues.length,
                excludedLabels: allExcludeLabels
            }, 'Filtered issues (excluding PRs and labels)');

            return { data: { items: filteredIssues } };
        },
        { ...retryConfigs.githubApi, correlationId },
        `fetch_issues_${repoFullName}`
    );

    try {
        const response = await fetchWithRetry();

        correlatedLogger.info({
            repo: repoFullName,
            count: response.data.items.length
        }, `Found ${response.data.items.length} matching issues.`);

        const detected: DetectedIssue[] = [];
        const hasWhitelist = getGithubUserWhitelist().length > 0;

        // Resolve label appliers with bounded concurrency to avoid N+1
        // sequential timeline API calls when many issues match at once.
        const MAX_CONCURRENT_TIMELINE = 5;
        const items = response.data.items;
        for (let i = 0; i < items.length; i += MAX_CONCURRENT_TIMELINE) {
            const batch = items.slice(i, i + MAX_CONCURRENT_TIMELINE);
            const results = await Promise.all(batch.map(async (issue) => {
                const labels = issue.labels.map(l => typeof l === 'string' ? l : l.name);
                let triggeredBy: string | undefined = issue.user?.login;
                if (hasWhitelist) {
                    const labelApplier = await resolveLabelApplierCached({
                        octokit, owner, repo, issueNumber: issue.number,
                        updatedAt: issue.updated_at, targetLabels: primaryProcessingLabels, log: correlatedLogger
                    });
                    if (labelApplier === null) {
                        correlatedLogger.warn(
                            { issueNumber: issue.number, repository: repoFullName },
                            'Could not determine label applier — skipping issue (fail closed). Will retry on timeline lookup failures; if the label event is too old to appear in the recent timeline window, remove and re-apply the processing label, or raise LABEL_APPLIER_TIMELINE_MAX_PAGES.'
                        );
                        return null;
                    }
                    triggeredBy = labelApplier;
                }
                return {
                    id: issue.id,
                    number: issue.number,
                    title: issue.title,
                    url: issue.html_url,
                    repoOwner: owner,
                    repoName: repo,
                    labels,
                    createdAt: issue.created_at,
                    updatedAt: issue.updated_at,
                    triggeredBy,
                    source: 'polling' as const
                };
            }));
            for (const r of results) {
                if (r) detected.push(r);
            }
        }
        return detected;
    } catch (error) {
        const err = error as Error & { status?: number };
        handleError(error, `fetch_issues_${repoFullName}`, { correlationId });

        if (err.status === 403 && err.message && err.message.includes('rate limit')) {
            correlatedLogger.warn('GitHub API rate limit likely exceeded. Consider increasing polling interval.');
        }

        return [];
    }
}
