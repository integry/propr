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
    status(code: number) { this.statusCode = code; return this; },
    json(payload: Record<string, unknown>) { this.body = payload; return this; }
  };
}

function createRoutes(previousRepos: RepoToMonitor[], saveMonitoredRepos: ReturnType<typeof mock.fn>) {
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
      saveMonitoredRepos,
      clearRemovedRepositoryIndexData: async () => {}
    } as never,
    database: {
      transaction: async (callback: (transaction: never) => Promise<unknown>) => callback({} as never)
    } as never
  });
}

test('POST repository config persists and preserves the follow-up CI cancellation option', async () => {
  const saveMonitoredRepos = mock.fn<(repos: RepoToMonitor[]) => Promise<boolean>>(async () => true);
  const routes = createRoutes([
    { id: 'repo-1', name: 'integry/propr', enabled: true, cancelCiDuringFollowup: true },
    { id: 'repo-2', name: 'integry/other', enabled: true }
  ], saveMonitoredRepos);
  const response = createResponse();

  // A client that does not know the option must not switch it off.
  await routes.postRepos({
    body: {
      repos_to_monitor: [
        { id: 'repo-1', name: 'integry/propr', enabled: true },
        { id: 'repo-2', name: 'integry/other', enabled: true, cancelCiDuringFollowup: true },
        { id: 'repo-3', name: 'integry/new', enabled: true }
      ]
    }
  } as never, response as never);

  assert.equal(response.statusCode, 200);
  assert.deepEqual(
    saveMonitoredRepos.mock.calls[0]?.arguments[0].map(repo => [repo.id, repo.cancelCiDuringFollowup]),
    [['repo-1', true], ['repo-2', true], ['repo-3', false]]
  );
});

test('POST repository config round-trips the validation workflow selection and preserves it for older clients', async () => {
  const saveMonitoredRepos = mock.fn<(repos: RepoToMonitor[]) => Promise<boolean>>(async () => true);
  const routes = createRoutes([
    {
      id: 'repo-1', name: 'integry/propr', enabled: true,
      cancelCiDuringFollowup: true, cancelCiDuringFollowupWorkflows: ['pr-build-check.yml', 'Full Test Suite']
    },
    { id: 'repo-2', name: 'integry/other', enabled: true }
  ], saveMonitoredRepos);
  const response = createResponse();

  await routes.postRepos({
    body: {
      repos_to_monitor: [
        // An older client that knows nothing about the selection must not drop it.
        { id: 'repo-1', name: 'integry/propr', enabled: true },
        // A current client selects workflows for another repository.
        {
          id: 'repo-2', name: 'integry/other', enabled: true,
          cancelCiDuringFollowup: true, cancelCiDuringFollowupWorkflows: [' ci-validation.yml ', 'ci-validation.yml']
        }
      ]
    }
  } as never, response as never);

  assert.equal(response.statusCode, 200);
  assert.deepEqual(
    saveMonitoredRepos.mock.calls[0]?.arguments[0].map(repo => [repo.id, repo.cancelCiDuringFollowupWorkflows]),
    [['repo-1', ['pr-build-check.yml', 'Full Test Suite']], ['repo-2', ['ci-validation.yml']]]
  );

  // ...and the stored selection is what the API hands back.
  const read = createResponse();
  await createRoutes(saveMonitoredRepos.mock.calls[0]!.arguments[0], saveMonitoredRepos)
    .getRepos({} as never, read as never);
  assert.deepEqual(
    (read.body?.repos_to_monitor as RepoToMonitor[]).map(repo => repo.cancelCiDuringFollowupWorkflows),
    [['pr-build-check.yml', 'Full Test Suite'], ['ci-validation.yml']]
  );
});

test('POST repository config rejects a selection that is not a list of workflows', async () => {
  const saveMonitoredRepos = mock.fn<(repos: RepoToMonitor[]) => Promise<boolean>>(async () => true);
  const routes = createRoutes([], saveMonitoredRepos);
  const response = createResponse();

  await routes.postRepos({
    body: { repos_to_monitor: [{ id: 'repo-1', name: 'integry/propr', enabled: true, cancelCiDuringFollowupWorkflows: 'pr-build-check.yml' }] }
  } as never, response as never);

  assert.equal(response.statusCode, 400);
  assert.match(String(response.body?.error), /cancelCiDuringFollowupWorkflows/);
  assert.equal(saveMonitoredRepos.mock.calls.length, 0);
});

test('POST repository config rejects a non-boolean follow-up CI cancellation option', async () => {
  const saveMonitoredRepos = mock.fn<(repos: RepoToMonitor[]) => Promise<boolean>>(async () => true);
  const routes = createRoutes([], saveMonitoredRepos);
  const response = createResponse();

  await routes.postRepos({
    body: { repos_to_monitor: [{ id: 'repo-1', name: 'integry/propr', enabled: true, cancelCiDuringFollowup: 'yes' }] }
  } as never, response as never);

  assert.equal(response.statusCode, 400);
  assert.match(String(response.body?.error), /cancelCiDuringFollowup/);
  assert.equal(saveMonitoredRepos.mock.calls.length, 0);
});
