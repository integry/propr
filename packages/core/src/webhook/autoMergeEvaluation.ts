/**
 * Outcomes of one auto-merge evaluation, so the auto-merge sweep can tell an
 * evaluation that resolved a `require_up_to_date` retry from one that could not
 * decide. A deferred candidate may get no further event, so the sweep keeps its
 * retry entry unless the evaluation resolved it.
 */
import type logger from '../utils/logger.js';
import { isEpicBranch } from '../services/taskExecutionService.js';
import type { AutoMergeDecision } from '../workflow/autoMergePolicy.js';
import { readLinkedIssueAutoMergeLabel, type CiMergeReadiness, type PRAutoMergeInfo } from './checkRunHelpers.js';

/**
 * `resolved`: the PR merged, is no longer open, or waits on something that
 * produces its own event (a human, a new head, a failed check). `inconclusive`:
 * a read was unavailable or a transient gate (unknown mergeability, CI not yet
 * registered or still running, active work, a refused or failed merge, a
 * deferral) held the merge back; the PR stays in the sweep's retry set.
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
}

/**
 * Whether the PR's labels and Ultrafix state make it an auto-merge candidate.
 */
export async function evaluateAutoMergeEligibility(ctx: AutoMergeEligibilityContext): Promise<AutoMergeEligibility> {
    const { owner, repoName, prNumber, prInfo, log } = ctx;

    if (prInfo.hasActiveUltrafixLoop) {
        log.info({ owner, repoName, prNumber }, 'PR has an active ultrafix loop, skipping auto-merge');
        return 'transient';
    }

    if (prInfo.ultrafixCompletionStatus === 'failed') {
        log.info({ owner, repoName, prNumber }, 'PR has a failed ultrafix loop, keeping auto-merge blocked');
        return 'ineligible';
    }

    if (prInfo.hasUltrafixLabel && prInfo.ultrafixStateUnavailable) {
        log.warn(
            { owner, repoName, prNumber },
            'Ultrafix state is unavailable while ultrafix label is present, keeping auto-merge blocked'
        );
        return 'transient';
    }

    if (prInfo.hasUltrafixLabel && prInfo.ultrafixCompletionStatus !== 'succeeded') {
        log.info(
            { owner, repoName, prNumber, ultrafixCompletionStatus: prInfo.ultrafixCompletionStatus },
            'Ultrafix label remains without a successful completion state, keeping auto-merge blocked'
        );
        return 'ineligible';
    }

    if (isEpicBranch(prInfo.headBranch)) {
        if (!prInfo.hasLabel) {
            log.debug({ owner, repoName, prNumber, headBranch: prInfo.headBranch }, 'Epic PR does not have auto-merge label, skipping merge');
            return 'ineligible';
        }
        return 'eligible';
    }

    if (prInfo.hasLabel) return 'eligible';
    const issueHasLabel = await readLinkedIssueAutoMergeLabel(owner, repoName, prNumber);
    if (issueHasLabel === true) return 'eligible';
    if (issueHasLabel === null) {
        log.debug({ owner, repoName, prNumber }, 'Linked issue labels are unavailable, skipping auto-merge for now');
        return 'transient';
    }
    log.debug({ owner, repoName, prNumber }, 'PR does not have auto-merge label, skipping');
    return 'ineligible';
}

/** Ultrafix still working, or labels/state that could not be read, are inconclusive; a missing label or failed Ultrafix is not. */
export function eligibilityRefusalOutcome(eligibility: Exclude<AutoMergeEligibility, 'eligible'>): AutoMergeEvaluationOutcome {
    return eligibility === 'transient' ? 'inconclusive' : 'resolved';
}

/**
 * A failed blocking check waits on a new head (or a re-run), which produces its
 * own event, so it resolves the evaluation. Checks that are still running do
 * not: the green event they produce may itself meet a transient refusal (unknown
 * mergeability, active work) that no further event follows, so the retry entry
 * must outlive them. Unreadable CI and a head whose CI has not registered (or a
 * repository without CI, inside its grace period) may produce no event either.
 */
export function ciRefusalOutcome(ci: Pick<CiMergeReadiness, 'reason' | 'checksFailed'>): AutoMergeEvaluationOutcome {
    return ci.reason === 'checks_not_passing' && ci.checksFailed === true ? 'resolved' : 'inconclusive';
}

/** A mergeability GitHub has not computed yet is inconclusive; any other refusal waits on a change to the PR. */
export function mergeabilityRefusalOutcome(prInfo: Pick<PRAutoMergeInfo, 'mergeable' | 'mergeableState'>): AutoMergeEvaluationOutcome {
    return prInfo.mergeable === null || prInfo.mergeableState === 'unknown' ? 'inconclusive' : 'resolved';
}

/**
 * A policy refusal that may stem from an unreadable policy file, PR or diff is
 * inconclusive; a refusal the policy itself decided leaves the PR for a human.
 */
export function policyRefusalOutcome(decision: Pick<AutoMergeDecision, 'reason'>): AutoMergeEvaluationOutcome {
    return decision.reason === 'skipped_diff_unavailable' || decision.reason === 'skipped_policy_invalid' ? 'inconclusive' : 'resolved';
}
