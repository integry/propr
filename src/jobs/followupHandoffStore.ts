import type { UnprocessedComment } from '@propr/core';

/**
 * Durable follow-up execution/publication handoff ledger.
 *
 * A row is written before a follow-up's agent container starts and advanced
 * through every publication phase, so a worker restart at any boundary leaves
 * enough state behind for a later delivery to adopt the retained worktree and
 * finish commit/push/result publication instead of stranding the branch.
 *
 * Every operation here is deliberately non-fatal: the ledger must never turn a
 * healthy publication into a failure. Reads return nothing on storage errors,
 * so recovery simply does not trigger when the ledger is unavailable.
 */

export const FOLLOWUP_HANDOFF_PHASES = [
    'agent-pending',
    'agent-running',
    'agent-exited',
    'changes-inspected',
    'committed',
    'pushed',
    'comment-published',
    'cleanup-complete',
] as const;

export type FollowupHandoffPhase = typeof FOLLOWUP_HANDOFF_PHASES[number];

const TABLE = 'followup_publication_handoffs';

export interface FollowupHandoffRecord {
    task_id: string;
    repository: string;
    pull_request_number: number;
    branch_name: string;
    worktree_path: string;
    local_repo_path: string | null;
    base_branch: string | null;
    expected_head_sha: string | null;
    container_label: string | null;
    claimed_comments: string;
    lock_key: string;
    lock_token_hash: string;
    phase: FollowupHandoffPhase;
    successor_task_id: string | null;
    next_action: string | null;
    commit_hash: string | null;
    created_at: number;
    updated_at: number;
}

export interface PullRequestHandoffRef {
    repoOwner: string;
    repoName: string;
    pullRequestNumber: number;
}

export function handoffPhaseRank(phase: string): number {
    return FOLLOWUP_HANDOFF_PHASES.indexOf(phase as FollowupHandoffPhase);
}

const repositoryKey = (ref: PullRequestHandoffRef) => `${ref.repoOwner}/${ref.repoName}`.toLowerCase();

interface LedgerWhereBuilder {
    whereNull(column: string): { orWhere(criteria: object): unknown };
}

interface LedgerQuery {
    insert(row: object): { onConflict(column: string): { merge(): Promise<unknown> } };
    where(criteria: object): LedgerQuery;
    whereNot(criteria: object): LedgerQuery;
    andWhere(builder: (this: LedgerWhereBuilder, b: LedgerWhereBuilder) => void): LedgerQuery;
    orderBy(column: string, direction: 'asc' | 'desc'): LedgerQuery;
    first(): Promise<unknown>;
    update(patch: object): Promise<number>;
}

type LedgerDb = (table: string) => LedgerQuery;

// Imported lazily so this ledger stays inert — not a link error — wherever the
// core module is substituted without a database binding.
async function core(): Promise<{
    db?: LedgerDb;
    logger?: { warn: (meta: object, msg: string) => void };
    hashTaskAttemptToken?: (token: string) => string;
}> {
    return await import('@propr/core') as never;
}

async function withLedger<T>(operation: string, fallback: T, work: (db: LedgerDb) => Promise<T>): Promise<T> {
    try {
        const { db } = await core();
        if (!db) return fallback;
        return await work(db);
    } catch (error) {
        try {
            (await core()).logger?.warn({ operation, error: (error as Error).message }, 'Follow-up handoff ledger operation failed; continuing without it');
        } catch { /* the ledger must never fail the publication path */ }
        return fallback;
    }
}

export interface BeginFollowupHandoffInput {
    taskId: string;
    ref: PullRequestHandoffRef;
    branchName: string;
    worktreePath: string;
    localRepoPath?: string;
    baseBranch?: string;
    expectedHeadSha?: string;
    claimedComments: UnprocessedComment[];
    lockKey: string;
    lockTokenHash: string;
}

/** Persist the handoff before agent execution; a retry of the same attempt starts over. */
export async function beginFollowupHandoff(input: BeginFollowupHandoffInput): Promise<void> {
    await withLedger('begin', undefined, async db => {
        const now = Date.now();
        await db(TABLE).insert({
            task_id: input.taskId,
            repository: repositoryKey(input.ref),
            pull_request_number: input.ref.pullRequestNumber,
            branch_name: input.branchName,
            worktree_path: input.worktreePath,
            local_repo_path: input.localRepoPath ?? null,
            base_branch: input.baseBranch ?? null,
            expected_head_sha: input.expectedHeadSha ?? null,
            container_label: `propr.task.id=${input.taskId}`,
            claimed_comments: JSON.stringify(input.claimedComments),
            lock_key: input.lockKey,
            lock_token_hash: input.lockTokenHash,
            phase: 'agent-pending',
            successor_task_id: null,
            next_action: null,
            commit_hash: null,
            created_at: now,
            updated_at: now,
        }).onConflict('task_id').merge();
    });
}

interface FollowupHandoffExecutionState {
    worktreeInfo?: { worktreePath: string; branchName: string };
    localRepoPath?: string;
    repositoryWorkflowBaseBranch?: string;
    unprocessedComments: UnprocessedComment[];
}

/** Persists the durable handoff right before agent execution starts. */
export async function recordFollowupHandoffBeforeAgent(
    params: { taskId: string; context: PullRequestHandoffRef; state: FollowupHandoffExecutionState; lockKey: string; lockToken: string },
    expectedHeadSha: string | undefined,
): Promise<void> {
    const { taskId, context, state, lockKey, lockToken } = params;
    if (!state.worktreeInfo) return;
    const hash = (await core().catch(() => undefined))?.hashTaskAttemptToken;
    await beginFollowupHandoff({
        taskId, ref: context,
        branchName: state.worktreeInfo.branchName, worktreePath: state.worktreeInfo.worktreePath,
        localRepoPath: state.localRepoPath, baseBranch: state.repositoryWorkflowBaseBranch,
        expectedHeadSha, claimedComments: state.unprocessedComments,
        lockKey, lockTokenHash: hash ? hash(lockToken) : 'unhashed-token-withheld',
    });
}

/** Monotonic: never regresses a later phase, so duplicate recovery passes are no-ops. */
export async function advanceFollowupHandoffPhase(
    taskId: string,
    phase: FollowupHandoffPhase,
    patch: { commitHash?: string; nextAction?: string | null } = {},
): Promise<boolean> {
    return withLedger('advance', false, async db => {
        const row = await db(TABLE).where({ task_id: taskId }).first() as FollowupHandoffRecord | undefined;
        if (!row || handoffPhaseRank(row.phase) >= handoffPhaseRank(phase)) return false;
        const updated = await db(TABLE).where({ task_id: taskId, phase: row.phase }).update({
            phase,
            updated_at: Date.now(),
            ...(patch.commitHash !== undefined ? { commit_hash: patch.commitHash } : {}),
            ...(patch.nextAction !== undefined ? { next_action: patch.nextAction } : {}),
        });
        return updated > 0;
    });
}

/** Latest handoff for this PR that has not finished cleanup, if any. */
export async function findOpenFollowupHandoff(ref: PullRequestHandoffRef): Promise<FollowupHandoffRecord | undefined> {
    return withLedger('find', undefined, async db =>
        await db(TABLE)
            .where({ repository: repositoryKey(ref), pull_request_number: ref.pullRequestNumber })
            .whereNot({ phase: 'cleanup-complete' })
            .orderBy('updated_at', 'desc')
            .first() as FollowupHandoffRecord | undefined);
}

/**
 * Durable successor fencing: only one attempt may adopt a handoff. The same
 * successor may re-claim after its own crash; a different live successor is
 * refused without deleting anyone's ownership.
 */
export async function claimFollowupHandoffSuccessor(taskId: string, successorTaskId: string): Promise<boolean> {
    return withLedger('claim', false, async db => {
        const updated = await db(TABLE)
            .where({ task_id: taskId })
            .andWhere(builder => { builder.whereNull('successor_task_id').orWhere({ successor_task_id: successorTaskId }); })
            .update({ successor_task_id: successorTaskId, updated_at: Date.now() });
        return updated > 0;
    });
}

export async function recordFollowupHandoffNextAction(taskId: string, nextAction: string): Promise<void> {
    await withLedger('next-action', undefined, async db => {
        await db(TABLE).where({ task_id: taskId }).update({ next_action: nextAction, updated_at: Date.now() });
    });
}

export async function completeFollowupHandoff(taskId: string, nextAction: string | null = null): Promise<void> {
    await withLedger('complete', undefined, async db => {
        await db(TABLE).where({ task_id: taskId }).update({
            phase: 'cleanup-complete', next_action: nextAction, updated_at: Date.now(),
        });
    });
}

/**
 * Attempt teardown. A successful attempt only retires a fully published
 * handoff: anything earlier means this run was rescheduled or skipped and the
 * open handoff may still be owed recovery. A failed attempt already published
 * its failure, so its handoff closes without inviting adoption.
 */
export async function closeFollowupHandoffForAttempt(taskId: string, success: boolean): Promise<void> {
    await withLedger('close', undefined, async db => {
        const row = await db(TABLE).where({ task_id: taskId }).first() as FollowupHandoffRecord | undefined;
        if (!row || row.phase === 'cleanup-complete') return;
        if (success && handoffPhaseRank(row.phase) < handoffPhaseRank('comment-published')) return;
        await db(TABLE).where({ task_id: taskId }).update({
            phase: 'cleanup-complete',
            next_action: success ? null : 'attempt_closed_without_publication',
            updated_at: Date.now(),
        });
    });
}

export function parseClaimedHandoffComments(record: Pick<FollowupHandoffRecord, 'claimed_comments'>): UnprocessedComment[] {
    try {
        const parsed = JSON.parse(record.claimed_comments) as UnprocessedComment[];
        return Array.isArray(parsed) ? parsed : [];
    } catch {
        return [];
    }
}

export interface FollowupHandoffRecoveryInput {
    handoff: Pick<FollowupHandoffRecord, 'phase' | 'task_id'> | undefined;
    containerLiveness: 'running' | 'stopped' | 'not_found' | 'unavailable';
    predecessorTaskState: string | null;
    predecessorCancelledByUser: boolean;
    explicitRecoveryRequested: boolean;
}

export type FollowupHandoffRecoveryDecision =
    | { action: 'ignore' }
    | { action: 'wait'; reason: 'container_running' | 'container_inspection_unavailable' }
    | { action: 'operator'; nextAction: string }
    | { action: 'finalize' }
    | { action: 'adopt'; fromPhase: FollowupHandoffPhase };

export const FOLLOWUP_HANDOFF_OPERATOR_ACTION =
    'Post a `/recover` comment on the pull request to adopt and publish the retained work, or review the retained worktree manually. Nothing is removed automatically.';

/**
 * What a new owner of the PR lease may do with an open predecessor handoff.
 * A live (or uninspectable) container is never raced; a user cancellation is
 * authoritative and needs an explicit `/recover`; a predecessor that already
 * published only needs its cleanup finished; everything else is adopted.
 */
export function decideFollowupHandoffRecovery(input: FollowupHandoffRecoveryInput): FollowupHandoffRecoveryDecision {
    const { handoff } = input;
    if (!handoff || handoff.phase === 'cleanup-complete') return { action: 'ignore' };
    if (input.containerLiveness === 'running') return { action: 'wait', reason: 'container_running' };
    if (input.containerLiveness === 'unavailable') return { action: 'wait', reason: 'container_inspection_unavailable' };
    if (input.predecessorCancelledByUser && !input.explicitRecoveryRequested) {
        return { action: 'operator', nextAction: FOLLOWUP_HANDOFF_OPERATOR_ACTION };
    }
    if (input.predecessorTaskState === 'completed' || handoffPhaseRank(handoff.phase) >= handoffPhaseRank('comment-published')) {
        return { action: 'finalize' };
    }
    return { action: 'adopt', fromPhase: handoff.phase };
}
