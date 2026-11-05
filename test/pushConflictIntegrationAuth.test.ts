import { test, after, mock } from 'node:test';
import assert from 'node:assert/strict';
import knex from 'knex';

// Importing @propr/core opens its database connection; an in-memory one keeps the process from hanging.
const db = knex({ client: 'better-sqlite3', connection: { filename: ':memory:' }, useNullAsDefault: true });
await mock.module('../packages/core/src/db/connection.js', {
    namedExports: {
        db, closeConnection: async () => undefined, runMigrations: async () => undefined,
        configureSqliteConnection: () => undefined, configurePooledSqliteConnection: () => undefined, createKnexConfigForMigrations: () => ({}),
    },
});
after(async () => { await db.destroy(); });

// S16: the integration merge fetches the moved branch with the installation
// token, like the merge-conflict job, instead of relying on the worktree's
// remote URL. Only the merge driver and the agent resolver are stubbed.
const resolutions: Array<Record<string, unknown>> = [];
await mock.module('../packages/core/src/git/conflictResolution.js', {
    namedExports: {
        findConflictMarkers: async () => [],
        performConflictResolution: async (options: Record<string, unknown>) => {
            resolutions.push(options);
            return { status: 'clean', headSha: 'merged', previousHeadSha: 'before', baseCommit: 'base', conflictedFiles: [] };
        },
    },
});
await mock.module('../src/jobs/mergeConflictAgentRunner.js', {
    namedExports: { createAgentConflictResolver: async () => ({ resolvedModel: 'm', resolveConflicts: async () => ({ success: true }) }) },
});
const { integrateRemoteAndPush } = await import('../src/jobs/pushConflictIntegration.js');

test('the integration merge fetches the moved PR branch with the installation token', async () => {
    let tokens = 0;
    const result = await integrateRemoteAndPush({
        publication: { target: { branchName: 'feature', isFork: false }, push: async () => ({ commitHash: 'merged' }) } as never,
        worktreeInfo: { worktreePath: '/wt' } as never, pullRequestNumber: 7, repoOwner: 'acme', repoName: 'widgets',
        getGithubToken: async () => { tokens += 1; return 'installation-token'; },
        stateManager: {} as never, taskId: 'task-1', correlationId: 'corr', redisClient: {} as never,
        correlatedLogger: { info() {}, warn() {}, error() {}, debug() {} } as never,
    }, '/wt');
    assert.deepEqual(result, { commitHash: 'merged' });
    assert.equal(resolutions.length, 1);
    assert.deepEqual(resolutions[0].merge, { authToken: 'installation-token' });
    assert.equal(resolutions[0].baseBranch, 'feature');
    assert.equal(tokens, 1, 'one token serves both the resolver and the fetch');
});
