/**
 * The one status of a ProPR pull request: whether it is being worked on,
 * needs a human, or is ready to merge. Every surface (the PR body block, the
 * MCP pull request tools, the work overview) reads this computation; do not
 * add a second derivation.
 *
 * `computePullRequestStatus` is pure: it decides from facts gathered by
 * `loadPullRequestStatusFacts`, so each rule can be tested without GitHub,
 * Redis or a database.
 */

export type PullRequestStatusState = 'working' | 'needs_attention' | 'ready' | 'none';

/** What is happening on the pull request right now. */
export type PullRequestActivity =
    | 'implementing'
    | 'follow_up'
    | 'review'
    | 'resolving_conflicts'
    | 'ultrafix'
    | 'waiting_for_ci'
    | 'queued';

/** Why a pull request needs a human. */
export type PullRequestAttentionReason =
    | 'last_run_failed'
    | 'conflict_resolution_failed'
    | 'ultrafix_stopped'
    | 'check_failed'
    | 'merge_conflict'
    | 'review_below_goal'
    | 'checks_unavailable';

/** A ProPR task recorded for the pull request. */
export interface PullRequestStatusTask {
    /** `issue`, `pr-comment`, `review`, `merge_conflict`, … */
    type: string;
    /** For `pr-comment` tasks: whether the run is a `/review` or a follow-up. */
    mode: 'review' | 'follow_up' | null;
    /** Latest task state (`pending`, `processing`, …, `completed`, `failed`, `cancelled`). */
    state: string;
    createdAt: string;
}

export interface PullRequestStatusUltrafix {
    active: boolean;
    /** Completed fix cycles. */
    cycleCount: number;
    maxCycles: number;
    goal: number;
    /** `failed` means the loop ended without reaching its goal. */
    completionStatus: 'succeeded' | 'failed' | null;
    completionReason: string | null;
    finalScore: number | null;
    completedAt: string | null;
    /** The loop holds its next step back until checks on the head settle. */
    waitingForCi: boolean;
}

export interface PullRequestStatusChecks {
    /** False when GitHub could not be read completely, so a pass cannot be asserted. */
    complete: boolean;
    passed: number;
    failed: number;
    pending: number;
    failedNames: string[];
}

export interface PullRequestStatusFacts {
    pullRequest: {
        state: string;
        merged: boolean;
        headSha: string;
        /** GitHub's mergeability; null while GitHub is still computing it. */
        mergeable: boolean | null;
    };
    /** ProPR created the pull request (task, plan issue, goal or epic). */
    isProprPullRequest: boolean;
    /** ProPR tasks for the pull request, newest first. */
    tasks: PullRequestStatusTask[];
    /** BullMQ jobs for the pull request that have not started yet. */
    queuedJobs: number;
    ultrafix: PullRequestStatusUltrafix | null;
    checks: PullRequestStatusChecks;
    /** Latest persisted review score, null when the PR was never reviewed. */
    latestReviewScore: number | null;
    /** Instance Ultrafix rating goal. */
    ratingGoal: number;
    epic: { merged: number; total: number } | null;
}

export interface PullRequestStatusDetail {
    activity: PullRequestActivity | null;
    /** Present while an Ultrafix loop is active. */
    ultrafix: { cycle: number; maxCycles: number } | null;
    /** Present when an Ultrafix loop stopped without reaching its goal. */
    ultrafixStopped: { cycles: number; finalScore: number | null; reason: string | null } | null;
    reviewScore: number | null;
    ratingGoal: number;
    checks: { passed: number; failed: number; pending: number } | null;
    reason: PullRequestAttentionReason | null;
    /** Failed blocking check names, for `check_failed`. */
    failedChecks: string[];
    epic: { merged: number; total: number } | null;
}

export interface PullRequestStatus {
    state: PullRequestStatusState;
    detail: PullRequestStatusDetail;
}

const TERMINAL_STATES = new Set(['completed', 'failed', 'cancelled']);

export function isActiveTaskState(state: string): boolean {
    return !TERMINAL_STATES.has(state);
}

function taskActivity(task: PullRequestStatusTask): PullRequestActivity {
    if (task.type === 'merge_conflict') return 'resolving_conflicts';
    if (task.type === 'review' || task.mode === 'review') return 'review';
    if (task.type === 'pr-comment') return 'follow_up';
    return 'implementing';
}

function currentActivity(facts: PullRequestStatusFacts): PullRequestActivity | null {
    const active = facts.tasks.find(task => isActiveTaskState(task.state));
    if (active) return taskActivity(active);
    if (facts.ultrafix?.active) return facts.ultrafix.waitingForCi || facts.checks.pending > 0 ? 'waiting_for_ci' : 'ultrafix';
    if (facts.queuedJobs > 0) return 'queued';
    if (facts.checks.pending > 0) return 'waiting_for_ci';
    return null;
}

/** The loop ended short of its goal, and no ProPR run started on the PR since. */
function stoppedUltrafix(facts: PullRequestStatusFacts): PullRequestStatusUltrafix | null {
    const loop = facts.ultrafix;
    if (!loop || loop.active || loop.completionStatus !== 'failed') return null;
    const completedAt = Date.parse(loop.completedAt ?? '');
    const newestTask = Date.parse(facts.tasks[0]?.createdAt ?? '');
    if (Number.isFinite(completedAt) && Number.isFinite(newestTask) && newestTask > completedAt) return null;
    return loop;
}

function attentionReason(facts: PullRequestStatusFacts): PullRequestAttentionReason | null {
    const latest = facts.tasks[0];
    if (latest?.state === 'failed') return latest.type === 'merge_conflict' ? 'conflict_resolution_failed' : 'last_run_failed';
    if (stoppedUltrafix(facts)) return 'ultrafix_stopped';
    if (facts.checks.failed > 0) return 'check_failed';
    if (facts.pullRequest.mergeable === false) return 'merge_conflict';
    if (facts.latestReviewScore !== null && facts.latestReviewScore < facts.ratingGoal) return 'review_below_goal';
    if (!facts.checks.complete) return 'checks_unavailable';
    return null;
}

function emptyDetail(facts: PullRequestStatusFacts): PullRequestStatusDetail {
    return {
        activity: null, ultrafix: null, ultrafixStopped: null, reviewScore: facts.latestReviewScore, ratingGoal: facts.ratingGoal,
        checks: null, reason: null, failedChecks: [], epic: facts.epic,
    };
}

/**
 * Computes the status of a pull request from its facts. `ready` is only ever
 * reported once nothing is running and every blocking check on the current
 * head completed and passed; a review score alone never makes a PR ready.
 */
export function computePullRequestStatus(facts: PullRequestStatusFacts): PullRequestStatus {
    const base = emptyDetail(facts);
    if (facts.pullRequest.state !== 'open' || facts.pullRequest.merged || !facts.isProprPullRequest) {
        return { state: 'none', detail: base };
    }
    const { passed, failed, pending } = facts.checks;
    const detail: PullRequestStatusDetail = { ...base, checks: { passed, failed, pending }, failedChecks: [...facts.checks.failedNames] };
    const loop = facts.ultrafix;
    if (loop?.active) detail.ultrafix = { cycle: Math.min(loop.cycleCount + 1, Math.max(loop.maxCycles, 1)), maxCycles: loop.maxCycles };

    const activity = currentActivity(facts);
    if (activity) return { state: 'working', detail: { ...detail, activity } };

    const reason = attentionReason(facts);
    if (reason) {
        const stopped = reason === 'ultrafix_stopped' && loop
            ? { cycles: loop.cycleCount, finalScore: loop.finalScore, reason: loop.completionReason }
            : null;
        return { state: 'needs_attention', detail: { ...detail, reason, ultrafixStopped: stopped } };
    }
    return { state: 'ready', detail };
}
