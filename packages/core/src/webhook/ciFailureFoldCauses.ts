/**
 * The failed needed jobs a folded aggregate is reported under: each one's
 * check run and annotations, read as its own delivery would read them, and
 * whether the same-head comment already reports it.
 *
 * A needed job the comment does not report yet is listed as a code failure
 * only after the infrastructure classifier has looked at it, as its own
 * delivery would: an infrastructure-only failure (a runner that went away, a
 * mirror outage) is not claimed, so a genuine failure of the same check on a
 * later attempt of this head still gets reported. When any such job is
 * infrastructure-only, the aggregate is not folded under it and is listed as
 * a failure of its own, as before folding existed. The same holds when any
 * such job is a check the repository marked non-blocking: its own delivery
 * starts no follow-up, so folding must not list it as the failure to fix.
 */
import type logger from '../utils/logger.js';
import type { RunJob, AggregateFold } from './ciFailureAggregateFold.js';
import type { ReportedCheck } from './ciFailureCommentText.js';
import { buildAnnotationExcerpt, joinUsefulText } from './ciFailureCommentText.js';
import type { CiFailureAnnotation, CiFailureEvidence, CiFailureFollowupRequest } from './ciFailureFollowup.js';
import { classifyFailedCheckRun } from './ciFailureInfrastructureCheck.js';
import { isNonBlockingCheck } from './nonBlockingChecks.js';

type Log = ReturnType<typeof logger.withCorrelation>;

export interface CheckEvidenceOctokit {
    request: (route: string, parameters: Record<string, unknown>) => Promise<{ data: unknown }>;
    paginate?: (route: string, parameters: Record<string, unknown>) => Promise<unknown[]>;
}

export interface FoldCause {
    cause: RunJob;
    /** The hidden key marker its own delivery deduplicates on. */
    marker: string;
    /** Whether the same-head comment already carries `marker`. */
    reported: boolean;
    /** Its evidence; read only when it is not reported yet, or on demand. */
    check?: ReportedCheck;
}

/** The source a needed job's own check-run delivery reports under. */
export function causeSource(cause: RunJob): string {
    return `check-run:${cause.name}`;
}

/**
 * Every failed needed job of `fold`, with its evidence when `existingBody`
 * does not report it yet. Null when one of those is non-blocking (matches
 * `nonBlocking`) or infrastructure-only: the aggregate is then not folded.
 */
export async function resolveFoldCauses(
    octokit: CheckEvidenceOctokit,
    request: CiFailureFollowupRequest,
    { fold, existingBody, markerFor, nonBlocking }: {
        fold: AggregateFold; existingBody: string; markerFor: (source: string) => string; nonBlocking: readonly string[];
    },
    log: Log,
): Promise<FoldCause[] | null> {
    const excluded = fold.causes.find(cause => isNonBlockingCheck(cause.name, nonBlocking));
    if (excluded) {
        log.info({ aggregate: fold.aggregate, cause: excluded.name },
            'A failed needed job is non-blocking for this repository; listing the aggregate on its own');
        return null;
    }
    const causes = await Promise.all(fold.causes.map(async (cause): Promise<FoldCause | null> => {
        const marker = markerFor(causeSource(cause));
        if (existingBody.includes(marker)) return { cause, marker, reported: true };
        const { check, annotations } = await readCauseCheck(octokit, request, cause, log);
        const verdict = await classifyFailedCheckRun(octokit, {
            owner: request.owner, repo: request.repo, checkRunId: cause.id, state: check.evidence.state,
            url: check.evidence.url, outputText: check.evidence.fallbackExcerpt, annotations,
        });
        if (!verdict.infrastructure) return { cause, marker, reported: false, check };
        log.info({ aggregate: fold.aggregate, cause: cause.name, infrastructureCause: verdict.cause },
            'A failed needed job looks like a runner or network problem; listing the aggregate on its own');
        return null;
    }));
    return causes.every((cause): cause is FoldCause => cause !== null) ? causes : null;
}

/** The evidence of a cause, read now if it was not read while resolving. */
export async function foldCauseCheck(
    octokit: CheckEvidenceOctokit,
    request: CiFailureFollowupRequest,
    cause: FoldCause,
    log: Log,
): Promise<ReportedCheck> {
    return cause.check ?? (await readCauseCheck(octokit, request, cause.cause, log)).check;
}

/**
 * A needed job's check run and annotations, as its own delivery would report
 * them; a check run that cannot be read keeps the job's listing.
 */
async function readCauseCheck(
    octokit: CheckEvidenceOctokit,
    request: CiFailureFollowupRequest,
    cause: RunJob,
    log: Log,
): Promise<{ check: ReportedCheck; annotations: CiFailureAnnotation[] | undefined }> {
    let evidence: CiFailureEvidence = {
        kind: 'check_run', name: cause.name, state: cause.conclusion ?? 'failure', sha: request.evidence.sha,
        url: cause.url || request.evidence.url, source: causeSource(cause), checkRunId: cause.id,
    };
    try {
        // An Actions job's check run id is its job id.
        const { data } = await octokit.request('GET /repos/{owner}/{repo}/check-runs/{check_run_id}', {
            owner: request.owner, repo: request.repo, check_run_id: cause.id,
        });
        evidence = checkRunEvidence(data, evidence);
    } catch (error) {
        log.warn({ checkRunId: cause.id, error: (error as Error).message }, 'Could not read a failed needed job; listing it without its output');
    }
    const annotations = await loadAnnotations(octokit, { ...request, evidence }, log);
    return { check: { evidence, excerpt: annotations ? buildAnnotationExcerpt(annotations) : undefined }, annotations };
}

function checkRunEvidence(data: unknown, listed: CiFailureEvidence): CiFailureEvidence {
    if (!isRecord(data)) return listed;
    const output = isRecord(data.output) ? data.output : {};
    const text = (value: unknown) => (typeof value === 'string' ? value : undefined);
    return {
        ...listed,
        url: text(data.details_url) || text(data.html_url) || listed.url,
        fallbackExcerpt: joinUsefulText([text(output.title), text(output.summary), text(output.text)]) || undefined,
        annotationsCount: typeof output.annotations_count === 'number' ? output.annotations_count : undefined,
    };
}

/** A check run's annotations; undefined when they could not be read. */
export async function loadAnnotations(
    octokit: CheckEvidenceOctokit,
    request: CiFailureFollowupRequest,
    log: Log,
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
    octokit: CheckEvidenceOctokit,
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
