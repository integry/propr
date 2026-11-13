/**
 * Outcomes of one auto-merge evaluation, so the auto-merge sweep can tell an
 * evaluation that resolved a `require_up_to_date` retry from one that could not
 * decide. A deferred candidate may get no further event, so the sweep keeps its
 * retry entry unless the evaluation resolved it.
 */
import type logger from '../utils/logger.js';
import { isEpicBranch } from '../services/taskExecutionService.js';
import type { AutoMergeDecision } from '../workflow/autoMergePolicy.js';
import { readLinkedIssueAutoMergeLabel, type PRAutoMergeInfo } from './checkRunHelpers.js';

/**
 * `resolved`: the PR merged, is no longer open, is a draft, is no longer an
 * auto-merge candidate (label removed, Ultrafix failed), or the policy left it
 * to a human. `inconclusive`: anything else held the merge back, so the PR
 * stays in the sweep's retry set. That includes every CI and mergeability
 * refusal, not only transient ones (a read that failed, CI not yet registered or
 * still running, unknown mergeability, active work, a refused or failed merge, a
 * deferral). Failed checks, conflicts or a blocked merge wait on a re-run, a new
 * head or a review, and the event that produces (if any) may meet a transient
 * refusal that no further event follows; only the retry entry then recovers the PR.
 */
export type AutoMergeEvaluationOutcome = 'resolved' | 'inconclusive';

/** `transient`: the labels or Ultrafix state could not be read, or Ultrafix is still working on the PR. */
export type AutoMergeEligibility = 'eligible' | 'ineligible' | 'transient';

export interface AutoMergeEligibilityContext {
    owner: string;
    repoName: string;
    prNumber: number;
    prInfo: PRAutoMergeInfo;
    log: ReturnType<typeof logger.withCorrelation>;
    /** Linked-issue label reader; defaults to {@link readLinkedIssueAutoMergeLabel} with the App identity. */
    readLinkedIssueLabel?: (owner: string, repoName: string, prNumber: number) => Promise<boolean | null>;
}

/**
 * Why {@link evaluateAutoMergeEligibilityWithReason} decided as it did.
 * Eligible: `pr_label` (the PR, epic or not, carries `auto-merge`) or
 * `linked_issue_label`. Ineligible: `ultrafix_failed`, `ultrafix_not_succeeded`
 * (the `ultrafix` label remains without a successful completion),
 * `epic_without_label` or `no_auto_merge_label`. Transient: `ultrafix_active`,
 * `ultrafix_state_unavailable` or `linked_issue_unavailable`.
 */
export type AutoMergeEligibilityReason =
    | 'pr_label'
    | 'linked_issue_label'
    | 'ultrafix_active'
    | 'ultrafix_failed'
    | 'ultrafix_state_unavailable'
    | 'ultrafix_not_succeeded'
    | 'epic_without_label'
    | 'linked_issue_unavailable'
    | 'no_auto_merge_label';

export interface AutoMergeEligibilityResult {
    eligibility: AutoMergeEligibility;
    reason: AutoMergeEligibilityReason;
}

/**
 * Whether the PR's labels and Ultrafix state make it an auto-merge candidate.
 */
export async function evaluateAutoMergeEligibility(ctx: AutoMergeEligibilityContext): Promise<AutoMergeEligibility> {
    return (await evaluateAutoMergeEligibilityWithReason(ctx)).eligibility;
}

/** {@link evaluateAutoMergeEligibility} together with the reason code of its decision. */
export async function evaluateAutoMergeEligibilityWithReason(ctx: AutoMergeEligibilityContext): Promise<AutoMergeEligibilityResult> {
    const { owner, repoName, prNumber, prInfo, log } = ctx;
    const result = (eligibility: AutoMergeEligibility, reason: AutoMergeEligibilityReason): AutoMergeEligibilityResult => ({ eligibility, reason });

    if (prInfo.hasActiveUltrafixLoop) {
        log.info({ owner, repoName, prNumber }, 'PR has an active ultrafix loop, skipping auto-merge');
        return result('transient', 'ultrafix_active');
    }

    if (prInfo.ultrafixCompletionStatus === 'failed') {
        log.info({ owner, repoName, prNumber }, 'PR has a failed ultrafix loop, keeping auto-merge blocked');
        return result('ineligible', 'ultrafix_failed');
    }

    if (prInfo.hasUltrafixLabel && prInfo.ultrafixStateUnavailable) {
        log.warn(
            { owner, repoName, prNumber },
            'Ultrafix state is unavailable while ultrafix label is present, keeping auto-merge blocked'
        );
        return result('transient', 'ultrafix_state_unavailable');
    }

    if (prInfo.hasUltrafixLabel && prInfo.ultrafixCompletionStatus !== 'succeeded') {
        log.info(
            { owner, repoName, prNumber, ultrafixCompletionStatus: prInfo.ultrafixCompletionStatus },
            'Ultrafix label remains without a successful completion state, keeping auto-merge blocked'
        );
        return result('ineligible', 'ultrafix_not_succeeded');
    }

    if (isEpicBranch(prInfo.headBranch)) {
        if (!prInfo.hasLabel) {
            log.debug({ owner, repoName, prNumber, headBranch: prInfo.headBranch }, 'Epic PR does not have auto-merge label, skipping merge');
            return result('ineligible', 'epic_without_label');
        }
        return result('eligible', 'pr_label');
    }

    if (prInfo.hasLabel) return result('eligible', 'pr_label');
    const issueHasLabel = await (ctx.readLinkedIssueLabel ?? readLinkedIssueAutoMergeLabel)(owner, repoName, prNumber);
    if (issueHasLabel === true) return result('eligible', 'linked_issue_label');
    if (issueHasLabel === null) {
        log.debug({ owner, repoName, prNumber }, 'Linked issue labels are unavailable, skipping auto-merge for now');
        return result('transient', 'linked_issue_unavailable');
    }
    log.debug({ owner, repoName, prNumber }, 'PR does not have auto-merge label, skipping');
    return result('ineligible', 'no_auto_merge_label');
}

/** Ultrafix still working, or labels/state that could not be read, are inconclusive; a missing label or failed Ultrafix is not. */
export function eligibilityRefusalOutcome(eligibility: Exclude<AutoMergeEligibility, 'eligible'>): AutoMergeEvaluationOutcome {
    return eligibility === 'transient' ? 'inconclusive' : 'resolved';
}

/**
 * A policy refusal that may stem from an unreadable policy file, PR or diff is
 * inconclusive; a refusal the policy itself decided leaves the PR for a human.
 */
export function policyRefusalOutcome(decision: Pick<AutoMergeDecision, 'reason'>): AutoMergeEvaluationOutcome {
    return decision.reason === 'skipped_diff_unavailable' || decision.reason === 'skipped_policy_invalid' ? 'inconclusive' : 'resolved';
}
