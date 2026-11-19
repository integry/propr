import { createHash } from 'node:crypto';
import type { CheckRunEvent } from '@octokit/webhooks-types';
import type { Redis } from 'ioredis';
import { getAuthenticatedOctokit } from '../auth/githubAuth.js';
import { getBotUsername, getNonBlockingChecksForRepository, isAutoCiFollowupEnabledForRepository } from '../daemon/configLoader.js';
import logger from '../utils/logger.js';
import { withRetry } from '../utils/retryHandler.js';
import { getUltrafixStateRedis } from './checkRunHelpers.js';
import { findCancellationProvenance, type LoadProprCancelledRuns } from './ciCancellationProvenance.js';
import {
    appendCheckToCiFailureComment,
    buildCiFailureHeadMarker,
    editCiFailureComment,
    scanCiFailureComments,
    type CiFailureCommentScan,
} from './ciFailureCommentGrouping.js';
import { buildAnnotationExcerpt, buildCheckSection, buildCommentContent, checkTitle, joinUsefulText } from './ciFailureCommentText.js';
import { isInfrastructureOnlyFailure } from './ciFailureInfrastructureCheck.js';
import { loadFailedJobDependencies } from './ciFailureJobDependencies.js';
import { isNonBlockingCheck } from './nonBlockingChecks.js';
import { isActedCheckRunAction, isFailureStatusState } from './webhookEventGates.js';

export { buildAnnotationExcerpt } from './ciFailureCommentText.js';

export const CI_FAILURE_FOLLOWUP_MARKER_PREFIX = '<!-- propr:ci-failure-followup';
const CI_FAILURE_FOLLOWUP_MARKER_RE = /\n?<!-- propr:ci-failure-(?:followup key="[a-f0-9]{64}"|head sha="[^"]*") -->/gu;
const DEDUPE_TTL_SECONDS = 30 * 24 * 60 * 60;

const FAILING_CHECK_RUN_CONCLUSIONS = new Set([
    'action_required',
    'failure',
    'startup_failure',
    'timed_out',
]);

export interface CiFailureAnnotation {
    annotation_level?: string | null;
    path?: string | null;
    start_line?: number | null;
    end_line?: number | null;
    title?: string | null;
    message?: string | null;
    raw_details?: string | null;
}

export interface CiFailureEvidence {
    kind: 'check_run' | 'status';
    name: string;
    state: string;
    sha: string;
    url: string;
    source: string;
    fallbackExcerpt?: string;
    checkRunId?: number;
    annotationsCount?: number;
}

export interface CiFailureFollowupRequest {
    owner: string;
    repo: string;
    prNumber: number;
    evidence: CiFailureEvidence;
}

interface CiFailureOctokit {
    request: (route: string, parameters: Record<string, unknown>) => Promise<{ data: unknown }>;
    paginate?: (route: string, parameters: Record<string, unknown>) => Promise<unknown[]>;
}

type DedupeRedis = Pick<Redis, 'get' | 'set' | 'del'>;

export interface CiFailureFollowupDependencies {
    isEnabled?: (owner: string, repo: string) => Promise<boolean>;
    getOctokit?: () => Promise<CiFailureOctokit>;
    redisClient?: DedupeRedis;
    loadProprCancelledRuns?: LoadProprCancelledRuns;
    /** The repository's nonBlockingChecks patterns; a matching failed job is never named in a dependency line. */
    loadNonBlockingChecks?: (owner: string, repo: string) => Promise<string[]>;
}

export interface CiFailureFollowupResult {
    posted: boolean;
    /**
     * `updated`: listed on the same head's comment. `infrastructure`: a runner
     * or network problem the code cannot fix; no code follow-up is started,
     * and the pull request's status block says to re-run the failed jobs.
     */
    reason: 'posted' | 'updated' | 'disabled' | 'duplicate' | 'cancellation_induced' | 'infrastructure';
    body?: string;
}

interface StatusFailurePayload {
    sha: string;
    state: string;
    context?: string;
    description?: string | null;
    target_url?: string | null;
    repository: { full_name: string };
}

export function isFailingCheckRunConclusion(conclusion: string | null | undefined): boolean {
    return conclusion != null && FAILING_CHECK_RUN_CONCLUSIONS.has(conclusion.toLowerCase());
}

export function extractCheckRunFailure(payload: CheckRunEvent): CiFailureEvidence | null {
    if (!isActedCheckRunAction(payload.action) || !isFailingCheckRunConclusion(payload.check_run.conclusion)) return null;

    const output = payload.check_run.output;
    const fallbackExcerpt = joinUsefulText([output.title, output.summary, output.text]);
    const [owner, repo] = payload.repository.full_name.split('/');
    return {
        kind: 'check_run',
        name: payload.check_run.name || 'Unnamed check run',
        state: payload.check_run.conclusion as string,
        sha: payload.check_run.head_sha,
        url: payload.check_run.details_url
            || payload.check_run.html_url
            || `https://github.com/${owner}/${repo}/commit/${payload.check_run.head_sha}`,
        source: `check-run:${payload.check_run.name || payload.check_run.id}`,
        fallbackExcerpt: fallbackExcerpt || undefined,
        checkRunId: payload.check_run.id,
        annotationsCount: output.annotations_count,
    };
}

export function extractStatusFailure(payload: StatusFailurePayload): CiFailureEvidence | null {
    if (!isFailureStatusState(payload.state)) return null;
    const state = payload.state.toLowerCase();

    const context = payload.context?.trim() || 'Commit status';
    return {
        kind: 'status',
        name: context,
        state,
        sha: payload.sha,
        url: payload.target_url || `https://github.com/${payload.repository.full_name}/commit/${payload.sha}`,
        source: `status:${context}`,
        fallbackExcerpt: payload.description?.trim() || undefined,
    };
}

export function buildCiFailureDedupeKey(request: CiFailureFollowupRequest): string {
    const identity = [
        request.owner.toLowerCase(),
        request.repo.toLowerCase(),
        request.prNumber,
        request.evidence.sha.toLowerCase(),
        request.evidence.source.toLowerCase(),
    ].join('\0');
    return createHash('sha256').update(identity).digest('hex');
}

export function buildCiFailureFollowupMarker(dedupeKey: string): string {
    return `${CI_FAILURE_FOLLOWUP_MARKER_PREFIX} key="${dedupeKey}" -->`;
}

export function isCiFailureFollowupComment(body: string | null | undefined): boolean {
    if (!body) return false;
    CI_FAILURE_FOLLOWUP_MARKER_RE.lastIndex = 0;
    return CI_FAILURE_FOLLOWUP_MARKER_RE.test(body);
}

export function stripCiFailureFollowupMarker(body: string): string {
    CI_FAILURE_FOLLOWUP_MARKER_RE.lastIndex = 0;
    return body.replace(CI_FAILURE_FOLLOWUP_MARKER_RE, '').trim();
}

export function buildCiFailureFollowupComment(
    request: CiFailureFollowupRequest,
    failureExcerpt: string | undefined,
    dedupeKey = buildCiFailureDedupeKey(request),
    dependsOn: readonly string[] = [],
): string {
    return [
        ...buildCommentContent(request, [{ evidence: request.evidence, excerpt: failureExcerpt, dependsOn }]),
        '',
        buildCiFailureFollowupMarker(dedupeKey),
        buildCiFailureHeadMarker(request.evidence.sha),
    ].join('\n');
}

/**
 * Reports a failing CI source in one bot-authored comment per head commit. A
 * Redis NX claim closes redelivery races for the same source, while the marker
 * scan makes deduplication survive process restarts and Redis expiry. When a
 * comment for the same head exists, the check is added to it instead of
 * posting (best effort: near-simultaneous deliveries may both post, or the
 * later edit may drop the earlier check's entry).
 */
export async function postCiFailureFollowup(
    request: CiFailureFollowupRequest,
    correlationId: string,
    dependencies: CiFailureFollowupDependencies = {},
): Promise<CiFailureFollowupResult> {
    const log = logger.withCorrelation(correlationId);
    const isEnabled = dependencies.isEnabled ?? isAutoCiFollowupEnabledForRepository;
    if (!await isEnabled(request.owner, request.repo)) {
        log.debug({ owner: request.owner, repo: request.repo, prNumber: request.prNumber }, 'Automatic failed-CI follow-up is disabled');
        return { posted: false, reason: 'disabled' };
    }

    const getOctokit = dependencies.getOctokit
        ?? (async () => await getAuthenticatedOctokit() as unknown as CiFailureOctokit);
    const octokit = await getOctokit();
    const dedupeKey = buildCiFailureDedupeKey(request);
    const redis = dependencies.redisClient ?? getUltrafixStateRedis();
    const redisKey = `ci-failure-followup:${dedupeKey}`;
    // This read is only a cheap pre-check. Concurrent first deliveries still
    // need provenance followed by the atomic NX claim below.
    try {
        if (await redis.get(redisKey) !== null) return { posted: false, reason: 'duplicate' };
    } catch (error) {
        log.warn({ error: (error as Error).message }, 'Could not pre-check failed-CI follow-up claim');
    }
    if (await isCancellationInduced(octokit, request, dependencies, log)) {
        return { posted: false, reason: 'cancellation_induced' };
    }
    const annotations = await loadAnnotations(octokit, request, log);
    if (await isInfrastructureOnlyFailure(octokit, request, annotations, log)) {
        return { posted: false, reason: 'infrastructure' };
    }
    const annotationExcerpt = annotations ? buildAnnotationExcerpt(annotations) : undefined;
    const dependsOn = await loadReportedDependencies(octokit, request, dependencies, log);
    let claimed = false;

    try {
        const claim = await redis.set(redisKey, Date.now().toString(), 'EX', DEDUPE_TTL_SECONDS, 'NX');
        if (claim !== 'OK') {
            log.debug({ ...failureLogContext(request), dedupeKey }, 'Automatic failed-CI follow-up already claimed');
            return { posted: false, reason: 'duplicate' };
        }
        claimed = true;

        return await reportClaimedFailure({ octokit, request, dedupeKey, correlationId, log, annotationExcerpt, dependsOn });
    } catch (error) {
        if (claimed) {
            try {
                await redis.del(redisKey);
            } catch (cleanupError) {
                log.warn({ cleanupError }, 'Failed to release failed-CI follow-up dedupe claim after an error');
            }
        }
        throw error;
    }
}

/** Lists a claimed failure on the same head's comment, or posts a new one. */
async function reportClaimedFailure(
    { octokit, request, dedupeKey, correlationId, log, annotationExcerpt, dependsOn }: {
        octokit: CiFailureOctokit;
        request: CiFailureFollowupRequest;
        dedupeKey: string;
        correlationId: string;
        log: ReturnType<typeof logger.withCorrelation>;
        annotationExcerpt: string | undefined;
        /** The failed jobs of the same run this job needs; named in its section's dependency line. */
        dependsOn: readonly string[];
    },
): Promise<CiFailureFollowupResult> {
    let scan: CiFailureCommentScan = { duplicate: false, sameHead: null };
    try {
        scan = await scanExistingComments(octokit, request, dedupeKey);
    } catch (error) {
        // The atomic Redis claim still protects concurrent/redelivered
        // events. A transient comment-list failure should not hide a new CI
        // failure from the agent: it is posted as a new comment.
        log.warn({ error: (error as Error).message }, 'Could not scan PR comments for an existing failed-CI follow-up');
    }
    if (scan.duplicate) {
        log.debug({ ...failureLogContext(request), dedupeKey }, 'Automatic failed-CI follow-up comment already exists');
        return { posted: false, reason: 'duplicate' };
    }

    if (scan.sameHead) {
        const updated = appendCheckToCiFailureComment(scan.sameHead.body, {
            title: checkTitle(request.evidence),
            section: buildCheckSection({ evidence: request.evidence, excerpt: annotationExcerpt, dependsOn }),
            marker: buildCiFailureFollowupMarker(dedupeKey),
        });
        if (await editCiFailureComment(octokit, { ...request, commentId: scan.sameHead.id, body: updated }, log)) {
            return { posted: false, reason: 'updated', body: updated };
        }
    }
    const body = buildCiFailureFollowupComment(request, annotationExcerpt, dedupeKey, dependsOn);

    await withRetry(
        () => octokit.request('POST /repos/{owner}/{repo}/issues/{issue_number}/comments', {
            owner: request.owner,
            repo: request.repo,
            issue_number: request.prNumber,
            body,
        }),
        { maxAttempts: 3, baseDelay: 1000, maxDelay: 5000, exponentialBase: 2, correlationId },
        `post_ci_failure_followup_${request.owner}_${request.repo}_${request.prNumber}`,
    );

    log.info({ ...failureLogContext(request), dedupeKey }, 'Posted automatic failed-CI follow-up comment');
    return { posted: true, reason: 'posted', body };
}

/**
 * The failed jobs of the same workflow run that this failed job directly
 * needs, for its dependency line. A job the repository marked non-blocking is
 * left out: its own failure is not reported. Empty whenever this is not
 * certain (see ciFailureJobDependencies), so no line is added.
 */
async function loadReportedDependencies(
    octokit: CiFailureOctokit,
    request: CiFailureFollowupRequest,
    dependencies: CiFailureFollowupDependencies,
    log: ReturnType<typeof logger.withCorrelation>,
): Promise<string[]> {
    if (request.evidence.kind !== 'check_run') return [];
    const related = await loadFailedJobDependencies(octokit, { owner: request.owner, repo: request.repo, url: request.evidence.url }, log);
    if (!related) return [];
    try {
        const nonBlocking = await (dependencies.loadNonBlockingChecks ?? getNonBlockingChecksForRepository)(request.owner, request.repo);
        return related.dependsOn.filter(name => !isNonBlockingCheck(name, nonBlocking));
    } catch (error) {
        log.debug({ error: (error as Error).message }, 'Could not read the non-blocking checks; adding no dependency line');
        return [];
    }
}

async function loadAnnotations(
    octokit: CiFailureOctokit,
    request: CiFailureFollowupRequest,
    log: ReturnType<typeof logger.withCorrelation>,
): Promise<CiFailureAnnotation[] | undefined> {
    if (request.evidence.kind !== 'check_run' || request.evidence.checkRunId == null) return undefined;
    try {
        return await loadCheckRunAnnotations(octokit, request);
    } catch (error) {
        // Output summaries are carried in the webhook and remain useful
        // when the annotations endpoint is temporarily unavailable.
        log.warn({ error: (error as Error).message }, 'Could not load check-run annotations; using webhook output instead');
        return undefined;
    }
}

async function loadCheckRunAnnotations(
    octokit: CiFailureOctokit,
    request: CiFailureFollowupRequest,
): Promise<CiFailureAnnotation[]> {
    if ((request.evidence.annotationsCount ?? 0) <= 0) return [];
    const parameters = {
        owner: request.owner,
        repo: request.repo,
        check_run_id: request.evidence.checkRunId as number,
        per_page: 100,
    };
    const data = octokit.paginate
        ? await octokit.paginate('GET /repos/{owner}/{repo}/check-runs/{check_run_id}/annotations', parameters)
        : (await octokit.request('GET /repos/{owner}/{repo}/check-runs/{check_run_id}/annotations', parameters)).data;
    return Array.isArray(data) ? data.filter(isRecord) as CiFailureAnnotation[] : [];
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null;
}

/**
 * A failure caused by a deliberate cancellation of its workflow run is not a
 * code failure. Nothing is claimed for it, so a genuine failure of the same
 * check on a later attempt of this head still gets its follow-up.
 */
async function isCancellationInduced(
    octokit: CiFailureOctokit,
    request: CiFailureFollowupRequest,
    dependencies: CiFailureFollowupDependencies,
    log: ReturnType<typeof logger.withCorrelation>,
): Promise<boolean> {
    if (request.evidence.kind !== 'check_run') return false;
    try {
        const provenance = await findCancellationProvenance(octokit, {
            owner: request.owner,
            repo: request.repo,
            prNumber: request.prNumber,
            checkRunId: request.evidence.checkRunId,
            url: request.evidence.url,
            conclusion: request.evidence.state,
        }, dependencies.loadProprCancelledRuns);
        if (!provenance) return false;
        log.info({ ...failureLogContext(request), ...provenance }, 'Failed check run was caused by a deliberate workflow cancellation; no follow-up');
        return true;
    } catch (error) {
        // Unproven cancellation must not hide a genuine failure.
        log.warn({ error: (error as Error).message }, 'Could not determine whether a failed check run was cancellation-induced; posting follow-up');
        return false;
    }
}

async function scanExistingComments(
    octokit: CiFailureOctokit,
    request: CiFailureFollowupRequest,
    dedupeKey: string,
): Promise<CiFailureCommentScan> {
    if (!octokit.paginate) return { duplicate: false, sameHead: null };
    const comments = await octokit.paginate('GET /repos/{owner}/{repo}/issues/{issue_number}/comments', {
        owner: request.owner,
        repo: request.repo,
        issue_number: request.prNumber,
        per_page: 100,
    });
    const botUsernames = new Set(
        [getBotUsername(), process.env.GITHUB_BOT_USERNAME, 'propr-dev[bot]'].filter((name): name is string => Boolean(name)),
    );
    return scanCiFailureComments(comments, { dedupeKey, sha: request.evidence.sha, botUsernames });
}

function failureLogContext(request: CiFailureFollowupRequest): Record<string, unknown> {
    return {
        owner: request.owner,
        repo: request.repo,
        prNumber: request.prNumber,
        sha: request.evidence.sha,
        source: request.evidence.source,
    };
}
