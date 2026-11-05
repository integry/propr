import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import knex from 'knex';
import type { AddressInfo } from 'node:net';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { up as createFollowupHandoffsTable } from '../../core/src/db/migrations/20261017000000_add_pr_followup_handoffs.js';
import {
  createFollowupHandoffRoutes,
  followupHandoffTargetKey,
  FOLLOWUP_HANDOFF_RECOVERY_MODULE,
  type FollowupHandoffKey,
  type FollowupHandoffRecoverySummary,
  type FollowupHandoffRouteDeps,
  type FollowupHandoffStatus,
} from '../routes/followupHandoffRoutes.js';
import { createRequestRateLimiter } from '../requestRateLimits.js';

test('the default deps module path points at the real recovery job source', () => {
  const routesDirectory = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../routes');
  const source = path.resolve(routesDirectory, FOLLOWUP_HANDOFF_RECOVERY_MODULE.replace(/\.js$/, '.ts'));
  assert.ok(existsSync(source), `${source} should exist; the lazy import would fail at runtime`);
});

test('the default deps actually import the recovery module and run against the real import graph', async () => {
  // Packaged-runtime smoke: unlike the path assertion above, this executes the
  // production lazy import (and the recovery module's full dependency graph,
  // including the real @propr/core surface) through the default dependencies.
  process.env.NODE_ENV = 'test';
  const { createDefaultFollowupHandoffDeps } = await import('../routes/followupHandoffRoutes.js');
  const deps = createDefaultFollowupHandoffDeps();
  const database = knex({ client: 'better-sqlite3', connection: { filename: ':memory:' }, useNullAsDefault: true });
  try {
    await createFollowupHandoffsTable(database);
    const statuses = await deps.inspectFollowupHandoffs({ store: { database } });
    assert.deepEqual(statuses, [], 'the loaded module answers with the injected empty store');
  } finally {
    await database.destroy();
    // The real core import holds a knex pool open; release it so the runner exits.
    const { db } = await import('@propr/core');
    await (db as { destroy(): Promise<void> }).destroy();
  }
});

const summary: FollowupHandoffRecoverySummary = {
  inspected: 1, published: 1, noChanges: 0, settled: 0, cleanupPending: 0,
  skippedLiveAgent: 0, failedClosed: 0, awaitingOperator: 0, lockedByOtherWriter: 0, errors: 0,
};

function status(overrides: Partial<FollowupHandoffStatus['record']> = {}): FollowupHandoffStatus {
  return {
    record: {
      repository: 'integry/propr', pull_request: 42, task_id: 'task-1', phase: 'pushed',
      status: 'awaiting_operator', status_reason: 'cancelled_by_user', operator_authorized: 0,
      branch_name: 'propr/fix-42', worktree_path: '/tmp/worktrees/fix-42',
      commit_hash: 'abc123', completion_comment_url: null, updated_at: 1760650000000, ...overrides,
    },
    liveness: 'not_checked', nextAction: 'inspect the retained worktree, then resume or release',
    predecessorTaskIds: ['task-0'], successorTaskId: null,
  };
}

interface Call { name: string; args: unknown[] }

function stubDeps(calls: Call[], overrides: Partial<FollowupHandoffRouteDeps> = {}): FollowupHandoffRouteDeps {
  const record = (name: string) => (...args: unknown[]) => { calls.push({ name, args }); };
  return {
    inspectFollowupHandoffs: async (deps, key) => { record('inspect')(deps, key); return [status()]; },
    recoverInterruptedFollowupHandoffs: async (deps, key) => { record('recover')(deps, key); return summary; },
    authorizeCancelledFollowupHandoff: async (key, deps) => { record('authorize')(key, deps); return status().record; },
    resumeOperatorHeldFollowupHandoff: async (key, deps) => { record('resume')(key, deps); return { resumed: true }; },
    releaseFollowupHandoffRecord: async (key, options, deps) => { record('release')(key, options, deps); return { released: true }; },
    ...overrides,
  };
}

async function withServer(deps: FollowupHandoffRouteDeps, run: (origin: string) => Promise<void>): Promise<void> {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    const role = req.get('x-role');
    if (role) {
      const admin = role === 'admin';
      req.user = { id: role, username: role } as typeof req.user;
      req.authorization = { role: admin ? 'admin' : 'member', permissions: admin ? ['instance.manage_runtime'] : [], source: 'local' };
    }
    next();
  });
  const routes = createFollowupHandoffRoutes(deps);
  const rateLimiter = createRequestRateLimiter({ identifier: 'followup-handoff-routes-test-fixture', limit: 100, windowMs: 60_000 });
  app.get('/api/admin/followup-handoffs', rateLimiter, routes.list);
  app.get('/api/admin/followup-handoffs/:owner/:repo/:pr', rateLimiter, routes.get);
  app.post('/api/admin/followup-handoffs/:owner/:repo/:pr/resume', rateLimiter, routes.resume);
  app.post('/api/admin/followup-handoffs/:owner/:repo/:pr/release', rateLimiter, routes.release);
  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>(resolve => server.once('listening', resolve));
  try { await run(`http://127.0.0.1:${(server.address() as AddressInfo).port}`); }
  finally { await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); }
}

const asAdmin = { 'x-role': 'admin', 'content-type': 'application/json' };

test('every follow-up handoff route denies anonymous and non-admin callers inside the handler', async () => {
  const calls: Call[] = [];
  await withServer(stubDeps(calls), async origin => {
    const targets: [string, string][] = [
      ['GET', '/api/admin/followup-handoffs'],
      ['GET', '/api/admin/followup-handoffs/integry/propr/42'],
      ['POST', '/api/admin/followup-handoffs/integry/propr/42/resume'],
      ['POST', '/api/admin/followup-handoffs/integry/propr/42/release'],
    ];
    for (const [method, path] of targets) {
      assert.equal((await fetch(`${origin}${path}`, { method })).status, 401, `${method} ${path} anonymous`);
      assert.equal((await fetch(`${origin}${path}`, { method, headers: { 'x-role': 'member' } })).status, 403, `${method} ${path} member`);
    }
    assert.equal(calls.length, 0, 'no backend function runs for rejected callers');
  });
});

test('admin list and single status expose the operator payload with no-store caching', async () => {
  const calls: Call[] = [];
  await withServer(stubDeps(calls), async origin => {
    const list = await fetch(`${origin}/api/admin/followup-handoffs`, { headers: asAdmin });
    assert.equal(list.status, 200);
    assert.equal(list.headers.get('cache-control'), 'no-store');
    const { handoffs } = await list.json() as { handoffs: Record<string, unknown>[] };
    assert.equal(handoffs.length, 1);
    assert.deepEqual(handoffs[0], {
      repository: 'integry/propr', pullRequest: 42, taskId: 'task-1', predecessorTaskIds: ['task-0'],
      successorTaskId: null, phase: 'pushed', status: 'awaiting_operator', statusReason: 'cancelled_by_user',
      settlement: null, operatorAuthorized: false, liveness: 'not_checked', branchName: 'propr/fix-42', commitHash: 'abc123',
      completionCommentUrl: null, nextAction: 'inspect the retained worktree, then resume or release',
      retainedWorktreePath: '/tmp/worktrees/fix-42', updatedAt: 1760650000000,
    });

    const one = await fetch(`${origin}/api/admin/followup-handoffs/Integry/ProPR/42`, { headers: asAdmin });
    assert.equal(one.status, 200);
    const single = await one.json() as { status: { repository: string } };
    assert.equal(single.status.repository, 'integry/propr');
    // The single-status inspection is keyed with the lowercased repository.
    const inspect = calls.find(call => call.name === 'inspect' && call.args[1]);
    assert.deepEqual(inspect?.args[1], { repository: 'integry/propr', pull_request: 42 });
  });
});

test('status keeps the durable settlement apart from a later liveness diagnostic', async () => {
  const deps = stubDeps([], {
    inspectFollowupHandoffs: async () => [status({
      phase: 'cleanup_pending', status: 'active', status_reason: 'liveness_unavailable',
      settlement: 'returned_to_queue', commit_hash: null,
    })],
  });
  await withServer(deps, async origin => {
    const one = await fetch(`${origin}/api/admin/followup-handoffs/integry/propr/42`, { headers: asAdmin });
    assert.equal(one.status, 200);
    const { status: body } = await one.json() as { status: Record<string, unknown> };
    assert.equal(body.statusReason, 'liveness_unavailable');
    assert.equal(body.settlement, 'returned_to_queue', 'the diagnostic does not replace the semantic classification');
  });
});

test('bad targets are rejected with 400 and unknown handoffs with 404', async () => {
  const calls: Call[] = [];
  const deps = stubDeps(calls, { inspectFollowupHandoffs: async () => [] });
  await withServer(deps, async origin => {
    for (const path of [
      '/api/admin/followup-handoffs/integry/propr/0',
      '/api/admin/followup-handoffs/integry/propr/abc',
      '/api/admin/followup-handoffs/integry/pro%20pr/42',
      '/api/admin/followup-handoffs/in%2Ftegry/propr/42',
    ]) {
      assert.equal((await fetch(`${origin}${path}`, { headers: asAdmin })).status, 400, path);
      assert.equal((await fetch(`${origin}${path}/release`, { method: 'POST', headers: asAdmin, body: '{}' })).status, 400, `${path}/release`);
    }
    assert.equal((await fetch(`${origin}/api/admin/followup-handoffs/integry/propr/42`, { headers: asAdmin })).status, 404);
  });
  assert.equal(followupHandoffTargetKey({ owner: 'Integry', repo: 'ProPR', pr: '42' })?.repository, 'integry/propr');
  assert.equal(followupHandoffTargetKey({ owner: 'integry', repo: 'propr', pr: '4.2' }), null);
});

test('resume runs a recovery pass strictly keyed to the addressed pull request', async () => {
  const calls: Call[] = [];
  await withServer(stubDeps(calls), async origin => {
    const response = await fetch(`${origin}/api/admin/followup-handoffs/integry/propr/42/resume`, {
      method: 'POST', headers: asAdmin, body: JSON.stringify({}),
    });
    assert.equal(response.status, 200);
    const body = await response.json() as { summary: FollowupHandoffRecoverySummary; status: { pullRequest: number } };
    assert.deepEqual(body.summary, summary);
    assert.equal(body.status.pullRequest, 42);
    const recover = calls.find(call => call.name === 'recover');
    assert.ok(recover, 'the keyed recovery pass ran');
    assert.deepEqual(recover.args[1] as FollowupHandoffKey, { repository: 'integry/propr', pull_request: 42 });
    const resume = calls.find(call => call.name === 'resume');
    assert.deepEqual(resume?.args[0], { repository: 'integry/propr', pull_request: 42 });
    assert.equal(calls.some(call => call.name === 'authorize'), false, 'no cancellation authority without the flag');
  });
});

test('resume surfaces cancellation authorization and refusal outcomes', async () => {
  const calls: Call[] = [];
  const deps = stubDeps(calls, {
    resumeOperatorHeldFollowupHandoff: async key => {
      calls.push({ name: 'resume', args: [key] });
      return { resumed: false, reason: 'requires_cancellation_authorization' };
    },
  });
  await withServer(deps, async origin => {
    const refused = await fetch(`${origin}/api/admin/followup-handoffs/integry/propr/42/resume`, {
      method: 'POST', headers: asAdmin, body: JSON.stringify({}),
    });
    assert.equal(refused.status, 409);
    assert.equal((await refused.json() as { code: string }).code, 'requires_cancellation_authorization');
    assert.equal(calls.some(call => call.name === 'recover'), false, 'no recovery pass after a refusal');

    const authorized = await fetch(`${origin}/api/admin/followup-handoffs/integry/propr/42/resume`, {
      method: 'POST', headers: asAdmin, body: JSON.stringify({ authorizeCancelled: true }),
    });
    assert.equal(authorized.status, 200);
    const authorize = calls.find(call => call.name === 'authorize');
    assert.deepEqual(authorize?.args[0], { repository: 'integry/propr', pull_request: 42 });
  });
});

test('resume maps a missing record to 404 and withheld authorization to 409', async () => {
  const deps = stubDeps([], {
    resumeOperatorHeldFollowupHandoff: async () => ({ resumed: false, reason: 'not_found' }),
    authorizeCancelledFollowupHandoff: async () => null,
  });
  await withServer(deps, async origin => {
    const missing = await fetch(`${origin}/api/admin/followup-handoffs/integry/propr/42/resume`, {
      method: 'POST', headers: asAdmin, body: JSON.stringify({}),
    });
    assert.equal(missing.status, 404);
    const withheld = await fetch(`${origin}/api/admin/followup-handoffs/integry/propr/42/resume`, {
      method: 'POST', headers: asAdmin, body: JSON.stringify({ authorizeCancelled: true }),
    });
    assert.equal(withheld.status, 409);
    assert.equal((await withheld.json() as { code: string }).code, 'cancellation_authorization_unavailable');
    const invalid = await fetch(`${origin}/api/admin/followup-handoffs/integry/propr/42/resume`, {
      method: 'POST', headers: asAdmin, body: JSON.stringify({ authorizeCancelled: 'yes' }),
    });
    assert.equal(invalid.status, 400);
  });
});

test('release maps refusals to 409, missing records to 404 and forwards force', async () => {
  const calls: Call[] = [];
  const outcomes = [
    { released: false, reason: 'worktree_holds_unpublished_work' },
    { released: false, reason: 'not_found' },
    { released: true },
  ];
  const deps = stubDeps(calls, {
    releaseFollowupHandoffRecord: async (key, options) => {
      calls.push({ name: 'release', args: [key, options] });
      return outcomes.shift()!;
    },
  });
  await withServer(deps, async origin => {
    const path = `${origin}/api/admin/followup-handoffs/integry/propr/42/release`;
    const held = await fetch(path, { method: 'POST', headers: asAdmin, body: JSON.stringify({}) });
    assert.equal(held.status, 409);
    assert.deepEqual(await held.json(), { released: false, reason: 'worktree_holds_unpublished_work' });
    assert.equal((await fetch(path, { method: 'POST', headers: asAdmin, body: JSON.stringify({}) })).status, 404);
    const forced = await fetch(path, { method: 'POST', headers: asAdmin, body: JSON.stringify({ force: true }) });
    assert.equal(forced.status, 200);
    assert.deepEqual(await forced.json(), { released: true });
    assert.deepEqual(calls.filter(call => call.name === 'release').map(call => call.args[1]),
      [{ force: false }, { force: false }, { force: true }]);
  });
});
