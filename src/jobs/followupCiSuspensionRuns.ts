/**
 * GitHub Actions access for follow-up CI suspension, kept deliberately narrow:
 * it can read a pull request head, list the runs of one SHA, and cancel or
 * rerun one run. Nothing here decides when those operations are allowed.
 */

import {
    isEligibleValidationWorkflow, isPullRequestValidationEvent, type ValidationWorkflowPolicy,
} from './followupCiSuspensionPolicy.js';

/** Runs in these statuses have not produced a result yet, so cancelling one only discards work a new commit would invalidate. */
const CANCELABLE_RUN_STATUSES: ReadonlySet<string> = new Set(['queued', 'in_progress', 'waiting', 'pending', 'requested']);
/** A run that still occupies a runner, including one waiting for manual approval. */
export const PENDING_RUN_STATUSES: ReadonlySet<string> = new Set([...CANCELABLE_RUN_STATUSES, 'action_required']);

export interface WorkflowRunSummary {
    id: number;
    name?: string | null;
    /** Workflow file path, for example `.github/workflows/pr-build-check.yml`. Part of the workflow's identity for the eligibility policy. */
    path?: string | null;
    event?: string | null;
    status?: string | null;
    conclusion?: string | null;
    head_sha?: string | null;
    workflow_id?: number;
    /** Attempt number GitHub reports; a higher one proves a rerun was accepted. */
    run_attempt?: number;
    pull_requests?: Array<{ number: number }> | null;
}

export interface CiSuspensionOctokit {
    request(route: string, parameters?: Record<string, unknown>): Promise<{ status?: number; data: unknown }>;
}

export interface SuspensionTarget {
    owner: string;
    repo: string;
    pullRequestNumber: number;
}

export class CiActionsPermissionError extends Error {
    constructor(readonly operation: string, message: string) {
        super(`GitHub Actions ${operation} was refused: ${message}`);
        this.name = 'CiActionsPermissionError';
    }
}

export function sameSha(left: string | null | undefined, right: string | null | undefined): boolean {
    return !!left && !!right && left.toLowerCase() === right.toLowerCase();
}

/**
 * A request GitHub definitively refused: bad or expired credentials (401), a
 * permission the installation lacks (403), or the integration error GitHub
 * reports for an Actions scope the App was not granted. None of these ever
 * reached the run, which is what matters to the caller: a refused cancel
 * cancelled nothing and must not leave an intent behind, and a refused rerun
 * keeps the obligation until access is back.
 */
function isPermissionError(error: unknown): boolean {
    const { status, message } = error as { status?: number; message?: string };
    return status === 401 || status === 403 || /resource not accessible by integration/i.test(message ?? '');
}

/**
 * GitHub answers a cancel or rerun it will not apply with 409. For a cancel
 * that is the outcome the caller wanted: the run already finished. For a rerun
 * it proves nothing by itself: the run may already have been restarted, but it
 * may just as well still be converging on the cancellation ProPR asked for.
 */
function isConflict(error: unknown): boolean {
    return (error as { status?: number }).status === 409;
}

function isMissing(error: unknown): boolean {
    return (error as { status?: number }).status === 404;
}

/**
 * Ownership is proven by GitHub's own pull request association plus an exact
 * head SHA match, and the workflow itself must be one the operator selected: an
 * event alone never qualifies a run, a workflow name never does, and a branch
 * name never does either.
 */
export function isCancelableValidationRun(
    run: WorkflowRunSummary,
    target: { pullRequestNumber: number; headSha: string; policy: ValidationWorkflowPolicy },
): boolean {
    if (!isEligibleValidationWorkflow(run, target.policy)) return false;
    if (!CANCELABLE_RUN_STATUSES.has((run.status ?? '').toLowerCase())) return false;
    if (!sameSha(run.head_sha, target.headSha)) return false;
    return (run.pull_requests ?? []).some(pullRequest => pullRequest?.number === target.pullRequestNumber);
}

/**
 * Whether this live run is proof that the validation of a cancelled run already
 * exists again. Only a run of the same workflow that GitHub associates with the
 * captured pull request, carries the captured head and was triggered by the pull
 * request itself qualifies: a `push` run of the same commit, or a run of another
 * pull request, validates something else and can never settle the obligation to
 * restart what ProPR cancelled.
 */
export function isReplacementValidationRun(
    run: WorkflowRunSummary,
    target: { pullRequestNumber: number; headSha: string },
): boolean {
    if (!PENDING_RUN_STATUSES.has((run.status ?? '').toLowerCase())) return false;
    if (!isPullRequestValidationEvent(run.event)) return false;
    if (!sameSha(run.head_sha, target.headSha)) return false;
    return (run.pull_requests ?? []).some(pullRequest => pullRequest?.number === target.pullRequestNumber);
}

/** One page of runs; a busy head can carry more, so discovery never stops at the first page. */
const RUNS_PER_PAGE = 100;
/** Safety stop for pagination: 10 pages of runs for a single commit is already far past any real validation matrix. */
const MAX_RUN_PAGES = 10;

export async function listRunsForSha(
    octokit: CiSuspensionOctokit,
    target: SuspensionTarget,
    headSha: string,
): Promise<WorkflowRunSummary[]> {
    const runs: WorkflowRunSummary[] = [];
    const seen = new Set<number>();
    for (let page = 1; page <= MAX_RUN_PAGES; page += 1) {
        const response = await octokit.request('GET /repos/{owner}/{repo}/actions/runs', {
            owner: target.owner,
            repo: target.repo,
            head_sha: headSha,
            per_page: RUNS_PER_PAGE,
            page,
        });
        const data = response.data as { workflow_runs?: WorkflowRunSummary[]; total_count?: number } | undefined;
        const pageRuns = data?.workflow_runs ?? [];
        for (const run of pageRuns) {
            // Pages shift while runs start and finish; the same run must not be handled twice.
            if (seen.has(run.id)) continue;
            seen.add(run.id);
            runs.push(run);
        }
        if (pageRuns.length < RUNS_PER_PAGE) break;
        if (typeof data?.total_count === 'number' && seen.size >= data.total_count) break;
    }
    return runs;
}

/**
 * One run as GitHub reports it now; `undefined` when the lookup answered 404.
 * That answer does not establish that the run is gone: a private repository
 * the installation has lost access to answers 404 for every one of its runs,
 * exactly as it does for its pull request (see {@link getPullRequestHead}),
 * and the run is still there when access comes back. A caller that owes the
 * run something must therefore keep owing it, and ask again later.
 */
export async function getRun(
    octokit: CiSuspensionOctokit,
    target: SuspensionTarget,
    runId: number,
): Promise<WorkflowRunSummary | undefined> {
    try {
        const response = await octokit.request('GET /repos/{owner}/{repo}/actions/runs/{run_id}', {
            owner: target.owner, repo: target.repo, run_id: runId,
        });
        return response.data as WorkflowRunSummary;
    } catch (error) {
        if (isMissing(error)) return undefined;
        throw error;
    }
}

/** One attempt of a run, as GitHub keeps it after the run moved on; undefined when GitHub has no such attempt. */
export async function getRunAttempt(
    octokit: CiSuspensionOctokit,
    target: SuspensionTarget,
    runId: number,
    attempt: number,
): Promise<WorkflowRunSummary | undefined> {
    try {
        const response = await octokit.request('GET /repos/{owner}/{repo}/actions/runs/{run_id}/attempts/{attempt_number}', {
            owner: target.owner, repo: target.repo, run_id: runId, attempt_number: attempt,
        });
        return response.data as WorkflowRunSummary;
    } catch (error) {
        if (isMissing(error)) return undefined;
        throw error;
    }
}

/**
 * Which attempt an accepted cancellation affected, established from the run's
 * own attempts rather than from whatever attempt the run shows now.
 *
 * GitHub cancels the attempt that is current when the request lands, and the
 * attempt discovery observed is the earliest that can have been. A run still
 * on that attempt settles it: nothing was rerun in between, so that is the
 * attempt the request landed on, whether its cancellation has converged yet or
 * not. A run beyond it was rerun at some point, and the newer attempt must not
 * simply be adopted: had the cancellation landed first, the rerun already
 * brought the validation back, and "restoring" the newer attempt would rerun
 * on somebody else's behalf whatever they later did with it. The attempts the
 * run left behind are the evidence: the first one from the observed attempt
 * on that ended cancelled is the one ProPR's request affected, and the rerun
 * past it met the obligation. Only when none of them ended cancelled did the
 * request land on the attempt the run is on now.
 *
 * Returns undefined when the evidence cannot be read: an unconfirmed attempt
 * is settled by the run's outcome later, with the observed attempt on record
 * to repeat this very check.
 */
export async function locateCancelledAttempt(
    octokit: CiSuspensionOctokit,
    target: SuspensionTarget,
    runId: number,
    evidence: { observedAttempt?: number; live: WorkflowRunSummary },
): Promise<number | undefined> {
    const { observedAttempt, live } = evidence;
    if (typeof live.run_attempt !== 'number' || typeof observedAttempt !== 'number') return undefined;
    if (live.run_attempt < observedAttempt) return undefined;
    for (let attempt = observedAttempt; attempt < live.run_attempt; attempt += 1) {
        const earlier = await getRunAttempt(octokit, target, runId, attempt);
        if (!earlier) return undefined;
        if ((earlier.conclusion ?? '').toLowerCase() === 'cancelled') return attempt;
    }
    return live.run_attempt;
}

export interface PullRequestHead {
    sha: string;
    open: boolean;
}

/**
 * The pull request's current head and whether it is still open. `undefined`
 * means the lookup could not establish either: the pull request answered 404 or
 * came back without a head. That is not a closed pull request — a private
 * repository answers 404 while the installation has lost access to it, and the
 * head is still there when access comes back — so callers must keep whatever
 * they owe that head and ask again later.
 */
export async function getPullRequestHead(
    octokit: CiSuspensionOctokit,
    target: SuspensionTarget,
): Promise<PullRequestHead | undefined> {
    try {
        const response = await octokit.request('GET /repos/{owner}/{repo}/pulls/{pull_number}', {
            owner: target.owner, repo: target.repo, pull_number: target.pullRequestNumber,
        });
        const data = response.data as { state?: string; head?: { sha?: string } };
        if (!data?.head?.sha) return undefined;
        return { sha: data.head.sha, open: data.state === 'open' };
    } catch (error) {
        if (isMissing(error)) return undefined;
        throw error;
    }
}

export async function cancelRun(
    octokit: CiSuspensionOctokit,
    target: SuspensionTarget,
    runId: number,
): Promise<boolean> {
    try {
        await octokit.request('POST /repos/{owner}/{repo}/actions/runs/{run_id}/cancel', {
            owner: target.owner, repo: target.repo, run_id: runId,
        });
        return true;
    } catch (error) {
        // 409 means the run already reached a terminal state on its own.
        if (isConflict(error)) return false;
        if (isPermissionError(error)) throw new CiActionsPermissionError('cancellation', (error as Error).message);
        throw error;
    }
}

/**
 * `restarted` — GitHub accepted this rerun, or the run itself proves that the
 * lost request landed; `exists` — the cancelled attempt was already restarted
 * by somebody else; `unconfirmed` — the request failed with no evidence that
 * the cancelled attempt was restarted, so the obligation stays and the next
 * pass retries it.
 */
export type RerunOutcome = 'restarted' | 'exists' | 'unconfirmed';

/**
 * Whether the run has moved past the attempt ProPR cancelled, which only an
 * accepted rerun can cause. Nothing else the run reports is evidence of a
 * restart: a pending status on the same attempt is what a cancellation that
 * is still converging looks like, and treating it as a restart would release
 * the obligation while the head's validation ends up cancelled.
 */
function attemptAdvancedPast(live: WorkflowRunSummary, evidence: { attempt?: number }): boolean {
    return typeof live.run_attempt === 'number' && typeof evidence.attempt === 'number' && live.run_attempt > evidence.attempt;
}

export async function rerunRun(
    octokit: CiSuspensionOctokit,
    target: SuspensionTarget,
    runId: number,
    evidence: { attempt?: number } = {},
): Promise<RerunOutcome> {
    try {
        await octokit.request('POST /repos/{owner}/{repo}/actions/runs/{run_id}/rerun', {
            owner: target.owner, repo: target.repo, run_id: runId,
        });
        return 'restarted';
    } catch (error) {
        if (isPermissionError(error)) throw new CiActionsPermissionError('rerun', (error as Error).message);
        // Neither a conflict nor a lost response says what happened to the
        // cancelled attempt. GitHub rejects a rerun with 409 both for a run
        // somebody already restarted and for a run still converging on its
        // cancellation, and a request can be accepted after its response was
        // lost. The run itself is the only evidence: an attempt beyond the
        // one ProPR cancelled means the restart happened and must not be
        // requested again. Anything else keeps the obligation, for the next
        // pass to look at the run again and retry the rerun.
        const live = await getRun(octokit, target, runId).catch(() => undefined);
        if (!live || !attemptAdvancedPast(live, evidence)) return 'unconfirmed';
        return isConflict(error) ? 'exists' : 'restarted';
    }
}
