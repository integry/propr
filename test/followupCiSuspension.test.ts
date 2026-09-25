import assert from 'node:assert/strict';
import { after, beforeEach, describe, mock, test } from 'node:test';
import knex from 'knex';
import { readFile } from 'node:fs/promises';
import { up } from '../packages/core/src/db/migrations/20260923010000_add_pr_ci_suspensions.js';
import { up as createLeases } from '../packages/core/src/db/migrations/20260923020000_add_pr_ci_suspension_leases.js';

const database = knex({ client: 'better-sqlite3', connection: { filename: ':memory:' }, useNullAsDefault: true });
await up(database);
await createLeases(database);
await (await import('../packages/core/src/db/migrations/20260924010000_add_ci_suspension_incarnation.js')).up(database);

await mock.module('@propr/core', {
    namedExports: {
        db: database,
        logger: { debug: () => undefined, info: () => undefined, warn: () => undefined, error: () => undefined },
        getAuthenticatedOctokit: async () => { throw new Error('the test must inject its own Octokit'); },
        getStateManager: () => ({ getTaskState: async () => null }),
        isCancelCiDuringFollowupEnabledForRepository: async () => true,
        getCancelCiDuringFollowupWorkflowsForRepository: async () => [],
        TaskStates: {
            PENDING: 'pending', PROCESSING: 'processing', CLAUDE_EXECUTION: 'claude_execution',
            POST_PROCESSING: 'post_processing', COMPLETED: 'completed', FAILED: 'failed', CANCELLED: 'cancelled',
        },
    },
});

const {
    beginFollowupCiSuspension,
    createValidationWorkflowPolicy,
    isCancelableValidationRun,
    isEligibleValidationWorkflow,
    loadValidationWorkflowPolicyFromEnv,
    MAX_RESTORE_ATTEMPTS,
    PR_CI_SUSPENSION_LEASES_TABLE,
    PR_CI_SUSPENSIONS_TABLE,
    reconcileFollowupCiSuspensions,
    releaseFollowupCiSuspensionsForTask,
    resolveFollowupCiSuspensionTarget,
    resolveValidationWorkflowPolicy,
    restoreFollowupCiSuspension,
    sweepFollowupCiSuspension,
    VALIDATION_WORKFLOW_ALLOWLIST_ENV,
} = await import('../src/jobs/followupCiSuspension.ts');

const HEAD = 'a'.repeat(40);
const NEW_HEAD = 'b'.repeat(40);
const TARGET = { owner: 'integry', repo: 'propr', pullRequestNumber: 2485 };
const TASK_ID = 'task-2485';
/** The workflow the operator selected in most tests. Everything else is deliberately not selected. */
const VALIDATION_WORKFLOW = { name: 'Build & Lint Check', path: '.github/workflows/pr-build-check.yml' };
const SELECTED_WORKFLOWS = ['pr-build-check.yml'];

interface FakeRun {
    id: number;
    name: string;
    path: string;
    event: string;
    status: string;
    conclusion: string | null;
    head_sha: string;
    workflow_id: number;
    run_attempt: number;
    /** Earlier attempts the run moved past, as GitHub keeps them; a rerun through the fake records the attempt it replaces. */
    attempts?: Record<number, { status: string; conclusion: string | null }>;
    pull_requests: Array<{ number: number }>;
}

interface GitHubOptions {
    /** Runs stay `in_progress` after a cancel request, like GitHub's asynchronous cancellation. */
    asyncCancellation?: boolean;
    cancelStatus?: number;
    /** Fails every cancel request after this many successful ones. */
    failCancelAfter?: number;
    /** HTTP status of those later failures; 500 by default, the ambiguous kind. */
    failCancelStatus?: number;
    rerunStatus?: number;
    /** Runs after the cancel was applied; throwing here simulates a response lost on the way back. */
    onCancel?: (runId: number) => Promise<void>;
    /** Runs instead of the normal rerun handling; throwing simulates a lost rerun response. */
    onRerun?: (runId: number) => Promise<void>;
    /** Runs before every request, so a test can move the head while an operation waits. */
    onRequest?: (route: string) => Promise<void> | void;
    prState?: string;
    /** Fails the pull request lookup itself, the way a repository the installation lost access to answers 404. */
    prStatus?: number;
    /** Fails every individual run lookup, the way the runs of a repository the installation lost access to answer 404. Read per request, so a test can lose access mid-pass. */
    runStatus?: number;
    headSha?: string;
    /** Runs returned per page, to exercise pagination. */
    perPage?: number;
    /** Shared, ordered record of what every coordinator asked GitHub, across clients. */
    journal?: Array<{ coordinator: string; route: string; runId?: number }>;
    coordinator?: string;
}

function run(overrides: Partial<FakeRun> & { id: number }): FakeRun {
    return {
        name: VALIDATION_WORKFLOW.name,
        path: VALIDATION_WORKFLOW.path,
        event: 'pull_request',
        status: 'in_progress',
        conclusion: null,
        head_sha: HEAD,
        workflow_id: overrides.id,
        run_attempt: 1,
        pull_requests: [{ number: TARGET.pullRequestNumber }],
        ...overrides,
    };
}

function createGitHub(runs: FakeRun[], options: GitHubOptions = {}) {
    const calls: Array<{ route: string; runId?: number }> = [];
    let cancels = 0;
    const head = { sha: options.headSha ?? HEAD, state: options.prState ?? 'open' };
    const error = (status: number) => Object.assign(new Error(`status ${status}`), { status });
    const octokit = {
        request: async (route: string, parameters: Record<string, unknown> = {}) => {
            const runId = parameters.run_id as number | undefined;
            calls.push({ route, runId });
            options.journal?.push({ coordinator: options.coordinator ?? 'default', route, runId });
            await options.onRequest?.(route);
            if (route === 'GET /repos/{owner}/{repo}/pulls/{pull_number}') {
                if (options.prStatus) throw error(options.prStatus);
                return { data: { state: head.state, head: { sha: head.sha } } };
            }
            if (route === 'GET /repos/{owner}/{repo}/actions/runs') {
                const matching = runs.filter(candidate => candidate.head_sha === parameters.head_sha);
                const perPage = options.perPage ?? (parameters.per_page as number);
                const page = (parameters.page as number) ?? 1;
                // Snapshots, as GitHub answers: what a run does after it was listed is not visible through the listing.
                return {
                    data: {
                        total_count: matching.length,
                        workflow_runs: matching.slice((page - 1) * perPage, page * perPage).map(candidate => ({ ...candidate })),
                    },
                };
            }
            if (route === 'GET /repos/{owner}/{repo}/actions/runs/{run_id}') {
                if (options.runStatus) throw error(options.runStatus);
                const found = runs.find(candidate => candidate.id === runId);
                if (!found) throw error(404);
                return { data: { ...found } };
            }
            if (route === 'GET /repos/{owner}/{repo}/actions/runs/{run_id}/attempts/{attempt_number}') {
                if (options.runStatus) throw error(options.runStatus);
                const found = runs.find(candidate => candidate.id === runId);
                const attempt = parameters.attempt_number as number;
                if (!found) throw error(404);
                if (attempt === found.run_attempt) return { data: found };
                const earlier = found.attempts?.[attempt];
                if (!earlier) throw error(404);
                return { data: { ...found, run_attempt: attempt, ...earlier } };
            }
            if (route === 'POST /repos/{owner}/{repo}/actions/runs/{run_id}/cancel') {
                if (options.cancelStatus) throw error(options.cancelStatus);
                if (options.failCancelAfter !== undefined && cancels++ >= options.failCancelAfter) throw error(options.failCancelStatus ?? 500);
                const found = runs.find(candidate => candidate.id === runId)!;
                if (!options.asyncCancellation) {
                    found.status = 'completed';
                    found.conclusion = 'cancelled';
                }
                await options.onCancel?.(runId!);
                return { data: {} };
            }
            if (route === 'POST /repos/{owner}/{repo}/actions/runs/{run_id}/rerun') {
                if (options.rerunStatus) throw error(options.rerunStatus);
                if (options.onRerun) await options.onRerun(runId!);
                const found = runs.find(candidate => candidate.id === runId)!;
                found.attempts = { ...found.attempts, [found.run_attempt]: { status: found.status, conclusion: found.conclusion } };
                found.status = 'queued';
                found.conclusion = null;
                found.run_attempt += 1;
                return { data: {} };
            }
            throw new Error(`unexpected route ${route}`);
        },
    };
    return {
        octokit,
        calls,
        head,
        cancelled: () => calls.filter(call => call.route.endsWith('/cancel')).map(call => call.runId),
        rerun: () => calls.filter(call => call.route.endsWith('/rerun')).map(call => call.runId),
    };
}

function deps(github: ReturnType<typeof createGitHub>, overrides: Record<string, unknown> = {}) {
    return {
        octokit: github.octokit,
        database,
        isEnabled: async () => true,
        loadSelectedWorkflows: async () => SELECTED_WORKFLOWS,
        restoreBudgetMs: 0,
        pollIntervalMs: 0,
        sleep: async () => undefined,
        ...overrides,
    } as never;
}

async function records() {
    return database(PR_CI_SUSPENSIONS_TABLE).select('*');
}

async function storedRunIds(): Promise<number[]> {
    const [record] = await records();
    return record ? JSON.parse(record.cancelled_runs).map((entry: { id: number }) => entry.id) : [];
}

/**
 * The shared database as one worker sees it, except that `afterWrite` runs once
 * a write to the suspension row has landed and before that worker resumes:
 * the window in which the write's response is still on its way back to it.
 */
function databaseResumingAfterSuspensionWrite(afterWrite: () => Promise<void>) {
    return ((table: string) => {
        const builder = database(table);
        if (table !== PR_CI_SUSPENSIONS_TABLE) return builder;
        const update = builder.update.bind(builder) as (...args: unknown[]) => PromiseLike<number>;
        builder.update = ((...args: unknown[]) => ({
            then: (resolve?: (count: number) => unknown, reject?: (error: unknown) => unknown) =>
                update(...args).then(async count => { await afterWrite(); return count; }).then(resolve, reject),
        })) as never;
        return builder;
    }) as never;
}

/**
 * The shared database as one worker sees it, except that `afterRead` runs once
 * a read of the suspension row has returned and before that worker resumes:
 * the window in which the read's response is still on its way back to it.
 */
/**
 * The shared database as one worker sees it, except that `beforeRead` runs
 * once that worker has asked for the suspension row and before the query
 * reaches the database: the worker is stalled with its read still ahead of
 * it, so what it eventually reads is whatever `beforeRead` left behind.
 */
function databaseStalledBeforeSuspensionRead(beforeRead: () => Promise<void>) {
    return ((table: string) => {
        const builder = database(table);
        if (table !== PR_CI_SUSPENSIONS_TABLE) return builder;
        const first = builder.first.bind(builder) as (...args: unknown[]) => PromiseLike<unknown>;
        builder.first = ((...args: unknown[]) => ({
            then: (resolve?: (row: unknown) => unknown, reject?: (error: unknown) => unknown) =>
                beforeRead().then(() => first(...args)).then(resolve, reject),
        })) as never;
        return builder;
    }) as never;
}

function databaseResumingAfterSuspensionRead(afterRead: () => Promise<void>) {
    return ((table: string) => {
        const builder = database(table);
        if (table !== PR_CI_SUSPENSIONS_TABLE) return builder;
        const first = builder.first.bind(builder) as (...args: unknown[]) => PromiseLike<unknown>;
        builder.first = ((...args: unknown[]) => ({
            then: (resolve?: (row: unknown) => unknown, reject?: (error: unknown) => unknown) =>
                first(...args).then(async row => { await afterRead(); return row; }).then(resolve, reject),
        })) as never;
        return builder;
    }) as never;
}

beforeEach(async () => {
    await database(PR_CI_SUSPENSIONS_TABLE).delete();
    await database(PR_CI_SUSPENSION_LEASES_TABLE).delete();
});

after(async () => {
    await database.destroy();
});

describe('follow-up CI suspension targeting', () => {
    test('cancels only the eligible validation GitHub associates with the captured pull request and head', async () => {
        const runs = [
            run({ id: 1 }),
            run({ id: 2, status: 'queued' }),
            run({ id: 3, event: 'push', pull_requests: [] }),
            run({ id: 4, event: 'release', pull_requests: [] }),
            run({ id: 5, event: 'workflow_dispatch', pull_requests: [] }),
            run({ id: 6, event: 'deployment', pull_requests: [] }),
            run({ id: 7, pull_requests: [{ number: 9999 }] }),
            run({ id: 8, pull_requests: [] }),
            run({ id: 9, head_sha: NEW_HEAD }),
            run({ id: 10, status: 'completed', conclusion: 'success' }),
            // Nobody selected these two, whatever their names suggest they do.
            run({ id: 11, name: 'PR Preview', path: '.github/workflows/pr-preview.yml', event: 'pull_request_target', status: 'queued' }),
            run({ id: 12, name: 'CI', path: '.github/workflows/ci.yml', status: 'queued' }),
            run({ id: 13, name: 'Full Test Suite', path: '.github/workflows/pr-test-on-label.yml', status: 'queued' }),
        ];
        const github = createGitHub(runs);

        const result = await beginFollowupCiSuspension({ target: TARGET, taskId: TASK_ID }, deps(github, {
            loadSelectedWorkflows: async () => ['pr-build-check.yml', '.github/workflows/pr-test-on-label.yml'],
        }));

        assert.equal(result.suspended, true);
        assert.deepEqual(result.cancelledRunIds.sort((a, b) => a - b), [1, 2, 13]);
        assert.deepEqual(github.cancelled().sort((a, b) => (a ?? 0) - (b ?? 0)), [1, 2, 13]);
        const [record] = await records();
        assert.equal(record.repository, 'integry/propr');
        assert.equal(record.pull_request, TARGET.pullRequestNumber);
        assert.equal(record.head_sha, HEAD);
        assert.equal(record.task_id, TASK_ID);
        assert.deepEqual(await storedRunIds(), [1, 2, 13]);
    });

    test('never qualifies a run by branch name alone', () => {
        const policy = createValidationWorkflowPolicy(['build & lint check'], 'repository');
        const branchOnly = {
            id: 1, name: 'Build & Lint Check', event: 'pull_request', status: 'queued', head_sha: HEAD, pull_requests: [],
        };
        assert.equal(isCancelableValidationRun(branchOnly, { pullRequestNumber: 2485, headSha: HEAD, policy }), false);
        assert.equal(
            isCancelableValidationRun({ ...branchOnly, pull_requests: [{ number: 2485 }] }, { pullRequestNumber: 2485, headSha: HEAD, policy }),
            true,
        );
    });

    test('routes a continuation to its own pull request and skips a reservation without one', () => {
        const ref = { repoOwner: 'integry', repoName: 'propr', pullRequestNumber: 2485 };
        assert.deepEqual(resolveFollowupCiSuspensionTarget(ref), { owner: 'integry', repo: 'propr', pullRequestNumber: 2485 });
        assert.deepEqual(
            resolveFollowupCiSuspensionTarget(ref, { repository: 'integry/propr', continuation_pr: 2500 }),
            { owner: 'integry', repo: 'propr', pullRequestNumber: 2500 },
        );
        assert.equal(resolveFollowupCiSuspensionTarget(ref, { repository: 'integry/propr', continuation_pr: null }), null);
    });

    test('does not touch GitHub when the repository opted out', async () => {
        const github = createGitHub([run({ id: 1 })]);

        const result = await beginFollowupCiSuspension(
            { target: TARGET, taskId: TASK_ID },
            deps(github, { isEnabled: async () => false }),
        );

        assert.deepEqual(result, { suspended: false, reason: 'disabled', cancelledRunIds: [] });
        assert.equal(github.calls.length, 0);
        assert.deepEqual(await records(), []);
    });

    test('keeps implementation running and records nothing when Actions write access is missing', async () => {
        const github = createGitHub([run({ id: 1 })], { cancelStatus: 403 });

        const result = await beginFollowupCiSuspension({ target: TARGET, taskId: TASK_ID }, deps(github));

        assert.equal(result.reason, 'permission_denied');
        assert.equal(result.suspended, false);
        assert.deepEqual(await records(), []);
    });

    test('a refused retry keeps the restart obligations its previous attempt left behind', async () => {
        const runs = [run({ id: 1 }), run({ id: 2, status: 'queued' })];
        // GitHub accepts both cancellations; cancelling is asynchronous, so the
        // runs are still finishing when the job is redelivered.
        const first = createGitHub(runs, { asyncCancellation: true });
        const begun = await beginFollowupCiSuspension({ target: TARGET, taskId: TASK_ID }, deps(first));
        assert.deepEqual(begun.cancelledRunIds, [1, 2]);

        // The retry runs after the installation lost Actions write access.
        const retried = createGitHub(runs, { asyncCancellation: true, cancelStatus: 403 });
        const result = await beginFollowupCiSuspension({ target: TARGET, taskId: TASK_ID }, deps(retried));

        assert.equal(result.reason, 'permission_denied');
        // The refusal proves this attempt cancelled nothing. It proves nothing
        // about the two cancellations GitHub already accepted.
        assert.deepEqual(await storedRunIds(), [1, 2]);
        const [stored] = await records();
        assert.deepEqual(JSON.parse(stored.cancelled_runs).map((entry: { restarted: boolean }) => entry.restarted), [false, false]);

        // GitHub finishes both cancellations; the obligation is still there to honour.
        runs.forEach(candidate => { candidate.status = 'completed'; candidate.conclusion = 'cancelled'; });
        const recovery = createGitHub(runs);
        const summary = await reconcileFollowupCiSuspensions(deps(recovery, { getTaskState: async () => null }));
        assert.equal(summary.restored, 1);
        assert.deepEqual(recovery.rerun().sort((a, b) => (a ?? 0) - (b ?? 0)), [1, 2]);
        assert.deepEqual(await records(), []);
    });

    test('a refused cancellation leaves no intent behind, while what earlier requests cancelled is still restored', async () => {
        const runs = [run({ id: 1 }), run({ id: 2, status: 'queued' })];
        // GitHub accepts the first cancellation, applies it asynchronously, and
        // refuses the second: Actions write access went away in between.
        const github = createGitHub(runs, { asyncCancellation: true, failCancelAfter: 1, failCancelStatus: 403 });

        const result = await beginFollowupCiSuspension({ target: TARGET, taskId: TASK_ID }, deps(github));

        assert.equal(result.reason, 'permission_denied');
        assert.deepEqual(github.cancelled(), [1, 2]);
        assert.deepEqual(await storedRunIds(), [1], 'a refused request authorizes no rerun; the accepted one is still owed a restart');

        // Both runs end up cancelled: run 1 by ProPR, run 2 by somebody else
        // after ProPR's request was refused.
        runs.forEach(candidate => { candidate.status = 'completed'; candidate.conclusion = 'cancelled'; });
        const recovery = createGitHub(runs);
        const summary = await reconcileFollowupCiSuspensions(deps(recovery, { getTaskState: async () => null }));
        assert.equal(summary.restored, 1);
        assert.deepEqual(recovery.rerun(), [1], 'only the cancellation ProPR caused is restored');
        assert.equal(runs[1].conclusion, 'cancelled', 'a run ProPR was refused to cancel is never restarted on its behalf');
        assert.deepEqual(await records(), []);
    });

    test('a cancellation refused for bad credentials leaves no intent behind either', async () => {
        const github = createGitHub([run({ id: 1 })], { cancelStatus: 401 });

        const result = await beginFollowupCiSuspension({ target: TARGET, taskId: TASK_ID }, deps(github));

        assert.equal(result.reason, 'permission_denied');
        assert.equal(result.suspended, false);
        assert.deepEqual(await records(), [], 'a request GitHub rejected outright authorizes no rerun');
    });

    test('a run somebody else cancels after ProPR\'s credentials were rejected is never restarted on its behalf', async () => {
        const runs = [run({ id: 1 }), run({ id: 2, status: 'queued' })];
        // GitHub accepts the first cancellation, applies it asynchronously, and
        // rejects the credentials of the second: the token expired in between.
        const github = createGitHub(runs, { asyncCancellation: true, failCancelAfter: 1, failCancelStatus: 401 });

        const result = await beginFollowupCiSuspension({ target: TARGET, taskId: TASK_ID }, deps(github));

        assert.equal(result.reason, 'permission_denied');
        assert.deepEqual(github.cancelled(), [1, 2]);
        assert.deepEqual(await storedRunIds(), [1], 'the rejected request is withdrawn; the accepted one is still owed a restart');

        // Both runs end up cancelled: run 1 by ProPR, run 2 by an operator after
        // ProPR's request was rejected. Credentials recover, and implementation
        // ends without replacing the head.
        runs.forEach(candidate => { candidate.status = 'completed'; candidate.conclusion = 'cancelled'; });
        const recovery = createGitHub(runs);
        const summary = await reconcileFollowupCiSuspensions(deps(recovery, { getTaskState: async () => null }));
        assert.equal(summary.restored, 1);
        assert.deepEqual(recovery.rerun(), [1], 'only the cancellation ProPR caused is restored');
        assert.equal(runs[1].conclusion, 'cancelled', 'the operator\'s cancellation stands');
        assert.deepEqual(await records(), []);
    });

    test('a refused re-cancellation keeps the obligation an earlier cancellation left behind, as it was', async () => {
        const runs = [run({ id: 1 })];
        // GitHub accepts the cancellation and applies it asynchronously.
        const github = createGitHub(runs, { asyncCancellation: true });
        const begun = await beginFollowupCiSuspension({ target: TARGET, taskId: TASK_ID }, deps(github));
        assert.deepEqual(begun.cancelledRunIds, [1]);
        const [record] = await records();

        // A sweep still finds the run pending and asks again, after the
        // installation lost Actions write access.
        const sweeping = createGitHub(runs, { asyncCancellation: true, cancelStatus: 403 });
        await assert.rejects(sweepFollowupCiSuspension(record, deps(sweeping)), { name: 'CiActionsPermissionError' });

        const [stored] = await records();
        assert.deepEqual(
            JSON.parse(stored.cancelled_runs).map((entry: { id: number; attempt?: number; restarted: boolean }) => [entry.id, entry.attempt, entry.restarted]),
            [[1, 1, false]], 'the accepted cancellation is still owed a restart, on the attempt GitHub confirmed');

        // The first cancellation lands; the obligation is honoured once access is back.
        runs[0].status = 'completed';
        runs[0].conclusion = 'cancelled';
        const recovery = createGitHub(runs);
        const summary = await reconcileFollowupCiSuspensions(deps(recovery, { getTaskState: async () => null }));
        assert.equal(summary.restored, 1);
        assert.deepEqual(recovery.rerun(), [1]);
        assert.deepEqual(await records(), []);
    });

    test('keeps the restore obligation for runs cancelled before a failure', async () => {
        const runs = [run({ id: 1 }), run({ id: 2, status: 'queued' })];
        const github = createGitHub(runs, { failCancelAfter: 1 });

        const result = await beginFollowupCiSuspension({ target: TARGET, taskId: TASK_ID }, deps(github));

        assert.equal(result.reason, 'error');
        // Run 1 was cancelled; run 2's cancel failed ambiguously, so its intent is
        // kept too and the run's own outcome decides what it needs.
        assert.deepEqual(await storedRunIds(), [1, 2]);

        // Run 2 was never actually cancelled and finishes on its own.
        runs[1].status = 'completed';
        runs[1].conclusion = 'failure';
        const recovery = createGitHub(runs);
        const summary = await reconcileFollowupCiSuspensions(deps(recovery, { getTaskState: async () => null }));
        assert.equal(summary.restored, 1);
        assert.deepEqual(recovery.rerun(), [1]);
        assert.deepEqual(await records(), []);
    });

    test('stores the run before GitHub receives its cancellation, so a lost response cannot lose it', async () => {
        const runs = [run({ id: 1 })];
        const seenWhenGitHubCancelled: number[][] = [];
        const github = createGitHub(runs, {
            onCancel: async runId => {
                // GitHub accepted the cancellation; whatever the worker does next, the
                // obligation must already be durable at this exact moment.
                seenWhenGitHubCancelled.push(await storedRunIds());
                // ...and then the response never makes it back, followed by a crash.
                throw Object.assign(new Error(`socket hang up while cancelling ${runId}`), { code: 'ECONNRESET' });
            },
        });

        const result = await beginFollowupCiSuspension({ target: TARGET, taskId: TASK_ID }, deps(github));

        assert.equal(result.reason, 'error');
        assert.deepEqual(seenWhenGitHubCancelled, [[1]], 'the run id was stored before GitHub received the cancel request');
        assert.deepEqual(await storedRunIds(), [1]);

        // After the restart, reconciliation finds the cancelled run and restores it.
        const afterRestart = createGitHub(runs);
        const summary = await reconcileFollowupCiSuspensions(deps(afterRestart, { getTaskState: async () => null }));
        assert.equal(summary.restored, 1);
        assert.deepEqual(afterRestart.rerun(), [1]);
        assert.deepEqual(await records(), []);
    });

    test('records the attempt the cancellation landed on, not the one discovery listed', async () => {
        const runs = [run({ id: 1 })];
        const github = createGitHub(runs, {
            onRequest: async route => {
                if (route !== 'POST /repos/{owner}/{repo}/actions/runs/{run_id}/cancel') return;
                // Between discovery and the cancel request, attempt 1 failed and
                // somebody at GitHub reran the workflow: the request lands on attempt 2.
                runs[0].attempts = { 1: { status: 'completed', conclusion: 'failure' } };
                runs[0].run_attempt = 2;
                runs[0].status = 'queued';
                runs[0].conclusion = null;
            },
        });

        const result = await beginFollowupCiSuspension({ target: TARGET, taskId: TASK_ID }, deps(github));

        assert.deepEqual(result.cancelledRunIds, [1]);
        assert.deepEqual([runs[0].status, runs[0].conclusion, runs[0].run_attempt], ['completed', 'cancelled', 2]);
        const [stored] = await records();
        assert.deepEqual(
            JSON.parse(stored.cancelled_runs).map((entry: { attempt?: number; restarted: boolean }) => [entry.attempt, entry.restarted]),
            [[2, false]], 'the record identifies the attempt ProPR cancelled');

        // The head is unchanged when implementation ends. Attempt 2 being newer
        // than what discovery listed proves nothing: it is what ProPR cancelled,
        // and it has to come back.
        const summary = await reconcileFollowupCiSuspensions(deps(github, { getTaskState: async () => null }));
        assert.equal(summary.restored, 1);
        assert.deepEqual(github.rerun(), [1]);
        assert.equal(runs[0].run_attempt, 3);
        assert.deepEqual(await records(), []);
    });

    test('a rerun somebody starts right after the cancellation landed is not adopted as the attempt ProPR cancelled', async () => {
        const runs = [run({ id: 1 })];
        const github = createGitHub(runs, {
            onCancel: async () => {
                // GitHub applied the cancellation to attempt 1. Before the worker
                // reads the run back, somebody at GitHub reruns it: attempt 2 starts.
                runs[0].attempts = { 1: { status: 'completed', conclusion: 'cancelled' } };
                runs[0].run_attempt = 2;
                runs[0].status = 'queued';
                runs[0].conclusion = null;
            },
        });

        const result = await beginFollowupCiSuspension({ target: TARGET, taskId: TASK_ID }, deps(github));

        assert.deepEqual(result.cancelledRunIds, [1]);
        const [stored] = await records();
        assert.deepEqual(
            JSON.parse(stored.cancelled_runs).map((entry: { observedAttempt?: number; attempt?: number; restarted: boolean }) =>
                [entry.observedAttempt, entry.attempt, entry.restarted]),
            [[1, 1, false]], 'the record ties the cancellation to attempt 1, not to the rerun that followed it');

        // That actor cancels attempt 2 as well, and the head is unchanged when
        // implementation ends. Attempt 2 is theirs: their rerun already brought
        // back the attempt ProPR cancelled, so there is nothing left to restore.
        runs[0].status = 'completed';
        runs[0].conclusion = 'cancelled';
        const recovery = createGitHub(runs);
        const summary = await reconcileFollowupCiSuspensions(deps(recovery, { getTaskState: async () => null }));

        assert.equal(summary.released, 1);
        assert.equal(summary.restored, 0);
        assert.deepEqual(recovery.rerun(), [], 'the newer attempt is never restarted on somebody else\'s behalf');
        assert.equal(runs[0].run_attempt, 2);
        assert.deepEqual(await records(), []);
    });

    test('a run an operator cancelled and reran while earlier runs were handled is cancelled on the attempt it is on now', async () => {
        const runs = [run({ id: 1 }), run({ id: 2 })];
        const observedBeforeCancel: Array<number | undefined> = [];
        const github = createGitHub(runs, {
            onCancel: async runId => {
                if (runId !== 1) return;
                // While ProPR is busy with run 1, an operator cancels run 2 on the
                // attempt discovery listed and reruns it: run 2 is on attempt 2 now.
                runs[1].attempts = { 1: { status: 'completed', conclusion: 'cancelled' } };
                runs[1].run_attempt = 2;
                runs[1].status = 'queued';
                runs[1].conclusion = null;
            },
            onRequest: async route => {
                if (route !== 'POST /repos/{owner}/{repo}/actions/runs/{run_id}/cancel') return;
                const [stored] = await records();
                const entry = JSON.parse(stored.cancelled_runs).find((candidate: { id: number }) => candidate.id === 2);
                observedBeforeCancel.push(entry?.observedAttempt);
            },
        });

        const result = await beginFollowupCiSuspension({ target: TARGET, taskId: TASK_ID }, deps(github));

        assert.deepEqual(result.cancelledRunIds, [1, 2]);
        assert.deepEqual([runs[1].status, runs[1].conclusion, runs[1].run_attempt], ['completed', 'cancelled', 2]);
        assert.deepEqual(observedBeforeCancel, [undefined, 2],
            'the intent for run 2 records the attempt it is on right before its request leaves, not the listed one');
        const [stored] = await records();
        assert.deepEqual(
            JSON.parse(stored.cancelled_runs).map((entry: { id: number; observedAttempt?: number; attempt?: number; restarted: boolean }) =>
                [entry.id, entry.observedAttempt, entry.attempt, entry.restarted]),
            [[1, 1, 1, false], [2, 2, 2, false]], 'the record ties ProPR\'s cancellation of run 2 to attempt 2');

        // The head is unchanged when implementation ends. The operator's
        // cancelled attempt 1 must not pass for ProPR's, nor their rerun for its
        // restoration: attempt 2 is what ProPR cancelled, and it has to come back.
        const summary = await reconcileFollowupCiSuspensions(deps(github, { getTaskState: async () => null }));
        assert.equal(summary.restored, 1);
        assert.deepEqual(github.rerun(), [1, 2]);
        assert.equal(runs[1].run_attempt, 3);
        assert.deepEqual(await records(), []);
    });

    test('a run an operator cancelled and reran while its intent was being written receives no request on the operator\'s rerun', async () => {
        const runs = [run({ id: 1 })];
        let rerunByOperator = false;
        const github = createGitHub(runs);
        const rerunWhileTheWriteReturns = async () => {
            if (rerunByOperator) return;
            rerunByOperator = true;
            // The intent for attempt 1 has landed. While its response is on its
            // way back, an operator cancels attempt 1 and reruns the workflow:
            // the run is on attempt 2 now, with attempt 1 ended cancelled by
            // their hand — the very evidence a cancellation by ProPR leaves.
            runs[0].attempts = { 1: { status: 'completed', conclusion: 'cancelled' } };
            runs[0].run_attempt = 2;
            runs[0].status = 'queued';
            runs[0].conclusion = null;
        };

        const result = await beginFollowupCiSuspension({ target: TARGET, taskId: TASK_ID },
            deps(github, { database: databaseResumingAfterSuspensionWrite(rerunWhileTheWriteReturns) }));

        assert.equal(result.reason, 'suspended');
        assert.deepEqual(result.cancelledRunIds, []);
        assert.deepEqual(github.cancelled(), [], 'the request recorded for attempt 1 never leaves for the operator\'s attempt 2');
        assert.deepEqual([runs[0].status, runs[0].run_attempt], ['queued', 2], 'the operator\'s rerun keeps running');
        assert.deepEqual(await storedRunIds(), [], 'the intent the rerun invalidated is withdrawn, not left to pass for a cancellation');

        // A later sweep observes the run afresh, on attempt 2, and cancels that.
        const [record] = await records();
        const swept = await sweepFollowupCiSuspension(record, deps(github));
        assert.equal(swept.reason, 'swept');
        assert.deepEqual(swept.cancelledRunIds, [1]);
        assert.deepEqual([runs[0].status, runs[0].conclusion, runs[0].run_attempt], ['completed', 'cancelled', 2]);
        const [stored] = await records();
        assert.deepEqual(
            JSON.parse(stored.cancelled_runs).map((entry: { observedAttempt?: number; attempt?: number; restarted: boolean }) =>
                [entry.observedAttempt, entry.attempt, entry.restarted]),
            [[2, 2, false]], 'the record ties ProPR\'s cancellation to attempt 2, not to the attempt the operator cancelled');

        // The head is unchanged when implementation ends: attempt 2 is what
        // ProPR cancelled, and the operator's earlier cancellation of attempt 1
        // must neither pass for it nor discharge the obligation to restore it.
        const summary = await reconcileFollowupCiSuspensions(deps(github, { getTaskState: async () => null }));
        assert.equal(summary.restored, 1);
        assert.deepEqual(github.rerun(), [1]);
        assert.equal(runs[0].run_attempt, 3);
        assert.deepEqual(await records(), []);
    });

    test('a run that finished while its intent was being written receives no request and is not recorded', async () => {
        const runs = [run({ id: 1 }), run({ id: 2 })];
        let finished = false;
        const github = createGitHub(runs);
        const finishWhileTheWriteReturns = async () => {
            if (finished) return;
            finished = true;
            // Run 1 produced its own result while its intent was being written.
            runs[0].status = 'completed';
            runs[0].conclusion = 'success';
        };

        const result = await beginFollowupCiSuspension({ target: TARGET, taskId: TASK_ID },
            deps(github, { database: databaseResumingAfterSuspensionWrite(finishWhileTheWriteReturns) }));

        assert.deepEqual(result.cancelledRunIds, [2]);
        assert.deepEqual(github.cancelled(), [2], 'no cancel request leaves for a run that is no longer pending');
        assert.deepEqual(await storedRunIds(), [2], 'the withdrawn intent of run 1 does not stand next to the obligation for run 2');
        assert.deepEqual([runs[0].status, runs[0].conclusion], ['completed', 'success']);
    });

    test('a run that finished while earlier runs were handled is neither cancelled nor recorded', async () => {
        const runs = [run({ id: 1 }), run({ id: 2 })];
        const github = createGitHub(runs, {
            onCancel: async runId => {
                if (runId !== 1) return;
                // Run 2 produced its own result while run 1 was being cancelled.
                runs[1].status = 'completed';
                runs[1].conclusion = 'success';
            },
        });

        const result = await beginFollowupCiSuspension({ target: TARGET, taskId: TASK_ID }, deps(github));

        assert.deepEqual(result.cancelledRunIds, [1]);
        assert.deepEqual(github.cancelled(), [1], 'the listing alone never sends a cancel to a run that is no longer pending');
        assert.deepEqual(await storedRunIds(), [1]);
        assert.deepEqual([runs[1].status, runs[1].conclusion], ['completed', 'success']);
    });

    test('an unconfirmed cancellation is settled by the attempts the run left behind, not by the attempt it shows', async () => {
        const runs = [run({ id: 1 })];
        let cancelSent = false;
        const github = createGitHub(runs, {
            // The worker dies before it can read the run back: the attempt the
            // cancellation affected is never confirmed, only the one observed.
            onRequest: async route => {
                if (route === 'POST /repos/{owner}/{repo}/actions/runs/{run_id}/cancel') cancelSent = true;
                if (cancelSent && route === 'GET /repos/{owner}/{repo}/actions/runs/{run_id}') throw Object.assign(new Error('worker died'), { status: 500 });
            },
        });
        const begun = await beginFollowupCiSuspension({ target: TARGET, taskId: TASK_ID }, deps(github));
        assert.equal(begun.reason, 'suspended');
        const [unconfirmed] = await records();
        assert.deepEqual(
            JSON.parse(unconfirmed.cancelled_runs).map((entry: { observedAttempt?: number; attempt?: number; restarted: boolean }) =>
                [entry.observedAttempt, entry.attempt, entry.restarted]),
            [[1, undefined, false]]);

        // Somebody at GitHub reruns the cancelled attempt and later cancels the
        // rerun too. The run now shows a cancelled attempt 2.
        runs[0].attempts = { 1: { status: 'completed', conclusion: 'cancelled' } };
        runs[0].run_attempt = 2;
        runs[0].status = 'completed';
        runs[0].conclusion = 'cancelled';
        const recovery = createGitHub(runs);
        const summary = await reconcileFollowupCiSuspensions(deps(recovery, { getTaskState: async () => null }));

        assert.equal(summary.released, 1);
        assert.equal(summary.restored, 0);
        assert.deepEqual(recovery.rerun(), [], 'attempt 1 was cancelled and rerun; attempt 2 is not ProPR\'s to restore');
        assert.equal(runs[0].run_attempt, 2);
        assert.deepEqual(await records(), []);
    });

    test('an unconfirmed cancellation whose evidence cannot be read keeps its obligation for a later pass', async () => {
        const runs = [run({ id: 1 })];
        let cancelSent = false;
        let readBackFails = true;
        const github = createGitHub(runs, {
            onRequest: async route => {
                if (route === 'POST /repos/{owner}/{repo}/actions/runs/{run_id}/cancel') cancelSent = true;
                if (cancelSent && readBackFails && route === 'GET /repos/{owner}/{repo}/actions/runs/{run_id}') throw Object.assign(new Error('read back failed'), { status: 500 });
            },
        });
        await beginFollowupCiSuspension({ target: TARGET, taskId: TASK_ID }, deps(github));
        readBackFails = false;
        // The run moved on to a cancelled attempt 2, and GitHub cannot say what
        // became of attempt 1: nothing is decided, and nothing is rerun blindly.
        runs[0].run_attempt = 2;
        runs[0].status = 'completed';
        runs[0].conclusion = 'cancelled';

        const [result] = await releaseFollowupCiSuspensionsForTask({ taskId: TASK_ID }, deps(github));

        assert.equal(result.reason, 'pending');
        assert.deepEqual(result.pendingRunIds, [1]);
        assert.deepEqual(github.rerun(), []);
        const [retained] = await records();
        assert.equal(retained.state, 'restoring');

        // Once GitHub reports attempt 1 as having failed on its own, the request
        // can only have affected attempt 2, and that is what comes back.
        runs[0].attempts = { 1: { status: 'completed', conclusion: 'failure' } };
        const summary = await reconcileFollowupCiSuspensions(deps(github, { getTaskState: async () => null }));

        assert.equal(summary.restored, 1);
        assert.deepEqual(github.rerun(), [1]);
        assert.equal(runs[0].run_attempt, 3);
        assert.deepEqual(await records(), []);
    });

    test('a cancellation whose outcome is unknown is never settled by attempt advancement', async () => {
        const runs = [run({ id: 1 })];
        const github = createGitHub(runs, {
            onRequest: async route => {
                if (route !== 'POST /repos/{owner}/{repo}/actions/runs/{run_id}/cancel') return;
                // Rerun between discovery and the request, as above...
                runs[0].attempts = { 1: { status: 'completed', conclusion: 'failure' } };
                runs[0].run_attempt = 2;
                runs[0].status = 'queued';
                runs[0].conclusion = null;
            },
            // ...and this time the worker never learns that GitHub accepted the request.
            onCancel: async runId => {
                throw Object.assign(new Error(`socket hang up while cancelling ${runId}`), { code: 'ECONNRESET' });
            },
        });

        const result = await beginFollowupCiSuspension({ target: TARGET, taskId: TASK_ID }, deps(github));

        assert.equal(result.reason, 'error');
        const [stored] = await records();
        assert.deepEqual(
            JSON.parse(stored.cancelled_runs).map((entry: { attempt?: number; restarted: boolean }) => [entry.attempt, entry.restarted]),
            [[undefined, false]], 'no attempt is recorded that the request was not confirmed to affect');

        // Attempt 2 is cancelled and the head is unchanged: only the run's own
        // outcome decides, and it says the validation has to come back.
        const recovery = createGitHub(runs);
        const summary = await reconcileFollowupCiSuspensions(deps(recovery, { getTaskState: async () => null }));
        assert.equal(summary.restored, 1);
        assert.deepEqual(recovery.rerun(), [1]);
        assert.deepEqual(await records(), []);
    });

    test('takes back the intent of a cancellation GitHub rejected because the run was already terminal', async () => {
        const runs = [run({ id: 1 })];
        const github = createGitHub(runs, {
            cancelStatus: 409,
            onRequest: async route => {
                if (route !== 'POST /repos/{owner}/{repo}/actions/runs/{run_id}/cancel') return;
                // Somebody at GitHub cancelled the run between discovery and ProPR's
                // request, which GitHub therefore rejects.
                runs[0].status = 'completed';
                runs[0].conclusion = 'cancelled';
            },
        });

        const result = await beginFollowupCiSuspension({ target: TARGET, taskId: TASK_ID }, deps(github));

        assert.equal(result.reason, 'suspended');
        assert.deepEqual(result.cancelledRunIds, []);
        assert.deepEqual(await storedRunIds(), [], 'a definitively rejected request leaves no obligation behind');

        // Implementation ends with the head unchanged. The run is cancelled, but
        // not by ProPR, and is never restarted on its behalf.
        const summary = await reconcileFollowupCiSuspensions(deps(github, { getTaskState: async () => null }));
        assert.equal(summary.released, 1);
        assert.deepEqual(github.rerun(), []);
        assert.equal(runs[0].conclusion, 'cancelled');
        assert.deepEqual(await records(), []);
    });

    test('a rejected re-cancellation keeps the obligation an earlier cancellation left behind', async () => {
        const runs = [run({ id: 1 })];
        // GitHub accepts the cancellation and applies it asynchronously.
        const github = createGitHub(runs, { asyncCancellation: true });
        const begun = await beginFollowupCiSuspension({ target: TARGET, taskId: TASK_ID }, deps(github));
        assert.deepEqual(begun.cancelledRunIds, [1]);
        const [record] = await records();

        // A sweep still finds the run pending and asks again; the first
        // cancellation lands just before, so this request is rejected.
        const sweeping = createGitHub(runs, {
            cancelStatus: 409,
            onRequest: async route => {
                if (route !== 'POST /repos/{owner}/{repo}/actions/runs/{run_id}/cancel') return;
                runs[0].status = 'completed';
                runs[0].conclusion = 'cancelled';
            },
        });
        const swept = await sweepFollowupCiSuspension(record, deps(sweeping));

        assert.equal(swept.reason, 'swept');
        assert.deepEqual(swept.cancelledRunIds, []);
        const [stored] = await records();
        assert.deepEqual(
            JSON.parse(stored.cancelled_runs).map((entry: { id: number; attempt?: number; restarted: boolean }) => [entry.id, entry.attempt, entry.restarted]),
            [[1, 1, false]], 'the obligation of the accepted cancellation is untouched');

        const summary = await reconcileFollowupCiSuspensions(deps(sweeping, { getTaskState: async () => null }));
        assert.equal(summary.restored, 1);
        assert.deepEqual(sweeping.rerun(), [1]);
        assert.deepEqual(await records(), []);
    });

    test('discovers runs beyond the first page of the Actions API', async () => {
        const runs = Array.from({ length: 105 }, (_, index) => run({ id: index + 1, status: 'queued' }));
        const github = createGitHub(runs, { perPage: 100 });

        const result = await beginFollowupCiSuspension({ target: TARGET, taskId: TASK_ID }, deps(github));

        assert.equal(result.cancelledRunIds.length, 105);
        assert.equal(github.cancelled().length, 105);
        assert.equal((await storedRunIds()).length, 105);
    });

    test('does not suspend a pull request that is no longer open', async () => {
        const github = createGitHub([run({ id: 1 })], { prState: 'closed' });

        const result = await beginFollowupCiSuspension({ target: TARGET, taskId: TASK_ID }, deps(github));

        assert.equal(result.reason, 'head_unavailable');
        assert.deepEqual(github.cancelled(), []);
        assert.deepEqual(await records(), []);
    });
});

describe('selected validation workflows', () => {
    const eligible = (workflow: { name: string; path: string; event?: string; workflow_id?: number }, policy?: unknown) =>
        isEligibleValidationWorkflow({ event: 'pull_request', ...workflow }, policy as never);

    test('accepts only the workflows an operator selected, by name, path, file name or ID', () => {
        const policy = createValidationWorkflowPolicy(
            ['Full Test Suite', ' PR-BUILD-CHECK.YML ', '.github/workflows/codeql.yml', 'dependency-review', '425'],
            'repository',
        );
        assert.equal(eligible({ name: 'Full Test Suite', path: '.github/workflows/pr-test-on-label.yml' }, policy), true);
        assert.equal(eligible({ name: 'Build & Lint Check', path: '.github/workflows/pr-build-check.yml' }, policy), true);
        assert.equal(eligible({ name: 'CodeQL', path: '.github/workflows/codeql.yml' }, policy), true);
        assert.equal(eligible({ name: 'Nightly', path: '.github/workflows/nightly.yml', workflow_id: 425 }, policy), true);
        // A file name without its extension is not one of the documented identities.
        assert.equal(eligible({ name: 'Dependency Review', path: '.github/workflows/dependency-review.yml' }, policy), false);
        // A selected workflow stays selected on the event its operator chose it for.
        assert.equal(eligible({ name: 'Full Test Suite', path: '.github/workflows/pr-test-on-label.yml', event: 'pull_request_target' }, policy), true);
        // ...but never outside a pull request.
        assert.equal(eligible({ name: 'Full Test Suite', path: '.github/workflows/pr-test-on-label.yml', event: 'push' }, policy), false);
    });

    test('never infers permission to cancel a workflow from its name', () => {
        const policy = createValidationWorkflowPolicy(['pr-build-check.yml'], 'repository');
        // A `Build`/`CI` workflow is free to deploy; only an operator knows.
        assert.equal(eligible({ name: 'CI', path: '.github/workflows/ci.yml' }, policy), false);
        // Selecting the display name `CI` selects the workflow shown as `CI`, not
        // every workflow whose file happens to be called `ci.yml`.
        const displayName = createValidationWorkflowPolicy(['CI'], 'repository');
        assert.equal(eligible({ name: 'Deploy Preview', path: '.github/workflows/ci.yml' }, displayName), false);
        assert.equal(eligible({ name: 'CI', path: '.github/workflows/checks.yml' }, displayName), true);
        assert.equal(eligible({ name: 'Build', path: '.github/workflows/build.yml' }, policy), false);
        assert.equal(eligible({ name: 'Full Test Suite', path: '.github/workflows/pr-test-on-label.yml' }, policy), false);
        assert.equal(eligible({ name: 'PR Preview', path: '.github/workflows/pr-preview.yml', event: 'pull_request_target' }, policy), false);
        // Substrings are not identities: selecting one workflow selects exactly it.
        assert.equal(eligible({ name: 'PR Build Check (matrix)', path: '.github/workflows/pr-build-check-matrix.yml' }, policy), false);
    });

    test('selects nothing at all while nothing was selected', () => {
        assert.equal(eligible({ name: 'Build & Lint Check', path: '.github/workflows/pr-build-check.yml' }), false);
        assert.equal(eligible({ name: 'Build & Lint Check', path: '.github/workflows/pr-build-check.yml' }, resolveValidationWorkflowPolicy([], {})), false);
        assert.equal(resolveValidationWorkflowPolicy(undefined, {}).source, 'none');
        assert.equal(resolveValidationWorkflowPolicy(['  ', ''], {}).selected.size, 0);
    });

    test('the repository selection wins over the documented environment fallback', () => {
        const env = { [VALIDATION_WORKFLOW_ALLOWLIST_ENV]: 'pr-preview.yml' };
        const repository = resolveValidationWorkflowPolicy(['pr-build-check.yml'], env);
        assert.equal(repository.source, 'repository');
        assert.equal(eligible({ name: 'Build & Lint Check', path: '.github/workflows/pr-build-check.yml' }, repository), true);
        assert.equal(eligible({ name: 'PR Preview', path: '.github/workflows/pr-preview.yml' }, repository), false);

        const fallback = resolveValidationWorkflowPolicy([], env);
        assert.equal(fallback.source, 'environment');
        assert.equal(eligible({ name: 'PR Preview', path: '.github/workflows/pr-preview.yml' }, fallback), true);
        assert.equal(loadValidationWorkflowPolicyFromEnv({}).selected.size, 0);
    });

    test('an unselected CI workflow that deploys keeps running while the selected validation is cancelled', async () => {
        const runs = [
            // Named like validation, deploys in reality, and nobody selected it.
            run({ id: 1, name: 'CI', path: '.github/workflows/ci.yml', status: 'queued' }),
            run({ id: 2, name: 'Build', path: '.github/workflows/build-and-deploy.yml', status: 'queued' }),
            run({ id: 3, name: 'PR Preview', path: '.github/workflows/pr-preview.yml', event: 'pull_request_target', status: 'queued' }),
            run({ id: 4, name: 'Full Test Suite', path: '.github/workflows/pr-test-on-label.yml', status: 'queued' }),
        ];
        const github = createGitHub(runs);

        const result = await beginFollowupCiSuspension({ target: TARGET, taskId: TASK_ID }, deps(github, {
            loadSelectedWorkflows: async () => ['pr-test-on-label.yml'],
        }));

        assert.deepEqual(result.cancelledRunIds, [4], 'only the selected validation workflow was cancelled');
        assert.deepEqual(github.cancelled(), [4]);
        assert.deepEqual(await storedRunIds(), [4]);
        assert.deepEqual(runs.filter(candidate => candidate.id !== 4).map(candidate => candidate.status), ['queued', 'queued', 'queued']);
    });

    test('cancels nothing and records nothing while the repository selected no workflows', async () => {
        const github = createGitHub([run({ id: 1 })]);

        const result = await beginFollowupCiSuspension({ target: TARGET, taskId: TASK_ID }, deps(github, {
            loadSelectedWorkflows: async () => [],
        }));

        assert.equal(result.reason, 'no_workflows_selected');
        assert.equal(result.suspended, false);
        assert.deepEqual(github.calls, [], 'an empty selection never even asks GitHub for the runs');
        assert.deepEqual(await records(), []);
    });

    test('falls back to the documented environment selection when the repository selected nothing', async () => {
        const runs = [
            run({ id: 1, name: 'Build & Lint Check', path: '.github/workflows/pr-build-check.yml', status: 'queued' }),
            run({ id: 2, name: 'PR Preview', path: '.github/workflows/pr-preview.yml', event: 'pull_request_target', status: 'queued' }),
        ];
        const github = createGitHub(runs);
        const policy = resolveValidationWorkflowPolicy([], { [VALIDATION_WORKFLOW_ALLOWLIST_ENV]: 'pr-preview.yml' });

        const result = await beginFollowupCiSuspension({ target: TARGET, taskId: TASK_ID }, deps(github, { workflowPolicy: policy }));

        assert.deepEqual(result.cancelledRunIds, [2]);
        assert.deepEqual(await storedRunIds(), [2]);
    });

    test('an unreadable repository selection cancels nothing, and never falls back to the environment', async () => {
        const previous = process.env[VALIDATION_WORKFLOW_ALLOWLIST_ENV];
        process.env[VALIDATION_WORKFLOW_ALLOWLIST_ENV] = 'pr-preview.yml';
        try {
            const runs = [run({ id: 1, name: 'PR Preview', path: '.github/workflows/pr-preview.yml', event: 'pull_request_target', status: 'queued' })];
            const unreadable = createGitHub(runs);

            // The stored selection could not be read: the repository may well have
            // selected workflows other than the fallback's, so nothing is cancelled.
            const skipped = await beginFollowupCiSuspension({ target: TARGET, taskId: TASK_ID }, deps(unreadable, {
                loadSelectedWorkflows: async () => null,
            }));

            assert.equal(skipped.suspended, false);
            assert.equal(skipped.reason, 'selection_unreadable');
            assert.deepEqual(unreadable.cancelled(), []);
            assert.deepEqual(unreadable.calls, [], 'an unreadable selection never even asks GitHub for the runs');
            assert.deepEqual(await records(), []);
            assert.equal(runs[0].status, 'queued');

            // A selection that was read and is genuinely empty still uses the fallback.
            const readable = createGitHub(runs);
            const fallback = await beginFollowupCiSuspension({ target: TARGET, taskId: TASK_ID }, deps(readable, {
                loadSelectedWorkflows: async () => [],
            }));

            assert.deepEqual(fallback.cancelledRunIds, [1]);
            assert.deepEqual(await storedRunIds(), [1]);
        } finally {
            if (previous === undefined) delete process.env[VALIDATION_WORKFLOW_ALLOWLIST_ENV];
            else process.env[VALIDATION_WORKFLOW_ALLOWLIST_ENV] = previous;
        }
    });
});

describe('follow-up CI suspension while implementation runs', () => {
    test('cancels a run that GitHub queued after the suspension started', async () => {
        const runs = [run({ id: 1 })];
        const github = createGitHub(runs);
        await beginFollowupCiSuspension({ target: TARGET, taskId: TASK_ID }, deps(github));

        runs.push(run({ id: 2, status: 'queued' }));
        const [record] = await records();
        const swept = await sweepFollowupCiSuspension(record, deps(github));

        assert.equal(swept.reason, 'swept');
        assert.deepEqual(swept.cancelledRunIds, [2]);
        assert.deepEqual(await storedRunIds(), [1, 2]);
    });

    test('releases the suspension and leaves the new head validated once a replacement is published', async () => {
        const runs = [run({ id: 1 })];
        const github = createGitHub(runs);
        await beginFollowupCiSuspension({ target: TARGET, taskId: TASK_ID }, deps(github));

        runs.push(run({ id: 2, head_sha: NEW_HEAD, status: 'queued' }));
        const published = createGitHub(runs, { headSha: NEW_HEAD });
        const [record] = await records();
        const swept = await sweepFollowupCiSuspension(record, deps(published));

        assert.equal(swept.reason, 'head_replaced');
        assert.deepEqual(published.cancelled(), []);
        assert.deepEqual(await records(), []);
        assert.equal(runs.find(candidate => candidate.id === 2)!.status, 'queued');
    });
});

describe('restoring cancelled validation', () => {
    test('restarts the cancelled runs when implementation produced no replacement commit', async () => {
        const runs = [run({ id: 1 }), run({ id: 2, status: 'queued' })];
        const github = createGitHub(runs);
        await beginFollowupCiSuspension({ target: TARGET, taskId: TASK_ID }, deps(github));

        const [result] = await releaseFollowupCiSuspensionsForTask({ taskId: TASK_ID }, deps(github));

        assert.equal(result.reason, 'restarted');
        assert.deepEqual(result.restartedRunIds.sort((a, b) => a - b), [1, 2]);
        assert.deepEqual(await records(), []);
        assert.deepEqual(runs.map(candidate => candidate.status), ['queued', 'queued']);
    });

    test('does not restart an obsolete revision', async () => {
        const runs = [run({ id: 1 })];
        const github = createGitHub(runs);
        await beginFollowupCiSuspension({ target: TARGET, taskId: TASK_ID }, deps(github));

        const published = createGitHub(runs, { headSha: NEW_HEAD });
        const [result] = await releaseFollowupCiSuspensionsForTask({ taskId: TASK_ID }, deps(published));

        assert.equal(result.reason, 'head_replaced');
        assert.deepEqual(published.rerun(), []);
        assert.deepEqual(await records(), []);
    });

    test('does not restart a revision that was replaced while the restart waited for cancellation', async () => {
        const runs = [run({ id: 1 })];
        const github = createGitHub(runs, { asyncCancellation: true });
        await beginFollowupCiSuspension({ target: TARGET, taskId: TASK_ID }, deps(github));

        // The implementation publishes its replacement commit while the cancelled
        // run is still finishing, between two polls of the restore.
        const [result] = await releaseFollowupCiSuspensionsForTask({ taskId: TASK_ID }, deps(github, {
            restoreBudgetMs: 60_000,
            sleep: async () => { github.head.sha = NEW_HEAD; },
        }));

        assert.equal(result.reason, 'head_replaced');
        assert.deepEqual(github.rerun(), []);
        assert.deepEqual(await records(), []);
    });

    test('stops restarting once a replacement is published between two reruns', async () => {
        const runs = [run({ id: 1 }), run({ id: 2, status: 'queued' })];
        const github = createGitHub(runs, {
            // The implementation publishes its replacement commit while the first
            // rerun is in flight, after the single head check that began the restore.
            onRerun: async () => { github.head.sha = NEW_HEAD; },
        });
        await beginFollowupCiSuspension({ target: TARGET, taskId: TASK_ID }, deps(github));

        const [result] = await releaseFollowupCiSuspensionsForTask({ taskId: TASK_ID }, deps(github));

        assert.equal(result.reason, 'head_replaced');
        assert.deepEqual(github.rerun(), [1], 'the obsolete revision is not restarted any further once its replacement exists');
        assert.deepEqual(result.restartedRunIds, [1]);
        assert.deepEqual(result.pendingRunIds, [2]);
        assert.deepEqual(await records(), [], 'the obsolete obligation is released');
        assert.equal(runs[1].status, 'completed');
        assert.equal(runs[1].conclusion, 'cancelled');
    });

    test('waits for asynchronous cancellation and finishes the restart on a later reconciliation', async () => {
        const runs = [run({ id: 1 })];
        const github = createGitHub(runs, { asyncCancellation: true });
        await beginFollowupCiSuspension({ target: TARGET, taskId: TASK_ID }, deps(github));

        const [pending] = await releaseFollowupCiSuspensionsForTask({ taskId: TASK_ID }, deps(github));
        assert.equal(pending.reason, 'pending');
        assert.deepEqual(github.rerun(), []);
        const [stored] = await records();
        assert.equal(stored.state, 'restoring');
        assert.equal(stored.attempts, 1);

        // GitHub finishes the cancellation; the owning task is gone after a restart.
        runs[0].status = 'completed';
        runs[0].conclusion = 'cancelled';
        const summary = await reconcileFollowupCiSuspensions(deps(github, { getTaskState: async () => null }));

        assert.equal(summary.restored, 1);
        assert.deepEqual(github.rerun(), [1]);
        assert.deepEqual(await records(), []);
    });

    test('never restarts a run that produced its own result before the cancellation landed', async () => {
        const runs = [run({ id: 1 })];
        const github = createGitHub(runs, { asyncCancellation: true });
        await beginFollowupCiSuspension({ target: TARGET, taskId: TASK_ID }, deps(github));

        runs[0].status = 'completed';
        runs[0].conclusion = 'failure';
        const [result] = await releaseFollowupCiSuspensionsForTask({ taskId: TASK_ID }, deps(github));

        assert.equal(result.reason, 'restarted');
        assert.deepEqual(github.rerun(), []);
        assert.deepEqual(await records(), []);
    });

    test('does not duplicate validation that GitHub already restarted', async () => {
        const runs = [run({ id: 1 })];
        const github = createGitHub(runs, { asyncCancellation: true });
        await beginFollowupCiSuspension({ target: TARGET, taskId: TASK_ID }, deps(github));

        // The run completed as cancelled, and a fresh run of the same workflow is queued.
        runs[0].status = 'completed';
        runs[0].conclusion = 'cancelled';
        runs.push(run({ id: 99, workflow_id: 1, status: 'queued' }));
        const [result] = await releaseFollowupCiSuspensionsForTask({ taskId: TASK_ID }, deps(github));

        assert.equal(result.reason, 'restarted');
        assert.deepEqual(github.rerun(), []);
        assert.deepEqual(await records(), []);
    });

    test('a cancelled run never stands in as its own replacement while its cancellation is still landing', async () => {
        const runs = [run({ id: 1 })];
        let restoring = false;
        const github = createGitHub(runs, {
            asyncCancellation: true,
            // The listing that begins the restore still shows the cancelled run in
            // progress; by the time the run itself is read, GitHub has landed the
            // cancellation. Only ProPR's own run ever appears for this workflow.
            onRequest: route => {
                if (!restoring || route !== 'GET /repos/{owner}/{repo}/actions/runs/{run_id}') return;
                runs[0].status = 'completed';
                runs[0].conclusion = 'cancelled';
            },
        });
        await beginFollowupCiSuspension({ target: TARGET, taskId: TASK_ID }, deps(github));
        assert.deepEqual(github.cancelled(), [1]);

        restoring = true;
        const [result] = await releaseFollowupCiSuspensionsForTask({ taskId: TASK_ID }, deps(github));

        assert.equal(result.reason, 'restarted');
        assert.deepEqual(result.restartedRunIds, [1]);
        assert.deepEqual(github.rerun(), [1], 'the run ProPR cancelled is restarted rather than mistaken for a replacement');
        assert.equal(runs[0].run_attempt, 2);
        assert.deepEqual(await records(), []);
    });

    test('a run of another event or another pull request never stands in for the cancelled validation', async () => {
        const runs = [run({ id: 1 })];
        const github = createGitHub(runs, { asyncCancellation: true });
        await beginFollowupCiSuspension({ target: TARGET, taskId: TASK_ID }, deps(github));

        runs[0].status = 'completed';
        runs[0].conclusion = 'cancelled';
        // Same workflow and same commit, but neither run validates this pull
        // request: the push run skips everything the pull request event checks.
        runs.push(run({ id: 98, workflow_id: 1, status: 'queued', event: 'push', pull_requests: [] }));
        runs.push(run({ id: 97, workflow_id: 1, status: 'queued', pull_requests: [{ number: 9999 }] }));
        const [result] = await releaseFollowupCiSuspensionsForTask({ taskId: TASK_ID }, deps(github));

        assert.equal(result.reason, 'restarted');
        assert.deepEqual(result.restartedRunIds, [1]);
        assert.deepEqual(github.rerun(), [1], 'the cancelled pull request validation was brought back itself');
        assert.deepEqual(await records(), []);
    });

    test('a refused rerun keeps the obligation and restores the checks once access is granted back', async () => {
        const runs = [run({ id: 1 }), run({ id: 2, status: 'queued' })];
        const denied = createGitHub(runs, { rerunStatus: 403 });
        await beginFollowupCiSuspension({ target: TARGET, taskId: TASK_ID }, deps(denied));

        const [result] = await releaseFollowupCiSuspensionsForTask({ taskId: TASK_ID }, deps(denied));

        assert.equal(result.reason, 'permission_denied');
        assert.deepEqual(result.pendingRunIds, [1, 2]);
        // The checks ProPR cancelled are still cancelled, so the obligation to
        // bring them back must survive the refusal.
        const [blocked] = await records();
        assert.equal(blocked.state, 'blocked');
        assert.deepEqual(await storedRunIds(), [1, 2]);
        assert.deepEqual(JSON.parse(blocked.cancelled_runs).map((entry: { restarted: boolean }) => entry.restarted), [false, false]);
        // A refusal never reached GitHub, so it must not spend the restart budget.
        assert.equal(blocked.attempts, 0);

        // Actions access is granted back; the next reconciliation honours the obligation.
        const restored = createGitHub(runs);
        const summary = await reconcileFollowupCiSuspensions(deps(restored, { getTaskState: async () => null }));

        assert.equal(summary.restored, 1);
        assert.deepEqual(restored.rerun().sort((a, b) => (a ?? 0) - (b ?? 0)), [1, 2]);
        assert.deepEqual(await records(), []);
    });

    test('a refused rerun releases its obligation once the cancelled head is obsolete', async () => {
        const runs = [run({ id: 1 })];
        const denied = createGitHub(runs, { rerunStatus: 403 });
        await beginFollowupCiSuspension({ target: TARGET, taskId: TASK_ID }, deps(denied));
        const [result] = await releaseFollowupCiSuspensionsForTask({ taskId: TASK_ID }, deps(denied));
        assert.equal(result.reason, 'permission_denied');
        assert.equal((await records())[0].state, 'blocked');

        // A replacement commit is published: the cancelled revision is obsolete.
        const replaced = createGitHub(runs, { headSha: NEW_HEAD, rerunStatus: 403 });
        const summary = await reconcileFollowupCiSuspensions(deps(replaced, { getTaskState: async () => null }));

        assert.equal(summary.released, 1);
        assert.deepEqual(replaced.rerun(), []);
        assert.deepEqual(await records(), []);
    });

    test('a rerun whose response was lost is not requested again once the run proves it restarted', async () => {
        const runs = [run({ id: 1 })];
        const github = createGitHub(runs, {
            asyncCancellation: true,
            // GitHub queues the run again and the response is lost on the way back.
            onRerun: async runId => {
                const found = runs.find(candidate => candidate.id === runId)!;
                found.status = 'queued';
                found.conclusion = null;
                found.run_attempt += 1;
                throw Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' });
            },
        });
        await beginFollowupCiSuspension({ target: TARGET, taskId: TASK_ID }, deps(github));
        runs[0].status = 'completed';
        runs[0].conclusion = 'cancelled';

        const [result] = await releaseFollowupCiSuspensionsForTask({ taskId: TASK_ID }, deps(github));

        assert.equal(result.reason, 'restarted');
        assert.deepEqual(result.restartedRunIds, [1]);
        assert.deepEqual(github.rerun(), [1], 'the lost response is reconciled from the run itself, not retried blindly');
        assert.deepEqual(await records(), []);
    });

    test('a rerun GitHub rejected while the cancellation was still converging keeps the obligation', async () => {
        const runs = [run({ id: 1 })];
        // Discovery already reports the run cancelled, but the rerun endpoint
        // still answers 409: the cancellation has not converged on GitHub's side.
        const converging = createGitHub(runs, { asyncCancellation: true, rerunStatus: 409 });
        await beginFollowupCiSuspension({ target: TARGET, taskId: TASK_ID }, deps(converging));
        runs[0].status = 'completed';
        runs[0].conclusion = 'cancelled';

        const [result] = await releaseFollowupCiSuspensionsForTask({ taskId: TASK_ID }, deps(converging));

        assert.equal(result.reason, 'pending');
        assert.deepEqual(result.pendingRunIds, [1]);
        assert.deepEqual(result.restartedRunIds, []);
        // The head is still current and its validation is still cancelled on
        // the attempt ProPR cancelled, so nothing may be released yet.
        const [retained] = await records();
        assert.equal(retained.state, 'restoring');
        assert.deepEqual(
            JSON.parse(retained.cancelled_runs).map((entry: { attempt?: number; restarted: boolean }) => [entry.attempt, entry.restarted]),
            [[1, false]],
        );
        assert.deepEqual([runs[0].conclusion, runs[0].run_attempt], ['cancelled', 1]);

        // The cancellation converged; the next reconciliation restarts the validation.
        const recovered = createGitHub(runs);
        const summary = await reconcileFollowupCiSuspensions(deps(recovered, { getTaskState: async () => null }));

        assert.equal(summary.restored, 1);
        assert.deepEqual(recovered.rerun(), [1]);
        assert.equal(runs[0].run_attempt, 2);
        assert.deepEqual(await records(), []);
    });

    test('a rerun GitHub rejected because the attempt was already restarted settles the obligation without a duplicate', async () => {
        const runs = [run({ id: 1 })];
        const github = createGitHub(runs, {
            asyncCancellation: true,
            // Somebody restarted the cancelled attempt just before ProPR did;
            // GitHub rejects the duplicate and the run already carries attempt 2.
            onRerun: async runId => {
                const found = runs.find(candidate => candidate.id === runId)!;
                found.status = 'queued';
                found.conclusion = null;
                found.run_attempt += 1;
                throw Object.assign(new Error('status 409'), { status: 409 });
            },
        });
        await beginFollowupCiSuspension({ target: TARGET, taskId: TASK_ID }, deps(github));
        runs[0].status = 'completed';
        runs[0].conclusion = 'cancelled';

        const [result] = await releaseFollowupCiSuspensionsForTask({ taskId: TASK_ID }, deps(github));

        assert.equal(result.reason, 'restarted');
        assert.deepEqual(result.restartedRunIds, [], 'the restart was not ProPR\'s');
        assert.deepEqual(github.rerun(), [1]);
        assert.equal(runs[0].run_attempt, 2);
        assert.deepEqual(await records(), []);
    });

    test('a lost rerun response is not taken as a restart while the run is only pending on the cancelled attempt', async () => {
        const runs = [run({ id: 1 })];
        const github = createGitHub(runs, {
            asyncCancellation: true,
            // The response is lost while the run is still winding down on the
            // very attempt ProPR cancelled: nothing has been restarted.
            onRerun: async runId => {
                const found = runs.find(candidate => candidate.id === runId)!;
                found.status = 'in_progress';
                found.conclusion = null;
                throw Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' });
            },
        });
        await beginFollowupCiSuspension({ target: TARGET, taskId: TASK_ID }, deps(github));
        runs[0].status = 'completed';
        runs[0].conclusion = 'cancelled';

        const [result] = await releaseFollowupCiSuspensionsForTask({ taskId: TASK_ID }, deps(github));

        assert.equal(result.reason, 'pending');
        assert.deepEqual(result.pendingRunIds, [1]);
        assert.deepEqual(result.restartedRunIds, []);
        const [retained] = await records();
        assert.equal(retained.state, 'restoring');
        assert.deepEqual(
            JSON.parse(retained.cancelled_runs).map((entry: { attempt?: number; restarted: boolean }) => [entry.attempt, entry.restarted]),
            [[1, false]],
        );

        // The cancellation finishes on attempt 1; reconciliation now brings the validation back.
        runs[0].status = 'completed';
        runs[0].conclusion = 'cancelled';
        const recovered = createGitHub(runs);
        const summary = await reconcileFollowupCiSuspensions(deps(recovered, { getTaskState: async () => null }));

        assert.equal(summary.restored, 1);
        assert.deepEqual(recovered.rerun(), [1]);
        assert.equal(runs[0].run_attempt, 2);
        assert.deepEqual(await records(), []);
    });

    test('an attempt a crashed pass already restarted is never rerun again, even once its newer attempt was cancelled', async () => {
        const runs = [run({ id: 1 })];
        let workerDied = false;
        const github = createGitHub(runs, {
            onRerun: async runId => {
                // GitHub accepts the rerun and starts attempt 2. The worker dies right
                // there: neither the response nor any evidence reaches it, so the
                // record still says attempt 1 was cancelled and never restarted.
                const found = runs.find(candidate => candidate.id === runId)!;
                found.status = 'queued';
                found.conclusion = null;
                found.run_attempt += 1;
                workerDied = true;
                throw Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' });
            },
            onRequest: async route => {
                if (workerDied && route === 'GET /repos/{owner}/{repo}/actions/runs/{run_id}') throw Object.assign(new Error('worker died'), { status: 500 });
            },
        });
        await beginFollowupCiSuspension({ target: TARGET, taskId: TASK_ID }, deps(github));
        const [crashed] = await releaseFollowupCiSuspensionsForTask({ taskId: TASK_ID }, deps(github));
        assert.equal(crashed.reason, 'pending');
        const [stored] = await records();
        assert.deepEqual(
            JSON.parse(stored.cancelled_runs).map((entry: { attempt: number; restarted: boolean }) => [entry.attempt, entry.restarted]),
            [[1, false]], 'the crash left the original obligation recorded against attempt 1');
        assert.equal(runs[0].run_attempt, 2);
        workerDied = false;

        // Somebody at GitHub cancels the restarted attempt. That is theirs, not
        // ProPR's: the attempt ProPR cancelled was already brought back.
        runs[0].status = 'completed';
        runs[0].conclusion = 'cancelled';
        const summary = await reconcileFollowupCiSuspensions(deps(github, { getTaskState: async () => null }));

        assert.equal(summary.released, 1);
        assert.equal(summary.restored, 0);
        assert.deepEqual(github.rerun(), [1], 'the only rerun is the one the crashed pass sent');
        assert.equal(runs[0].run_attempt, 2, 'the cancelled newer attempt is left as it is');
        assert.deepEqual(await records(), [], 'the stored attempt is the proof that the obligation was met');
    });

    test('a run an operator reran and cancelled again while earlier runs were restarted is settled, not rerun on their behalf', async () => {
        const runs = [run({ id: 1 }), run({ id: 2 })];
        const github = createGitHub(runs, {
            onRerun: async runId => {
                if (runId !== 1) return;
                // While ProPR's rerun of run 1 is outstanding, an operator reruns run
                // 2 as attempt 2 and cancels that attempt. Run 2 is cancelled again,
                // but on an attempt past the one ProPR cancelled.
                runs[1].attempts = { 1: { status: 'completed', conclusion: 'cancelled' } };
                runs[1].run_attempt = 2;
                runs[1].status = 'completed';
                runs[1].conclusion = 'cancelled';
            },
        });
        await beginFollowupCiSuspension({ target: TARGET, taskId: TASK_ID }, deps(github));
        const [stored] = await records();
        assert.deepEqual(
            JSON.parse(stored.cancelled_runs).map((entry: { id: number; attempt?: number }) => [entry.id, entry.attempt]),
            [[1, 1], [2, 1]], 'both cancellations are on record against attempt 1');

        // The head is unchanged when implementation ends. The operator's rerun of
        // run 2 met ProPR's obligation; what they did with their attempt afterwards
        // is theirs, and the listing the pass started with must not decide otherwise.
        const [result] = await releaseFollowupCiSuspensionsForTask({ taskId: TASK_ID }, deps(github));

        assert.equal(result.reason, 'restarted');
        assert.deepEqual(result.restartedRunIds, [1]);
        assert.deepEqual(github.rerun(), [1], 'run 2 is judged on its fresh attempt, and its newer cancelled attempt is left alone');
        assert.equal(runs[1].run_attempt, 2, 'no attempt 3 is started on the operator\'s behalf');
        assert.deepEqual([runs[1].status, runs[1].conclusion], ['completed', 'cancelled']);
        assert.deepEqual(await records(), [], 'the advanced attempt is the proof that the obligation was met');
    });

    test('an obligation without a confirmed attempt records the attempt it reruns before the rerun is sent', async () => {
        const runs = [run({ id: 1 })];
        let cancelSent = false;
        let readBackFails = true;
        let workerDied = false;
        let attemptOnRecordAtRerun: number | undefined;
        const github = createGitHub(runs, {
            onRequest: async route => {
                if (route === 'POST /repos/{owner}/{repo}/actions/runs/{run_id}/cancel') cancelSent = true;
                if (!cancelSent || route !== 'GET /repos/{owner}/{repo}/actions/runs/{run_id}') return;
                // Reading the run back after the cancellation fails, so the attempt
                // ProPR cancelled was never confirmed; later the worker is dead.
                if (readBackFails || workerDied) throw Object.assign(new Error('read back failed'), { status: 500 });
            },
            onRerun: async runId => {
                const [stored] = await records();
                attemptOnRecordAtRerun = JSON.parse(stored.cancelled_runs)[0].attempt;
                // GitHub accepts the rerun and starts attempt 2. The worker dies right
                // there, before it can record that the restart happened.
                const found = runs.find(candidate => candidate.id === runId)!;
                found.status = 'queued';
                found.conclusion = null;
                found.run_attempt += 1;
                workerDied = true;
                throw Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' });
            },
        });
        const begun = await beginFollowupCiSuspension({ target: TARGET, taskId: TASK_ID }, deps(github));
        assert.equal(begun.reason, 'suspended');
        readBackFails = false;
        const [unconfirmed] = await records();
        assert.deepEqual(
            JSON.parse(unconfirmed.cancelled_runs).map((entry: { attempt?: number; restarted: boolean }) => [entry.attempt, entry.restarted]),
            [[undefined, false]], 'the cancellation landed on an attempt the worker never learned');

        const [crashed] = await releaseFollowupCiSuspensionsForTask({ taskId: TASK_ID }, deps(github));

        assert.equal(crashed.reason, 'pending');
        assert.equal(attemptOnRecordAtRerun, 1, 'the attempt being rerun was on record before GitHub received the rerun');
        const [stored] = await records();
        assert.deepEqual(
            JSON.parse(stored.cancelled_runs).map((entry: { attempt?: number; restarted: boolean }) => [entry.attempt, entry.restarted]),
            [[1, false]], 'the crash left the obligation recorded against the attempt that was rerun');
        assert.equal(runs[0].run_attempt, 2);
        workerDied = false;

        // Somebody at GitHub cancels the restarted attempt. That is theirs, not
        // ProPR's: the attempt ProPR rerun is on record, and the run moved past it.
        runs[0].status = 'completed';
        runs[0].conclusion = 'cancelled';
        const summary = await reconcileFollowupCiSuspensions(deps(github, { getTaskState: async () => null }));

        assert.equal(summary.released, 1);
        assert.equal(summary.restored, 0);
        assert.deepEqual(github.rerun(), [1], 'the only rerun is the one the crashed pass sent');
        assert.equal(runs[0].run_attempt, 2, 'the cancelled newer attempt is left as it is');
        assert.deepEqual(await records(), [], 'the recorded attempt is the proof that the obligation was met');
    });

    test('a run an operator reran and cancelled again while its attempt was being recorded is settled, not rerun on their behalf', async () => {
        const runs = [run({ id: 1 })];
        let cancelSent = false;
        let readBackFails = true;
        const github = createGitHub(runs, {
            onRequest: async route => {
                if (route === 'POST /repos/{owner}/{repo}/actions/runs/{run_id}/cancel') cancelSent = true;
                if (!cancelSent || !readBackFails || route !== 'GET /repos/{owner}/{repo}/actions/runs/{run_id}') return;
                // Reading the run back after the cancellation fails, so the attempt
                // ProPR cancelled was never confirmed.
                throw Object.assign(new Error('read back failed'), { status: 500 });
            },
        });
        const begun = await beginFollowupCiSuspension({ target: TARGET, taskId: TASK_ID }, deps(github));
        assert.equal(begun.reason, 'suspended');
        readBackFails = false;
        const [unconfirmed] = await records();
        assert.deepEqual(
            JSON.parse(unconfirmed.cancelled_runs).map((entry: { observedAttempt?: number; attempt?: number }) => [entry.observedAttempt, entry.attempt]),
            [[1, undefined]], 'the cancellation landed on an attempt the worker never learned');

        let operatorActed = false;
        const rerunAndCancelWhileTheWriteReturns = async () => {
            const [stored] = await records();
            // Only the write that records attempt 1 as the one to rerun opens the
            // window; the restoring transition before it records no attempt.
            if (operatorActed || JSON.parse(stored.cancelled_runs)[0].attempt !== 1) return;
            operatorActed = true;
            // While that write's response is on its way back, an operator reruns
            // the workflow and cancels the attempt they started. The run is
            // cancelled again, but on an attempt past the one on record.
            runs[0].attempts = { 1: { status: 'completed', conclusion: 'cancelled' } };
            runs[0].run_attempt = 2;
            runs[0].status = 'completed';
            runs[0].conclusion = 'cancelled';
        };

        // The head is unchanged when implementation ends. The operator's rerun met
        // ProPR's obligation; what they did with their attempt afterwards is theirs.
        const [result] = await releaseFollowupCiSuspensionsForTask({ taskId: TASK_ID },
            deps(github, { database: databaseResumingAfterSuspensionWrite(rerunAndCancelWhileTheWriteReturns) }));

        assert.equal(operatorActed, true);
        assert.equal(result.reason, 'restarted');
        assert.deepEqual(result.restartedRunIds, []);
        assert.deepEqual(github.rerun(), [], 'no rerun leaves on the assessment from before the write');
        assert.equal(runs[0].run_attempt, 2, 'no attempt 3 is started on the operator\'s behalf');
        assert.deepEqual([runs[0].status, runs[0].conclusion], ['completed', 'cancelled']);
        assert.deepEqual(await records(), [], 'the advanced attempt is the proof that the obligation was met');
    });

    test('a run an operator reran and cancelled again while the head was being checked is settled, not rerun on their behalf', async () => {
        const runs = [run({ id: 1 })];
        let headChecksWhileReleasing = 0;
        let operatorActed = false;
        const github = createGitHub(runs, {
            onRequest: async route => {
                if (headChecksWhileReleasing < 0 || route !== 'GET /repos/{owner}/{repo}/pulls/{pull_number}') return;
                headChecksWhileReleasing += 1;
                // The first head check of the release precedes any assessment. The
                // second is the gate right before the rerun: the run was assessed
                // as cancelled on the attempt on record, and while the head is
                // being checked an operator reruns the workflow and cancels the
                // attempt they started.
                if (headChecksWhileReleasing !== 2) return;
                operatorActed = true;
                runs[0].attempts = { 1: { status: 'completed', conclusion: 'cancelled' } };
                runs[0].run_attempt = 2;
                runs[0].status = 'completed';
                runs[0].conclusion = 'cancelled';
            },
        });
        headChecksWhileReleasing = -1;
        await beginFollowupCiSuspension({ target: TARGET, taskId: TASK_ID }, deps(github));
        const [stored] = await records();
        assert.deepEqual(
            JSON.parse(stored.cancelled_runs).map((entry: { attempt?: number }) => entry.attempt), [1],
            'the cancellation is on record against attempt 1');

        headChecksWhileReleasing = 0;
        const [result] = await releaseFollowupCiSuspensionsForTask({ taskId: TASK_ID }, deps(github));

        assert.equal(operatorActed, true);
        assert.equal(result.reason, 'restarted');
        assert.deepEqual(result.restartedRunIds, []);
        assert.deepEqual(github.rerun(), [], 'no rerun leaves on the assessment from before the head check');
        assert.equal(runs[0].run_attempt, 2, 'no attempt 3 is started on the operator\'s behalf');
        assert.deepEqual([runs[0].status, runs[0].conclusion], ['completed', 'cancelled']);
        assert.deepEqual(await records(), [], 'the advanced attempt is the proof that the obligation was met');
    });

    test('keeps the obligation when a failed rerun left no evidence that it landed', async () => {
        const runs = [run({ id: 1 })];
        const github = createGitHub(runs, { rerunStatus: 500 });
        await beginFollowupCiSuspension({ target: TARGET, taskId: TASK_ID }, deps(github));

        const [result] = await releaseFollowupCiSuspensionsForTask({ taskId: TASK_ID }, deps(github));

        assert.equal(result.reason, 'pending');
        assert.deepEqual(result.pendingRunIds, [1]);
        const [stored] = await records();
        assert.equal(stored.state, 'restoring');
        assert.deepEqual(JSON.parse(stored.cancelled_runs).map((entry: { restarted: boolean }) => entry.restarted), [false]);
    });

    test('keeps an unresolved obligation after the attempt budget is spent and honours it once GitHub recovers', async () => {
        const runs = [run({ id: 1 }), run({ id: 2, status: 'queued' })];
        const failing = createGitHub(runs, { rerunStatus: 500 });
        await beginFollowupCiSuspension({ target: TARGET, taskId: TASK_ID }, deps(failing));
        // Every earlier attempt already failed to reach GitHub's rerun API.
        await database(PR_CI_SUSPENSIONS_TABLE).update({ attempts: MAX_RESTORE_ATTEMPTS - 1 });

        const [result] = await releaseFollowupCiSuspensionsForTask({ taskId: TASK_ID }, deps(failing));

        assert.equal(result.reason, 'blocked');
        assert.deepEqual(result.pendingRunIds, [1, 2]);
        // The head is still current and its checks are still cancelled, so the
        // obligation to bring them back must outlive the attempt budget.
        const [retained] = await records();
        assert.equal(retained.state, 'blocked');
        assert.deepEqual(await storedRunIds(), [1, 2]);
        assert.deepEqual(JSON.parse(retained.cancelled_runs).map((entry: { restarted: boolean }) => entry.restarted), [false, false]);

        // GitHub recovers; the retained record is what restores the validation.
        const recovered = createGitHub(runs);
        const summary = await reconcileFollowupCiSuspensions(deps(recovered, { getTaskState: async () => null }));

        assert.equal(summary.restored, 1);
        assert.deepEqual(recovered.rerun().sort((a, b) => (a ?? 0) - (b ?? 0)), [1, 2]);
        assert.deepEqual(await records(), []);
    });

    test('a spent attempt budget releases its obligation once the cancelled head is obsolete', async () => {
        const runs = [run({ id: 1 })];
        const failing = createGitHub(runs, { rerunStatus: 500 });
        await beginFollowupCiSuspension({ target: TARGET, taskId: TASK_ID }, deps(failing));
        await database(PR_CI_SUSPENSIONS_TABLE).update({ attempts: MAX_RESTORE_ATTEMPTS });
        const [blockedResult] = await releaseFollowupCiSuspensionsForTask({ taskId: TASK_ID }, deps(failing));
        assert.equal(blockedResult.reason, 'blocked');
        assert.equal((await records())[0].state, 'blocked');

        // A replacement commit is published: the cancelled revision is obsolete,
        // which is the evidence that nothing is owed any more.
        const replaced = createGitHub(runs, { headSha: NEW_HEAD, rerunStatus: 500 });
        const summary = await reconcileFollowupCiSuspensions(deps(replaced, { getTaskState: async () => null }));

        assert.equal(summary.released, 1);
        assert.deepEqual(replaced.rerun(), []);
        assert.deepEqual(await records(), []);
    });

    test('keeps the obligation while the pull request cannot be read, and honours it once it can be again', async () => {
        const runs = [run({ id: 1 })];
        const github = createGitHub(runs);
        await beginFollowupCiSuspension({ target: TARGET, taskId: TASK_ID }, deps(github));
        const [active] = await records();

        // The installation lost access to the private repository: the pull request
        // answers 404 although it is still open, on the very same head.
        const inaccessible = createGitHub(runs, { prStatus: 404 });
        const summary = await reconcileFollowupCiSuspensions(deps(inaccessible, { getTaskState: async () => null }));

        assert.equal(summary.released, 0);
        assert.equal(summary.errors, 0);
        assert.deepEqual(inaccessible.rerun(), []);
        assert.equal((await records()).length, 1, 'a pull request that cannot be seen is not a closed one');
        assert.deepEqual(await storedRunIds(), [1]);

        // Nor does a sweep, while the owner is still implementing, decide anything about a head it cannot see.
        const swept = await sweepFollowupCiSuspension(active, deps(inaccessible));
        assert.equal(swept.reason, 'head_unavailable');
        assert.deepEqual(inaccessible.cancelled(), []);
        assert.equal((await records()).length, 1);

        // Access is granted back and the head is unchanged: the cancelled checks come back.
        const restored = await reconcileFollowupCiSuspensions(deps(github, { getTaskState: async () => null }));

        assert.equal(restored.restored, 1);
        assert.deepEqual(github.rerun(), [1]);
        assert.deepEqual(await records(), []);
    });

    test('keeps the obligation when the run cannot be read once the head and its runs were, and honours it once it can be again', async () => {
        const runs = [run({ id: 1 })];
        const github = createGitHub(runs);
        await beginFollowupCiSuspension({ target: TARGET, taskId: TASK_ID }, deps(github));

        // Restoration reads the unchanged head and lists its runs; then, before the
        // awaited lookup of the cancelled run itself, an administrator removes the
        // installation's access to the private repository. The run answers 404
        // from then on, exactly as a deleted run would.
        const options: GitHubOptions = {
            onRequest: route => {
                if (route === 'GET /repos/{owner}/{repo}/actions/runs/{run_id}') options.runStatus = 404;
            },
        };
        const losingAccess = createGitHub(runs, options);
        const summary = await reconcileFollowupCiSuspensions(deps(losingAccess, { getTaskState: async () => null }));

        assert.equal(summary.released, 0, 'a run that cannot be read is not a settled one');
        assert.equal(summary.errors, 0);
        assert.deepEqual(losingAccess.rerun(), []);
        const [retained] = await records();
        assert.ok(retained, 'the obligation stays recorded for a reconciliation that can read the run');
        assert.equal(retained.state, 'restoring');
        assert.deepEqual(await storedRunIds(), [1]);
        assert.deepEqual([runs[0].status, runs[0].conclusion], ['completed', 'cancelled'], 'the current head\'s validation is still cancelled');

        // Access is granted back and the head is unchanged: the cancelled checks come back.
        const restored = await reconcileFollowupCiSuspensions(deps(github, { getTaskState: async () => null }));

        assert.equal(restored.restored, 1);
        assert.deepEqual(github.rerun(), [1]);
        assert.deepEqual(await records(), []);
    });

    test('keeps the obligation when the run cannot be read in the final lookup before its rerun', async () => {
        const runs = [run({ id: 1 })];
        const github = createGitHub(runs);
        await beginFollowupCiSuspension({ target: TARGET, taskId: TASK_ID }, deps(github));

        // The run is assessed as cancelled on the attempt on record and the gate
        // re-proves the head; access is lost during the very last read of the run
        // before the rerun would leave, and that read answers 404.
        let runLookups = 0;
        const options: GitHubOptions = {
            onRequest: route => {
                if (route !== 'GET /repos/{owner}/{repo}/actions/runs/{run_id}') return;
                runLookups += 1;
                if (runLookups === 2) options.runStatus = 404;
            },
        };
        const losingAccess = createGitHub(runs, options);
        const [result] = await releaseFollowupCiSuspensionsForTask({ taskId: TASK_ID }, deps(losingAccess));

        assert.equal(runLookups, 2, 'the final read before the rerun is the one that failed');
        assert.equal(result.reason, 'pending');
        assert.deepEqual(result.restartedRunIds, []);
        assert.deepEqual(result.pendingRunIds, [1]);
        assert.deepEqual(losingAccess.rerun(), [], 'no rerun leaves on a run that cannot be read');
        const [retained] = await records();
        assert.ok(retained, 'the obligation stays recorded');
        assert.equal(retained.state, 'restoring');
        assert.deepEqual(await storedRunIds(), [1]);

        // Access is granted back and the head is unchanged: the cancelled checks come back.
        const restored = await reconcileFollowupCiSuspensions(deps(github, { getTaskState: async () => null }));

        assert.equal(restored.restored, 1);
        assert.deepEqual(github.rerun(), [1]);
        assert.deepEqual(await records(), []);
    });

    test('a pull request that is confirmed closed still releases its obligation', async () => {
        const runs = [run({ id: 1 })];
        const github = createGitHub(runs);
        await beginFollowupCiSuspension({ target: TARGET, taskId: TASK_ID }, deps(github));

        github.head.state = 'closed';
        const [result] = await releaseFollowupCiSuspensionsForTask({ taskId: TASK_ID }, deps(github));

        assert.equal(result.reason, 'pull_request_closed');
        assert.deepEqual(github.rerun(), []);
        assert.deepEqual(await records(), []);
    });
});

describe('concurrent owners of one pull request suspension', () => {
    test('a sweep never re-cancels validation that is already being restored', async () => {
        const runs = [run({ id: 1 })];
        const github = createGitHub(runs, { asyncCancellation: true });
        await beginFollowupCiSuspension({ target: TARGET, taskId: TASK_ID }, deps(github));
        const [active] = await records();

        // The finalizer starts the release; the cancellation is still finishing, so
        // the suspension stays behind in the one-way restoring state.
        const [pending] = await releaseFollowupCiSuspensionsForTask({ taskId: TASK_ID }, deps(github));
        assert.equal(pending.reason, 'pending');

        // The recovery pass still holds the record as it read it before the release.
        runs.push(run({ id: 2, status: 'queued' }));
        const swept = await sweepFollowupCiSuspension(active, deps(github));

        assert.equal(swept.reason, 'superseded');
        assert.deepEqual(swept.cancelledRunIds, []);
        assert.deepEqual(github.cancelled(), [1], 'the late run is left alone while the suspension is being released');
        assert.deepEqual(await storedRunIds(), [1]);
    });

    test('interleaved sweep and release of the same pull request never cancel after restarting', async () => {
        const runs = [run({ id: 1 })];
        const github = createGitHub(runs);
        await beginFollowupCiSuspension({ target: TARGET, taskId: TASK_ID }, deps(github));
        const [active] = await records();
        runs.push(run({ id: 2, status: 'queued' }));

        const [swept, released] = await Promise.all([
            sweepFollowupCiSuspension(active, deps(github)),
            releaseFollowupCiSuspensionsForTask({ taskId: TASK_ID }, deps(github)),
        ]);

        assert.equal(swept.reason, 'swept');
        assert.equal(released[0].reason, 'restarted');
        const lastCancel = github.calls.map(call => call.route).lastIndexOf('POST /repos/{owner}/{repo}/actions/runs/{run_id}/cancel');
        const firstRerun = github.calls.map(call => call.route).indexOf('POST /repos/{owner}/{repo}/actions/runs/{run_id}/rerun');
        assert.ok(lastCancel < firstRerun, 'the two operations ran one after the other, not interleaved');
        assert.deepEqual(github.rerun().sort((a, b) => (a ?? 0) - (b ?? 0)), [1, 2], 'everything the sweep cancelled was restarted');
        assert.deepEqual(await records(), []);
    });

    test('a stale record can neither overwrite nor delete the suspension of a new owner', async () => {
        const runs = [run({ id: 1 })];
        const github = createGitHub(runs);
        await beginFollowupCiSuspension({ target: TARGET, taskId: TASK_ID }, deps(github));
        const [stale] = await records();

        // A replacement commit is published and a second follow-up takes the pull request over.
        runs.push(run({ id: 2, head_sha: NEW_HEAD, status: 'queued' }));
        const next = createGitHub(runs, { headSha: NEW_HEAD });
        await beginFollowupCiSuspension({ target: TARGET, taskId: 'task-next' }, deps(next));

        // The first task's finalizer and the recovery pass arrive late with what they read.
        const late = createGitHub(runs, { headSha: NEW_HEAD });
        const swept = await sweepFollowupCiSuspension(stale, deps(late));
        const restored = await restoreFollowupCiSuspension(stale, deps(late));

        assert.equal(swept.reason, 'superseded');
        assert.equal(restored.reason, 'superseded');
        assert.deepEqual(late.rerun(), []);
        assert.deepEqual(late.cancelled(), []);
        const [current] = await records();
        assert.equal(current.task_id, 'task-next');
        assert.equal(current.head_sha, NEW_HEAD);
        assert.equal(current.state, 'active');
        assert.deepEqual(await storedRunIds(), [2]);
    });
});

describe('coordinators in separate worker processes', () => {
    const tick = () => new Promise<void>(resolve => { setTimeout(resolve, 10); });

    test('a sweep and a release that share only the database never interleave, and nothing is cancelled after a restart', async () => {
        const journal: Array<{ coordinator: string; route: string; runId?: number }> = [];
        const runs = [run({ id: 1 })];
        const setup = createGitHub(runs, { journal, coordinator: 'setup' });
        await beginFollowupCiSuspension({ target: TARGET, taskId: TASK_ID }, deps(setup, { leaseHolder: 'worker-a' }));
        // What worker A's reconciliation pass read before it started sweeping.
        const [active] = await records();
        runs.push(run({ id: 2, status: 'queued' }));

        let reachedCancel!: () => void;
        const sweepIsInsideItsCancel = new Promise<void>(resolve => { reachedCancel = resolve; });
        let letSweepFinish!: () => void;
        const sweepMayContinue = new Promise<void>(resolve => { letSweepFinish = resolve; });
        let paused = false;
        const workerA = createGitHub(runs, {
            journal,
            coordinator: 'worker-a',
            onRequest: async route => {
                if (paused || !route.endsWith('/cancel')) return;
                paused = true;
                reachedCancel();
                await sweepMayContinue;
            },
        });
        const workerB = createGitHub(runs, { journal, coordinator: 'worker-b' });

        // Worker A is inside the cancel request for the late run when worker B's
        // job finalizer starts releasing the very same pull request.
        const sweep = sweepFollowupCiSuspension(active, deps(workerA, { leaseHolder: 'worker-a' }));
        await sweepIsInsideItsCancel;
        const release = releaseFollowupCiSuspensionsForTask({ taskId: TASK_ID }, deps(workerB, { leaseHolder: 'worker-b' }));

        // Nothing but the database is shared, and it is what holds worker B back.
        await tick();
        assert.deepEqual(workerB.calls, [], 'worker B does not touch GitHub while worker A holds the lease');
        const lease = await database(PR_CI_SUSPENSION_LEASES_TABLE).first();
        assert.equal(lease.holder, 'worker-a');
        assert.equal(lease.lease_key, 'integry/propr#2485');

        letSweepFinish();
        const [swept, released] = await Promise.all([sweep, release]);

        assert.equal(swept.reason, 'swept');
        assert.deepEqual(swept.cancelledRunIds, [2]);
        assert.equal(released[0].reason, 'restarted');
        assert.deepEqual(released[0].restartedRunIds.sort((a, b) => a - b), [1, 2], 'everything the sweep cancelled was restarted');

        // Worker A's reconciliation arrives once more with the state it read before
        // any of this: it must not cancel the validation worker B just restarted.
        const late = createGitHub(runs, { journal, coordinator: 'worker-a-late' });
        const lateSweep = await sweepFollowupCiSuspension(active, deps(late, { leaseHolder: 'worker-a' }));

        assert.equal(lateSweep.reason, 'superseded');
        assert.deepEqual(late.cancelled(), []);
        const lastCancel = journal.map(entry => entry.route).lastIndexOf('POST /repos/{owner}/{repo}/actions/runs/{run_id}/cancel');
        const firstRerun = journal.map(entry => entry.route).indexOf('POST /repos/{owner}/{repo}/actions/runs/{run_id}/rerun');
        assert.ok(firstRerun > 0 && lastCancel < firstRerun, 'no run was cancelled after a restart had started');
        assert.deepEqual(await records(), []);
        assert.deepEqual(await database(PR_CI_SUSPENSION_LEASES_TABLE).select('*'), [], 'every holder released its lease');
    });

    test('leaves a pull request alone while another worker holds its lease', async () => {
        const runs = [run({ id: 1 })];
        const github = createGitHub(runs);
        await beginFollowupCiSuspension({ target: TARGET, taskId: TASK_ID }, deps(github));
        const [active] = await records();
        runs.push(run({ id: 2, status: 'queued' }));

        // Another worker is in the middle of its own pass over this pull request.
        await database(PR_CI_SUSPENSION_LEASES_TABLE).insert({
            lease_key: 'integry/propr#2485', token: 'other-worker', holder: 'worker-b',
            acquired_at: Date.now(), expires_at: Date.now() + 60_000,
        });

        const busyDeps = deps(github, { leaseAcquireTimeoutMs: 0 });
        const swept = await sweepFollowupCiSuspension(active, busyDeps);
        const restored = await restoreFollowupCiSuspension(active, busyDeps);
        const begun = await beginFollowupCiSuspension({ target: TARGET, taskId: TASK_ID }, busyDeps);

        assert.equal(swept.reason, 'busy');
        assert.equal(restored.reason, 'busy');
        assert.deepEqual(restored.pendingRunIds, [1], 'the obligation stays with the record for the next pass');
        assert.equal(begun.reason, 'busy');
        assert.deepEqual(github.cancelled(), [1], 'only the original suspension cancelled anything');
        assert.deepEqual(github.rerun(), []);
        // The other worker's lease is untouched, and the record is still there.
        const [lease] = await database(PR_CI_SUSPENSION_LEASES_TABLE).select('*');
        assert.equal(lease.token, 'other-worker');
        assert.equal((await records()).length, 1);
    });

    test('a restore that loses its lease while waiting stops instead of restarting anything else', async () => {
        const runs = [run({ id: 1 }), run({ id: 2, status: 'queued' })];
        const github = createGitHub(runs, { asyncCancellation: true });
        await beginFollowupCiSuspension({ target: TARGET, taskId: TASK_ID }, deps(github));
        // The first cancellation finished; the second run is still finishing, so
        // the restore has to wait for it.
        runs[0].status = 'completed';
        runs[0].conclusion = 'cancelled';
        const [record] = await records();

        const result = await restoreFollowupCiSuspension(record, deps(github, {
            restoreBudgetMs: 60_000,
            // While this restore waits, its lease expires and another worker takes it.
            sleep: async () => {
                await database(PR_CI_SUSPENSION_LEASES_TABLE)
                    .update({ token: 'other-worker', holder: 'worker-b', expires_at: Date.now() + 60_000 });
            },
        }));

        assert.equal(result.reason, 'busy');
        assert.deepEqual(github.rerun(), [1], 'nothing was restarted after the lease was gone');
        assert.equal((await records()).length, 1, 'the obligation waits for whoever holds the lease now');
        const [lease] = await database(PR_CI_SUSPENSION_LEASES_TABLE).select('*');
        assert.equal(lease.token, 'other-worker', 'a lost lease is never released by its previous holder');
    });

    test('a restore that loses its lease while discovering runs reruns nothing on the new owner\'s suspension', async () => {
        const runs = [run({ id: 1 })];
        const github = createGitHub(runs);
        await beginFollowupCiSuspension({ target: TARGET, taskId: TASK_ID }, deps(github));
        const [record] = await records();
        // GitHub queued a late run of the same head after the suspension started.
        runs.push(run({ id: 2, status: 'queued' }));

        let reachedDiscovery!: () => void;
        const discoveryIsPaused = new Promise<void>(resolve => { reachedDiscovery = resolve; });
        let letDiscoveryFinish!: () => void;
        const discoveryMayContinue = new Promise<void>(resolve => { letDiscoveryFinish = resolve; });
        let paused = false;
        const workerA = createGitHub(runs, {
            onRequest: async route => {
                if (paused || route !== 'GET /repos/{owner}/{repo}/actions/runs') return;
                paused = true;
                reachedDiscovery();
                await discoveryMayContinue;
            },
        });

        // Worker A restores and stalls inside its run discovery for longer than
        // the lease lives.
        const restoreA = restoreFollowupCiSuspension(record, deps(workerA, { leaseHolder: 'worker-a' }));
        await discoveryIsPaused;
        await database(PR_CI_SUSPENSION_LEASES_TABLE).update({ expires_at: Date.now() - 1 });

        // A newer follow-up of the same head takes the expired lease over and
        // starts its own suspension, cancelling the late run.
        const workerB = createGitHub(runs);
        const begunB = await beginFollowupCiSuspension({ target: TARGET, taskId: 'task-next' },
            deps(workerB, { leaseHolder: 'worker-b', leaseAcquireTimeoutMs: 0 }));
        assert.equal(begunB.reason, 'suspended');
        assert.deepEqual(begunB.cancelledRunIds, [2]);

        // Worker A's discovery finally returns, with run 1 completed as cancelled.
        letDiscoveryFinish();
        const resultA = await restoreA;

        assert.equal(resultA.reason, 'busy');
        assert.deepEqual(workerA.rerun(), [], 'nothing is rerun on a lease that belongs to somebody else');
        assert.deepEqual(runs.map(candidate => candidate.status), ['completed', 'completed'], 'the new owner\'s suspension stays suspended');
        const [current] = await records();
        assert.equal(current.task_id, 'task-next');
        assert.equal(current.state, 'active');
        assert.deepEqual((await storedRunIds()).sort((a, b) => a - b), [1, 2], "the new owner's restart obligations survived the stale worker");
    });

    test('a restore that loses its lease while reading the pull request head reruns nothing, even on an unchanged head', async () => {
        const runs = [run({ id: 1 })];
        const github = createGitHub(runs);
        await beginFollowupCiSuspension({ target: TARGET, taskId: TASK_ID }, deps(github));
        const [record] = await records();

        let headLookups = 0;
        const worker = createGitHub(runs, {
            onRequest: async route => {
                if (route !== 'GET /repos/{owner}/{repo}/pulls/{pull_number}') return;
                headLookups += 1;
                // The first lookup decides whether the obligation still applies. The
                // second is the rerun gate's: while it is outstanding the lease
                // expires and another worker takes it over. The head it returns is
                // unchanged, so the head alone would let the rerun through.
                if (headLookups === 2) {
                    await database(PR_CI_SUSPENSION_LEASES_TABLE)
                        .update({ token: 'other-worker', holder: 'worker-b', expires_at: Date.now() + 60_000 });
                }
            },
        });

        const result = await restoreFollowupCiSuspension(record, deps(worker));

        assert.equal(headLookups, 2, 'the takeover happened during the gate\'s own head lookup');
        assert.equal(result.reason, 'busy');
        assert.deepEqual(worker.rerun(), [], 'nothing is rerun on a lease that belongs to somebody else');
        assert.equal(runs[0].status, 'completed', 'the suspension the new owner holds stays suspended');
        assert.equal((await records()).length, 1, 'the obligation waits for whoever holds the lease now');
        const [lease] = await database(PR_CI_SUSPENSION_LEASES_TABLE).select('*');
        assert.equal(lease.token, 'other-worker', 'a lost lease is never released by its previous holder');
    });

    test('a restore that loses its lease while reading the run one last time reruns nothing the new owner restored', async () => {
        const runs = [run({ id: 1 })];
        const github = createGitHub(runs);
        await beginFollowupCiSuspension({ target: TARGET, taskId: TASK_ID }, deps(github));
        const [record] = await records();

        const workerB = createGitHub(runs);
        const workerA = createGitHub(runs);
        let runReads = 0;
        let takenOver = false;
        const request = workerA.octokit.request;
        workerA.octokit.request = async (route, parameters) => {
            const response = await request(route, parameters);
            if (route !== 'GET /repos/{owner}/{repo}/actions/runs/{run_id}' || ++runReads !== 2 || takenOver) return response;
            takenOver = true;
            // The restore assessed the run, wrote the attempt it owes a rerun and
            // passed its gate; this is the final read before the rerun request.
            // Its response, attempt 1 cancelled, is captured, and then the worker
            // stalls for longer than the lease lives.
            await database(PR_CI_SUSPENSION_LEASES_TABLE).update({ expires_at: Date.now() - 1 });
            // Worker B takes the expired lease over, restores the run as attempt 2
            // and drops the suspension.
            const restored = await restoreFollowupCiSuspension(record, deps(workerB, { leaseHolder: 'worker-b', leaseAcquireTimeoutMs: 0 }));
            assert.equal(restored.reason, 'restarted');
            assert.deepEqual(workerB.rerun(), [1]);
            assert.deepEqual(await records(), []);
            // Worker A resumes with the response it captured before it stalled.
            return response;
        };

        const result = await restoreFollowupCiSuspension(record, deps(workerA, { leaseHolder: 'worker-a' }));

        assert.equal(runReads, 2, 'the takeover happened during the final read before the rerun request');
        assert.equal(result.reason, 'busy');
        assert.deepEqual(result.restartedRunIds, []);
        assert.deepEqual(workerA.rerun(), [], 'nothing is rerun on a lease that belongs to somebody else');
        assert.equal(runs[0].run_attempt, 2, 'the validation the new owner restored is not run a third time');
        assert.equal(runs[0].status, 'queued');
        assert.deepEqual(await records(), [], 'the stale worker left no suspension behind');
        assert.deepEqual(await database(PR_CI_SUSPENSION_LEASES_TABLE).select('*'), []);
    });

    test('a worker that lost its lease while reading the pull request never reserves the suspension over its new owner', async () => {
        const runs = [run({ id: 1 }), run({ id: 2, head_sha: NEW_HEAD, status: 'queued' })];
        let reachedLookup!: () => void;
        const lookupIsPaused = new Promise<void>(resolve => { reachedLookup = resolve; });
        let letLookupFinish!: () => void;
        const lookupMayContinue = new Promise<void>(resolve => { letLookupFinish = resolve; });
        let paused = false;
        const workerA = createGitHub(runs, {
            onRequest: async route => {
                if (paused || route !== 'GET /repos/{owner}/{repo}/pulls/{pull_number}') return;
                paused = true;
                reachedLookup();
                await lookupMayContinue;
            },
        });

        // Worker A takes the lease and stalls inside its pull request lookup for
        // longer than the lease lives.
        const begunA = beginFollowupCiSuspension({ target: TARGET, taskId: TASK_ID }, deps(workerA, { leaseHolder: 'worker-a' }));
        await lookupIsPaused;
        await database(PR_CI_SUSPENSION_LEASES_TABLE).update({ expires_at: Date.now() - 1 });

        // A replacement commit was published meanwhile; a second follow-up takes
        // the expired lease over and suspends the validation of the new head.
        const workerB = createGitHub(runs, { headSha: NEW_HEAD });
        const begunB = await beginFollowupCiSuspension({ target: TARGET, taskId: 'task-next' },
            deps(workerB, { leaseHolder: 'worker-b', leaseAcquireTimeoutMs: 0 }));
        assert.equal(begunB.reason, 'suspended');
        assert.deepEqual(begunB.cancelledRunIds, [2]);

        // Worker A's lookup finally returns, with the old head.
        letLookupFinish();
        const resultA = await begunA;

        assert.equal(resultA.reason, 'busy');
        assert.deepEqual(workerA.cancelled(), [], 'nothing is cancelled on a lease that belongs to somebody else');
        const [current] = await records();
        assert.equal(current.task_id, 'task-next');
        assert.equal(current.head_sha, NEW_HEAD);
        assert.deepEqual(await storedRunIds(), [2], "the new owner's restart obligation survived the stale worker");
        assert.deepEqual(await database(PR_CI_SUSPENSION_LEASES_TABLE).select('*'), [], 'the stale worker released nothing that was not its own');
    });

    test('a worker that lost its lease while reading an absent suspension never inserts over the one its new owner reserved', async () => {
        const runs = [run({ id: 1 }), run({ id: 2, head_sha: NEW_HEAD, status: 'queued' })];
        const workerB = createGitHub(runs, { headSha: NEW_HEAD });
        let takenOver = false;
        const takeOverWhileTheReadReturns = async () => {
            if (takenOver) return;
            takenOver = true;
            // Worker A read that nothing is reserved, but its lease expired while
            // the read's response was on its way back to it.
            await database(PR_CI_SUSPENSION_LEASES_TABLE).update({ expires_at: Date.now() - 1 });
            // A replacement commit was published meanwhile; a second follow-up takes
            // the expired lease over, reserves the pull request for the new head and
            // cancels its validation.
            const begunB = await beginFollowupCiSuspension({ target: TARGET, taskId: 'task-next' },
                deps(workerB, { leaseHolder: 'worker-b', leaseAcquireTimeoutMs: 0 }));
            assert.equal(begunB.reason, 'suspended');
            assert.deepEqual(begunB.cancelledRunIds, [2]);
        };
        const workerA = createGitHub(runs);

        const resultA = await beginFollowupCiSuspension({ target: TARGET, taskId: TASK_ID }, deps(workerA, {
            leaseHolder: 'worker-a',
            database: databaseResumingAfterSuspensionRead(takeOverWhileTheReadReturns),
        }));

        // The lease is asserted once the read has resolved, so the loss is
        // caught before the insert its primary key would have rejected anyway.
        assert.equal(resultA.reason, 'busy');
        assert.deepEqual(resultA.cancelledRunIds, []);
        assert.deepEqual(workerA.cancelled(), [], 'nothing is cancelled on a lease that belongs to somebody else');
        const [current] = await records();
        assert.equal(current.task_id, 'task-next');
        assert.equal(current.head_sha, NEW_HEAD);
        assert.equal(current.state, 'active');
        assert.deepEqual(await storedRunIds(), [2], "the new owner's restart obligation survived the stale worker");
        assert.equal(runs[0].status, 'in_progress', 'the validation the stale worker meant to cancel keeps running');
        assert.deepEqual(await database(PR_CI_SUSPENSION_LEASES_TABLE).select('*'), [], 'the stale worker released nothing that was not its own');
    });

    test('a worker that lost its lease while reading an existing suspension never takes it over from its new owner', async () => {
        const runs = [run({ id: 1 }), run({ id: 2, head_sha: NEW_HEAD, status: 'queued' })];
        // An earlier follow-up of the same head still owns the pull request.
        const earlier = createGitHub(runs, { asyncCancellation: true });
        await beginFollowupCiSuspension({ target: TARGET, taskId: 'task-earlier' }, deps(earlier));
        assert.deepEqual(await storedRunIds(), [1]);

        const workerB = createGitHub(runs, { headSha: NEW_HEAD });
        let takenOver = false;
        let generationOfNewOwner!: number;
        const takeOverWhileTheReadReturns = async () => {
            if (takenOver) return;
            takenOver = true;
            // Worker A read the earlier owner's row, but its lease expired while
            // the read's response was on its way back to it.
            await database(PR_CI_SUSPENSION_LEASES_TABLE).update({ expires_at: Date.now() - 1 });
            // A replacement commit was published meanwhile; a second follow-up takes
            // the expired lease over, takes the row over for the new head and
            // cancels its validation.
            const begunB = await beginFollowupCiSuspension({ target: TARGET, taskId: 'task-next' },
                deps(workerB, { leaseHolder: 'worker-b', leaseAcquireTimeoutMs: 0 }));
            assert.equal(begunB.reason, 'suspended');
            assert.deepEqual(begunB.cancelledRunIds, [2]);
            const [ownedByB] = await records();
            generationOfNewOwner = ownedByB.generation;
        };
        const workerA = createGitHub(runs);

        // Worker A is a retry of the earlier implementation on the same head.
        const resultA = await beginFollowupCiSuspension({ target: TARGET, taskId: TASK_ID }, deps(workerA, {
            leaseHolder: 'worker-a',
            database: databaseResumingAfterSuspensionRead(takeOverWhileTheReadReturns),
        }));

        // The lease is asserted once the read has resolved, so the loss is
        // caught before the takeover its generation predicate would have refused anyway.
        assert.equal(resultA.reason, 'busy');
        assert.deepEqual(workerA.cancelled(), [], 'nothing is cancelled on a lease that belongs to somebody else');
        const [current] = await records();
        assert.equal(current.task_id, 'task-next');
        assert.equal(current.head_sha, NEW_HEAD);
        assert.equal(current.generation, generationOfNewOwner, "the new owner's generation was not bumped by the stale worker");
        assert.deepEqual(await storedRunIds(), [2], "the new owner's restart obligation survived the stale worker");
        assert.deepEqual(await database(PR_CI_SUSPENSION_LEASES_TABLE).select('*'), [], 'the stale worker released nothing that was not its own');
    });

    test('a worker stalled before its reservation read never takes over the newer suspension it then reads', async () => {
        const runs = [run({ id: 1 }), run({ id: 2, head_sha: NEW_HEAD, status: 'queued' })];
        const workerB = createGitHub(runs, { headSha: NEW_HEAD });
        let stalled = false;
        let generationOfNewOwner!: number;
        const takeOverBeforeTheReadRuns = async () => {
            if (stalled) return;
            stalled = true;
            // Worker A captured the old head and proved its lease, then stalled
            // before its reservation read reached the database, for longer
            // than the lease lives.
            await database(PR_CI_SUSPENSION_LEASES_TABLE).update({ expires_at: Date.now() - 1 });
            // A replacement commit was published meanwhile; a second follow-up
            // takes the expired lease over, reserves the pull request for the
            // new head and cancels its validation.
            const begunB = await beginFollowupCiSuspension({ target: TARGET, taskId: 'task-next' },
                deps(workerB, { leaseHolder: 'worker-b', leaseAcquireTimeoutMs: 0 }));
            assert.equal(begunB.reason, 'suspended');
            assert.deepEqual(begunB.cancelledRunIds, [2]);
            const [ownedByB] = await records();
            generationOfNewOwner = ownedByB.generation;
            // Worker A's read now runs and returns B's fresh row: the generation
            // and incarnation it will write against are the new owner's own.
        };
        const workerA = createGitHub(runs);

        const resultA = await beginFollowupCiSuspension({ target: TARGET, taskId: TASK_ID }, deps(workerA, {
            leaseHolder: 'worker-a',
            database: databaseStalledBeforeSuspensionRead(takeOverBeforeTheReadRuns),
        }));

        assert.ok(stalled, 'the takeover happened while the reservation read was still ahead of the stale worker');
        assert.equal(resultA.reason, 'busy');
        assert.deepEqual(resultA.cancelledRunIds, []);
        assert.deepEqual(workerA.cancelled(), [], 'nothing is cancelled on a lease that belongs to somebody else');
        const [current] = await records();
        assert.equal(current.task_id, 'task-next', 'the new owner keeps the pull request');
        assert.equal(current.head_sha, NEW_HEAD, 'the new owner\'s head was not replaced by the obsolete one');
        assert.equal(current.state, 'active');
        assert.equal(current.generation, generationOfNewOwner, "the new owner's generation was not bumped by the stale worker");
        assert.deepEqual(await storedRunIds(), [2], "the new owner's restart obligation survived the stale worker");
        assert.equal(runs[0].status, 'in_progress', 'the validation the stale worker meant to cancel keeps running');
        assert.deepEqual(await database(PR_CI_SUSPENSION_LEASES_TABLE).select('*'), [], 'the stale worker released nothing that was not its own');
    });

    test('a sweep that loses its lease while its intent is being written cancels nothing the new owner restored', async () => {
        const runs = [run({ id: 1 })];
        // GitHub accepts the cancellation and applies it asynchronously, so a
        // sweep still finds the run pending and asks again.
        const github = createGitHub(runs, { asyncCancellation: true });
        const begun = await beginFollowupCiSuspension({ target: TARGET, taskId: TASK_ID }, deps(github));
        assert.deepEqual(begun.cancelledRunIds, [1]);
        const [record] = await records();

        const workerB = createGitHub(runs);
        let takenOver = false;
        const takeOverWhileTheWriteReturns = async () => {
            if (takenOver) return;
            takenOver = true;
            // Worker A's intent has landed, but its lease expired while the
            // write's response was on its way back to it.
            await database(PR_CI_SUSPENSION_LEASES_TABLE).update({ expires_at: Date.now() - 1 });
            // The cancellation lands; worker B takes the expired lease over,
            // restores the run and drops the suspension.
            runs[0].status = 'completed';
            runs[0].conclusion = 'cancelled';
            const restored = await restoreFollowupCiSuspension(record, deps(workerB, { leaseHolder: 'worker-b', leaseAcquireTimeoutMs: 0 }));
            assert.equal(restored.reason, 'restarted');
            assert.deepEqual(workerB.rerun(), [1]);
            assert.deepEqual(await records(), []);
        };
        const workerA = createGitHub(runs);
        const swept = await sweepFollowupCiSuspension(record, deps(workerA, {
            leaseHolder: 'worker-a',
            database: databaseResumingAfterSuspensionWrite(takeOverWhileTheWriteReturns),
        }));

        assert.equal(swept.reason, 'busy');
        assert.deepEqual(swept.cancelledRunIds, []);
        assert.deepEqual(workerA.cancelled(), [], 'nothing is cancelled on a lease that belongs to somebody else');
        assert.equal(runs[0].status, 'queued', 'the validation the new owner restored keeps running');
        assert.equal(runs[0].run_attempt, 2);
        assert.deepEqual(await records(), [], 'the stale worker left no suspension behind');
        assert.deepEqual(await database(PR_CI_SUSPENSION_LEASES_TABLE).select('*'), []);
    });

    test('a sweep that loses its lease while reading the run one last time cancels nothing the new owner restored', async () => {
        const runs = [run({ id: 1 })];
        // GitHub accepts the cancellation and applies it asynchronously, so a
        // sweep still finds the run pending and asks again.
        const github = createGitHub(runs, { asyncCancellation: true });
        const begun = await beginFollowupCiSuspension({ target: TARGET, taskId: TASK_ID }, deps(github));
        assert.deepEqual(begun.cancelledRunIds, [1]);
        const [record] = await records();

        const workerB = createGitHub(runs);
        const workerA = createGitHub(runs);
        let runReads = 0;
        let takenOver = false;
        const request = workerA.octokit.request;
        workerA.octokit.request = async (route, parameters) => {
            const response = await request(route, parameters);
            if (route !== 'GET /repos/{owner}/{repo}/actions/runs/{run_id}' || ++runReads !== 2 || takenOver) return response;
            takenOver = true;
            // The sweep re-read the run, wrote its intent and proved its lease;
            // this is the final read before the cancel request. Its response,
            // attempt 1 still running, is captured, and then the worker stalls
            // for longer than the lease lives.
            await database(PR_CI_SUSPENSION_LEASES_TABLE).update({ expires_at: Date.now() - 1 });
            // The earlier cancellation lands; worker B takes the expired lease
            // over, restores the run as attempt 2 and drops the suspension.
            runs[0].status = 'completed';
            runs[0].conclusion = 'cancelled';
            const restored = await restoreFollowupCiSuspension(record, deps(workerB, { leaseHolder: 'worker-b', leaseAcquireTimeoutMs: 0 }));
            assert.equal(restored.reason, 'restarted');
            assert.deepEqual(workerB.rerun(), [1]);
            assert.deepEqual(await records(), []);
            // Worker A resumes with the response it captured before it stalled.
            return response;
        };

        const swept = await sweepFollowupCiSuspension(record, deps(workerA, { leaseHolder: 'worker-a' }));

        assert.equal(runReads, 2, 'the takeover happened during the final read before the cancel request');
        assert.equal(swept.reason, 'busy');
        assert.deepEqual(swept.cancelledRunIds, []);
        assert.deepEqual(workerA.cancelled(), [], 'nothing is cancelled on a lease that belongs to somebody else');
        assert.equal(runs[0].status, 'queued', 'the validation the new owner restored keeps running');
        assert.equal(runs[0].run_attempt, 2);
        assert.deepEqual(await records(), [], 'the stale worker left no suspension behind');
        assert.deepEqual(await database(PR_CI_SUSPENSION_LEASES_TABLE).select('*'), []);
    });

    test('leaves CI untouched and the implementation running when the lease cannot be taken at all', async () => {
        const github = createGitHub([run({ id: 1 })]);

        // Every query fails, the way a database outage looks.
        const unavailableDatabase = () => { throw new Error('database is down'); };
        const result = await beginFollowupCiSuspension({ target: TARGET, taskId: TASK_ID },
            deps(github, { database: unavailableDatabase as never, leaseAcquireTimeoutMs: 0 }));

        assert.equal(result.suspended, false);
        assert.equal(result.reason, 'error');
        assert.deepEqual(github.cancelled(), []);
        assert.deepEqual(await records(), []);
    });

    test('takes over the lease of a worker that died holding it', async () => {
        const runs = [run({ id: 1 })];
        const github = createGitHub(runs);
        await beginFollowupCiSuspension({ target: TARGET, taskId: TASK_ID }, deps(github));
        await database(PR_CI_SUSPENSION_LEASES_TABLE).insert({
            lease_key: 'integry/propr#2485', token: 'dead-worker', holder: 'worker-b',
            acquired_at: Date.now() - 600_000, expires_at: Date.now() - 300_000,
        });

        const [result] = await releaseFollowupCiSuspensionsForTask({ taskId: TASK_ID }, deps(github, { leaseAcquireTimeoutMs: 0 }));

        assert.equal(result.reason, 'restarted');
        assert.deepEqual(github.rerun(), [1]);
        assert.deepEqual(await database(PR_CI_SUSPENSION_LEASES_TABLE).select('*'), []);
    });
});

describe('follow-up CI suspension reconciliation', () => {
    test('sweeps while the owning task is still implementing', async () => {
        const runs = [run({ id: 1 })];
        const github = createGitHub(runs);
        await beginFollowupCiSuspension({ target: TARGET, taskId: TASK_ID }, deps(github));
        runs.push(run({ id: 2, status: 'queued' }));

        const summary = await reconcileFollowupCiSuspensions(deps(github, { getTaskState: async () => ({ state: 'claude_execution' }) }));

        assert.equal(summary.swept, 1);
        assert.deepEqual(github.cancelled(), [1, 2]);
        assert.equal((await records()).length, 1);
    });

    test('restores the suspension of a task that never reported a terminal state', async () => {
        const runs = [run({ id: 1 })];
        const github = createGitHub(runs);
        await beginFollowupCiSuspension({ target: TARGET, taskId: TASK_ID }, deps(github));

        // A crashed worker leaves no task state behind.
        const summary = await reconcileFollowupCiSuspensions(deps(github, { getTaskState: async () => null }));

        assert.equal(summary.restored, 1);
        assert.deepEqual(github.rerun(), [1]);
        assert.deepEqual(await records(), []);
    });

    test('restores the suspension when the repository option is disabled mid-task', async () => {
        const runs = [run({ id: 1 })];
        const github = createGitHub(runs);
        await beginFollowupCiSuspension({ target: TARGET, taskId: TASK_ID }, deps(github));

        const summary = await reconcileFollowupCiSuspensions(deps(github, {
            isEnabled: async () => false,
            getTaskState: async () => ({ state: 'claude_execution' }),
        }));

        assert.equal(summary.released, 1);
        assert.deepEqual(github.rerun(), [1]);
        assert.deepEqual(await records(), []);
    });

    test('a repeated reconciliation pass restarts nothing twice', async () => {
        const runs = [run({ id: 1 })];
        const github = createGitHub(runs);
        await beginFollowupCiSuspension({ target: TARGET, taskId: TASK_ID }, deps(github));

        await reconcileFollowupCiSuspensions(deps(github, { getTaskState: async () => ({ state: 'completed' }) }));
        const second = await reconcileFollowupCiSuspensions(deps(github, { getTaskState: async () => ({ state: 'completed' }) }));

        assert.equal(second.scanned, 0);
        assert.deepEqual(github.rerun(), [1]);
    });

    test('replaces an obsolete suspension of the same pull request instead of restarting it', async () => {
        const runs = [run({ id: 1 })];
        const github = createGitHub(runs);
        await beginFollowupCiSuspension({ target: TARGET, taskId: TASK_ID }, deps(github));

        // A second follow-up starts after a replacement commit was published.
        runs.push(run({ id: 2, head_sha: NEW_HEAD, status: 'queued' }));
        const next = createGitHub(runs, { headSha: NEW_HEAD });
        await beginFollowupCiSuspension({ target: TARGET, taskId: 'task-next' }, deps(next));

        const stored = await records();
        assert.equal(stored.length, 1);
        assert.equal(stored[0].head_sha, NEW_HEAD);
        assert.equal(stored[0].task_id, 'task-next');
        assert.deepEqual(await storedRunIds(), [2]);
        assert.deepEqual(next.rerun(), []);
    });
});

describe('follow-up CI suspension lifecycle wiring', () => {
    test('only the authorized implementation path suspends validation, and every exit releases it', async () => {
        const job = await readFile(new URL('../src/jobs/processPullRequestCommentJob.ts', import.meta.url), 'utf8');
        const reviewJob = await readFile(new URL('../src/jobs/prCommentReviewJob.ts', import.meta.url), 'utf8');
        const cleanup = await readFile(new URL('../src/jobs/prCommentJobUtils.ts', import.meta.url), 'utf8');

        assert.equal(reviewJob.includes('FollowupCiSuspension'), false, 'review processing must never cancel checks');
        const labelGate = job.indexOf("reason: 'missing_required_label'");
        const authorizedFindings = job.indexOf("reason: 'no_authorized_review_findings'");
        const begin = job.indexOf('await suspendObsoleteValidationForImplementation(');
        assert.ok(labelGate > 0, 'the label authorization gate is still in place');
        assert.ok(authorizedFindings > 0, 'the /fix authorization gate is still in place');
        assert.ok(begin > authorizedFindings, 'suspension must follow instruction filtering and authorization');
        // cleanupJob runs in the job's finally for success, failure and cancellation.
        assert.ok(cleanup.includes('releaseFollowupCiSuspensionsForTask'), 'job cleanup releases the suspension');
        assert.ok(job.includes('await cleanupJob({ stateManager, lockKey, lockToken, taskId'), 'cleanup receives the owning task');
    });
});

describe('suspension identities survive row recreation', () => {
    test('an old cancellation callback cannot overwrite a same-task retry at the same generation', async () => {
        const store = await import('../src/jobs/followupCiSuspensionStore.ts');
        const runs = [run({ id: 901 })];
        let signal!: () => void;
        const paused = new Promise<void>(resolve => { signal = resolve; });
        let resume!: () => void;
        const continuation = new Promise<void>(resolve => { resume = resolve; });
        const worker = createGitHub(runs, { onCancel: async () => { signal(); await continuation; } });
        const original = beginFollowupCiSuspension({ target: TARGET, taskId: TASK_ID }, deps(worker));
        await paused;
        const [stale] = await records();
        assert.equal(stale.generation, 2);
        // Model stopped lease renewal while the old request's response is delayed.
        await database(PR_CI_SUSPENSION_LEASES_TABLE).update({ expires_at: Date.now() - 1 });
        await restoreFollowupCiSuspension(stale, deps(createGitHub(runs)));
        assert.equal((await records()).length, 0);
        const fresh = await store.reserveSuspension({ target: TARGET, headSha: HEAD, taskId: TASK_ID }, { database });
        assert.ok(fresh);
        const current = await store.saveCancelledRuns({ database }, fresh.record, [{ id: 902, attempt: 1, restarted: false }]);
        assert.ok(current);
        assert.equal(current.generation, stale.generation);
        assert.notEqual(current.incarnation, stale.incarnation);
        resume();
        await original;
        assert.deepEqual(await storedRunIds(), [902]);
        assert.equal(await store.deleteSuspension({ database }, stale), false);
        assert.equal(await store.saveCancelledRuns({ database }, stale, []), null);
        assert.deepEqual(await storedRunIds(), [902]);
    });

    test('a stale reservation cannot take over a recreated row with identical owner and generation', async () => {
        const store = await import('../src/jobs/followupCiSuspensionStore.ts');
        const params = { target: TARGET, headSha: HEAD, taskId: TASK_ID };
        const original = await store.reserveSuspension(params, { database });
        assert.ok(original);
        const staleDatabase = databaseResumingAfterSuspensionRead(async () => {
            await store.deleteSuspension({ database }, original.record);
            await store.reserveSuspension(params, { database });
        });
        assert.equal(await store.reserveSuspension(params, { database: staleDatabase }), null);
        const [current] = await records();
        assert.notEqual(current.incarnation, original.record.incarnation);
        assert.equal(current.generation, original.record.generation);
    });
});

test('incarnation migration preserves existing restoration records and is reversible', async () => {
    const legacy = knex({ client: 'better-sqlite3', connection: { filename: ':memory:' }, useNullAsDefault: true });
    try {
        await up(legacy);
        const row = { repository: 'integry/propr', pull_request: 1, head_sha: HEAD, task_id: TASK_ID,
            state: 'restoring', cancelled_runs: '[{"id":42}]', attempts: 3, generation: 9,
            created_at: 1, updated_at: 2, correlation_id: null };
        await legacy(PR_CI_SUSPENSIONS_TABLE).insert([row, { ...row, pull_request: 2 }]);
        const migration = await import('../packages/core/src/db/migrations/20260924010000_add_ci_suspension_incarnation.js');
        await migration.up(legacy);
        const migrated = await legacy(PR_CI_SUSPENSIONS_TABLE).orderBy('pull_request');
        assert.notEqual(migrated[0].incarnation, migrated[1].incarnation);
        assert.match(migrated[0].incarnation, /^[a-f0-9-]{36}$/);
        const { incarnation: _token, ...preserved } = migrated[0];
        assert.deepEqual(preserved, row);
        await migration.down(legacy);
        assert.deepEqual(await legacy(PR_CI_SUSPENSIONS_TABLE).where('pull_request', 1).first(), row);
    } finally { await legacy.destroy(); }
});
