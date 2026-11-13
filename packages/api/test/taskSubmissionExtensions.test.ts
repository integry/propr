import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import knex from 'knex';
import type { Request, Response } from 'express';
import { closeConnection } from '@propr/core';
import { up } from '../../core/src/db/migrations/20260922000000_add_task_submissions.js';
import { up as identityMigration } from '../../core/src/db/migrations/20260922010000_preserve_task_submission_identity.js';
import { up as profileMigration } from '../../core/src/db/migrations/20261013210000_extension_profiles.js';
import { up as grantMigration } from '../../core/src/db/migrations/20261013220000_extension_grant_network.js';
import { up as libraryMigration } from '../../core/src/db/migrations/20261113000000_extension_library.js';
import { ExtensionLibraryStore } from '../../core/src/extensions/extensionProfileStore.js';
import { submissionExtensionsForRun } from '../../core/src/services/taskSubmissionService.js';
import { createTaskSubmissionRoutes } from '../routes/taskSubmissionRoutes.js';
import { configureDemoMode } from '../demoMode.js';

after(closeConnection);
const secret = 'UNMISTAKABLE_SUBMISSION_PREVIEW_SENTINEL';
const previousSecret = process.env.SYSTEM_TASK_SECRET;
process.env.SYSTEM_TASK_SECRET = 'synthetic-submission-extension-key';
after(() => { if (previousSecret === undefined) delete process.env.SYSTEM_TASK_SECRET; else process.env.SYSTEM_TASK_SECRET = previousSecret; });

function request(body: unknown, { key = 'stable-key', headers = {}, query = {} }: { key?: string; headers?: Record<string, string>; query?: Record<string, string> } = {}): Request {
  return { body, query, user: { id: '1', username: 'alice' }, files: [], params: { key }, get: (name: string) => (name === 'Idempotency-Key' ? key : headers[name]) } as unknown as Request;
}
function response() {
  const state: { status: number; body: Record<string, unknown> } = { status: 200, body: {} };
  const res = { status(code: number) { state.status = code; return this; }, json(body: Record<string, unknown>) { state.body = body; return this; } } as Response;
  return { res, state };
}
async function fixture() {
  const db = knex({ client: 'better-sqlite3', connection: { filename: ':memory:' }, useNullAsDefault: true });
  await up(db); await identityMigration(db);
  await db.schema.alterTable('task_submissions', t => t.text('extension_authorization'));
  await db.schema.createTable('config', c => { c.string('key').primary(); c.text('value'); });
  await db.schema.createTable('instance_members', c => { c.string('github_user_id').primary(); c.string('role'); });
  await db.schema.createTable('agent_definitions', c => { c.string('id').primary(); c.string('name'); });
  await db('instance_members').insert({ github_user_id: '1', role: 'admin' });
  await profileMigration(db); await grantMigration(db); await libraryMigration(db);
  return db;
}
function routesFor(db: knex.Knex, calls: { route: string; body: Record<string, unknown> }[] = [], runtime = 'claude') {
  return createTaskSubmissionRoutes({ db, services: {
    authorize: async () => ({ id: 'repo', name: 'owner/repo', enabled: true, baseBranch: 'main' }),
    routing: async () => ({ agentAlias: 'claude', model: 'model', routingLabel: 'llm-claude-model', runtime }),
    getOctokit: async () => ({ request: async (route: string, body: Record<string, unknown>) => {
      calls.push({ route, body });
      if (route.endsWith('/issues')) return { data: { number: 42, html_url: 'https://github.com/owner/repo/issues/42' } };
      return { data: {} };
    } }) as never,
    processingLabels: async () => ['AI'],
    enqueue: async () => undefined,
  } });
}

test('a New Task write opt-in is sealed and authorizes write servers for the exact initial task only', async () => {
  configureDemoMode(false);
  const db = await fixture();
  try {
    const res = response();
    await routesFor(db).submit(request({ repository: 'owner/repo', instruction: 'Update the tracker', extensionAllowWrite: true }, { headers: { 'X-ProPR-Extensions': '1' } }), res.res);
    assert.equal(res.state.body.state, 'queued');
    const row = await db('task_submissions').first();
    assert.equal(JSON.parse(row.payload).extensionAllowWrite, true);
    assert.ok(row.extension_authorization);
    await db('task_submissions').where({ id: row.id }).update({ task_id: 'initial', latest_task_id: 'initial' });
    const saved = await db('task_submissions').where({ id: row.id }).first();
    const run = { taskId: 'initial', agentAlias: 'claude', model: 'model', repository: 'owner/repo', issueNumber: 42 };
    assert.deepEqual(await submissionExtensionsForRun(saved, run, process.env, db), { extensions: { autoApply: true, servers: [], skills: [], repositories: ['owner/repo'], allowWrite: true } });
    // Retries, replacements and runs that are not exactly the submitted one fail safe to read items.
    for (const changed of [{ taskId: 'retry' }, { model: 'other' }, { agentAlias: 'codex' }, { issueNumber: 43 }]) assert.deepEqual(await submissionExtensionsForRun(saved, { ...run, ...changed }, process.env, db), {});
    assert.deepEqual(await submissionExtensionsForRun({ ...saved, latest_task_id: 'replacement' }, run, process.env, db), {});
    assert.deepEqual(await submissionExtensionsForRun({ ...saved, payload: JSON.stringify({ ...JSON.parse(saved.payload), instruction: 'Changed' }) }, run, process.env, db), {});
    assert.deepEqual(await submissionExtensionsForRun({ ...saved, extension_authorization: 'corrupt' }, run, process.env, db), {});
  } finally { await db.destroy(); }
});

test('"Run without extensions" labels the issue before the trigger; plain submissions keep their identity and labels', async () => {
  configureDemoMode(false);
  for (const [key, body, expected] of [
    ['plain', {}, [['llm-claude-model'], ['base-main'], ['AI']]],
    ['disabled', { disableExtensions: true }, [['llm-claude-model'], ['base-main'], ['disable-extensions'], ['AI']]],
  ] as const) {
    const db = await fixture();
    const calls: { route: string; body: Record<string, unknown> }[] = [];
    try {
      const res = response();
      await routesFor(db, calls).submit(request({ repository: 'owner/repo', instruction: 'Fix it', ...body }, { key }), res.res);
      assert.equal(res.state.body.state, 'queued', key);
      assert.deepEqual(calls.filter(call => call.route.endsWith('/labels')).map(call => call.body.labels), expected, key);
      const row = await db('task_submissions').first();
      assert.equal(JSON.parse(row.payload).disableExtensions, key === 'disabled' ? true : undefined);
      assert.equal(row.extension_authorization, null);
    } finally { await db.destroy(); }
  }
});

test('the New Task preview lists only names of items that apply to the repository and agent, never URLs or credentials', async () => {
  configureDemoMode(false);
  const db = await fixture();
  try {
    const store = new ExtensionLibraryStore(db);
    const bundle = await store.importSkill('1', [{ path: 'SKILL.md', content: Buffer.from('---\nname: release-notes\ndescription: Writes release notes\n---\nWrite them.').toString('base64') }], { kind: 'archive', filename: 'skill.tar' });
    const server = { kind: 'https' as const, url: 'https://8.8.8.8/mcp', enabled: true, tools: ['lookup'], authentication: 'none' as const, repositories: [], agents: [] };
    await store.saveLibrary('1', { version: 1, servers: [
      { ...server, name: 'docs', capability: 'read' },
      { ...server, name: 'tracker', capability: 'write', authentication: 'bearer' },
      { ...server, name: 'other-repo', capability: 'read', repositories: ['other/repo'] },
      { ...server, name: 'manual', capability: 'read', autoApply: false },
      { ...server, name: 'off', capability: 'read', enabled: false },
    ], skills: [{ bundleId: bundle.id, enabled: true, repositories: [], agents: ['claude'], autoApply: true }] }, { tracker: secret }, 0);
    const res = response();
    await routesFor(db).extensions(request(undefined, { query: { repository: 'Owner/Repo', agentAlias: 'claude' } }), res.res);
    assert.equal(res.state.status, 200);
    assert.deepEqual(res.state.body, { qualified: true, revision: 1, servers: [{ name: 'docs', capability: 'read' }, { name: 'tracker', capability: 'write' }], skills: [{ name: 'release-notes' }] });
    assert.doesNotMatch(JSON.stringify(res.state.body), new RegExp(`${secret}|8\\.8\\.8\\.8`));
    const unqualified = response();
    await routesFor(db, [], 'vibe').extensions(request(undefined, { query: { repository: 'owner/repo' } }), unqualified.res);
    assert.deepEqual(unqualified.state.body, { qualified: false, revision: 1, servers: [], skills: [] });
    const invalid = response();
    await routesFor(db).extensions(request(undefined, { query: { repository: 'not a repo' } }), invalid.res);
    assert.equal(invalid.state.status, 400);
  } finally { await db.destroy(); }
});
