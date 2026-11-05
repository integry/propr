import { getPendingPrCommentsKey } from '@propr/core';
import { resolveRecoveryDeps, type FollowupHandoffRecoveryDeps } from './followupHandoffDeps.js';
import { releaseFollowupHandoffRecord } from './followupHandoffOperator.js';
import { recoverInterruptedFollowupHandoffs } from './followupHandoffRecovery.js';
import { splitHandoffRepository, type HandoffOctokit } from './followupHandoffResumeTypes.js';
import {
    HANDOFF_AWAITING_OPERATOR, loadFollowupHandoff, loadFollowupHandoffs, parseHandoffJobData,
    type FollowupHandoffKey, type FollowupHandoffRecord,
} from './followupHandoffStore.js';

/**
 * Follow-ups held for an operator on a pull request that has since been merged
 * or closed. Nothing can be published there any more, so the hold would block
 * every later follow-up for the pull request forever: each one waited behind
 * it, and before waiting in place each queued a replacement every minute.
 */

export type PullRequestClosure = 'merged' | 'closed';

/** How the pull request was closed, or null while it is open. */
export async function readPullRequestClosure(
    octokit: Pick<HandoffOctokit, 'request'>,
    owner: string,
    repo: string,
    pullRequestNumber: number,
): Promise<PullRequestClosure | null> {
    const { data } = await octokit.request('GET /repos/{owner}/{repo}/pulls/{pull_number}', {
        owner, repo, pull_number: pullRequestNumber,
    });
    const pull = data as { state?: string; merged?: boolean | null; merged_at?: string | null };
    if (pull.state !== 'closed') return null;
    return pull.merged || pull.merged_at ? 'merged' : 'closed';
}

interface DeletingRedis { del?(key: string): Promise<unknown> }

/**
 * Releases one operator-held follow-up of a closed pull request and drops the
 * comments still queued for it. The release is the operator release, forced:
 * it still requires the agent proven gone and the PR lease, and it only
 * detaches the worktree HEAD, so retained files and commits stay for the
 * normal worktree retention cleanup.
 */
export async function releaseClosedPullRequestHandoff(
    record: FollowupHandoffRecord,
    closure: PullRequestClosure,
    deps: FollowupHandoffRecoveryDeps = {},
): Promise<{ released: boolean; reason?: string }> {
    const key: FollowupHandoffKey = { repository: record.repository, pull_request: record.pull_request };
    const result = await releaseFollowupHandoffRecord(key, {
        force: true, reason: closure === 'merged' ? 'released_pr_merged' : 'released_pr_closed',
    }, deps);
    if (result.released && deps.redis) {
        const jobData = parseHandoffJobData(record);
        const { owner, repo } = splitHandoffRepository(record.repository);
        await (deps.redis as DeletingRedis).del?.(
            getPendingPrCommentsKey(jobData.repoOwner ?? owner, jobData.repoName ?? repo, record.pull_request),
        );
    }
    return result;
}

/** Releases the pull request's follow-up hold, if one is held for an operator; never throws. */
export async function releaseHeldHandoffOfClosedPullRequest(
    ref: { repoOwner: string; repoName: string; pullRequestNumber: number },
    closure: PullRequestClosure,
    deps: FollowupHandoffRecoveryDeps = {},
): Promise<{ released: boolean; reason?: string }> {
    const resolved = await resolveRecoveryDeps(deps);
    try {
        const record = await loadFollowupHandoff(resolved.store, {
            repository: `${ref.repoOwner}/${ref.repoName}`.toLowerCase(), pull_request: ref.pullRequestNumber,
        });
        if (record?.status !== HANDOFF_AWAITING_OPERATOR) return { released: false, reason: 'not_held' };
        return await releaseClosedPullRequestHandoff(record, closure, sharedDeps(deps, resolved));
    } catch (error) {
        resolved.log.warn({ ...ref, error: (error as Error).message }, 'Could not release the follow-up hold of a closed pull request');
        return { released: false, reason: 'error' };
    } finally {
        if (resolved.ownRedis) await resolved.redis.quit?.();
    }
}

function sharedDeps(
    deps: FollowupHandoffRecoveryDeps,
    resolved: Awaited<ReturnType<typeof resolveRecoveryDeps>>,
): FollowupHandoffRecoveryDeps {
    return {
        ...deps, store: resolved.store, redis: resolved.redis, log: resolved.log,
        getOctokit: resolved.getOctokit, git: resolved.git, inspectLiveness: resolved.inspectLiveness,
    };
}

export interface ClosedPullRequestHandoffSummary {
    inspected: number;
    released: number;
    refused: number;
    errors: number;
}

/** Each held follow-up's pull request is read from GitHub at most this often. */
export const CLOSED_PULL_REQUEST_CHECK_INTERVAL_MS = 10 * 60_000;
const lastChecked = new Map<string, number>();

/**
 * One pass over the operator-held follow-ups: those whose pull request was
 * merged or closed are released. A refused release (the agent still running,
 * unverifiable liveness, the lease held by a live writer) is retried after
 * the check interval.
 */
export async function releaseClosedPullRequestHandoffs(
    deps: FollowupHandoffRecoveryDeps & { now?: () => number } = {},
): Promise<ClosedPullRequestHandoffSummary> {
    const now = deps.now ?? Date.now;
    const resolved = await resolveRecoveryDeps(deps);
    const summary: ClosedPullRequestHandoffSummary = { inspected: 0, released: 0, refused: 0, errors: 0 };
    try {
        const held = await loadFollowupHandoffs(resolved.store, { status: HANDOFF_AWAITING_OPERATOR });
        const current = new Set<string>();
        for (const record of held) {
            const checkKey = `${record.repository}#${record.pull_request}#${record.incarnation}`;
            current.add(checkKey);
            const checkedAt = lastChecked.get(checkKey);
            if (checkedAt !== undefined && now() - checkedAt < CLOSED_PULL_REQUEST_CHECK_INTERVAL_MS) continue;
            lastChecked.set(checkKey, now());
            summary.inspected += 1;
            try {
                const { owner, repo } = splitHandoffRepository(record.repository);
                const closure = await readPullRequestClosure(await resolved.getOctokit(), owner, repo, record.pull_request);
                if (!closure) continue;
                const result = await releaseClosedPullRequestHandoff(record, closure, sharedDeps(deps, resolved));
                if (result.released) {
                    summary.released += 1;
                    resolved.log.info({ repository: record.repository, pullRequest: record.pull_request, taskId: record.task_id, closure },
                        'Released the follow-up hold of a closed pull request');
                } else {
                    summary.refused += 1;
                    resolved.log.warn({ repository: record.repository, pullRequest: record.pull_request, reason: result.reason },
                        'Could not yet release the follow-up hold of a closed pull request');
                }
            } catch (error) {
                summary.errors += 1;
                resolved.log.warn({ repository: record.repository, pullRequest: record.pull_request, error: (error as Error).message },
                    'Failed to check a held follow-up against its pull request');
            }
        }
        for (const key of lastChecked.keys()) if (!current.has(key)) lastChecked.delete(key);
        return summary;
    } finally {
        if (resolved.ownRedis) await resolved.redis.quit?.();
    }
}

/** The worker's periodic handoff pass: interrupted publications, then holds on closed pull requests. */
export async function recoverFollowupHandoffsAndClosedHolds(): Promise<Record<string, unknown>> {
    return {
        ...await recoverInterruptedFollowupHandoffs(),
        closedPullRequestHolds: await releaseClosedPullRequestHandoffs(),
    };
}
