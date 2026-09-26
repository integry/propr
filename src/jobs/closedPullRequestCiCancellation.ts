/**
 * Cancels the validation still running for a pull request that was merged or
 * closed. That validation is as obsolete as the head a follow-up implementation
 * replaces, so it runs under the same opt-in: the repository option and its
 * selected validation workflows. GitHub never cancels these runs itself, and it
 * stops associating them with the pull request once it closes, so ownership is
 * proven by the pull request's final head SHA, branch and repository instead,
 * and only runs started before the pull request closed are touched: a workflow
 * that reacts to the close itself (a preview teardown, say) keeps running.
 */

import {
    CLOSED_PULL_REQUEST_CI_KEY, getClosedPullRequestCiRedis, isCancelCiDuringFollowupEnabledForRepository,
    type ClosedPullRequestCiRequest,
} from '@propr/core';
import { isEligibleValidationWorkflow, type ValidationWorkflowPolicy } from './followupCiSuspensionPolicy.js';
import {
    CANCELABLE_RUN_STATUSES, CiActionsPermissionError, cancelRun, listRunsForSha, sameSha,
    type CiSuspensionOctokit, type SuspensionTarget, type WorkflowRunSummary,
} from './followupCiSuspensionRuns.js';
import { resolveLog, resolveOctokit, resolvePolicy, type CiSuspensionDeps } from './followupCiSuspensionContext.js';

/** Validation queued for longer than this is left alone; the request is only a best-effort cleanup. */
export const CLOSED_PULL_REQUEST_CI_MAX_AGE_MS = 6 * 60 * 60 * 1000;

interface ClosedPullRequestCiRedis {
    hgetall(key: string): Promise<Record<string, string>>;
    hget(key: string, field: string): Promise<string | null>;
    hdel(key: string, ...fields: string[]): Promise<number>;
}

export interface ClosedPullRequestCiDeps extends CiSuspensionDeps {
    redis?: ClosedPullRequestCiRedis;
    now?: () => number;
}

export interface ClosedPullRequestCiSummary {
    scanned: number;
    cancelledRuns: number;
    errors: number;
}

export function isObsoleteClosedPullRequestRun(
    run: WorkflowRunSummary,
    request: Pick<ClosedPullRequestCiRequest, 'headSha' | 'headRef' | 'headRepository' | 'closedAt'>,
    policy: ValidationWorkflowPolicy,
): boolean {
    if (!isEligibleValidationWorkflow(run, policy)) return false;
    if (!CANCELABLE_RUN_STATUSES.has((run.status ?? '').toLowerCase())) return false;
    if (!sameSha(run.head_sha, request.headSha)) return false;
    if (run.head_branch !== request.headRef) return false;
    const runRepository = run.head_repository?.full_name;
    if (request.headRepository && runRepository?.toLowerCase() !== request.headRepository.toLowerCase()) return false;
    const createdAt = Date.parse(run.created_at ?? '');
    return Number.isFinite(createdAt) && createdAt < Date.parse(request.closedAt);
}

/** Another open pull request of the same head commit still needs this validation. */
async function headStillUnderReview(octokit: CiSuspensionOctokit, target: SuspensionTarget, request: ClosedPullRequestCiRequest): Promise<boolean> {
    const headOwner = (request.headRepository ?? `${target.owner}/${target.repo}`).split('/')[0];
    const { data } = await octokit.request('GET /repos/{owner}/{repo}/pulls', {
        owner: target.owner, repo: target.repo, state: 'open', head: `${headOwner}:${request.headRef}`, per_page: 100,
    });
    return (data as Array<{ number: number; head?: { sha?: string } }>)
        .some(pullRequest => pullRequest.number !== request.pullRequestNumber && sameSha(pullRequest.head?.sha, request.headSha));
}

async function cancelForRequest(request: ClosedPullRequestCiRequest, deps: ClosedPullRequestCiDeps): Promise<number> {
    const [owner, repo] = request.repository.split('/');
    const target: SuspensionTarget = { owner, repo, pullRequestNumber: request.pullRequestNumber };
    const isEnabled = deps.isEnabled ?? isCancelCiDuringFollowupEnabledForRepository;
    if (!await isEnabled(owner, repo)) return 0;
    const policy = await resolvePolicy(deps, target);
    if (policy.selected.size === 0) return 0;
    const octokit = await resolveOctokit(deps);
    const runs = (await listRunsForSha(octokit, target, request.headSha))
        .filter(run => isObsoleteClosedPullRequestRun(run, request, policy));
    if (runs.length === 0 || await headStillUnderReview(octokit, target, request)) return 0;
    let cancelled = 0;
    for (const run of runs) {
        if (await cancelRun(octokit, target, run.id)) cancelled += 1;
    }
    resolveLog(deps).info({
        repository: request.repository, pullRequest: request.pullRequestNumber, merged: request.merged,
        cancelledRunIds: runs.map(run => run.id),
    }, 'Cancelled obsolete validation of a closed pull request');
    return cancelled;
}

/** One reconciliation pass over the closed pull requests the webhook recorded. */
export async function cancelClosedPullRequestValidation(deps: ClosedPullRequestCiDeps = {}): Promise<ClosedPullRequestCiSummary> {
    const redis = deps.redis ?? getClosedPullRequestCiRedis();
    const log = resolveLog(deps);
    const now = (deps.now ?? Date.now)();
    const summary: ClosedPullRequestCiSummary = { scanned: 0, cancelledRuns: 0, errors: 0 };
    for (const [field, raw] of Object.entries(await redis.hgetall(CLOSED_PULL_REQUEST_CI_KEY))) {
        summary.scanned += 1;
        let settled = true;
        try {
            const request = JSON.parse(raw) as ClosedPullRequestCiRequest;
            if (now - Date.parse(request.closedAt) <= CLOSED_PULL_REQUEST_CI_MAX_AGE_MS) {
                summary.cancelledRuns += await cancelForRequest(request, deps);
            }
        } catch (error) {
            // A refused Actions request will be refused again; anything else is retried next pass.
            settled = error instanceof CiActionsPermissionError || error instanceof SyntaxError;
            summary.errors += 1;
            log.warn({ request: field, error: (error as Error).message, retried: !settled },
                'Failed to cancel obsolete validation of a closed pull request');
        }
        // A pull request reopened and closed again in the meantime is handled by its newer request.
        if (settled && await redis.hget(CLOSED_PULL_REQUEST_CI_KEY, field) === raw) {
            await redis.hdel(CLOSED_PULL_REQUEST_CI_KEY, field);
        }
    }
    return summary;
}
