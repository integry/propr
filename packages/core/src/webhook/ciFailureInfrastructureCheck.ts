/**
 * Reads what the infrastructure classifier (ciFailureInfrastructure) needs
 * about one failed GitHub Actions check run, and classifies it. Shared by the
 * CI-failure follow-up, which starts no code follow-up for an
 * infrastructure-only failure, and the pull request status, which says on the
 * pull request that such a failure looks like a runner or network problem and
 * that re-running the failed jobs is the fix. ProPR never re-runs the jobs
 * itself. Nothing is stored: the verdict is derived from GitHub whenever it is
 * needed. Any read failure keeps the failure a code failure.
 */
import logger from '../utils/logger.js';
import { requestPullRequestStatusSync } from '../services/pullRequestStatus/pullRequestStatusSignal.js';
import type { CiFailureAnnotation, CiFailureFollowupRequest } from './ciFailureFollowup.js';
import { classifyCiInfrastructureFailure, hasInfrastructureSignature, type CiInfrastructureVerdict } from './ciFailureInfrastructure.js';

export interface InfrastructureGitHub {
    request: (route: string, parameters: Record<string, unknown>) => Promise<{ data: unknown }>;
}

export interface FailedCheckRun {
    owner: string;
    repo: string;
    checkRunId: number;
    /** The check's conclusion (`failure`, `timed_out`, …). */
    state: string;
    /** The check's details URL; for GitHub Actions it names the job. */
    url?: string | null;
    /** The check's output title, summary and text. */
    outputText?: string | null;
    /** The check's annotations; undefined when they could not be read, which keeps it a code failure. */
    annotations: CiFailureAnnotation[] | undefined;
}

const ACTIONS_JOB_URL_RE = /\/actions\/runs\/\d+\/job\/(\d+)/u;
const FAILED_STEP_CONCLUSIONS = new Set(['failure', 'timed_out']);
const NOT_INFRASTRUCTURE: CiInfrastructureVerdict = { infrastructure: false };

type Log = ReturnType<typeof logger.withCorrelation>;

/** Names of the job's failed steps; null when they could not be read. */
async function loadFailedSteps(github: InfrastructureGitHub, run: FailedCheckRun): Promise<string[] | null> {
    const match = run.url ? ACTIONS_JOB_URL_RE.exec(run.url) : null;
    const jobId = match ? Number(match[1]) : run.checkRunId;
    const { data } = await github.request('GET /repos/{owner}/{repo}/actions/jobs/{job_id}', { owner: run.owner, repo: run.repo, job_id: jobId });
    const steps = (data as { steps?: Array<{ name?: unknown; conclusion?: unknown }> } | null)?.steps;
    if (!Array.isArray(steps)) return null;
    return steps
        .filter(step => typeof step.conclusion === 'string' && FAILED_STEP_CONCLUSIONS.has(step.conclusion))
        .map(step => (typeof step.name === 'string' ? step.name : ''));
}

/**
 * Whether one failed check run is infrastructure-only. The job's steps are
 * read only when the output or annotations already look like a runner or
 * network error. Never throws: a failed read is a code failure.
 */
export async function classifyFailedCheckRun(github: InfrastructureGitHub, run: FailedCheckRun): Promise<CiInfrastructureVerdict> {
    const { annotations } = run;
    if (!annotations) return NOT_INFRASTRUCTURE;
    const texts = [run.outputText, ...annotations.flatMap(item => [item.title, item.message, item.raw_details])];
    if (!hasInfrastructureSignature(texts)) return NOT_INFRASTRUCTURE;
    let failedSteps: string[] | null;
    try {
        failedSteps = await loadFailedSteps(github, run);
    } catch (error) {
        logger.debug({ owner: run.owner, repo: run.repo, checkRunId: run.checkRunId, error: (error as Error).message },
            'Could not read the failed job; treating the CI failure as a code failure');
        return NOT_INFRASTRUCTURE;
    }
    return classifyCiInfrastructureFailure({ kind: 'check_run', state: run.state, texts: [run.outputText], annotations, failedSteps });
}

/**
 * A check run's annotations, from one page of 100; throws when unreadable,
 * or when there are more than one page holds, since an unread one may point
 * at a source file.
 */
export async function loadCheckRunAnnotationPage(
    github: InfrastructureGitHub, target: { owner: string; repo: string; checkRunId: number; annotationsCount?: number | null },
): Promise<CiFailureAnnotation[]> {
    const count = target.annotationsCount ?? 0;
    if (count <= 0) return [];
    if (count > 100) throw new Error(`${count} annotations: more than one page`);
    const { data } = await github.request('GET /repos/{owner}/{repo}/check-runs/{check_run_id}/annotations', {
        owner: target.owner, repo: target.repo, check_run_id: target.checkRunId, per_page: 100,
    });
    if (!Array.isArray(data)) return [];
    return data.filter((item): item is CiFailureAnnotation => !!item && typeof item === 'object');
}

/**
 * An infrastructure-only failure (a runner or network problem in a setup step)
 * starts no code follow-up, so it suspends no validation either. ProPR does
 * not re-run it: the status block, derived from the head's failed checks when
 * it is rendered, says the failure looks like a runner problem, names the job
 * and says to re-run the failed jobs. Nothing is claimed for it, so a genuine
 * failure of the same check on a manual re-run still gets its follow-up. Any
 * doubt or read failure, including annotations that could not be read
 * (undefined), keeps it a code failure. Once classified, nothing can turn it
 * back into a code failure: a failed status update is only logged.
 */
export async function isInfrastructureOnlyFailure(
    octokit: InfrastructureGitHub,
    request: CiFailureFollowupRequest,
    annotations: CiFailureAnnotation[] | undefined,
    log: Log,
): Promise<boolean> {
    const { evidence } = request;
    if (evidence.kind !== 'check_run' || evidence.checkRunId == null) return false;
    let verdict: CiInfrastructureVerdict;
    try {
        verdict = await classifyFailedCheckRun(octokit, {
            owner: request.owner, repo: request.repo, checkRunId: evidence.checkRunId, state: evidence.state,
            url: evidence.url, outputText: evidence.fallbackExcerpt, annotations,
        });
    } catch (error) {
        log.warn({ error: (error as Error).message }, 'Could not classify a CI failure as a runner problem; posting follow-up');
        return false;
    }
    if (!verdict.infrastructure) return false;
    const { owner, repo, prNumber } = request;
    log.info({ owner, repo, prNumber, check: evidence.name, sha: evidence.sha, cause: verdict.cause, step: verdict.step },
        'CI failure looks like a runner or network problem; no code follow-up is started');
    try {
        requestPullRequestStatusSync(`${owner}/${repo}`, prNumber);
    } catch (error) {
        log.warn({ error: (error as Error).message }, 'Could not update the status block for a runner-problem CI failure');
    }
    return true;
}
