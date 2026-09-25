import { getStateManager, isCancelCiDuringFollowupEnabledForRepository, TaskStates } from '@propr/core';
import {
    CiActionsPermissionError, getPullRequestHead, getRun, isReplacementValidationRun, listRunsForSha, locateCancelledAttempt,
    rerunRun, sameSha, type CiSuspensionOctokit, type SuspensionTarget, type WorkflowRunSummary,
} from './followupCiSuspensionRuns.js';
import { delay, resolveLog, resolveOctokit, type CiSuspensionDeps } from './followupCiSuspensionContext.js';
import { cancellationState, cancelPendingRuns } from './followupCiSuspensionCancel.js';
import {
    deleteSuspension, loadSuspension, loadSuspensions, nowMs, parseCancelledRuns, saveCancelledRuns, splitRepository,
    SUSPENSION_ACTIVE, SUSPENSION_BLOCKED, SUSPENSION_RESTORING, suspensionKey, targetOf,
    type CancelledRun, type CiSuspensionRecord,
} from './followupCiSuspensionStore.js';
import {
    SuspensionLeaseLostError, SuspensionLeaseUnavailableError, withSuspensionLease, type SuspensionLease,
} from './followupCiSuspensionLease.js';

/**
 * Cancels the GitHub Actions validation of a pull request head that a follow-up
 * implementation is about to replace, and owns the obligation to bring that
 * validation back when no replacement commit is published.
 *
 * Opt-in per repository ("Cancel CI while follow-up implementation is in
 * progress") and strictly scoped: only queued/in-progress runs that GitHub
 * itself associates with the captured pull request and captured head SHA, and
 * whose workflow the repository's operator explicitly selected, are touched.
 * Workflows nobody selected — preview and deployment workflows among them, and
 * any workflow whose name merely sounds like validation — are never cancelled,
 * and neither are manual, branch and other-pull-request runs, other revisions
 * or non-Actions checks.
 *
 * Every step of one pull request's suspension — begin, sweep, restore, release —
 * runs while holding the same shared lease and writes with the generation it
 * read, so the job finalizer of one worker and the periodic recovery pass of
 * another can never fight over it.
 */

const TERMINAL_TASK_STATES: ReadonlySet<string> = new Set([TaskStates.COMPLETED, TaskStates.FAILED, TaskStates.CANCELLED]);

/** Absolute lifetime of a suspension. Reached only when its owner never reported a terminal state; CI is never suppressed beyond it. */
export const MAX_SUSPENSION_AGE_MS = 6 * 60 * 60 * 1000;
/** Restoration attempts before the obligation stops being retried inline and waits, loudly, in the durable blocked state. */
export const MAX_RESTORE_ATTEMPTS = 60;
const DEFAULT_RESTORE_BUDGET_MS = 15_000;
const DEFAULT_POLL_INTERVAL_MS = 2_000;

export interface SweepSuspensionResult {
    /** `head_unavailable`: the pull request could not be read, so nothing was decided and the suspension is kept for the next pass. */
    reason: 'swept' | 'head_replaced' | 'pull_request_closed' | 'head_unavailable' | 'superseded' | 'busy';
    cancelledRunIds: number[];
}

export interface RestoreSuspensionResult {
    /** `head_unavailable`: the pull request could not be read, so the obligation is kept and retried by the next reconciliation. */
    reason: 'restarted' | 'head_replaced' | 'pull_request_closed' | 'head_unavailable' | 'pending' | 'permission_denied'
        | 'superseded' | 'blocked' | 'busy';
    restartedRunIds: number[];
    pendingRunIds: number[];
}

/** Outcomes that released nothing: the record, and with it every restart obligation, is still there. */
const RETAINED_RESTORE_REASONS: ReadonlySet<RestoreSuspensionResult['reason']> = new Set([
    'pending', 'permission_denied', 'blocked', 'superseded', 'busy', 'head_unavailable',
]);

export { CiActionsPermissionError, isCancelableValidationRun } from './followupCiSuspensionRuns.js';
export {
    createValidationWorkflowPolicy, isEligibleValidationWorkflow, loadValidationWorkflowPolicyFromEnv,
    NO_VALIDATION_WORKFLOWS_SELECTED, parseWorkflowSelection, resolveValidationWorkflowPolicy,
    VALIDATION_WORKFLOW_ALLOWLIST_ENV, VALIDATION_WORKFLOW_SELECTION_UNREADABLE,
} from './followupCiSuspensionPolicy.js';
export { PR_CI_SUSPENSION_LEASES_TABLE, SuspensionLeaseUnavailableError } from './followupCiSuspensionLease.js';
export type { ValidationWorkflowPolicy } from './followupCiSuspensionPolicy.js';
export {
    beginFollowupCiSuspension, resolveFollowupCiSuspensionTarget, suspendObsoleteValidationForImplementation,
} from './followupCiSuspensionCancel.js';
export {
    PR_CI_SUSPENSIONS_TABLE, SUSPENSION_ACTIVE, SUSPENSION_BLOCKED, SUSPENSION_RESTORING,
} from './followupCiSuspensionStore.js';
export type { BeginSuspensionResult } from './followupCiSuspensionCancel.js';
export type { CiSuspensionDeps } from './followupCiSuspensionContext.js';
export type { SuspensionTarget } from './followupCiSuspensionRuns.js';
export type { CancelledRun, CiSuspensionRecord } from './followupCiSuspensionStore.js';

/**
 * Cancels runs that GitHub queued after the suspension started. Runs of a newly
 * published head carry a different SHA and are never matched here, and a
 * suspension that is already restoring is left alone so a sweep can never
 * re-cancel validation that is being brought back.
 */
export async function sweepFollowupCiSuspension(
    record: CiSuspensionRecord,
    deps: CiSuspensionDeps = {},
): Promise<SweepSuspensionResult> {
    try {
        return await withSuspensionLease(deps, suspensionKey(record), lease => sweepSuspension(record, deps, lease));
    } catch (error) {
        if (!(error instanceof SuspensionLeaseUnavailableError) && !(error instanceof SuspensionLeaseLostError)) throw error;
        // Whoever holds the lease is already deciding what this pull request
        // needs; sweeping next to them could cancel what they are restoring.
        return { reason: 'busy', cancelledRunIds: [] };
    }
}

async function sweepSuspension(
    record: CiSuspensionRecord,
    deps: CiSuspensionDeps,
    lease: SuspensionLease,
): Promise<SweepSuspensionResult> {
    const current = await loadSuspension(deps, record);
    // The row may already belong to a newer implementation of the same pull
    // request, or its restoring transition may have taken it out of suppression.
    if (!current || current.incarnation !== record.incarnation || current.task_id !== record.task_id || !sameSha(current.head_sha, record.head_sha)) {
        return { reason: 'superseded', cancelledRunIds: [] };
    }
    if (current.state !== SUSPENSION_ACTIVE) return { reason: 'superseded', cancelledRunIds: [] };
    const target = targetOf(current);
    const octokit = await resolveOctokit(deps);
    const live = await getPullRequestHead(octokit, target);
    if (!live) {
        // Nothing is known about the head, so nothing is decided about it: the
        // suspension and its obligations wait for a pass that can read it.
        logHeadUnavailable(current, deps);
        return { reason: 'head_unavailable', cancelledRunIds: [] };
    }
    if (!live.open) {
        await deleteSuspension(deps, current);
        return { reason: 'pull_request_closed', cancelledRunIds: [] };
    }
    if (!sameSha(live.sha, current.head_sha)) {
        // A replacement commit is published: its validation must run normally and
        // the superseded revision is never restarted.
        await deleteSuspension(deps, current);
        resolveLog(deps).info({ repository: current.repository, pullRequest: current.pull_request, headSha: live.sha },
            'Released follow-up CI suspension: a replacement commit was published');
        return { reason: 'head_replaced', cancelledRunIds: [] };
    }
    const state = cancellationState(current, parseCancelledRuns(current));
    await cancelPendingRuns(state, { ...deps, octokit }, lease);
    return { reason: state.ownershipLost ? 'superseded' : 'swept', cancelledRunIds: state.cancelledRunIds };
}

function logHeadUnavailable(record: CiSuspensionRecord, deps: CiSuspensionDeps): void {
    resolveLog(deps).warn({ repository: record.repository, pullRequest: record.pull_request, headSha: record.head_sha },
        'The pull request of a follow-up CI suspension cannot be read right now; the suspension is kept and retried, '
        + 'because a pull request that cannot be seen is not a closed one');
}

/**
 * Decides what one cancelled run still needs. Runs that are still finishing stay
 * pending; runs that produced their own result or already have a fresh run of
 * the same workflow validating the same pull request head need no restart.
 * Only a run GitHub reports as cancelled, on the attempt ProPR cancelled, is
 * owed a rerun.
 *
 * A run that cannot be read is pending as well, never settled. GitHub answers
 * 404 for a run that was deleted, but just the same for every run of a private
 * repository the installation has lost access to — the pull request lookup
 * treats that answer exactly so — and the run itself cannot tell the two
 * apart. Access comes back, and with it the very run, still cancelled on the
 * still-current head; an obligation dropped on that 404 would leave those
 * checks cancelled with nothing left to restore them. The obligation therefore
 * stays recorded, for a reconciliation that can read the run to settle it. A
 * run that truly was deleted keeps its record only until its head is replaced
 * or the pull request is closed, which is what every retained obligation waits
 * for.
 *
 * The run is read from GitHub here, immediately before the decision, never
 * taken from the listing the pass started with. That listing is a snapshot,
 * and it ages while the runs before this one are assessed and rerun: an
 * operator who reruns this run in the meantime, and cancels the attempt they
 * started, leaves it cancelled on a newer attempt. Judged on the listed
 * attempt, that would look like the attempt ProPR cancelled still waiting for
 * its rerun, and the rerun would restart their cancelled attempt on their
 * behalf. Judged on the run as it is now, the newer attempt is the proof that
 * the obligation was already met.
 *
 * The attempt recorded at cancellation is the one GitHub confirmed ProPR
 * cancelled. A live attempt beyond it proves that attempt was already rerun —
 * by a pass that crashed before it could record the restart, or by somebody at
 * GitHub — and the obligation is met. Whatever happened to the newer attempt
 * afterwards is not ProPR's doing and is never "restored" on its behalf. A
 * record without a confirmed attempt proves nothing of the kind, and is settled
 * by the run's outcome: the attempt the run is cancelled on now is reported
 * back as the one a rerun would restart, for the caller to record before it
 * sends that rerun — unless the attempts the run left behind since the one
 * observed at cancellation show that ProPR's request affected an earlier one,
 * in which case the rerun past it already met the obligation. A record from
 * before that evidence was kept has no observed attempt and is settled by the
 * outcome alone.
 */
async function assessCancelledRun(
    run: CancelledRun,
    context: { target: SuspensionTarget; octokit: CiSuspensionOctokit; activeWorkflowIds: Set<number> },
): Promise<'pending' | 'settled' | { rerun: { cancelledAttempt?: number } }> {
    const { target, octokit, activeWorkflowIds } = context;
    const liveRun = await getRun(octokit, target, run.id);
    // Unreadable is not gone: a 404 is what lost access to a private repository
    // looks like as well, and the run is still there when access returns.
    if (!liveRun) return 'pending';
    if (attemptAdvanced(run, liveRun)) return 'settled';
    if ((liveRun.status ?? '').toLowerCase() !== 'completed') return 'pending';
    if ((liveRun.conclusion ?? '').toLowerCase() !== 'cancelled') return 'settled';
    if (run.workflowId !== undefined && activeWorkflowIds.has(run.workflowId)) return 'settled';
    if (typeof run.attempt === 'number') return { rerun: { cancelledAttempt: run.attempt } };
    if (typeof run.observedAttempt !== 'number') return { rerun: { cancelledAttempt: liveRun.run_attempt } };
    const cancelledAttempt = await locateCancelledAttempt(octokit, target, run.id, { observedAttempt: run.observedAttempt, live: liveRun });
    // Evidence that cannot be read right now decides nothing; the obligation waits for a pass that can read it.
    if (cancelledAttempt === undefined) return 'pending';
    if (typeof liveRun.run_attempt === 'number' && liveRun.run_attempt > cancelledAttempt) return 'settled';
    return { rerun: { cancelledAttempt } };
}

/** Whether the run already moved past the attempt ProPR confirmably cancelled, which only an accepted rerun can cause. */
function attemptAdvanced(run: CancelledRun, liveRun: WorkflowRunSummary): boolean {
    return typeof run.attempt === 'number' && typeof liveRun.run_attempt === 'number' && liveRun.run_attempt > run.attempt;
}

/**
 * What has to hold immediately before a rerun leaves the worker: the lease is
 * still this worker's and the captured head is still the pull request's current
 * one. Returns null while both hold; otherwise the result restoration stops
 * with. Lease loss surfaces as {@link SuspensionLeaseLostError}, and it is
 * checked last, after the head lookup, because that lookup is where a stalled
 * worker outlives its lease.
 */
type RerunGate = () => Promise<RestoreSuspensionResult | null>;

/**
 * Proves the lease is still this worker's at the very moment before a rerun
 * leaves it, after the final run lookup that the gate cannot cover. Lease
 * loss surfaces as {@link SuspensionLeaseLostError}.
 */
type AssertOwned = () => Promise<void>;

interface RestartPassResult {
    /** Whether the record has to be written before the next wait. */
    progressed: boolean;
    /** Set when the pass was stopped before one of its reruns; nothing was rerun from then on. */
    stopped: RestoreSuspensionResult | null;
}

/** Writes the runs as they are now at the generation last read; false once the row moved on without this worker. */
type PersistRuns = () => Promise<boolean>;

/**
 * One pass over everything still owed a restart.
 *
 * Run discovery and every per-run lookup are awaited GitHub calls: while they
 * are outstanding the lease can expire and be taken over, and the implementation
 * can publish a replacement commit. Neither the lease nor the head is therefore
 * trusted across them — the gate re-proves both immediately before every rerun,
 * so a stale worker never reruns what a newer owner now handles and an obsolete
 * revision is never restarted once its replacement is published. The listing
 * is not trusted across them either: it only says which workflows already have
 * a replacement run, while each run's own attempt and status are read again
 * when its turn comes, after everything the runs before it waited on.
 *
 * A rerun is only sent for an obligation whose attempt is on record. An
 * obligation whose cancellation was never confirmed has none, so the attempt
 * the run is cancelled on now is written first, with the generation-checked
 * write, and the rerun waits for that write to land. Otherwise a rerun GitHub
 * accepted, followed by a crash before the restart is recorded, leaves a
 * record that cannot tell the restarted attempt from the cancelled one: were
 * that new attempt later cancelled by somebody else, recovery would rerun it
 * again on their behalf. With the attempt on record, its advancement is the
 * proof that the obligation was met.
 *
 * That write and the gate are awaited calls as well, and the lease keeps only
 * other ProPR workers out, not the people at GitHub. An operator who reruns
 * the cancelled attempt while either is outstanding, and cancels the attempt
 * they started, has met the obligation and then stopped their own work; a
 * rerun sent on the assessment from before would restart it on their behalf.
 * The run is therefore read once more after the gate, immediately before the
 * rerun leaves the worker, and the rerun is sent only while the run is still
 * cancelled on the very attempt on record: an attempt past it settles the
 * obligation, anything else waits for the next pass to assess it afresh.
 *
 * That final read is an awaited GitHub call too, and a worker stalled inside
 * it can outlive its lease: the worker that took the lease over meanwhile may
 * have restored the very attempt the captured response still shows cancelled,
 * and dropped the suspension. The rerun is the last external effect of this
 * pass and leaves only on a lease proven this worker's after that very last
 * read; a resumed heartbeat alone would only note the loss, and the record
 * would show it gone only once the duplicate rerun had already left.
 */
async function restartPass(
    runs: CancelledRun[],
    context: {
        target: SuspensionTarget; octokit: CiSuspensionOctokit; headSha: string; restartedRunIds: number[];
        persist: PersistRuns; assertOwned: AssertOwned;
    },
    gate: RerunGate,
): Promise<RestartPassResult> {
    const { target, octokit, headSha, restartedRunIds, persist, assertOwned } = context;
    // Re-read the live runs of the captured head on every pass so validation
    // GitHub already restarted is never duplicated. Only a run that validates
    // *this* pull request head on the pull request's own event counts as that
    // replacement: an unrelated push or another pull request's run of the same
    // commit never settles the obligation to restart what ProPR cancelled.
    // Neither does a run ProPR cancelled itself: GitHub lands a cancellation
    // asynchronously, so the listing can still show such a run in progress
    // while the run's own read moments later returns it cancelled, and the
    // obligation would be dropped on nothing. A rerun of one of those runs is
    // recognised by its attempt advancing, never through the listing.
    const recordedRunIds = new Set(runs.map(run => run.id));
    const activeWorkflowIds = new Set((await listRunsForSha(octokit, target, headSha))
        .filter(run => !recordedRunIds.has(run.id))
        .filter(run => isReplacementValidationRun(run, { pullRequestNumber: target.pullRequestNumber, headSha }))
        .map(run => run.workflow_id)
        .filter((id): id is number => typeof id === 'number'));
    let progressed = false;
    for (const run of runs.filter(candidate => !candidate.restarted)) {
        const decision = await assessCancelledRun(run, { target, octokit, activeWorkflowIds });
        if (decision === 'pending') continue;
        if (decision !== 'settled') {
            if (run.attempt === undefined && typeof decision.rerun.cancelledAttempt === 'number') {
                // Durable before the rerun leaves the worker; the write also proves
                // this pass still owns the row, and stops it when it does not.
                run.attempt = decision.rerun.cancelledAttempt;
                if (!await persist()) return { progressed, stopped: { reason: 'superseded', restartedRunIds, pendingRunIds: [] } };
            }
            const stopped = await gate();
            if (stopped) return { progressed, stopped };
            // The write and the gate took time; the run is proven once more to
            // be still owed this rerun, on the attempt the record now names.
            const owed = await stillOwedRerun(run, { target, octokit });
            if (owed === 'pending') continue;
            if (owed === 'rerun') {
                // That read took time as well, and a worker stalled inside it may
                // have outlived its lease: whoever took it over may have restored
                // this very attempt already. The rerun leaves only on a lease
                // proven this worker's after the very last read.
                await assertOwned();
                // A rejected or lost rerun only settles the obligation once the run
                // proves its cancelled attempt was restarted; otherwise it stays owed.
                const outcome = await rerunRun(octokit, target, run.id, { attempt: run.attempt });
                if (outcome === 'unconfirmed') continue;
                if (outcome === 'restarted') restartedRunIds.push(run.id);
            }
        }
        run.restarted = true;
        progressed = true;
    }
    return { progressed, stopped: null };
}

/**
 * Whether the run, as it is right now, is still owed the rerun a pass is about
 * to send: completed, cancelled, and not past the attempt on record. A run
 * that moved past that attempt or produced its own result needs no rerun, so
 * its obligation is settled; a run that is not completed any more is left to
 * the next pass, which reads it afresh before deciding anything. So is a run
 * that cannot be read: its 404 may be the installation's lost access to the
 * repository rather than a deleted run, and the run is still owed its rerun
 * when access returns (see {@link assessCancelledRun}).
 */
async function stillOwedRerun(
    run: CancelledRun,
    context: { target: SuspensionTarget; octokit: CiSuspensionOctokit },
): Promise<'pending' | 'settled' | 'rerun'> {
    const liveRun = await getRun(context.octokit, context.target, run.id);
    if (!liveRun) return 'pending';
    if (attemptAdvanced(run, liveRun)) return 'settled';
    if ((liveRun.status ?? '').toLowerCase() !== 'completed') return 'pending';
    if ((liveRun.conclusion ?? '').toLowerCase() !== 'cancelled') return 'settled';
    return 'rerun';
}

/**
 * Drops the obligation when the head it was taken on is gone: a closed pull
 * request or a published replacement commit means the cancelled revision is
 * obsolete and must never be restarted. Returns null while the head is current.
 *
 * Only a confirmed state drops anything. A pull request that cannot be read —
 * a private repository the installation lost access to answers 404 — is not
 * closed, and its head may well be unchanged; the obligation stays recorded and
 * the next reconciliation asks again.
 */
async function releaseObsoleteHead(
    context: { record: CiSuspensionRecord; octokit: CiSuspensionOctokit; restartedRunIds: number[]; pendingRunIds: number[] },
    deps: CiSuspensionDeps,
): Promise<RestoreSuspensionResult | null> {
    const { record, octokit, restartedRunIds, pendingRunIds } = context;
    const live = await getPullRequestHead(octokit, targetOf(record));
    if (!live) {
        logHeadUnavailable(record, deps);
        return { reason: 'head_unavailable', restartedRunIds, pendingRunIds };
    }
    if (!live.open) {
        await deleteSuspension(deps, record);
        return { reason: 'pull_request_closed', restartedRunIds, pendingRunIds };
    }
    if (sameSha(live.sha, record.head_sha)) return null;
    await deleteSuspension(deps, record);
    resolveLog(deps).info({ repository: record.repository, pullRequest: record.pull_request, headSha: live.sha },
        'Released follow-up CI suspension without restarting the rest: the cancelled revision is obsolete');
    return { reason: 'head_replaced', restartedRunIds, pendingRunIds };
}

/**
 * Brings the cancelled validation back for a head that is still current.
 * Cancellation is asynchronous and the rerun API requires a completed run, so
 * runs that are still finishing stay recorded and are retried by reconciliation.
 */
export async function restoreFollowupCiSuspension(
    record: CiSuspensionRecord,
    deps: CiSuspensionDeps = {},
): Promise<RestoreSuspensionResult> {
    try {
        return await withSuspensionLease(deps, suspensionKey(record), lease => restoreSuspension(record, deps, lease));
    } catch (error) {
        // Either another worker holds the lease, or this one waited for a
        // cancellation long enough to lose it. Both leave the obligation
        // recorded for whoever holds the lease next.
        if (!(error instanceof SuspensionLeaseUnavailableError) && !(error instanceof SuspensionLeaseLostError)) throw error;
        resolveLog(deps).info({ repository: record.repository, pullRequest: record.pull_request, error: (error as Error).message },
            'Another worker holds this pull request suspension; its restart continues on the next reconciliation');
        return { reason: 'busy', restartedRunIds: [], pendingRunIds: parseCancelledRuns(record).filter(run => !run.restarted).map(run => run.id) };
    }
}

const SUPERSEDED: RestoreSuspensionResult = { reason: 'superseded', restartedRunIds: [], pendingRunIds: [] };

async function restoreSuspension(
    record: CiSuspensionRecord,
    deps: CiSuspensionDeps,
    lease?: { assertHeld: () => Promise<void> },
): Promise<RestoreSuspensionResult> {
    const log = resolveLog(deps);
    // Work from the row as it is now: what the caller was handed may already
    // belong to a newer implementation of the same pull request.
    const loaded = await loadSuspension(deps, record);
    if (!loaded || loaded.incarnation !== record.incarnation || loaded.task_id !== record.task_id || !sameSha(loaded.head_sha, record.head_sha)) return SUPERSEDED;
    let current = loaded;
    // A refused attempt never reached GitHub, so it must not consume the budget
    // of attempts that eventually gives up on a run that keeps finishing.
    const attemptsBeforeRestore = loaded.attempts;
    const target = targetOf(current);
    const octokit = await resolveOctokit(deps);
    const attempts = current.attempts + 1;
    const restartedRunIds: number[] = [];
    const runs = parseCancelledRuns(current);
    const pendingRunIds = () => runs.filter(run => !run.restarted).map(run => run.id);

    const obsolete = await releaseObsoleteHead({ record: current, octokit, restartedRunIds, pendingRunIds: pendingRunIds() }, deps);
    if (obsolete) return obsolete;

    if (current.state !== SUSPENSION_RESTORING) {
        // One-way transition, persisted before the first rerun: from here on a
        // sweep leaves this suspension alone instead of re-cancelling what is
        // being restarted, and a crash resumes restoration rather than suppression.
        const restoring = await saveCancelledRuns(deps, current, runs, { state: SUSPENSION_RESTORING, attempts });
        if (!restoring) return SUPERSEDED;
        current = restoring;
    }

    // Proven again before every rerun and after every wait: first that the lease
    // is still this worker's, so a restart somebody else took over is never
    // duplicated from here, then that the head is still current, so an obsolete
    // revision is never restarted once its replacement is published. The head
    // lookup is itself an awaited GitHub call, during which the lease can expire
    // and be taken over; an unchanged head therefore proves nothing about
    // ownership, and the lease is asserted once more after the lookup returns,
    // immediately before the rerun leaves the worker.
    const gate: RerunGate = async () => {
        await lease?.assertHeld();
        const stopped = await releaseObsoleteHead({ record: current, octokit, restartedRunIds, pendingRunIds: pendingRunIds() }, deps);
        if (stopped) return stopped;
        await lease?.assertHeld();
        return null;
    };
    // The gate's proof is itself followed by one more awaited read of the run;
    // this is what the pass asserts after that read, immediately before the
    // rerun leaves the worker.
    const assertOwned: AssertOwned = async () => { await lease?.assertHeld(); };
    // Every write of the runs goes through here, so the worker always continues
    // on the generation it just produced.
    const persist: PersistRuns = async () => {
        const saved = await saveCancelledRuns(deps, current, runs, { state: SUSPENSION_RESTORING, attempts });
        if (!saved) return false;
        current = saved;
        return true;
    };
    // Writes what a pass settled before the next wait; false once the row moved
    // on without this worker. A pass the gate stopped on a released head has no
    // row left to write, one stopped on an unreadable head keeps its progress.
    const saveProgress = async (pass: RestartPassResult): Promise<boolean> => {
        if (!pass.progressed || (pass.stopped && !RETAINED_RESTORE_REASONS.has(pass.stopped.reason))) return true;
        return persist();
    };

    const deadline = nowMs(deps) + (deps.restoreBudgetMs ?? DEFAULT_RESTORE_BUDGET_MS);
    try {
        for (;;) {
            const pass = await restartPass(runs, { target, octokit, headSha: current.head_sha, restartedRunIds, persist, assertOwned }, gate);
            if (!await saveProgress(pass)) return { ...SUPERSEDED, restartedRunIds };
            if (pass.stopped) return pass.stopped;
            const pending = runs.filter(run => !run.restarted);
            if (pending.length === 0) {
                await deleteSuspension(deps, current);
                if (restartedRunIds.length > 0) {
                    log.info({ repository: current.repository, pullRequest: current.pull_request, headSha: current.head_sha, restartedRunIds },
                        'Restarted the pull request validation that the follow-up implementation had cancelled');
                }
                return { reason: 'restarted', restartedRunIds, pendingRunIds: [] };
            }
            if (nowMs(deps) >= deadline) {
                return await deferRestore({ record: current, runs, pending, restartedRunIds, attempts }, deps);
            }
            await delay(deps, deps.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS);
            // Waiting is where a lease expires and where a replacement gets
            // published; neither is waited on any further.
            const stopped = await gate();
            if (stopped) return stopped;
        }
    } catch (error) {
        if (!(error instanceof CiActionsPermissionError)) {
            const saved = await saveCancelledRuns(deps, current, runs, { state: SUSPENSION_RESTORING, attempts }).catch(() => null);
            if (saved) current = saved;
            throw error;
        }
        return await blockRestore(
            { record: current, runs, restartedRunIds, attempts: attemptsBeforeRestore, error }, deps);
    }
}

/**
 * Keeps the obligation alive when GitHub refuses the rerun. A refusal can be
 * temporary and Actions access can be granted back, so everything ProPR
 * cancelled stays recorded in the durable blocked state that every later
 * reconciliation retries: only a confirmed restart, a closed pull request or a
 * replaced head may clear it. Dropping the record here would leave the current
 * head's checks cancelled with nothing left to restore them.
 */
async function blockRestore(
    params: { record: CiSuspensionRecord; runs: CancelledRun[]; restartedRunIds: number[]; attempts: number; error: Error },
    deps: CiSuspensionDeps,
): Promise<RestoreSuspensionResult> {
    const { record, runs, restartedRunIds, attempts, error } = params;
    const pendingRunIds = runs.filter(run => !run.restarted).map(run => run.id);
    const retained = await saveCancelledRuns(deps, record, runs, { state: SUSPENSION_BLOCKED, attempts }).catch(() => null);
    resolveLog(deps).error(
        {
            repository: record.repository, pullRequest: record.pull_request, headSha: record.head_sha,
            pendingRunIds, error: error.message, retained: retained !== null,
        },
        'Cannot restart cancelled pull request validation: the GitHub App needs Actions "Read and write" access. '
        + 'The cancelled runs stay recorded and every reconciliation retries them until access is restored or the head is replaced');
    return { reason: 'permission_denied', restartedRunIds, pendingRunIds };
}

/**
 * Hands the unfinished part of a restart to the next reconciliation pass.
 *
 * The attempt budget decides how loudly that is reported, never whether the
 * obligation survives: these runs were cancelled for a head that is still
 * current, so only a confirmed restart, a closed pull request or a published
 * replacement may clear them. Past the budget the record stops being retried at
 * the normal pace and waits in the durable blocked state instead, which every
 * later reconciliation still retries — dropping it there would leave the current
 * head's checks cancelled with nothing left to bring them back.
 */
async function deferRestore(
    params: { record: CiSuspensionRecord; runs: CancelledRun[]; pending: CancelledRun[]; restartedRunIds: number[]; attempts: number },
    deps: CiSuspensionDeps,
): Promise<RestoreSuspensionResult> {
    const { record, runs, pending, restartedRunIds, attempts } = params;
    const log = resolveLog(deps);
    const pendingRunIds = pending.map(run => run.id);
    const budgetSpent = attempts >= MAX_RESTORE_ATTEMPTS;
    const state = budgetSpent ? SUSPENSION_BLOCKED : SUSPENSION_RESTORING;
    const retained = await saveCancelledRuns(deps, record, runs, { state, attempts });
    if (budgetSpent) {
        log.error({ repository: record.repository, pullRequest: record.pull_request, pendingRunIds, attempts, retained: retained !== null },
            'Cannot restart cancelled pull request validation after repeated attempts. The cancelled runs stay recorded '
            + 'and every reconciliation retries them until validation is restored or the cancelled head becomes obsolete');
    } else {
        log.info({ repository: record.repository, pullRequest: record.pull_request, pendingRunIds, restartedRunIds },
            'Cancelled pull request validation is still finishing; restart continues on the next reconciliation');
    }
    return { reason: budgetSpent ? 'blocked' : 'pending', restartedRunIds, pendingRunIds };
}

/**
 * Ends every suspension this task owns. Called when implementation finished,
 * failed or was cancelled; a published replacement keeps its own CI, anything
 * else gets the cancelled validation of the still-current head back.
 */
export async function releaseFollowupCiSuspensionsForTask(
    params: { taskId: string },
    deps: CiSuspensionDeps = {},
): Promise<RestoreSuspensionResult[]> {
    const log = resolveLog(deps);
    const records = await loadSuspensions(deps, { taskId: params.taskId });
    const results: RestoreSuspensionResult[] = [];
    for (const record of records) {
        try {
            results.push(await restoreFollowupCiSuspension(record, deps));
        } catch (error) {
            log.warn({ repository: record.repository, pullRequest: record.pull_request, error: (error as Error).message },
                'Failed to release the follow-up CI suspension; reconciliation will retry it');
        }
    }
    return results;
}

export interface CiSuspensionReconciliationSummary {
    scanned: number;
    swept: number;
    restored: number;
    released: number;
    errors: number;
}

async function isOwnerActive(record: CiSuspensionRecord, deps: CiSuspensionDeps): Promise<boolean> {
    const getTaskState = deps.getTaskState ?? (async (taskId: string) => getStateManager().getTaskState(taskId));
    try {
        const state = await getTaskState(record.task_id);
        // A task whose state is gone cannot be implementing any more.
        return !!state && !TERMINAL_TASK_STATES.has(state.state);
    } catch {
        // An unreadable task state must not keep CI suppressed; treat it as finished.
        return false;
    }
}

/** True while the owning implementation may still publish a replacement commit. */
async function keepsSuppressing(record: CiSuspensionRecord, deps: CiSuspensionDeps, enabled: boolean): Promise<boolean> {
    if (!enabled || record.state !== SUSPENSION_ACTIVE) return false;
    if (nowMs(deps) - Number(record.created_at) >= MAX_SUSPENSION_AGE_MS) {
        resolveLog(deps).warn({ repository: record.repository, pullRequest: record.pull_request, taskId: record.task_id },
            'Releasing follow-up CI suspension that outlived its maximum lifetime');
        return false;
    }
    return isOwnerActive(record, deps);
}

/**
 * Periodic owner of every suspension that outlived its task: it sweeps late runs
 * while implementation is in progress, releases suspensions whose repository
 * option was switched off, and restarts validation after a worker crash.
 */
export async function reconcileFollowupCiSuspensions(
    deps: CiSuspensionDeps = {},
): Promise<CiSuspensionReconciliationSummary> {
    const log = resolveLog(deps);
    const summary: CiSuspensionReconciliationSummary = { scanned: 0, swept: 0, restored: 0, released: 0, errors: 0 };
    const records = await loadSuspensions(deps);
    if (records.length === 0) return summary;
    const isEnabled = deps.isEnabled ?? isCancelCiDuringFollowupEnabledForRepository;
    for (const record of records) {
        summary.scanned += 1;
        const { owner, repo } = splitRepository(record.repository);
        try {
            const enabled = await isEnabled(owner, repo);
            if (!enabled) {
                // Disabling the option mid-task must give the pull request its CI back.
                log.info({ repository: record.repository, pullRequest: record.pull_request },
                    'Releasing follow-up CI suspension: the repository option is disabled');
            }
            if (await keepsSuppressing(record, deps, enabled)) {
                const swept = await sweepFollowupCiSuspension(record, deps);
                if (swept.reason === 'swept') summary.swept += 1;
                else if (!['superseded', 'busy', 'head_unavailable'].includes(swept.reason)) summary.released += 1;
                continue;
            }
            const restored = await restoreFollowupCiSuspension(record, deps);
            // A denied, blocked or undecidable restore released nothing: its obligation is still recorded.
            if (!RETAINED_RESTORE_REASONS.has(restored.reason)) summary.released += 1;
            if (restored.restartedRunIds.length > 0) summary.restored += 1;
        } catch (error) {
            summary.errors += 1;
            log.warn({ repository: record.repository, pullRequest: record.pull_request, error: (error as Error).message },
                'Failed to reconcile a follow-up CI suspension');
        }
    }
    log.debug(summary as unknown as Record<string, unknown>, 'Reconciled follow-up CI suspensions');
    return summary;
}
