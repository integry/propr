import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { randomBytes } from 'node:crypto';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import express from 'express';
import { generateKeyPair, exportJWK, decodeJwt, SignJWT } from 'jose';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { Client as LegacyClient } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport as LegacyTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { db, closeConnection } from '@propr/core';
import { up as initial } from '../../core/src/db/migrations/20251216000000_initial_sqlite_schema.js';
import { up as planIssues } from '../../core/src/db/migrations/20260120000000_add_plan_issues.js';
import { up as configs } from '../../core/src/db/migrations/20251217000000_add_system_configs.js';
import { up as members } from '../../core/src/db/migrations/20260730000000_create_instance_members.js';
import { up as migration } from '../../core/src/db/migrations/20260910220000_add_mcp.js';
import { loadMcpConfig, MCP_SCOPES } from '../mcp/config.js';
import { McpConnect, registerMcpInstance, MCP_CONNECT_CONTRACT, type InstanceIdentity } from '../mcp/connect.js';
import { McpStore, digest } from '../mcp/store.js';
import { McpPolicy } from '../mcp/policy.js';
import { McpOAuthProvider } from '../mcp/oauth.js';
import { mountMcp, mcpResponseHeaders } from '../mcp/server.js';
import type { GitHubUser } from '../authTypes.js';
import { configureDemoMode } from '../demoMode.js';
import { routingDatabase } from './fixtures/routingD1.js';

after(closeConnection);
interface ToolOutput { data: { resource: string; state: string; result: { planId: string }; operationId: string } }

test('pinned actual Connect Worker -> actual core registration, OAuth, SDK eras, persistence, credentials and revocation', { timeout: 120000, skip: !process.env.MCP_ROUTING_BUNDLE && 'Run npm run test:mcp:connect with MCP_ROUTING_REPOSITORY' }, async () => {
  assert.ok(process.env.MCP_ROUTING_BUNDLE, 'Run npm run test:mcp:connect');
  const worker = createRequire(import.meta.url)(process.env.MCP_ROUTING_BUNDLE!).default;
  const routing = routingDatabase(await readFile(`${process.env.MCP_ROUTING_FIXTURE}/schema.sql`, 'utf8'));
  const relay = `prt_${'a'.repeat(43)}`;
  const pair = await generateKeyPair('ES256', { extractable: true });
  const signingJwk = { ...await exportJWK(pair.privateKey), kid: 'gateway-a' };
  const env = { DB: routing, MCP_SIGNING_JWK: JSON.stringify(signingJwk), INSTANCE_AUTH_ENCRYPTION_KEY: randomBytes(32).toString('base64url') };
  const pendingWork: Promise<unknown>[] = [];
  const gateway = (request: Request): Promise<Response> => worker.fetch(request, env, { waitUntil(p: Promise<unknown>) { pendingWork.push(p); } });
  const origin = 'https://mcp.propr.dev';
  const resource = `${origin}/mcp`;
  const api = (path: string, method = 'GET', body?: unknown, token?: string) => gateway(new Request(`${origin}${path}`, {
    method, headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
    body: body === undefined ? undefined : JSON.stringify(body)
  }));
  await routing.prepare(`INSERT INTO installations (installation_id, github_account_id, github_account_login, github_account_type,
    default_github_user_id, polar_subscription_status) VALUES (1, 99, 'acme', 'Organization', '99', 'active')`).run();
  await routing.prepare(`INSERT INTO installation_members (installation_id, github_user_id, github_username,
    added_by_github_user_id, added_by_github_username) VALUES (1, '777', 'member', '99', 'owner')`).run();
  await routing.prepare(`INSERT INTO ui_tunnels (tunnel_id, installation_id, cf_tunnel_id, hostname, tunnel_url)
    VALUES ('tunnel-1', 1, 'cf-1', 't-fixture.propr.dev', 'https://t-fixture.propr.dev')`).run();
  await routing.prepare(`INSERT INTO relay_tokens (token_id, token_sha256, token_prefix, installation_id, github_username, label)
    VALUES ('relay-1', ?, 'prt_aaa', 1, 'owner', 'fixture')`).bind(digest(relay)).run();
  configureDemoMode(false);
  Object.assign(process.env, { MCP_ENABLED: 'true', MCP_PUBLIC_ORIGIN: 'https://t-fixture.propr.dev',
    MCP_INSTANCE_ID: '12345678-1234-4321-abcd-123456789012', MCP_ENCRYPTION_KEY: randomBytes(32).toString('base64'),
    MCP_CONNECT_TRUST: 'true', MCP_CONNECT_ISSUER: origin, PROPR_ADMIN_USERS: '', GH_INSTALLATION_ID: '1', PROPR_GH_RELAY_TOKEN: relay,
    PROPR_GH_RELAY_URL: `${origin}/v1`, PROPR_INSTANCE_ID: 'tunnel-1', PROPR_UI_TUNNEL_ENABLED: 'true',
    PROPR_UI_TUNNEL_TOKEN: 'fixture-connector-only', GITHUB_USER_WHITELIST: 'member' });
  await initial(db); await planIssues(db); await migration(db);
  await db.schema.alterTable('task_drafts', table => table.boolean('paused').defaultTo(false));
  await members(db);
  await db('instance_members').insert({ github_user_id: '777', github_username: 'member', role: 'member', source: 'local' });
  await configs(db);
  await db('system_configs').insert({ key: 'repos_to_monitor', value: JSON.stringify([{ id: 'repo-1', name: 'acme/allowed', enabled: true }, { id: 'repo-2', name: 'acme/restricted', enabled: true }]) });
  delete process.env.MCP_CONNECT_TUNNEL_ID;
  const config = loadMcpConfig()!;
  assert.equal(config.connect!.tunnelId, 'tunnel-1', 'Reuse the existing tunnel setup identifier');
  const store = new McpStore(db, config.encryptionKey);
  const proof = new McpConnect(config, store);
  const policy = new McpPolicy(new McpOAuthProvider(store, config), config);
  const app = express(); app.use('/api/mcp', mcpResponseHeaders); app.use(express.json());
  mountMcp(app, { db, taskQueue: {} as never, redisClient: {} as never, runtimeBuildQueue: {} as never });
  const server = createServer(app);
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const local = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const nativeFetch = globalThis.fetch;
  const upstream: Request[] = [];
  const repositoryRequests: string[] = [];
  const repositoryUrl = 'https://api.github.com/user/installations/1/repositories?per_page=100&page=1';
  const instancePosts: Array<{ path: string; body: Record<string, string> }> = [];
  const wire: string[] = [];
  let offline = false;
  let onlineUnavailable = false;
  let onlineResponse: 'normal' | 'malformed' | 'mismatched' = 'normal';
  let githubExpired = false;
  function githubResponse(request: Request, url: URL): Response {
    assert.ok(request.headers.get('authorization')?.includes('github-member'), 'Only a GitHub credential can reach GitHub');
    if (githubExpired && request.headers.get('authorization')?.includes('github-member-expired')) return Response.json({ message: 'Expired' }, { status: 401 });
    if (url.pathname === '/user') return Response.json({ id: 777, login: 'member', avatar_url: null });
    if (url.pathname.endsWith('/repositories')) {
      repositoryRequests.push(request.url);
      assert.equal(request.method, 'GET');
      assert.equal(request.headers.get('authorization'), 'Bearer github-member', 'Discovery must use the consenting user credential');
      assert.equal(request.url, repositoryUrl, 'Discovery must use the exact user-authorized installation path and pagination');
      return Response.json({ total_count: 1, repositories: [{ id: 1, full_name: 'acme/allowed' }] });
    }
    if (url.pathname === '/repos/acme/allowed') return Response.json({ permissions: { push: true } });
    return Response.json({ message: 'Not found' }, { status: 404 });
  }
  globalThis.fetch = async (input, init) => {
    const request = new Request(input, init);
    const url = new URL(request.url);
    if (url.origin === origin) {
      if (url.pathname === '/v1/mcp/delegations/validate' && onlineUnavailable) throw new Error('isolated outage');
      if (url.pathname.startsWith('/v1/') && request.method === 'POST') {
        assert.equal(request.headers.get('authorization'), `Bearer ${relay}`);
        instancePosts.push({ path: url.pathname, body: await request.clone().json() });
      }
      const response = await gateway(request);
      if (url.pathname === '/v1/mcp/delegations/validate' && response.ok && onlineResponse !== 'normal') {
        if (onlineResponse === 'malformed') return new Response('not-json', { headers: { 'content-type': 'application/json' } });
        return Response.json({ ...await response.json(), installation_id: 2 });
      }
      return response;
    }
    if (url.hostname === 't-fixture.propr.dev') {
      if (offline) throw new Error('isolated tunnel outage');
      upstream.push(request.clone());
      if (request.method === 'POST') wire.push((await request.clone().json()).method);
      wire.push(request.headers.get('mcp-protocol-version') || '');
      const response = await nativeFetch(`${local}${url.pathname}`, { method: request.method, headers: request.headers,
        body: request.body ? await request.arrayBuffer() : undefined, redirect: 'manual' });
      assert.equal(response.headers.get('x-propr-mcp-contract'), MCP_CONNECT_CONTRACT);
      return response;
    }
    if (url.hostname === 'api.github.com') {
      return githubResponse(request, url);
    }
    throw new Error(`External network forbidden: ${url.origin}`);
  };
  const jsonOk = async (response: Response, status = 200) => {
    const body = await response.json(); assert.equal(response.status, status, JSON.stringify(body)); return body;
  };
  async function consent(selectedScopes = ['read', 'plan'], verifyFailure = false): Promise<{ access_token: string; refresh_token: string; client_id: string }> {
    const registration = await jsonOk(await api('/oauth/register', 'POST', { client_name: 'Integration client',
      redirect_uris: ['http://127.0.0.1:3344/callback'], token_endpoint_auth_method: 'none' }), 201);
    const verifier = 'v'.repeat(64);
    const challenge = Buffer.from(digest(verifier), 'hex').toString('base64url');
    const parameters = new URLSearchParams({ client_id: registration.client_id, redirect_uri: registration.redirect_uris[0],
      response_type: 'code', resource, scope: MCP_SCOPES.join(' '), code_challenge: challenge, code_challenge_method: 'S256', state: 'test-state' });
    const started = await api(`/oauth/authorize?${parameters}`);
    assert.equal(started.status, 302);
    const requestId = new URL(started.headers.get('location')!).searchParams.get('request');
    const details = await jsonOk(await api(`/v1/mcp/consent?request=${requestId}`, 'GET', undefined, 'github-member'));
    assert.deepEqual(details.scopes, MCP_SCOPES);
    const beforeDiscovery = repositoryRequests.length;
    const discovery = await api(`/v1/mcp/consent/repositories?request=${requestId}&installation_id=1`, 'GET', undefined, 'github-member');
    const legacyRouting = discovery.status === 404;
    if (legacyRouting) {
      // Only the known merged routing pin predates repository discovery. A
      // missing endpoint on a newer candidate must fail the paired test.
      const report = JSON.parse(await readFile(`${process.env.MCP_ROUTING_FIXTURE}/commits.json`, 'utf8'));
      assert.equal(report.routingHead, '1fcf82fd1a843fbdf199d79b8f92843dc74a89e0');
      assert.equal((await jsonOk(discovery, 404)).error, 'not_found');
      assert.equal(repositoryRequests.length, beforeDiscovery);
    } else {
      const discovered = await jsonOk(discovery);
      assert.deepEqual(discovered.repositories, ['acme/allowed']);
      assert.equal(discovered.complete, true);
      assert.deepEqual(repositoryRequests.slice(beforeDiscovery), [repositoryUrl]);
    }
    const approved = await jsonOk(await api('/v1/mcp/consent', 'POST', { request_id: requestId, approve: true,
      installation_id: 1, scopes: selectedScopes, repositories: ['acme/allowed'] }, 'github-member'));
    if (!legacyRouting) {
      assert.deepEqual(repositoryRequests.slice(beforeDiscovery), [repositoryUrl, repositoryUrl], 'Consent must recheck user-authorized repositories');
    }
    const code = new URL(approved.redirect_url).searchParams.get('code')!;
    const exchange = (verifierValue: string) => gateway(new Request(`${origin}/oauth/token`, { method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ grant_type: 'authorization_code',
        client_id: registration.client_id, redirect_uri: registration.redirect_uris[0], resource, code, code_verifier: verifierValue }) }));
    if (verifyFailure) {
      assert.equal((await exchange('wrong'.repeat(12))).status, 400);
      return consent(selectedScopes); // Routing consumes rejected PKCE codes; start a new authorization.
    }
    const tokens = await jsonOk(await exchange(verifier));
    assert.equal(tokens.scope, selectedScopes.join(' '));
    assert.equal((await exchange(verifier)).status, 400);
    assert.ok(!JSON.stringify(tokens).includes('github-member'));
    return { ...tokens, client_id: registration.client_id } as { access_token: string; refresh_token: string; client_id: string };
  }
  try {
    assert.equal((await api('/mcp')).status, 401);
    assert.deepEqual((await jsonOk(await api('/.well-known/oauth-protected-resource/mcp'))).scopes_supported, MCP_SCOPES);
    assert.deepEqual((await jsonOk(await api('/.well-known/oauth-authorization-server'))).token_endpoint_auth_methods_supported, ['none']);
    const badJson = await nativeFetch(`${local}/api/mcp`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{' });
    assert.equal(badJson.status, 400); assert.equal(badJson.headers.get('x-propr-mcp-contract'), MCP_CONNECT_CONTRACT);
    await registerMcpInstance(config, store);
    const identity = await proof.identity();
    await registerMcpInstance(config, new McpStore(db, config.encryptionKey));
    assert.equal((await new McpConnect(config, store).identity()).thumbprint, identity.thumbprint);
    assert.ok(!JSON.stringify(await db('mcp_records').select()).includes(identity.privateJwk.d!));
    await assert.rejects(new McpConnect({ ...config, connect: { ...config.connect!, tunnelId: 'unregistered-tunnel' } }, store).register(), { code: 'ACCESS_REVOKED' });
    const firstRegistration = instancePosts.find(item => item.path.endsWith('/register'))!;
    assert.equal((await api(firstRegistration.path, 'POST', firstRegistration.body, relay)).status, 401, 'Assertions are one-use');
    assert.equal((await api(firstRegistration.path, 'POST', firstRegistration.body, `prt_${'b'.repeat(43)}`)).status, 401);
    const tokens = await consent(['read', 'plan'], true);
    const transportOptions = { requestInit: { headers: { authorization: `Bearer ${tokens.access_token}` } }, fetch: globalThis.fetch };
    const planIds: string[] = [];
    for (const modern of [true, false]) {
      const client = modern ? new Client({ name: 'integration-modern', version: '1' }, { versionNegotiation: { mode: { pin: '2026-07-28' } } })
        : new LegacyClient({ name: 'integration-legacy', version: '1' });
      const transport = modern ? new StreamableHTTPClientTransport(new URL(resource), transportOptions) : new LegacyTransport(new URL(resource), transportOptions);
      await client.connect(transport as never);
      try {
        assert.ok((await client.listTools()).tools.some(tool => tool.name === 'create_plan'));
        assert.ok(!(await client.listTools()).tools.some(tool => tool.name === 'merge_pull_request'));
        assert.equal((await client.listResources()).resources.length, 6);
        assert.equal((await client.getPrompt({ name: 'plan_change', arguments: { request: 'Improve reliability' } })).messages.length, 1);
        const connection = await client.callTool({ name: 'get_connection', arguments: {} });
        assert.equal((connection.structuredContent as ToolOutput).data.resource, resource);
        const args = { repository: 'acme/allowed', name: `Draft ${modern}`, prompt: 'Improve reliability', idempotencyKey: `connect-draft-${modern}` };
        const created = await client.callTool({ name: 'create_plan', arguments: args });
        assert.notEqual(created.isError, true, JSON.stringify(created));
        const data = (created.structuredContent as ToolOutput).data;
        assert.equal(data.state, 'completed');
        planIds.push(data.result.planId);
        const duplicate = await client.callTool({ name: 'create_plan', arguments: args });
        assert.equal((duplicate.structuredContent as ToolOutput).data.operationId, data.operationId);
        assert.equal((await db('task_drafts').where({ draft_id: data.result.planId }).first()).name, args.name);
        assert.equal((await client.readResource({ uri: `propr://instances/${config.instanceId}/plans/${data.result.planId}` })).contents.length, 1);
        const forbidden = await client.callTool({ name: 'create_plan', arguments: { ...args, repository: 'acme/restricted', idempotencyKey: `forbidden-${modern}` } });
        assert.equal(forbidden.isError, true);
        const before = instancePosts.filter(p => p.path.endsWith('/validate')).length;
        await client.listPrompts();
        assert.equal(instancePosts.filter(p => p.path.endsWith('/validate')).length, before + 1);
      } finally { await client.close(); }
    }
    assert.ok(wire.includes('2026-07-28')); assert.ok(wire.includes('2025-11-25'));
    assert.ok(wire.includes('server/discover')); assert.ok(wire.includes('initialize'));
    assert.equal((await db('task_drafts').count('* as count').first())!.count, 2);
    // Reopen the actual SQLite file through a second connection: persisted core mutation.
    const knex = (await import('knex')).default;
    const reopened = knex(db.client.config);
    assert.equal((await reopened('task_drafts').whereIn('draft_id', planIds).select()).length, 2);
    await reopened.destroy();
    const delegated = upstream.at(-1)!.headers.get('authorization')!.slice(7);
    const claims = decodeJwt(delegated);
    assert.equal(claims.aud, `urn:propr:instance:${config.instanceId}:mcp`);
    assert.equal(claims.installation_id, 1);
    assert.deepEqual(claims.scopes, ['read', 'plan']);
    assert.deepEqual(claims.repositories, ['acme/allowed']);
    const credentialCalls = instancePosts.filter(p => p.path.includes('credentials') || p.path.endsWith('/redeem'));
    assert.deepEqual(credentialCalls.map(p => p.path), ['/v1/mcp/credentials', '/v1/auth/instance-grants/redeem']);
    assert.notEqual(credentialCalls[0].body.instance_assertion, credentialCalls[1].body.instance_assertion);
    for (const call of credentialCalls) {
      const assertion = decodeJwt(call.body.instance_assertion);
      assert.equal(assertion.delegation_sha256, digest(call.body.delegation));
      assert.equal(assertion.aud, `${origin}${call.path}`);
    }
    assert.equal((await store.get<GitHubUser>('credential', '777'))!.accessToken, 'github-member');
    assert.ok(!JSON.stringify(await db('mcp_records').select()).includes('github-member'));
    assert.equal((await api('/v1/auth/instance-grants/redeem', 'POST', { code: credentialCalls[1].body.code, delegation: credentialCalls[1].body.delegation,
      instance_assertion: await proof.assertion('/v1/auth/instance-grants/redeem', { delegation_sha256: digest(credentialCalls[1].body.delegation) }) }, relay)).status, 401);
    await assert.rejects(policy.authenticate(delegated, 'https://wrong.example/mcp'), { code: 'INVALID_DELEGATION' });
    const sign = (changes: Record<string, unknown>) => new SignJWT({ ...claims, ...changes })
      .setProtectedHeader({ alg: 'ES256', kid: signingJwk.kid, typ: 'propr-mcp-delegation+jwt' }).sign(pair.privateKey);
    for (const changes of [{ instance_id: 'wrong-instance-id' }, { installation_id: 2 }, { instance_key_thumbprint: 'wrong' }, { repositories: ['acme/restricted'] }, { scopes: ['read', 'merge'] }]) {
      await assert.rejects(policy.authenticate(await sign(changes)));
    }
    await assert.rejects(policy.authenticate(await sign({ contract_version: 'propr-connect-mcp/2' })), { code: 'INSTANCE_VERSION_MISMATCH' });
    const realIdentity = await store.get<InstanceIdentity>('connect_identity', 'instance');
    const wrongPair = await generateKeyPair('ES256', { extractable: true });
    await store.put('connect_identity', 'instance', { instanceId: config.instanceId, privateJwk: await exportJWK(wrongPair.privateKey) });
    await assert.rejects(policy.authenticate(delegated), { code: 'CONNECT_SETUP_REQUIRED' });
    await store.put('connect_identity', 'instance', realIdentity);
    const wrongAssertion = await new SignJWT({ installation_id: 1, delegation_sha256: digest(delegated) })
      .setProtectedHeader({ alg: 'ES256', typ: 'propr-instance-assertion+jwt' }).setIssuer(`urn:propr:instance:${config.instanceId}:mcp`)
      .setSubject(config.instanceId).setAudience(`${origin}/v1/mcp/delegations/validate`).setIssuedAt().setExpirationTime('60s').setJti('wrong-key')
      .sign(wrongPair.privateKey);
    assert.equal((await api('/v1/mcp/delegations/validate', 'POST', { delegation: delegated, instance_assertion: wrongAssertion }, relay)).status, 401);
    const goodAssertion = await proof.assertion('/v1/mcp/delegations/validate', { delegation_sha256: digest(delegated) });
    assert.equal((await api('/v1/mcp/delegations/validate', 'POST', { delegation: await sign({ jti: 'another-jti' }), instance_assertion: goodAssertion }, relay)).status, 401);
    onlineResponse = 'malformed';
    await assert.rejects(policy.authenticate(delegated), { code: 'CONNECT_UNAVAILABLE' });
    onlineResponse = 'mismatched';
    await assert.rejects(policy.authenticate(delegated), { code: 'ACCESS_REVOKED' });
    onlineResponse = 'normal';
    // A browser renewal can recover a stored GitHub token with no expiry metadata.
    const credential = await store.get<GitHubUser>('credential', '777');
    await store.put('credential', '777', { ...credential, accessToken: 'github-member-expired' });
    githubExpired = true;
    assert.equal((await policy.authenticate(delegated)).user.accessToken, 'github-member');
    onlineUnavailable = true;
    await assert.rejects(policy.authenticate(delegated), { code: 'CONNECT_UNAVAILABLE' });
    onlineUnavailable = false;
    const publicRequest = () => api('/mcp', 'GET', undefined, tokens.access_token);
    offline = true;
    assert.equal((await jsonOk(await publicRequest(), 503)).error, 'mcp_tunnel_offline');
    offline = false;
    const version = await gateway(new Request(resource, { headers: { authorization: `Bearer ${tokens.access_token}`, 'mcp-protocol-version': '1900-01-01' } }));
    assert.equal((await jsonOk(version, 409)).error, 'mcp_version_mismatch');
    await db('instance_members').where({ github_user_id: '777' }).delete();
    await assert.rejects(policy.authenticate(delegated), /membership was revoked/);
    await db('instance_members').insert({ github_user_id: '777', github_username: 'member', role: 'member', source: 'local' });
    await routing.prepare("DELETE FROM installation_members WHERE github_user_id = '777'").run();
    assert.equal((await publicRequest()).status, 401);
    await assert.rejects(policy.authenticate(delegated), { code: 'ACCESS_REVOKED' });
    await routing.prepare(`INSERT INTO installation_members (installation_id, github_user_id, github_username, added_by_github_user_id, added_by_github_username)
      VALUES (1, '777', 'member', '99', 'owner')`).run();
    assert.equal((await publicRequest()).status, 401, 'Restoring membership must not revive grants');
    const renewed = await consent(['read']);
    const renewedResponse = await api('/mcp', 'GET', undefined, renewed.access_token);
    await renewedResponse.body?.cancel();
    const renewedDelegation = upstream.at(-1)!.headers.get('authorization')!.slice(7);
    const readOnlyPrincipal = await policy.authenticate(renewedDelegation);
    assert.deepEqual(readOnlyPrincipal.scopes, ['read']);
    assert.throws(() => policy.requireScope(readOnlyPrincipal, 'plan'), { code: 'INSUFFICIENT_SCOPE' });
    await jsonOk(await api('/v1/mcp/apps', 'POST', { grant_id: (await routing.prepare('SELECT grant_id FROM mcp_tokens WHERE token_hash = ?').bind(digest(renewed.access_token)).first()).grant_id, revoke: true }, 'github-member'));
    assert.equal((await api('/mcp', 'GET', undefined, renewed.access_token)).status, 401);
    await assert.rejects(policy.authenticate(renewedDelegation), { code: 'ACCESS_REVOKED' });
    // Use the published revocation endpoint as well; repeat revocation is harmless.
    await jsonOk(await gateway(new Request(`${origin}/oauth/revoke`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ token: renewed.access_token, client_id: renewed.client_id }) })));
    const finalGrant = await routing.prepare('SELECT g.* FROM mcp_grants g JOIN mcp_tokens t ON t.grant_id=g.grant_id WHERE t.token_hash=?').bind(digest(renewed.access_token)).first();
    assert.notEqual(finalGrant.revoked_at, null);
    const tunnelGrant = await consent();
    await routing.prepare(`UPDATE ui_tunnels SET deleted_at=datetime('now') WHERE tunnel_id='tunnel-1'`).run();
    assert.equal((await api('/mcp', 'GET', undefined, tunnelGrant.access_token)).status, 401);
    await routing.prepare(`UPDATE ui_tunnels SET deleted_at=NULL WHERE tunnel_id='tunnel-1'`).run();
    assert.equal((await api('/mcp', 'GET', undefined, tunnelGrant.access_token)).status, 401);
    const keyGrant = await consent();
    await store.put('connect_identity', 'instance', { instanceId: config.instanceId, privateJwk: await exportJWK(wrongPair.privateKey) });
    await proof.register();
    assert.equal((await api('/mcp', 'GET', undefined, keyGrant.access_token)).status, 401);
    await store.put('connect_identity', 'instance', realIdentity);
    await proof.register();
    assert.equal((await api('/mcp', 'GET', undefined, keyGrant.access_token)).status, 401, 'Restoring an old key must not revive grants');
    const allAssertions = instancePosts.map(post => decodeJwt(post.body.instance_assertion));
    assert.equal(new Set(allAssertions.map(claim => claim.jti)).size, allAssertions.length, 'Every core POST uses a new proof');
    console.log('PASS: real registration, discovery/PKCE/consent, modern+legacy calls, SQLite mutation/deduplication, encrypted proof-bound credential handoff, key/instance/repository/scope/hash restrictions, local and Connect membership removal, revocation, offline/version denials');
  } finally {
    globalThis.fetch = nativeFetch;
    server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve()));
    await Promise.allSettled(pendingWork); routing.close();
  }
});
