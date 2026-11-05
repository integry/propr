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
let importOutcome: 'throw' | 'false' | 'true' = 'throw';
let completionFails = false;
const executeTask = async () => {
    if (importOutcome === 'throw') throw new Error('import execution failed');
    return { success: importOutcome === 'true', summary: 'import result' };
};
const cleanup = mock.fn(async (...args: Parameters<typeof realCleanup>) => realCleanup(...args));
const createTaskState = mock.fn(async () => ({}));
const markTaskFailed = mock.fn(async () => ({}));
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
        getStateManager: () => ({ createTaskState, markTaskFailed,
            updateTaskState: async () => {}, markTaskCompleted: async () => { if (completionFails) throw new Error('completion persistence failed'); },
        }),
        TaskStates: {},
        createWorktreeForIssue: async () => ({ worktreePath: checkoutPath, branchName: 'task' }),
        cleanupWorktree: cleanup,
        getRepoUrl: mock.fn(),
        ensureRepoCloned: async () => repositoryPath,
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
