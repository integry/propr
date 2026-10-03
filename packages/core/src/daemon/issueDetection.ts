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
import type { DetectedIssue } from '../webhook/webhookHandler.js';
import { restoreIssueTrigger } from '../services/taskIntent.js';
import { hasStaleTriggerLabels, readTriggerApplicationEvidence, staleTriggerMarkers, type TriggerEvidence } from './triggerApplicationEvidence.js';
import type { DeliveryDisposition } from '../intake/routingWebSocketProtocol.js';

export type { DetectedIssue };

// Cache resolved label-applier per issue to avoid N+1 timeline API calls on
// every poll cycle. Keyed by "owner/repo#number:updatedAt:labels" so the entry
// is invalidated whenever the issue changes.
const labelApplierCache = new Map<string, { evidence: TriggerEvidence; expiresAt: number }>();
const LABEL_APPLIER_CACHE_MAX = 500;
// Stale evidence (no reapplication after the stale marker) may only reflect
// timeline lag behind the issue's updatedAt, so it is rechecked periodically.
const STALE_EVIDENCE_CACHE_TTL_MS = 5 * 60 * 1000;

function getLabelApplierCacheKey(opts: { owner: string; repo: string; issueNumber: number; updatedAt: string; targetLabels: string[]; appliedMarkers?: string[] }): string {
    return `${opts.owner}/${opts.repo}#${opts.issueNumber}:${opts.updatedAt}:${opts.targetLabels.join(',')}:${(opts.appliedMarkers ?? []).join(',')}`;
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
    user?: { id: number; login: string } | null;
}

interface GitHubSearchResponse {
    data: {
        items: GitHubIssue[];
    };
}

async function resolveLabelApplierCached(opts: {
    octokit: PaginatedOctokitInstance;
    owner: string;
    repo: string;
    issueNumber: number;
    updatedAt: string;
    targetLabels: string[];
    staleMarkers: string[];
    appliedMarkers?: string[];
    log?: Logger;
}): Promise<TriggerEvidence | null> {
    const cacheKey = getLabelApplierCacheKey(opts);
    const cached = labelApplierCache.get(cacheKey);
    if (cached !== undefined && cached.expiresAt > Date.now()) return cached.evidence;

    try {
        // Let API errors propagate to here. Errors must NOT be cached because
        // the cache key only rotates when the issue's updatedAt changes, which
        // would stall the issue indefinitely after a transient failure.
        const result = await readTriggerApplicationEvidence(opts);
        // Only cache resolved actors. A missing actor from a successful timeline
        // lookup means the labeled event isn't visible yet (GitHub timeline
        // eventual consistency). Caching it would stall the issue until
        // updatedAt changes, since that's the only thing that rotates the cache key.
        if (result.actor !== null) {
            // FIFO eviction — oldest-inserted key is dropped (not LRU).
            labelApplierCache.delete(cacheKey);
            if (labelApplierCache.size >= LABEL_APPLIER_CACHE_MAX) {
                const first = labelApplierCache.keys().next().value;
                if (first !== undefined) labelApplierCache.delete(first);
            }
            labelApplierCache.set(cacheKey, {
                evidence: result,
                expiresAt: result.staleSinceApplied || result.orderingUnverified || result.appliedMarkerUnseen ? Date.now() + STALE_EVIDENCE_CACHE_TTL_MS : Infinity,
            });
        }
        return result;
    } catch (err) {
        // Transient API error (rate limit, network blip). Return null but do NOT
        // cache so the issue is retried on the next poll cycle. The caller fails
        // closed when actor identity is required for whitelist authorization.
        opts.log?.warn(
            { owner: opts.owner, repo: opts.repo, issueNumber: opts.issueNumber, error: (err as Error).message },
            'Timeline API lookup failed — actor unknown. Will retry on next poll.'
        );
        return null;
    }
}

const BOT_LOGIN_PATTERN = /\[bot\]$/i;

function issueSeatConsumed(issue: DetectedIssue): boolean {
    const actor = issue.triggeredBy?.trim();
    return Boolean(actor && !BOT_LOGIN_PATTERN.test(actor));
}

function excludeLabelsFor(triggers: string[]): string[] {
    return triggers.flatMap(label => [`${label}-processing`, `${label}-done`, `${label}-cancelled`]);
}

// Restoration evidence must show an application ordered after every stale
// marker, including each currently applied one.
function provesTriggerReapplied(evidence: TriggerEvidence | null): boolean {
    return Boolean(evidence?.actor) && !evidence?.staleSinceApplied && !evidence?.orderingUnverified && !evidence?.appliedMarkerUnseen;
}

// The trigger admission selects; restoration evidence must be for this trigger.
function admissionTrigger(labels: string[], triggers: string[]): string | undefined {
    return triggers.find(label => labels.includes(label));
}

export async function processDetectedIssue(issue: DetectedIssue, correlationId: string, redisClient: Redis): Promise<DeliveryDisposition> {
    const correlatedLogger: Logger = logger.withCorrelation(correlationId);
    const repoFullName = `${issue.repoOwner}/${issue.repoName}`;

    let primaryProcessingLabels = getPrimaryProcessingLabels();
    if (primaryProcessingLabels.length === 0) {
        await loadPrimaryProcessingLabelsFromConfig();
        primaryProcessingLabels = getPrimaryProcessingLabels();
    }

    const allExcludeLabels = excludeLabelsFor(primaryProcessingLabels);

    // Check for processing labels BEFORE acquiring dedup lock
    // This ensures invalid events don't block subsequent valid events
    const triggeringLabel = admissionTrigger(issue.labels, primaryProcessingLabels);

    if (!triggeringLabel) {
        correlatedLogger.info({
            issueNumber: issue.number,
            repository: repoFullName,
            issueLabels: issue.labels,
            expectedLabels: primaryProcessingLabels
        }, 'Issue does not have any primary processing label, skipping');
        return { status: 'ignored', reason: 'no_processing_label' };
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
        return { status: 'ignored', reason: 'user_not_allowed' };
    }

    // Only a trigger reapplication is renewed intent. Unrelated label events
    // fall through to the exclude check, which keeps cancelled issues idle.
    if (issue.triggerReapplied && hasStaleTriggerLabels(issue.labels, triggeringLabel, primaryProcessingLabels)) {
        const labels = await restoreIssueTrigger({ repoOwner: issue.repoOwner, repoName: issue.repoName, number: issue.number, kind: 'issue', triggeringLabel });
        if (!labels) return { status: 'ignored', reason: 'intent_not_current' };
        issue = { ...issue, labels };
    }

    if (allExcludeLabels.some(excludeLabel => issue.labels.includes(excludeLabel))) {
        correlatedLogger.debug({ issueNumber: issue.number, repository: repoFullName }, 'Issue has exclude labels, skipping');
        return { status: 'ignored', reason: 'issue_has_terminal_label' };
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
        return { status: 'ignored', reason: 'duplicate_delivery' };
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
        return { status: 'ignored', reason: 'job_already_queued' };
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
            ...(issue.triggeredById ? { userId: issue.triggeredById } : {}),
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
        return { status: 'accepted', billing: { seatConsumed: issueSeatConsumed(issue) } };

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
    const allExcludeLabels = excludeLabelsFor(primaryProcessingLabels);

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

                // Cancelled requests, and requests whose processing marker
                // survived failed cleanup, need to reach timeline evidence and
                // restoration. Done markers still block.
                const trigger = admissionTrigger(labelNames, primaryProcessingLabels);
                const restorable = !!trigger && hasStaleTriggerLabels(labelNames, trigger, primaryProcessingLabels);
                return !allExcludeLabels.some(excludeLabel => labelNames.includes(excludeLabel)
                    && (!restorable || excludeLabel.endsWith('-done')));
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
                const trigger = admissionTrigger(labels, primaryProcessingLabels);
                const stale = !!trigger && hasStaleTriggerLabels(labels, trigger, primaryProcessingLabels);
                // Restoration needs an application of the trigger admission
                // will use; another trigger's newer (possibly removed)
                // application is not renewed intent for it.
                const evidence = await resolveLabelApplierCached({
                    octokit, owner, repo, issueNumber: issue.number, updatedAt: issue.updated_at,
                    targetLabels: stale ? [trigger] : primaryProcessingLabels,
                    staleMarkers: stale ? staleTriggerMarkers(trigger, primaryProcessingLabels) : [],
                    appliedMarkers: stale ? labels : [],
                    log: correlatedLogger
                });
                // Reopening a cancelled issue is not renewed intent: restoration
                // requires the trigger to have been reapplied after its stale
                // `-processing`/`-cancelled` marker, matching webhook-mode behaviour.
                // A marker still applied but not yet visible in the timeline
                // leaves that ordering unproven, so restoration waits.
                if (stale && !provesTriggerReapplied(evidence)) {
                    correlatedLogger.debug({ issueNumber: issue.number, repository: repoFullName }, 'Stale issue has no trigger reapplication after its stale marker — skipping');
                    return null;
                }
                const labelApplier = evidence?.actor ?? null;
                if (labelApplier === null) {
                    if (hasWhitelist) {
                        correlatedLogger.warn(
                            { issueNumber: issue.number, repository: repoFullName },
                            'Could not determine label applier — skipping issue (fail closed). Will retry on timeline lookup failures; if the label event is too old to appear in the recent timeline window, remove and re-apply the processing label, or raise LABEL_APPLIER_TIMELINE_MAX_PAGES.'
                        );
                        return null;
                    }
                    correlatedLogger.warn(
                        { issueNumber: issue.number, repository: repoFullName },
                        'Could not determine label applier — processing without stable user ownership because no whitelist is configured.'
                    );
                }
                const triggeredBy = labelApplier?.login ?? issue.user?.login;
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
                    ...(triggeredBy ? { triggeredBy } : {}),
                    ...(labelApplier ? { triggeredById: labelApplier.userId } : {}),
                    source: 'polling' as const,
                    // The stale-marker gate above already required newer trigger evidence.
                    ...(stale ? { triggerReapplied: true } : {})
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
