import assert from 'node:assert/strict';
import { after, mock, test } from 'node:test';
import { randomBytes } from 'node:crypto';
import { generateKeyPair, exportJWK, SignJWT, decodeJwt, calculateJwkThumbprint } from 'jose';
import knex from 'knex';
import { closeConnection } from '@propr/core';
import { up } from '../../core/src/db/migrations/20260910220000_add_mcp.js';
import { McpStore, digest } from '../mcp/store.js';
import { McpOAuthProvider } from '../mcp/oauth.js';
import { MCP_CONNECT_CONTRACT } from '../mcp/connect.js';
import { McpPolicy } from '../mcp/policy.js';
import { configureDemoMode } from '../demoMode.js';

after(async () => closeConnection());

test('signed hosted delegation enforces issuer/audience/instance, current grant restrictions, membership and separate credentials', async () => {
  configureDemoMode(false);
  const db = knex({ client: 'better-sqlite3', connection: { filename: ':memory:' }, useNullAsDefault: true });
  await db.schema.createTable('task_drafts', table => table.string('draft_id').primary());
  await up(db);
  await db.schema.createTable('instance_members', table => { table.string('github_user_id').primary(); table.string('role'); table.string('source'); });
  await db('instance_members').insert({ github_user_id: '123', role: 'member', source: 'local' });
  const key = await generateKeyPair('ES256');
  const jwk = { ...await exportJWK(key.publicKey), kid: 'fixture-key', alg: 'ES256', use: 'sig' };
  const config = { origin: 'https://instance.example', resource: 'https://instance.example/api/mcp', instanceId: 'instance-1234567890', encryptionKey: randomBytes(32),
    connect: { issuer: 'https://mcp.propr.dev', jwks: 'https://mcp.propr.dev/.well-known/jwks.json', installationId: 456, resource: 'https://mcp.propr.dev/mcp', tunnelId: 'tunnel-1', relayToken: 'prt_fixture' } };
  const store = new McpStore(db, config.encryptionKey);
  const instanceKey = await generateKeyPair('ES256', { extractable: true });
  const privateJwk = await exportJWK(instanceKey.privateKey);
  const thumbprint = await calculateJwkThumbprint(await exportJWK(instanceKey.publicKey));
  await store.put('connect_identity', 'instance', { instanceId: config.instanceId, privateJwk });
  await store.put('connect_registration', 'instance', { instanceId: config.instanceId, issuer: config.connect.issuer, installationId: 456, tunnel_id: 'tunnel-1', key_thumbprint: thumbprint, contract_version: MCP_CONNECT_CONTRACT });
  const oauth = new McpOAuthProvider(store, config);
  const policy = new McpPolicy(oauth, config);
  const originalWhitelist = process.env.GITHUB_USER_WHITELIST;
  process.env.GITHUB_USER_WHITELIST = 'tester';
  let active = true;
  let checks = 0;
  let refreshed = false;
  const relayEnv = { url: process.env.PROPR_GH_RELAY_URL, token: process.env.PROPR_GH_RELAY_TOKEN };
  process.env.PROPR_GH_RELAY_URL = 'https://relay.example/v1';
  process.env.PROPR_GH_RELAY_TOKEN = 'fixture-relay-credential';
  const calls: Array<{ url: string; auth: string | null }> = [];
  const fetchMock = mock.method(globalThis, 'fetch', async (input: string | URL | Request, init?: RequestInit) => {
    const req = new Request(input, init); const url = req.url;
    calls.push({ url, auth: req.headers.get('authorization') });
    if (url === config.connect.jwks) return Response.json({ keys: [jwk] });
    if (url === `${config.connect.issuer}/v1/mcp/delegations/validate`) {
      assert.equal(req.headers.get('authorization'), 'Bearer prt_fixture');
      checks++;
      const body = await req.json();
      assert.equal(decodeJwt(body.instance_assertion).delegation_sha256, digest(body.delegation));
      return Response.json({ active, ...decodeJwt(body.delegation) });
    }
    if (url === 'https://api.github.com/user') {
      assert.equal(req.headers.get('authorization'), `token ${refreshed ? 'fixture-refreshed-github' : 'fixture-github-credential'}`);
      return Response.json({ id: 123, login: 'tester' });
    }
    if (url === 'https://relay.example/v1/auth/instance-grants/refresh') {
      assert.equal(req.headers.get('authorization'), 'Bearer fixture-relay-credential');
      assert.equal(refreshed, false, 'A rotating GitHub credential must only refresh once');
      refreshed = true;
      return Response.json({ access_token: 'fixture-refreshed-github', refresh_token: 'fixture-rotated-refresh', expires_in: 3600 });
    }
    throw new Error(`Unexpected fixture URL ${url}`);
  });
  const issue = (overrides: Record<string, unknown> = {}) => new SignJWT({ grant_id: 'grant-456', instance_id: config.instanceId, installation_id: 456, scopes: ['read'], repositories: ['acme/repo'], contract_version: MCP_CONNECT_CONTRACT, resource: config.connect.resource, instance_key_thumbprint: thumbprint, ...overrides })
    .setProtectedHeader({ alg: 'ES256', kid: 'fixture-key', typ: 'propr-mcp-delegation+jwt' }).setIssuer(config.connect.issuer).setSubject('123').setAudience(`urn:propr:instance:${config.instanceId}:mcp`).setIssuedAt().setExpirationTime('60s').setJti('fixture-jti').sign(key.privateKey);
  try {
    const token = await issue();
    await store.put('credential', '123', { id: '123', username: 'tester', login: 'tester', displayName: 'Test', email: null, avatarUrl: null, accessToken: 'fixture-github-credential' });
    const principal = await policy.authenticate(token);
    assert.deepEqual(principal.scopes, ['read']);
    assert.deepEqual(principal.grant.repositories, ['acme/repo']);
    const before = checks; await policy.authenticate(token); assert.equal(checks, before + 1);
    await assert.rejects(policy.authenticate(await issue({ instance_id: 'wrong-instance' })), /binding/);
    await assert.rejects(policy.authenticate(await issue({ contract_version: 2 })), { code: 'INSTANCE_VERSION_MISMATCH', status: 409 });
    const wrongAudience = await new SignJWT({}).setProtectedHeader({ alg: 'ES256', kid: 'fixture-key' }).setIssuer(config.connect.issuer).setAudience('wrong').setIssuedAt().setExpirationTime('60s').sign(key.privateKey);
    await assert.rejects(policy.authenticate(wrongAudience));
    active = false; await assert.rejects(policy.authenticate(token), /revoked/); active = true;
    process.env.GITHUB_USER_WHITELIST = 'another-user'; await assert.rejects(policy.authenticate(token), /access denied/); process.env.GITHUB_USER_WHITELIST = 'tester';
    assert.ok(calls.every(call => call.auth !== `Bearer ${token}`), 'Delegation must never be forwarded to GitHub or introspection');
    const direct = 'propr_mcp_direct-fixture';
    await store.put('grant', 'direct-grant', { ...principal.grant, id: 'direct-grant', membershipSource: 'local', resource: config.resource });
    await store.put('access', digest(direct), { grantId: 'direct-grant', clientId: 'fixture', scopes: ['read'], expiresAt: Date.now() + 60000 }, { expiresAt: Date.now() + 60000 });
    const beforeDirect = checks;
    await new McpPolicy(oauth, { ...config, connect: undefined }).authenticate(direct);
    assert.equal(checks, beforeDirect, 'Direct OAuth does not require Connect');
    await db('instance_members').where({ github_user_id: '123' }).update({ role: 'admin' });
    assert.ok((await policy.authenticate(direct)).authorization.permissions.includes('instance.manage_settings'));
    await db('instance_members').where({ github_user_id: '123' }).update({ role: 'member' });
    assert.equal((await policy.authenticate(direct)).authorization.permissions.length, 0);
    const credential = await store.get<Record<string, unknown>>('credential', '123');
    await store.put('credential', '123', { ...credential, refreshToken: 'fixture-refresh', tokenExpiresAt: Date.now() - 1000, oauthSource: 'connect' });
    const refreshes = await Promise.allSettled([policy.authenticate(direct), policy.authenticate(direct)]);
    assert.ok(refreshes.some(result => result.status === 'fulfilled'));
    for (const result of refreshes) if (result.status === 'rejected') assert.equal(result.reason.code, 'GITHUB_AUTH_REFRESHING');
    assert.equal(refreshed, true);
    assert.equal((await policy.authenticate(direct)).user.accessToken, 'fixture-refreshed-github');
    await db('instance_members').where({ github_user_id: '123' }).delete();
    await assert.rejects(policy.authenticate(direct), /membership was revoked/);
  } finally {
    fetchMock.mock.restore();
    if (originalWhitelist === undefined) delete process.env.GITHUB_USER_WHITELIST; else process.env.GITHUB_USER_WHITELIST = originalWhitelist;
    if (relayEnv.url === undefined) delete process.env.PROPR_GH_RELAY_URL; else process.env.PROPR_GH_RELAY_URL = relayEnv.url;
    if (relayEnv.token === undefined) delete process.env.PROPR_GH_RELAY_TOKEN; else process.env.PROPR_GH_RELAY_TOKEN = relayEnv.token;
    await db.destroy();
  }
});
