import assert from 'node:assert/strict';
import { test } from 'node:test';
import { PLUGIN_STATE_LIMITS, PluginSdkError, type PluginEventInput, type RepositoryEvent } from '@propr/shared';
import { createTestPluginContext } from '../testing/index.js';
import { recordEvent } from '../example-pack/handlers.js';

const event = (overrides: Partial<RepositoryEvent> = {}): PluginEventInput => ({
  kind: 'event',
  event: { seq: 4, repository: 'owner/repo', domain: 'task', type: 'completed', entityId: 'task-9', prNumber: null, issueNumber: 2, planId: null, headSha: null, payload: {}, occurredAt: '', ...overrides },
});

test('the test kit runs a handler with recorded propr calls, in-memory state and captured logs', async () => {
  const kit = createTestPluginContext({
    pluginId: 'example-pack', settings: { greeting: 'hey' }, grantedPermissions: ['events.read', 'tasks.read'],
    propr: { getTask: taskId => ({ taskId, repository: 'owner/repo', kind: 'implementation', issueNumber: 2, prNumber: null, state: 'completed', model: null, createdAt: '' }) },
  });
  assert.deepEqual(await recordEvent(event(), kit.ctx), { repository: 'owner/repo', cursor: 4 });
  assert.deepEqual(kit.calls, [{ operation: 'getTask', args: ['task-9'] }]);
  assert.equal(kit.state.get('cursor:owner/repo'), 4);
  assert.deepEqual(kit.logs.map(l => [l.level, l.message]), [['info', 'hey: task task-9 is completed']]);

  // The cursor only moves forward.
  assert.deepEqual(await recordEvent(event({ seq: 2, domain: 'pull_request', type: 'opened', entityId: '5' }), kit.ctx), { repository: 'owner/repo', cursor: 4 });
  assert.equal(kit.logs[1].message, 'pull_request opened');
});

test('the test kit refuses ungranted permissions, repositories outside the limit, unlisted hosts and plain HTTP', async () => {
  const kit = createTestPluginContext({ grantedPermissions: ['issues.read'], repositories: ['owner/repo'], outboundHosts: ['api.example.com'], connections: ['token'] });
  await assert.rejects(kit.ctx.propr.commentOnIssue('owner/repo', 1, 'hi'), (error: unknown) => error instanceof PluginSdkError && error.code === 'permission_denied');
  await assert.rejects(kit.ctx.propr.getIssue('other/repo', 1), (error: unknown) => error instanceof PluginSdkError && error.code === 'repository_not_allowed');
  assert.equal((await kit.ctx.propr.getIssue('owner/repo', 1)).number, 1);
  assert.deepEqual(kit.calls.map(c => c.operation), ['getIssue']);

  kit.respond('https://api.example.com/v1/', { json: { items: [1, 2] } });
  kit.respond(/\/v1\/missing$/, { status: 404, body: 'nope' });
  const fetch = kit.ctx.http('token');
  const ok = await fetch('https://api.example.com/v1/items', { method: 'POST', json: { q: 1 } });
  assert.equal(ok.ok, true);
  assert.deepEqual(await ok.json(), { items: [1, 2] });
  assert.equal(ok.headers['content-type'], 'application/json');
  const missing = await fetch('https://api.example.com/v1/missing');
  assert.equal(missing.status, 404);
  assert.equal(await missing.text(), 'nope');
  assert.deepEqual(kit.requests.map(r => [r.url, r.init.method ?? 'GET', r.connection]), [['https://api.example.com/v1/items', 'POST', 'token'], ['https://api.example.com/v1/missing', 'GET', 'token']]);
  await assert.rejects(fetch('http://api.example.com/v1/items'), (error: unknown) => error instanceof PluginSdkError && error.code === 'insecure_url');
  await assert.rejects(fetch('https://evil.example/v1/items'), (error: unknown) => error instanceof PluginSdkError && error.code === 'host_not_allowed');
  await assert.rejects(kit.ctx.http()('https://api.example.com/other'), (error: unknown) => error instanceof PluginSdkError && error.code === 'http_failed');
  assert.throws(() => kit.ctx.http('unknown'), (error: unknown) => error instanceof PluginSdkError && error.code === 'connection_unavailable');
});

test('the test kit refuses a task from a repository outside the limit, as the real getTask does', async () => {
  const task = (taskId: string, repository: string) => ({ taskId, repository, kind: 'implementation' as const, issueNumber: 2, prNumber: null, state: 'completed', model: null, createdAt: '' });
  const kit = createTestPluginContext({
    grantedPermissions: ['tasks.read'], repositories: ['owner/allowed'],
    // Read asynchronously, as a test answering from a fake store would.
    propr: { getTask: async taskId => task(taskId, taskId === 'elsewhere' ? 'other/repo' : 'Owner/Allowed') },
  });
  await assert.rejects(kit.ctx.propr.getTask('elsewhere'), (error: unknown) => error instanceof PluginSdkError && error.code === 'repository_not_allowed');
  assert.equal((await kit.ctx.propr.getTask('mine')).repository, 'Owner/Allowed', 'compared case-insensitively');
  assert.deepEqual(kit.calls, [{ operation: 'getTask', args: ['mine'] }], 'the refused call is not recorded');

  // An unanswered getTask resolves with a placeholder task inside the limit; a missing task is not found.
  const placeholder = createTestPluginContext({ grantedPermissions: ['tasks.read'], repositories: ['owner/allowed'] });
  assert.equal((await placeholder.ctx.propr.getTask('t')).repository, 'owner/allowed');
  const missing = createTestPluginContext({ grantedPermissions: ['tasks.read'], repositories: ['owner/allowed'], propr: { getTask: () => null as never } });
  await assert.rejects(missing.ctx.propr.getTask('gone'), (error: unknown) => error instanceof PluginSdkError && error.code === 'not_found');
});

test('the test kit state applies the real limits', async () => {
  const kit = createTestPluginContext({ state: { a: 1 } });
  assert.equal(await kit.ctx.state.get('a'), 1);
  await assert.rejects(kit.ctx.state.set('big', 'x'.repeat(PLUGIN_STATE_LIMITS.valueBytes)), (error: unknown) => error instanceof PluginSdkError && error.code === 'state_limit');
  await assert.rejects(kit.ctx.state.set('bad key', 1), (error: unknown) => error instanceof PluginSdkError && error.code === 'invalid_input');
  for (let i = 1; i < PLUGIN_STATE_LIMITS.keys; i++) await kit.ctx.state.set(`k${i}`, i);
  await assert.rejects(kit.ctx.state.set('one-more', 1), (error: unknown) => error instanceof PluginSdkError && error.code === 'state_limit');
  assert.equal(await kit.ctx.state.delete('a'), true);
  const expected = Array.from({ length: PLUGIN_STATE_LIMITS.keys - 1 }, (_, i) => `k${i + 1}`).filter(key => key.startsWith('k1')).sort();
  assert.deepEqual(await kit.ctx.state.keys('k1'), expected);
});
