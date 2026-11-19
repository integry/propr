import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import knexFactory, { type Knex } from 'knex';
import type { PullRequestStatusFacts } from '../src/services/pullRequestStatus/pullRequestStatus.js';

process.env.PROPR_DEMO_MODE = 'true';

const { closeConnection } = await import('../src/db/connection.js');
const { computePullRequestStatus } = await import('../src/services/pullRequestStatus/pullRequestStatus.js');
const { CI_SUSPENDED_TEXT, renderPullRequestStatusBlock, renderPullRequestStatusLine } = await import('../src/services/pullRequestStatus/pullRequestStatusBlock.js');
const { onlyCheckProgressChanged } = await import('../src/services/pullRequestStatus/pullRequestStatusEditPacing.js');
const { loadCiRunnerProblemFact, loadCiSuspensionFact } = await import('../src/services/pullRequestStatus/pullRequestStatusCiNotes.js');
const { ciInfrastructureNoticeKey } = await import('../src/webhook/ciInfrastructureNotice.js');

const NOW = new Date('2026-11-19T03:40:00Z');
const HEAD = 'abc123';

function facts(overrides: Partial<PullRequestStatusFacts> = {}): PullRequestStatusFacts {
    return {
        pullRequest: { state: 'open', merged: false, headSha: HEAD, mergeable: true },
        isProprPullRequest: true,
        tasks: [{ type: 'pr-comment', mode: 'follow_up', state: 'processing', createdAt: '2026-11-19T03:30:00Z' }],
        queuedJobs: 0,
        ultrafix: null,
        checks: { complete: true, passed: 20, failed: 0, pending: 0, cancelled: 3, cancelledNames: ['unit', 'lint', 'e2e'], failedNames: [] },
        latestReviewScore: null,
        ratingGoal: 8,
        epic: null,
        ...overrides,
    };
}

const line = (overrides: Partial<PullRequestStatusFacts>) => renderPullRequestStatusLine(computePullRequestStatus(facts(overrides)), NOW);

let database: Knex;

before(async () => {
    database = knexFactory({ client: 'better-sqlite3', connection: { filename: ':memory:' }, useNullAsDefault: true });
    await (await import('../src/db/migrations/20260923010000_add_pr_ci_suspensions.js')).up(database);
    await (await import('../src/db/migrations/20260924010000_add_ci_suspension_incarnation.js')).up(database);
});

after(async () => {
    await database.destroy();
    await closeConnection();
});

test('while a follow-up suspends validation, the status line says so and that re-runs have no effect', () => {
    const during = line({ ciSuspension: { cancelledRuns: 3 } });
    assert.equal(during,
        '**ProPR** 🔨 Follow-up in progress · CI suspended until the follow-up finishes, re-running checks before then has no effect'
        + ' · runs cancelled by ProPR: 3 · checks: 20 passed, 3 cancelled · updated Nov 19 03:40 UTC');
    assert.ok(during.includes(CI_SUSPENDED_TEXT));
    // Nothing cancelled yet: the suspension is named, no count.
    assert.equal(line({ ciSuspension: { cancelledRuns: 0 } }).includes('runs cancelled by ProPR'), false);
    assert.ok(line({ ciSuspension: { cancelledRuns: 0 } }).includes(CI_SUSPENDED_TEXT));
});

test('the suspension text disappears when the suspension ends', () => {
    const afterSuspension = line({ tasks: [{ type: 'pr-comment', mode: 'follow_up', state: 'completed', createdAt: '2026-11-19T03:30:00Z' }], checks: { complete: true, passed: 23, failed: 0, pending: 0, failedNames: [] } });
    assert.equal(afterSuspension, '**ProPR** ✅ Ready · checks: 23 passed · updated Nov 19 03:40 UTC');
    assert.equal(line({}).includes('suspended'), false);
});

test('the suspension text survives the block budget, ahead of the check counts', () => {
    const status = computePullRequestStatus(facts({
        ciSuspension: { cancelledRuns: 2 },
        tasks: [{ type: 'pr-comment', mode: 'follow_up', state: 'failed', createdAt: '2026-11-19T03:30:00Z' }],
        checks: { complete: true, passed: 1, failed: 30, pending: 0, failedNames: Array.from({ length: 30 }, (_, index) => `${'very long check name '.repeat(3)}${index}`) },
    }));
    const block = renderPullRequestStatusBlock(status, NOW)!;
    assert.ok(block.length <= 512);
    assert.ok(block.includes(CI_SUSPENDED_TEXT));
});

test('a change of the suspension cancel count alone is paced like check progress; the suspension starting or ending is not', () => {
    const body = (overrides: Partial<PullRequestStatusFacts>) => `${renderPullRequestStatusBlock(computePullRequestStatus(facts(overrides)), NOW)}\n\nBody`;
    assert.equal(onlyCheckProgressChanged(body({ ciSuspension: { cancelledRuns: 1 } }), body({ ciSuspension: { cancelledRuns: 2 } })), true);
    assert.equal(onlyCheckProgressChanged(body({}), body({ ciSuspension: { cancelledRuns: 0 } })), false);
    assert.equal(onlyCheckProgressChanged(body({ ciSuspension: { cancelledRuns: 2 } }), body({})), false);
});

test('a runner-problem failure names the job and what ProPR did instead of a code follow-up', () => {
    const failed = { complete: true, passed: 20, failed: 1, pending: 0, failedNames: ['Validate Changes'] };
    const idle = { tasks: [] as PullRequestStatusFacts['tasks'], checks: failed };
    assert.equal(line({ ...idle, ciRunnerProblem: { job: 'Validate Changes', action: 'rerun_unavailable' } }),
        '**ProPR** ⚠️ Needs you · failed: Validate Changes · Validate Changes failed on what looks like a runner problem, re-run it'
        + ' · checks: 20 passed, 1 failed · updated Nov 19 03:40 UTC');
    assert.ok(line({ ...idle, ciRunnerProblem: { job: 'Validate Changes', action: 'rerun_deferred' } })
        .includes('runner problem in Validate Changes, re-run when its workflow finishes'));
    const rerunning = line({ tasks: [], checks: { complete: true, passed: 20, failed: 0, pending: 1, failedNames: [] }, ciRunnerProblem: { job: 'Validate Changes', action: 'rerun_requested' } });
    assert.equal(rerunning, '**ProPR** 🔨 Waiting for CI · runner problem in Validate Changes, re-run requested · checks: 20 passed, 1 pending · updated Nov 19 03:40 UTC');
    // Once the re-run passed, the pull request is ready and the note says nothing more.
    assert.equal(line({ tasks: [], checks: { complete: true, passed: 21, failed: 0, pending: 0, failedNames: [] }, ciRunnerProblem: { job: 'Validate Changes', action: 'rerun_requested' } }),
        '**ProPR** ✅ Ready · checks: 21 passed · updated Nov 19 03:40 UTC');
});

test('the suspension fact is read from the active suspension of the current head only', async () => {
    const row = {
        repository: 'integry/propr', pull_request: 3648, head_sha: HEAD, task_id: 'task-1', state: 'active',
        cancelled_runs: JSON.stringify([{ id: 1 }, { id: 2, restarted: true }, { id: 3 }]),
        attempts: 0, generation: 1, incarnation: 'i', created_at: 1, updated_at: 1,
    };
    await database('pr_ci_suspensions').insert(row);
    assert.deepEqual(await loadCiSuspensionFact(database, 'Integry/ProPR', 3648, HEAD), { cancelledRuns: 2 });
    assert.equal(await loadCiSuspensionFact(database, 'integry/propr', 3648, 'newer-head'), null);
    assert.equal(await loadCiSuspensionFact(database, 'integry/propr', 3649, HEAD), null);
    await database('pr_ci_suspensions').where({ pull_request: 3648 }).update({ state: 'restoring' });
    assert.equal(await loadCiSuspensionFact(database, 'integry/propr', 3648, HEAD), null, 'restoring: re-runs are no longer cancelled');
    await database('pr_ci_suspensions').where({ pull_request: 3648 }).delete();
    assert.equal(await loadCiSuspensionFact(database, 'integry/propr', 3648, HEAD), null, 'ended: the row is gone');
});

test('an unreadable suspension or notice record leaves the note out instead of failing the status', async () => {
    const broken = knexFactory({ client: 'better-sqlite3', connection: { filename: ':memory:' }, useNullAsDefault: true });
    try {
        assert.equal(await loadCiSuspensionFact(broken, 'integry/propr', 1, HEAD), null);
    } finally {
        await broken.destroy();
    }
    assert.equal(await loadCiRunnerProblemFact({ get: async () => { throw new Error('down'); } }, 'integry/propr', 1, HEAD), null);
});

test('the runner-problem fact is read for the current head only', async () => {
    const values = new Map([[ciInfrastructureNoticeKey('integry/propr', 3699), JSON.stringify({
        headSha: HEAD, job: 'Validate Changes', runId: 7, runAttempt: 1, action: 'rerun_requested', at: 1,
    })]]);
    const redis = { get: async (key: string) => values.get(key) ?? null };
    assert.deepEqual(await loadCiRunnerProblemFact(redis, 'integry/propr', 3699, HEAD), { job: 'Validate Changes', action: 'rerun_requested' });
    assert.equal(await loadCiRunnerProblemFact(redis, 'integry/propr', 3699, 'pushed-since'), null);
    assert.equal(await loadCiRunnerProblemFact(null, 'integry/propr', 3699, HEAD), null);
});
