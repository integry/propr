import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { after, afterEach, beforeEach, test } from 'node:test';
import express from 'express';
import knex, { type Knex } from 'knex';
import { closeConnection, db as coreDb, runMigrations, signAgentRunGrantRequest, type StoredAgentRun } from '@propr/core';
import { up as mcpMigration } from '../../core/src/db/migrations/20260910220000_add_mcp.js';
import { up as lifecycleMigration } from '../../core/src/db/migrations/20261001000000_add_mcp_operation_lifecycle.js';
import { McpStore } from '../mcp/store.js';
import { McpOAuthProvider, type McpGrant } from '../mcp/oauth.js';
import { McpPolicy } from '../mcp/policy.js';
import type { McpConfig } from '../mcp/config.js';
import { renderConnectedApp } from '../mcp/browser.js';
import { configureDemoMode } from '../demoMode.js';
import {
  AGENT_RUN_GRANT_RECORD_KIND,
  AGENT_RUN_MCP_CLIENT_ID,
  issueAgentRunGrant,
  revokeAgentRunGrant,
  revokeAgentRunPhaseGrant,
  type AgentRunGrantDependencies,
} from '../mcp/agentRunGrants.js';
import { AGENT_RUN_GRANT_SIGNATURE_WINDOW_MS, createAgentRunInternalRoutes } from '../routes/agentRunInternalRoutes.js';
import { createRequestRateLimiter } from '../requestRateLimits.js';

after(async () => closeConnection());

const OWNER = '123';
const SECRET = 'fixture-system-task-secret';
const config: McpConfig = { origin: 'https://instance.example', resource: 'https://instance.example/api/mcp', instanceId: 'instance-1234567890', encryptionKey: randomBytes(32) };
const activeGrant = { resolve: async () => ({ status: 'active' as const, accessToken: 'ghu_owner' }) };

function run(overrides: Partial<StoredAgentRun> = {}): StoredAgentRun {
  return {
    id: 'run-1', definitionId: 'def-1', ownerId: OWNER, trigger: 'manual', triggerSource: null, idempotencyKey: null,
    state: 'running', autonomyMode: 'dry_run',
    definitionSnapshot: { id: 'def-1', ownerId: OWNER, name: 'Nightly triage', repositories: ['acme/repo', 'acme/docs'] } as StoredAgentRun['definitionSnapshot'],
    reportTaskId: null, actionTaskId: null, report: null, reportTruncated: false, actionSummary: null, skipReason: null,
    failureReason: null, approvedBy: null, operatorNote: null, deferredUntil: null, deferrals: 0, createdAt: 1, startedAt: 1, reportedAt: null,
    finishedAt: null, updatedAt: 1,
    ...overrides,
  };
}

let db: Knex;
let server: Server;
let base: string;
let runs: Map<string, StoredAgentRun>;
let policy: McpPolicy;
let grantDeps: AgentRunGrantDependencies;
let originalFetch: typeof fetch;
const originalWhitelist = process.env.GITHUB_USER_WHITELIST;

beforeEach(async () => {
  configureDemoMode(false);
  process.env.GITHUB_USER_WHITELIST = 'tester';
  db = knex({ client: 'better-sqlite3', connection: { filename: ':memory:' }, useNullAsDefault: true });
  await db.schema.createTable('task_drafts', table => table.string('draft_id').primary());
  await mcpMigration(db);
  await lifecycleMigration(db);
  await db.schema.createTable('instance_members', table => { table.string('github_user_id').primary(); table.string('role'); table.string('source'); });
  await db('instance_members').insert({ github_user_id: OWNER, role: 'member', source: 'local' });
  grantDeps = { database: db, resolveConfig: async () => config, userGrants: activeGrant };
  policy = new McpPolicy(new McpOAuthProvider(new McpStore(db, config.encryptionKey), config), config, activeGrant);
  originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const request = new Request(input, init);
    if (request.url === 'https://api.github.com/user') {
      assert.equal(request.headers.get('authorization'), 'token ghu_owner');
      return Response.json({ id: Number(OWNER), login: 'tester' });
    }
    if (request.url.startsWith('https://api.github.com/repos/')) return Response.json({ permissions: { push: true } });
    return originalFetch(input, init);
  }) as typeof fetch;
  runs = new Map([['run-1', run()]]);
  const routes = createAgentRunInternalRoutes({
    ...grantDeps,
    getRun: async id => runs.get(id),
    environment: { SYSTEM_TASK_SECRET: SECRET, PROPR_INTERNAL_API_URL: 'http://api:4000' },
  });
  const app = express();
  const rateLimiter = createRequestRateLimiter({ identifier: 'agent-run-grants-test-fixture', limit: 100, windowMs: 60_000 });
  app.use(express.json());
  app.post('/api/internal/agent-runs/:runId/mcp-grants', rateLimiter, routes.issueGrant);
  app.post('/api/internal/agent-runs/:runId/mcp-grants/revoke', rateLimiter, routes.revokeGrant);
  server = createServer(app);
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterEach(async () => {
  globalThis.fetch = originalFetch;
  if (originalWhitelist === undefined) delete process.env.GITHUB_USER_WHITELIST; else process.env.GITHUB_USER_WHITELIST = originalWhitelist;
  await new Promise<void>(resolve => server.close(() => resolve()));
  await db.destroy();
});

async function post(path: string, body: Record<string, unknown>): Promise<{ status: number; body: Record<string, unknown> }> {
  const response = await originalFetch(`${base}/api/internal/agent-runs/run-1/mcp-grants${path}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
  return { status: response.status, body: await response.json() as Record<string, unknown> };
}

function signed(phase: string, ts = Date.now(), secret = SECRET): Record<string, unknown> {
  return { phase, ts, signature: signAgentRunGrantRequest(secret, 'run-1', phase, ts) };
}

test('forged, expired or mismatched signatures are rejected with 401', async () => {
  assert.equal((await post('', signed('report', Date.now(), 'another-secret'))).status, 401);
  assert.equal((await post('', { ...signed('report'), phase: 'action' })).status, 401, 'The phase is part of the signed payload');
  const stale = await post('', signed('report', Date.now() - AGENT_RUN_GRANT_SIGNATURE_WINDOW_MS - 1000));
  assert.equal(stale.status, 401);
  assert.equal(stale.body.error, 'SIGNATURE_EXPIRED');
  assert.equal((await post('', signed('report', Date.now() + AGENT_RUN_GRANT_SIGNATURE_WINDOW_MS + 1000))).status, 401);
  assert.equal((await post('/revoke', signed('report', Date.now(), 'another-secret'))).status, 401);
  assert.equal((await post('', { phase: 'report', ts: Date.now() })).status, 400);
  assert.equal((await post('', signed('merge'))).status, 400);
  assert.equal(await db('mcp_records').where({ kind: 'grant' }).count('* as count').first().then(row => Number(row!.count)), 0);
});

test('a valid signature for a run in the wrong state returns 409', async () => {
  runs.set('run-1', run({ state: 'completed' }));
  assert.equal((await post('', signed('report'))).status, 409);
  assert.equal((await post('', signed('action'))).status, 409);
  runs.set('run-1', run({ state: 'acting' }));
  assert.equal((await post('', signed('report'))).status, 409, 'A report grant requires a running run');
  runs.delete('run-1');
  assert.equal((await post('', signed('report'))).status, 404);
});

test('a report grant is read-only, limited to the run snapshot repositories and labelled for Connected apps', async () => {
  const response = await post('', { ...signed('report'), repositories: ['acme/everything'], ownerId: '999' });
  assert.equal(response.status, 200, JSON.stringify(response.body));
  assert.equal(response.body.url, 'http://api:4000/api/mcp');
  const token = response.body.token as string;
  assert.match(token, /^propr_mcp_/);
  assert.ok(Number(response.body.expiresAt) > Date.now() + 115 * 60_000 && Number(response.body.expiresAt) <= Date.now() + 120 * 60_000);

  const principal = await policy.authenticate(token);
  assert.equal(principal.user.id, OWNER);
  assert.deepEqual(principal.scopes, ['read']);
  assert.deepEqual(principal.grant.repositories, ['acme/repo', 'acme/docs'], 'Repositories come from the snapshot, never the body');
  assert.equal(principal.grant.clientId, AGENT_RUN_MCP_CLIENT_ID);
  assert.equal(principal.grant.clientName, 'ProPR Agent: Nightly triage');
  assert.equal(principal.grant.membershipSource, 'local', "The owner's membership source, so membership loss is enforced");
  assert.throws(() => policy.requireScope(principal, 'execute'), /requires execute/);
  await assert.rejects(policy.repository(principal, 'acme/other', true), { code: 'REPOSITORY_FORBIDDEN' });

  // Listed on /mcp/apps for the owner, and the token itself is only stored hashed.
  const rows = await db('mcp_records').where({ kind: 'grant', owner_id: OWNER }).select('value');
  assert.equal(rows.length, 1);
  const store = new McpStore(db, config.encryptionKey);
  assert.match(renderConnectedApp(store.unseal<McpGrant>(rows[0].value), ''), /ProPR Agent: Nightly triage/);
  assert.ok(!JSON.stringify(await db('mcp_records').select()).includes(token));
  assert.ok(await store.get(AGENT_RUN_GRANT_RECORD_KIND, 'run-1:report'), 'The sweep can find the grant by run');

  // Revocation ends the token immediately and is idempotent.
  const revoked = await post('/revoke', { ...signed('report'), grantId: response.body.grantId });
  assert.equal(revoked.status, 200);
  assert.equal(revoked.body.revoked, true);
  await assert.rejects(policy.authenticate(token));
  assert.equal(await store.get(AGENT_RUN_GRANT_RECORD_KIND, 'run-1:report'), undefined);
  assert.equal((await post('/revoke', signed('report'))).body.revoked, false);
});

test('an action grant may plan and execute but never merge, deploy, manage or review', async () => {
  runs.set('run-1', run({ state: 'acting' }));
  const response = await post('', signed('action'));
  assert.equal(response.status, 200, JSON.stringify(response.body));
  const principal = await policy.authenticate(response.body.token as string);
  assert.deepEqual(principal.scopes, ['read', 'plan', 'execute']);
  for (const scope of ['merge', 'deploy', 'manage', 'review'] as const) assert.throws(() => policy.requireScope(principal, scope), new RegExp(`requires ${scope}`));
  // `other/repo` is configured on the instance and writable on GitHub, but outside the definition.
  await runMigrations();
  const repos = JSON.stringify(['acme/repo', 'acme/docs', 'other/repo'].map(name => ({ name, enabled: true })));
  await coreDb('system_configs').insert({ key: 'repos_to_monitor', value: repos }).onConflict('key').merge({ value: repos });
  try {
    await policy.repository(principal, 'acme/repo', true);
    await assert.rejects(policy.repository(principal, 'other/repo', true), { code: 'REPOSITORY_FORBIDDEN' });
  } finally { await coreDb('system_configs').where({ key: 'repos_to_monitor' }).delete(); }
  // Revoking terminal runs still works (crash recovery).
  runs.set('run-1', run({ state: 'failed' }));
  assert.equal((await post('/revoke', signed('action'))).body.revoked, true);
  await assert.rejects(policy.authenticate(response.body.token as string));
});

test('a retried phase replaces its grant and revokes the previous token', async () => {
  const first = await issueAgentRunGrant({ ownerId: OWNER, definitionName: 'Nightly triage', runId: 'run-1', phase: 'report', repositories: ['acme/repo'] }, grantDeps);
  const second = await issueAgentRunGrant({ ownerId: OWNER, definitionName: 'Nightly triage', runId: 'run-1', phase: 'report', repositories: ['acme/repo'] }, grantDeps);
  await assert.rejects(policy.authenticate(first.accessToken));
  await policy.authenticate(second.accessToken);
  // A stale worker revoking its old grant id leaves the newer grant alone.
  assert.equal((await post('/revoke', { ...signed('report'), grantId: first.grantId })).body.revoked, false);
  await policy.authenticate(second.accessToken);
  await revokeAgentRunGrant(second.grantId, grantDeps);
  await assert.rejects(policy.authenticate(second.accessToken));
});

test('removing the owner\'s explicit membership ends the agent grant', async () => {
  const issued = await issueAgentRunGrant({ ownerId: OWNER, definitionName: 'Nightly triage', runId: 'run-1', phase: 'report', repositories: ['acme/repo'] }, grantDeps);
  await policy.authenticate(issued.accessToken);
  // GitHub identity and the whitelist stay valid, so the owner is still implicitly authorized.
  await db('instance_members').where({ github_user_id: OWNER }).delete();
  await assert.rejects(policy.authenticate(issued.accessToken), { code: 'ACCESS_REVOKED' });
});

test('overlapping issuances of one phase leave a single live grant that cleanup revokes', async () => {
  const input = { ownerId: OWNER, definitionName: 'Nightly triage', runId: 'run-1', phase: 'report' as const, repositories: ['acme/repo'] };
  const [a, b] = await Promise.all([issueAgentRunGrant(input, grantDeps), issueAgentRunGrant(input, grantDeps)]);
  const store = new McpStore(db, config.encryptionKey);
  const live = (await db('mcp_records').where({ kind: 'grant' }).select('value')).map(row => store.unseal<McpGrant>(row.value)).filter(grant => !grant.revoked);
  assert.equal(live.length, 1, 'The later issuance revoked the earlier one');
  // Each worker cleans up the grant it was given.
  await Promise.all([a, b].map(grant => revokeAgentRunPhaseGrant('run-1', 'report', { ...grantDeps, grantId: grant.grantId })));
  await assert.rejects(policy.authenticate(a.accessToken));
  await assert.rejects(policy.authenticate(b.accessToken));
  assert.equal(await store.get(AGENT_RUN_GRANT_RECORD_KIND, 'run-1:report'), undefined);
});

test('stale cleanup overlapping a replacement never deletes the replacement record', async () => {
  const input = { ownerId: OWNER, definitionName: 'Nightly triage', runId: 'run-1', phase: 'report' as const, repositories: ['acme/repo'] };
  const a = await issueAgentRunGrant(input, grantDeps);
  const [revoked, b] = await Promise.all([
    revokeAgentRunPhaseGrant('run-1', 'report', { ...grantDeps, grantId: a.grantId }),
    issueAgentRunGrant(input, grantDeps),
  ]);
  assert.ok(revoked === a.grantId || revoked === null);
  await assert.rejects(policy.authenticate(a.accessToken));
  await policy.authenticate(b.accessToken);
  const store = new McpStore(db, config.encryptionKey);
  assert.equal((await store.get<{ grantId: string }>(AGENT_RUN_GRANT_RECORD_KIND, 'run-1:report'))?.grantId, b.grantId);
  assert.equal(await revokeAgentRunPhaseGrant('run-1', 'report', { ...grantDeps, grantId: b.grantId }), b.grantId);
  await assert.rejects(policy.authenticate(b.accessToken));
});

test('issuance requires MCP and a stored GitHub user grant for the owner', async () => {
  const input = { ownerId: OWNER, definitionName: 'Nightly triage', runId: 'run-1', phase: 'report' as const, repositories: ['acme/repo'] };
  await assert.rejects(issueAgentRunGrant(input, { ...grantDeps, resolveConfig: async () => null }), { code: 'MCP_DISABLED' });
  await assert.rejects(issueAgentRunGrant(input, { ...grantDeps, userGrants: { resolve: async () => ({ status: 'missing' }) } }), { code: 'GITHUB_AUTHORIZATION_REQUIRED' });
  await assert.rejects(issueAgentRunGrant(input, { ...grantDeps, userGrants: { resolve: async () => ({ status: 'reauth_required' }) } }), { code: 'GITHUB_AUTHORIZATION_REQUIRED' });
  assert.equal(await db('mcp_records').where({ kind: 'grant' }).count('* as count').first().then(row => Number(row!.count)), 0);
});

test('the internal client cannot be used for interactive OAuth', async () => {
  const issued = await issueAgentRunGrant({ ownerId: OWNER, definitionName: 'Nightly triage', runId: 'run-1', phase: 'report', repositories: ['acme/repo'] }, grantDeps);
  assert.ok(issued.grantId);
  const oauth = new McpOAuthProvider(new McpStore(db, config.encryptionKey), config);
  const client = await oauth.clientsStore.getClient(AGENT_RUN_MCP_CLIENT_ID);
  assert.ok(client);
  assert.deepEqual(client.redirect_uris, []);
  await assert.rejects(oauth.authorize(client, { redirectUri: 'http://127.0.0.1:8765/callback', codeChallenge: 'a'.repeat(43), resource: new URL(config.resource), scopes: ['read'] }, {} as never), /redirect_uri/);
});
