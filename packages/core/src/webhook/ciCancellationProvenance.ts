import type { Knex } from 'knex';
import { db } from '../db/connection.js';

/**
 * Tells a check run that failed *because* its workflow run was deliberately
 * cancelled apart from a genuine failure.
 *
 * An aggregate gate such as the Full Test Suite's `Run Full Test Suite` runs
 * under `always()` and fails closed when its shards were cancelled, so GitHub
 * reports it as `failure` although no assertion failed. When ProPR itself
 * cancelled that run to suspend validation during a follow-up implementation,
 * turning the gate's failure into another follow-up restarts the cycle: the
 * new follow-up cancels the next head's validation, whose gate fails again.
 *
 * The check is only judged cancellation-induced when all of this holds:
 *  - the cancellation is provenanced: ProPR's durable suspension record owns
 *    this run attempt, or GitHub reports the attempt itself as `cancelled`
 *    (an operator or another deliberate cancellation);
 *  - no other job of that attempt genuinely failed (failure, timed_out,
 *    startup_failure, action_required), so a real failure next to the
 *    cancellation still reaches the agent;
 *  - the failing job finished no earlier than the first job the cancellation
 *    stopped, so a job that failed on its own before the cancellation landed
 *    keeps its follow-up.
 * Anything unreadable or ambiguous is not proof, and the follow-up is posted.
 * The check run itself keeps its failing conclusion, so required merge gates
 * are untouched.
 */

/** Mirrors `PR_CI_SUSPENSIONS_TABLE` in the worker's src/jobs/followupCiSuspensionStore.ts. */
const PR_CI_SUSPENSIONS_TABLE = 'pr_ci_suspensions';
const ACTIONS_RUN_URL_RE = /\/actions\/runs\/(\d+)(?:\/job\/(\d+))?/u;
const GENUINE_FAILURE_CONCLUSIONS = new Set(['action_required', 'failure', 'startup_failure', 'timed_out']);
const JOBS_PAGE_SIZE = 100;

/** The subset of the worker's `CancelledRun` that identifies the attempt ProPR cancelled. */
export interface ProprCancelledRun {
    id: number;
    observedAttempt?: number;
    attempt?: number;
    restarted?: boolean;
}

export interface CancellationProvenanceOctokit {
    request: (route: string, parameters: Record<string, unknown>) => Promise<{ data: unknown }>;
}

export interface CancellationProvenanceTarget {
    owner: string;
    repo: string;
    prNumber: number;
    checkRunId?: number;
    url: string;
}

export interface CancellationProvenance {
    cancelledBy: 'propr_suspension' | 'workflow_cancelled';
    runId: number;
    runAttempt: number | undefined;
}

export type LoadProprCancelledRuns = (repository: string, pullRequest: number) => Promise<ProprCancelledRun[]>;

interface ActionsJob {
    id?: number;
    run_id?: number;
    run_attempt?: number;
    conclusion?: string | null;
    completed_at?: string | null;
}

/** The runs ProPR's active suspension of this pull request recorded as cancelled. */
export async function loadProprCancelledRuns(
    repository: string,
    pullRequest: number,
    database: Knex = db as unknown as Knex,
): Promise<ProprCancelledRun[]> {
    const row = await database(PR_CI_SUSPENSIONS_TABLE)
        .where({ repository: repository.toLowerCase(), pull_request: pullRequest })
        .first('cancelled_runs') as { cancelled_runs?: string } | undefined;
    if (!row?.cancelled_runs) return [];
    try {
        const parsed = JSON.parse(row.cancelled_runs) as unknown;
        if (!Array.isArray(parsed)) return [];
        return parsed.filter((entry): entry is ProprCancelledRun =>
            !!entry && typeof entry === 'object' && Number.isInteger((entry as ProprCancelledRun).id));
    } catch {
        return [];
    }
}

/**
 * Whether ProPR's record covers this attempt. A confirmed attempt must match
 * exactly, so a rerun ProPR started to restore validation is judged on its
 * own; otherwise the attempt must be at least the one observed at cancel time
 * and the obligation still unrestored.
 */
export function proprCancelledAttempt(entry: ProprCancelledRun, runAttempt: number | undefined): boolean {
    if (runAttempt === undefined) return entry.restarted !== true;
    if (typeof entry.attempt === 'number') return runAttempt === entry.attempt;
    if (typeof entry.observedAttempt === 'number' && runAttempt < entry.observedAttempt) return false;
    return entry.restarted !== true;
}

export async function findCancellationProvenance(
    octokit: CancellationProvenanceOctokit,
    target: CancellationProvenanceTarget,
    loadCancelledRuns: LoadProprCancelledRuns = loadProprCancelledRuns,
): Promise<CancellationProvenance | null> {
    const urlMatch = ACTIONS_RUN_URL_RE.exec(target.url);
    if (!urlMatch) return null;
    // An Actions job's check run id is its job id.
    const jobId = target.checkRunId ?? (urlMatch[2] ? Number(urlMatch[2]) : undefined);
    if (jobId == null) return null;
    const repoParams = { owner: target.owner, repo: target.repo };

    const job = asRecord((await octokit.request('GET /repos/{owner}/{repo}/actions/jobs/{job_id}', { ...repoParams, job_id: jobId })).data) as ActionsJob | null;
    const runId = typeof job?.run_id === 'number' ? job.run_id : Number(urlMatch[1]);
    const runAttempt = typeof job?.run_attempt === 'number' ? job.run_attempt : undefined;
    if (!job || !job.completed_at || runAttempt === undefined) return null;

    const cancelledBy = await resolveCancellationSource(octokit, target, runId, runAttempt, loadCancelledRuns);
    if (!cancelledBy) return null;

    const { data } = await octokit.request('GET /repos/{owner}/{repo}/actions/runs/{run_id}/attempts/{attempt_number}/jobs', {
        ...repoParams, run_id: runId, attempt_number: runAttempt, per_page: JOBS_PAGE_SIZE,
    });
    const listing = asRecord(data);
    const jobs = Array.isArray(listing?.jobs) ? listing.jobs.filter(asRecord) as ActionsJob[] : [];
    // Jobs that could not be seen may hold the genuine failure.
    if (typeof listing?.total_count !== 'number' || listing.total_count > jobs.length) return null;

    const siblings = jobs.filter(sibling => sibling.id !== jobId);
    if (siblings.some(sibling => GENUINE_FAILURE_CONCLUSIONS.has((sibling.conclusion ?? '').toLowerCase()))) return null;
    const cancellationTimes = siblings
        .filter(sibling => (sibling.conclusion ?? '').toLowerCase() === 'cancelled')
        .map(sibling => Date.parse(sibling.completed_at ?? ''))
        .filter(Number.isFinite);
    if (cancellationTimes.length === 0) return null;
    const failedAt = Date.parse(job.completed_at);
    if (!Number.isFinite(failedAt) || failedAt < Math.min(...cancellationTimes)) return null;

    return { cancelledBy, runId, runAttempt };
}

async function resolveCancellationSource(
    octokit: CancellationProvenanceOctokit,
    target: CancellationProvenanceTarget,
    runId: number,
    runAttempt: number,
    loadCancelledRuns: LoadProprCancelledRuns,
): Promise<CancellationProvenance['cancelledBy'] | null> {
    const recorded = await loadCancelledRuns(`${target.owner}/${target.repo}`, target.prNumber);
    if (recorded.some(entry => entry.id === runId && proprCancelledAttempt(entry, runAttempt))) return 'propr_suspension';

    // The suspension row is gone once validation was restored; a late event of
    // the cancelled attempt still carries the attempt's own conclusion.
    const { data } = await octokit.request('GET /repos/{owner}/{repo}/actions/runs/{run_id}/attempts/{attempt_number}', {
        owner: target.owner, repo: target.repo, run_id: runId, attempt_number: runAttempt,
    });
    const attempt = asRecord(data);
    return attempt?.status === 'completed' && attempt.conclusion === 'cancelled' ? 'workflow_cancelled' : null;
}

function asRecord(value: unknown): Record<string, unknown> | null {
    return typeof value === 'object' && value !== null ? value as Record<string, unknown> : null;
}
