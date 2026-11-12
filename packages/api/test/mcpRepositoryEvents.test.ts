import assert from 'node:assert/strict';
import { after, test, mock } from 'node:test';
import { randomBytes } from 'node:crypto';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import knex from 'knex';
import type { Request, Response } from 'express';
import type { RedisClientType } from 'redis';
import { encodeRepositoryEventCursor } from '@propr/shared';
import type { McpPrincipal } from '../mcp/policy.js';
import type { ToolDeps, McpTool } from '../mcp/tools.js';

const repository = 'acme/repo';
const forbiddenRepository = 'acme/forbidden';
const ownerId = '123';

type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

after(async () => {
  const { closeConnection } = await import('@propr/core');
  await closeConnection();
});

/** Records what a handler sends: status, JSON body and whether the response was sent. */
function recorder() {
  const sent: { status: number; body?: Json } = { status: 200 };
  const res = {
    writableEnded: false,
    status(code: number) { sent.status = code; return res; },
    json(body: Json) { sent.body = body; res.writableEnded = true; return res; },
    once() { return res; },
    off() { return res; },
  };
  return { res: res as unknown as Response, sent };
}

test('list_repository_events, wait_repository_events and the REST routes share one cursor contract with authorization', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'propr-mcp-repository-events-'));
  process.env.DATA_DIR = root;
  process.env.DB_FILENAME = path.join(root, 'propr.sqlite');
  process.env.NODE_ENV = 'test';
  const core = await import('@propr/core');
  const configured = [repository, forbiddenRepository].map(name => ({ name, enabled: true, baseBranch: 'main' }));
  const boundary = await mock.module('@propr/core', { namedExports: { ...core, loadMonitoredReposRaw: async () => configured } });
  const { McpError } = await import('../mcp/config.js');
  const { McpPolicy } = await import('../mcp/policy.js');
  const { McpStore } = await import('../mcp/store.js');
  const { McpOAuthProvider } = await import('../mcp/oauth.js');
  const { createToolCatalog, executeTool } = await import('../mcp/tools.js');
  const { createRepositoryEventRoutes } = await import('../routes/repositoryEventRoutes.js');
  const { activeRepositoryEventWaiterCount, notifyRepositoryEventWaiters } = await import('../services/repositoryEventWait.js');
  const { RepositoryEventList, RepositoryEventWait } = await import('../openapi/schemasRepositoryEvents.js');
  const { ErrorEnvelope } = await import('../openapi/schemas.js');

  const db = knex({ client: 'better-sqlite3', connection: { filename: ':memory:' }, useNullAsDefault: true });
  try {
    await db.migrate.latest({ directory: fileURLToPath(new URL('../../core/src/db/migrations/', import.meta.url)) });
    const append = async (values: Record<string, unknown>) => {
      const result = await core.appendRepositoryEvent(db, { repository, domain: 'pull_request', type: 'head_changed', entityId: 7, prNumber: 7, ...values } as never, { publish: false });
      assert.equal(result.status, 'appended');
    };
    const config = { origin: 'https://instance.example', resource: 'https://instance.example/api/mcp', instanceId: 'events-instance', encryptionKey: randomBytes(32) };
    const store = new McpStore(db, config.encryptionKey);
    const policy = new McpPolicy(new McpOAuthProvider(store, config), config);
    policy.repository = async (_principal, target) => {
      if (target === forbiddenRepository) throw new McpError('REPOSITORY_FORBIDDEN', 'Denied', 403);
    };
    const deps: ToolDeps = { db, policy, redisClient: {} as RedisClientType, taskQueue: {} as never, runtimeBuildQueue: {} as never };
    const catalog = createToolCatalog(deps);
    const grant = { id: 'events-grant', ownerId, clientId: 'client', clientName: 'Events', instanceId: config.instanceId,
      resource: config.resource, scopes: ['read'], repositories: [repository, forbiddenRepository],
      createdAt: Date.now(), expiresAt: Date.now() + 600_000, revoked: false, membershipSource: 'local' };
    await store.put('grant', grant.id, grant);
    const principal = { user: { id: ownerId, username: 'tester', login: 'tester' },
      authorization: { role: 'member', source: 'local', permissions: [] }, scopes: ['read'], grant } as unknown as McpPrincipal;
    const tool = (name: string): McpTool => catalog.find(candidate => candidate.name === name)!;
    const call = async (name: string, args: Record<string, unknown>, signal?: AbortSignal) =>
      await executeTool(tool(name), args, principal, deps, signal) as unknown as { data: Json; summary: string };

    for (const name of ['list_repository_events', 'wait_repository_events']) {
      assert.equal(tool(name).scope, 'read');
      assert.equal(tool(name).readOnly, true);
      assert.match(tool(name).description, /CURSOR_EXPIRED/);
    }

    // Without a cursor: the current end, no history.
    await append({ type: 'opened' });
    const start = await call('list_repository_events', { repository });
    assert.deepEqual(start.data.events, []);
    assert.match(start.data.cursor, /^rec1\./);
    const history = await call('list_repository_events', { repository, fromStart: true });
    assert.deepEqual(history.data.events.map((event: Json) => event.type), ['opened']);

    await append({ type: 'merged' });
    await append({ domain: 'epic_queue', type: 'advanced', entityId: 'exec-1', prNumber: undefined, planId: 'plan-1' });
    const later = await call('list_repository_events', { repository, afterCursor: start.data.cursor });
    assert.deepEqual(later.data.events.map((event: Json) => event.type), ['merged', 'advanced']);
    assert.match(later.summary, /2 repository events/);
    const filtered = await call('list_repository_events', { repository, afterCursor: start.data.cursor, domains: ['epic_queue'], planId: 'plan-1' });
    assert.deepEqual(filtered.data.events.map((event: Json) => event.type), ['advanced']);

    // A wait returns at once on existing events, and times out with the unchanged cursor.
    const immediate = await call('wait_repository_events', { repository, afterCursor: start.data.cursor, types: ['merged'] });
    assert.equal(immediate.data.outcome, 'events');
    assert.deepEqual(immediate.data.events.map((event: Json) => event.pullRequest), [7]);
    const timedOut = await call('wait_repository_events', { repository, afterCursor: later.data.cursor, timeoutSeconds: 0.05 });
    assert.equal(timedOut.data.outcome, 'timeout');
    assert.equal(timedOut.data.cursor, later.data.cursor);
    assert.match(timedOut.summary, /Wait again with cursor/);

    // A wait wakes on a new event.
    const pending = call('wait_repository_events', { repository, afterCursor: later.data.cursor, timeoutSeconds: 10 });
    await new Promise(resolve => setTimeout(resolve, 50));
    await append({ type: 'closed' });
    notifyRepositoryEventWaiters(repository);
    assert.deepEqual((await pending).data.events.map((event: Json) => event.type), ['closed']);

    // Errors keep their codes and recovery; access is the standard grant check.
    await assert.rejects(call('list_repository_events', { repository, afterCursor: 'rec1.bogus' }), (error: Json) => {
      assert.equal(error.code, 'CURSOR_INVALID');
      assert.match(error.details.recovery, /afterCursor/);
      return true;
    });
    await assert.rejects(call('list_repository_events', { repository, afterCursor: encodeRepositoryEventCursor(forbiddenRepository, 0) }), { code: 'CURSOR_WRONG_REPOSITORY' });
    await assert.rejects(call('list_repository_events', { repository: forbiddenRepository }), { code: 'REPOSITORY_FORBIDDEN' });
    await assert.rejects(call('wait_repository_events', { repository: forbiddenRepository, timeoutSeconds: 0 }), { code: 'REPOSITORY_FORBIDDEN' });
    await assert.rejects(call('wait_repository_events', { repository, timeoutSeconds: 31 }), /timeoutSeconds|less than or equal|too_big|31/i);
    await assert.rejects(call('list_repository_events', { repository, limit: 101 }), /limit|too_big|100/i);
    await assert.rejects(call('list_repository_events', { repository, types: ['not_a_type'] }), /types|invalid/i);

    // Cancelling the MCP request releases the wait.
    const controller = new AbortController();
    const cancelled = call('wait_repository_events', { repository, timeoutSeconds: 30 }, controller.signal);
    await new Promise(resolve => setTimeout(resolve, 50));
    assert.equal(activeRepositoryEventWaiterCount(repository), 1);
    controller.abort();
    await assert.rejects(cancelled, { code: 'WAIT_ABORTED' });
    assert.equal(activeRepositoryEventWaiterCount(repository), 0);

    // A grant revoked while waiting stops the wait before any further event is returned.
    const revocable = call('wait_repository_events', { repository, timeoutSeconds: 10 });
    await new Promise(resolve => setTimeout(resolve, 50));
    await store.put('grant', grant.id, { ...grant, revoked: true });
    notifyRepositoryEventWaiters(repository);
    await assert.rejects(revocable, { code: 'ACCESS_REVOKED' });
    await store.put('grant', grant.id, grant);

    // REST: the same contract, checked against the published schemas.
    let denied = false;
    const routes = createRepositoryEventRoutes({
      db,
      configuredRepositories: async () => [repository, forbiddenRepository],
      verifyAccess: async (_req, target) => {
        if (target === forbiddenRepository || denied) throw Object.assign(new Error('Not Found'), { status: 404 });
      },
    });
    const rest = async (handler: 'listEvents' | 'waitEvents', query: Record<string, unknown>, user: Json | null = { id: ownerId }) => {
      const { res, sent } = recorder();
      await routes[handler]({ query, user: user ?? undefined } as unknown as Request, res);
      return sent;
    };
    const listed = await rest('listEvents', { repository, afterCursor: start.data.cursor, types: 'merged,closed' });
    assert.equal(listed.status, 200);
    RepositoryEventList.parse(listed.body);
    assert.deepEqual(listed.body!.events.map((event: Json) => event.type), ['merged', 'closed']);
    // The configured spelling is resolved case-insensitively.
    assert.equal((await rest('listEvents', { repository: 'ACME/Repo' })).body!.cursor, (await rest('listEvents', { repository })).body!.cursor);
    const waited = await rest('waitEvents', { repository, afterCursor: listed.body!.cursor, timeoutSeconds: '0' });
    assert.equal(waited.status, 200);
    RepositoryEventWait.parse(waited.body);
    assert.equal(waited.body!.outcome, 'timeout');
    assert.equal(waited.body!.cursor, listed.body!.cursor);

    const envelope = (sent: { status: number; body?: Json }, status: number, code: string) => {
      assert.equal(sent.status, status, JSON.stringify(sent.body));
      ErrorEnvelope.parse(sent.body);
      assert.equal(sent.body!.code, code);
    };
    envelope(await rest('listEvents', { repository, afterCursor: 'rec1.bogus' }), 400, 'CURSOR_INVALID');
    envelope(await rest('listEvents', { repository, afterCursor: encodeRepositoryEventCursor(forbiddenRepository, 0) }), 400, 'CURSOR_WRONG_REPOSITORY');
    envelope(await rest('listEvents', { repository, domains: 'pull_request,nope' }), 400, 'INVALID_INPUT');
    envelope(await rest('listEvents', { repository, limit: '0' }), 400, 'INVALID_INPUT');
    envelope(await rest('listEvents', { repository: 'not a repo' }), 400, 'INVALID_INPUT');
    envelope(await rest('waitEvents', { repository, timeoutSeconds: '31' }), 400, 'INVALID_INPUT');
    envelope(await rest('listEvents', { repository: 'acme/unconfigured' }), 404, 'REPOSITORY_NOT_ACCESSIBLE');
    assert.equal((await rest('listEvents', { repository }, null)).status, 401);
    const forbidden = await rest('listEvents', { repository: forbiddenRepository });
    assert.equal(forbidden.status, 404);
    assert.equal(forbidden.body!.code, 'REPOSITORY_NOT_ACCESSIBLE', 'the standard GitHub repository access error');
    denied = true;
    assert.equal((await rest('waitEvents', { repository, timeoutSeconds: '0' })).body!.code, 'REPOSITORY_NOT_ACCESSIBLE');
    denied = false;

    // Expired cursors answer 410, distinct from an empty result.
    await db('repository_event_floors').insert({ repository, floor_seq: 3, pruned_at: new Date().toISOString() });
    envelope(await rest('listEvents', { repository, afterCursor: encodeRepositoryEventCursor(repository, 0) }), 410, 'CURSOR_EXPIRED');
    await assert.rejects(call('list_repository_events', { repository, afterCursor: encodeRepositoryEventCursor(repository, 0) }), { code: 'CURSOR_EXPIRED' });
    assert.equal(activeRepositoryEventWaiterCount(), 0);
  } finally {
    boundary.restore();
    await db.destroy();
  }
});
