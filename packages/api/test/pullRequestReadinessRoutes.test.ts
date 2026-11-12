import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, test } from 'node:test';
import type { Request, Response } from 'express';
import knex, { type Knex } from 'knex';
import { z } from 'zod';
import { closeConnection, evaluatePullRequestReadiness } from '@propr/core';
import { ErrorEnvelope, PullRequestReadiness } from '../openapi/schemas.js';
import { createPullRequestReadinessRoutes } from '../routes/pullRequestReadinessRoutes.js';
import { READY_HEAD, appIdentityFake, readOnlyStandIns, readyPull, seedReviewScore } from './fixtures/pullRequestReadiness.js';

const migrations = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../core/src/db/migrations');
const database: Knex = knex({
  client: 'better-sqlite3', connection: { filename: ':memory:' }, useNullAsDefault: true, pool: { min: 1, max: 1 },
  migrations: { directory: migrations, loadExtensions: ['.js'] },
});
after(async () => { await database.destroy(); await closeConnection(); });

async function invoke(handler: (req: Request, res: Response) => Promise<void>, params: Record<string, string>, query: Record<string, string>) {
  const sent: { status: number; body?: unknown } = { status: 200 };
  const response = {
    status(code: number) { sent.status = code; return response; },
    json(value: unknown) { sent.body = JSON.parse(JSON.stringify(value)); return response; },
  } as unknown as Response;
  await handler({ params, query } as unknown as Request, response);
  return sent;
}

function assertConforms(schema: z.ZodType, body: unknown, label: string): void {
  const result = schema.safeParse(body);
  assert.ok(result.success, `${label} does not match its schema:\n${result.success ? '' : z.prettifyError(result.error)}`);
  assert.deepEqual(result.data, body, `${label} sends fields its schema does not allow`);
}

test('GET /api/pull-requests/:number/readiness returns the core verdict, scored from the persisted review', async () => {
  await database.migrate.latest();
  await seedReviewScore(database, 'acme/app', 42, { score: 7, goal: 7, goalReached: true });
  const app = appIdentityFake({ 42: readyPull(42) });
  const evaluated: string[] = [];
  const routes = createPullRequestReadinessRoutes({
    db: database,
    evaluate: (owner, repo, number, deps) => {
      evaluated.push(`${owner}/${repo}#${number}`);
      return evaluatePullRequestReadiness(owner, repo, number, { ...readOnlyStandIns, ...deps, octokit: app.octokit });
    },
  });

  const ready = await invoke(routes.getReadiness, { number: '42' }, { repository: ' acme/app ' });
  assert.equal(ready.status, 200);
  assertConforms(PullRequestReadiness, ready.body, 'PullRequestReadiness');
  const body = ready.body as { verdict: string; blockingReasons: string[]; waitingReasons: string[]; review: unknown; checks: { reason: string } };
  assert.equal(body.verdict, 'ready');
  assert.deepEqual(body.blockingReasons, []);
  assert.deepEqual(body.waitingReasons, []);
  // The score loader projects goal_reached, so the Ultrafix cycle's own verdict and goal count.
  assert.deepEqual(body.review, { score: 7, goal: 7, goalReached: true, reviewedHead: READY_HEAD, matchesCurrentHead: true });
  assert.equal(body.checks.reason, 'checks_passing');
  assert.deepEqual(evaluated, ['acme/app#42']);
  for (const call of app.calls) assert.match(call, /^(GET |graphql)/);

  const missing = await invoke(routes.getReadiness, { number: '43' }, { repository: 'acme/app' });
  assert.equal(missing.status, 404);
  assertConforms(ErrorEnvelope, missing.body, 'ErrorEnvelope');
  assert.equal((missing.body as { code: string }).code, 'PULL_REQUEST_NOT_FOUND');

  for (const [params, query] of [[{ number: '1.5' }, { repository: 'acme/app' }], [{ number: '0' }, { repository: 'acme/app' }], [{ number: '1' }, {}], [{ number: '1' }, { repository: 'not a repo' }]] as const) {
    const invalid = await invoke(routes.getReadiness, params, query);
    assert.equal(invalid.status, 400, JSON.stringify(params));
    assertConforms(ErrorEnvelope, invalid.body, 'ErrorEnvelope');
    assert.equal((invalid.body as { code: string }).code, 'INVALID_INPUT');
  }
  assert.deepEqual(evaluated, ['acme/app#42', 'acme/app#43'], 'invalid requests never reach the evaluation');
});

test('a GitHub outage reading the pull request is a retryable GITHUB_UNAVAILABLE envelope', async () => {
  const routes = createPullRequestReadinessRoutes({
    db: database,
    evaluate: (owner, repo, number, deps) => evaluatePullRequestReadiness(owner, repo, number, {
      ...readOnlyStandIns, ...deps, octokit: { request: async () => { throw Object.assign(new Error('Bad gateway'), { status: 502 }); } },
    }),
  });
  const outage = await invoke(routes.getReadiness, { number: '42' }, { repository: 'acme/app' });
  assert.equal(outage.status, 502);
  assertConforms(ErrorEnvelope, outage.body, 'ErrorEnvelope');
  assert.equal((outage.body as { code: string }).code, 'GITHUB_UNAVAILABLE');
});
