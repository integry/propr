import { createHash } from 'node:crypto';
import type { CheckRunEvent } from '@octokit/webhooks-types';
import type { Redis } from 'ioredis';
import { getAuthenticatedOctokit } from '../auth/githubAuth.js';
import { getBotUsername, isAutoCiFollowupEnabledForRepository } from '../daemon/configLoader.js';
import logger from '../utils/logger.js';
import { withRetry } from '../utils/retryHandler.js';
import { getUltrafixStateRedis } from './checkRunHelpers.js';

export const CI_FAILURE_FOLLOWUP_MARKER_PREFIX = '<!-- propr:ci-failure-followup';
const CI_FAILURE_FOLLOWUP_MARKER_RE = /\n?<!-- propr:ci-failure-followup key="[a-f0-9]{64}" -->/gu;
const DEDUPE_TTL_SECONDS = 30 * 24 * 60 * 60;
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

interface CiFailureOctokit {
    request: (route: string, parameters: Record<string, unknown>) => Promise<{ data: unknown }>;
    paginate?: (route: string, parameters: Record<string, unknown>) => Promise<unknown[]>;
}

type DedupeRedis = Pick<Redis, 'set' | 'del'>;

export interface CiFailureFollowupDependencies {
    isEnabled?: (owner: string, repo: string) => Promise<boolean>;
    getOctokit?: () => Promise<CiFailureOctokit>;
    redisClient?: DedupeRedis;
}

export interface CiFailureFollowupResult {
    posted: boolean;
    reason: 'posted' | 'disabled' | 'duplicate';
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
    if (payload.action !== 'completed' || !isFailingCheckRunConclusion(payload.check_run.conclusion)) return null;

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
    const state = payload.state.toLowerCase();
    if (state !== 'failure' && state !== 'error') return null;

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
): string {
    const { evidence } = request;
    const excerpt = truncate(failureExcerpt?.trim() || evidence.fallbackExcerpt?.trim() || 'No failure output was provided by the CI service.');
    const shortSha = evidence.sha.slice(0, 12);

    return [
        `CI failed: **${escapeInlineMarkdown(evidence.name)}**`,
        '',
        'Please investigate and fix this CI failure.',
        '',
        `- Check: \`${escapeInlineCode(evidence.name)}\``,
        `- Result: \`${escapeInlineCode(evidence.state)}\``,
        `- Commit: [\`${shortSha}\`](${evidence.url}) (\`${escapeInlineCode(evidence.sha)}\`)`,
        `- Details: [View CI failure](${evidence.url})`,
        '',
        '**Failure evidence**',
        ...excerpt.split('\n').map(line => `> ${line || ' '}`),
        '',
        buildCiFailureFollowupMarker(dedupeKey),
    ].join('\n');
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
    let claimed = false;

    try {
        const claim = await redis.set(redisKey, Date.now().toString(), 'EX', DEDUPE_TTL_SECONDS, 'NX');
        if (claim !== 'OK') {
            log.debug({ ...failureLogContext(request), dedupeKey }, 'Automatic failed-CI follow-up already claimed');
            return { posted: false, reason: 'duplicate' };
        }
        claimed = true;

        try {
            if (await hasExistingFollowupComment(octokit, request, dedupeKey)) {
                log.debug({ ...failureLogContext(request), dedupeKey }, 'Automatic failed-CI follow-up comment already exists');
                return { posted: false, reason: 'duplicate' };
            }
        } catch (error) {
            // The atomic Redis claim still protects concurrent/redelivered
            // events. A transient comment-list failure should not hide a new CI
            // failure from the agent.
            log.warn({ error: (error as Error).message }, 'Could not scan PR comments for an existing failed-CI follow-up');
        }

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
        const annotationExcerpt = buildAnnotationExcerpt(annotations);
        const body = buildCiFailureFollowupComment(request, annotationExcerpt, dedupeKey);

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

async function hasExistingFollowupComment(
    octokit: CiFailureOctokit,
    request: CiFailureFollowupRequest,
    dedupeKey: string,
): Promise<boolean> {
    if (!octokit.paginate) return false;
    const comments = await octokit.paginate('GET /repos/{owner}/{repo}/issues/{issue_number}/comments', {
        owner: request.owner,
        repo: request.repo,
        issue_number: request.prNumber,
        per_page: 100,
    });
    const marker = buildCiFailureFollowupMarker(dedupeKey);
    const configuredBotUsernames = new Set(
        [getBotUsername(), process.env.GITHUB_BOT_USERNAME, 'propr-dev[bot]'].filter(Boolean),
    );
    return comments.some(comment => {
        if (!isRecord(comment) || typeof comment.body !== 'string' || !comment.body.includes(marker)) return false;
        const user = isRecord(comment.user) ? comment.user : null;
        const login = user && typeof user.login === 'string' ? user.login : '';
        return configuredBotUsernames.has(login);
    });
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

function escapeInlineCode(value: string): string {
    return value.replace(/([\\`])/gu, '\\$1');
}

function escapeInlineMarkdown(value: string): string {
    return value.replace(/([\\*_`[\]])/gu, '\\$1');
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null;
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
