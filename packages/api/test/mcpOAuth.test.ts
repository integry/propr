import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createHash, randomBytes } from 'node:crypto';
import knex from 'knex';
import express from 'express';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mcpAuthRouter } from '@modelcontextprotocol/sdk/server/auth/router.js';
import { up } from '../../core/src/db/migrations/20260910220000_add_mcp.js';
import { McpOAuthProvider, validatePublicTokenRequest } from '../mcp/oauth.js';
import { McpStore } from '../mcp/store.js';
import { loadMcpConfig, type McpConfig } from '../mcp/config.js';
import { validateGitHubToken } from '../authBearer.js';

test('ordinary GitHub bearer authentication rejects ProPR tokens before cache or network access', async () => {
  assert.equal(await validateGitHubToken('propr_mcp_fixture'), null);
});

async function fixture() {
  const db = knex({ client: 'better-sqlite3', connection: { filename: ':memory:' }, useNullAsDefault: true });
  await db.schema.createTable('task_drafts', table => { table.string('draft_id').primary(); table.string('name'); });
  await up(db);
  const config: McpConfig = { origin: 'https://instance.example', resource: 'https://instance.example/api/mcp', instanceId: 'instance-123', encryptionKey: randomBytes(32) };
  const store = new McpStore(db, config.encryptionKey);
  const oauth = new McpOAuthProvider(store, config);
  const client = await oauth.clientsStore.registerClient!({ client_name: 'Test client', token_endpoint_auth_method: 'none', redirect_uris: ['http://127.0.0.1:8765/callback'], grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'] });
  const user = { id: '12345', username: 'tester', login: 'tester', displayName: 'Test', email: null, avatarUrl: null, accessToken: 'github-credential-fixture' };
  const verifier = randomBytes(32).toString('base64url');
  const challenge = createHash('sha256').update(verifier).digest('base64url');
  const authorize = async () => {
    let url = '';
    await oauth.authorize(client, { redirectUri: client.redirect_uris[0], codeChallenge: challenge, resource: new URL(config.resource), scopes: ['read', 'plan'], state: 'client-state' }, { redirect(value: string) { url = value; } } as never);
    const pending = new URL(url).searchParams.get('request')!;
    const redirect = new URL(await oauth.approve(pending, user, ['acme/repo'], { membershipSource: 'local' }));
    assert.equal(redirect.searchParams.get('state'), 'client-state');
    assert.equal(redirect.searchParams.get('iss'), `${config.origin}/`);
    return redirect.searchParams.get('code')!;
  };
  const exchange = (code: string) => oauth.exchangeAuthorizationCode(client, code, verifier, client.redirect_uris[0], new URL(config.resource));
  return { db, config, store, oauth, client, user, verifier, challenge, authorize, exchange };
}

test('OAuth codes are single use, PKCE/resource/redirect bound, credentials encrypted and grants durable', async () => {
  const f = await fixture();
  try {
    const code = await f.authorize();
    await assert.rejects(f.oauth.exchangeAuthorizationCode(f.client, code, 'wrong', f.client.redirect_uris[0], new URL(f.config.resource)));
    await assert.rejects(f.oauth.exchangeAuthorizationCode(f.client, code, f.verifier, 'http://127.0.0.1:9999/callback', new URL(f.config.resource)));
    await assert.rejects(f.oauth.exchangeAuthorizationCode(f.client, code, f.verifier, f.client.redirect_uris[0], new URL('https://another.example/api/mcp')));
    const token = await f.exchange(code);
    // Claude may proactively refresh up to five minutes before expiry. The
    // access token must be born outside that window instead of looking stale.
    assert.equal(token.expires_in, 15 * 60);
    await assert.rejects(f.exchange(code));
    const info = await f.oauth.verifyAccessToken(token.access_token);
    assert.deepEqual(info.scopes, ['read', 'plan']);
    const persisted = JSON.stringify(await f.db('mcp_records').select());
    assert.ok(!persisted.includes(token.access_token));
    assert.ok(!persisted.includes(token.refresh_token!));
    assert.ok(!persisted.includes(f.user.accessToken));
    const restarted = new McpOAuthProvider(new McpStore(f.db, f.config.encryptionKey), f.config);
    assert.equal((await restarted.verifyAccessToken(token.access_token)).extra.grantId, info.extra.grantId);
    await restarted.revokeGrant(info.extra.grantId, 'another-owner');
    await restarted.verifyAccessToken(token.access_token);
    await restarted.revokeGrant(info.extra.grantId, f.user.id);
    await assert.rejects(restarted.verifyAccessToken(token.access_token));
    await assert.rejects(restarted.exchangeRefreshToken(f.client, token.refresh_token!, undefined, new URL(f.config.resource)));
  } finally { await f.db.destroy(); }
});

test('refresh rotation rejects escalation and revokes the whole grant on replay including concurrent reuse', async () => {
  const f = await fixture();
  try {
    const initial = await f.exchange(await f.authorize());
    await assert.rejects(f.oauth.exchangeRefreshToken(f.client, initial.refresh_token!, ['merge'], new URL(f.config.resource)));
    const results = await Promise.allSettled([1, 2].map(() => f.oauth.exchangeRefreshToken(f.client, initial.refresh_token!, ['read'], new URL(f.config.resource))));
    assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
    assert.equal(results.filter(result => result.status === 'rejected').length, 1);
    const succeeded = results.find(result => result.status === 'fulfilled') as PromiseFulfilledResult<Awaited<ReturnType<typeof f.exchange>>>;
    await assert.rejects(f.oauth.verifyAccessToken(initial.access_token));
    await assert.rejects(f.oauth.verifyAccessToken(succeeded.value.access_token));
  } finally { await f.db.destroy(); }
});

test('OAuth authorization validates exact redirects, scopes and resource before issuing consent', async () => {
  const f = await fixture();
  try {
    for (const changes of [{ redirectUri: 'http://127.0.0.1:9999/callback' }, { resource: undefined }, { scopes: ['root'] }, { codeChallenge: 'invalid' }]) {
      await assert.rejects(f.oauth.authorize(f.client, { redirectUri: f.client.redirect_uris[0], resource: new URL(f.config.resource), scopes: ['read'], codeChallenge: f.challenge, ...changes }, {} as never));
    }
    await assert.rejects(f.oauth.clientsStore.registerClient!({ redirect_uris: ['https://example.org/callback#fragment'], token_endpoint_auth_method: 'none' }));
    assert.equal(await f.db('mcp_records').where({ kind: 'pending' }).count('* as count').first().then(row => row!.count), 0);
  } finally { await f.db.destroy(); }
});

test('SDK OAuth HTTP router performs a real authorization-code/PKCE exchange and replay rejection', async () => {
  const f = await fixture();
  const app = express();
  app.use('/token', express.urlencoded({ extended: false, limit: '16kb' }), validatePublicTokenRequest);
  app.use(mcpAuthRouter({ provider: f.oauth, issuerUrl: new URL(f.config.origin), resourceServerUrl: new URL(f.config.resource), scopesSupported: ['read', 'plan'] }));
  const server = createServer(app);
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  try {
    const metadata = await fetch(`${base}/.well-known/oauth-protected-resource/api/mcp`).then(response => response.json());
    assert.equal(metadata.resource, f.config.resource);
    const code = await f.authorize();
    const params = new URLSearchParams({ grant_type: 'authorization_code', client_id: f.client.client_id, code, code_verifier: f.verifier, redirect_uri: f.client.redirect_uris[0], resource: f.config.resource });
    for (const extra of [{ client_assertion: 'unsupported.jwt.assertion' }, { client_assertion_type: 'jwt-bearer' }, { scope: 'read merge' }, { client_secret: 'secret' }]) {
      const attempted = new URLSearchParams(params);
      for (const [key, value] of Object.entries(extra)) attempted.set(key, value);
      assert.equal((await fetch(`${base}/token`, { method: 'POST', body: attempted })).status, 400);
    }
    const response = await fetch(`${base}/token`, { method: 'POST', body: params });
    assert.equal(response.status, 200, await response.clone().text());
    const token = await response.json();
    assert.equal((await f.oauth.verifyAccessToken(token.access_token)).clientId, f.client.client_id);
    const replay = await fetch(`${base}/token`, { method: 'POST', body: params });
    assert.equal(replay.status, 400);
  } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); await f.db.destroy(); }
});

test('MCP configuration fails closed without explicit secrets and stable identity', () => {
  assert.equal(loadMcpConfig({}), undefined);
  assert.throws(() => loadMcpConfig({ MCP_ENABLED: 'true' }), /MCP_PUBLIC_ORIGIN/);
  assert.throws(() => loadMcpConfig({ MCP_ENABLED: 'true', MCP_PUBLIC_ORIGIN: 'https://instance.example', MCP_INSTANCE_ID: 'instance-123' }), /MCP_ENCRYPTION_KEY/);
});


test('direct consent selects a bounded subset, rejects malformed selections and never consumes a failed selection', async () => {
  const f = await fixture();
  try {
    let url = '';
    await f.oauth.authorize(f.client, { redirectUri: f.client.redirect_uris[0], codeChallenge: f.challenge,
      resource: new URL(f.config.resource), scopes: ['read', 'plan', 'execute'] }, { redirect(value: string) { url = value; } } as never);
    const pending = new URL(url).searchParams.get('request')!;
    for (const scopes of [[], ['merge'], ['read', 'merge'], ['read', 3], ['read', {}], 'read', null]) {
      await assert.rejects(f.oauth.approve(pending, f.user, ['acme/repo'], { membershipSource: 'local', selectedScopes: scopes }));
    }
    const redirect = new URL(await f.oauth.approve(pending, f.user, ['acme/repo'], { membershipSource: 'local', selectedScopes: ['read', 'plan'] }));
    const tokens = await f.exchange(redirect.searchParams.get('code')!);
    assert.equal(tokens.scope, 'read plan');
    await assert.rejects(f.oauth.exchangeRefreshToken(f.client, tokens.refresh_token!, ['read', 'execute'], new URL(f.config.resource)));
    await assert.rejects(f.oauth.exchangeRefreshToken(f.client, tokens.refresh_token!, [], new URL(f.config.resource)));
    const narrowed = await f.oauth.exchangeRefreshToken(f.client, tokens.refresh_token!, ['read'], new URL(f.config.resource));
    assert.equal(narrowed.scope, 'read');
    await assert.rejects(f.oauth.exchangeRefreshToken(f.client, narrowed.refresh_token!, ['read', 'plan'], new URL(f.config.resource)));
  } finally { await f.db.destroy(); }
});
