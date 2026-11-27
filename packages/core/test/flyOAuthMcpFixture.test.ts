import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ExtensionLibraryServerInput } from '@propr/shared';
import { extensionTestResources } from './helpers/extensionTestResources.js';
import { ExtensionLibraryStore, extensionTokenHash, type ExtensionLaunchContext } from '../src/extensions/extensionProfileStore.js';
import { ExtensionOAuthStore, setExtensionOAuth } from '../src/extensions/extensionOAuthStore.js';
import { extensionGatewayCall } from '../src/extensions/mcpGateway.js';
import { ExtensionUpstreamSessionNotFoundError, ExtensionUpstreamUnauthorizedError, type ExtensionMcpExchange } from '../src/extensions/endpointPolicy.js';
import { ExtensionUpstreamSessions } from '../src/extensions/mcpUpstreamSessions.js';
import { testExtensionConnections } from '../src/extensions/extensionConnectionTest.js';
import type { OAuthTransport } from '../src/extensions/extensionOAuthHttp.js';
import { up } from '../src/db/migrations/20261013210000_extension_profiles.js';
import { up as grantMigration } from '../src/db/migrations/20261013220000_extension_grant_network.js';
import { up as libraryMigration } from '../src/db/migrations/20261113000000_extension_library.js';
import { up as oauthMigration } from '../src/db/migrations/20261113120000_extension_oauth.js';

/**
 * The Fly smoke's OAuth fixture (.github/fly-e2e/oauth-mcp-fixture.mjs) against
 * ProPR's own OAuth client and gateway: discovery, dynamic registration, the
 * auto-approving consent, code exchange, a stateful session, a refresh while
 * the session stays open and the DELETE at grant end. The fixture runs locally
 * over HTTP; the transports below map its public origin to it.
 */
const fixtureScript = fileURLToPath(new URL('../../../.github/fly-e2e/oauth-mcp-fixture.mjs', import.meta.url));
const ORIGIN = 'https://8.8.4.4';
const REDIRECT = 'https://propr.example.com/api/instance/extensions/v1/oauth/callback';
const context: ExtensionLaunchContext = { agentAlias: 'claude-main', runtime: 'claude', repositories: ['team/repo'], allowWrite: false };

test('the Fly smoke OAuth fixture signs in, refreshes mid-session and ends its session through the gateway', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'oauth-fixture-'));
  extensionTestResources(t).defer(() => fs.rm(root, { recursive: true, force: true }));
  const port = 20000 + Math.floor(Math.random() * 20000);
  // 61 s tokens: inside Core's one-minute refresh margin after one second.
  const child = spawn(process.execPath, [fixtureScript], { env: { PATH: process.env.PATH, PUBLIC_URL: ORIGIN, PORT: String(port), ACCESS_TTL: '61', STATE_FILE: path.join(root, 'state.json') }, stdio: ['ignore', 'pipe', 'inherit'] });
  extensionTestResources(t).defer(() => { child.kill(); });
  await new Promise<void>((resolve, reject) => { child.stdout!.once('data', () => resolve()); child.once('exit', code => reject(new Error(`fixture exited ${code}`))); });
  const local = (url: string) => `http://127.0.0.1:${port}${new URL(url).pathname}${new URL(url).search}`;
  const stats = async () => (await fetch(local(`${ORIGIN}/stats`))).json() as Promise<Record<string, number>>;

  const transport: OAuthTransport = async request => {
    const response = await fetch(local(request.url), { method: request.method, headers: request.headers, body: request.body, redirect: 'manual' });
    return { status: response.status, headers: { 'www-authenticate': response.headers.get('www-authenticate') ?? undefined, 'content-type': response.headers.get('content-type') ?? undefined }, body: await response.text() };
  };
  // The gateway transport's contract over plain HTTP: session headers in, Mcp-Session-Id out, 401 and 404 as errors.
  const deleted: string[] = [];
  const send = async (endpoint: string, body: unknown, bearer?: string, _policy?: unknown, exchange: ExtensionMcpExchange = {}) => {
    if (exchange.method === 'DELETE' && exchange.sessionId) deleted.push(exchange.sessionId);
    const response = await fetch(local(endpoint), {
      method: exchange.method ?? 'POST', ...(exchange.method === 'DELETE' ? {} : { body: JSON.stringify(body) }),
      headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', 'mcp-protocol-version': exchange.protocolVersion ?? '2025-03-26', ...exchange.headers, ...(exchange.sessionId ? { 'mcp-session-id': exchange.sessionId } : {}), ...(bearer ? { authorization: `Bearer ${bearer}` } : {}) },
    });
    if (exchange.method === 'DELETE') return null;
    if (response.status === 401 && bearer) throw new ExtensionUpstreamUnauthorizedError();
    if (response.status === 404 && exchange.sessionId) throw new ExtensionUpstreamSessionNotFoundError();
    const assigned = response.headers.get('mcp-session-id'); if (assigned) exchange.assignedSessionId = assigned;
    if (response.status === 202) return null;
    if (response.status !== 200) throw new Error('MCP connection failed');
    return response.json();
  };

  const database = extensionTestResources(t).database();
  await database.schema.createTable('config', c => { c.string('key').primary(); c.text('value'); });
  await database.schema.createTable('instance_members', c => { c.string('github_user_id').primary(); c.string('role'); });
  await database.schema.createTable('agent_definitions', c => { c.string('id').primary(); c.string('name'); });
  await database('instance_members').insert({ github_user_id: '1', role: 'admin' });
  await up(database); await grantMigration(database); await libraryMigration(database); await oauthMigration(database);
  const store = new ExtensionLibraryStore(database, { SYSTEM_TASK_SECRET: 'fly-oauth-fixture-key' });
  const oauth = new ExtensionOAuthStore(store, { transport, notify: async () => undefined, retryDelayMs: 1 });
  setExtensionOAuth(store, oauth);
  const urls = { redirectUri: REDIRECT, clientMetadataUrl: null };

  const check = await oauth.check('1', { url: `${ORIGIN}/mcp` }, urls);
  assert.deepEqual([check.authorizationRequired, check.registration, check.issuer, check.resource], [true, 'dynamic', ORIGIN, `${ORIGIN}/mcp`]);
  const server = { kind: 'https', name: 'fixture-oauth', url: `${ORIGIN}/mcp`, enabled: true, tools: ['echo'], capability: 'read', authentication: 'oauth', repositories: [], agents: [], autoApply: true } as ExtensionLibraryServerInput;
  await store.saveLibrary('1', { version: 1, servers: [server], skills: [] }, {}, 0);
  // Test connections before sign-in: unavailable, and it says why.
  const oauthResult = (fields: Record<string, unknown>) => [{ name: 'fixture-oauth', authentication: 'oauth', ...fields }];
  assert.deepEqual(await testExtensionConnections(store, '1', send), oauthResult({ reachable: false, status: 'unavailable', session: null, reason: 'OAuth not connected' }));
  // The consent page approves at once and redirects to ProPR's callback, as the smoke's curl follows it.
  const { authorizationUrl } = await oauth.startSignIn('1', 'smoke-session', 'fixture-oauth', urls);
  const consent = await fetch(local(authorizationUrl), { redirect: 'manual' });
  assert.equal(consent.status, 302);
  const callback = new URL(consent.headers.get('location')!);
  assert.equal(callback.origin + callback.pathname, REDIRECT);
  assert.deepEqual(await oauth.completeSignIn('1', 'smoke-session', { state: callback.searchParams.get('state'), code: callback.searchParams.get('code'), iss: callback.searchParams.get('iss') }), { name: 'fixture-oauth' });
  // The smoke's step: Test connections right after sign-in reaches the server with the new token, in a session of
  // its own that it ends; it never uses (or is fenced by) the gateway's per-run sessions.
  const signedIn = await stats();
  assert.deepEqual(await testExtensionConnections(store, '1', send), oauthResult({ reachable: true, status: 'reachable', session: 'stateful' }));
  const tested = await stats();
  // Discovery's unauthenticated probes were the only 401s: the token went with every Test connections request.
  assert.deepEqual([tested.sessionsOpened, tested.sessionsDeleted, tested.unauthorized - signedIn.unauthorized, tested.refreshes], [1, 1, 0, 0]);
  deleted.length = 0;

  const prepared = await store.resolveLaunch(context, false);
  const token = await store.createGrant(prepared, 'oauth-fixture-run');
  await store.activateGrant(token, prepared, context);
  const sessions = new ExtensionUpstreamSessions();
  extensionTestResources(t).defer(() => sessions.closeAll('test'));
  const echo = async (id: number, message: string) => {
    const reply = await extensionGatewayCall(store, token, 'fixture-oauth', { jsonrpc: '2.0', id, method: 'tools/call', params: { name: 'echo', arguments: { message } } }, send, sessions) as { result: { content: { text: string }[] } };
    return reply.result.content[0].text;
  };
  assert.equal(await echo(1, 'URL-OAUTH-OK-local'), 'URL-OAUTH-OK-local');
  await new Promise(resolve => setTimeout(resolve, 1_200));
  assert.equal(await echo(2, 'after-refresh'), 'after-refresh');
  const during = await stats();
  assert.equal(during.refreshes >= 1, true, 'the access token was refreshed mid-run');
  assert.deepEqual([during.sessionsOpened, during.sessionNotFound], [2, 0], 'one gateway session across the refresh (after Test connections\' own)');
  const entry = sessions.peek(extensionTokenHash(token), 'fixture-oauth')!;
  assert.deepEqual([entry.state?.mode, entry.authentication], ['stateful', 'oauth']);
  assert.ok(entry.refreshes >= 1);
  await sessions.closeGrant(extensionTokenHash(token), 'grant_ended');
  assert.equal(deleted.length, 1);
  assert.equal((await stats()).sessionsDeleted, 2);
  // Test connections after the run's session was dropped at grant end: still reachable, in a new session it ends.
  assert.deepEqual(await testExtensionConnections(store, '1', send), oauthResult({ reachable: true, status: 'reachable', session: 'stateful' }));
  const after = await stats();
  assert.deepEqual([after.sessionsOpened, after.sessionsDeleted, after.sessionNotFound], [3, 3, 0]);

  // The request log the smoke dumps on failure: every request once on arrival and once at its end, with the proxy's
  // client address headers, and nothing of a query, header or body (no client id, code or token: all are `fixture_…`).
  await fetch(local(`${ORIGIN}/health?probe=fixture_secret`), { headers: { 'fly-client-ip': '2a09:8280:1::1', 'x-forwarded-for': '203.0.113.7, <script>' } });
  const raw = await fs.readFile(path.join(root, 'state.json.requests.jsonl'), 'utf8');
  assert.doesNotMatch(raw, /fixture_|Bearer|\?/);
  const log = raw.trim().split('\n').map(line => JSON.parse(line) as Record<string, unknown>);
  const starts = log.filter(entry => entry.event === 'start'); const ends = log.filter(entry => entry.event === 'end');
  assert.equal(starts.length, ends.length);
  assert.ok(['/authorize', '/token', '/register', '/mcp', '/.well-known/oauth-authorization-server'].every(p => starts.some(entry => entry.path === p)));
  const health = ends.at(-1)!;
  assert.deepEqual([health.method, health.path, health.status, health.completed, health.flyClientIp, health.forwardedFor], ['GET', '/health', 200, true, '2a09:8280:1::1', '203.0.113.7, **c*****']);
  assert.equal(typeof health.remote, 'string'); assert.equal(typeof health.durationMs, 'number'); assert.match(String(health.time), /^\d{4}-\d\d-\d\dT/);
  assert.deepEqual(ends.filter(entry => entry.path === '/mcp' && entry.method === 'DELETE').map(entry => entry.status), [204, 204, 204]);
});
