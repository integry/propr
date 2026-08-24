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

test('GET repository config returns false for legacy entries with a missing option', async () => {
  const routes = createConfigRoutes({
    redisClient: {} as never,
    configStore: {
      loadMonitoredReposRaw: async () => [{ id: 'repo-1', name: 'integry/propr', enabled: true }]
    }
  });
  const response = createResponse();

  await routes.getRepos({} as never, response as never);

  assert.equal(response.statusCode, 200);
  assert.deepEqual(response.body, {
    repos_to_monitor: [{
      id: 'repo-1',
      name: 'integry/propr',
      enabled: true,
      autoFollowupOnFailedCi: false
    }]
  });
});

test('POST repository config persists an enabled option without enabling other repositories', async () => {
  const saveMonitoredRepos = mock.fn(async () => true);
  const routes = createConfigRoutes({
    redisClient: {
      set: mock.fn(async () => 'OK'),
      eval: mock.fn(async () => 1),
      publish: mock.fn(async () => 1),
      lPush: mock.fn(async () => 1),
      lTrim: mock.fn(async () => 'OK')
    } as never,
    configStore: {
      loadMonitoredReposRaw: async () => [],
      saveMonitoredRepos,
      clearRemovedRepositoryIndexData: async () => {}
    },
    database: {
      transaction: async (callback: (transaction: never) => Promise<unknown>) => callback({} as never)
    } as never
  });
  const response = createResponse();

  await routes.postRepos({
    body: {
      repos_to_monitor: [
        { id: 'repo-1', name: 'integry/propr', enabled: true, autoFollowupOnFailedCi: true },
        { id: 'repo-2', name: 'integry/other', enabled: true }
      ]
    }
  } as never, response as never);

  assert.equal(response.statusCode, 200);
  assert.equal(saveMonitoredRepos.mock.calls.length, 1);
  assert.deepEqual(saveMonitoredRepos.mock.calls[0]?.arguments[0], [
    {
      id: 'repo-1',
      name: 'integry/propr',
      enabled: true,
      autoFollowupOnFailedCi: true,
      alias: undefined,
      baseBranch: undefined,
      defaultBranch: undefined
    },
    {
      id: 'repo-2',
      name: 'integry/other',
      enabled: true,
      autoFollowupOnFailedCi: false,
      alias: undefined,
      baseBranch: undefined,
      defaultBranch: undefined
    }
  ]);
});
