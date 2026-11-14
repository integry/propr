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

import type { EpicMergeProgress } from '../../webhook/epicMergeProgress.js';

export type PullRequestStatusState = 'working' | 'needs_attention' | 'ready' | 'none';

/** What is happening on the pull request right now. */
export type PullRequestActivity =
    | 'implementing'
    | 'follow_up'
    | 'review'
    | 'resolving_conflicts'
    | 'ultrafix'
    | 'waiting_for_ci'
    | 'queued'
    /** GitHub is still computing whether the pull request conflicts with its base. */
    | 'checking_mergeability';

/** Why a pull request needs a human. */
export type PullRequestAttentionReason =
    | 'last_run_failed'
    | 'conflict_resolution_failed'
    | 'ultrafix_stopped'
    | 'check_failed'
    | 'merge_conflict'
    | 'review_below_goal'
    | 'checks_unavailable'
    /** Epic: a sub-PR needs a person. */
    | 'epic_child_needs_attention'
    /** Epic: a sub-PR is ready and waits to be merged into the epic branch. */
    | 'epic_child_ready'
    /** Epic: an issue's run stopped on a blocker the agent reported, and waits on a person. */
    | 'epic_issue_blocked'
    /**
     * Epic: no sub-PR or issue read is working, but sub-PRs left unread by the
     * read budget could be, so whether the epic waits on a person is unknown.
     * The status sync does not publish it (isUndeterminedPullRequestStatus).
     */
    | 'epic_children_unread'
    /** Epic: the plan's execution queue is paused. */
    | 'epic_queue_paused'
    /** Epic: issues are left, but nothing runs or is queued to start. */
    | 'epic_idle';

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
    /**
     * A GitHub check read rejected (transport, rate limit): a transient gap the
     * reconciliation retries. Checks left unread by the page budget are
     * incomplete without it, a limit no retry lifts.
     */
    readFailed?: boolean;
    passed: number;
    failed: number;
    pending: number;
    failedNames: string[];
}

/** An open sub-PR of an epic: a pull request into the epic branch. */
export interface EpicChildStatus {
    prNumber: number;
    /** The plan issue the sub-PR implements, when known. */
    issueNumber: number | null;
    title: string | null;
    /** The sub-PR's own status, from this computation; null when it is not a ProPR pull request, or was not read. */
    status: PullRequestStatus | null;
    /** The status was not read in this update nor kept from an earlier one (the read budget): null `status` then says nothing about the sub-PR. */
    statusUnread?: boolean;
}

/** A plan issue of an epic, without a sub-PR. */
export interface EpicIssueRef {
    issueNumber: number;
    title: string | null;
    /** A run is implementing the issue now. */
    working?: boolean;
    /** The issue's run stopped on a blocker the agent reported (the queue's recorded reason): nothing runs until a person acts. */
    blocked?: boolean;
}

/**
 * What an epic pull request's status is computed from. The counts come from
 * the epic merge progress computation (computeEpicMergeProgress).
 */
export interface EpicStatusFacts {
    merged: number;
    total: number;
    /** Open sub-PRs into the epic branch. */
    children?: EpicChildStatus[];
    /** Plan issues that started and have no sub-PR yet. */
    startedIssues?: EpicIssueRef[];
    /** Plan issues that have not started, in queue order. */
    upNext?: EpicIssueRef[];
    /** The plan's queue is about to start its next issue. */
    nextIssueQueued?: boolean;
    queuePaused?: boolean;
    /** The full merge progress, for the epic progress comment. */
    progress?: EpicMergeProgress;
    planName?: string | null;
    /** The epic branch, for the epic progress lease. */
    epicBranch?: string;
    /** Sub-PRs were left unread (the read budget): another update should read them (pullRequestStatusEpicChildReads). */
    continueChildReads?: boolean;
}

/** What the status block says an epic is doing or waits on. */
export interface EpicStatusFocus {
    prNumber: number | null;
    issueNumber: number | null;
    /** The sub-PR's status when the focus is a sub-PR. */
    status: PullRequestStatus | null;
}

export interface EpicStatusDetail {
    merged: number;
    total: number;
    focus?: EpicStatusFocus | null;
    /** Open sub-PRs whose status was not read (the read budget), for `epic_children_unread`. */
    unreadChildren?: number;
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
    /** Present for an epic pull request ProPR recorded for its plan. */
    epic: EpicStatusFacts | null;
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
    epic: EpicStatusDetail | null;
}

export interface PullRequestStatus {
    state: PullRequestStatusState;
    detail: PullRequestStatusDetail;
}

/** Task states after which a task no longer runs; every other state is active. */
export const TERMINAL_TASK_STATES: readonly string[] = ['completed', 'failed', 'cancelled'];
const TERMINAL_STATES = new Set(TERMINAL_TASK_STATES);

export function isActiveTaskState(state: string): boolean {
    return !TERMINAL_STATES.has(state);
}

function taskActivity(task: PullRequestStatusTask): PullRequestActivity {
    if (task.type === 'merge_conflict') return 'resolving_conflicts';
    if (task.type === 'review' || task.mode === 'review') return 'review';
    if (task.type === 'pr-comment') return 'follow_up';
    return 'implementing';
}

/**
 * ProPR work on the pull request: a task running, an active Ultrafix loop or a
 * queued job. Checks still pending are not ProPR work: they hold the status at
 * working only when no confirmed problem needs a person (computePullRequestStatus).
 */
function activeProprWork(facts: PullRequestStatusFacts): PullRequestActivity | null {
    const active = facts.tasks.find(task => isActiveTaskState(task.state));
    if (active) return taskActivity(active);
    if (facts.ultrafix?.active) return facts.ultrafix.waitingForCi || facts.checks.pending > 0 ? 'waiting_for_ci' : 'ultrafix';
    if (facts.queuedJobs > 0) return 'queued';
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

/**
 * A problem that is established whatever the checks still pending conclude:
 * no pending check can undo a failed run or check, a stopped loop, a conflict
 * or a recorded review score.
 */
function confirmedAttentionReason(facts: PullRequestStatusFacts): PullRequestAttentionReason | null {
    const latest = facts.tasks[0];
    if (latest?.state === 'failed') return latest.type === 'merge_conflict' ? 'conflict_resolution_failed' : 'last_run_failed';
    if (stoppedUltrafix(facts)) return 'ultrafix_stopped';
    if (facts.checks.failed > 0) return 'check_failed';
    if (facts.pullRequest.mergeable === false) return 'merge_conflict';
    if (facts.latestReviewScore !== null && facts.latestReviewScore < facts.ratingGoal) return 'review_below_goal';
    return null;
}

function emptyDetail(facts: PullRequestStatusFacts): PullRequestStatusDetail {
    return {
        activity: null, ultrafix: null, ultrafixStopped: null, reviewScore: facts.latestReviewScore, ratingGoal: facts.ratingGoal,
        checks: null, reason: null, failedChecks: [], epic: facts.epic ? { merged: facts.epic.merged, total: facts.epic.total, focus: null } : null,
    };
}

/**
 * Computes the status of a pull request from its facts. `ready` is only ever
 * reported once nothing is running, every blocking check on the current head
 * completed and passed, and GitHub has determined that the PR does not
 * conflict with its base; a review score alone never makes a PR ready.
 */
export function computePullRequestStatus(facts: PullRequestStatusFacts): PullRequestStatus {
    const base = emptyDetail(facts);
    if (facts.pullRequest.state !== 'open' || facts.pullRequest.merged || !facts.isProprPullRequest) {
        return { state: 'none', detail: base };
    }
    if (facts.epic && facts.epic.total > 0) return computeEpicStatus(facts, facts.epic);
    return computeSinglePullRequestStatus(facts, base);
}

function computeSinglePullRequestStatus(facts: PullRequestStatusFacts, base: PullRequestStatusDetail): PullRequestStatus {
    const { passed, failed, pending } = facts.checks;
    const detail: PullRequestStatusDetail = { ...base, checks: { passed, failed, pending }, failedChecks: [...facts.checks.failedNames] };
    const loop = facts.ultrafix;
    if (loop?.active) detail.ultrafix = { cycle: Math.min(loop.cycleCount + 1, Math.max(loop.maxCycles, 1)), maxCycles: loop.maxCycles };

    const activity = activeProprWork(facts);
    if (activity) return { state: 'working', detail: { ...detail, activity } };

    const reason = confirmedAttentionReason(facts);
    if (reason) {
        const stopped = reason === 'ultrafix_stopped' && loop
            ? { cycles: loop.cycleCount, finalScore: loop.finalScore, reason: loop.completionReason }
            : null;
        return { state: 'needs_attention', detail: { ...detail, reason, ultrafixStopped: stopped } };
    }
    // Nothing ProPR runs is left and nothing is known to be wrong: the checks
    // still pending decide, so the PR is neither ready nor needs a person yet.
    if (facts.checks.pending > 0) return { state: 'working', detail: { ...detail, activity: 'waiting_for_ci' } };
    if (!facts.checks.complete) return { state: 'needs_attention', detail: { ...detail, reason: 'checks_unavailable' } };
    // Unknown mergeability has not established that the PR is free of conflicts.
    if (facts.pullRequest.mergeable === null) return { state: 'working', detail: { ...detail, activity: 'checking_mergeability' } };
    return { state: 'ready', detail };
}

function childFocus(child: EpicChildStatus): EpicStatusFocus {
    return { prNumber: child.prNumber, issueNumber: child.issueNumber, status: child.status };
}

function issueFocus(issue: EpicIssueRef | undefined): EpicStatusFocus | null {
    return issue ? { prNumber: null, issueNumber: issue.issueNumber, status: null } : null;
}

/**
 * The status of an epic pull request, whose own branch only receives merges:
 * until every issue is merged it follows its sub-PRs and the plan's queue;
 * once they are, it is ready like any pull request, from its own checks and
 * mergeability. An epic shows no review score.
 */
function computeEpicStatus(facts: PullRequestStatusFacts, epic: EpicStatusFacts): PullRequestStatus {
    const own: PullRequestStatusFacts = { ...facts, latestReviewScore: null };
    const base: PullRequestStatusDetail = { ...emptyDetail(own), epic: { merged: epic.merged, total: epic.total, focus: null } };
    if (epic.merged >= epic.total) return computeSinglePullRequestStatus(own, base);

    const { passed, failed, pending } = facts.checks;
    const detail: PullRequestStatusDetail = { ...base, checks: { passed, failed, pending }, failedChecks: [...facts.checks.failedNames] };
    const children = (epic.children ?? []).filter(child => child.status !== null && child.status.state !== 'none');
    const withFocus = (state: PullRequestStatusState, focus: EpicStatusFocus | null, extra: Partial<PullRequestStatusDetail>): PullRequestStatus =>
        ({ state, detail: { ...detail, ...extra, epic: { merged: epic.merged, total: epic.total, focus } } });

    const workingChild = children.find(child => child.status?.state === 'working');
    if (workingChild) return withFocus('working', childFocus(workingChild), { activity: workingChild.status!.detail.activity });
    // A blocked issue's run has stopped, whatever its persisted status says.
    const workingIssue = (epic.startedIssues ?? []).find(issue => issue.working && !issue.blocked);
    if (workingIssue) return withFocus('working', issueFocus(workingIssue), { activity: 'implementing' });
    const ownWork = activeProprWork(own);
    if (ownWork) return withFocus('working', null, { activity: ownWork });
    if (epic.nextIssueQueued && !epic.queuePaused) return withFocus('working', issueFocus(epic.upNext?.[0]), { activity: 'queued' });

    // Nothing read is working; a sub-PR whose status was not read may be, so no attention state is established.
    const unreadChildren = (epic.children ?? []).filter(child => child.statusUnread).length;
    if (unreadChildren > 0) {
        return { state: 'needs_attention', detail: { ...detail, reason: 'epic_children_unread', epic: { merged: epic.merged, total: epic.total, focus: null, unreadChildren } } };
    }
    const attention = children.find(child => child.status?.state === 'needs_attention');
    if (attention) return withFocus('needs_attention', childFocus(attention), { reason: 'epic_child_needs_attention' });
    const blockedIssue = (epic.startedIssues ?? []).find(issue => issue.blocked);
    if (blockedIssue) return withFocus('needs_attention', issueFocus(blockedIssue), { reason: 'epic_issue_blocked' });
    const ready = children.find(child => child.status?.state === 'ready');
    if (ready) return withFocus('needs_attention', childFocus(ready), { reason: 'epic_child_ready' });
    if (epic.queuePaused) return withFocus('needs_attention', null, { reason: 'epic_queue_paused' });
    if (facts.pullRequest.mergeable === false) return withFocus('needs_attention', null, { reason: 'merge_conflict' });
    return withFocus('needs_attention', null, { reason: 'epic_idle' });
}

/**
 * The status could not be determined from the facts read (an epic whose
 * unread sub-PRs may be working): surfaces that keep a published status leave
 * it as it is rather than replace it with this one.
 */
export function isUndeterminedPullRequestStatus(status: PullRequestStatus | null): boolean {
    return status?.detail.reason === 'epic_children_unread';
}
