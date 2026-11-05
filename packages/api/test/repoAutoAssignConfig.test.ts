import type { RepoToMonitor } from '@propr/core';
import assert from 'node:assert/strict';
import { after, mock, test } from 'node:test';
import { normalizeRepoConfig, preserveRepoSettings, withDefaultRepoOptions } from '../routes/configRepoValidation.js';
import { resolveRepositoryAutoAssignment } from '../../core/src/daemon/configLoader.js';

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

const autoAssignOf = (repo: RepoToMonitor) => [repo.id, repo.autoAssignPullRequests, repo.autoAssignDefaultAssignee, repo.autoAssignRequestReview];

/** Normalizes the incoming list and applies the preservation chain, as POST /api/config/repos does. */
function write(previous: RepoToMonitor[], incoming: Record<string, unknown>[]): RepoToMonitor[] {
  const normalized = incoming.map(repo => {
    const result = normalizeRepoConfig(repo);
    assert.equal(result.ok, true, result.ok ? undefined : result.error);
    return (result as { ok: true; value: RepoToMonitor }).value;
  });
  return preserveRepoSettings(previous, normalized, incoming);
}

test('a repository without the fields reports automatic assignment as disabled', () => {
  const normalized = normalizeRepoConfig({ id: 'repo-1', name: 'integry/propr', enabled: true });
  assert.equal(normalized.ok, true);
  if (normalized.ok) assert.deepEqual(autoAssignOf(normalized.value), ['repo-1', false, null, false]);

  assert.deepEqual(autoAssignOf(withDefaultRepoOptions({ id: 'repo-1', name: 'integry/propr', enabled: true })), ['repo-1', false, null, false]);
  assert.deepEqual(
    autoAssignOf(withDefaultRepoOptions({ id: 'repo-1', name: 'integry/propr', enabled: true, autoAssignPullRequests: true, autoAssignDefaultAssignee: 'not a login', autoAssignRequestReview: true })),
    ['repo-1', true, null, true],
    'a malformed stored login reads as the issue author'
  );
});

test('repository config accepts the options, strips a leading @ and clears the assignee with null or a blank string', () => {
  const accepted = normalizeRepoConfig({
    id: 'repo-1', name: 'integry/propr', enabled: true,
    autoAssignPullRequests: true, autoAssignDefaultAssignee: ' @octo-cat ', autoAssignRequestReview: true
  });
  assert.equal(accepted.ok, true);
  if (accepted.ok) assert.deepEqual(autoAssignOf(accepted.value), ['repo-1', true, 'octo-cat', true]);

  for (const autoAssignDefaultAssignee of [null, '', '  ']) {
    const cleared = normalizeRepoConfig({ id: 'repo-1', name: 'integry/propr', enabled: true, autoAssignDefaultAssignee });
    assert.equal(cleared.ok, true);
    if (cleared.ok) assert.equal(cleared.value.autoAssignDefaultAssignee, null);
  }
});

test('repository config rejects malformed automatic assignment options, naming the repository and field', () => {
  const invalid: Array<[string, unknown]> = [
    ['autoAssignPullRequests', 'true'],
    ['autoAssignPullRequests', 1],
    ['autoAssignRequestReview', 'on'],
    ['autoAssignRequestReview', null],
    ['autoAssignDefaultAssignee', 42],
    ['autoAssignDefaultAssignee', true],
    ['autoAssignDefaultAssignee', 'octo cat'],
    ['autoAssignDefaultAssignee', '-octocat'],
    ['autoAssignDefaultAssignee', 'a'.repeat(40)],
    ['autoAssignDefaultAssignee', 'owner/repo']
  ];
  for (const [field, value] of invalid) {
    const normalized = normalizeRepoConfig({ id: 'repo-1', name: 'integry/propr', enabled: true, [field]: value });
    assert.equal(normalized.ok, false, `${field}=${JSON.stringify(value)} should be rejected`);
    if (!normalized.ok) {
      assert.match(normalized.error, new RegExp(field));
      assert.match(normalized.error, /integry\/propr/);
    }
  }
});

test('a partial write that omits the fields keeps the stored values', () => {
  const previous: RepoToMonitor[] = [
    { id: 'repo-1', name: 'integry/propr', enabled: true, autoAssignPullRequests: true, autoAssignDefaultAssignee: 'octocat', autoAssignRequestReview: true },
    { id: 'repo-2', name: 'integry/other', enabled: true }
  ];
  // The CLI and older UIs post the whole list without fields they do not know about.
  const saved = write(previous, [
    { id: 'repo-1', name: 'integry/propr', enabled: false },
    { id: 'repo-2', name: 'integry/other', enabled: true }
  ]);
  assert.deepEqual(saved.map(autoAssignOf), [['repo-1', true, 'octocat', true], ['repo-2', false, null, false]]);
  assert.equal(saved[0].enabled, false);
});

test('a write that changes one field keeps the other stored fields', () => {
  const previous: RepoToMonitor[] = [
    { id: 'repo-1', name: 'integry/propr', enabled: true, autoAssignPullRequests: true, autoAssignDefaultAssignee: 'octocat', autoAssignRequestReview: true }
  ];
  const saved = write(previous, [{ id: 'repo-1', name: 'integry/propr', enabled: true, autoAssignRequestReview: false }]);
  assert.deepEqual(saved.map(autoAssignOf), [['repo-1', true, 'octocat', false]]);
});

test('setting an option on one branch entry applies it to every entry of the repository', () => {
  const previous: RepoToMonitor[] = [
    { id: 'main', name: 'integry/propr', enabled: true, baseBranch: 'main' },
    { id: 'release', name: 'integry/propr', enabled: true, baseBranch: 'release' },
    { id: 'other', name: 'integry/other', enabled: true }
  ];
  const saved = write(previous, [
    { id: 'main', name: 'integry/propr', enabled: true, baseBranch: 'main' },
    { id: 'release', name: 'Integry/Propr', enabled: true, baseBranch: 'release', autoAssignPullRequests: true, autoAssignDefaultAssignee: 'octocat', autoAssignRequestReview: true },
    { id: 'other', name: 'integry/other', enabled: true }
  ]);
  assert.deepEqual(saved.map(autoAssignOf), [
    ['main', true, 'octocat', true],
    ['release', true, 'octocat', true],
    ['other', false, null, false]
  ]);

  // A current client that round-trips every entry and changes one of them wins over its unchanged siblings.
  const disabled = write(saved, [
    { ...saved[0], autoAssignPullRequests: false },
    { ...saved[1] },
    { ...saved[2] }
  ] as unknown as Record<string, unknown>[]);
  assert.deepEqual(disabled.map(autoAssignOf), [
    ['main', false, 'octocat', true],
    ['release', false, 'octocat', true],
    ['other', false, null, false]
  ]);
});

test('null clears the default assignee on every branch entry so the issue author is used again', () => {
  const previous: RepoToMonitor[] = [
    { id: 'main', name: 'integry/propr', enabled: true, baseBranch: 'main', autoAssignPullRequests: true, autoAssignDefaultAssignee: 'octocat' },
    { id: 'release', name: 'integry/propr', enabled: true, baseBranch: 'release', autoAssignPullRequests: true, autoAssignDefaultAssignee: 'octocat' }
  ];
  const saved = write(previous, [
    { id: 'main', name: 'integry/propr', enabled: true, baseBranch: 'main', autoAssignDefaultAssignee: null },
    { id: 'release', name: 'integry/propr', enabled: true, baseBranch: 'release' }
  ]);
  assert.deepEqual(saved.map(autoAssignOf), [['main', true, null, false], ['release', true, null, false]]);
});

test('POST /api/config/repos persists the options and rejects invalid values with 400', async () => {
  const saveMonitoredRepos = mock.fn<(repos: RepoToMonitor[]) => Promise<boolean>>(async () => true);
  const routes = createRoutes([{ id: 'repo-1', name: 'integry/propr', enabled: true }], saveMonitoredRepos);
  const response = createResponse();
  await routes.postRepos({
    body: { repos_to_monitor: [{ id: 'repo-1', name: 'integry/propr', enabled: true, autoAssignPullRequests: true, autoAssignDefaultAssignee: 'octocat', autoAssignRequestReview: true }] }
  } as never, response as never);
  assert.equal(response.statusCode, 200);
  assert.deepEqual(saveMonitoredRepos.mock.calls[0]?.arguments[0].map(autoAssignOf), [['repo-1', true, 'octocat', true]]);

  // The stored values are what GET hands back.
  const read = createResponse();
  await createRoutes(saveMonitoredRepos.mock.calls[0]!.arguments[0], saveMonitoredRepos).getRepos({} as never, read as never);
  assert.deepEqual((read.body?.repos_to_monitor as RepoToMonitor[]).map(autoAssignOf), [['repo-1', true, 'octocat', true]]);

  for (const [field, value] of [['autoAssignPullRequests', 'yes'], ['autoAssignDefaultAssignee', 'not a login'], ['autoAssignRequestReview', 0]] as const) {
    const rejected = createResponse();
    await routes.postRepos({
      body: { repos_to_monitor: [{ id: 'repo-1', name: 'integry/propr', enabled: true, [field]: value }] }
    } as never, rejected as never);
    assert.equal(rejected.statusCode, 400);
    assert.match(String(rejected.body?.error), new RegExp(`${field}.*integry/propr`));
  }
  assert.equal(saveMonitoredRepos.mock.calls.length, 1);
});

test('resolveRepositoryAutoAssignment returns the effective repository-wide settings', async () => {
  const repos: RepoToMonitor[] = [
    { id: 'main', name: 'integry/propr', enabled: true, baseBranch: 'main' },
    { id: 'release', name: 'Integry/Propr', enabled: true, baseBranch: 'release', autoAssignPullRequests: true, autoAssignDefaultAssignee: 'octocat', autoAssignRequestReview: true },
    { id: 'other', name: 'integry/other', enabled: true, autoAssignPullRequests: true, autoAssignDefaultAssignee: 'invalid login' }
  ];
  const load = async () => repos;
  assert.deepEqual(await resolveRepositoryAutoAssignment('integry', 'propr', load), { enabled: true, defaultAssignee: 'octocat', requestReview: true });
  assert.deepEqual(await resolveRepositoryAutoAssignment('integry', 'other', load), { enabled: true, defaultAssignee: null, requestReview: false });
  assert.deepEqual(await resolveRepositoryAutoAssignment('integry', 'unknown', load), { enabled: false, defaultAssignee: null, requestReview: false });
});

test('resolveRepositoryAutoAssignment fails closed when the configuration cannot be read', async () => {
  const resolved = await resolveRepositoryAutoAssignment('integry', 'propr', async () => {
    throw new Error('configuration unavailable');
  });
  assert.deepEqual(resolved, { enabled: false, defaultAssignee: null, requestReview: false });
});
