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
 *  - the check itself plainly failed: its reported conclusion, the fetched
 *    job and the attempt's job listing all read `failure`. A target that
 *    timed out, could not start or awaits action is a genuine outcome of its
 *    own, even when its evidence and the fetched job disagree;
 *  - the cancellation is provenanced: ProPR's durable suspension record owns
 *    this run attempt, or GitHub reports the attempt itself as `cancelled`
 *    (an operator or another deliberate cancellation);
 *  - no other job of that attempt genuinely failed (failure, timed_out,
 *    startup_failure, action_required), so a real failure next to the
 *    cancellation still reaches the agent;
 *  - the failing job finished no earlier than the first job the cancellation
 *    stopped, so a job that failed on its own before the cancellation landed
 *    keeps its follow-up;
 *  - the check's own failure annotations show it failed *because* of the
 *    cancellation: at least one reports a needed job as `cancelled`, and every
 *    other one is the runner's exit-code notice or a recognized consequence
 *    of cancelled shards. Timing and provenance only correlate; a job that
 *    keeps running under `always()` and fails its own assertion after the
 *    cancellation is still reported;
 *  - every step of the check that failed is the recognized gate that enforces
 *    its needed jobs' results, or a recognized step that fails only because
 *    cancelled shards uploaded nothing, and the gate itself failed. Exit-code
 *    notices carry no step, so a plain shell step failing next to the gate is
 *    caught by its step conclusion, and the notices may not outnumber the
 *    recognized steps that ran.
 * Anything unreadable or ambiguous is not proof, and the follow-up is posted.
 * The check run itself keeps its failing conclusion, so required merge gates
 * are untouched.
 */

/** Mirrors `PR_CI_SUSPENSIONS_TABLE` in the worker's src/jobs/followupCiSuspensionStore.ts. */
const PR_CI_SUSPENSIONS_TABLE = 'pr_ci_suspensions';
const ACTIONS_RUN_URL_RE = /\/actions\/runs\/(\d+)(?:\/job\/(\d+))?/u;
const GENUINE_FAILURE_CONCLUSIONS = new Set(['action_required', 'failure', 'startup_failure', 'timed_out']);
/** The only target conclusion a deliberate cancellation can explain: an aggregate failing closed. */
const ELIGIBLE_TARGET_CONCLUSION = 'failure';
const JOBS_PAGE_SIZE = 100;
const ANNOTATIONS_PAGE_SIZE = 100;
/** More annotation pages than GitHub keeps for one job is not a cancelled aggregate. */
const MAX_ANNOTATION_PAGES = 5;
/** The aggregate's `::error::` for a needed job the cancellation stopped. */
const CANCELLED_DEPENDENCY_RE = /^.+ finished with result 'cancelled'\.$/u;
/** The runner's notice for the failing step; it says nothing about why. */
const STEP_EXIT_RE = /^Process completed with exit code \d+\.$/u;
/**
 * Failures the aggregate reports only as a consequence of cancelled shards:
 * cancelled shards upload no summaries, so their coverage cannot verify.
 */
const CANCELLATION_CONSEQUENCES = new Set([
    "Shard coverage verification finished with result 'failure'.",
]);
/** The aggregate's step that fails on the needed jobs' results; mirrors pr-test-on-label.yml. */
const DEPENDENCY_GATE_STEPS = new Set(['Enforce shard and docs results']);
/** Steps whose failure cancelled shards alone explain: no summaries were uploaded to verify. */
const CANCELLATION_CONSEQUENCE_STEPS = new Set(['Verify shards ran every discovered test exactly once']);
/** Step conclusions that do not fail a job. */
const PASSING_STEP_CONCLUSIONS = new Set(['neutral', 'skipped', 'success']);

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
    /** The conclusion the failure evidence reported for this check run. */
    conclusion: string;
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
    steps?: unknown;
}

interface ActionsStep {
    name?: unknown;
    conclusion?: unknown;
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
    const targetJob = await loadTargetJob(octokit, target);
    if (!targetJob) return null;
    const { job, jobId, runId, runAttempt } = targetJob;

    const cancelledBy = await resolveCancellationSource(octokit, target, { runId, runAttempt }, loadCancelledRuns);
    if (!cancelledBy) return null;

    const jobs = await listAttemptJobs(octokit, target, runId, runAttempt);
    if (!jobs || !failedAfterSiblingCancellation(job, jobId, jobs)) return null;
    const gateSteps = gateStepsThatRan(job.steps);
    if (gateSteps === null) return null;
    if (!await failedOnCancelledDependencies(octokit, target, jobId, gateSteps)) return null;

    return { cancelledBy, runId, runAttempt };
}

interface TargetJob {
    job: ActionsJob & { completed_at: string };
    jobId: number;
    runId: number;
    runAttempt: number;
}

/** The target's own Actions job, when it is a completed, failed job of a known attempt. */
async function loadTargetJob(
    octokit: CancellationProvenanceOctokit,
    target: CancellationProvenanceTarget,
): Promise<TargetJob | null> {
    if (!isEligibleTargetConclusion(target.conclusion)) return null;
    const urlMatch = ACTIONS_RUN_URL_RE.exec(target.url);
    if (!urlMatch) return null;
    // An Actions job's check run id is its job id.
    const jobId = target.checkRunId ?? (urlMatch[2] ? Number(urlMatch[2]) : undefined);
    if (jobId == null) return null;

    const job = asRecord((await octokit.request('GET /repos/{owner}/{repo}/actions/jobs/{job_id}', {
        owner: target.owner, repo: target.repo, job_id: jobId,
    })).data) as ActionsJob | null;
    if (!job || !job.completed_at || typeof job.run_attempt !== 'number') return null;
    if (!isEligibleTargetConclusion(job.conclusion)) return null;
    const runId = typeof job.run_id === 'number' ? job.run_id : Number(urlMatch[1]);
    return { job: job as TargetJob['job'], jobId, runId, runAttempt: job.run_attempt };
}

/** Every job of the attempt, or null when some could not be seen; those may hold the genuine failure. */
async function listAttemptJobs(
    octokit: CancellationProvenanceOctokit,
    target: CancellationProvenanceTarget,
    runId: number,
    runAttempt: number,
): Promise<ActionsJob[] | null> {
    const { data } = await octokit.request('GET /repos/{owner}/{repo}/actions/runs/{run_id}/attempts/{attempt_number}/jobs', {
        owner: target.owner, repo: target.repo, run_id: runId, attempt_number: runAttempt, per_page: JOBS_PAGE_SIZE,
    });
    const listing = asRecord(data);
    const jobs = Array.isArray(listing?.jobs) ? listing.jobs.filter(asRecord) as ActionsJob[] : [];
    if (typeof listing?.total_count !== 'number' || listing.total_count > jobs.length) return null;
    return jobs;
}

/**
 * Whether the attempt's listing confirms the target failed, no sibling failed
 * genuinely, and the target finished no earlier than a cancelled sibling.
 */
function failedAfterSiblingCancellation(job: TargetJob['job'], jobId: number, jobs: ActionsJob[]): boolean {
    const listed = jobs.find(entry => entry.id === jobId);
    if (!listed || !isEligibleTargetConclusion(listed.conclusion)) return false;
    const siblings = jobs.filter(sibling => sibling.id !== jobId);
    if (siblings.some(sibling => GENUINE_FAILURE_CONCLUSIONS.has((sibling.conclusion ?? '').toLowerCase()))) return false;
    const cancellationTimes = siblings
        .filter(sibling => (sibling.conclusion ?? '').toLowerCase() === 'cancelled')
        .map(sibling => Date.parse(sibling.completed_at ?? ''))
        .filter(Number.isFinite);
    if (cancellationTimes.length === 0) return false;
    const failedAt = Date.parse(job.completed_at);
    return Number.isFinite(failedAt) && failedAt >= Math.min(...cancellationTimes);
}

async function resolveCancellationSource(
    octokit: CancellationProvenanceOctokit,
    target: CancellationProvenanceTarget,
    { runId, runAttempt }: { runId: number; runAttempt: number },
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

/**
 * How many recognized gate steps ran, when every failed step of the job is
 * one of them and the dependency gate itself failed; otherwise null. Missing,
 * unnamed or unconcluded steps cannot be attributed and are not proof.
 */
function gateStepsThatRan(steps: unknown): number | null {
    if (!Array.isArray(steps) || steps.length === 0) return null;
    let ran = 0;
    let gateFailed = false;
    for (const entry of steps) {
        const step = asRecord(entry) as ActionsStep | null;
        if (!step || typeof step.name !== 'string' || typeof step.conclusion !== 'string') return null;
        const conclusion = step.conclusion.toLowerCase();
        const gate = DEPENDENCY_GATE_STEPS.has(step.name);
        const recognized = gate || CANCELLATION_CONSEQUENCE_STEPS.has(step.name);
        if (recognized && conclusion !== 'skipped') ran += 1;
        if (PASSING_STEP_CONCLUSIONS.has(conclusion)) continue;
        if (!recognized) return null;
        if (gate) gateFailed = true;
    }
    return gateFailed ? ran : null;
}

/**
 * Whether the check's failure annotations attribute its failure to cancelled
 * needed jobs and to nothing else. Missing, truncated or unrecognized
 * failures are not proof, and neither are more exit-code notices than the
 * recognized gate steps that ran could have produced.
 */
async function failedOnCancelledDependencies(
    octokit: CancellationProvenanceOctokit,
    target: CancellationProvenanceTarget,
    checkRunId: number,
    gateStepsRan: number,
): Promise<boolean> {
    const failures: string[] = [];
    for (let page = 1; ; page += 1) {
        if (page > MAX_ANNOTATION_PAGES) return false;
        const { data } = await octokit.request('GET /repos/{owner}/{repo}/check-runs/{check_run_id}/annotations', {
            owner: target.owner, repo: target.repo, check_run_id: checkRunId, per_page: ANNOTATIONS_PAGE_SIZE, page,
        });
        if (!Array.isArray(data)) return false;
        for (const annotation of data) {
            const record = asRecord(annotation);
            if (record?.annotation_level !== 'failure') continue;
            failures.push(typeof record.message === 'string' ? record.message.trim() : '');
        }
        if (data.length < ANNOTATIONS_PAGE_SIZE) break;
    }
    if (failures.filter(message => STEP_EXIT_RE.test(message)).length > gateStepsRan) return false;
    return failures.some(message => CANCELLED_DEPENDENCY_RE.test(message))
        && failures.every(message => CANCELLED_DEPENDENCY_RE.test(message)
            || STEP_EXIT_RE.test(message)
            || CANCELLATION_CONSEQUENCES.has(message));
}

function isEligibleTargetConclusion(conclusion: string | null | undefined): boolean {
    return (conclusion ?? '').toLowerCase() === ELIGIBLE_TARGET_CONCLUSION;
}

function asRecord(value: unknown): Record<string, unknown> | null {
    return typeof value === 'object' && value !== null ? value as Record<string, unknown> : null;
}
