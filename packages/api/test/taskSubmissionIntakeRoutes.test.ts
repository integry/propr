import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import knex from 'knex';
import type { Request, Response } from 'express';
import { closeConnection } from '@propr/core';
import { up } from '../../core/src/db/migrations/20260922000000_add_task_submissions.js';
import { up as identityMigration } from '../../core/src/db/migrations/20260922010000_preserve_task_submission_identity.js';
import type { IntakeJobState, SubmissionIntakeEvidence } from '../../core/src/services/taskSubmissionIntake.js';
import { createTaskSubmissionRoutes } from '../routes/taskSubmissionRoutes.js';
import { configureDemoMode } from '../demoMode.js';

after(closeConnection);

const ADMISSION = 'Worktree disk pressure: admission reserve unavailable; data retained';

function request(key = 'stable-key', user: unknown = { id: '297689653', username: 'propr-ultrafix' }): Request {
  return { body: {}, user, files: [], params: { key }, get: () => key } as unknown as Request;
}
function response() {
  const state: { status: number; body: Record<string, unknown> } = { status: 200, body: {} };
  const res = { status(code: number) { state.status = code; return this; }, json(body: Record<string, unknown>) { state.body = body; return this; } } as Response;
  return { res, state };
}

/** The observed legacy submission: accepted and queued on issue #34, its intake gone, no task. */
async function fixture() {
  const db = knex({ client: 'better-sqlite3', connection: { filename: ':memory:' }, useNullAsDefault: true });
  await up(db);
  await identityMigration(db);
  await db('task_submissions').insert({ id: 'cb70c6a3-45ed-4311-803e-84540911fc09', user_id: '297689653', submission_key: 'stable-key', payload_hash: 'hash',
    repository: 'owner/repo', payload: JSON.stringify({ instruction: 'Audit', agentAlias: 'astra', model: 'gpt-6-astra', routingLabel: 'llm-astra', trigger: 'AI', username: 'propr-ultrafix' }),
    attachments: '[]', state: 'queued', issue_number: 34, issue_url: 'https://github.com/owner/repo/issues/34' });
  return db;
}

function intake(job: IntakeJobState, failures: number): SubmissionIntakeEvidence & { checks: string[] } {
  const checks: string[] = [];
  return {
    checks,
    job: async jobId => { checks.push(jobId); return job; },
    failures: async () => failures ? { timestamp: 1, failures, reason: ADMISSION } : null,
  };
}

test('polling a legacy queued submission whose intake exhausted its attempts reports it failed, and retry starts the same issue once', async () => {
  configureDemoMode(false);
  const db = await fixture();
  const calls: string[] = [];
  const enqueued: Array<Record<string, unknown>> = [];
  let job: IntakeJobState = { state: 'absent' };
  let failures = 2;
  const evidence: SubmissionIntakeEvidence = { job: async () => job, failures: async () => failures ? { timestamp: 1, failures, reason: ADMISSION } : null };
  const routes = createTaskSubmissionRoutes({ db, services: {
    authorize: async () => ({ id: 'repo', name: 'owner/repo', enabled: true }),
    routing: async () => ({ agentAlias: 'astra', model: 'gpt-6-astra', routingLabel: 'llm-astra' }),
    getOctokit: async () => ({ request: async (route: string) => {
      calls.push(route);
      // The trigger the original dispatch published is on the issue's timeline.
      if (route.endsWith('/timeline')) return { data: [{ event: 'labeled', label: { name: 'AI' } }] };
      return { data: {} };
    } }) as never,
    processingLabels: async () => ['AI'],
    enqueue: async input => { enqueued.push(input); },
    intake: evidence,
  } });
  try {
    // Two recorded failures do not establish an exhausted intake: it stays queued.
    const pending = response();
    await routes.get(request(), pending.res);
    assert.equal(pending.state.body.state, 'queued');
    assert.equal(pending.state.body.error, null);
    failures = 3;
    const failed = response();
    await routes.get(request(), failed.res);
    assert.deepEqual(failed.state.body, {
      id: 'cb70c6a3-45ed-4311-803e-84540911fc09', state: 'failed', issueNumber: 34, issueUrl: 'https://github.com/owner/repo/issues/34', taskId: null,
      error: `Implementation did not start after 3 attempts: ${ADMISSION}. Once the cause is fixed, Retry agent starts this same issue again without creating another.`,
    });
    // Another user cannot read or retry it.
    const foreign = response();
    await routes.retry(request('stable-key', { id: 'mallory', username: 'mallory' }), foreign.res);
    assert.equal(foreign.state.status, 404);
    // Retries race; one re-dispatches the original issue without another issue or trigger write.
    job = { state: 'live', timestamp: 2 };
    const retries = [response(), response()];
    await Promise.all(retries.map(retry => routes.retry(request(), retry.res)));
    assert.ok(retries.some(retry => retry.state.body.state === 'queued'));
    assert.ok(retries.every(retry => retry.state.body.issueNumber === 34));
    assert.equal(calls.filter(route => route === 'POST /repos/{owner}/{repo}/issues').length, 0);
    assert.equal(calls.filter(route => route.endsWith('/labels')).length, 0);
    assert.deepEqual(enqueued, [{ owner: 'owner', repo: 'repo', issueNumber: 34, userId: '297689653', triggeringLabel: 'AI', correlationId: 'cb70c6a3-45ed-4311-803e-84540911fc09' }]);
    // The retry's own intake is live: polling keeps the submission queued.
    const live = response();
    await routes.get(request(), live.res);
    assert.equal(live.state.body.state, 'queued');
    assert.equal(live.state.body.error, null);
  } finally { await db.destroy(); }
});

test('live, delayed or completed intakes, dispatched submissions and unreadable evidence leave the submission as stored', async () => {
  configureDemoMode(false);
  const cases: Array<[string, IntakeJobState, number, Record<string, unknown>]> = [
    ['a live intake', { state: 'live', timestamp: 1 }, 3, {}],
    ['a completed intake', { state: 'completed', timestamp: 1 }, 3, {}],
    ['an absent intake without recorded failures', { state: 'absent' }, 0, {}],
    ['a dispatched submission', { state: 'absent' }, 3, { dispatch_complete: true }],
    ['a submission with a task', { state: 'absent' }, 3, { task_id: 'task-1', latest_task_id: 'task-1' }],
  ];
  for (const [name, job, failures, change] of cases) {
    const db = await fixture();
    try {
      if (Object.keys(change).length) await db('task_submissions').update(change);
      const evidence = intake(job, failures);
      const routes = createTaskSubmissionRoutes({ db, services: { intake: evidence } });
      const read = response();
      await routes.get(request(), read.res);
      assert.equal(read.state.body.state, 'queued', name);
      assert.equal(read.state.body.error, null, name);
      if (Object.keys(change).length) assert.deepEqual(evidence.checks, [], name);
    } finally { await db.destroy(); }
  }
  const db = await fixture();
  try {
    const routes = createTaskSubmissionRoutes({ db, services: { intake: { job: async () => { throw new Error('Redis unavailable'); }, failures: async () => null } } });
    const read = response();
    await routes.get(request(), read.res);
    assert.equal(read.state.status, 200);
    assert.equal(read.state.body.state, 'queued');
  } finally { await db.destroy(); }
});
