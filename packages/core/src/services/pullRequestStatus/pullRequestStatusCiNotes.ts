/**
 * Facts for what CI cannot say for itself: a follow-up's suspension of the
 * head's validation, and failed checks of the head that look like a runner or
 * network problem, for which ProPR starts no code follow-up. Both are notes,
 * not verdicts: an unreadable record or check leaves the note out rather than
 * failing the status read.
 */
import type { Knex } from 'knex';
import logger from '../../utils/logger.js';
import { classifyFailedCheckRun, loadCheckRunAnnotationPage, type InfrastructureGitHub } from '../../webhook/ciFailureInfrastructureCheck.js';
import type { PullRequestCiRunnerProblem, PullRequestCiSuspension } from './pullRequestStatus.js';

/** Mirrors `PR_CI_SUSPENSIONS_TABLE` and `SUSPENSION_ACTIVE` in the worker's src/jobs/followupCiSuspensionStore.ts. */
const PR_CI_SUSPENSIONS_TABLE = 'pr_ci_suspensions';
const SUSPENSION_ACTIVE = 'active';

function sameSha(left: string, right: string): boolean {
    return left.toLowerCase() === right.toLowerCase();
}

/** Runs the suspension cancelled and has not brought back. */
function countCancelledRuns(raw: unknown): number {
    if (typeof raw !== 'string') return 0;
    try {
        const runs = JSON.parse(raw) as unknown;
        if (!Array.isArray(runs)) return 0;
        return runs.filter(run => !!run && typeof run === 'object' && Number.isInteger((run as { id?: unknown }).id)
            && (run as { restarted?: unknown }).restarted !== true).length;
    } catch {
        return 0;
    }
}

/**
 * The active suspension of the head's validation, if any. Only `active`
 * suspends: once restoring starts, a re-run is no longer cancelled.
 */
export async function loadCiSuspensionFact(
    db: Knex, repository: string, prNumber: number, headSha: string,
): Promise<PullRequestCiSuspension | null> {
    try {
        const row = await db(PR_CI_SUSPENSIONS_TABLE)
            .where({ repository: repository.toLowerCase(), pull_request: prNumber })
            .first('head_sha', 'state', 'cancelled_runs') as { head_sha?: string; state?: string; cancelled_runs?: unknown } | undefined;
        if (!row || row.state !== SUSPENSION_ACTIVE || typeof row.head_sha !== 'string' || !sameSha(row.head_sha, headSha)) return null;
        return { cancelledRuns: countCancelledRuns(row.cancelled_runs) };
    } catch (error) {
        logger.debug({ repository, prNumber, error: (error as Error).message }, 'Could not read the CI suspension of a pull request');
        return null;
    }
}

/** A blocking check run of the head that failed, as the status read lists it (pullRequestStatusFacts). */
export interface FailedStatusCheckRun {
    id: number;
    name: string;
    conclusion: string;
    detailsUrl: string | null;
    /** The app that reported the check; only GitHub Actions jobs have steps to read. */
    appSlug: string | null;
    output: { title?: string | null; summary?: string | null; text?: string | null; annotations_count?: number | null } | null;
}

/** What the head's check run listing carries beyond the counts, for the runner-problem note. */
export interface ListedCheckRunDetails {
    id?: number;
    name?: string;
    status: string;
    conclusion: string | null;
    details_url?: string | null;
    app?: { slug?: string | null } | null;
    output?: FailedStatusCheckRun['output'];
}

/** The blocking check runs that failed, from the listed ones; runs without an id cannot be read further. */
export function failedStatusCheckRuns(blockingRuns: readonly ListedCheckRunDetails[]): FailedStatusCheckRun[] {
    return blockingRuns
        .filter(run => run.status === 'completed' && typeof run.id === 'number'
            && run.conclusion !== null && run.conclusion !== 'success' && run.conclusion !== 'skipped')
        .map(run => ({
            id: run.id as number, name: run.name || 'check run', conclusion: run.conclusion as string,
            detailsUrl: run.details_url ?? null, appSlug: run.app?.slug ?? null, output: run.output ?? null,
        }));
}

/**
 * Failed checks classified per status read; more is a broadly broken head,
 * not a runner problem worth reading every job for.
 */
const MAX_CLASSIFIED_FAILED_RUNS = 5;

/** Whether one failed check of the head is infrastructure-only; any read failure says no. */
async function isRunnerProblem(github: InfrastructureGitHub, owner: string, repo: string, run: FailedStatusCheckRun): Promise<boolean> {
    let annotations;
    try {
        annotations = await loadCheckRunAnnotationPage(github, { owner, repo, checkRunId: run.id, annotationsCount: run.output?.annotations_count });
    } catch (error) {
        logger.debug({ owner, repo, checkRunId: run.id, error: (error as Error).message }, 'Could not read check-run annotations for the runner-problem note');
        return false;
    }
    const outputText = [run.output?.title, run.output?.summary, run.output?.text].filter(Boolean).join('\n');
    const verdict = await classifyFailedCheckRun(github, {
        owner, repo, checkRunId: run.id, state: run.conclusion, url: run.detailsUrl, outputText, annotations,
    });
    return verdict.infrastructure;
}

/**
 * The failed checks of the current head that look like a runner or network
 * problem (ciFailureInfrastructure), derived when the status is read: nothing
 * is stored, so the note goes away as soon as those checks no longer fail on
 * the head (a re-run passed, or a new push). Null when none, or when there
 * are too many failed checks to read. Never throws.
 */
export async function loadCiRunnerProblemFact(
    github: InfrastructureGitHub, owner: string, repo: string, failedRuns: readonly FailedStatusCheckRun[],
): Promise<PullRequestCiRunnerProblem | null> {
    const candidates = failedRuns.filter(run => (run.appSlug === null || run.appSlug === 'github-actions')
        && (run.conclusion === 'failure' || run.conclusion === 'timed_out'));
    if (candidates.length === 0 || candidates.length > MAX_CLASSIFIED_FAILED_RUNS) return null;
    try {
        const verdicts = await Promise.all(candidates.map(run => isRunnerProblem(github, owner, repo, run)));
        const jobs = candidates.filter((_, index) => verdicts[index]).map(run => run.name);
        return jobs.length > 0 ? { jobs } : null;
    } catch (error) {
        logger.debug({ owner, repo, error: (error as Error).message }, 'Could not classify the failed checks of a pull request');
        return null;
    }
}
