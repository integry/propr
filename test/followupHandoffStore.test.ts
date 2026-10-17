import { after, describe, mock, test } from 'node:test';
import assert from 'node:assert/strict';
import knex from 'knex';
import { up } from '../packages/core/src/db/migrations/20261017000000_create_followup_publication_handoffs.js';

const database = knex({ client: 'better-sqlite3', connection: { filename: ':memory:' }, useNullAsDefault: true });
await up(database);

const warnings: string[] = [];
await mock.module('@propr/core', {
    namedExports: {
        db: database,
        logger: { warn: (_meta: object, message: string) => warnings.push(message) },
    },
});

const {
    advanceFollowupHandoffPhase,
    beginFollowupHandoff,
    claimFollowupHandoffSuccessor,
    closeFollowupHandoffForAttempt,
    completeFollowupHandoff,
    decideFollowupHandoffRecovery,
    findOpenFollowupHandoff,
    parseClaimedHandoffComments,
    FOLLOWUP_HANDOFF_PHASES,
} = await import('../src/jobs/followupHandoffStore.js');

const ref = { repoOwner: 'Integry', repoName: 'Propr', pullRequestNumber: 265 };

function beginInput(taskId: string) {
    return {
        taskId, ref, branchName: 'feature/fix', worktreePath: `/worktrees/${taskId}`,
        localRepoPath: '/clones/integry/propr', baseBranch: 'main', expectedHeadSha: 'a'.repeat(40),
        claimedComments: [{ id: 7, body: 'please fix', author: 'integry', type: 'issue' as const }],
        lockKey: 'lock:pr:integry:propr:265', lockTokenHash: 'token-hash',
    };
}

after(() => database.destroy());

describe('follow-up handoff ledger', () => {
    test('persists before execution and binds task, PR, worktree, comments and lock', async () => {
        await beginFollowupHandoff(beginInput('task-1'));
        const found = await findOpenFollowupHandoff(ref);
        assert.equal(found?.task_id, 'task-1');
        assert.equal(found?.repository, 'integry/propr');
        assert.equal(found?.phase, 'agent-pending');
        assert.equal(found?.branch_name, 'feature/fix');
        assert.equal(found?.worktree_path, '/worktrees/task-1');
        assert.equal(found?.lock_key, 'lock:pr:integry:propr:265');
        assert.equal(found?.lock_token_hash, 'token-hash');
        assert.equal(found?.container_label, 'propr.task.id=task-1');
        assert.deepEqual(parseClaimedHandoffComments(found!).map(c => c.id), [7]);
    });

    test('phases advance monotonically and never regress', async () => {
        assert.equal(await advanceFollowupHandoffPhase('task-1', 'agent-running'), true);
        assert.equal(await advanceFollowupHandoffPhase('task-1', 'committed', { commitHash: 'b'.repeat(40) }), true);
        // A duplicate or late pass cannot move the record backwards.
        assert.equal(await advanceFollowupHandoffPhase('task-1', 'agent-running'), false);
        assert.equal(await advanceFollowupHandoffPhase('task-1', 'committed'), false);
        const found = await findOpenFollowupHandoff(ref);
        assert.equal(found?.phase, 'committed');
        assert.equal(found?.commit_hash, 'b'.repeat(40));
    });

    test('successor claim is a fence: one owner, idempotent for itself, no overwrite', async () => {
        assert.equal(await claimFollowupHandoffSuccessor('task-1', 'successor-a'), true);
        assert.equal(await claimFollowupHandoffSuccessor('task-1', 'successor-a'), true);
        assert.equal(await claimFollowupHandoffSuccessor('task-1', 'successor-b'), false);
        const found = await findOpenFollowupHandoff(ref);
        assert.equal(found?.successor_task_id, 'successor-a');
    });

    test('a successful attempt only retires a fully published handoff', async () => {
        await closeFollowupHandoffForAttempt('task-1', true);
        assert.equal((await findOpenFollowupHandoff(ref))?.task_id, 'task-1');

        await advanceFollowupHandoffPhase('task-1', 'comment-published');
        await closeFollowupHandoffForAttempt('task-1', true);
        assert.equal(await findOpenFollowupHandoff(ref), undefined);
    });

    test('a failed attempt closes its handoff because the failure was published', async () => {
        await beginFollowupHandoff(beginInput('task-2'));
        await advanceFollowupHandoffPhase('task-2', 'agent-exited');
        await closeFollowupHandoffForAttempt('task-2', false);
        assert.equal(await findOpenFollowupHandoff(ref), undefined);
        const row = await database('followup_publication_handoffs').where({ task_id: 'task-2' }).first();
        assert.equal(row.next_action, 'attempt_closed_without_publication');
    });

    test('completeFollowupHandoff records the terminal phase and next action', async () => {
        await beginFollowupHandoff(beginInput('task-3'));
        await completeFollowupHandoff('task-3', 'finalized_published_predecessor');
        assert.equal(await findOpenFollowupHandoff(ref), undefined);
    });

    test('a retry of the same attempt starts its handoff over', async () => {
        await beginFollowupHandoff(beginInput('task-4'));
        await advanceFollowupHandoffPhase('task-4', 'pushed', { commitHash: 'c'.repeat(40) });
        await beginFollowupHandoff(beginInput('task-4'));
        const found = await findOpenFollowupHandoff(ref);
        assert.equal(found?.phase, 'agent-pending');
        assert.equal(found?.successor_task_id, null);
        await completeFollowupHandoff('task-4');
    });

    test('ledger failures never throw into the publication path', async () => {
        await database.schema.renameTable('followup_publication_handoffs', 'followup_publication_handoffs_hidden');
        try {
            await beginFollowupHandoff(beginInput('task-5'));
            assert.equal(await findOpenFollowupHandoff(ref), undefined);
            assert.equal(await advanceFollowupHandoffPhase('task-5', 'pushed'), false);
            assert.equal(await claimFollowupHandoffSuccessor('task-5', 'x'), false);
            await closeFollowupHandoffForAttempt('task-5', true);
            assert.ok(warnings.length > 0);
        } finally {
            await database.schema.renameTable('followup_publication_handoffs_hidden', 'followup_publication_handoffs');
        }
    });
});

describe('follow-up handoff recovery decision', () => {
    const handoff = (phase: string) => ({ phase: phase as typeof FOLLOWUP_HANDOFF_PHASES[number], task_id: 'task-old' });
    const input = (overrides: object) => ({
        handoff: handoff('agent-running'),
        containerLiveness: 'not_found' as const,
        predecessorTaskState: 'processing',
        predecessorCancelledByUser: false,
        explicitRecoveryRequested: false,
        ...overrides,
    });

    test('no open handoff is ignored', () => {
        assert.deepEqual(decideFollowupHandoffRecovery(input({ handoff: undefined })), { action: 'ignore' });
        assert.deepEqual(decideFollowupHandoffRecovery(input({ handoff: handoff('cleanup-complete') })), { action: 'ignore' });
    });

    test('a live exact labelled container is never raced', () => {
        assert.deepEqual(decideFollowupHandoffRecovery(input({ containerLiveness: 'running' })),
            { action: 'wait', reason: 'container_running' });
    });

    test('an uninspectable container fails closed', () => {
        assert.deepEqual(decideFollowupHandoffRecovery(input({ containerLiveness: 'unavailable' })),
            { action: 'wait', reason: 'container_inspection_unavailable' });
    });

    test('user cancellation stays authoritative until an explicit /recover', () => {
        const blocked = decideFollowupHandoffRecovery(input({ predecessorTaskState: 'cancelled', predecessorCancelledByUser: true }));
        assert.equal(blocked.action, 'operator');
        const authorized = decideFollowupHandoffRecovery(input({
            predecessorTaskState: 'cancelled', predecessorCancelledByUser: true, explicitRecoveryRequested: true,
        }));
        assert.equal(authorized.action, 'adopt');
    });

    test('a collision-cancelled predecessor with a vanished container is adopted', () => {
        const decision = decideFollowupHandoffRecovery(input({ predecessorTaskState: 'cancelled', containerLiveness: 'not_found' }));
        assert.deepEqual(decision, { action: 'adopt', fromPhase: 'agent-running' });
    });

    test('a stopped container is as recoverable as a vanished one', () => {
        assert.equal(decideFollowupHandoffRecovery(input({ containerLiveness: 'stopped' })).action, 'adopt');
    });

    test('published predecessors only need cleanup finished', () => {
        assert.deepEqual(decideFollowupHandoffRecovery(input({ predecessorTaskState: 'completed' })), { action: 'finalize' });
        assert.deepEqual(decideFollowupHandoffRecovery(input({ handoff: handoff('comment-published') })), { action: 'finalize' });
    });

    test('every pre-publication crash boundary resumes finalization', () => {
        for (const phase of ['agent-pending', 'agent-running', 'agent-exited', 'changes-inspected', 'committed', 'pushed'] as const) {
            assert.deepEqual(decideFollowupHandoffRecovery(input({ handoff: handoff(phase) })), { action: 'adopt', fromPhase: phase });
        }
    });
});
