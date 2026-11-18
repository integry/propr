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

/** The caller can read every repository; the denied-caller test supplies its own check. */
const allowAccess = async () => {};
/** The repositories this instance configures; readiness is served for no other. */
const configuredRepositories = async () => [
  { name: 'acme/app', enabled: true },
  { name: 'acme/private-repo', enabled: true },
  { name: 'Acme/Retired', enabled: false },
];

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
    configuredRepositories,
    verifyAccess: allowAccess,
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
    configuredRepositories,
    verifyAccess: allowAccess,
    evaluate: (owner, repo, number, deps) => evaluatePullRequestReadiness(owner, repo, number, {
      ...readOnlyStandIns, ...deps, octokit: { request: async () => { throw Object.assign(new Error('Bad gateway'), { status: 502 }); } },
    }),
  });
  const outage = await invoke(routes.getReadiness, { number: '42' }, { repository: 'acme/app' });
  assert.equal(outage.status, 502);
  assertConforms(ErrorEnvelope, outage.body, 'ErrorEnvelope');
  assert.equal((outage.body as { code: string }).code, 'GITHUB_UNAVAILABLE');
});

test('a caller without GitHub read access to the repository gets no readiness data and the App is never consulted', async () => {
  await database.migrate.latest();
  const app = appIdentityFake({ 42: readyPull(42) });
  const evaluated: string[] = [];
  const checked: string[] = [];
  let denial: unknown = Object.assign(new Error('Not Found'), { status: 404 });
  const routes = createPullRequestReadinessRoutes({
    db: database,
    configuredRepositories,
    verifyAccess: async (_req, repository) => { checked.push(repository); if (denial) throw denial; },
    evaluate: (owner, repo, number, deps) => {
      evaluated.push(`${owner}/${repo}#${number}`);
      return evaluatePullRequestReadiness(owner, repo, number, { ...readOnlyStandIns, ...deps, octokit: app.octokit });
    },
  });

  // GitHub hides private repositories from non-members with 404, and answers 403 for some denials.
  for (const status of [404, 403]) {
    denial = Object.assign(new Error('denied'), { status });
    const denied = await invoke(routes.getReadiness, { number: '42' }, { repository: 'acme/private-repo' });
    assert.equal(denied.status, 404, `GitHub ${status}`);
    assertConforms(ErrorEnvelope, denied.body, 'ErrorEnvelope');
    assert.equal((denied.body as { code: string }).code, 'REPOSITORY_NOT_ACCESSIBLE');
    assert.doesNotMatch(JSON.stringify(denied.body), /head|base|sha|check|review/i, 'no pull request data is disclosed');
  }

  denial = Object.assign(new Error('Service unavailable'), { status: 503 });
  const outage = await invoke(routes.getReadiness, { number: '42' }, { repository: 'acme/private-repo' });
  assert.equal(outage.status, 502);
  assertConforms(ErrorEnvelope, outage.body, 'ErrorEnvelope');
  assert.equal((outage.body as { code: string }).code, 'GITHUB_UNAVAILABLE');

  assert.deepEqual(evaluated, [], 'the App-backed evaluation never runs without proven caller access');
  assert.deepEqual(app.calls, [], 'the App identity never reads GitHub for a denied caller');
  assert.deepEqual(checked, ['acme/private-repo', 'acme/private-repo', 'acme/private-repo'], 'the trimmed requested repository is checked');

  denial = null;
  assert.equal((await invoke(routes.getReadiness, { number: '42' }, { repository: 'acme/private-repo' })).status, 200);
  assert.deepEqual(evaluated, ['acme/private-repo#42'], 'evaluation runs only once access is proven');
});

test('without an injected check the caller\'s own GitHub credential is required before evaluation', async () => {
  const evaluated: string[] = [];
  const routes = createPullRequestReadinessRoutes({
    db: database,
    configuredRepositories,
    evaluate: async (owner, repo, number) => { evaluated.push(`${owner}/${repo}#${number}`); throw new Error('must not run'); },
  });
  // An instance member authenticated without a GitHub token (no session token, not an instance token).
  const sent: { status: number; body?: { code?: string } } = { status: 200 };
  const response = {
    status(code: number) { sent.status = code; return response; },
    json(value: { code?: string }) { sent.body = value; return response; },
  } as unknown as Response;
  await routes.getReadiness({ params: { number: '42' }, query: { repository: 'acme/private-repo' }, user: { id: 'member-1' } } as unknown as Request, response);
  assert.notEqual(sent.status, 200);
  assert.equal(sent.body?.code, 'GITHUB_AUTHORIZATION_REQUIRED');
  assert.deepEqual(evaluated, []);
});

test('readiness is served only for an enabled configured repository, under its configured name', async () => {
  await database.migrate.latest();
  const evaluated: string[] = [];
  const checked: string[] = [];
  const routes = createPullRequestReadinessRoutes({
    db: database,
    configuredRepositories,
    verifyAccess: async (_req, repository) => { checked.push(repository); },
    evaluate: async (owner, repo, number) => {
      evaluated.push(`${owner}/${repo}#${number}`);
      return { repository: `${owner}/${repo}`, number } as never;
    },
  });

  // A public repository this instance does not monitor, and a disabled one, are never evaluated.
  for (const repository of ['facebook/react', 'acme/retired']) {
    const denied = await invoke(routes.getReadiness, { number: '1' }, { repository });
    assert.equal(denied.status, 404, repository);
    assertConforms(ErrorEnvelope, denied.body, 'ErrorEnvelope');
    assert.equal((denied.body as { code: string }).code, 'REPOSITORY_NOT_ACCESSIBLE');
  }
  assert.deepEqual(checked, [], 'no GitHub quota is spent on an unconfigured repository');
  assert.deepEqual(evaluated, []);

  // Any capitalization finds the configured repository, and the echo is its configured name.
  const ready = await invoke(routes.getReadiness, { number: '7' }, { repository: 'ACME/App' });
  assert.equal(ready.status, 200);
  assert.equal((ready.body as { repository: string }).repository, 'acme/app');
  assert.deepEqual(evaluated, ['acme/app#7']);
  assert.deepEqual(checked, ['acme/app']);
});

test('the response echoes the configured name even when the evaluator reports GitHub\'s spelling', async () => {
  await database.migrate.latest();
  const routes = createPullRequestReadinessRoutes({
    db: database,
    configuredRepositories: async () => [{ name: 'Acme/App', enabled: true }],
    verifyAccess: allowAccess,
    // Like the core evaluator, report the identity GitHub returned for the pull request.
    evaluate: async (_owner, _repo, number) => ({ repository: 'acme/app', number, verdict: 'ready' }) as never,
  });

  const sent = await invoke(routes.getReadiness, { number: '3' }, { repository: 'acme/APP' });
  assert.equal(sent.status, 200);
  assert.equal((sent.body as { repository: string }).repository, 'Acme/App');
  assert.equal((sent.body as { number: number }).number, 3);
  assert.equal((sent.body as { verdict: string }).verdict, 'ready');
});
