import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import knex from 'knex';
import type { Request, Response } from 'express';
import { closeConnection, type ScheduleDependencies } from '@propr/core';
import { up as submissionsMigration } from '../../core/src/db/migrations/20260922000000_add_task_submissions.js';
import { up as identityMigration } from '../../core/src/db/migrations/20260922010000_preserve_task_submission_identity.js';
import { up as scheduleMigration } from '../../core/src/db/migrations/20261007000000_create_task_schedules.js';
import { createScheduleRoutes } from '../routes/scheduleRoutes.js';
import { configureDemoMode } from '../demoMode.js';

after(closeConnection);

const alice = { id: '1', username: 'alice' };
const bob = { id: '2', username: 'bob' };

function request(user: unknown, body: unknown = {}, params: Record<string, string> = {}, permissions: string[] = []): Request {
  return { user, body, params, query: {}, authorization: { permissions }, get: () => undefined } as unknown as Request;
}
function response() {
  const state: { status: number; body: Record<string, unknown> } = { status: 200, body: {} };
  const res = {
    status(code: number) { state.status = code; return this; },
    json(body: Record<string, unknown>) { state.body = body; return this; },
    end() { return this; },
  } as unknown as Response;
  return { res, state };
}

test('schedules are created for the requester; only the owner or an administrator may change or run them', async () => {
  configureDemoMode(false);
  const db = knex({ client: 'better-sqlite3', connection: { filename: ':memory:' }, useNullAsDefault: true });
  await db.schema.createTable('tasks', table => { table.string('task_id').primary(); });
  await submissionsMigration(db);
  await identityMigration(db);
  await scheduleMigration(db);
  const authorized: string[] = [];
  const dispatched: string[] = [];
  const dependencies: ScheduleDependencies = {
    admissionSettings: async () => ({ maxConcurrent: 1, window: '', windowError: null }),
    dispatch: async (_schedule, key) => { dispatched.push(key); return { submissionId: 's1', state: 'queued', taskId: null, error: null }; },
  };
  const routes = createScheduleRoutes({ db, services: {
    authorize: async (_req, repository) => { authorized.push(repository); return {} as never; },
    routing: async body => {
      if (body.model === 'gone') throw Object.assign(new Error('Selected agent or model is no longer available'), { status: 400 });
      return { agentAlias: 'a', model: 'm', routingLabel: 'llm-a-m' };
    },
    dependencies,
    now: () => new Date('2026-10-06T12:00:00Z'),
  } });
  try {
    const body = { repository: 'Acme/Repo', cron: '0 3 * * *', timezone: 'Europe/Riga', instruction: { text: 'Hunt flaky tests' } };
    const invalidModel = response();
    await routes.create(request(alice, { ...body, instruction: { text: 'x', model: 'gone' } }), invalidModel.res);
    assert.equal(invalidModel.state.status, 400);
    const badCron = response();
    await routes.create(request(alice, { ...body, cron: 'every night' }), badCron.res);
    assert.equal(badCron.state.status, 400);
    assert.match(String(badCron.state.body.error), /cron/);

    const created = response();
    await routes.create(request(alice, body), created.res);
    assert.equal(created.state.status, 201);
    const schedule = created.state.body.schedule as { id: string; owner: { username: string }; nextRunAt: string; name: string };
    assert.equal(schedule.owner.username, 'alice');
    assert.equal(schedule.name, 'Hunt flaky tests');
    assert.equal(schedule.nextRunAt, '2026-10-07T00:00:00.000Z');
    assert.deepEqual(authorized.slice(-1), ['acme/repo']);

    const listed = response();
    await routes.list(request(bob), listed.res);
    assert.equal((listed.state.body.schedules as unknown[]).length, 1);
    assert.deepEqual(listed.state.body.admission, { maxConcurrent: 1, window: '', windowError: null, running: 0 });

    const forbidden = response();
    await routes.runNow(request(bob, {}, { id: schedule.id }), forbidden.res);
    assert.equal(forbidden.state.status, 403);
    const forbiddenDelete = response();
    await routes.remove(request(bob, {}, { id: schedule.id }), forbiddenDelete.res);
    assert.equal(forbiddenDelete.state.status, 403);
    assert.equal(dispatched.length, 0);

    const ran = response();
    await routes.runNow(request(alice, {}, { id: schedule.id }), ran.res);
    assert.equal(ran.state.status, 200);
    assert.equal((ran.state.body.run as { trigger: string }).trigger, 'manual');
    assert.equal(dispatched.length, 1);

    const adminUpdate = response();
    await routes.update(request(bob, { enabled: false }, { id: schedule.id }, ['instance.manage_settings']), adminUpdate.res);
    assert.equal((adminUpdate.state.body.schedule as { enabled: boolean }).enabled, false);

    const detail = response();
    await routes.get(request(bob, {}, { id: schedule.id }), detail.res);
    assert.equal((detail.state.body.runs as unknown[]).length, 1);

    const removed = response();
    await routes.remove(request(alice, {}, { id: schedule.id }), removed.res);
    assert.equal(removed.state.status, 204);
    const missing = response();
    await routes.get(request(alice, {}, { id: schedule.id }), missing.res);
    assert.equal(missing.state.status, 404);
  } finally {
    await db.destroy();
  }
});
