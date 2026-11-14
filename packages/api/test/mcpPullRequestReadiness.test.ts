import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { z } from 'zod';
import type { ToolDeps } from '../mcp/tools.js';
import type { McpPrincipal } from '../mcp/policy.js';
import { READY_HEAD, appIdentityFake, readOnlyStandIns, readyPull, seedReviewScore } from './fixtures/pullRequestReadiness.js';

test('get_pull_request_readiness authorizes like get_pull_request, then evaluates read-only with the App identity', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'mcp-readiness-'));
  process.env.DATA_DIR = root; process.env.DB_FILENAME = path.join(root, 'core.sqlite'); process.env.NODE_ENV = 'test';
  const core = await import('@propr/core');
  try {
    await core.runMigrations();
    const { McpStore } = await import('../mcp/store.js');
    const { McpOAuthProvider } = await import('../mcp/oauth.js');
    const { McpPolicy } = await import('../mcp/policy.js');
    const { createToolCatalog, executeTool } = await import('../mcp/tools.js');
    const { PullRequestReadiness } = await import('../openapi/schemas.js');
    const config = { origin: 'https://instance.example', resource: 'https://instance.example/api/mcp', instanceId: 'fixture-instance', encryptionKey: randomBytes(32) };
    const policy = new McpPolicy(new McpOAuthProvider(new McpStore(core.db, config.encryptionKey), config), config);
    const authorized: Array<[string, boolean | undefined]> = [];
    policy.repository = async (_principal, repository, write) => {
      authorized.push([repository, write]);
      if (repository === 'acme/forbidden') throw new (await import('../mcp/config.js')).McpError('FORBIDDEN', 'Repository not in grant.', 403);
    };

    // The App sees PRs 42 and 44; the caller's own GitHub access only sees 42 and 43.
    const app = appIdentityFake({ 42: readyPull(42), 44: readyPull(44) });
    const callerCalls: string[] = [];
    const principal = { user: { id: 'alice', username: 'alice' }, authorization: { permissions: [] },
      grant: { id: 'grant-1', repositories: ['acme/app'] }, scopes: ['read'],
      github: { request: async (route: string, params: Record<string, unknown>) => {
        callerCalls.push(route);
        if (route !== 'GET /repos/{owner}/{repo}/pulls/{pull_number}' || ![42, 43].includes(Number(params.pull_number))) {
          throw Object.assign(new Error('Not Found'), { status: 404 });
        }
        return { data: readyPull(Number(params.pull_number)) };
      } } } as unknown as McpPrincipal;
    const evaluated: string[] = [];
    const deps = { db: core.db, policy, taskQueue: {}, redisClient: {}, runtimeBuildQueue: {},
      pullRequestReadiness: (owner, repo, number, readinessDeps) => {
        evaluated.push(`${owner}/${repo}#${number}`);
        return core.evaluatePullRequestReadiness(owner, repo, number, { ...readOnlyStandIns, ...readinessDeps, octokit: app.octokit });
      } } as ToolDeps;
    const tool = createToolCatalog(deps).find(item => item.name === 'get_pull_request_readiness');
    assert.ok(tool);
    assert.equal(tool.scope, 'read');
    assert.equal(tool.readOnly, true);
    assert.deepEqual(Object.keys(tool.schema.shape), ['repository', 'number']);

    await seedReviewScore(core.db, 'acme/app', 42, { score: 9 });
    const result = await executeTool(tool, { repository: 'acme/app', number: 42 }, principal, deps);
    const parsed = PullRequestReadiness.safeParse(result.data);
    assert.ok(parsed.success, parsed.success ? '' : z.prettifyError(parsed.error));
    assert.deepEqual(parsed.data, result.data, 'the tool returns exactly the documented shape');
    const readiness = result.data as { verdict: string; blockingReasons: string[]; waitingReasons: string[]; review: { reviewedHead: string } };
    assert.equal(readiness.verdict, 'ready');
    assert.deepEqual(readiness.blockingReasons, []);
    assert.deepEqual(readiness.waitingReasons, []);
    assert.equal(readiness.review.reviewedHead, READY_HEAD);
    // Repository authorization is the read-only check, and the caller's own access is one PR read.
    assert.deepEqual(authorized, [['acme/app', false]]);
    assert.deepEqual(callerCalls, ['GET /repos/{owner}/{repo}/pulls/{pull_number}']);
    assert.ok(app.calls.includes('GET /repos/{owner}/{repo}/commits/{ref}/status'), 'the App identity reads legacy commit statuses');
    for (const call of app.calls) assert.match(call, /^(GET |graphql)/);

    // Outside the grant: refused before GitHub or the evaluation is touched.
    await assert.rejects(executeTool(tool, { repository: 'acme/forbidden', number: 42 }, principal, deps), { code: 'FORBIDDEN' });
    // The caller cannot see #44: the App identity is never consulted on their behalf.
    await assert.rejects(executeTool(tool, { repository: 'acme/app', number: 44 }, principal, deps));
    // The caller sees #43 but the App does not: a coded not-found, not a guessed verdict.
    await assert.rejects(executeTool(tool, { repository: 'acme/app', number: 43 }, principal, deps), { code: 'PULL_REQUEST_NOT_FOUND' });
    assert.deepEqual(evaluated, ['acme/app#42', 'acme/app#43']);
  } finally {
    await core.closeConnection();
    await rm(root, { recursive: true, force: true });
  }
});
