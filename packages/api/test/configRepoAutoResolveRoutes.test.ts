import { resolveGitHubAttachmentCapacity } from '@propr/shared';
import type { RepoToMonitor } from '@propr/core';
import assert from 'node:assert/strict';
import { after, mock, test } from 'node:test';

process.env.PROPR_DEMO_MODE = 'true';
const [{ createConfigRoutes }, { db }] = await Promise.all([
  import('../routes/configRoutes.js'),
  import('@propr/core')
]);

after(async () => {
  await db.destroy();
});

function createResponse() {
  return {
    statusCode: 200,
    body: undefined as Record<string, unknown> | undefined,
    status(code: number) {
      this.statusCode = code;
      return this;
    },
    json(payload: Record<string, unknown>) {
      this.body = payload;
      return this;
    }
  };
}

function createRepoPostRoutes(previousRepos: RepoToMonitor[], saveMonitoredRepos: ReturnType<typeof mock.fn>) {
  return createConfigRoutes({
    redisClient: {
      set: mock.fn(async () => 'OK'),
      eval: mock.fn(async () => 1),
      publish: mock.fn(async () => 1),
      lPush: mock.fn(async () => 1),
      lTrim: mock.fn(async () => 'OK')
    } as never,
    configStore: {
      loadMonitoredReposRaw: async () => previousRepos,
      loadGitHubAttachmentCapacity: async () => resolveGitHubAttachmentCapacity(),
      saveMonitoredRepos,
      clearRemovedRepositoryIndexData: async () => {}
    } as never,
    database: {
      transaction: async (callback: (transaction: never) => Promise<unknown>) => callback({} as never)
    } as never
  });
}

for (const { name, previousRepos, repos, expected } of [
  {
    name: 'keeps the stored merge-conflict override when a partial or legacy update omits it',
    previousRepos: [
      { id: 'repo-main', name: 'integry/propr', enabled: true, autoResolveMergeConflicts: true },
      { id: 'repo-other', name: 'integry/other', enabled: true, autoResolveMergeConflicts: false }
    ],
    repos: [
      { id: 'repo-main', name: 'integry/propr', enabled: false },
      { id: 'repo-branch', name: 'integry/propr', enabled: true, baseBranch: 'next' },
      { id: 'repo-other', name: 'integry/other', enabled: true },
      { id: 'repo-new', name: 'integry/new', enabled: true }
    ],
    expected: [['repo-main', true], ['repo-branch', true], ['repo-other', false], ['repo-new', undefined]]
  },
  {
    name: 'clears the merge-conflict override on every branch entry when one entry sends null',
    previousRepos: [
      { id: 'repo-main', name: 'integry/propr', enabled: true, baseBranch: 'main', autoResolveMergeConflicts: true },
      { id: 'repo-release', name: 'integry/propr', enabled: true, baseBranch: 'release', autoResolveMergeConflicts: true }
    ],
    repos: [
      { id: 'repo-main', name: 'integry/propr', enabled: true, baseBranch: 'main', autoResolveMergeConflicts: null },
      { id: 'repo-release', name: 'integry/propr', enabled: true, baseBranch: 'release', autoResolveMergeConflicts: true }
    ],
    expected: [['repo-main', undefined], ['repo-release', undefined]]
  },
  {
    name: 'propagates a merge-conflict override change on one branch entry to the whole repository',
    previousRepos: [
      { id: 'repo-main', name: 'integry/propr', enabled: true, baseBranch: 'main' },
      { id: 'repo-release', name: 'INTEGRY/PROPR', enabled: true, baseBranch: 'release' },
      { id: 'repo-other', name: 'integry/other', enabled: true }
    ],
    repos: [
      { id: 'repo-main', name: 'integry/propr', enabled: true, baseBranch: 'main' },
      { id: 'repo-release', name: 'INTEGRY/PROPR', enabled: true, baseBranch: 'release', autoResolveMergeConflicts: false },
      { id: 'repo-other', name: 'integry/other', enabled: true }
    ],
    expected: [['repo-main', false], ['repo-release', false], ['repo-other', undefined]]
  }
] as Array<{ name: string; previousRepos: RepoToMonitor[]; repos: unknown[]; expected: Array<[string, boolean | undefined]> }>) {
  test(`POST repository config ${name}`, async () => {
    const saveMonitoredRepos = mock.fn<(repos: RepoToMonitor[]) => Promise<boolean>>(async () => true);
    const response = createResponse();

    await createRepoPostRoutes(previousRepos, saveMonitoredRepos).postRepos({ body: { repos_to_monitor: repos } } as never, response as never);

    assert.equal(response.statusCode, 200);
    const saved = saveMonitoredRepos.mock.calls[0]?.arguments[0] ?? [];
    assert.deepEqual(saved.map(repo => [repo.id, repo.autoResolveMergeConflicts]), expected);
    // "Inherit" is stored as an absent field, never as false or null.
    for (const repo of saved) assert.ok(repo.autoResolveMergeConflicts !== null);
  });
}

test('POST repository config rejects a non-boolean, non-null merge-conflict override', async () => {
  for (const autoResolveMergeConflicts of ['true', 1, {}]) {
    const saveMonitoredRepos = mock.fn(async () => true);
    const response = createResponse();

    await createRepoPostRoutes([], saveMonitoredRepos).postRepos({ body: { repos_to_monitor: [{ id: 'repo-1', name: 'integry/propr', enabled: true, autoResolveMergeConflicts }] } } as never, response as never);

    assert.equal(response.statusCode, 400);
    assert.match(String(response.body?.error), /autoResolveMergeConflicts.*boolean or null/);
    assert.equal(saveMonitoredRepos.mock.calls.length, 0);
  }
});

test('GET repository config returns the merge-conflict override and omits it when inheriting', async () => {
  const routes = createConfigRoutes({
    redisClient: {} as never,
    configStore: {
      loadMonitoredReposRaw: async () => [
        { id: 'repo-1', name: 'integry/propr', enabled: true, autoResolveMergeConflicts: false },
        { id: 'repo-2', name: 'integry/other', enabled: true }
      ],
      loadGitHubAttachmentCapacity: async () => resolveGitHubAttachmentCapacity()
    }
  });
  const response = createResponse();

  await routes.getRepos({} as never, response as never);

  const repos = response.body?.repos_to_monitor as RepoToMonitor[];
  assert.equal(repos[0].autoResolveMergeConflicts, false);
  assert.equal('autoResolveMergeConflicts' in repos[1], false);
});
