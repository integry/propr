import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { randomBytes } from 'node:crypto';
import knex from 'knex';
import { z } from 'zod';
import { closeConnection, type ScheduleDispatchResult, type TaskSchedule } from '@propr/core';
import { up as mcpMigration } from '../../core/src/db/migrations/20260910220000_add_mcp.js';
import { up as lifecycleMigration } from '../../core/src/db/migrations/20261001000000_add_mcp_operation_lifecycle.js';
import { up as submissionMigration } from '../../core/src/db/migrations/20260922000000_add_task_submissions.js';
import { up as scheduleMigration } from '../../core/src/db/migrations/20261007000000_create_task_schedules.js';
import { createToolCatalog, executeTool, type ToolDeps } from '../mcp/tools.js';
import { McpPolicy, type McpPrincipal } from '../mcp/policy.js';
import { McpError } from '../mcp/config.js';
import { McpStore } from '../mcp/store.js';
import { McpOAuthProvider } from '../mcp/oauth.js';

after(closeConnection);

type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

async function fixture() {
  const db = knex({ client: 'better-sqlite3', connection: { filename: ':memory:' }, useNullAsDefault: true });
  await db.schema.createTable('task_drafts', table => { table.string('draft_id').primary(); });
  await mcpMigration(db);
  await lifecycleMigration(db);
  await submissionMigration(db);
  await db.schema.createTable('tasks', table => { table.string('task_id').primary(); table.string('repository'); });
  await scheduleMigration(db);
  const authorized: string[] = [];
  const dispatched: Array<{ schedule: TaskSchedule; key: string }> = [];
  const config = { origin: 'https://instance.example', resource: 'https://instance.example/api/mcp', instanceId: 'test', encryptionKey: randomBytes(32) };
  const policy = new McpPolicy(new McpOAuthProvider(new McpStore(db, config.encryptionKey), config), config);
  policy.repository = async (principal, repository) => {
    if (!principal.grant.repositories.includes(repository)) throw new McpError('REPOSITORY_FORBIDDEN', 'No repository access', 403);
  };
  const principal = (id: string, extra: Json = {}) => ({ user: { id, username: id }, authorization: { permissions: [] },
    grant: { id: `grant-${id}`, repositories: ['owner/repo', 'owner/other'] }, scopes: ['read', 'execute'], ...extra }) as unknown as McpPrincipal;
  const deps: ToolDeps = { db, policy, taskQueue: {} as never, redisClient: {} as never, runtimeBuildQueue: {} as never,
    scheduleServices: {
      authorize: async (_req, repository) => { authorized.push(repository); return { id: 'repo', name: repository, enabled: true, baseBranch: 'main' } as never; },
      routing: async body => {
        if (body.model === 'unsupported') throw Object.assign(new Error('Unsupported model'), { status: 400 });
        return { agentAlias: body.agentAlias || 'default-agent', model: body.model || 'default-model', routingLabel: 'llm-agent-model' };
      },
      dependencies: {
        dispatch: async (schedule, key): Promise<ScheduleDispatchResult> => {
          dispatched.push({ schedule, key });
          return { submissionId: `submission-${dispatched.length}`, state: 'queued', taskId: null, error: null };
        },
        admissionSettings: async () => ({ maxConcurrent: 0, window: null, windowError: null }) as never,
      },
    },
  };
  const catalog = createToolCatalog(deps);
  const call = async (name: string, args: Json, user: McpPrincipal) =>
    (await executeTool(catalog.find(tool => tool.name === name)!, args, user, deps)).data as Json;
  return { db, catalog, call, principal, authorized, dispatched };
}

const createArgs = {
  idempotencyKey: 'nightly-deps-schedule', repository: 'Owner/Repo', name: 'Nightly dependency bump',
  cron: '0 3 * * *', timezone: 'Europe/Berlin', instruction: 'Update outdated dependencies and run the tests.',
};

test('MCP schedule tools are registered with the expected scopes and read-only annotations', async () => {
  const f = await fixture();
  try {
    const expected = { create_schedule: ['execute', false], list_schedules: ['read', true], run_schedule_now: ['execute', false], delete_schedule: ['execute', false] };
    for (const [name, [scope, readOnly]] of Object.entries(expected)) {
      const tool = f.catalog.find(candidate => candidate.name === name);
      assert.ok(tool, name);
      assert.equal(tool.scope, scope);
      assert.equal(!!tool.readOnly, readOnly);
      assert.ok(z.toJSONSchema(tool.schema));
    }
  } finally { await f.db.destroy(); }
});

test('create_schedule authorizes the repository, records the caller as owner and replays by idempotency key', async () => {
  const f = await fixture();
  const alice = f.principal('alice');
  try {
    const receipt = await f.call('create_schedule', createArgs, alice);
    assert.notEqual(receipt.state, 'failed', JSON.stringify(receipt.result));
    const schedule = receipt.result.schedule as TaskSchedule;
    assert.deepEqual(f.authorized, ['owner/repo']);
    assert.equal(schedule.repository, 'owner/repo');
    assert.deepEqual(schedule.owner, { userId: 'alice', username: 'alice' });
    assert.equal(schedule.cron, '0 3 * * *');
    assert.equal(schedule.timezone, 'Europe/Berlin');
    assert.equal(schedule.enabled, true);
    assert.equal(schedule.instruction.text, createArgs.instruction);
    assert.ok(!schedule.instruction.runUltrafix);
    assert.equal(schedule.instruction.ultrafixGoal, undefined);
    assert.ok(schedule.nextRunAt);
    assert.equal(receipt.result.continuation.scheduleId, schedule.id);

    assert.deepEqual(await f.call('create_schedule', createArgs, alice), receipt);
    assert.equal((await f.db('task_schedules')).length, 1);
    await assert.rejects(f.call('create_schedule', { ...createArgs, cron: '0 4 * * *' }, alice), /different arguments/);
    await assert.rejects(f.call('create_schedule', { ...createArgs, idempotencyKey: 'outside-grant', repository: 'outside/grant' }, alice), /No repository access/);
    await assert.rejects(f.call('create_schedule', { ...createArgs, idempotencyKey: 'read-only-caller' }, { ...alice, scopes: ['read'] } as McpPrincipal), /requires execute/);

    const merging = await f.call('create_schedule', { ...createArgs, idempotencyKey: 'auto-merge-schedule', autoMerge: true }, alice);
    assert.equal(merging.state, 'failed');
    const invalidCron = await f.call('create_schedule', { ...createArgs, idempotencyKey: 'too-frequent-schedule', cron: '* * * * *' }, alice);
    assert.equal(invalidCron.state, 'failed');
    const invalidModel = await f.call('create_schedule', { ...createArgs, idempotencyKey: 'unsupported-model', model: 'unsupported' }, alice);
    assert.equal(invalidModel.state, 'failed');
    const strayBound = await f.call('create_schedule', { ...createArgs, idempotencyKey: 'stray-ultrafix-bound', ultrafixGoal: 8 }, alice);
    assert.equal(strayBound.state, 'failed');
    assert.equal((await f.db('task_schedules')).length, 1);

    const reviewer = f.principal('alice', { scopes: ['read', 'execute', 'review'] });
    const ultrafix = await f.call('create_schedule', { ...createArgs, idempotencyKey: 'ultrafix-schedule', runUltrafix: true, ultrafixMaxCycles: 4, enabled: false }, reviewer);
    assert.equal(ultrafix.result.schedule.instruction.runUltrafix, true);
    assert.equal(ultrafix.result.schedule.instruction.ultrafixMaxCycles, 4);
    assert.equal(ultrafix.result.schedule.enabled, false);
  } finally { await f.db.destroy(); }
});

test('list_schedules stays inside the grant and returns recent runs for one schedule', async () => {
  const f = await fixture();
  const alice = f.principal('alice');
  try {
    const created = await f.call('create_schedule', createArgs, alice);
    const id = created.result.schedule.id as string;
    await f.db('task_schedules').insert({ ...(await f.db('task_schedules').where({ id }).first()), id: '00000000-0000-4000-8000-000000000001', repository: 'elsewhere/repo' });
    const listed = await f.call('list_schedules', {}, alice);
    assert.deepEqual(listed.schedules.map((schedule: Json) => schedule.id), [id]);
    assert.deepEqual((await f.call('list_schedules', { repository: 'owner/other' }, alice)).schedules, []);
    await assert.rejects(f.call('list_schedules', { repository: 'elsewhere/repo' }, alice), /No repository access/);
    await assert.rejects(f.call('list_schedules', { scheduleId: id }, alice), /scheduleId requires repository/);
    await f.call('run_schedule_now', { idempotencyKey: 'run-before-listing', repository: 'owner/repo', scheduleId: id }, alice);
    const detail = await f.call('list_schedules', { repository: 'owner/repo', scheduleId: id }, alice);
    assert.equal(detail.schedules[0].id, id);
    assert.equal(detail.runs.length, 1);
    assert.equal(detail.runs[0].trigger, 'manual');
    await assert.rejects(f.call('list_schedules', { repository: 'owner/other', scheduleId: id }, alice), /not found/i);
  } finally { await f.db.destroy(); }
});

test('run_schedule_now and delete_schedule are limited to the owner or an instance administrator', async () => {
  const f = await fixture();
  const alice = f.principal('alice');
  const bob = f.principal('bob');
  const admin = f.principal('carol', { authorization: { permissions: ['instance.manage_settings'] } });
  try {
    const created = await f.call('create_schedule', createArgs, alice);
    const id = created.result.schedule.id as string;
    await f.db('task_schedules').where({ id }).update({ enabled: false, paused_reason: 'Paused after 3 consecutive failed runs' });
    const target = { repository: 'owner/repo', scheduleId: id };

    const denied = await f.call('run_schedule_now', { ...target, idempotencyKey: 'bob-runs-alice' }, bob);
    assert.equal(denied.state, 'failed');
    assert.equal(denied.result.error.code, 'FORBIDDEN');
    assert.equal(f.dispatched.length, 0);
    await assert.rejects(f.call('run_schedule_now', { repository: 'owner/other', scheduleId: id, idempotencyKey: 'wrong-repository' }, alice), /not found/i);

    const run = await f.call('run_schedule_now', { ...target, idempotencyKey: 'alice-runs-own' }, alice);
    assert.notEqual(run.state, 'failed', JSON.stringify(run.result));
    assert.equal(run.result.run.trigger, 'manual');
    assert.equal(run.result.run.submissionId, 'submission-1');
    assert.equal(run.result.schedule.enabled, true);
    assert.equal(run.result.schedule.pausedReason, null);
    assert.equal(run.result.continuation.submissionId, 'submission-1');
    assert.equal(f.dispatched.length, 1);
    assert.match(f.dispatched[0].key, new RegExp(`^schedule:${id}:manual:mcp-`));
    assert.deepEqual(await f.call('run_schedule_now', { ...target, idempotencyKey: 'alice-runs-own' }, alice), run);
    assert.equal(f.dispatched.length, 1);

    const byAdmin = await f.call('run_schedule_now', { ...target, idempotencyKey: 'admin-runs-alice' }, admin);
    assert.notEqual(byAdmin.state, 'failed', JSON.stringify(byAdmin.result));
    assert.equal(f.dispatched.length, 2);

    await f.db('task_schedules').where({ id }).update({ instruction: JSON.stringify({ text: 'Merge it', autoMerge: true }) });
    const needsMerge = await f.call('run_schedule_now', { ...target, idempotencyKey: 'run-without-merge' }, alice);
    assert.equal(needsMerge.state, 'failed');
    assert.equal(f.dispatched.length, 2);

    const notDeleted = await f.call('delete_schedule', { ...target, idempotencyKey: 'bob-deletes-alice' }, bob);
    assert.equal(notDeleted.state, 'failed');
    assert.equal((await f.db('task_schedules')).length, 1);
    const deleted = await f.call('delete_schedule', { ...target, idempotencyKey: 'alice-deletes-own' }, alice);
    assert.notEqual(deleted.state, 'failed', JSON.stringify(deleted.result));
    assert.equal((await f.db('task_schedules')).length, 0);
    assert.equal((await f.db('task_schedule_runs')).length, 0);
  } finally { await f.db.destroy(); }
});
