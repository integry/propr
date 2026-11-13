import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { extensionTestResources } from './helpers/extensionTestResources.js';
import type { ExtensionLibraryServerInput } from '@propr/shared';
import { ExtensionLibraryStore, type ExtensionLaunchContext } from '../src/extensions/extensionProfileStore.js';
import { ExtensionOAuthStore, setExtensionOAuth, type ExtensionOAuthOptions } from '../src/extensions/extensionOAuthStore.js';
import { extensionGatewayCall } from '../src/extensions/mcpGateway.js';
import { createOAuthHttpsTransport, oauthRequest, type OAuthHttpRequest, type OAuthHttpResponse, type OAuthTransport } from '../src/extensions/extensionOAuthHttp.js';
import { discoverOAuth, parseBearerChallenge, requestTokens } from '../src/extensions/extensionOAuth.js';
import { up } from '../src/db/migrations/20261013210000_extension_profiles.js';
import { up as grantMigration } from '../src/db/migrations/20261013220000_extension_grant_network.js';
import { up as libraryMigration } from '../src/db/migrations/20261113000000_extension_library.js';
import { up as oauthMigration } from '../src/db/migrations/20261113120000_extension_oauth.js';
import logger from '../src/utils/logger.js';
import { OAUTH_ISSUER, OAUTH_MCP_URL, OAUTH_URLS, PREREGISTERED_CLIENT, syntheticOAuthProvider, type SyntheticOAuthOptions } from '../../../test/fixtures/extensionOAuthFixture.js';

const oauthServer = (extra: Partial<ExtensionLibraryServerInput> = {}): ExtensionLibraryServerInput => ({ kind: 'https', name: 'docs', url: OAUTH_MCP_URL, enabled: true, tools: ['lookup'], capability: 'read', authentication: 'oauth', repositories: [], agents: [], autoApply: true, ...extra } as ExtensionLibraryServerInput);
const context: ExtensionLaunchContext = { agentAlias: 'claude-main', runtime: 'claude', repositories: ['team/repo'], allowWrite: false };

async function fixture(t: TestContext, provider: SyntheticOAuthOptions = { advertise: { dynamic: true } }, options: Partial<ExtensionOAuthOptions> = {}) {
  const database = extensionTestResources(t).database();
  await database.schema.createTable('config', c => { c.string('key').primary(); c.text('value'); });
  await database.schema.createTable('instance_members', c => { c.string('github_user_id').primary(); c.string('role'); });
  await database.schema.createTable('agent_definitions', c => { c.string('id').primary(); c.string('name'); });
  await database('instance_members').insert([{ github_user_id: '1', role: 'admin' }, { github_user_id: '2', role: 'member' }, { github_user_id: '3', role: 'admin' }]);
  await up(database); await grantMigration(database); await libraryMigration(database); await oauthMigration(database);
  let clock = Date.now();
  const synthetic = syntheticOAuthProvider({ now: () => clock, ...provider });
  const store = new ExtensionLibraryStore(database, { SYSTEM_TASK_SECRET: 'synthetic-oauth-custody-root' });
  const notifications: { serverName: string }[] = [];
  const oauth = new ExtensionOAuthStore(store, { transport: synthetic.transport, now: () => clock, notify: async event => { notifications.push(event); }, retryDelayMs: 1, ...options });
  setExtensionOAuth(store, oauth);
  const save = async (servers: ExtensionLibraryServerInput[], secrets: Record<string, string | null> = {}) => store.saveLibrary('1', { version: 1, servers, skills: [] }, secrets, (await store.readLibrary('1')).revision);
  /** Start in session-a as administrator 1, consent at the provider, and return the callback parameters. */
  const consent = async (override: Parameters<typeof synthetic.authorize>[1] = {}, session = 'session-a', actor = '1') => {
    const { authorizationUrl } = await oauth.startSignIn(actor, session, 'docs', OAUTH_URLS);
    return { authorizationUrl, params: synthetic.authorize(authorizationUrl, override) };
  };
  const connect = async () => { const { params } = await consent(); return oauth.completeSignIn('1', 'session-a', params); };
  const launch = async (taskId = 'task-1') => {
    const prepared = await store.resolveLaunch(context, false);
    const token = await store.createGrant(prepared, taskId);
    await store.activateGrant(token, prepared, context);
    return { prepared, token };
  };
  const call = (token: string, id = 1) => extensionGatewayCall(store, token, 'docs', { jsonrpc: '2.0', id, method: 'tools/call', params: { name: 'lookup', arguments: {} } }, synthetic.send);
  const connectionRows = () => database('extension_oauth_connections').select();
  return { database, store, oauth, synthetic, notifications, save, consent, connect, launch, call, connectionRows, tick: (ms: number) => { clock += ms; }, now: () => clock };
}

test('discovery follows the 401 challenge and falls back to the well-known location, and Check stores nothing', async t => {
  for (const discovery of ['challenge', 'well_known'] as const) {
    const f = await fixture(t, { discovery, advertise: { metadataDocument: true, dynamic: true } });
    const check = await f.oauth.check('1', { url: OAUTH_MCP_URL }, OAUTH_URLS);
    assert.equal(check.authorizationRequired, true);
    assert.equal(check.discoveredFrom, discovery);
    assert.equal(check.issuer, OAUTH_ISSUER);
    assert.equal(check.registration, 'metadata_document');
    assert.deepEqual(check.scopes, ['docs.read']);
    assert.equal(check.redirectUri, OAUTH_URLS.redirectUri);
    // Without a public base URL a metadata document cannot be served: registration falls back.
    assert.equal((await f.oauth.check('1', { url: OAUTH_MCP_URL }, { redirectUri: null, clientMetadataUrl: null })).registration, 'dynamic');
    assert.equal((await f.oauth.check('1', { url: OAUTH_MCP_URL, clientId: 'console-client' }, OAUTH_URLS)).registration, 'preregistered');
    assert.equal((await f.connectionRows()).length, 0);
    assert.equal((await f.database('extension_oauth_pending').select()).length, 0);
    assert.equal(f.synthetic.state.registrations, 0);
    await assert.rejects(f.oauth.check('2', { url: OAUTH_MCP_URL }, OAUTH_URLS), /administrator/);
  }
  const none = await fixture(t, { advertise: {} });
  const check = await none.oauth.check('1', { url: OAUTH_MCP_URL }, OAUTH_URLS);
  assert.equal(check.registration, null);
  assert.match(check.message, /developer console.*Bearer token/);
  assert.deepEqual(parseBearerChallenge('Bearer error="invalid_token", resource_metadata="https://x.example/.well-known/oauth-protected-resource", scope="a b"'), { resourceMetadata: 'https://x.example/.well-known/oauth-protected-resource', scope: 'a b' });
});

test('each registration method completes a sign-in, and a run uses the connection through the gateway', async t => {
  const cases = [
    { provider: { advertise: { metadataDocument: true, dynamic: true } }, server: oauthServer(), registration: 'metadata_document', secrets: {} },
    { provider: { advertise: { dynamic: true } }, server: oauthServer({ scopes: ['docs.read', 'docs.write'] }), registration: 'dynamic', secrets: {} },
    { provider: { advertise: {} }, server: oauthServer({ clientId: PREREGISTERED_CLIENT.id }), registration: 'preregistered', secrets: { docs: PREREGISTERED_CLIENT.secret } },
  ] as const;
  for (const item of cases) {
    const f = await fixture(t, item.provider);
    const saved = await f.save([item.server], { ...item.secrets });
    assert.deepEqual(saved.secrets.docs, item.registration === 'preregistered' ? { fields: ['clientSecret'], configured: true } : undefined);
    // Not connected: the auto-applied server is skipped with the reason, the run proceeds without it.
    const before = await f.store.resolveLaunch(context, false);
    assert.deepEqual(before.set.servers, []);
    assert.deepEqual(before.set.skipped, [{ kind: 'server', name: 'docs', reason: 'oauth_not_connected', source: 'auto' }]);
    const explicit = await f.store.resolveLaunch({ ...context, autoApply: false, additional: { servers: ['docs'], skills: [] } }, false);
    assert.deepEqual(explicit.set.skipped, [{ kind: 'server', name: 'docs', reason: 'oauth_not_connected', source: 'additional' }]);
    const { authorizationUrl, params } = await f.consent();
    const url = new URL(authorizationUrl);
    assert.equal(url.searchParams.get('code_challenge_method'), 'S256');
    assert.equal(url.searchParams.get('resource'), OAUTH_MCP_URL);
    assert.equal(url.searchParams.get('redirect_uri'), OAUTH_URLS.redirectUri);
    if (item.registration === 'metadata_document') assert.equal(url.searchParams.get('client_id'), OAUTH_URLS.clientMetadataUrl);
    if (item.registration === 'preregistered') assert.equal(url.searchParams.get('client_id'), PREREGISTERED_CLIENT.id);
    if (item.registration === 'dynamic') assert.equal(url.searchParams.get('scope'), 'docs.read docs.write');
    assert.deepEqual(await f.oauth.completeSignIn('1', 'session-a', params), { name: 'docs' });
    const statuses = await f.oauth.statuses(saved.instanceId, saved.servers);
    assert.equal(statuses.docs.state, 'connected');
    assert.equal(statuses.docs.registration, item.registration);
    assert.equal(statuses.docs.connectedBy, '1');
    // Connecting is credential state, not configuration: no new revision.
    assert.equal((await f.store.readLibrary('1')).revision, saved.revision);
    assert.deepEqual((await f.oauth.audit('1')).map(e => [e.server, e.action, e.actor]), [['docs', 'connect', '1']]);
    const { prepared, token } = await f.launch();
    assert.deepEqual(prepared.set.servers.map(s => s.name), ['docs']);
    const result = await f.call(token);
    const issuedAccess = f.synthetic.state.issued.find(v => v.startsWith('SYNTHETIC_ACCESS_TOKEN'))!;
    assert.equal(f.synthetic.state.upstreamCalls.at(-1)!.token, issuedAccess);
    // The upstream echoed the token; the gateway redacts it.
    assert.ok(!JSON.stringify(result).includes(issuedAccess));
    assert.match(JSON.stringify(result), /Found the document/);
  }
});

test('PKCE mismatch, unknown, reused or expired state, another session or administrator, and a mismatched iss are refused and store nothing', async t => {
  const f = await fixture(t, { advertise: { dynamic: true }, issParameter: true });
  await f.save([oauthServer()]);
  const empty = async () => assert.equal((await f.connectionRows()).length, 0);

  const tampered = await f.consent({ challenge: 'A'.repeat(43) });
  await assert.rejects(f.oauth.completeSignIn('1', 'session-a', tampered.params), /refused the sign-in/);
  await empty();
  await assert.rejects(f.oauth.completeSignIn('1', 'session-a', { state: 'B'.repeat(43), code: 'x', iss: OAUTH_ISSUER }), /Unknown, used or expired/);
  await assert.rejects(f.oauth.completeSignIn('1', 'session-a', { state: 'not a state', code: 'x' }), /Unknown, used or expired/);
  await empty();

  const otherSession = await f.consent();
  await assert.rejects(f.oauth.completeSignIn('1', 'session-b', otherSession.params), /another session/);
  // Single use: the refused attempt consumed the state.
  await assert.rejects(f.oauth.completeSignIn('1', 'session-a', otherSession.params), /Unknown, used or expired/);
  await empty();

  const otherAdmin = await f.consent();
  await assert.rejects(f.oauth.completeSignIn('3', 'session-a', otherAdmin.params), /another session/);
  await empty();

  const mixUp = await f.consent({ iss: 'https://1.1.1.1' });
  await assert.rejects(f.oauth.completeSignIn('1', 'session-a', mixUp.params), /another issuer/);
  const missingIss = await f.consent({ iss: null });
  await assert.rejects(f.oauth.completeSignIn('1', 'session-a', missingIss.params), /another issuer/);
  await empty();

  const expired = await f.consent();
  f.tick(10 * 60 * 1000 + 1);
  await assert.rejects(f.oauth.completeSignIn('1', 'session-a', expired.params), /Unknown, used or expired/);
  await empty();

  const denied = await f.consent();
  await assert.rejects(f.oauth.completeSignIn('1', 'session-a', { state: denied.params.state, error: 'access_denied' }), /did not authorize/);
  await empty();
  await assert.rejects(f.oauth.startSignIn('2', 'session-a', 'docs', OAUTH_URLS), /administrator/);
  await assert.rejects(f.oauth.startSignIn('1', 'session-a', 'docs', { redirectUri: null, clientMetadataUrl: null }), /public HTTPS base URL/);

  const reused = await f.consent();
  await f.oauth.completeSignIn('1', 'session-a', reused.params);
  await assert.rejects(f.oauth.completeSignIn('1', 'session-a', reused.params), /Unknown, used or expired/);
  assert.equal((await f.connectionRows()).length, 1);
  const registrations = f.synthetic.state.registrations;
  await f.connect();
  assert.equal(f.synthetic.state.registrations, registrations, 'reconnecting reuses the dynamic registration of the connection');
});

test('refresh before expiry is single-flight, persists a rotated refresh token, and an upstream 401 refreshes once and retries once', async t => {
  const f = await fixture(t, { advertise: { dynamic: true }, accessTtl: 120 });
  await f.save([oauthServer()]);
  await f.connect();
  const { token } = await f.launch();
  await f.call(token);
  assert.equal(f.synthetic.state.tokenRequests.refresh_token, 0);
  // Within the refresh margin: refreshed before use.
  f.tick(90 * 1000);
  let release!: () => void; f.synthetic.state.holdRefresh = new Promise(resolve => { release = resolve; });
  const instanceId = await f.store.instanceId(); const server = (await f.store.readLibrary('1')).servers[0];
  const concurrent = Promise.all([f.oauth.accessToken(instanceId, server), f.oauth.accessToken(instanceId, server)]);
  await new Promise(resolve => setTimeout(resolve, 20));
  release(); f.synthetic.state.holdRefresh = null;
  const [first, second] = await concurrent;
  assert.equal(first, second);
  assert.equal(f.synthetic.state.tokenRequests.refresh_token, 1, 'two concurrent callers cause exactly one refresh');
  const version = (await f.connectionRows())[0].version;
  // The rotated refresh token was persisted: the next refresh succeeds although the first one is now invalid.
  f.tick(120 * 1000);
  await f.call(token, 2);
  assert.equal(f.synthetic.state.tokenRequests.refresh_token, 2);
  assert.ok((await f.connectionRows())[0].version > version);
  assert.equal((await f.connectionRows())[0].state, 'connected');
  // The provider invalidated the access token early: one refresh and one retry.
  f.synthetic.expireAccessTokens();
  const calls = f.synthetic.state.upstreamCalls.length;
  const result = await f.call(token, 3);
  assert.match(JSON.stringify(result), /Found the document/);
  assert.equal(f.synthetic.state.tokenRequests.refresh_token, 3);
  assert.equal(f.synthetic.state.upstreamCalls.length - calls, 2);
  // A refresh that cannot help (the token is refused again) fails the call once, without looping.
  f.synthetic.state.upstreamCalls.length = 0;
  const send = async (...args: Parameters<typeof f.synthetic.send>) => { f.synthetic.state.upstreamCalls.push({ token: args[2], method: 'refused' }); return f.synthetic.send(args[0], args[1], 'refused-token'); };
  await assert.rejects(extensionGatewayCall(f.store, token, 'docs', { jsonrpc: '2.0', id: 4, method: 'tools/list' }, send), /connection failed/);
  assert.equal(f.synthetic.state.upstreamCalls.filter(c => c.method === 'refused').length, 2);
});

test('a parent resource identifier declared by the metadata is used for authorization, code exchange and refresh; the endpoint stays the binding', async t => {
  const parent = 'https://8.8.8.8';
  for (const discovery of ['challenge', 'well_known'] as const) {
    const f = await fixture(t, { discovery, advertise: { dynamic: true }, accessTtl: 120, resource: parent });
    assert.equal((await f.oauth.check('1', { url: OAUTH_MCP_URL }, OAUTH_URLS)).resource, parent);
    await f.save([oauthServer()]);
    const { authorizationUrl, params } = await f.consent();
    assert.equal(new URL(authorizationUrl).searchParams.get('resource'), parent);
    assert.deepEqual(await f.oauth.completeSignIn('1', 'session-a', params), { name: 'docs' });
    const tokenRequests = () => f.synthetic.state.requests.filter(r => r.url === `${OAUTH_ISSUER}/token`).map(r => new URLSearchParams(r.body ?? ''));
    assert.deepEqual(tokenRequests().map(form => [form.get('grant_type'), form.get('resource')]), [['authorization_code', parent]]);
    const [row] = await f.connectionRows();
    assert.equal(row.resource, parent);
    assert.equal(row.endpoint, OAUTH_MCP_URL);
    const { token } = await f.launch();
    await f.call(token);
    // Within the refresh margin: the refresh names the declared resource, and the call still goes to the endpoint.
    f.tick(90 * 1000);
    assert.match(JSON.stringify(await f.call(token, 2)), /Found the document/);
    assert.equal(f.synthetic.state.tokenRequests.refresh_token, 1);
    assert.deepEqual(tokenRequests().map(form => [form.get('grant_type'), form.get('resource')]), [['authorization_code', parent], ['refresh_token', parent]]);
    assert.equal((await f.connectionRows())[0].state, 'connected');
  }
  // A resource that is not the endpoint or a path prefix of it on the same origin is still refused.
  for (const other of ['https://8.8.8.8/other', 'https://8.8.4.4']) {
    const f = await fixture(t, { advertise: { dynamic: true }, resource: other });
    await assert.rejects(f.oauth.check('1', { url: OAUTH_MCP_URL }, OAUTH_URLS), /names another resource/);
  }
});

test('a rejected refresh moves to Needs sign-in with one notification; later runs skip the server; a network failure changes nothing', async t => {
  const f = await fixture(t, { advertise: { dynamic: true }, accessTtl: 30 });
  await f.save([oauthServer()]);
  await f.connect();
  const instanceId = await f.store.instanceId(); const server = (await f.store.readLibrary('1')).servers[0];
  f.tick(31 * 1000);
  f.synthetic.state.refreshFailure = 'network';
  await assert.rejects(f.oauth.accessToken(instanceId, server), /unavailable|failed/);
  assert.equal(f.synthetic.state.tokenRequests.refresh_token, 3, 'network errors are retried');
  assert.equal((await f.connectionRows())[0].state, 'connected');
  assert.equal(f.notifications.length, 0);
  f.synthetic.state.refreshFailure = 'authorization';
  const results = await Promise.allSettled([f.oauth.accessToken(instanceId, server), f.oauth.accessToken(instanceId, server)]);
  assert.ok(results.every(r => r.status === 'rejected'));
  assert.equal((await f.connectionRows())[0].state, 'needs_sign_in');
  assert.deepEqual(f.notifications.map(n => n.serverName), ['docs']);
  await assert.rejects(f.oauth.accessToken(instanceId, server), /unavailable/);
  assert.equal(f.notifications.length, 1, 'one notification, not one per run');
  const later = await f.store.resolveLaunch(context, false);
  assert.deepEqual(later.set.servers, []);
  assert.deepEqual(later.set.skipped, [{ kind: 'server', name: 'docs', reason: 'oauth_needs_sign_in', source: 'auto' }]);
  assert.equal((await f.oauth.statuses(instanceId, [server])).docs.state, 'needs_sign_in');
  assert.ok((await f.oauth.audit('1')).some(e => e.action === 'needs_sign_in' && e.actor === 'system'));
  // Reconnecting returns to Connected.
  f.synthetic.state.refreshFailure = null;
  await f.connect();
  assert.equal((await f.connectionRows())[0].state, 'connected');
});

test('Reconnect registers again when the authorization server rejected the dynamic client', async t => {
  for (const ending of ['expiry', 'upstream 401'] as const) {
    const f = await fixture(t, { advertise: { dynamic: true }, accessTtl: 30 });
    await f.save([oauthServer()]);
    await f.connect();
    const instanceId = await f.store.instanceId(); const server = (await f.store.readLibrary('1')).servers[0];
    const rejected = (await f.connectionRows())[0].client_id as string;
    assert.equal(f.synthetic.state.registrations, 1);
    // The provider deletes the registration: its tokens stop working and the refresh is refused with 401 invalid_client.
    f.synthetic.invalidateClient(rejected);
    if (ending === 'expiry') { f.tick(31 * 1000); await assert.rejects(f.oauth.accessToken(instanceId, server)); }
    else { const { token } = await f.launch(); await assert.rejects(f.call(token)); }
    assert.equal((await f.connectionRows())[0].state, 'needs_sign_in', ending);
    // Reconnect obtains a new registration instead of the rejected client, and completes.
    const { authorizationUrl, params } = await f.consent();
    assert.notEqual(new URL(authorizationUrl).searchParams.get('client_id'), rejected, ending);
    assert.equal(f.synthetic.state.registrations, 2, ending);
    assert.deepEqual(await f.oauth.completeSignIn('1', 'session-a', params), { name: 'docs' });
    const [row] = await f.connectionRows();
    assert.equal(row.state, 'connected', ending);
    assert.notEqual(row.client_id, rejected, ending);
    // The new connection works for runs and refreshes with the new client.
    const { token } = await f.launch(`task-${ending}`);
    assert.match(JSON.stringify(await f.call(token)), /Found the document/, ending);
    f.tick(31 * 1000);
    assert.match(JSON.stringify(await f.call(token, 2)), /Found the document/, ending);
    assert.equal((await f.connectionRows())[0].state, 'connected', ending);
    // A Connected dynamic client is still reused by Reconnect.
    await f.connect();
    assert.equal(f.synthetic.state.registrations, 2, ending);
  }
});

test('discovery, registration and token requests to private or loopback addresses are refused by the endpoint policy', async t => {
  let dialed = 0;
  const counting = async () => { dialed++; return { status: 200, headers: {}, body: '{}' }; };
  for (const url of ['https://127.0.0.1/mcp', 'https://10.0.0.5/mcp', 'https://localhost/mcp', 'https://169.254.169.254/latest', 'http://8.8.8.8/mcp', 'https://8.8.8.8:8443/mcp']) {
    await assert.rejects(oauthRequest(counting, { method: 'GET', url }), /endpoint policy/);
  }
  await assert.rejects(discoverOAuth(counting, 'https://127.0.0.1/mcp'), /could not be reached/);
  const metadata = { issuer: OAUTH_ISSUER, authorization_endpoint: `${OAUTH_ISSUER}/authorize`, token_endpoint: 'https://192.168.1.10/token', registration_endpoint: 'https://[::1]/register' };
  await assert.rejects(requestTokens(counting, metadata, { registration: 'dynamic', clientId: 'c', authMethod: 'none' }, { grant_type: 'refresh_token', refresh_token: 'r' }), /endpoint policy/);
  assert.equal(dialed, 0);
  // Names are resolved before dialing; a private answer is refused.
  const transport = createOAuthHttpsTransport({ lookup: async () => [{ address: '10.1.2.3', family: 4 }] });
  await assert.rejects(oauthRequest(transport, { method: 'GET', url: 'https://auth.example.com/.well-known/oauth-authorization-server' }), /OAuth request failed|public/);
  // A provider whose metadata names a private token endpoint cannot complete a sign-in.
  const f = await fixture(t, { advertise: { dynamic: true } });
  f.synthetic.metadata.token_endpoint = 'https://10.0.0.7/token';
  await f.save([oauthServer()]);
  const { params } = await f.consent();
  await assert.rejects(f.oauth.completeSignIn('1', 'session-a', params), /refused the sign-in/);
  assert.ok(!f.synthetic.state.requests.some(r => r.url.includes('10.0.0.7')));
  assert.equal((await f.connectionRows()).length, 0);
});

test('changing the URL or authentication discards the connection; disabling keeps it; Disconnect revokes and deletes', async t => {
  const f = await fixture(t, { advertise: { dynamic: true } });
  await f.save([oauthServer()]);
  await f.connect();
  await f.store.setItemEnabled('1', { kind: 'server', name: 'docs' }, false);
  await f.store.setItemEnabled('1', { kind: 'server', name: 'docs' }, true);
  assert.equal((await f.connectionRows()).length, 1, 'disabling and re-enabling keeps the connection');
  await f.save([oauthServer({ tools: ['lookup', 'search'] })]);
  assert.equal((await f.connectionRows()).length, 1, 'other edits keep the connection');
  await f.save([oauthServer({ url: 'https://8.8.8.8/v2/mcp' })]);
  assert.equal((await f.connectionRows()).length, 0, 'a new URL needs a new sign-in');
  await f.save([oauthServer()]);
  await f.connect();
  await f.save([oauthServer({ authentication: 'none' })]);
  assert.equal((await f.connectionRows()).length, 0, 'switching the authentication type discards the tokens');
  await f.save([oauthServer()]);
  await f.connect();
  const [row] = await f.connectionRows();
  assert.equal(row.state, 'connected');
  const issued = f.synthetic.state.issued.slice(-2);
  assert.deepEqual(await f.oauth.disconnect('1', 'docs'), { revoked: true });
  assert.deepEqual(f.synthetic.state.revoked.sort(), [...issued].sort());
  assert.equal((await f.connectionRows()).length, 0);
  assert.deepEqual((await f.oauth.audit('1')).slice(0, 2).map(e => e.action), ['disconnect', 'connect']);
  assert.ok((await f.oauth.audit('1')).filter(e => e.action === 'discarded').length >= 2);
  await assert.rejects(f.oauth.disconnect('2', 'docs'), /administrator/);
});

test('tokens and client secrets never appear in projections, revisions, logs, task events or telemetry', async t => {
  // Every log call made by the flow below, as its structured arguments.
  const logged: string[] = [];
  for (const level of ['debug', 'info', 'warn', 'error'] as const) {
    const original = logger[level];
    (logger as unknown as Record<string, unknown>)[level] = (...args: unknown[]) => { logged.push(JSON.stringify(args)); return (original as (...a: unknown[]) => void).apply(logger, args); };
    t.after(() => { (logger as unknown as Record<string, unknown>)[level] = original; });
  }
  const f = await fixture(t, { advertise: { dynamic: true }, accessTtl: 30 });
  await f.database.schema.createTable('tasks', c => { c.string('task_id').primary(); });
  await f.database.schema.createTable('task_history', c => { c.increments('id'); c.string('task_id'); c.string('state'); c.string('timestamp'); c.text('reason'); c.text('metadata'); });
  await f.database('tasks').insert({ task_id: 'task-1' });
  await f.save([oauthServer()]);
  await f.connect();
  const { prepared, token } = await f.launch('task-1');
  await f.call(token);
  await f.store.recordResolution('task-1', { event: 'extensions.resolved', libraryRevision: prepared.snapshot.revision, runKind: 'automation', provenance: { source: 'auto', auditActor: '1' }, servers: ['docs'], skills: [], autoApplied: { servers: ['docs'], skills: [] }, added: { servers: [], skills: [] }, skipped: [], omitted: [] });
  await f.store.retainGatewayTelemetry(token);
  // Refresh, a transient failure and a rejected refresh all log.
  const instanceId = await f.store.instanceId(); const server = (await f.store.readLibrary('1')).servers[0];
  f.tick(31 * 1000); await f.oauth.accessToken(instanceId, server);
  f.tick(31 * 1000); f.synthetic.state.refreshFailure = 'network'; await assert.rejects(f.oauth.accessToken(instanceId, server));
  f.synthetic.state.refreshFailure = 'authorization'; await assert.rejects(f.oauth.accessToken(instanceId, server));
  assert.ok(logged.some(line => line.includes('needs a new sign-in')));
  const library = await f.store.readLibrary('1');
  const surfaces = JSON.stringify([
    library, await f.store.history('1'), await f.oauth.statuses(library.instanceId, library.servers), await f.oauth.audit('1'),
    await f.database('task_history').select(), await f.database('extension_library_revisions').select(), await f.database('extension_oauth_audit').select(),
    logged,
  ]);
  const sealed = JSON.stringify(await f.connectionRows());
  assert.ok(f.synthetic.state.issued.length >= 3);
  for (const value of f.synthetic.state.issued) {
    assert.ok(!surfaces.includes(value), 'no token or registration secret in any projection or log');
    assert.ok(!sealed.includes(value), 'stored only in sealed form');
  }
});

/** The synthetic provider behind a hook that sees every request and may act or wait around the provider's answer. */
type TransportHook = (request: OAuthHttpRequest, forward: () => Promise<OAuthHttpResponse>) => Promise<OAuthHttpResponse>;
async function hooked(t: TestContext, provider: SyntheticOAuthOptions, hook: TransportHook, options: Partial<ExtensionOAuthOptions> = {}) {
  let forward!: OAuthTransport;
  const f = await fixture(t, provider, { ...options, transport: request => hook(request, () => forward(request)) });
  forward = f.synthetic.transport;
  return f;
}
const grantType = (request: OAuthHttpRequest) => new URLSearchParams(request.body ?? '').get('grant_type');
const deferred = () => { let resolve!: () => void; const promise = new Promise<void>(r => { resolve = r; }); return { promise, resolve }; };
const REPLACEMENT_SECRET = 'REPLACEMENT_CLIENT_SECRET_SENTINEL_0002';

test('Disconnect or a binding change while the code exchange is outstanding cancels the sign-in', async t => {
  const changes = [
    { name: 'disconnect', provider: { advertise: { dynamic: true } }, server: oauthServer(), secrets: {}, change: (f: Awaited<ReturnType<typeof hooked>>) => f.oauth.disconnect('1', 'docs') },
    { name: 'new URL', provider: { advertise: { dynamic: true } }, server: oauthServer(), secrets: {}, change: (f: Awaited<ReturnType<typeof hooked>>) => f.save([oauthServer({ url: 'https://8.8.8.8/v2/mcp' })]) },
    { name: 'removed', provider: { advertise: { dynamic: true } }, server: oauthServer(), secrets: {}, change: (f: Awaited<ReturnType<typeof hooked>>) => f.save([]) },
    { name: 'new client id', provider: { advertise: {} }, server: oauthServer({ clientId: PREREGISTERED_CLIENT.id }), secrets: { docs: PREREGISTERED_CLIENT.secret }, change: (f: Awaited<ReturnType<typeof hooked>>) => f.save([oauthServer({ clientId: 'replacement-client' })], { docs: REPLACEMENT_SECRET }) },
  ];
  for (const item of changes) {
    const exchanging = deferred(); const answer = deferred();
    // The provider has issued the tokens; their delivery is outstanding while the administrator acts.
    const f = await hooked(t, item.provider, async (request, forward) => {
      const response = await forward();
      if (grantType(request) === 'authorization_code') { exchanging.resolve(); await answer.promise; }
      return response;
    });
    await f.save([item.server], { ...item.secrets });
    const { params } = await f.consent();
    const callback = f.oauth.completeSignIn('1', 'session-a', params);
    await exchanging.promise;
    await item.change(f);
    answer.resolve();
    await assert.rejects(callback, /cancelled|changed during sign-in/, item.name);
    assert.deepEqual(await f.connectionRows(), [], `${item.name}: no connection is restored`);
    assert.deepEqual(await f.database('extension_oauth_pending').select(), [], `${item.name}: the attempt is gone`);
    assert.ok(!(await f.oauth.audit('1')).some(e => e.action === 'connect'), item.name);
  }
});

test('Disconnect or a binding change while discovery or registration is outstanding cancels the start', async t => {
  type F = Awaited<ReturnType<typeof hooked>>;
  const dynamic = { provider: { advertise: { dynamic: true } }, server: oauthServer(), secrets: {} };
  const preregistered = { provider: { advertise: {} }, server: oauthServer({ clientId: PREREGISTERED_CLIENT.id }), secrets: { docs: PREREGISTERED_CLIENT.secret } };
  const discovering = (request: OAuthHttpRequest) => request.method === 'POST' && request.url === OAUTH_MCP_URL;
  const registering = (request: OAuthHttpRequest) => new URL(request.url).pathname === '/register';
  const cases = [
    // Reconnect of a connected server: Disconnect returns while the start is still discovering.
    { name: 'disconnect during discovery', ...dynamic, connected: true, hold: discovering, change: (f: F) => f.oauth.disconnect('1', 'docs') },
    { name: 'disconnect during registration', ...dynamic, connected: false, hold: registering, change: (f: F) => f.oauth.disconnect('1', 'docs') },
    { name: 'new URL during discovery', ...dynamic, connected: true, hold: discovering, change: (f: F) => f.save([oauthServer({ url: 'https://8.8.8.8/v2/mcp' })]) },
    { name: 'removed during registration', ...dynamic, connected: false, hold: registering, change: (f: F) => f.save([]) },
    { name: 'new client id during discovery', ...preregistered, connected: false, hold: discovering, change: (f: F) => f.save([oauthServer({ clientId: 'replacement-client' })], { docs: REPLACEMENT_SECRET }) },
    // Back on the endpoint the start read: only the cancelled record tells this start from a new one.
    { name: 'URL changed and restored during discovery', ...dynamic, connected: false, hold: discovering, change: async (f: F) => { await f.save([oauthServer({ url: 'https://8.8.8.8/v2/mcp' })]); await f.save([oauthServer()]); } },
  ];
  for (const item of cases) {
    let armed = false; const holding = deferred(); const answer = deferred();
    const f = await hooked(t, item.provider, async (request, forward) => {
      const response = await forward();
      if (armed && item.hold(request)) { armed = false; holding.resolve(); await answer.promise; }
      return response;
    });
    await f.save([item.server], { ...item.secrets });
    if (item.connected) await f.connect();
    armed = true;
    const start = f.oauth.startSignIn('1', 'session-a', 'docs', OAUTH_URLS);
    await holding.promise;
    assert.equal((await f.database('extension_oauth_pending').select()).length, 1, `${item.name}: the start is recorded before its first request completes`);
    await item.change(f);
    answer.resolve();
    await assert.rejects(start, /cancelled/, item.name);
    assert.deepEqual(await f.database('extension_oauth_pending').select(), [], `${item.name}: no pending sign-in is recorded`);
    assert.deepEqual(await f.connectionRows(), [], `${item.name}: no connection is restored`);
  }

  // A library save that keeps the binding leaves the start, and its sign-in, intact.
  let armed = false; const holding = deferred(); const answer = deferred();
  const f = await hooked(t, preregistered.provider, async (request, forward) => {
    const response = await forward();
    if (armed && discovering(request)) { armed = false; holding.resolve(); await answer.promise; }
    return response;
  });
  await f.save([preregistered.server], { ...preregistered.secrets });
  armed = true;
  const start = f.oauth.startSignIn('1', 'session-a', 'docs', OAUTH_URLS);
  await holding.promise;
  await f.save([preregistered.server, oauthServer({ name: 'other', url: 'https://8.8.8.8/other/mcp' })]);
  answer.resolve();
  const { authorizationUrl } = await start;
  assert.deepEqual(await f.oauth.completeSignIn('1', 'session-a', f.synthetic.authorize(authorizationUrl)), { name: 'docs' });
  assert.equal((await f.connectionRows())[0].state, 'connected');
});

test('a refresh of a replaced connection neither overwrites its successor nor is joined by it', async t => {
  for (const phase of ['write', 'single-flight'] as const) {
    const delivering = deferred(); const answer = deferred(); let refreshes = 0;
    const f = await hooked(t, { advertise: { dynamic: true }, accessTtl: 120 }, async (request, forward) => {
      const response = await forward();
      // Only the first refresh: the provider rotated, its answer is outstanding.
      if (grantType(request) === 'refresh_token' && ++refreshes === 1) { delivering.resolve(); await answer.promise; }
      return response;
    });
    await f.save([oauthServer()]);
    await f.connect();
    const instanceId = await f.store.instanceId(); const server = (await f.store.readLibrary('1')).servers[0];
    f.tick(90 * 1000);
    const old = f.oauth.accessToken(instanceId, server);
    const oldSettled = old.then(() => 'resolved', () => 'rejected');
    await delivering.promise;
    // A library change discards the connection while its refresh is outstanding (Disconnect would wait for the refresh).
    await f.save([oauthServer({ url: 'https://8.8.8.8/v2/mcp' })]);
    await f.save([oauthServer()]);
    await f.connect();
    const [replacement] = await f.connectionRows();
    assert.equal(Number(replacement.version), 1, 'the successor starts again at version 1');
    const current = await f.oauth.accessToken(instanceId, server);
    if (phase === 'single-flight') {
      // A rejected token of the new connection refreshes on its own instead of waiting for the old refresh.
      const own = await Promise.race([f.oauth.refreshAfterRejection(instanceId, server, current), new Promise<string>((_, reject) => setTimeout(() => reject(new Error('joined the refresh of the replaced connection')), 2000))]);
      assert.notEqual(own, current);
      assert.equal(refreshes, 2);
    }
    const [before] = await f.connectionRows();
    answer.resolve();
    assert.equal(await oldSettled, 'rejected');
    await assert.rejects(old, /changed during refresh/);
    const [after] = await f.connectionRows();
    assert.deepEqual(after, before, 'the old result is discarded');
    // The successor's tokens still open under its own identity and work upstream.
    const { token } = await f.launch();
    assert.match(JSON.stringify(await f.call(token)), /Found the document/);
  }
});

test('a refresh retry never sends a replacement client secret to the previous authorization server', async t => {
  const changes = [
    { name: 'new client id', server: oauthServer({ clientId: 'replacement-client' }) },
    { name: 'new URL', server: oauthServer({ clientId: PREREGISTERED_CLIENT.id, url: 'https://8.8.8.8/v2/mcp' }) },
  ];
  for (const item of changes) {
    const sent: OAuthHttpRequest[] = []; let refreshes = 0;
    const f = await hooked(t, { advertise: {}, accessTtl: 120 }, async (request, forward) => {
      sent.push(request);
      if (grantType(request) === 'refresh_token' && ++refreshes === 1) {
        // During the transient failure the administrator changes the server and enters its new secret.
        await f.save([item.server], { docs: REPLACEMENT_SECRET });
        return { status: 503, headers: { 'content-type': 'application/json' }, body: '{"error":"temporarily_unavailable"}' };
      }
      return forward();
    });
    await f.save([oauthServer({ clientId: PREREGISTERED_CLIENT.id })], { docs: PREREGISTERED_CLIENT.secret });
    await f.connect();
    const instanceId = await f.store.instanceId(); const server = (await f.store.readLibrary('1')).servers[0];
    f.tick(90 * 1000);
    await assert.rejects(f.oauth.accessToken(instanceId, server));
    assert.equal(refreshes, 1, `${item.name}: no retry for a discarded connection`);
    const wire = JSON.stringify(sent.map(r => ({ ...r, decoded: Buffer.from((/^Basic (.+)$/.exec(r.headers?.Authorization ?? '') ?? ['', ''])[1], 'base64').toString() })));
    assert.ok(!wire.includes(REPLACEMENT_SECRET), `${item.name}: the replacement secret never left`);
  }
});

test('the refresh lease covers every retry, so another process neither refreshes again nor marks the connection Needs sign-in', async t => {
  const third = deferred(); const answer = deferred(); let refreshes = 0;
  const f = await hooked(t, { advertise: { dynamic: true }, accessTtl: 120 }, async (request, forward) => {
    if (grantType(request) !== 'refresh_token') return forward();
    refreshes++;
    // Two transient failures that each take almost the whole request timeout.
    if (refreshes <= 2) { f.tick(9900); return { status: 503, headers: { 'content-type': 'application/json' }, body: '{"error":"temporarily_unavailable"}' }; }
    // The third request rotates at once, but its answer arrives after the original 30 s lease would have ended.
    const response = await forward();
    if (refreshes === 3) { f.tick(10_600); third.resolve(); await answer.promise; }
    return response;
  });
  await f.save([oauthServer()]);
  await f.connect();
  const instanceId = await f.store.instanceId(); const server = (await f.store.readLibrary('1')).servers[0];
  f.tick(90 * 1000);
  const processA = f.oauth.accessToken(instanceId, server);
  await third.promise;
  // A second process: its own module instance, so it shares no in-memory single-flight state.
  const other = await import('../src/extensions/extensionOAuthStore.js?second-process') as typeof import('../src/extensions/extensionOAuthStore.js');
  const processB = new other.ExtensionOAuthStore(f.store, { transport: request => f.synthetic.transport(request), now: f.now, notify: async event => { f.notifications.push(event); }, retryDelayMs: 1 })
    .accessToken(instanceId, server);
  await new Promise(resolve => setTimeout(resolve, 250));
  answer.resolve();
  const [a, b] = await Promise.all([processA, processB]);
  assert.equal(b, a, 'the second process uses the result of the first');
  assert.equal(refreshes, 3);
  assert.equal(f.synthetic.state.tokenRequests.refresh_token, 1, 'only the rotating request reached the provider: no second exchange of the old refresh token');
  const [row] = await f.connectionRows();
  assert.equal(row.state, 'connected');
  assert.equal(row.refresh_lease_owner, null);
  assert.equal(f.notifications.length, 0);
});

/** A provider that issues access tokens without refresh tokens. */
const withoutRefreshTokens: TransportHook = async (request, forward) => {
  const response = await forward();
  if (grantType(request) !== 'authorization_code' || response.status !== 200) return response;
  const { refresh_token: _dropped, ...body } = JSON.parse(response.body) as Record<string, unknown>;
  return { ...response, body: JSON.stringify(body) };
};

test('a connection without a refresh token stays usable until its access token expires or is refused upstream', async t => {
  for (const ending of ['expiry', 'upstream rejection'] as const) {
    const f = await hooked(t, { advertise: { dynamic: true }, accessTtl: 30 }, withoutRefreshTokens);
    await f.save([oauthServer()]);
    await f.connect();
    const { token } = await f.launch();
    // Inside the refresh margin from the start: there is nothing to refresh, so the valid token is used.
    assert.match(JSON.stringify(await f.call(token)), /Found the document/);
    f.tick(20 * 1000);
    assert.match(JSON.stringify(await f.call(token, 2)), /Found the document/);
    assert.equal(f.synthetic.state.tokenRequests.refresh_token, 0);
    assert.equal((await f.connectionRows())[0].state, 'connected', ending);
    assert.equal(f.notifications.length, 0);
    if (ending === 'expiry') f.tick(11 * 1000);
    else f.synthetic.expireAccessTokens();
    await assert.rejects(f.call(token, 3), /connection failed|unavailable/);
    assert.equal((await f.connectionRows())[0].state, 'needs_sign_in', ending);
    assert.deepEqual(f.notifications.map(n => n.serverName), ['docs'], ending);
  }
});

test('Disconnect waits for a refresh in flight and revokes the rotated tokens', async t => {
  const delivering = deferred(); const answer = deferred(); let refreshes = 0;
  const f = await hooked(t, { advertise: { dynamic: true }, accessTtl: 120 }, async (request, forward) => {
    const response = await forward();
    // The provider rotated; its answer is outstanding when Disconnect starts.
    if (grantType(request) === 'refresh_token' && ++refreshes === 1) { delivering.resolve(); await answer.promise; }
    return response;
  });
  await f.save([oauthServer()]);
  await f.connect();
  const instanceId = await f.store.instanceId(); const server = (await f.store.readLibrary('1')).servers[0];
  f.tick(90 * 1000);
  const refreshing = f.oauth.accessToken(instanceId, server);
  await delivering.promise;
  const rotated = f.synthetic.state.issued.slice(-2);
  let disconnected = false;
  const disconnect = f.oauth.disconnect('1', 'docs').finally(() => { disconnected = true; });
  await new Promise(resolve => setTimeout(resolve, 50));
  assert.equal(disconnected, false, 'Disconnect waits for the refresh holding the lease');
  answer.resolve();
  assert.ok(rotated.includes(await refreshing), 'the refresh completes with the rotated access token');
  assert.deepEqual(await disconnect, { revoked: true });
  for (const token of rotated) assert.ok(f.synthetic.state.revoked.includes(token), 'the rotated tokens are revoked');
  assert.equal((await f.connectionRows()).length, 0);
});

test('during Disconnect revocation no refresh starts and a sign-in callback cannot replace the connection', async t => {
  for (const during of ['refresh', 'callback'] as const) {
    const revoking = deferred(); const answer = deferred(); let held = false;
    const f = await hooked(t, { advertise: { dynamic: true }, accessTtl: 120 }, async (request, forward) => {
      if (request.url.endsWith('/revoke') && !held) { held = true; revoking.resolve(); await answer.promise; }
      return forward();
    });
    await f.save([oauthServer()]);
    await f.connect();
    const instanceId = await f.store.instanceId(); const server = (await f.store.readLibrary('1')).servers[0];
    const issued = f.synthetic.state.issued.slice(-2);
    const disconnect = f.oauth.disconnect('1', 'docs');
    await revoking.promise;
    if (during === 'refresh') {
      f.tick(90 * 1000);
      await assert.rejects(f.oauth.accessToken(instanceId, server), /unavailable/);
      assert.equal(f.synthetic.state.tokenRequests.refresh_token, 0, 'no rotation behind the revocation');
    } else {
      const exchanges = f.synthetic.state.tokenRequests.authorization_code;
      const { params } = await f.consent();
      await assert.rejects(f.oauth.completeSignIn('1', 'session-a', params), /being disconnected/);
      assert.equal(f.synthetic.state.tokenRequests.authorization_code, exchanges, 'no code is exchanged while disconnecting');
      assert.equal((await f.oauth.statuses(instanceId, [server])).docs.state, 'needs_sign_in');
    }
    answer.resolve();
    assert.deepEqual(await disconnect, { revoked: true });
    assert.deepEqual([...f.synthetic.state.revoked].sort(), [...issued].sort(), during);
    assert.equal((await f.connectionRows()).length, 0, during);
    assert.equal((await f.oauth.audit('1'))[0].action, 'disconnect');
  }
});
