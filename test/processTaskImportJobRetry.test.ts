import assert from 'node:assert/strict';
import { after, mock, test } from 'node:test';

import fs from 'fs-extra';
import os from 'node:os';
import path from 'node:path';
import { simpleGit } from 'simple-git';

const root = await fs.mkdtemp(path.join(os.tmpdir(), 'task-import-retention-'));
process.env.GIT_WORKTREES_BASE_PATH = path.join(root, 'worktrees');
process.env.GIT_CLONES_BASE_PATH = path.join(root, 'clones');
const { cleanupWorktree: realCleanup } = await import('../packages/core/src/git/worktreeOperations.js');
after(async () => { await fs.remove(root); });
let repositoryPath = '';
let checkoutPath = '';
let authenticationFails = true;
let importOutcome: 'throw' | 'false' | 'true' | 'capacity' = 'throw';
let completionFails = false;
const executeTask = async () => {
    if (importOutcome === 'throw') throw new Error('import execution failed');
    // Lost the race at the authoritative acquire past the job's race bound.
    if (importOutcome === 'capacity') throw Object.assign(new Error("Waiting for agent capacity: 'test' at its ceiling"), { name: 'AgentCapacityError', aliases: ['test'] });
    return { success: importOutcome === 'true', summary: 'import result' };
};
const cleanup = mock.fn(async (...args: Parameters<typeof realCleanup>) => realCleanup(...args));
const createTaskState = mock.fn(async () => ({}));
const createTaskStateIfAbsent = mock.fn(async () => ({}));
const markTaskFailed = mock.fn(async () => ({}));
let storedTaskState: string | null = null;
const ensureRepoCloned = mock.fn(async () => repositoryPath);
let capacityRefusal: Error | null = null;
const persistedDeferrals = mock.fn(async () => {});
const correlatedLogger = { info: mock.fn(), debug: mock.fn(), warn: mock.fn(), error: mock.fn() };

class UsageLimitError extends Error {}

await mock.module('@propr/core', {
    namedExports: {
        logger: { withCorrelation: () => correlatedLogger },
        getAuthenticatedOctokit: mock.fn(async () => {
            if (authenticationFails) throw new Error('GitHub authentication unavailable');
            return { auth: async () => ({ token: 'test-token' }) };
        }),
        withRetry: async (operation: () => Promise<unknown>) => operation(),
        retryConfigs: { githubApi: {} },
        getStateManager: () => ({ createTaskState, createTaskStateIfAbsent, markTaskFailed,
            getTaskState: async () => (storedTaskState ? { state: storedTaskState } : null),
            updateTaskState: async () => {}, markTaskCompleted: async () => { if (completionFails) throw new Error('completion persistence failed'); },
        }),
        TaskStates: { CANCELLED: 'cancelled' },
        createWorktreeForIssue: async () => ({ worktreePath: checkoutPath, branchName: 'task' }),
        cleanupWorktree: cleanup,
        getRepoUrl: mock.fn(),
        ensureRepoCloned,
        ensureGitRepository: mock.fn(),
        AgentRegistry: { getInstance: () => ({ ensureInitialized: async () => {}, getAgentByAlias: () => ({ executeTask }) }) },
        UsageLimitError,
        generateTaskImportPrompt: mock.fn(),
        handleError: mock.fn(),
    },
});
await mock.module('../src/jobs/issueJobHelpers.js', {
    namedExports: { handleSimpleUsageLimitError: mock.fn() },
});
await mock.module('../src/jobs/prCommentAgentUtils.js', {
    namedExports: { resolveDefaultAgentAndModel: async () => ({ resolvedAlias: 'test', resolvedModel: 'test' }) },
});
// The real capacity helpers are covered by agentCapacityDeferral.test.ts; here only the job's path.
await mock.module('../src/jobs/agentCapacityDeferral.js', {
    namedExports: {
        checkJobAgentCapacity: async () => { if (capacityRefusal) throw capacityRefusal; return { pins: new Map(), raceWaitMs: 30_000 }; },
        admitAgentCapacity: async () => {},
        isAgentCapacityRefusal: (error: unknown) => (error as Error | null)?.name === 'AgentCapacityError',
        persistAgentCapacityDeferral: persistedDeferrals,
        runWithJobAgentCapacity: (_context: unknown, operation: () => Promise<unknown>) => operation(),
        JOB_AGENT_CAPACITY_RACE_WAIT_MS: 30_000,
    },
});
await mock.module('../src/jobs/notificationRecap.js', {
    namedExports: { compactNotificationRecap: mock.fn() },
});

const { processTaskImportJob } = await import('../src/jobs/processTaskImportJob.js');

test('task import retries reuse the durable task identity of their BullMQ job', async () => {
    const job = {
        id: 'import-tasks-integry-propr-1758800000000',
        name: 'processTaskImport',
        data: {
            taskDescription: 'Import the roadmap',
            repository: 'integry/propr',
            correlationId: 'import-correlation',
            user: 'integry',
        },
    };

    await assert.rejects(processTaskImportJob(job as never), /GitHub authentication unavailable/);
    await assert.rejects(processTaskImportJob(job as never), /GitHub authentication unavailable/);

    const attempts = createTaskState.mock.calls.map(call => ({
        taskId: call.arguments[0],
        jobId: call.arguments[3],
    }));
    assert.deepEqual(attempts, [
        { taskId: `task-import-${job.id}`, jobId: job.id },
        { taskId: `task-import-${job.id}`, jobId: job.id },
    ]);
    assert.deepEqual(
        markTaskFailed.mock.calls.map(call => call.arguments[0]),
        [`task-import-${job.id}`, `task-import-${job.id}`],
    );
});

for (const strategy of ['keep_on_failure', 'keep_for_hours']) {
    for (const outcome of ['throw', 'false', 'completion-failure'] as const) {
        test(`failed import retains its clean branch-backed checkout: ${strategy}, ${outcome}`, async () => {
            const previous = process.env.WORKTREE_RETENTION_STRATEGY;
            process.env.WORKTREE_RETENTION_STRATEGY = strategy;
            authenticationFails = false;
            importOutcome = outcome === 'completion-failure' ? 'true' : outcome;
            completionFails = outcome === 'completion-failure';
            const name = `${strategy}-${outcome}`;
            repositoryPath = path.join(root, name);
            checkoutPath = path.join(root, 'worktrees', 'owner', name, 'checkout');
            await fs.ensureDir(repositoryPath);
            const git = simpleGit(repositoryPath);
            await git.init(['--initial-branch=main']);
            await git.addConfig('user.name', 'Test');
            await git.addConfig('user.email', 'test@example.test');
            await fs.writeFile(path.join(repositoryPath, 'tracked'), 'base');
            await git.add('.').commit('initial');
            await fs.ensureDir(path.dirname(checkoutPath));
            await git.raw(['worktree', 'add', '-b', 'task', checkoutPath]);
            try {
                const attempt = processTaskImportJob({ id: name, data: { repository: 'owner/repo' } } as never);
                if (outcome === 'false') assert.equal((await attempt).success, false);
                else await assert.rejects(attempt, /import execution failed|completion persistence failed/);
                assert.equal(cleanup.mock.calls.at(-1)!.arguments[3]!.success, false);
                assert.equal(await fs.pathExists(checkoutPath), true);
                assert.equal((await simpleGit(checkoutPath).status()).isClean(), true);
                assert.match(await git.raw(['worktree', 'list', '--porcelain']), new RegExp(checkoutPath));
            } finally {
                if (previous === undefined) delete process.env.WORKTREE_RETENTION_STRATEGY;
                else process.env.WORKTREE_RETENTION_STRATEGY = previous;
            }
        });
    }
}

/** A BullMQ job that records being moved to delayed. */
function deferrable(id: string, data: Record<string, unknown> = {}) {
    const job = { id, token: 'lock', data: { repository: 'owner/repo', correlationId: 'c', ...data }, delayed: 0,
        moveToDelayed: async () => { job.delayed++; }, updateData: async (next: Record<string, unknown>) => { job.data = next as never; } };
    return job;
}

test('a saturated default agent defers the import before cloning, without failing its task', async () => {
    const { DelayedError } = await import('bullmq');
    authenticationFails = false;
    capacityRefusal = Object.assign(new Error('Waiting for agent capacity'), { name: 'AgentCapacityError', aliases: ['test'] });
    const [failed, cloned, persisted] = [markTaskFailed.mock.callCount(), ensureRepoCloned.mock.callCount(), persistedDeferrals.mock.callCount()];
    const job = deferrable('capacity-precheck');
    try {
        await assert.rejects(processTaskImportJob(job as never), DelayedError);
    } finally { capacityRefusal = null; }
    assert.equal(job.delayed, 1);
    assert.equal(persistedDeferrals.mock.callCount(), persisted + 1);
    assert.equal(ensureRepoCloned.mock.callCount(), cloned, 'nothing is cloned for a deferred import');
    assert.equal(markTaskFailed.mock.callCount(), failed, 'a capacity wait is not a failure');
});

test('a lost race at admission defers the import and removes its throwaway worktree', async () => {
    const { DelayedError } = await import('bullmq');
    authenticationFails = false;
    importOutcome = 'capacity';
    completionFails = false;
    repositoryPath = path.join(root, 'race');
    checkoutPath = path.join(root, 'worktrees', 'owner', 'race', 'checkout');
    await fs.ensureDir(repositoryPath);
    const git = simpleGit(repositoryPath);
    await git.init(['--initial-branch=main']);
    await git.addConfig('user.name', 'Test');
    await git.addConfig('user.email', 'test@example.test');
    await fs.writeFile(path.join(repositoryPath, 'tracked'), 'base');
    await git.add('.').commit('initial');
    await fs.ensureDir(path.dirname(checkoutPath));
    await git.raw(['worktree', 'add', '-b', 'task', checkoutPath]);
    const [failed, persisted] = [markTaskFailed.mock.callCount(), persistedDeferrals.mock.callCount()];
    const job = deferrable('capacity-race');
    await assert.rejects(processTaskImportJob(job as never), DelayedError);
    assert.equal(job.delayed, 1);
    assert.equal(persistedDeferrals.mock.callCount(), persisted + 1);
    assert.equal(markTaskFailed.mock.callCount(), failed);
    // Asked to delete, not retain for diagnosis (the deletion itself is worktree cleanup's job).
    assert.equal(cleanup.mock.calls.at(-1)!.arguments[3]!.success, true, 'a deferred import keeps no checkout');
});

test('an import stopped while it waited for capacity is not re-entered', async () => {
    authenticationFails = false;
    storedTaskState = 'cancelled';
    const [created, ensured, cloned] = [createTaskState.mock.callCount(), createTaskStateIfAbsent.mock.callCount(), ensureRepoCloned.mock.callCount()];
    try {
        const result = await processTaskImportJob(deferrable('capacity-cancelled', { agentCapacityDeferrals: 2 }) as never);
        assert.equal(result.status, 'cancelled');
    } finally { storedTaskState = null; }
    assert.equal(createTaskState.mock.callCount(), created, 'the stopped task is not recreated');
    assert.equal(createTaskStateIfAbsent.mock.callCount(), ensured);
    assert.equal(ensureRepoCloned.mock.callCount(), cloned);
    // A re-entry of a still-waiting task keeps its task (and waiting row) instead of resetting it.
    importOutcome = 'true';
    repositoryPath = path.join(root, 'race');
    await processTaskImportJob(deferrable('capacity-resumed', { agentCapacityDeferrals: 1 }) as never).catch(() => undefined);
    assert.equal(createTaskState.mock.callCount(), created);
    assert.equal(createTaskStateIfAbsent.mock.callCount(), ensured + 1);
});
