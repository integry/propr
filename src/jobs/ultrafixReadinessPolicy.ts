import type { Redis } from 'ioredis';
import type {
    UltrafixAction,
    UltrafixCheckStatus,
    UltrafixLoopState,
    UltrafixReadinessResult,
} from './ultrafixOrchestrationService.js';

/**
 * A fix may need to repair failing CI. Reviews inspect the result of a fix, so
 * they must wait for CI to settle and pass before running.
 */
export function requiresPassingChecks(nextAction: UltrafixAction): boolean {
    return nextAction === 'review';
}

// --- Readiness helpers (side-effect free, testable independently) ---

/**
 * Check whether the configured cooldown has elapsed since the last action.
 */
export function isCooldownElapsed(state: UltrafixLoopState, nowMs?: number): boolean {
    if (!state.lastActionTimestamp) return true;
    const elapsed = (nowMs ?? Date.now()) - new Date(state.lastActionTimestamp).getTime();
    return elapsed >= state.pauseSeconds * 1000;
}

/**
 * Check whether there are follow-up jobs (waiting, active, or delayed)
 * for the same PR in the issue queue.
 *
 * Only considers jobs with `ultrafixMeta` (i.e. ultrafix implementation
 * follow-up work), not arbitrary PR jobs. This avoids false positives from
 * unrelated issue-queue work on the same PR.
 *
 * `getQueueJobs` is injected so this function stays side-effect free in tests.
 */
export async function hasFollowUpJobsForPR(
    owner: string,
    repo: string,
    pr: number,
    getQueueJobs: () => Promise<Array<{ data: { repoOwner?: string; repoName?: string; pullRequestNumber?: number; ultrafixMeta?: unknown } }>>,
): Promise<boolean> {
    const jobs = await getQueueJobs();
    return jobs.some(j =>
        j.data.repoOwner === owner &&
        j.data.repoName === repo &&
        j.data.pullRequestNumber === pr &&
        j.data.ultrafixMeta != null,
    );
}

/**
 * Check whether there are pending batched PR comments in Redis
 * that haven't been consumed yet.
 */
export async function hasPendingBatchedComments(
    redis: Redis,
    pendingCommentsKey: string,
): Promise<boolean> {
    const len = await redis.llen(pendingCommentsKey);
    return len > 0;
}

/**
 * Aggregate readiness check. Returns { ready, reasons } where reasons
 * lists every blocking condition that is currently true.
 *
 * Note: cooldown is NOT checked here — it is enforced via the enqueue delay
 * in `enqueueNextStep()`. Including it as a readiness gate would cause
 * double-application of the pause (once as a defer, then again as a delay).
 *
 * Side-effect free: callers supply the external check results.
 */
export function checkReadiness(opts: {
    allChecksPassing: boolean;
    hasFollowUpJobs: boolean;
    hasPendingComments: boolean;
}): UltrafixReadinessResult {
    const reasons: string[] = [];

    if (!opts.allChecksPassing) {
        reasons.push('checks_not_passing');
    }
    if (opts.hasFollowUpJobs) {
        reasons.push('follow_up_jobs_active');
    }
    if (opts.hasPendingComments) {
        reasons.push('pending_comments_exist');
    }

    return { ready: reasons.length === 0, reasons };
}

/**
 * Interpret GitHub check/status state for ultrafix progression.
 * A commit with zero check runs/status contexts is considered ready: there is
 * no future webhook to wait for, so deferring would deadlock the loop.
 * The status must come from a repository-aware source (getCheckRunsStatusForRepo)
 * so checks matching nonBlockingChecks never gate the loop.
 */
export function areChecksReadyForUltrafix(status: UltrafixCheckStatus): boolean {
    return status.allPassing;
}
