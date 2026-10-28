import fs from 'node:fs';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import {
    db,
    createWorktreeFromExistingBranch,
    cleanupWorktree,
    ensureGitRepository,
    ensureRepoCloned,
    getAuthenticatedOctokit,
    getRepoUrl,
    logger,
    type GoalJobData,
} from '@propr/core';
import { fencedGoal, type GoalRow } from './goalAttemptState.js';

/** Durable steering input: acknowledged by the same transport that delivers user input. */
export const GOAL_WORKTREE_RESTORED_NOTICE = 'ProPR rebuilt your checkout from the published goal branch because the previous working directory was gone. '
    + 'It contains the last published checkpoint; any uncommitted changes from before are lost. Review the working tree before continuing.';

async function recordRestorationNotice(trx: typeof db, goal: GoalRow): Promise<void> {
    const inputId = randomUUID();
    await trx('goal_inputs').insert({
        input_id: inputId, goal_id: goal.goal_id, owner_id: goal.owner_id,
        idempotency_key: `goal-restoration:${inputId}`, operation: 'goal.restore',
        payload_hash: 'goal-worktree-restored', kind: 'restoration', message: GOAL_WORKTREE_RESTORED_NOTICE,
    });
}

export interface GoalPullRequestState {
    state: string;
    merged: boolean;
    draft: boolean;
    nodeId: string;
}

type SavedGoalWorktree = GoalRow & { worktree_path: string; branch_name: string };

function hasSavedWorktree(goal: GoalRow): goal is SavedGoalWorktree {
    return Boolean(goal.worktree_path && goal.branch_name);
}

/** GitHub and Git operations a continued goal needs; injectable for tests. */
export interface GoalContinuationOperations {
    readPullRequest(repository: string, number: number): Promise<GoalPullRequestState | null>;
    convertToDraft(nodeId: string, assertCurrent: () => Promise<void>): Promise<void>;
    /** Returns null only when the remote branch is confirmed absent; other failures throw. */
    rebuildWorktree(goal: SavedGoalWorktree, assertCurrent: () => Promise<void>): Promise<string | null>;
    cleanupWorktree(goal: SavedGoalWorktree, assertCurrent: () => Promise<void>): Promise<void>;
}

function isDirectory(target: string): boolean {
    try { return fs.statSync(target).isDirectory(); } catch { return false; }
}

const FRESH_BRANCH = {
    worktree_path: null, branch_name: null, final_pr_number: null, final_pr_url: null,
} as const;

/** The saved checkout is gone and its published branch no longer exists, so there is nothing to resume from. */
export class GoalWorktreeLostError extends Error {
    constructor(goal: SavedGoalWorktree) {
        super(`Saved goal worktree ${goal.worktree_path} is missing and branch ${goal.branch_name} no longer exists on the remote`);
        this.name = 'GoalWorktreeLostError';
    }
}

function attemptClaimGuard(job: GoalJobData, what: string): () => Promise<void> {
    return async () => {
        if (!await fencedGoal(job)) throw new Error(`${what} lost its attempt claim`);
    };
}

// Retry only transient transport/server failures, once, with authority
// rechecked before retrying any external operation.
async function retryTransient<T>(operation: () => Promise<T>, assertCurrent: () => Promise<void>): Promise<T> {
    try { return await operation(); } catch (error) {
        const detail = error as { status?: number; code?: string; message?: string };
        if (!(Number(detail.status) >= 500 || ['ECONNRESET', 'ETIMEDOUT', 'EAI_AGAIN'].includes(detail.code ?? '')
            || /connection reset|fetch failed|socket hang up|timed out/i.test(detail.message ?? ''))) throw error;
        await assertCurrent();
        return operation();
    }
}

/**
 * Rebuilds a saved checkout that disappeared while the goal was still live,
 * such as after a host cleanup pruned the directory between attempts. The
 * published branch carries every checkpoint, so the attempt resumes from the
 * last one; only uncommitted work is gone. Throws {@link GoalWorktreeLostError}
 * when the branch itself is gone, which no attempt can recover from.
 */
export async function restoreMissingGoalWorktree(
    job: GoalJobData,
    goal: GoalRow,
    operations: GoalContinuationOperations = defaultContinuationOperations,
): Promise<{ goal: GoalRow; restored: boolean }> {
    if (!hasSavedWorktree(goal) || isDirectory(goal.worktree_path)) return { goal, restored: false };
    const assertCurrent = attemptClaimGuard(job, 'Goal worktree restoration');
    const rebuilt = await retryTransient(() => operations.rebuildWorktree(goal, assertCurrent), assertCurrent);
    if (rebuilt === null) throw new GoalWorktreeLostError(goal);
    logger.info({ goalId: goal.goal_id, worktreePath: rebuilt, branchName: goal.branch_name }, 'Rebuilt missing goal worktree from its published branch');
    await db.transaction(async trx => {
        const changed = await trx('goals').where({
            goal_id: job.goalId, current_task_id: job.taskId, run_generation: job.generation, run_claim: job.claimId,
        }).whereNull('result_state').update({ worktree_path: rebuilt, updated_at: trx.fn.now() });
        if (changed !== 1) throw new Error('Goal worktree restoration lost its attempt claim');
        await recordRestorationNotice(trx, goal);
    });
    const updated = await fencedGoal(job);
    if (!updated) throw new Error('Goal worktree restoration lost its attempt claim');
    return { goal: updated, restored: true };
}

/**
 * Brings the branch, worktree and pull request of a continued terminal goal
 * back to a state an attempt can publish to. Between the goal stopping and
 * the operator continuing it, the PR may have been merged, closed or marked
 * ready, and the worktree may have expired.
 *
 * - Merged PR: start a fresh branch from the base. A squash-merged branch would
 *   otherwise bring its already merged commits back in the next PR.
 * - Closed PR: keep the branch; the attempt opens a new draft PR.
 * - Ready PR: convert it back to a draft, which goal publication requires.
 * - Missing worktree: rebuild it from the remote branch, or start a fresh
 *   branch when that branch was deleted.
 */
export async function prepareContinuedGoal(
    job: GoalJobData,
    goal: GoalRow,
    operations: GoalContinuationOperations = defaultContinuationOperations,
): Promise<GoalRow> {
    if (!goal.continue_requested) return goal;
    const assertCurrent = attemptClaimGuard(job, 'Continued goal preparation');
    const retry = <T>(operation: () => Promise<T>): Promise<T> => retryTransient(operation, assertCurrent);
    const updates: Record<string, unknown> = {};
    let preservedCheckout: string | undefined;
    let restored = false;
    if (goal.final_pr_number) {
        const pull = await retry(() => operations.readPullRequest(goal.repository, goal.final_pr_number!));
        if (pull?.merged) {
            Object.assign(updates, FRESH_BRANCH);
        } else if (!pull || pull.state !== 'open') {
            Object.assign(updates, { final_pr_number: null, final_pr_url: null });
        } else if (!pull.draft) {
            await assertCurrent();
            await retry(() => operations.convertToDraft(pull.nodeId, assertCurrent));
        }
    }
    await assertCurrent();
    const keepsBranch = !('branch_name' in updates);
    if (keepsBranch && hasSavedWorktree(goal) && !isDirectory(goal.worktree_path)) {
        const rebuilt = await retry(() => operations.rebuildWorktree({
            ...goal, worktree_path: goal.worktree_path, branch_name: goal.branch_name,
        }, assertCurrent));
        if (rebuilt === null) Object.assign(updates, FRESH_BRANCH);
        else {
            restored = true;
            updates.worktree_path = rebuilt;
        }
    }
    if ('branch_name' in updates && hasSavedWorktree(goal) && isDirectory(goal.worktree_path)) {
        // Recheck authority after remote reads, before mutating the saved checkout.
        await assertCurrent();
        await operations.cleanupWorktree({ ...goal, worktree_path: goal.worktree_path, branch_name: goal.branch_name }, assertCurrent);
        preservedCheckout = `ProPR preserved the previous checkout at ${JSON.stringify(goal.worktree_path)} (previous branch ${JSON.stringify(goal.branch_name)}). Inspect it for uncommitted or unpublished work worth recovering onto the fresh branch.`;
    }
    if (Object.keys(updates).length === 0) return goal;
    await db.transaction(async trx => {
        const changed = await trx('goals').where({
            goal_id: job.goalId, current_task_id: job.taskId, run_generation: job.generation, run_claim: job.claimId,
        }).whereNull('result_state').update(updates);
        if (changed !== 1) throw new Error('Continued goal preparation lost its attempt claim');
        if (restored) await recordRestorationNotice(trx, goal);
        if (preservedCheckout) {
            const input = await trx('goal_inputs').where({ goal_id: job.goalId, operation: 'goal.continue', state: 'pending' })
                .orderBy('sequence', 'desc').first('input_id', 'message');
            if (input) await trx('goal_inputs').where({ input_id: input.input_id }).update({ message: `${input.message}\n\n${preservedCheckout}` });
        }
    });
    const updated = await fencedGoal(job);
    if (!updated) throw new Error('Continued goal preparation lost its attempt claim');
    return updated;
}

/** Recovery rotates attempt generations, but the accepted continuation stays the same. */
export async function continuedGoalBootstrapId(goal: GoalRow): Promise<string> {
    const input = await db('goal_inputs').where({ goal_id: goal.goal_id, owner_id: goal.owner_id, operation: 'goal.continue' })
        .orderBy('sequence', 'desc').first('input_id');
    return `goal-bootstrap:${goal.goal_id}:${input?.input_id ?? goal.run_generation}`;
}

const defaultContinuationOperations: GoalContinuationOperations = {
    async readPullRequest(repository, number) {
        const [owner, repo] = repository.split('/');
        const octokit = await getAuthenticatedOctokit();
        try {
            const { data } = await octokit.request('GET /repos/{owner}/{repo}/pulls/{pull_number}', {
                owner, repo, pull_number: number,
            });
            return {
                state: data.state,
                merged: Boolean(data.merged || data.merged_at),
                draft: Boolean(data.draft),
                nodeId: data.node_id,
            };
        } catch (error) {
            if ((error as { status?: number }).status === 404) return null;
            throw error;
        }
    },
    async convertToDraft(nodeId, assertCurrent) {
        const octokit = await getAuthenticatedOctokit();
        await assertCurrent();
        await octokit.graphql(
            'mutation($id: ID!) { convertPullRequestToDraft(input: { pullRequestId: $id }) { pullRequest { isDraft } } }',
            { id: nodeId },
        );
    },
    async cleanupWorktree(goal, assertCurrent) {
        // Use the shared storage policy: unique local work must remain recoverable.
        const [owner, repoName] = goal.repository.split('/');
        const octokit = await getAuthenticatedOctokit();
        const token = await octokit.auth({ type: 'installation' }) as { token: string };
        await assertCurrent();
        const localRepoPath = await ensureRepoCloned({
            repoUrl: getRepoUrl({ repoOwner: owner, repoName }), owner, repoName,
            authToken: token.token, ...(goal.base_branch ? { baseBranch: goal.base_branch } : {}),
        });
        await assertCurrent();
        await cleanupWorktree(localRepoPath, goal.worktree_path, goal.branch_name);
    },
    async rebuildWorktree(goal, assertCurrent) {
        const [owner, repoName] = goal.repository.split('/');
        const octokit = await getAuthenticatedOctokit();
        try {
            await octokit.request('GET /repos/{owner}/{repo}/git/ref/{ref}', {
                owner, repo: repoName, ref: `heads/${goal.branch_name}`,
            });
        } catch (error) {
            if ((error as { status?: number }).status !== 404) throw error;
            // An inaccessible repository also returns 404. Confirm access before
            // treating the missing ref as evidence that published work is gone.
            await octokit.request('GET /repos/{owner}/{repo}', { owner, repo: repoName });
            return null;
        }
        const token = await octokit.auth({ type: 'installation' }) as { token: string };
        await ensureGitRepository(logger as never);
        await assertCurrent();
        const localRepoPath = await ensureRepoCloned({
            repoUrl: getRepoUrl({ repoOwner: owner, repoName }), owner, repoName,
            authToken: token.token, ...(goal.base_branch ? { baseBranch: goal.base_branch } : {}),
        });
        await assertCurrent();
        const worktree = await createWorktreeFromExistingBranch(localRepoPath, goal.branch_name, {
            worktreeDirName: path.basename(goal.worktree_path), owner, repoName,
        });
        return worktree.worktreePath;
    },
};
