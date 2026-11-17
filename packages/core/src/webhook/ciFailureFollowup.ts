import { createHash } from 'node:crypto';
import type { CheckRunEvent } from '@octokit/webhooks-types';
import type { Redis } from 'ioredis';
import { getAuthenticatedOctokit } from '../auth/githubAuth.js';
import { isAutoCiFollowupEnabledForRepository } from '../daemon/configLoader.js';
import logger from '../utils/logger.js';
import { getUltrafixStateRedis } from './checkRunHelpers.js';
import { findCancellationProvenance, type LoadProprCancelledRuns } from './ciCancellationProvenance.js';
import { isActedCheckRunAction, isFailureStatusState } from './webhookEventGates.js';
import {
    buildCiFailureHeadKey, renderCiFailureHeadComment, stripCiFailureEntryMarkers, type CiFailureEntry,
} from './ciFailureHeadComment.js';
import { publishHeadFailure, withHeadLock, type CiFailureFollowupTiming } from './ciFailureHeadPublication.js';

export type { CiFailureFollowupTiming } from './ciFailureHeadPublication.js';

export const CI_FAILURE_DEDUPE_TTL_SECONDS = 30 * 24 * 60 * 60;
export const CI_FAILURE_FOLLOWUP_MARKER_PREFIX = '<!-- propr:ci-failure-followup';
const CI_FAILURE_FOLLOWUP_MARKER_RE = /\n?<!-- propr:ci-failure-followup key="[a-f0-9]{64}" -->/gu;
const MAX_EXCERPT_LENGTH = 1800;

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

export interface CiFailureOctokit {
    request: (route: string, parameters: Record<string, unknown>) => Promise<{ data: unknown }>;
    paginate?: (route: string, parameters: Record<string, unknown>) => Promise<unknown[]>;
}

export type DedupeRedis = Pick<Redis, 'get' | 'set' | 'del'>;


export interface CiFailureFollowupDependencies {
    isEnabled?: (owner: string, repo: string) => Promise<boolean>;
    getOctokit?: () => Promise<CiFailureOctokit>;
    redisClient?: DedupeRedis;
    loadProprCancelledRuns?: LoadProprCancelledRuns;
    timing?: CiFailureFollowupTiming;
}

export interface CiFailureFollowupResult {
    posted: boolean;
    /** `merged`: added to the head commit's existing CI-failure comment, no new comment or follow-up. */
    reason: 'posted' | 'merged' | 'disabled' | 'duplicate' | 'cancellation_induced';
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
    return stripCiFailureEntryMarkers(body.replace(CI_FAILURE_FOLLOWUP_MARKER_RE, '')).trim();
}

function toCiFailureEntry(request: CiFailureFollowupRequest, failureExcerpt: string | undefined): CiFailureEntry {
    const { evidence } = request;
    return {
        name: evidence.name,
        state: evidence.state,
        url: evidence.url,
        source: evidence.source,
        excerpt: truncate(failureExcerpt?.trim() || evidence.fallbackExcerpt?.trim() || 'No failure output was provided by the CI service.'),
    };
}

/** The comment for the first failure of a head; `dedupeKey` is the head key. */
export function buildCiFailureFollowupComment(
    request: CiFailureFollowupRequest,
    failureExcerpt: string | undefined,
    dedupeKey = buildCiFailureHeadKeyFor(request),
): string {
    return renderCiFailureHeadComment({
        owner: request.owner, repo: request.repo, sha: request.evidence.sha,
        entries: [toCiFailureEntry(request, failureExcerpt)],
        marker: buildCiFailureFollowupMarker(dedupeKey),
    });
}

function buildCiFailureHeadKeyFor(request: CiFailureFollowupRequest): string {
    return buildCiFailureHeadKey({ owner: request.owner, repo: request.repo, prNumber: request.prNumber, sha: request.evidence.sha });
}

/**
 * Posts one bot-authored follow-up for a failing CI source. A Redis NX claim
 * closes concurrent webhook races, while the marker scan makes deduplication
 * survive process restarts and Redis expiry.
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
    let claimed = false;

    try {
        const claim = await redis.set(redisKey, Date.now().toString(), 'EX', CI_FAILURE_DEDUPE_TTL_SECONDS, 'NX');
        if (claim !== 'OK') {
            log.debug({ ...failureLogContext(request), dedupeKey }, 'Automatic failed-CI follow-up already claimed');
            return { posted: false, reason: 'duplicate' };
        }
        claimed = true;

        let annotations: CiFailureAnnotation[] = [];
        if (request.evidence.kind === 'check_run' && request.evidence.checkRunId != null) {
            try {
                annotations = await loadCheckRunAnnotations(octokit, request);
            } catch (error) {
                // Output summaries are carried in the webhook and remain useful
                // when the annotations endpoint is temporarily unavailable.
                log.warn({ error: (error as Error).message }, 'Could not load check-run annotations; using webhook output instead');
            }
        }
        const entry = toCiFailureEntry(request, buildAnnotationExcerpt(annotations));
        const headKey = buildCiFailureHeadKeyFor(request);
        // One comment per head commit: the lock serializes the failures of one
        // head so they merge into one comment instead of racing to post.
        const outcome = await withHeadLock({ redis, headKey, timing: dependencies.timing, log },
            lease => publishHeadFailure({ octokit, redis, request, entry, headKey, correlationId, log, lease }));
        if (outcome.reason === 'merged' || outcome.reason === 'duplicate') return outcome;
        const body = outcome.body;
        log.info({ ...failureLogContext(request), dedupeKey, headKey }, 'Posted automatic failed-CI follow-up comment');
        return { posted: true, reason: 'posted', body };
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

export function buildAnnotationExcerpt(annotations: CiFailureAnnotation[]): string | undefined {
    const usefulAnnotations = [...annotations]
        .sort((left, right) => annotationPriority(left) - annotationPriority(right))
        .filter(annotation => annotation.message || annotation.title || annotation.raw_details)
        .slice(0, 3);
    if (usefulAnnotations.length === 0) return undefined;

    return truncate(usefulAnnotations.map(annotation => {
        const location = annotation.path
            ? `${annotation.path}${formatAnnotationLines(annotation.start_line, annotation.end_line)}`
            : '';
        return joinUsefulText([
            joinUsefulText([location, annotation.title], ' — '),
            annotation.message,
            annotation.raw_details,
        ]);
    }).filter(Boolean).join('\n\n'));
}

function annotationPriority(annotation: CiFailureAnnotation): number {
    if (annotation.annotation_level === 'failure') return 0;
    if (annotation.annotation_level === 'warning') return 1;
    return 2;
}

function formatAnnotationLines(startLine?: number | null, endLine?: number | null): string {
    if (startLine == null) return '';
    return endLine != null && endLine !== startLine ? `:${startLine}-${endLine}` : `:${startLine}`;
}

function joinUsefulText(values: Array<string | null | undefined>, separator = '\n'): string {
    return values.map(value => value?.trim()).filter((value): value is string => Boolean(value)).join(separator);
}

function truncate(value: string): string {
    if (value.length <= MAX_EXCERPT_LENGTH) return value;
    return `${value.slice(0, MAX_EXCERPT_LENGTH - 1).trimEnd()}…`;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null;
}

export function failureLogContext(request: CiFailureFollowupRequest): Record<string, unknown> {
    return {
        owner: request.owner,
        repo: request.repo,
        prNumber: request.prNumber,
        sha: request.evidence.sha,
        source: request.evidence.source,
    };
}
