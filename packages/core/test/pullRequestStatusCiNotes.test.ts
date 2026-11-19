import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import knexFactory, { type Knex } from 'knex';
import type { PullRequestStatusFacts } from '../src/services/pullRequestStatus/pullRequestStatus.js';

process.env.PROPR_DEMO_MODE = 'true';

const { closeConnection } = await import('../src/db/connection.js');
const { computePullRequestStatus } = await import('../src/services/pullRequestStatus/pullRequestStatus.js');
const { CI_SUSPENDED_TEXT, renderPullRequestStatusBlock, renderPullRequestStatusLine, runnerProblemText } = await import('../src/services/pullRequestStatus/pullRequestStatusBlock.js');
const { onlyCheckProgressChanged } = await import('../src/services/pullRequestStatus/pullRequestStatusEditPacing.js');
const { loadCiRunnerProblemFact, loadCiSuspensionFact } = await import('../src/services/pullRequestStatus/pullRequestStatusCiNotes.js');

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

test('a runner-problem failure names the job and says re-running the failed jobs is the fix', () => {
    const failed = { complete: true, passed: 20, failed: 1, pending: 0, failedNames: ['Validate Changes'] };
    const idle = { tasks: [] as PullRequestStatusFacts['tasks'], checks: failed };
    assert.equal(line({ ...idle, ciRunnerProblem: { jobs: ['Validate Changes'] } }),
        '**ProPR** ⚠️ Needs you · failed: Validate Changes · Validate Changes failed on what looks like a runner or network problem, re-run the failed jobs'
        + ' · checks: 20 passed, 1 failed · updated Nov 19 03:40 UTC');
    assert.equal(runnerProblemText({ jobs: ['unit', 'e2e', 'lint'] }), 'unit, e2e +1 failed on what looks like a runner or network problem, re-run the failed jobs');
    // Once the checks no longer fail (a re-run passed), the pull request is ready and the note says nothing more.
    assert.equal(line({ tasks: [], checks: { complete: true, passed: 21, failed: 0, pending: 0, failedNames: [] }, ciRunnerProblem: { jobs: ['Validate Changes'] } }),
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

test('an unreadable suspension record leaves the note out instead of failing the status', async () => {
    const broken = knexFactory({ client: 'better-sqlite3', connection: { filename: ':memory:' }, useNullAsDefault: true });
    try {
        assert.equal(await loadCiSuspensionFact(broken, 'integry/propr', 1, HEAD), null);
    } finally {
        await broken.destroy();
    }
});

const OWNER = 'integry';
const REPO = 'propr';
const MIRROR_STALL = { annotation_level: 'failure', path: '.github', message: 'Chromium install timed out on every attempt.' };
const EXIT = { annotation_level: 'failure', path: '.github', message: 'Process completed with exit code 1.' };

function failedRun(id: number, name: string, overrides: Record<string, unknown> = {}) {
    return {
        id, name, conclusion: 'failure', appSlug: 'github-actions',
        detailsUrl: `https://github.com/integry/propr/actions/runs/44288180457/job/${id}`,
        output: { title: null, summary: null, text: null, annotations_count: 2 },
        ...overrides,
    };
}

/** GitHub with per-check annotations and failed steps; records every route asked. */
function fakeGitHub(byJob: Record<number, { annotations?: unknown[] | Error; steps?: Array<{ name: string; conclusion: string }> }>) {
    const routes: string[] = [];
    return {
        routes,
        request: async (route: string, params: Record<string, unknown>) => {
            routes.push(route);
            if (route === 'GET /repos/{owner}/{repo}/check-runs/{check_run_id}/annotations') {
                const annotations = byJob[Number(params.check_run_id)]?.annotations ?? [];
                if (annotations instanceof Error) throw annotations;
                return { data: annotations };
            }
            if (route === 'GET /repos/{owner}/{repo}/actions/jobs/{job_id}') {
                return { data: { id: params.job_id, steps: byJob[Number(params.job_id)]?.steps ?? [] } };
            }
            throw new Error(`unexpected ${route}`);
        },
    };
}

const INSTALL_FAILED = [{ name: 'Set up job', conclusion: 'success' }, { name: 'Run ./scripts/ci-install-chromium.sh', conclusion: 'failure' }];

test('the runner-problem fact names the failed checks of the head that look like a runner problem, and asks GitHub for no re-run', async () => {
    const github = fakeGitHub({
        101: { annotations: [MIRROR_STALL, EXIT], steps: INSTALL_FAILED },
        102: { annotations: [{ annotation_level: 'failure', path: 'test/a.test.ts', message: 'AssertionError: expected 1 to equal 2' }, EXIT], steps: [{ name: 'Run npm test', conclusion: 'failure' }] },
    });
    const fact = await loadCiRunnerProblemFact(github, OWNER, REPO, [failedRun(101, 'Validate Changes'), failedRun(102, 'unit')]);
    assert.deepEqual(fact, { jobs: ['Validate Changes'] });
    assert.equal(github.routes.some(route => !route.startsWith('GET ')), false, 'read-only: no re-run request');
    // The text the status block renders from it names the job.
    assert.ok(line({ tasks: [], checks: { complete: true, passed: 1, failed: 2, pending: 0, failedNames: ['Validate Changes', 'unit'] }, ciRunnerProblem: fact })
        .includes('Validate Changes failed on what looks like a runner or network problem, re-run the failed jobs'));
});

test('a code failure, an unreadable check or no failed check leaves the runner-problem note out', async () => {
    assert.equal(await loadCiRunnerProblemFact(fakeGitHub({}), OWNER, REPO, []), null);
    // A network error in a test step is the code's.
    assert.equal(await loadCiRunnerProblemFact(fakeGitHub({ 101: { annotations: [MIRROR_STALL], steps: [{ name: 'Run Playwright tests', conclusion: 'failure' }] } }),
        OWNER, REPO, [failedRun(101, 'e2e')]), null);
    // Unreadable annotations are no evidence.
    assert.equal(await loadCiRunnerProblemFact(fakeGitHub({ 101: { annotations: new Error('Service Unavailable'), steps: INSTALL_FAILED } }),
        OWNER, REPO, [failedRun(101, 'Validate Changes')]), null);
    // No infrastructure signature: the job is not even read.
    const quiet = fakeGitHub({ 101: { annotations: [EXIT], steps: INSTALL_FAILED } });
    assert.equal(await loadCiRunnerProblemFact(quiet, OWNER, REPO, [failedRun(101, 'Validate Changes')]), null);
    assert.equal(quiet.routes.includes('GET /repos/{owner}/{repo}/actions/jobs/{job_id}'), false);
    // Checks of other apps have no Actions job; a broadly failing head is not read check by check.
    const other = fakeGitHub({ 101: { annotations: [MIRROR_STALL], steps: INSTALL_FAILED } });
    assert.equal(await loadCiRunnerProblemFact(other, OWNER, REPO, [failedRun(101, 'ci/external', { appSlug: 'circleci-checks' })]), null);
    assert.deepEqual(other.routes, []);
    const many = Array.from({ length: 6 }, (_, index) => failedRun(200 + index, `job-${index}`));
    const broad = fakeGitHub({});
    assert.equal(await loadCiRunnerProblemFact(broad, OWNER, REPO, many), null);
    assert.deepEqual(broad.routes, []);
});
