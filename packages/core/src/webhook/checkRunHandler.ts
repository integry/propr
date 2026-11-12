import logger from '../utils/logger.js';
import { findPlanIssueByRepoAndPR, updatePlanIssueByPR, PlanIssueStatus } from '../config/planIssueManager.js';
import { isEpicBranch } from '../services/taskExecutionService.js';
import {
    mergePR,
    deleteBranch,
    getFirstCommitMessage,
    getCurrentPRHead,
    getCiMergeReadiness,
    getPRAutoMergeInfo,
    hasActiveTasksForPR,
    findPRsForCommit,
    findPRsForCommitCached,
    type MergePROptions,
    type MergePRResult,
    type PRAutoMergeInfo
} from './checkRunHelpers.js';
import {
    extractCheckRunFailure,
    extractStatusFailure,
    postCiFailureFollowup,
    type CiFailureEvidence,
} from './ciFailureFollowup.js';
import type { CheckRunEvent, CheckSuiteEvent } from '@octokit/webhooks-types';
import { isActedCheckRunAction, isActedCheckSuiteAction, isPassingCheckSuiteConclusion, STATUS_SUCCESS_STATE } from './webhookEventGates.js';
import { getNonBlockingChecksForRepository } from '../daemon/configLoader.js';
import { isNonBlockingCheck } from './nonBlockingChecks.js';
import {
    evaluatePullRequestAutoMerge, resolveDirectMergeMethod, withdrawNativeAutoMergeForUpToDate, withdrawNativeAutoMergeIfUpToDateRequired,
} from '../services/autoMergeGate.js';
import type { AutoMergeDecision, AutoMergePolicyMethod } from '../workflow/autoMergePolicy.js';
import { mergeWhenUpToDate, noteCiWaitAfterBranchUpdate, type MergeOwnershipCheck } from './autoMergeUpToDate.js';
import {
    ciRefusalOutcome, eligibilityRefusalOutcome, evaluateAutoMergeEligibility, mergeabilityRefusalOutcome, policyRefusalOutcome,
    type AutoMergeEvaluationOutcome,
} from './autoMergeEvaluation.js';

export interface StatusEventPayload {
    sha: string;
    state: string;
    repository: { full_name: string };
    context?: string;
    description?: string | null;
    target_url?: string | null;
    [key: string]: unknown;
}

export { mergePR, type MergePROptions, type MergePRResult };

// Export types and internal functions for testing
export type { PRMergeContext };

// --- Ultrafix check_run hook ---

type UltrafixCheckRunHook = (owner: string, repo: string, prNumber: number, headSha: string) => Promise<void>;

let _ultrafixCheckRunHook: UltrafixCheckRunHook | null = null;

/**
 * Register a callback that fires when a check_run completes successfully.
 * Used by the ultrafix system to wake deferred continuations.
 */
export function setUltrafixCheckRunHook(hook: UltrafixCheckRunHook): void {
    _ultrafixCheckRunHook = hook;
}

/**
 * Fires the registered Ultrafix hook for a PR whose checks turned green, so a
 * deferred (or stranded) loop continuation can resume. Shared by webhook
 * intake (check_run, check_suite, status) and the polling reconciler.
 * Returns whether a hook was registered and completed without throwing.
 * A failure is logged through `log`, so callers keep their correlation ID.
 */
export async function triggerUltrafixCheckRunHook(
    target: { owner: string; repo: string; prNumber: number; headSha: string },
    log: Pick<typeof logger, 'warn'> = logger,
): Promise<boolean> {
    if (!_ultrafixCheckRunHook) return false;
    const { owner, repo, prNumber, headSha } = target;
    try {
        await _ultrafixCheckRunHook(owner, repo, prNumber, headSha);
        return true;
    } catch (error) {
        log.warn({ owner, repo, prNumber, headSha, error: (error as Error).message }, 'Ultrafix check hook failed');
        return false;
    }
}

interface PRContext {
    owner: string;
    repoName: string;
    prNumber: number;
    log: ReturnType<typeof logger.withCorrelation>;
}

interface PRMergeContext extends PRContext {
    headSha: string;
    prInfo: PRAutoMergeInfo;
}

/**
 * Determines if a PR should be auto-merged based on labels.
 */
export async function shouldAutoMergePR(ctx: PRMergeContext): Promise<boolean> {
    return await evaluateAutoMergeEligibility(ctx) === 'eligible';
}

/**
 * Performs the actual merge of a PR and post-merge actions. `stillOwned` (`require_up_to_date`) is checked right
 * before the merge request: an attempt that lost the merge ownership must not merge on a stale comparison.
 */
async function performMergeAndPostActions(ctx: PRMergeContext, mergeMethod: AutoMergePolicyMethod = 'squash', expectedHeadSha?: string, stillOwned?: MergeOwnershipCheck): Promise<boolean> {
    const { owner, repoName, prNumber, prInfo, log } = ctx;
    let commitTitle: string | undefined;
    let commitMessage: string | undefined;

    if (isEpicBranch(prInfo.baseBranch)) {
        const firstCommit = await getFirstCommitMessage(owner, repoName, prNumber);
        if (firstCommit) {
            commitTitle = firstCommit.title;
            commitMessage = firstCommit.message;
            log.debug({ owner, repoName, prNumber, commitTitle }, 'Using first commit message for epic branch merge');
        }
    }

    if (stillOwned && !await stillOwned()) {
        log.info({ owner, repoName, prNumber }, 'Auto-merge ownership was lost before the merge request, not merging');
        return false;
    }
    const mergeResult = await mergePR({ owner, repoName, prNumber, mergeMethod, commitTitle, commitMessage, sha: expectedHeadSha });

    if (mergeResult.success && mergeResult.merged) {
        log.info({ owner, repoName, prNumber, sha: mergeResult.sha }, 'PR auto-merged successfully');
        await deleteBranch(owner, repoName, prNumber, log);

        const repository = `${owner}/${repoName}`;
        const planIssue = await findPlanIssueByRepoAndPR(repository, prNumber);
        if (planIssue) {
            await updatePlanIssueByPR(repository, prNumber, { status: PlanIssueStatus.MERGED });
            log.info({ repository, prNumber }, 'Updated plan issue status to merged');
        }
        return true;
    }
    log.warn({ owner, repoName, prNumber, error: mergeResult.error }, 'Failed to auto-merge PR');
    return false;
}

/**
 * GitHub's PR mergeability result accounts for required checks that may not
 * have registered a check run yet, branch protection, and merge conflicts.
 * Requiring the authoritative clean state prevents an unrelated fast check
 * from opening a premature merge window for an App that can bypass rules.
 * `behind` (branch protection requires an up-to-date branch) passes this gate
 * only so `require_up_to_date` can update the branch; it never merges.
 */
function passesMergeabilityGate(ctx: PRContext, prInfo: PRAutoMergeInfo): boolean {
    const { mergeable, mergeableState } = prInfo;
    if (mergeable === true && (mergeableState === 'clean' || mergeableState === 'behind')) return true;
    ctx.log.debug({ owner: ctx.owner, repoName: ctx.repoName, prNumber: ctx.prNumber, mergeable, mergeableState },
        'GitHub does not report the PR as cleanly mergeable yet, skipping merge');
    return false;
}

/**
 * Merge an evaluated head. With `require_up_to_date`, the head must contain the
 * latest base commit; otherwise ProPR updates the branch and the updated head
 * merges only after its own CI passes. The comparison and the merge run under
 * the repository's merge ownership, so a second candidate compares against the
 * base this merge produced; the ownership is confirmed right before the merge
 * request. A head GitHub still reports as behind never merges. Only a merge
 * resolves the evaluation: an updated, waiting, refused or failed merge leaves it inconclusive.
 */
async function mergeEvaluatedHead(ctx: PRMergeContext, decision: AutoMergeDecision, baseRef: string, ciReason: string): Promise<AutoMergeEvaluationOutcome> {
    const { owner, repoName, prNumber, headSha, prInfo, log } = ctx;
    let merged = false;
    const merge = async (stillOwned?: MergeOwnershipCheck): Promise<void> => {
        if (prInfo.mergeableState !== 'clean') {
            log.debug({ owner, repoName, prNumber, mergeableState: prInfo.mergeableState }, 'GitHub reports the PR as behind its base, skipping merge');
            return;
        }
        // A policy without a method merges like the arming gate would arm: squash,
        // unless the repository disallows it.
        const mergeMethod = await resolveDirectMergeMethod({ owner, repo: repoName, method: decision.method });
        log.info({ owner, repoName, prNumber, headSha, ci: ciReason, mergeMethod }, 'CI allows merging the auto-merge PR, attempting to merge');
        // GitHub refuses the merge if the head moved after the evaluation.
        merged = await performMergeAndPostActions(ctx, mergeMethod, headSha, stillOwned);
    };
    if (decision.upToDate) await mergeWhenUpToDate({ owner, repo: repoName, prNumber, headSha, baseRef, log }, decision.upToDate, merge);
    else await merge();
    return merged ? 'resolved' : 'inconclusive';
}

/**
 * Processes a single PR for potential auto-merge. The outcome tells the sweep
 * whether a `require_up_to_date` retry is resolved ({@link AutoMergeEvaluationOutcome}).
 */
async function processPRAutoMerge(ctx: PRContext, headSha: string, options: { ignoreWorkIds?: readonly string[] } = {}): Promise<AutoMergeEvaluationOutcome> {
    const { owner, repoName, prNumber, log } = ctx;
    const prInfo = await getPRAutoMergeInfo(owner, repoName, prNumber);

    if (prInfo.unavailable) {
        log.debug({ owner, repoName, prNumber }, 'PR could not be read, skipping auto-merge for now');
        return 'inconclusive';
    }

    if (prInfo.state !== undefined && prInfo.state !== 'open') {
        log.debug({ owner, repoName, prNumber, state: prInfo.state }, 'PR is not open, skipping auto-merge');
        return 'resolved';
    }

    if (prInfo.isDraft) {
        log.debug({ owner, repoName, prNumber }, 'PR is a draft, skipping auto-merge');
        return 'resolved';
    }

    // `require_up_to_date`: GitHub's own auto-merge would merge a behind head once
    // CI passes, so ProPR's native request is withdrawn before any gate below can
    // return (pending CI, mergeability, Ultrafix state, active work).
    if (prInfo.autoMergeArmed) {
        await withdrawNativeAutoMergeIfUpToDateRequired({ owner, repo: repoName, prNumber, opportunity: 'check_merge', log });
    }

    const mergeCtx: PRMergeContext = { ...ctx, headSha, prInfo };

    const eligibility = await evaluateAutoMergeEligibility(mergeCtx);
    if (eligibility !== 'eligible') return eligibilityRefusalOutcome(eligibility);

    const currentPrHead = await getCurrentPRHead(owner, repoName, prNumber);
    if (currentPrHead !== headSha) {
        log.debug({ owner, repoName, prNumber, checkRunSha: headSha, currentPrHead }, 'Check run SHA does not match current PR head, skipping');
        return 'inconclusive';
    }

    // Passing CI, or no CI at all for this head, lets the merge proceed.
    const ci = await getCiMergeReadiness(owner, repoName, headSha, { prNumber });
    if (!ci.ready) {
        log.debug({ owner, repoName, prNumber, reason: ci.reason }, 'CI does not allow merging yet, skipping merge');
        // A head ProPR produced by updating the branch records that it waits for CI.
        if (ci.reason !== 'unavailable') await noteCiWaitAfterBranchUpdate({ owner, repo: repoName, prNumber, headSha, log });
        return ciRefusalOutcome(ci);
    }

    if (!passesMergeabilityGate(ctx, prInfo)) return mergeabilityRefusalOutcome(prInfo);

    // Check for active tasks (e.g., followup processing) before merging
    const repository = `${owner}/${repoName}`;
    const { hasActive, activeTasks, queuedJobs } = await hasActiveTasksForPR(repository, prNumber, options.ignoreWorkIds);
    if (hasActive) {
        log.info({
            owner,
            repoName,
            prNumber,
            activeTasks,
            queuedJobs,
        }, 'Skipping auto-merge - active or queued work in progress for this PR');
        return 'inconclusive';
    }

    // The repository's auto-merge policy (read from the base branch) gates this
    // merge exactly like arming GitHub auto-merge; any uncertainty keeps a human in the loop.
    const { decision, pullRequest } = await evaluatePullRequestAutoMerge({ owner, repo: repoName, prNumber, opportunity: 'check_merge' });
    if (!decision.arm) {
        log.info({ owner, repoName, prNumber, reason: decision.reason, matchedPaths: decision.matchedPaths },
            'Auto-merge policy does not allow merging this PR; leaving it for a human');
        return policyRefusalOutcome(decision);
    }
    // The decision covers only the head it evaluated, which must be the head whose checks passed.
    if (pullRequest?.headSha !== headSha) {
        log.info({ owner, repoName, prNumber, checkedHeadSha: headSha, evaluatedHeadSha: pullRequest?.headSha },
            'PR head changed while evaluating the auto-merge policy, skipping merge');
        return 'inconclusive';
    }

    // `require_up_to_date` keeps GitHub's own auto-merge off: it would merge a
    // behind head without the comparison below. Withdraw ProPR's own request if
    // it was armed after the early withdrawal above read the PR.
    if (decision.upToDate && pullRequest.autoMergeArmed) {
        await withdrawNativeAutoMergeForUpToDate({ owner, repo: repoName, prNumber, pullRequest, opportunity: 'check_merge', log });
    }

    return mergeEvaluatedHead(mergeCtx, decision, pullRequest.baseRef || prInfo.baseBranch, ci.reason);
}

export interface AutoMergeReevaluationOptions {
    correlationId: string;
    /** Task/job IDs of the caller's own still-running work, which must not block its merge. */
    ignoreWorkIds?: readonly string[];
}

/** Re-evaluate the PR's current head; the outcome tells the sweep whether a retry is resolved. */
export async function reevaluatePRAutoMerge(
    owner: string,
    repoName: string,
    prNumber: number,
    options: AutoMergeReevaluationOptions,
): Promise<AutoMergeEvaluationOutcome> {
    const log = logger.withCorrelation(options.correlationId);
    const headSha = await getCurrentPRHead(owner, repoName, prNumber);
    if (!headSha) {
        log.debug({ owner, repoName, prNumber }, 'Auto-merge re-evaluation skipped: PR head SHA unavailable');
        return 'inconclusive';
    }

    const ctx: PRContext = { owner, repoName, prNumber, log };
    return processPRAutoMerge(ctx, headSha, options);
}

/**
 * Handles check_run webhook events.
 * Successful check runs drive auto-merge/Ultrafix. Failed check runs can post an
 * automatic follow-up comment when that repository has opted in.
 */
/**
 * A failure from a check the repository marked non-blocking starts no
 * follow-up; GitHub still shows it, and the check keeps its own history.
 */
async function unlessNonBlocking(failure: CiFailureEvidence | null, owner: string, repoName: string): Promise<CiFailureEvidence | null> {
    if (!failure) return null;
    if (!isNonBlockingCheck(failure.name, await getNonBlockingChecksForRepository(owner, repoName))) return failure;
    logger.info({ owner, repoName, check: failure.name }, 'Failed check is non-blocking for this repository; no follow-up');
    return null;
}

export async function handleCheckRunEvent(
    payload: CheckRunEvent,
    correlationId: string
): Promise<void> {
    const log = logger.withCorrelation(correlationId);
    const [owner, repoName] = payload.repository.full_name.split('/');

    log.debug({
        owner,
        repoName,
        action: payload.action,
        conclusion: payload.check_run.conclusion,
        checkRunName: payload.check_run.name,
        prCount: payload.check_run.pull_requests?.length ?? 0,
    }, 'check_run event received');

    if (!isActedCheckRunAction(payload.action)) return;

    // Check runs dispatched on branch pushes often arrive with an empty
    // pull_requests array even though the branch backs an open PR.
    const targetPRs = await resolveTargetPRs(owner, repoName, {
        pullRequests: payload.check_run.pull_requests,
        headSha: payload.check_run.head_sha,
    });
    if (targetPRs.length === 0) {
        log.debug({ owner, repoName, sha: payload.check_run.head_sha }, 'check_run skipped: no associated PRs');
        return;
    }

    const conclusion = payload.check_run.conclusion;
    const failure = await unlessNonBlocking(extractCheckRunFailure(payload), owner, repoName);
    if (failure) {
        for (const pr of targetPRs) {
            try {
                const currentPrHead = await getCurrentPRHead(owner, repoName, pr.number);
                if (currentPrHead !== failure.sha) {
                    log.debug({
                        owner,
                        repoName,
                        prNumber: pr.number,
                        failedCiSha: failure.sha,
                        currentPrHead,
                    }, 'Failed check run SHA does not match current PR head, skipping follow-up');
                    continue;
                }
                await postCiFailureFollowup({ owner, repo: repoName, prNumber: pr.number, evidence: failure }, correlationId);
            } catch (error) {
                log.warn(
                    { owner, repoName, prNumber: pr.number, error: (error as Error).message },
                    'Failed to post automatic failed-CI follow-up',
                );
            }
        }
        return;
    }

    if (conclusion !== 'success' && conclusion !== 'skipped') {
        log.debug({ owner, repoName, conclusion }, 'check_run skipped: not success/skipped');
        return;
    }

    for (const pr of targetPRs) {
        log.debug({
            owner,
            repoName,
            prNumber: pr.number,
            checkRunName: payload.check_run.name,
            conclusion
        }, 'Processing check run completion for PR');

        await processGreenCheckForPR({ owner, repoName, prNumber: pr.number, log }, payload.check_run.head_sha);
    }
}

/**
 * PRs a check run/suite applies to. When the payload lists none, open PRs are
 * looked up by commit. The branch name cannot rule that lookup out: a PR may
 * use the default branch as its head (`main` into `release`), and a fork PR's
 * head branch may share the base repository's default-branch name. Every job
 * of a default-branch push lists no PRs, so the lookup is cached per commit.
 */
async function resolveTargetPRs(
    owner: string,
    repoName: string,
    source: { pullRequests?: Array<{ number: number }> | null; headSha: string },
): Promise<Array<{ number: number }>> {
    if (source.pullRequests && source.pullRequests.length > 0) {
        return source.pullRequests.map(pr => ({ number: pr.number }));
    }
    return findPRsForCommitCached(owner, repoName, source.headSha);
}

/**
 * Runs auto-merge evaluation, then wakes any deferred Ultrafix continuation.
 * Idempotency is handled by the Redis GETDEL claim in claimDeferredContinuation.
 */
async function processGreenCheckForPR(ctx: PRContext, headSha: string): Promise<void> {
    const { owner, repoName, prNumber, log } = ctx;
    try {
        await processPRAutoMerge(ctx, headSha);
    } catch (error) {
        log.error({ owner, repoName, prNumber, error: (error as Error).message }, 'Error processing auto-merge for PR');
    }
    await triggerUltrafixCheckRunHook({ owner, repo: repoName, prNumber, headSha }, log);
}

/**
 * Handles check_suite webhook events. A completed, green suite drives the same
 * auto-merge evaluation and Ultrafix wake-up as a successful check run.
 */
export async function handleCheckSuiteEvent(
    payload: CheckSuiteEvent,
    correlationId: string
): Promise<void> {
    const log = logger.withCorrelation(correlationId);
    const [owner, repoName] = payload.repository.full_name.split('/');
    const suite = payload.check_suite;

    log.debug({
        owner,
        repoName,
        action: payload.action,
        conclusion: suite.conclusion,
        prCount: suite.pull_requests?.length ?? 0,
    }, 'check_suite event received');

    if (!isActedCheckSuiteAction(payload.action)) return;

    if (!isPassingCheckSuiteConclusion(suite.conclusion)) {
        log.debug({ owner, repoName, conclusion: suite.conclusion }, 'check_suite skipped: not success/neutral/skipped');
        return;
    }

    const targetPRs = await resolveTargetPRs(owner, repoName, {
        pullRequests: suite.pull_requests,
        headSha: suite.head_sha,
    });
    if (targetPRs.length === 0) {
        log.debug({ owner, repoName, sha: suite.head_sha }, 'check_suite skipped: no associated PRs');
        return;
    }

    for (const pr of targetPRs) {
        log.debug({ owner, repoName, prNumber: pr.number, conclusion: suite.conclusion }, 'Processing check suite completion for PR');
        await processGreenCheckForPR({ owner, repoName, prNumber: pr.number, log }, suite.head_sha);
    }
}

/**
 * Handles legacy commit `status` webhook events.
 * Failed/error statuses can post an opted-in automatic follow-up. Successful
 * statuses fire the Ultrafix hook so deferred continuations can resume.
 */
export async function handleStatusEvent(
    payload: StatusEventPayload,
    correlationId: string
): Promise<void> {
    const log = logger.withCorrelation(correlationId);
    const [owner, repoName] = payload.repository.full_name.split('/');

    log.debug({ owner, repoName, state: payload.state, sha: payload.sha, context: payload.context }, 'status event received');

    const failure = await unlessNonBlocking(extractStatusFailure(payload), owner, repoName);
    if (!failure && payload.state !== STATUS_SUCCESS_STATE) return;
    if (!failure && !_ultrafixCheckRunHook) return;

    const prs = await findPRsForCommit(owner, repoName, payload.sha);
    if (prs.length === 0) {
        log.debug({ owner, repoName, sha: payload.sha }, 'status event: no open PRs for commit');
        return;
    }

    for (const pr of prs) {
        if (failure) {
            try {
                const currentPrHead = await getCurrentPRHead(owner, repoName, pr.number);
                if (currentPrHead !== failure.sha) {
                    log.debug({
                        owner,
                        repoName,
                        prNumber: pr.number,
                        failedCiSha: failure.sha,
                        currentPrHead,
                    }, 'Failed status SHA does not match current PR head, skipping follow-up');
                    continue;
                }
                await postCiFailureFollowup({ owner, repo: repoName, prNumber: pr.number, evidence: failure }, correlationId);
            } catch (error) {
                log.warn(
                    { owner, repoName, prNumber: pr.number, error: (error as Error).message },
                    'Failed to post automatic failed-CI status follow-up',
                );
            }
            continue;
        }

        await triggerUltrafixCheckRunHook({ owner, repo: repoName, prNumber: pr.number, headSha: payload.sha }, log);
    }
}
