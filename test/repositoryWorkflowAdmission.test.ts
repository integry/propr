import assert from 'node:assert/strict';
import { mock, test } from 'node:test';
import { spawn, spawnSync } from 'node:child_process';
import { access, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { setImmediate } from 'node:timers/promises';
import { Queue, Worker, DelayedError } from 'bullmq';
import { Redis } from 'ioredis';
import { ACQUIRE_WORKFLOW_SLOT, repositoryWorkflowSlotKeys, withRepositoryWorkflowSlot, releaseRepositoryWorkflowSlot, reconcileRepositoryWorkflowSlot, forgetRepositoryWorkflowWaiter, RepositoryWorkflowCapacityError, RepositoryWorkflowLeaseLostError } from '../packages/core/src/workflow/workflowConcurrency.js';
import { loadRepositoryWorkflow, WORKFLOW_MAX_BYTES, WORKFLOW_PATH, RepositoryWorkflowPolicyError } from '../packages/core/src/workflow/repositoryWorkflow.js';
import { withRetry } from '../packages/core/src/utils/retryHandler.js';
import { runWithExecutionAbortSignal, ExecutionAbortedError } from '../packages/core/src/claude/docker/dockerExecutionOwnership.js';
import { executeWithRepositoryWorkflow } from '../packages/core/src/workflow/workflowExecution.js';

let settings: Record<string, unknown> = {};
await mock.module('@propr/core', { namedExports: {
    withRepositoryWorkflowSlot, releaseRepositoryWorkflowSlot, reconcileRepositoryWorkflowSlot, forgetRepositoryWorkflowWaiter, RepositoryWorkflowCapacityError, RepositoryWorkflowLeaseLostError, loadRepositoryWorkflow, WORKFLOW_MAX_BYTES, WORKFLOW_PATH,
    executeWithRepositoryWorkflow, loadSettings: async () => settings, RepositoryWorkflowPolicyError, withRetry,
    retryConfigs: { githubApi: { maxAttempts: 3, baseDelay: 1, maxDelay: 1, exponentialBase: 1, retryableErrors: [] } },
    TaskStates: { CANCELLED: 'cancelled', FAILED: 'failed', COMPLETED: 'completed' },
} });
const {
    deferRepositoryWorkflowJob, withRepositoryWorkflowAdmission, runRepositoryWorkflow, repositoryWorkflowDeferralDelayMs, resolveRepositoryWorkflow, repositoryWorkflowDeferralData,
    prepareRepositoryWorkflow, clearAbsentRepositoryWorkflowCache, recordRepositoryWorkflowDeferral, isUserCancellationError, nonRetryableRepositoryWorkflowError,
} = await import('../src/jobs/repositoryWorkflow.js');
const log = { error() {}, warn() {} };

/** A GitHub client serving the given branches; each maps to a commit and an optional workflow file. */
function githubFixture(branches: Record<string, { sha: string; workflow?: string }>, defaultBranch = 'main') {
    const requests: string[] = [];
    const octokit = { request: async (route: string, params: { ref?: string; path?: string }) => {
        requests.push(params.ref ? `${route} ${params.ref}` : route);
        if (route === 'GET /repos/{owner}/{repo}') return { data: { default_branch: defaultBranch } };
        if (route === 'GET /repos/{owner}/{repo}/commits/{ref}') {
            const branch = branches[params.ref!];
            if (!branch) throw Object.assign(new Error('No commit found for SHA'), { status: 404 });
            return { data: { sha: branch.sha } };
        }
        const branch = Object.values(branches).find(candidate => candidate.sha === params.ref);
        if (!branch?.workflow || params.path !== WORKFLOW_PATH) throw Object.assign(new Error('Not Found'), { status: 404 });
        const content = Buffer.from(branch.workflow);
        return { data: { type: 'file', encoding: 'base64', content: content.toString('base64'), size: content.length, sha: `blob-${branch.sha}` } };
    } };
    return { octokit: octokit as never, requests };
}

test('policy for a base branch that does not exist yet comes from the default branch the worktree starts from', async () => {
    clearAbsentRepositoryWorkflowCache();
    const { octokit, requests } = githubFixture({ main: { sha: 'main-sha', workflow: 'limits: { max_parallel_tasks: 2 }' } });
    const workflow = await prepareRepositoryWorkflow({ octokit, repoOwner: 'owner', repoName: 'repo', baseBranch: 'propr/epic-7', defaultBranch: 'main' });
    assert.equal(workflow?.baseBranch, 'main');
    assert.equal(workflow?.revision, 'main-sha');
    assert.equal(workflow?.maxParallelTasks, 2);
    assert.ok(!requests.includes('GET /repos/{owner}/{repo}'), 'a known default branch needs no repository lookup');
    // Without a known default branch, it is looked up only after the base is missing.
    const lookup = githubFixture({ trunk: { sha: 'trunk-sha', workflow: '{}' } }, 'trunk');
    assert.equal((await prepareRepositoryWorkflow({ octokit: lookup.octokit, repoOwner: 'owner', repoName: 'repo', baseBranch: 'propr/epic-8' }))?.baseBranch, 'trunk');
    // Other failures are not mistaken for a missing branch.
    const broken = { request: async () => { throw Object.assign(new Error('Server Error'), { status: 502 }); } };
    await assert.rejects(prepareRepositoryWorkflow({ octokit: broken as never, repoOwner: 'owner', repoName: 'repo', baseBranch: 'release' }), /Server Error/);
});

test('an empty repository has no workflow, so implementation reaches repository initialization', async () => {
    clearAbsentRepositoryWorkflowCache();
    // GitHub answers every commit lookup in a repository without commits with 409.
    const empty = Object.assign(new Error('Git Repository is empty. - https://docs.github.com/rest/commits/commits#get-a-commit'), {
        status: 409, response: { data: { message: 'Git Repository is empty.' } },
    });
    const requests: string[] = [];
    const octokit = { request: async (route: string, params: { ref?: string }) => {
        requests.push(`${route} ${params.ref ?? ''}`.trim());
        if (route === 'GET /repos/{owner}/{repo}') return { data: { default_branch: 'main' } };
        throw empty;
    } } as never;
    assert.equal(await prepareRepositoryWorkflow({ octokit, repoOwner: 'owner', repoName: 'repo', defaultBranch: 'main' }), undefined);
    assert.deepEqual(requests, ['GET /repos/{owner}/{repo}/commits/{ref} main'], 'nothing else is read, and a 409 is not retried');
    // A requested base branch in an empty repository behaves the same.
    assert.equal(await prepareRepositoryWorkflow({ octokit, repoOwner: 'owner', repoName: 'repo', baseBranch: 'release' }), undefined);
    // Other conflicts and authentication failures still fail the attempt.
    for (const error of [Object.assign(new Error('Conflict'), { status: 409 }), Object.assign(new Error('Bad credentials'), { status: 401 })]) {
        const failing = { request: async () => { throw error; } } as never;
        await assert.rejects(prepareRepositoryWorkflow({ octokit: failing, repoOwner: 'owner', repoName: 'repo', defaultBranch: 'main' }), error);
    }
});

test('transient GitHub failures while reading policy are retried instead of failing the run', async () => {
    clearAbsentRepositoryWorkflowCache();
    const { octokit: fixture, requests } = githubFixture({ main: { sha: 'main-sha', workflow: 'validation: [npm test]' } });
    const failures = new Map([['GET /repos/{owner}/{repo}/commits/{ref}', 2], ['GET /repos/{owner}/{repo}/contents/{path}', 1]]);
    const octokit = { request: async (route: string, params: object) => {
        const remaining = failures.get(route) ?? 0;
        if (remaining) { failures.set(route, remaining - 1); throw Object.assign(new Error('Bad Gateway'), { status: 502 }); }
        return (fixture as unknown as { request(route: string, params: object): Promise<unknown> }).request(route, params);
    } } as never;
    assert.deepEqual((await prepareRepositoryWorkflow({ octokit, repoOwner: 'owner', repoName: 'repo', defaultBranch: 'main' }))?.config, { validation: ['npm test'] });
    assert.equal(requests.length, 2);
    // Persistent failures still surface after the bounded attempts.
    const broken = { request: async () => { throw Object.assign(new Error('Server Error'), { status: 502 }); } };
    let attempts = 0;
    await assert.rejects(prepareRepositoryWorkflow({ octokit: { request: async () => { attempts++; return broken.request(); } } as never, repoOwner: 'owner', repoName: 'repo', defaultBranch: 'main' }), /Server Error/);
    assert.equal(attempts, 3);
});

test('an unusable instance worker_concurrency falls back instead of blaming the workflow file', async () => {
    const { octokit } = githubFixture({ main: { sha: 'main-sha', workflow: 'limits: { max_parallel_tasks: 50 }' } });
    const previous = process.env.WORKER_CONCURRENCY;
    try {
        for (const [setting, env, expected] of [['', undefined, 5], ['abc', '3', 3], [0, undefined, 5], [7, undefined, 7], ['6', undefined, 6]] as const) {
            settings = { worker_concurrency: setting };
            if (env === undefined) delete process.env.WORKER_CONCURRENCY; else process.env.WORKER_CONCURRENCY = env;
            assert.equal((await prepareRepositoryWorkflow({ octokit, repoOwner: 'owner', repoName: 'repo', defaultBranch: 'main' }))?.maxParallelTasks, expected, String(setting));
        }
    } finally {
        settings = {};
        if (previous === undefined) delete process.env.WORKER_CONCURRENCY; else process.env.WORKER_CONCURRENCY = previous;
    }
    // Other callers passing a malformed instance value get an error naming the instance setting.
    await assert.rejects(loadRepositoryWorkflow({ resolveRevision: async () => assert.fail('validated first'), readFile: async () => null }, 'main', { maxParallelTasks: Number.NaN }),
        (error: Error) => error.message === 'Invalid instance setting: worker_concurrency must be a positive integer' && !(error instanceof RepositoryWorkflowPolicyError));
});

test('an invalid workflow file fails the job once instead of re-reporting it on every retry', async () => {
    const { octokit } = githubFixture({ main: { sha: 'main-sha', workflow: 'unknown: true' } });
    const error = await prepareRepositoryWorkflow({ octokit, repoOwner: 'owner', repoName: 'repo', defaultBranch: 'main' }).catch(failure => failure);
    assert.ok(error instanceof RepositoryWorkflowPolicyError);
    const unrecoverable = nonRetryableRepositoryWorkflowError(error) as Error;
    assert.equal(unrecoverable.name, 'UnrecoverableError');
    assert.equal(unrecoverable.message, error.message);
    const transient = new Error('Bad Gateway');
    assert.equal(nonRetryableRepositoryWorkflowError(transient), transient);
});

test('an issue with a known default branch and no base override resolves policy without a repository lookup', async () => {
    clearAbsentRepositoryWorkflowCache();
    const { octokit, requests } = githubFixture({ main: { sha: 'main-sha' } });
    assert.equal(await prepareRepositoryWorkflow({ octokit, repoOwner: 'owner', repoName: 'repo', defaultBranch: 'main' }), undefined);
    assert.deepEqual(requests, ['GET /repos/{owner}/{repo}/commits/{ref} main', 'GET /repos/{owner}/{repo}/contents/{path} main-sha']);
});

test('a missing workflow is remembered per base commit, so later jobs skip only the contents lookup', async () => {
    clearAbsentRepositoryWorkflowCache();
    const branches: Record<string, { sha: string; workflow?: string }> = { main: { sha: 'sha-1' } };
    const { octokit, requests } = githubFixture(branches);
    const prepare = () => prepareRepositoryWorkflow({ octokit, repoOwner: 'Owner', repoName: 'Repo', baseBranch: 'main' });
    assert.equal(await prepare(), undefined);
    assert.equal(await prepare(), undefined);
    assert.equal(requests.filter(route => route.includes('/contents/')).length, 1);
    assert.equal(requests.filter(route => route.includes('/commits/')).length, 2, 'the branch head is still resolved for every job');
    // A new commit adding the workflow is read immediately.
    branches.main = { sha: 'sha-2', workflow: 'validation: [npm test]' };
    assert.deepEqual((await prepare())?.config, { validation: ['npm test'] });
    assert.equal(requests.filter(route => route.includes('/contents/')).length, 2);
    // A present workflow is never cached.
    await prepare();
    assert.equal(requests.filter(route => route.includes('/contents/')).length, 3);
});

test('a deferral resolved from the default branch is reused for the requested base it was resolved for', async () => {
    const fallback = { revision: 'main-sha', baseBranch: 'main' } as never;
    const data = { ...repositoryWorkflowDeferralData({}, fallback, 'propr/epic-7'), repositoryWorkflow: fallback };
    assert.equal(data.repositoryWorkflowBaseBranch, 'propr/epic-7');
    let loads = 0;
    assert.equal(await resolveRepositoryWorkflow(data, 'propr/epic-7', async () => { loads++; return undefined; }), fallback);
    await resolveRepositoryWorkflow(data, 'release', async () => { loads++; return undefined; });
    assert.equal(loads, 1);
});

test('a lost capacity lease is never classified as a user cancellation', () => {
    assert.equal(isUserCancellationError(new RepositoryWorkflowLeaseLostError()), false);
    // Even if a transport relabels it, the lease-loss type wins.
    assert.equal(isUserCancellationError(Object.assign(new RepositoryWorkflowLeaseLostError(), { name: 'ExecutionAbortedError' })), false);
    assert.equal(isUserCancellationError(new ExecutionAbortedError()), true);
    assert.equal(isUserCancellationError(new Error('Execution aborted by user request')), true);
    assert.equal(isUserCancellationError(new Error('Agent failed')), false);
});

test('a capacity wait is recorded on the timeline with its count and the same retry time as the delayed job', async () => {
    const updates: unknown[][] = [];
    const current = { state: 'pending', createdAt: 'c', updatedAt: 'u', correlationId: 'id', version: 4 };
    const stateManager = { getTaskState: async () => current, updateTaskStateIfCurrent: async (...args: unknown[]) => { updates.push(args); return current; } };
    const deferral = repositoryWorkflowDeferralData({ repositoryWorkflowDeferrals: 1 }, undefined, 'main', { now: 1_000_000, random: () => 1 });
    assert.deepEqual([deferral.repositoryWorkflowDeferrals, deferral.repositoryWorkflowRetryAt], [2, 1_020_000]);
    await recordRepositoryWorkflowDeferral({ stateManager: stateManager as never, taskId: 'task', correlatedLogger: log as never, deferral,
        workflow: { maxParallelTasks: 2 } as never });
    assert.deepEqual(updates, [['task', { state: 'pending', createdAt: 'c', updatedAt: 'u', correlationId: 'id', version: 4 }, 'pending', {
        reason: 'Waiting for repository workflow capacity (limit 2)',
        historyMetadata: { repositoryWorkflowDeferrals: 2, repositoryWorkflowRetryAt: new Date(1_020_000).toISOString() },
    }]]);
    // Terminal tasks are left alone and timeline failures never block the delay.
    for (const state of ['cancelled', 'failed', 'completed']) {
        await recordRepositoryWorkflowDeferral({ stateManager: { ...stateManager, getTaskState: async () => ({ ...current, state }) } as never,
            taskId: 'task', correlatedLogger: log as never, deferral });
    }
    assert.equal(updates.length, 1);
    await recordRepositoryWorkflowDeferral({ stateManager: { getTaskState: async () => { throw new Error('Redis down'); } } as never,
        taskId: 'task', correlatedLogger: log as never, deferral });
    // The delayed job uses the persisted retry time shown on the timeline.
    const retryAt = Date.now() + 60_000;
    let deadline = 0;
    await assert.rejects(deferRepositoryWorkflowJob({ token: 't', data: { repositoryWorkflowDeferrals: 1, repositoryWorkflowRetryAt: retryAt },
        moveToDelayed: async (value: number) => { deadline = value; } } as never, async () => { throw new RepositoryWorkflowCapacityError(); }), DelayedError);
    assert.equal(deadline, retryAt);
});

test('later refusals update the waiting row instead of appending one per backoff cycle', async () => {
    const appended: unknown[][] = [];
    const updated: unknown[][] = [];
    let current = { state: 'pending', createdAt: 'c', updatedAt: 'u', correlationId: 'id', version: 4, history: [{ state: 'pending', metadata: {} }] as Array<{ state: string; metadata?: Record<string, unknown> }> };
    const stateManager = {
        getTaskState: async () => current,
        updateTaskStateIfCurrent: async (...args: unknown[]) => {
            appended.push(args);
            current = { ...current, history: [...current.history, { state: 'pending', metadata: (args[3] as { historyMetadata: Record<string, unknown> }).historyMetadata }] };
            return current;
        },
        updateHistoryMetadata: async (...args: unknown[]) => { updated.push(args); return current; },
    };
    let data = {};
    for (let refusal = 0; refusal < 4; refusal++) {
        const deferral = repositoryWorkflowDeferralData(data, undefined, 'main', { now: 1_000_000, random: () => 1 });
        data = deferral;
        await recordRepositoryWorkflowDeferral({ stateManager: stateManager as never, taskId: 'task', correlatedLogger: log as never, deferral });
    }
    assert.equal(appended.length, 1, 'the first refusal starts the waiting row');
    assert.equal(current.history.length, 2);
    assert.deepEqual(updated.map(([taskId, state, metadata]) => [taskId, state, (metadata as { repositoryWorkflowDeferrals: number }).repositoryWorkflowDeferrals]),
        [['task', 'pending', 2], ['task', 'pending', 3], ['task', 'pending', 4]]);
    // A different latest entry (for example after a retry) starts a new waiting row.
    current = { ...current, history: [...current.history, { state: 'pending', metadata: { isRetry: true } }] };
    await recordRepositoryWorkflowDeferral({ stateManager: stateManager as never, taskId: 'task', correlatedLogger: log as never,
        deferral: repositoryWorkflowDeferralData({}, undefined, 'main') });
    assert.equal(appended.length, 2);
});

test('capacity deferral waits for cleanup and passes the current BullMQ lock token', async () => {
    const events: string[] = [];
    const job = { token: 'token', moveToDelayed: async (deadline: number, token?: string) => {
        assert.ok(deadline > Date.now());
        assert.equal(token, 'token');
        events.push('delayed');
    } };
    await assert.rejects(deferRepositoryWorkflowJob(job as never, async () => {
        try { throw new RepositoryWorkflowCapacityError(); }
        finally { await Promise.resolve(); events.push('cleanup'); }
    }), DelayedError);
    assert.deepEqual(events, ['cleanup', 'delayed']);
    await assert.rejects(deferRepositoryWorkflowJob(job as never, async () => { throw new Error('unrelated'); }), /unrelated/);
    assert.equal(events.length, 2);
    await assert.rejects(deferRepositoryWorkflowJob({ ...job, moveToDelayed: async () => { throw new Error('lock lost'); } } as never,
        async () => { throw new RepositoryWorkflowCapacityError(); }), /lock lost/);
});

test('capacity deferrals back off exponentially with jitter up to a ceiling', async () => {
    assert.deepEqual([1, 2, 3, 4].map(n => repositoryWorkflowDeferralDelayMs(n, () => 1)), [10_000, 20_000, 40_000, 80_000]);
    assert.deepEqual([1, 2].map(n => repositoryWorkflowDeferralDelayMs(n, () => 0)), [5_000, 10_000]);
    assert.equal(repositoryWorkflowDeferralDelayMs(50, () => 1), 300_000);
    const deadlines: number[] = [];
    for (const deferrals of [1, 6]) {
        await assert.rejects(deferRepositoryWorkflowJob({ token: 't', data: { repositoryWorkflowDeferrals: deferrals },
            moveToDelayed: async (deadline: number) => { deadlines.push(deadline - Date.now()); } } as never,
        async () => { throw new RepositoryWorkflowCapacityError(); }), DelayedError);
    }
    assert.ok(deadlines[0] <= 10_000 && deadlines[1] >= 150_000 - 50);
});

test('deferred re-entry reuses the resolved policy, including no policy, unless the base branch changed', async () => {
    const cached = { revision: 'sha', baseBranch: 'main' } as never;
    let loads = 0;
    const prepare = async () => { loads++; return undefined; };
    assert.equal(await resolveRepositoryWorkflow({ repositoryWorkflow: cached, repositoryWorkflowDeferrals: 2 }, 'main', prepare), cached);
    assert.equal(await resolveRepositoryWorkflow({ repositoryWorkflow: cached, repositoryWorkflowDeferrals: 2 }, undefined, prepare), cached);
    assert.equal(await resolveRepositoryWorkflow({ repositoryWorkflow: null, repositoryWorkflowBaseBranch: 'main', repositoryWorkflowDeferrals: 1 }, 'main', prepare), undefined);
    assert.equal(await resolveRepositoryWorkflow({ repositoryWorkflow: null, repositoryWorkflowBaseBranch: null, repositoryWorkflowDeferrals: 1 }, undefined, prepare), undefined);
    assert.equal(loads, 0);
    await resolveRepositoryWorkflow({ repositoryWorkflow: cached, repositoryWorkflowDeferrals: 2 }, 'release', prepare);
    await resolveRepositoryWorkflow({ repositoryWorkflow: cached }, 'main', prepare);
    await resolveRepositoryWorkflow({}, 'main', prepare);
    assert.equal(loads, 3);
});

test('an absent policy is reloaded when the task was retargeted or the snapshot has no branch identity', async () => {
    const release = { revision: 'release-sha', baseBranch: 'release' } as never;
    let loads = 0;
    const prepare = async () => { loads++; return release; };
    assert.equal(await resolveRepositoryWorkflow({ repositoryWorkflow: null, repositoryWorkflowBaseBranch: 'main', repositoryWorkflowDeferrals: 1 }, 'release', prepare), release);
    assert.equal(await resolveRepositoryWorkflow({ repositoryWorkflow: null, repositoryWorkflowBaseBranch: null, repositoryWorkflowDeferrals: 1 }, 'release', prepare), release);
    assert.equal(await resolveRepositoryWorkflow({ repositoryWorkflow: null, repositoryWorkflowDeferrals: 1 }, 'main', prepare), release);
    assert.equal(loads, 3);
});

test('deferral data records the base branch with the snapshot, including when no workflow exists', () => {
    const workflow = { revision: 'sha', baseBranch: 'develop' } as never;
    assert.deepEqual(repositoryWorkflowDeferralData({}, undefined, 'main', { now: 0, random: () => 1 }), { repositoryWorkflow: null, repositoryWorkflowBaseBranch: 'main', repositoryWorkflowDeferrals: 1, repositoryWorkflowRetryAt: 10_000 });
    assert.deepEqual(repositoryWorkflowDeferralData({ repositoryWorkflowDeferrals: 1 }, undefined, undefined, { now: 0, random: () => 1 }), { repositoryWorkflow: null, repositoryWorkflowBaseBranch: null, repositoryWorkflowDeferrals: 2, repositoryWorkflowRetryAt: 20_000 });
    assert.equal(repositoryWorkflowDeferralData({}, workflow, undefined).repositoryWorkflowBaseBranch, 'develop');
});

test('cancelled re-entry and cancellation during admission never delay or execute', async () => {
    for (const cancelDuringAcquire of [false, true]) {
        let state = cancelDuringAcquire ? 'pending' : 'cancelled';
        let acquisitions = 0;
        await assert.rejects(deferRepositoryWorkflowJob({ moveToDelayed: () => assert.fail('must not delay') } as never,
            () => withRepositoryWorkflowAdmission({
                repoOwner: 'owner', repoName: 'repo', taskId: 'same-task', correlatedLogger: log as never,
                stateManager: { getTaskState: async () => ({ state }) } as never,
                redisClient: { eval: async () => { acquisitions++; state = 'cancelled'; return 0; } } as never,
            }, async () => assert.fail('must not execute'))), /Task ended/);
        assert.equal(acquisitions, cancelDuringAcquire ? 1 : 0);
    }
});

test('a shared processor advances from refused repository A to repository B without waiting for A to finish', async () => {
    const slots = new Map<string, string>();
    const started: string[] = [];
    const delayed: string[] = [];
    let finishA!: () => void;
    const activeA = new Promise<void>(resolve => { finishA = resolve; });
    const redisClient = { eval: async (script: string, _count: number, key: string, _limits: string, token: string) => {
        if (script === ACQUIRE_WORKFLOW_SLOT) {
            if (slots.has(key)) return 0;
            slots.set(key, token);
        } else if (slots.get(key) === token) slots.delete(key);
        return 1;
    } };
    const process = (repoName: string, id: string) => deferRepositoryWorkflowJob({
        token: id, moveToDelayed: async () => { delayed.push(id); },
    } as never, () => withRepositoryWorkflowAdmission({
        redisClient: redisClient as never, repoOwner: 'owner', repoName, taskId: id,
        stateManager: { getTaskState: async () => ({ state: 'pending' }) } as never,
        correlatedLogger: log as never,
    }, async () => { started.push(id); if (id === 'A1') await activeA; }));
    const firstProcessor = process('A', 'A1');
    await setImmediate();
    const secondProcessor = (async () => {
        await assert.rejects(process('A', 'A2'), DelayedError);
        await assert.rejects(process('A', 'A3'), DelayedError);
        await process('B', 'B1');
    })();
    try {
        await setImmediate();
        assert.deepEqual(started, ['A1', 'B1']);
        assert.deepEqual(delayed, ['A2', 'A3']);
        assert.equal(slots.size, 1, 'A remains running while B has already finished');
    } finally {
        finishA();
        await Promise.all([firstProcessor, secondProcessor]);
    }
});

test('agent execution rechecks cancellation and lease ownership after preparation awaits', async () => {
    const controller = new AbortController();
    const options = { repoOwner: 'owner', repoName: 'repo', taskId: 'task',
        correlatedLogger: log as never, redisClient: {} as never,
        stateManager: { getTaskState: async () => ({ state: 'cancelled' }) } as never,
    };
    await assert.rejects(runRepositoryWorkflow(options, async () => assert.fail('cancelled during preparation')), /Task ended/);
    await assert.rejects(runWithExecutionAbortSignal(controller.signal, () => runRepositoryWorkflow({
        ...options, stateManager: { getTaskState: async () => {
            controller.abort(new Error('lease lost during task-state read'));
            return { state: 'pending' };
        } } as never,
    }, async () => assert.fail('lease lost during cancellation check'))), /lease lost during task-state read/);
});

test('the capacity slot ends when the agent container exits, not when publication finishes', async () => {
    const calls: string[] = [];
    const redisClient = { eval: async (script: string) => { calls.push(script === ACQUIRE_WORKFLOW_SLOT ? 'acquire' : 'release'); return 1; } };
    const options = { repoOwner: 'owner', repoName: 'repo', taskId: 'task', correlatedLogger: log as never, redisClient: redisClient as never,
        stateManager: { getTaskState: async () => ({ state: 'processing' }) } as never };
    for (const agentFails of [false, true]) {
        calls.length = 0;
        const outcome = await withRepositoryWorkflowAdmission(options, async () => {
            const agent = runRepositoryWorkflow(options, async () => {
                calls.push('agent');
                if (agentFails) throw new Error('agent failed');
                return { success: true, logs: '', modifiedFiles: [], modelUsed: 'test', executionTimeMs: 1 };
            });
            const result = await agent.then(() => 'published', () => 'failure reported');
            calls.push(result);
            return result;
        });
        assert.equal(outcome, agentFails ? 'failure reported' : 'published');
        assert.deepEqual(calls, ['acquire', 'agent', 'release', outcome], 'released once, before post-processing');
    }
});

const binary = process.env.PROPR_TEST_REDIS_SERVER || 'redis-server';
const available = spawnSync(binary, ['--version']).status === 0;
test('saturated repository jobs release shared BullMQ processors so another repository runs', {
    skip: !available && 'redis-server is needed for the queue integration test', timeout: 15_000,
}, async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'workflow-queue-'));
    const socket = path.join(directory, 'redis.sock');
    const server = spawn(binary, ['--port', '0', '--unixsocket', socket, '--save', '', '--appendonly', 'no'], { stdio: 'ignore' });
    const redis = new Redis({ path: socket, lazyConnect: true, retryStrategy: () => 25, maxRetriesPerRequest: null });
    redis.on('error', () => {});
    let queue: Queue | undefined;
    let worker: Worker | undefined;
    let finishA!: () => void;
    const runningA = new Promise<void>(resolve => { finishA = resolve; });
    let bStarted!: () => void;
    const ranB = new Promise<void>(resolve => { bStarted = resolve; });
    let timeout: ReturnType<typeof setTimeout> | undefined;
    const started: string[] = [];
    try {
        for (let attempt = 0; ; attempt++) {
            try { await access(socket); break; }
            catch { if (attempt > 100) throw new Error('Redis socket unavailable'); await new Promise(resolve => setTimeout(resolve, 25)); }
        }
        await redis.connect();
        queue = new Queue('workflow-capacity', { connection: redis });
        await queue.addBulk([
            { name: 'issue', data: { repo: 'A', id: 'A1' } },
            { name: 'followup', data: { repo: 'A', id: 'A2' } },
            { name: 'issue', data: { repo: 'A', id: 'A3' } },
            { name: 'followup', data: { repo: 'B', id: 'B1' } },
        ]);
        worker = new Worker('workflow-capacity', job => deferRepositoryWorkflowJob(job, () => withRepositoryWorkflowAdmission({
            repoOwner: 'owner', repoName: job.data.repo, taskId: job.id!, redisClient: redis, job,
            workflow: { maxParallelTasks: 1 } as never,
            stateManager: { getTaskState: async () => ({ state: 'pending' }) } as never,
            correlatedLogger: log as never,
        }, async () => {
            started.push(job.data.id);
            if (job.data.repo === 'A') await runningA;
            else bStarted();
        })), { connection: redis, concurrency: 2 });
        await Promise.race([ranB, new Promise((_, reject) => {
            timeout = setTimeout(() => reject(new Error('Repository B was blocked by A waiters')), 5000);
        })]);
        assert.deepEqual(started, ['A1', 'B1']);
        assert.equal(await queue.getDelayedCount(), 2);
        for (const job of await queue.getDelayed()) assert.equal(job.attemptsMade, 0, 'capacity does not consume failure retries');
        // Releasing A's slot wakes the longest-waiting job well before its 5-10 s backoff,
        // even when an older waiter's job has since been removed from the queue.
        const [, , waitersKey, waitingKey] = repositoryWorkflowSlotKeys('owner/A');
        const removed = JSON.stringify(['workflow-capacity', 'removed-job']);
        await redis.zadd(waitersKey, 0, removed);
        await redis.zadd(waitingKey, Math.floor(Date.now() / 1000) + 300, removed);
        const released = Date.now();
        finishA();
        while (started.length < 4 && Date.now() - released < 4000) await new Promise(resolve => setTimeout(resolve, 25));
        assert.deepEqual(started, ['A1', 'B1', 'A2', 'A3'], 'waiters are admitted oldest first');
        assert.ok(Date.now() - released < 4000);
        assert.equal(await redis.zscore(waitersKey, removed), null, 'a removed job leaves the waiting list');
    } finally {
        clearTimeout(timeout);
        finishA();
        await worker?.close();
        await queue?.close();
        redis.disconnect();
        server.kill('SIGTERM');
        await new Promise<void>(resolve => server.once('exit', () => resolve()));
        await rm(directory, { recursive: true, force: true });
    }
});
