import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { ApiClient } from './client.js';
import { addRepo, updateRepo, type MonitoredRepo } from './repos.js';

function createClient(repos: MonitoredRepo[]): { client: ApiClient; postedRepos: () => MonitoredRepo[] } {
  let savedRepos = repos;
  const client = {
    get: async () => ({ data: { repos_to_monitor: savedRepos } }),
    post: async (_path: string, options: { body: { repos_to_monitor: MonitoredRepo[] } }) => {
      savedRepos = options.body.repos_to_monitor;
      return { data: { success: true, repos_to_monitor: savedRepos } };
    }
  } as unknown as ApiClient;
  return { client, postedRepos: () => savedRepos };
}

test('addRepo preserves existing failed-CI options and defaults the new repository to false', async () => {
  const existing = {
    id: 'repo-1',
    name: 'integry/propr',
    enabled: true,
    autoFollowupOnFailedCi: true
  };
  const { client, postedRepos } = createClient([existing]);

  await addRepo('integry/other', {}, client);

  assert.equal(postedRepos()[0]?.autoFollowupOnFailedCi, true);
  assert.equal(postedRepos()[1]?.autoFollowupOnFailedCi, false);
  assert.deepEqual(postedRepos()[1]?.visualPreview, { enabled: false, types: ['image'] });
});

test('updateRepo merges visual preview fields without dropping existing instructions', async () => {
  const { client, postedRepos } = createClient([{
    id: 'repo-1',
    name: 'integry/propr',
    enabled: true,
    autoFollowupOnFailedCi: false,
    visualPreview: { enabled: false, types: ['image'], instructions: 'Show mobile.' }
  }]);

  await updateRepo('integry/propr', {
    visualPreview: { enabled: true, types: ['image', 'video'] }
  }, client);

  assert.deepEqual(postedRepos()[0]?.visualPreview, {
    enabled: true,
    types: ['image', 'video'],
    instructions: 'Show mobile.'
  });

  await updateRepo('integry/propr', { visualPreview: { instructions: null } }, client);
  assert.deepEqual(postedRepos()[0]?.visualPreview, {
    enabled: true,
    types: ['image', 'video']
  });
});

test('updateRepo writes the failed-CI option without changing other repositories', async () => {
  const { client, postedRepos } = createClient([
    { id: 'repo-1', name: 'integry/propr', enabled: true, autoFollowupOnFailedCi: false },
    { id: 'repo-2', name: 'integry/other', enabled: true, autoFollowupOnFailedCi: false }
  ]);

  await updateRepo('integry/propr', { autoFollowupOnFailedCi: true }, client);

  assert.equal(postedRepos()[0]?.autoFollowupOnFailedCi, true);
  assert.equal(postedRepos()[1]?.autoFollowupOnFailedCi, false);
});
