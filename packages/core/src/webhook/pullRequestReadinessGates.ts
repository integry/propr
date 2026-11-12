/**
 * Pure gate classifiers of the pull request readiness verdict. Each turns facts
 * already read into one gate with a stable reason code; none of them reads or
 * writes anything. {@link evaluatePullRequestReadiness} gathers the facts.
 */
import type { AutoMergeDecision, AutoMergeReason } from '../workflow/autoMergePolicy.js';
import type { CiMergeClassification } from './checkRunHelpers.js';

export type ReadinessGateName =
    | 'open' | 'not_draft' | 'checks' | 'mergeable' | 'human_review' | 'ai_review' | 'ultrafix' | 'active_work' | 'policy';

export type ReadinessGateStatus = 'pass' | 'waiting' | 'fail' | 'unknown' | 'not_applicable';

export type ReadinessVerdict = 'ready' | 'waiting' | 'blocked' | 'merged' | 'closed' | 'unknown';

export interface ReadinessGate {
    gate: ReadinessGateName;
    status: ReadinessGateStatus;
    /** Stable, machine-readable reason code. */
    reason: string;
    /** Human-readable context; never needed to interpret `reason`. */
    detail?: string;
}

export type PullRequestState = 'open' | 'merged' | 'closed';

const gate = (name: ReadinessGateName, status: ReadinessGateStatus, reason: string, detail?: string): ReadinessGate =>
    detail === undefined ? { gate: name, status, reason } : { gate: name, status, reason, detail };

export function openGate(state: PullRequestState): ReadinessGate {
    if (state === 'merged') return gate('open', 'fail', 'pull_request_merged');
    if (state === 'closed') return gate('open', 'fail', 'pull_request_closed');
    return gate('open', 'pass', 'pull_request_open');
}

export function draftGate(draft: boolean): ReadinessGate {
    return draft ? gate('not_draft', 'fail', 'draft') : gate('not_draft', 'pass', 'not_draft');
}

/** Pending blocking checks wait; a failed blocking check fails; unreadable CI is unknown. */
export function checksGate(ci: CiMergeClassification): ReadinessGate {
    switch (ci.reason) {
        case 'checks_passing':
        case 'no_ci':
            return gate('checks', 'pass', ci.reason);
        case 'waiting_for_ci':
            return gate('checks', 'waiting', ci.reason, 'No CI has registered for this head yet.');
        case 'unavailable':
            return gate('checks', 'unknown', ci.reason, 'Check runs or commit statuses could not be read.');
        default: {
            const failed = ci.summary?.blockingFailed ?? [];
            const pending = ci.summary?.blockingPending ?? [];
            if (failed.length > 0) return gate('checks', 'fail', ci.reason, `Failed: ${failed.join(', ')}`);
            return gate('checks', 'waiting', ci.reason, pending.length ? `Pending: ${pending.join(', ')}` : undefined);
        }
    }
}

/**
 * GitHub's mergeability. `blocked` covers required checks and reviews that
 * have not finished as well as rules nothing will satisfy, so it only waits
 * while another gate explains it as waiting.
 */
export function mergeableGate(input: { mergeable: boolean | null; mergeableState: string; othersWaiting: boolean }): ReadinessGate {
    const { mergeable, mergeableState } = input;
    if (mergeableState === 'dirty' || mergeable === false) return gate('mergeable', 'fail', 'merge_conflict');
    if (mergeable === null || mergeableState === 'unknown' || mergeableState === 'draft') {
        return gate('mergeable', 'unknown', 'merge_state_unknown', `GitHub reports mergeable_state ${mergeableState}.`);
    }
    if (mergeableState === 'behind') return gate('mergeable', 'fail', 'branch_behind_base');
    if (mergeableState === 'blocked') {
        return gate('mergeable', input.othersWaiting ? 'waiting' : 'fail', 'branch_protection_blocked');
    }
    return gate('mergeable', 'pass', 'mergeable', `GitHub reports mergeable_state ${mergeableState}.`);
}

export interface HumanReviewFacts {
    /** GitHub's review decision (`APPROVED`, `CHANGES_REQUESTED`, `REVIEW_REQUIRED`), or null when none applies. */
    reviewDecision: string | null;
    /** Logins whose latest review requests changes. */
    changesRequestedBy: string[];
}

export function humanReviewGate(facts: HumanReviewFacts | null): ReadinessGate {
    if (!facts) return gate('human_review', 'unknown', 'review_state_unavailable');
    if (facts.reviewDecision === 'CHANGES_REQUESTED' || facts.changesRequestedBy.length > 0) {
        return gate('human_review', 'fail', 'changes_requested', facts.changesRequestedBy.length ? `By ${facts.changesRequestedBy.join(', ')}` : undefined);
    }
    if (facts.reviewDecision === 'REVIEW_REQUIRED') return gate('human_review', 'waiting', 'review_required');
    return gate('human_review', 'pass', facts.reviewDecision === 'APPROVED' ? 'approved' : 'no_changes_requested');
}

/** One persisted review score row, oldest first, as the score loader projects it. */
export interface ReviewScoreFact {
    task_id: string;
    score: number;
    goal: number | null;
    goal_reached: boolean | number | null;
    blocker_count: number;
    head_sha: string | null;
}

export interface ReviewSummary {
    score: number;
    goal: number;
    goalReached: boolean;
    reviewedHead: string | null;
    matchesCurrentHead: boolean;
}

/**
 * The latest review job's verdict. The newest score is authoritative, as in the
 * Ultrafix loop; an Ultrafix cycle carries the job's own `goal_reached`, and a
 * plain `/review` (no recorded goal) reaches the instance goal when its score
 * meets it and no reviewer of the job reported a blocker.
 */
export function summarizeReview(scores: readonly ReviewScoreFact[], head: string, defaultGoal: number): ReviewSummary | null {
    const latest = scores[scores.length - 1];
    if (!latest) return null;
    const job = scores.filter(score => score.task_id === latest.task_id);
    const goal = latest.goal ?? defaultGoal;
    const goalReached = latest.goal_reached === null || latest.goal_reached === undefined
        ? latest.score >= goal && job.every(score => score.blocker_count === 0)
        : Boolean(latest.goal_reached);
    return { score: latest.score, goal, goalReached, reviewedHead: latest.head_sha, matchesCurrentHead: latest.head_sha === head };
}

/** Never blocks a PR ProPR is not reviewing: no score and no `ultrafix` label is not applicable. */
export function aiReviewGate(input: { review: ReviewSummary | null; scoresUnavailable: boolean; ultrafixLabel: boolean }): ReadinessGate {
    const { review } = input;
    if (input.scoresUnavailable) return gate('ai_review', 'unknown', 'review_scores_unavailable');
    if (!review) return gate('ai_review', input.ultrafixLabel ? 'waiting' : 'not_applicable', 'no_review');
    const scored = `Score ${review.score}/10, goal ${review.goal}.`;
    if (!review.matchesCurrentHead) return gate('ai_review', 'waiting', 'review_stale_head', `Reviewed ${review.reviewedHead ?? 'an unrecorded head'}. ${scored}`);
    if (!review.goalReached) return gate('ai_review', 'fail', 'score_below_goal', scored);
    return gate('ai_review', 'pass', 'goal_reached', scored);
}

export interface UltrafixFacts {
    labelPresent: boolean;
    /** The loop state; null when none is recorded, `unavailable` when it could not be read. */
    state: { active: boolean; completionStatus: 'succeeded' | 'failed' | null; unavailable?: boolean } | null;
}

export function ultrafixGate({ labelPresent, state }: UltrafixFacts): ReadinessGate {
    if (state?.unavailable) return gate('ultrafix', 'unknown', 'ultrafix_state_unavailable');
    if (state?.active) return gate('ultrafix', 'waiting', 'ultrafix_active');
    if (state?.completionStatus === 'failed') return gate('ultrafix', 'fail', 'ultrafix_failed');
    if (state?.completionStatus === 'succeeded') return gate('ultrafix', 'pass', 'ultrafix_succeeded');
    if (labelPresent) return gate('ultrafix', 'waiting', 'ultrafix_pending', 'The ultrafix label is present but no loop has completed.');
    return gate('ultrafix', 'not_applicable', 'ultrafix_not_requested');
}

export function activeWorkGate(work: { activeTasks: unknown[]; queuedJobs: unknown[] } | null): ReadinessGate {
    if (!work) return gate('active_work', 'unknown', 'active_work_unavailable');
    const count = work.activeTasks.length + work.queuedJobs.length;
    if (count > 0) return gate('active_work', 'waiting', 'propr_work_active', `${work.activeTasks.length} active task(s), ${work.queuedJobs.length} queued job(s).`);
    return gate('active_work', 'pass', 'no_active_work');
}

const UNREADABLE_POLICY_REASONS: ReadonlySet<AutoMergeReason> = new Set(['skipped_diff_unavailable', 'skipped_policy_invalid']);

/**
 * `decision` is null when auto-merge is not requested; the policy is then not read at all.
 * `request_unavailable`: no direct label and the linked issue could not be read, so whether the
 * policy applies is unknown. `head_changed`: the policy was evaluated on another head or base
 * than the one this verdict reports, so its decision says nothing about that snapshot.
 */
export function policyGate(
    decision: Pick<AutoMergeDecision, 'arm' | 'reason' | 'detail' | 'matchedPaths'> | 'request_unavailable' | 'head_changed' | null,
): ReadinessGate {
    if (!decision) return gate('policy', 'not_applicable', 'auto_merge_not_requested');
    if (decision === 'request_unavailable') {
        return gate('policy', 'unknown', 'auto_merge_request_unavailable', 'The linked issue could not be read to tell whether auto-merge is requested.');
    }
    if (decision === 'head_changed') {
        return gate('policy', 'unknown', 'pull_request_changed', 'The head or base changed while the auto-merge policy was evaluated.');
    }
    if (decision.arm) return gate('policy', 'pass', decision.reason);
    const detail = decision.matchedPaths?.length ? `Protected paths: ${decision.matchedPaths.join(', ')}` : decision.detail;
    return gate('policy', UNREADABLE_POLICY_REASONS.has(decision.reason) ? 'unknown' : 'fail', decision.reason, detail);
}

/** `merged`/`closed` from the PR state; otherwise the worst gate status wins. */
export function decideVerdict(state: PullRequestState, gates: readonly ReadinessGate[]): ReadinessVerdict {
    if (state === 'merged' || state === 'closed') return state;
    const has = (status: ReadinessGateStatus) => gates.some(item => item.status === status);
    if (has('fail')) return 'blocked';
    if (has('waiting')) return 'waiting';
    if (has('unknown')) return 'unknown';
    return 'ready';
}
