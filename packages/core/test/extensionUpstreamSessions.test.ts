import test from 'node:test';
import assert from 'node:assert/strict';
import type { TestContext } from 'node:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { ExtensionLibraryServerInput } from '@propr/shared';
import { extensionTestResources } from './helpers/extensionTestResources.js';
import { ExtensionLibraryStore, extensionTokenHash, type ExtensionLaunchContext } from '../src/extensions/extensionProfileStore.js';
import { extensionGatewayCall } from '../src/extensions/mcpGateway.js';
import { EXTENSION_LIMITS } from '@propr/shared';
import { ExtensionUpstreamRequestError, ExtensionUpstreamSessionNotFoundError, ExtensionUpstreamUnauthorizedError, type ExtensionMcpExchange, type ExtensionMcpSend } from '../src/extensions/endpointPolicy.js';
import { ExtensionUpstreamHandshakeIncompleteError, ExtensionUpstreamHandshakeUnauthorizedError, ExtensionUpstreamSessionCapacityError, ExtensionUpstreamSessionEndedError, ExtensionUpstreamSessions, MCP_2026_REVISION, UPSTREAM_SESSION_LIMITS, closeExtensionGrantSessions, closeExtensionUpstreamSessions, extensionUpstreamSessions, openUpstreamSession, probeExtensionMcp } from '../src/extensions/mcpUpstreamSessions.js';
import { up } from '../src/db/migrations/20261013210000_extension_profiles.js';
import { up as grantMigration } from '../src/db/migrations/20261013220000_extension_grant_network.js';
import { up as libraryMigration } from '../src/db/migrations/20261113000000_extension_library.js';
import { redirectDials } from './helpers/extensionDialRedirect.js';

const secret = 'UPSTREAM_SESSION_BEARER_SENTINEL_DO_NOT_DISCLOSE';
const context: ExtensionLaunchContext = { agentAlias: 'claude-main', runtime: 'claude', repositories: ['team/repo'], allowWrite: true };
const server = (extra: Partial<ExtensionLibraryServerInput> = {}): ExtensionLibraryServerInput => ({ kind: 'https', name: 'echo', url: 'https://8.8.8.8/mcp', enabled: true, tools: ['echo'], capability: 'read', authentication: 'bearer', repositories: [], agents: [], autoApply: true, ...extra } as ExtensionLibraryServerInput);

async function fixture(t: TestContext, servers: ExtensionLibraryServerInput[] = [server()]) {
  const database = extensionTestResources(t).database();
  await database.schema.createTable('config', c => { c.string('key').primary(); c.text('value'); });
  await database.schema.createTable('instance_members', c => { c.string('github_user_id').primary(); c.string('role'); });
  await database.schema.createTable('agent_definitions', c => { c.string('id').primary(); c.string('name'); });
  await database('instance_members').insert({ github_user_id: '1', role: 'admin' });
  await up(database); await grantMigration(database); await libraryMigration(database);
  const store = new ExtensionLibraryStore(database, { SYSTEM_TASK_SECRET: 'synthetic-upstream-session-key' });
  await store.saveLibrary('1', { version: 1, servers, skills: [] }, Object.fromEntries(servers.filter(s => s.kind === 'https' && s.authentication === 'bearer').map(s => [s.name, secret])), 0);
  const launch = async (taskId: string, allowWrite = false) => {
    const prepared = await store.resolveLaunch(context, false);
    const token = await store.createGrant(prepared, taskId, undefined, allowWrite);
    await store.activateGrant(token, prepared, context);
    return token;
  };
  const sessions = new ExtensionUpstreamSessions();
  extensionTestResources(t).defer(() => sessions.closeAll('test'));
  return { database, store, launch, sessions };
}

interface Recorded { method: string; sessionId?: string; protocolVersion?: string; headers?: Record<string, string>; body: Record<string, unknown> }
/** A 2025-era stateful upstream: `initialize` assigns a session, every later request must carry it. */
function statefulUpstream(options: { era?: '2025' | '2026'; sessionless?: boolean } = {}) {
  const sessions = new Set<string>();
  const requests: Recorded[] = [];
  let next = 0;
  const state = { sessions, requests, deleted: [] as string[], serverRequest: false, answers: [] as unknown[] };
  const send = async (_endpoint: string, body: unknown, _token?: string, _policy?: unknown, exchange: ExtensionMcpExchange = {}) => {
    if (exchange.method === 'DELETE') { state.deleted.push(exchange.sessionId!); sessions.delete(exchange.sessionId!); return null; }
    const rpc = body as Record<string, unknown>;
    if (rpc.error) { state.answers.push(rpc); return null; }
    requests.push({ method: String(rpc.method), sessionId: exchange.sessionId, protocolVersion: exchange.protocolVersion, headers: exchange.headers, body: rpc });
    if (options.era === '2026') {
      if (rpc.method === 'initialize') return { jsonrpc: '2.0', id: rpc.id, error: { code: -32602, message: 'Use server/discover' } };
      const meta = (rpc.params as { _meta?: Record<string, unknown> } | undefined)?._meta;
      if (exchange.protocolVersion !== MCP_2026_REVISION || meta?.['io.modelcontextprotocol/protocolVersion'] !== MCP_2026_REVISION) return { jsonrpc: '2.0', id: rpc.id, error: { code: -32602, message: 'missing _meta' } };
      if (rpc.method === 'server/discover') return { jsonrpc: '2.0', id: rpc.id, result: { supportedVersions: [MCP_2026_REVISION, '2025-06-18'], capabilities: { tools: {} } } };
    } else if (rpc.method === 'initialize') {
      if (!options.sessionless) { const id = `upstream-session-${++next}`; sessions.add(id); exchange.assignedSessionId = id; }
      return { jsonrpc: '2.0', id: rpc.id, result: { protocolVersion: '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'upstream', version: '1' } } };
    } else if (!options.sessionless) {
      if (!exchange.sessionId) return { jsonrpc: '2.0', id: rpc.id, error: { code: -32600, message: 'Mcp-Session-Id header is required' } };
      if (!sessions.has(exchange.sessionId)) throw new ExtensionUpstreamSessionNotFoundError();
    }
    if (rpc.id === undefined) return null;
    if (state.serverRequest) exchange.onServerRequest?.('sampling-1');
    if (rpc.method === 'ping') return { jsonrpc: '2.0', id: rpc.id, result: {} };
    if (rpc.method === 'tools/list') return { jsonrpc: '2.0', id: rpc.id, result: { tools: [{ name: 'echo' }, { name: 'hidden' }] } };
    const args = (rpc.params as { arguments?: { message?: string } }).arguments;
    // A tool echoing request headers back must not reveal the session id or credential.
    return { jsonrpc: '2.0', id: rpc.id, result: { content: [{ type: 'text', text: `${args?.message ?? ''} session=${exchange.sessionId ?? 'none'} auth=${secret}` }] } };
  };
  return { send, state };
}
const callEcho = (id: number, message: string) => ({ jsonrpc: '2.0', id, method: 'tools/call', params: { name: 'echo', arguments: { message } } });

test('a gateway session is created once, reused, re-initialized after a 404 and deleted at grant end', async t => {
  const f = await fixture(t);
  const token = await f.launch('stateful-run');
  const upstream = statefulUpstream();
  const call = (body: unknown) => extensionGatewayCall(f.store, token, 'echo', body, upstream.send, f.sessions);
  const initialized = await call({ jsonrpc: '2.0', id: 0, method: 'initialize', params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'agent', version: '1' } } });
  assert.deepEqual(initialized, { jsonrpc: '2.0', id: 0, result: { protocolVersion: '2025-03-26', capabilities: { tools: {} }, serverInfo: { name: 'echo', version: '1' } } });
  // The agent's initialized notification is answered locally: the gateway already sent it.
  assert.equal(await call({ jsonrpc: '2.0', method: 'notifications/initialized' }), null);
  assert.deepEqual(await call({ jsonrpc: '2.0', id: 1, method: 'tools/list' }), { jsonrpc: '2.0', id: 1, result: { tools: [{ name: 'echo' }] } });
  const echoed = await call(callEcho(2, 'URL-STATEFUL-OK-1')) as { result: { content: { text: string }[] } };
  assert.match(echoed.result.content[0].text, /^URL-STATEFUL-OK-1 session=\[REDACTED\] auth=\[REDACTED\]$/);
  assert.deepEqual(upstream.state.requests.map(r => [r.method, r.sessionId ?? null]), [
    ['initialize', null], ['notifications/initialized', 'upstream-session-1'], ['tools/list', 'upstream-session-1'], ['tools/call', 'upstream-session-1'],
  ]);
  // Later requests carry the negotiated revision.
  assert.ok(upstream.state.requests.slice(1).every(r => r.protocolVersion === '2025-06-18'));
  const entry = f.sessions.peek(extensionTokenHash(token), 'echo')!;
  assert.equal(entry.state?.mode, 'stateful');

  // The upstream lost the session: one re-initialize, then the read call is replayed.
  upstream.state.sessions.clear();
  const replayed = await call(callEcho(3, 'again')) as { result: { content: { text: string }[] } };
  assert.match(replayed.result.content[0].text, /^again /);
  assert.equal(entry.reinitialized, 1);
  assert.deepEqual(upstream.state.requests.slice(4).map(r => [r.method, r.sessionId ?? null]), [
    ['tools/call', 'upstream-session-1'], ['initialize', null], ['notifications/initialized', 'upstream-session-2'], ['tools/call', 'upstream-session-2'],
  ]);

  // Grant end: the run's grant is deactivated, the sweep DELETEs the session and forgets it.
  await f.database('extension_run_grants').update({ active: false });
  await f.sessions.sweep();
  assert.deepEqual(upstream.state.deleted, ['upstream-session-2']);
  assert.equal(f.sessions.size(), 0);
  await assert.rejects(call(callEcho(4, 'late')), /expired or exhausted/);
});

test('a grant that ends during the initial handshake fails the call and closes the new session', async t => {
  const f = await fixture(t);
  const token = await f.launch('ended-handshake-run');
  const grant = extensionTokenHash(token);
  const upstream = statefulUpstream();
  // The run's grant ends (R3 closeGrant) while the upstream answers initialize.
  const send: ExtensionMcpSend = async (...args) => {
    const reply = await upstream.send(...args);
    if ((args[1] as { method?: string } | null)?.method === 'initialize') await f.sessions.closeGrant(grant, 'grant_ended');
    return reply;
  };
  await assert.rejects(extensionGatewayCall(f.store, token, 'echo', callEcho(1, 'x'), send, f.sessions), /expired or exhausted/);
  assert.deepEqual(upstream.state.requests.map(r => r.method), ['initialize', 'notifications/initialized'], 'the call was never sent');
  assert.deepEqual(upstream.state.deleted, ['upstream-session-1']);
  assert.equal(f.sessions.size(), 0, 'nothing is kept for the ended grant');
});

test('a grant that ends during the 404 re-initialize fails the call and opens no further session', async t => {
  const f = await fixture(t);
  const token = await f.launch('ended-reinitialize-run');
  const grant = extensionTokenHash(token);
  const upstream = statefulUpstream();
  let endOnInitialize = false;
  const send: ExtensionMcpSend = async (...args) => {
    const reply = await upstream.send(...args);
    if (endOnInitialize && (args[1] as { method?: string } | null)?.method === 'initialize') await f.sessions.closeGrant(grant, 'grant_ended');
    return reply;
  };
  await extensionGatewayCall(f.store, token, 'echo', callEcho(1, 'x'), send, f.sessions);
  upstream.state.sessions.clear(); endOnInitialize = true;
  await assert.rejects(extensionGatewayCall(f.store, token, 'echo', callEcho(2, 'y'), send, f.sessions), /expired or exhausted/);
  assert.deepEqual(upstream.state.requests.map(r => [r.method, r.sessionId ?? null]), [
    ['initialize', null], ['notifications/initialized', 'upstream-session-1'], ['tools/call', 'upstream-session-1'],
    ['tools/call', 'upstream-session-1'], ['initialize', null], ['notifications/initialized', 'upstream-session-2'],
  ], 'the read call is not replayed in the closed session');
  assert.deepEqual(upstream.state.deleted, ['upstream-session-2']);
  assert.equal(f.sessions.size(), 0);
});

test('a dropped entry never opens an upstream session again', async t => {
  const sessions = new ExtensionUpstreamSessions({ ...UPSTREAM_SESSION_LIMITS, perGrant: 1 });
  t.after(() => sessions.closeAll('test'));
  const init = (server: string) => ({ grant: 'g', server, taskId: 't', authentication: 'none' as const, remove: async () => null, alive: async () => true });
  let handshakes = 0;
  const handshake = async () => { handshakes++; return { state: { mode: 'stateless' as const, era: '2025' as const, protocolVersion: '2025-06-18' }, requestBytes: 0 }; };
  // Grant end: a call still holding the entry (the 404 recovery, an OAuth retry) is refused.
  const ended = sessions.entry(init('a'));
  await sessions.closeGrant('g', 'grant_ended');
  await assert.rejects(sessions.open(ended, handshake), ExtensionUpstreamSessionEndedError);
  // Capacity eviction: the evicted entry is refused with the capacity error.
  const evicted = sessions.entry(init('b'));
  sessions.release(evicted);
  sessions.release(sessions.entry(init('c')));
  await assert.rejects(sessions.open(evicted, handshake), ExtensionUpstreamSessionCapacityError);
  assert.equal(handshakes, 0);
  // A caller sharing a handshake whose entry is dropped meanwhile is refused too, and the session is closed.
  const closed: string[] = [];
  const shared = sessions.entry({ ...init('d'), remove: async exchange => { closed.push(exchange.sessionId!); return null; } });
  let finish!: () => void;
  const opening = sessions.open(shared, async () => { await new Promise<void>(resolve => { finish = resolve; }); return { state: { mode: 'stateful', era: '2025', protocolVersion: '2025-06-18', id: 'shared-session' }, requestBytes: 0 }; });
  const joined = sessions.open(shared, handshake);
  await sessions.closeGrant('g', 'grant_ended');
  finish();
  await assert.rejects(opening, ExtensionUpstreamSessionEndedError);
  await assert.rejects(joined, ExtensionUpstreamSessionEndedError);
  assert.deepEqual(closed, ['shared-session']);
  assert.equal(shared.state, undefined);
});

test('a revoked grant closes its sessions on the next call, and expired grants close in the sweep', async t => {
  const f = await fixture(t);
  const upstream = statefulUpstream();
  const first = await f.launch('revoked-run');
  await extensionGatewayCall(f.store, first, 'echo', callEcho(1, 'x'), upstream.send, f.sessions);
  await f.database('extension_run_grants').where({ token_hash: extensionTokenHash(first) }).delete();
  await assert.rejects(extensionGatewayCall(f.store, first, 'echo', callEcho(2, 'x'), upstream.send, f.sessions), /expired/);
  assert.deepEqual(upstream.state.deleted, ['upstream-session-1']);
  const second = await f.launch('expired-run');
  await extensionGatewayCall(f.store, second, 'echo', callEcho(1, 'x'), upstream.send, f.sessions);
  await f.database('extension_run_grants').where({ token_hash: extensionTokenHash(second) }).update({ expires_at: Date.now() - 1 });
  await f.sessions.sweep();
  assert.deepEqual(upstream.state.deleted, ['upstream-session-1', 'upstream-session-2']);
});

test('nothing upstream reaches the agent: no session id, and server-to-client requests are refused upstream', async t => {
  const f = await fixture(t);
  const token = await f.launch('isolated-run');
  const upstream = statefulUpstream();
  upstream.state.serverRequest = true;
  const results = [
    await extensionGatewayCall(f.store, token, 'echo', { jsonrpc: '2.0', id: 1, method: 'tools/list' }, upstream.send, f.sessions),
    await extensionGatewayCall(f.store, token, 'echo', callEcho(2, 'hello'), upstream.send, f.sessions),
    await extensionGatewayCall(f.store, token, 'echo', { jsonrpc: '2.0', id: 3, method: 'ping' }, upstream.send, f.sessions),
  ];
  const wire = JSON.stringify(results);
  assert.ok(!wire.includes('upstream-session-'), 'the upstream session id never reaches the agent');
  assert.ok(!wire.includes('sampling'), 'server-to-client requests are not relayed');
  assert.ok(!wire.includes(secret));
  // Each server request was answered upstream with a JSON-RPC error.
  assert.ok(upstream.state.answers.length >= 3);
  for (const answer of upstream.state.answers) assert.deepEqual(answer, { jsonrpc: '2.0', id: 'sampling-1', error: { code: -32601, message: 'Server-to-client requests are not supported' } });
  // The agent cannot send server-to-client methods or choose session headers either.
  await assert.rejects(extensionGatewayCall(f.store, token, 'echo', { jsonrpc: '2.0', id: 4, method: 'sampling/createMessage' }, upstream.send, f.sessions), /method unavailable/);
  await assert.rejects(extensionGatewayCall(f.store, token, 'echo', { jsonrpc: '2.0', id: 5, method: 'tools/list', sessionId: 'agent-chosen' }, upstream.send, f.sessions), /method unavailable/);
});

test('write servers are never replayed after a lost session; reads are', async t => {
  const f = await fixture(t, [server({ capability: 'write' })]);
  const token = await f.launch('write-run', true);
  const upstream = statefulUpstream();
  await extensionGatewayCall(f.store, token, 'echo', callEcho(1, 'first'), upstream.send, f.sessions);
  upstream.state.sessions.clear();
  const before = upstream.state.requests.length;
  await assert.rejects(extensionGatewayCall(f.store, token, 'echo', callEcho(2, 'write'), upstream.send, f.sessions), /not replayed/);
  assert.deepEqual(upstream.state.requests.slice(before).map(r => r.method), ['tools/call'], 'the write call reached the upstream exactly once');
  // The next call opens a fresh session; it is a new call, not a replay.
  const fresh = await extensionGatewayCall(f.store, token, 'echo', callEcho(3, 'next'), upstream.send, f.sessions) as { result: { content: { text: string }[] } };
  assert.match(fresh.result.content[0].text, /^next /);
  assert.equal((await f.database('extension_run_grants').first()).connections, 0);
});

test('both protocol eras: 2025 stateless and stateful, and the 2026-07-28 revision through server/discover', async t => {
  const f = await fixture(t);
  // 2025 without a session id: stateless, no Mcp-Session-Id is ever sent.
  const sessionless = statefulUpstream({ sessionless: true });
  const stateless = await f.launch('stateless-run');
  await extensionGatewayCall(f.store, stateless, 'echo', callEcho(1, 'a'), sessionless.send, f.sessions);
  await extensionGatewayCall(f.store, stateless, 'echo', callEcho(2, 'b'), sessionless.send, f.sessions);
  assert.equal(f.sessions.peek(extensionTokenHash(stateless), 'echo')!.state?.mode, 'stateless');
  assert.ok(sessionless.state.requests.every(r => r.sessionId === undefined));
  assert.equal(sessionless.state.requests.filter(r => r.method === 'initialize').length, 1, 'the handshake is not repeated');

  // 2026-07-28: initialize is refused, server/discover answers; every request carries _meta and the revision header.
  const modern = statefulUpstream({ era: '2026' });
  const token = await f.launch('modern-run');
  // The agent's initialize is answered with the projection although the upstream refused initialize.
  assert.deepEqual(await extensionGatewayCall(f.store, token, 'echo', { jsonrpc: '2.0', id: 0, method: 'initialize', params: {} }, modern.send, f.sessions),
    { jsonrpc: '2.0', id: 0, result: { protocolVersion: '2025-03-26', capabilities: { tools: {} }, serverInfo: { name: 'echo', version: '1' } } });
  const listed = await extensionGatewayCall(f.store, token, 'echo', { jsonrpc: '2.0', id: 1, method: 'tools/list' }, modern.send, f.sessions);
  assert.deepEqual(listed, { jsonrpc: '2.0', id: 1, result: { tools: [{ name: 'echo' }] } });
  const echoed = await extensionGatewayCall(f.store, token, 'echo', callEcho(2, 'URL-STATELESS-OK'), modern.send, f.sessions) as { result: { content: { text: string }[] } };
  assert.match(echoed.result.content[0].text, /^URL-STATELESS-OK session=none/);
  const entry = f.sessions.peek(extensionTokenHash(token), 'echo')!;
  assert.deepEqual([entry.state?.mode, entry.state?.era, entry.state?.protocolVersion], ['stateless', '2026', MCP_2026_REVISION]);
  assert.deepEqual(modern.state.requests.map(r => r.method), ['initialize', 'server/discover', 'tools/list', 'tools/call']);
  assert.deepEqual(modern.state.requests.at(-1)!.headers, { 'Mcp-Method': 'tools/call', 'Mcp-Name': 'echo' });
  await f.sessions.closeGrant(extensionTokenHash(token), 'test');
  assert.deepEqual(modern.state.deleted, [], 'a stateless session has nothing to DELETE');
});

test('sessions are capped in total and expire when idle', async t => {
  let now = 1_000;
  const sessions = new ExtensionUpstreamSessions({ perGrant: 2, total: 3, idleMs: 1_000, sweepMs: 60_000 }, () => now);
  t.after(() => sessions.closeAll('test'));
  const removed: string[] = [];
  const open = async (grant: string, name: string) => {
    const entry = sessions.entry({ grant, server: name, taskId: grant, authentication: 'none', remove: async exchange => { removed.push(exchange.sessionId!); return null; }, alive: async () => true });
    await sessions.open(entry, async () => ({ state: { mode: 'stateful', era: '2025', protocolVersion: '2025-06-18', id: `${grant}-${name}` }, requestBytes: 0 }));
    sessions.release(entry);
    now += 10;
  };
  await open('a', 'one'); await open('a', 'two'); await open('a', 'three');
  assert.deepEqual(removed, ['a-one'], 'over the per-grant cap the least recently used session closes');
  await open('b', 'one'); await open('c', 'one');
  assert.equal(sessions.size(), 3);
  assert.deepEqual(removed, ['a-one', 'a-two'], 'over the total cap the least recently used session closes');
  now += 2_000;
  await sessions.sweep();
  assert.equal(sessions.size(), 0);
  assert.deepEqual(removed.slice(2).sort(), ['a-three', 'b-one', 'c-one']);
});

test('the real transport keeps a stateful session on one pinned connection, reads event streams and DELETEs at the end', async t => {
  const https = (await import('node:https')).default;
  const { execFileSync } = await import('node:child_process');
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'extension-session-'));
  extensionTestResources(t).defer(() => fs.rm(root, { recursive: true, force: true }));
  execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', path.join(root, 'key.pem'), '-out', path.join(root, 'cert.pem'), '-days', '1', '-subj', '/CN=mcp.synthetic.example', '-addext', 'subjectAltName=DNS:mcp.synthetic.example'], { stdio: 'ignore' });
  const cert = await fs.readFile(path.join(root, 'cert.pem'));
  // Sessions are bound to the connection that opened them, as sticky upstreams do.
  const sessions = new Map<string, unknown>(); let next = 0; let forget = false;
  const deleted: string[] = []; const answers: unknown[] = []; const sockets = new Set<unknown>();
  const upstream = https.createServer({ key: await fs.readFile(path.join(root, 'key.pem')), cert }, async (req, res) => {
    const chunks: Buffer[] = []; for await (const chunk of req) chunks.push(chunk as Buffer);
    const id = req.headers['mcp-session-id'] as string | undefined;
    if (req.method === 'DELETE') { deleted.push(id!); sessions.delete(id!); res.writeHead(204).end(); return; }
    const rpc = JSON.parse(Buffer.concat(chunks).toString());
    if (rpc.error) { answers.push(rpc); res.writeHead(202).end(); return; }
    sockets.add(req.socket);
    if (rpc.method === 'initialize') {
      const session = `sticky-${++next}`; sessions.set(session, req.socket);
      res.writeHead(200, { 'content-type': 'application/json', 'mcp-session-id': session }).end(JSON.stringify({ jsonrpc: '2.0', id: rpc.id, result: { protocolVersion: '2025-06-18', capabilities: {} } }));
      return;
    }
    if (forget) { forget = false; sessions.clear(); }
    if (!id || sessions.get(id) !== req.socket) { res.writeHead(404, { 'content-type': 'application/json' }).end(JSON.stringify({ jsonrpc: '2.0', id: rpc.id ?? null, error: { code: -32001, message: 'Session not found' } })); return; }
    if (rpc.id === undefined) { res.writeHead(202).end(); return; }
    // An event stream: a progress notification, a sampling request, then the call's response.
    const message = rpc.method === 'tools/call' ? { content: [{ type: 'text', text: `${rpc.params.arguments.message} via ${id}` }] } : { tools: [{ name: 'echo' }] };
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.write(`event: message\ndata: ${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/progress', params: { progress: 1 } })}\n\n`);
    res.write(`data: ${JSON.stringify({ jsonrpc: '2.0', id: 'srv-1', method: 'sampling/createMessage', params: {} })}\n\n`);
    res.end(`event: message\ndata: ${JSON.stringify({ jsonrpc: '2.0', id: rpc.id, result: message })}\n\n`);
  });
  extensionTestResources(t).defer(() => new Promise<void>(resolve => { upstream.closeAllConnections(); upstream.close(() => resolve()); }));
  await new Promise<void>(r => upstream.listen(0, '127.0.0.1', r));
  const { port } = upstream.address() as import('node:net').AddressInfo;
  const original = https.request;
  // The vetted address is dialled by the Happy Eyeballs agent; only the test maps it to the local fixture.
  redirectDials(t, '127.0.0.1');
  t.mock.method(https, 'request', (url: URL, options: import('node:https').RequestOptions, callback: Parameters<typeof https.request>[2]) => {
    assert.equal(url.href, 'https://8.8.8.8/mcp');
    return original(`https://127.0.0.1:${port}/mcp`, { ...options, lookup: undefined, ca: cert, servername: 'mcp.synthetic.example' }, callback);
  });
  extensionTestResources(t).defer(() => t.mock.restoreAll());
  const f = await fixture(t);
  const token = await f.launch('transport-run');
  const call = (body: unknown) => extensionGatewayCall(f.store, token, 'echo', body, undefined, f.sessions);
  assert.deepEqual(await call({ jsonrpc: '2.0', id: 1, method: 'tools/list' }), { jsonrpc: '2.0', id: 1, result: { tools: [{ name: 'echo' }] } });
  const first = await call(callEcho(2, 'URL-STATEFUL-OK-T')) as { result: { content: { text: string }[] } };
  assert.equal(first.result.content[0].text, 'URL-STATEFUL-OK-T via [REDACTED]');
  assert.equal(sockets.size, 1, 'initialize, the notification and both calls share one connection');
  forget = true;
  const replayed = await call(callEcho(3, 'after-404')) as { result: { content: { text: string }[] } };
  assert.equal(replayed.result.content[0].text, 'after-404 via [REDACTED]');
  // The sampling requests were answered with errors on separate connections; the agent saw none of them.
  await new Promise(resolve => setTimeout(resolve, 100));
  assert.ok(answers.length >= 3);
  assert.ok(answers.every(answer => JSON.stringify(answer) === JSON.stringify({ jsonrpc: '2.0', id: 'srv-1', error: { code: -32601, message: 'Server-to-client requests are not supported' } })));
  await f.sessions.closeGrant(extensionTokenHash(token), 'grant_ended');
  assert.deepEqual(deleted, ['sticky-2']);
  // Settings' check uses the same handshake and ends the session it opened.
  const probe = await probeExtensionMcp('https://8.8.8.8/mcp', secret, { listTools: true });
  assert.deepEqual([probe.reachable, probe.session, probe.protocolVersion], [true, 'stateful', '2025-06-18']);
  assert.deepEqual((probe.tools as { result: unknown }).result, { tools: [{ name: 'echo' }] });
  assert.deepEqual(deleted, ['sticky-2', 'sticky-3']);
});

test('a call refused for capacity leaves the grant\'s sessions open; only a revoked or expired grant closes them', async t => {
  const f = await fixture(t);
  const token = await f.launch('busy-run');
  const upstream = statefulUpstream();
  const call = (id: number) => extensionGatewayCall(f.store, token, 'echo', callEcho(id, 'busy'), upstream.send, f.sessions);
  await call(1);
  const grant = extensionTokenHash(token);
  const entry = f.sessions.peek(grant, 'echo')!;
  const state = entry.state!;
  // Four admitted calls hold every connection slot; a fifth is refused with the grant's 401.
  await f.database('extension_run_grants').where({ token_hash: grant }).update({ connections: 4 });
  await assert.rejects(call(2), /expired or exhausted/);
  assert.equal(f.sessions.peek(grant, 'echo'), entry, 'the session admitted calls use is kept');
  assert.equal(entry.state, state);
  assert.deepEqual(upstream.state.deleted, []);
  // An exhausted call budget is not grant termination either.
  await f.database('extension_run_grants').where({ token_hash: grant }).update({ connections: 0, calls: 1_000_000 });
  await assert.rejects(call(3), /expired or exhausted/);
  assert.deepEqual(upstream.state.deleted, []);
  await f.database('extension_run_grants').where({ token_hash: grant }).update({ calls: 1 });
  assert.match(JSON.stringify(await call(4)), /busy session=\[REDACTED\]/);
  assert.equal(upstream.state.requests.filter(r => r.method === 'initialize').length, 1, 'the same session served the next call');
  // Expiry does close it on the next refused call.
  await f.database('extension_run_grants').where({ token_hash: grant }).update({ expires_at: Date.now() - 1 });
  await assert.rejects(call(5), /expired or exhausted/);
  assert.deepEqual(upstream.state.deleted, ['upstream-session-1']);
  assert.equal(f.sessions.size(), 0);
});

test('a credential refused on the initialized notification keeps the session: the next handshake resumes it', async t => {
  const f = await fixture(t);
  const token = await f.launch('refused-notification-run');
  const upstream = statefulUpstream();
  let refuse = true;
  const send: typeof upstream.send = async (endpoint, body, bearer, policy, exchange = {}) => {
    if (refuse && (body as { method?: string })?.method === 'notifications/initialized') { refuse = false; throw new ExtensionUpstreamUnauthorizedError(); }
    return upstream.send(endpoint, body, bearer, policy, exchange);
  };
  await assert.rejects(extensionGatewayCall(f.store, token, 'echo', callEcho(1, 'x'), send, f.sessions), /connection failed/);
  const entry = f.sessions.peek(extensionTokenHash(token), 'echo')!;
  assert.equal(entry.state, undefined);
  assert.equal(entry.pending?.state.id, 'upstream-session-1', 'the assigned session stays owned by the entry');
  assert.match(JSON.stringify(await extensionGatewayCall(f.store, token, 'echo', callEcho(2, 'resumed'), send, f.sessions)), /resumed session=\[REDACTED\]/);
  assert.deepEqual(upstream.state.requests.map(r => [r.method, r.sessionId ?? null]), [
    ['initialize', null], ['notifications/initialized', 'upstream-session-1'], ['tools/call', 'upstream-session-1'],
  ], 'no second initialize: the notification was retried in the first session');
  assert.equal(entry.pending, undefined);
  await f.sessions.closeGrant(extensionTokenHash(token), 'grant_ended');
  assert.deepEqual(upstream.state.deleted, ['upstream-session-1']);

  // A session still pending when its grant ends is deleted too.
  const second = await f.launch('pending-at-end-run');
  refuse = true;
  await assert.rejects(extensionGatewayCall(f.store, second, 'echo', callEcho(1, 'x'), send, f.sessions), /connection failed/);
  await f.sessions.closeGrant(extensionTokenHash(second), 'grant_ended');
  assert.deepEqual(upstream.state.deleted, ['upstream-session-1', 'upstream-session-2']);
});

test('every abandoned handshake closes the connection it pinned and ends an assigned session', async t => {
  const agents: { destroyed: boolean }[] = [];
  const pinned = (exchange: ExtensionMcpExchange) => {
    if (!exchange.pin) return;
    const agent = { destroyed: false, destroy() { this.destroyed = true; } };
    agents.push(agent);
    exchange.connection = { address: '8.8.8.8', family: 4, agent: agent as unknown as import('node:https').Agent };
  };
  // Refused on initialize, and on server/discover after initialize was declined.
  for (const refused of ['initialize', 'server/discover']) {
    agents.length = 0;
    await assert.rejects(openUpstreamSession(async (body, exchange) => {
      pinned(exchange);
      const rpc = body as { id: string; method: string };
      if (rpc.method === refused) throw new ExtensionUpstreamUnauthorizedError();
      return { jsonrpc: '2.0', id: rpc.id, error: { code: -32602, message: 'Use server/discover' } };
    }), ExtensionUpstreamUnauthorizedError);
    assert.ok(agents.length > 0 && agents.every(a => a.destroyed), refused);
  }
  // Settings' probe has no refresh: a session assigned before the refusal is DELETEd and its connection closed.
  agents.length = 0;
  const deleted: string[] = [];
  const send: ExtensionMcpSend = async (_endpoint, body, _token, _policy, exchange = {}) => {
    if (exchange.method === 'DELETE') { deleted.push(exchange.sessionId!); return null; }
    pinned(exchange);
    const rpc = body as { id?: number; method: string };
    if (rpc.method === 'notifications/initialized') throw new ExtensionUpstreamUnauthorizedError();
    exchange.assignedSessionId = 'probe-session';
    return { jsonrpc: '2.0', id: rpc.id, result: { protocolVersion: '2025-06-18', capabilities: {} } };
  };
  await assert.rejects(probeExtensionMcp('https://8.8.8.8/mcp', 'refused', {}, send), ExtensionUpstreamUnauthorizedError);
  assert.deepEqual(deleted, ['probe-session']);
  assert.ok(agents.length === 1 && agents[0].destroyed);

  // An entry dropped while the refused handshake ran does not keep its session.
  const sessions = new ExtensionUpstreamSessions();
  t.after(() => sessions.closeAll('test'));
  const removed: string[] = [];
  const entry = sessions.entry({ grant: 'g', server: 's', taskId: 't', authentication: 'oauth', remove: async exchange => { removed.push(exchange.sessionId!); return null; }, alive: async () => true });
  await assert.rejects(sessions.open(entry, async () => {
    await sessions.closeGrant('g', 'grant_ended');
    throw new ExtensionUpstreamHandshakeUnauthorizedError({ state: { mode: 'stateful', era: '2025', protocolVersion: '2025-06-18', id: 'dropped-session' }, requestBytes: 0 });
  }), ExtensionUpstreamUnauthorizedError);
  assert.equal(entry.pending, undefined);
  assert.deepEqual(removed, ['dropped-session']);
});

test('a session assigned to a failed initialize response is DELETEd once before the fallback, and never kept', async t => {
  // The upstream assigns a session, then its initialize reply fails: unreadable (malformed, oversized, timed out:
  // the transport throws after recording the header) or a JSON-RPC answer that is not a result.
  for (const failure of ['unreadable', 'not a result', 'delete fails']) {
    const log: string[] = [];
    const agents: { destroyed: boolean }[] = [];
    const outcome = await openUpstreamSession(async (body, exchange) => {
      if (exchange.method === 'DELETE') {
        log.push(`DELETE ${exchange.sessionId} ${exchange.connection ? 'pinned' : 'fresh'}`);
        assert.equal(agents[0].destroyed, false, 'the DELETE goes out before the connection is closed');
        if (failure === 'delete fails') throw new Error('MCP connection failed');
        return null;
      }
      const rpc = body as { id: string; method: string };
      log.push(rpc.method);
      if (exchange.pin) {
        const agent = { destroyed: false, destroy() { this.destroyed = true; } };
        agents.push(agent);
        exchange.connection = { address: '8.8.8.8', family: 4, agent: agent as unknown as import('node:https').Agent };
      }
      if (rpc.method === 'initialize') {
        exchange.assignedSessionId = 'abandoned-session';
        if (failure !== 'not a result') throw new Error('MCP connection failed');
      }
      return { jsonrpc: '2.0', id: rpc.id, error: { code: -32600, message: 'unsupported' } };
    });
    assert.deepEqual(log, ['initialize', 'DELETE abandoned-session pinned', 'server/discover'], failure);
    assert.equal(outcome.state, undefined, failure);
    assert.ok(agents.length === 2 && agents.every(a => a.destroyed), failure);
  }

  // Through the gateway: the call falls back without a session, nothing is cached, and the next call opens a new one.
  const f = await fixture(t);
  const token = await f.launch('failed-initialize-run');
  const upstream = statefulUpstream();
  let fail = true;
  const send: typeof upstream.send = async (endpoint, body, bearer, policy, exchange = {}) => {
    const reply = await upstream.send(endpoint, body, bearer, policy, exchange);
    if ((body as { method?: string } | null)?.method === 'initialize' && fail) { fail = false; throw new Error('MCP connection failed'); }
    return reply;
  };
  await extensionGatewayCall(f.store, token, 'echo', callEcho(1, 'x'), send, f.sessions).catch(() => undefined);
  const entry = f.sessions.peek(extensionTokenHash(token), 'echo')!;
  assert.equal(entry.state, undefined); assert.equal(entry.pending, undefined);
  assert.deepEqual(upstream.state.deleted, ['upstream-session-1']);
  assert.deepEqual([...upstream.state.sessions], []);
  assert.match(JSON.stringify(await extensionGatewayCall(f.store, token, 'echo', callEcho(2, 'fresh'), send, f.sessions)), /fresh session=\[REDACTED\]/);
  assert.equal(entry.state?.id, 'upstream-session-2');
});

test('the real transport frees the pinned connection after an event-stream response the upstream leaves open', async t => {
  const https = (await import('node:https')).default;
  const { execFileSync } = await import('node:child_process');
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'extension-open-stream-'));
  extensionTestResources(t).defer(() => fs.rm(root, { recursive: true, force: true }));
  execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', path.join(root, 'key.pem'), '-out', path.join(root, 'cert.pem'), '-days', '1', '-subj', '/CN=mcp.synthetic.example', '-addext', 'subjectAltName=DNS:mcp.synthetic.example'], { stdio: 'ignore' });
  const cert = await fs.readFile(path.join(root, 'cert.pem'));
  const sessions = new Set<string>(); let next = 0; let abandoned = 0;
  const upstream = https.createServer({ key: await fs.readFile(path.join(root, 'key.pem')), cert }, async (req, res) => {
    const chunks: Buffer[] = []; for await (const chunk of req) chunks.push(chunk as Buffer);
    const id = req.headers['mcp-session-id'] as string | undefined;
    if (req.method === 'DELETE') { sessions.delete(id!); res.writeHead(204).end(); return; }
    const rpc = JSON.parse(Buffer.concat(chunks).toString());
    if (rpc.method === 'initialize') {
      const session = `open-${++next}`; sessions.add(session);
      res.writeHead(200, { 'content-type': 'application/json', 'mcp-session-id': session }).end(JSON.stringify({ jsonrpc: '2.0', id: rpc.id, result: { protocolVersion: '2025-06-18', capabilities: {} } }));
      return;
    }
    if (!id || !sessions.has(id)) { res.writeHead(404).end(); return; }
    if (rpc.id === undefined) { res.writeHead(202).end(); return; }
    // The call's response, on a stream the upstream never ends.
    res.on('close', () => { if (!res.writableEnded) abandoned++; });
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.write(`data: ${JSON.stringify({ jsonrpc: '2.0', id: rpc.id, result: { content: [{ type: 'text', text: `${rpc.params.arguments.message} via ${id}` }] } })}\n\n`);
  });
  extensionTestResources(t).defer(() => new Promise<void>(resolve => { upstream.closeAllConnections(); upstream.close(() => resolve()); }));
  await new Promise<void>(r => upstream.listen(0, '127.0.0.1', r));
  const { port } = upstream.address() as import('node:net').AddressInfo;
  const original = https.request;
  // The vetted address is dialled by the Happy Eyeballs agent; only the test maps it to the local fixture.
  redirectDials(t, '127.0.0.1');
  t.mock.method(https, 'request', (_url: URL, options: import('node:https').RequestOptions, callback: Parameters<typeof https.request>[2]) =>
    original(`https://127.0.0.1:${port}/mcp`, { ...options, lookup: undefined, ca: cert, servername: 'mcp.synthetic.example' }, callback));
  extensionTestResources(t).defer(() => t.mock.restoreAll());
  const f = await fixture(t, [server({ capability: 'write' })]);
  const token = await f.launch('open-stream-run', true);
  const started = Date.now();
  for (const [id, message] of [[1, 'first'], [2, 'second'], [3, 'third']] as const) {
    const result = await extensionGatewayCall(f.store, token, 'echo', callEcho(id, message), undefined, f.sessions) as { result: { content: { text: string }[] } };
    assert.equal(result.result.content[0].text, `${message} via [REDACTED]`);
  }
  // Far below the 10 s request timeout each call would otherwise wait out behind the open stream.
  assert.ok(Date.now() - started < EXTENSION_LIMITS.timeoutMs / 2, `three calls took ${Date.now() - started} ms`);
  assert.equal(f.sessions.peek(extensionTokenHash(token), 'echo')!.reinitialized, 0, 'the session survived; the write calls were not refused');
  // The last stream is ended once its short grace passes.
  await new Promise(resolve => setTimeout(resolve, 1_200));
  assert.equal(abandoned, 3, 'each open stream was ended by the gateway');
  assert.equal((await f.database('extension_run_grants').first()).connections, 0);
});

test('a session whose initialized notification is not accepted is closed, never cached; the next call opens a new one', async t => {
  const f = await fixture(t);
  const token = await f.launch('unaccepted-notification-run');
  const upstream = statefulUpstream();
  // The upstream answers the notification with a 503 (the transport's failure) or a refused credential, per call.
  const failures: Array<() => Error> = [];
  const send: typeof upstream.send = async (endpoint, body, bearer, policy, exchange = {}) => {
    if ((body as { method?: string })?.method === 'notifications/initialized' && failures.length) {
      await upstream.send(endpoint, body, bearer, policy, exchange);
      throw failures.shift()!();
    }
    return upstream.send(endpoint, body, bearer, policy, exchange);
  };
  const call = (id: number, message: string) => extensionGatewayCall(f.store, token, 'echo', callEcho(id, message), send, f.sessions);
  const unavailable = () => new Error('MCP connection failed');
  failures.push(unavailable);
  await assert.rejects(call(1, 'x'), /connection failed/);
  const entry = f.sessions.peek(extensionTokenHash(token), 'echo')!;
  assert.equal(entry.state, undefined, 'an uninitialized session is not kept');
  assert.equal(entry.pending, undefined);
  assert.deepEqual(upstream.state.deleted, ['upstream-session-1'], 'the assigned session is ended upstream');
  assert.equal(upstream.state.requests.filter(r => r.method === 'tools/call').length, 0, 'no call reaches an uninitialized session');
  assert.match(JSON.stringify(await call(2, 'fresh')), /fresh session=\[REDACTED\]/);
  assert.equal(entry.state?.id, 'upstream-session-2', 'the next call initialized a new session');
  await f.sessions.closeGrant(extensionTokenHash(token), 'grant_ended');

  // A resumed handshake (after a refused credential) whose notification then fails is closed as well.
  const second = await f.launch('unaccepted-resume-run');
  failures.push(() => new ExtensionUpstreamUnauthorizedError(), unavailable);
  const resumed = (id: number) => extensionGatewayCall(f.store, second, 'echo', callEcho(id, 'r'), send, f.sessions);
  await assert.rejects(resumed(1), /connection failed/);
  const pending = f.sessions.peek(extensionTokenHash(second), 'echo')!;
  assert.equal(pending.pending?.state.id, 'upstream-session-3');
  await assert.rejects(resumed(2), /connection failed/);
  assert.equal(pending.pending, undefined); assert.equal(pending.state, undefined);
  assert.deepEqual(upstream.state.deleted, ['upstream-session-1', 'upstream-session-2', 'upstream-session-3']);
  assert.match(JSON.stringify(await resumed(3)), /r session=\[REDACTED\]/);
  assert.equal(pending.state?.id, 'upstream-session-4');

  // Settings' check reports the server unavailable and ends the session.
  const deleted: string[] = [];
  const probeSend: ExtensionMcpSend = async (_endpoint, body, _token, _policy, exchange = {}) => {
    if (exchange.method === 'DELETE') { deleted.push(exchange.sessionId!); return null; }
    const rpc = body as { id?: number; method: string };
    if (rpc.method === 'notifications/initialized') throw unavailable();
    exchange.assignedSessionId = 'probe-session';
    return { jsonrpc: '2.0', id: rpc.id, result: { protocolVersion: '2025-06-18', capabilities: {} } };
  };
  await assert.rejects(probeExtensionMcp('https://8.8.8.8/mcp', secret, {}, probeSend), ExtensionUpstreamHandshakeIncompleteError);
  assert.deepEqual(deleted, ['probe-session']);
});

/** A synthetic TLS upstream reached through the real transport (requests to 8.8.8.8 are redirected to it). */
async function tlsUpstream(t: TestContext, handler: (req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse, body: string) => void | Promise<void>) {
  const https = (await import('node:https')).default;
  const { execFileSync } = await import('node:child_process');
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'extension-tls-upstream-'));
  extensionTestResources(t).defer(() => fs.rm(root, { recursive: true, force: true }));
  execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', path.join(root, 'key.pem'), '-out', path.join(root, 'cert.pem'), '-days', '1', '-subj', '/CN=mcp.synthetic.example', '-addext', 'subjectAltName=DNS:mcp.synthetic.example'], { stdio: 'ignore' });
  const cert = await fs.readFile(path.join(root, 'cert.pem'));
  const upstream = https.createServer({ key: await fs.readFile(path.join(root, 'key.pem')), cert }, async (req, res) => {
    const chunks: Buffer[] = []; for await (const chunk of req) chunks.push(chunk as Buffer);
    await handler(req, res, Buffer.concat(chunks).toString());
  });
  extensionTestResources(t).defer(() => new Promise<void>(resolve => { upstream.closeAllConnections(); upstream.close(() => resolve()); }));
  await new Promise<void>(r => upstream.listen(0, '127.0.0.1', r));
  const { port } = upstream.address() as import('node:net').AddressInfo;
  const original = https.request;
  // The vetted address is dialled by the Happy Eyeballs agent; only the test maps it to the local fixture.
  redirectDials(t, '127.0.0.1');
  t.mock.method(https, 'request', (_url: URL, options: import('node:https').RequestOptions, callback: Parameters<typeof https.request>[2]) =>
    original(`https://127.0.0.1:${port}/mcp`, { ...options, lookup: undefined, ca: cert, servername: 'mcp.synthetic.example' }, callback));
  extensionTestResources(t).defer(() => t.mock.restoreAll());
}

test('Test connections names why a server is unavailable: HTTP status, JSON-RPC error code, timeout, never upstream content', async t => {
  const leaked = 'UPSTREAM-DETAIL-SENTINEL';
  let mode: 'status' | 'rpc-error' = 'status';
  await tlsUpstream(t, (req, res, body) => {
    const rpc = JSON.parse(body);
    if (mode === 'rpc-error' && rpc.method === 'initialize') { res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ jsonrpc: '2.0', id: rpc.id, error: { code: -32600, message: leaked } })); return; }
    res.writeHead(rpc.method === 'initialize' ? 503 : 400, { 'content-type': 'text/plain' }).end(leaked);
  });
  const { requestExtensionMcp } = await import('../src/extensions/endpointPolicy.js');
  // The real transport: each era's failure, by status.
  const status = await probeExtensionMcp('https://8.8.8.8/mcp', 'probe-token', {}, requestExtensionMcp);
  assert.deepEqual([status.reachable, status.session, status.reason], [false, null, 'initialize: HTTP 503; server/discover: HTTP 400']);
  mode = 'rpc-error';
  const refused = await probeExtensionMcp('https://8.8.8.8/mcp', 'probe-token', {}, requestExtensionMcp);
  assert.equal(refused.reason, 'initialize: JSON-RPC error -32600; server/discover: HTTP 400');
  assert.ok(!JSON.stringify([status, refused]).includes(leaked) && !JSON.stringify([status, refused]).includes('probe-token'));
  // A request timed out by the transport (its 10 s timer) is named as such.
  const timedOut: ExtensionMcpSend = async (_endpoint, body) => {
    if ((body as { method?: string }).method === 'initialize') throw new ExtensionUpstreamRequestError('timeout after 10 s');
    throw new ExtensionUpstreamRequestError('HTTP 400');
  };
  assert.equal((await probeExtensionMcp('https://8.8.8.8/mcp', undefined, {}, timedOut)).reason, 'initialize: timeout after 10 s; server/discover: HTTP 400');
  // A reachable server has no reason.
  const ok: ExtensionMcpSend = async (_endpoint, body, _token, _policy, exchange = {}) => {
    const rpc = body as { id?: number; method?: string } | null;
    if (rpc?.method === 'initialize') { exchange.assignedSessionId = 'reason-session'; return { jsonrpc: '2.0', id: rpc.id, result: { protocolVersion: '2025-06-18', capabilities: {} } }; }
    return null;
  };
  assert.deepEqual(await probeExtensionMcp('https://8.8.8.8/mcp', undefined, {}, ok), { reachable: true, session: 'stateful', protocolVersion: '2025-06-18' });
});

test('an event stream whose CRLF is split across network chunks keeps each multi-line event whole', async t => {
  await tlsUpstream(t, async (_req, res, body) => {
    const rpc = JSON.parse(body);
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    const flush = () => new Promise(resolve => setTimeout(resolve, 30));
    // One JSON message over three data lines; every chunk boundary falls between a CR and its LF.
    for (const chunk of ['data: {"jsonrpc":"2.0",\r', `\ndata: "id":${JSON.stringify(rpc.id)},\r`, '\ndata: "result":{"text":"whole"}}\r', '\n\r', '\n']) { res.write(chunk); await flush(); }
    res.end();
  });
  const { requestExtensionMcp } = await import('../src/extensions/endpointPolicy.js');
  assert.deepEqual(await requestExtensionMcp('https://8.8.8.8/mcp', { jsonrpc: '2.0', id: 7, method: 'ping' }), { jsonrpc: '2.0', id: 7, result: { text: 'whole' } });
});

test('handshake responses share the call\'s response reservation and are charged on first, recovery and initialize calls', async t => {
  let initializePadding = 0; let callPadding = 0; let next = 0; let forget = false;
  const sessions = new Set<string>();
  const wire = { initialize: 0, call: 0 };
  await tlsUpstream(t, (req, res, body) => {
    const id = req.headers['mcp-session-id'] as string | undefined;
    if (req.method === 'DELETE') { sessions.delete(id!); res.writeHead(204).end(); return; }
    const rpc = JSON.parse(body);
    if (rpc.method === 'initialize') {
      const session = `budget-${++next}`; sessions.add(session);
      const text = JSON.stringify({ jsonrpc: '2.0', id: rpc.id, result: { protocolVersion: '2025-06-18', capabilities: {}, instructions: 'i'.repeat(initializePadding) } });
      wire.initialize = Buffer.byteLength(text);
      res.writeHead(200, { 'content-type': 'application/json', 'mcp-session-id': session }).end(text);
      return;
    }
    if (forget) { forget = false; sessions.clear(); }
    if (!id || !sessions.has(id)) { res.writeHead(404).end(); return; }
    if (rpc.id === undefined) { res.writeHead(202).end(); return; }
    const text = JSON.stringify({ jsonrpc: '2.0', id: rpc.id, result: { content: [{ type: 'text', text: `ok${'c'.repeat(callPadding)}` }] } });
    wire.call = Buffer.byteLength(text);
    res.writeHead(200, { 'content-type': 'application/json' }).end(text);
  });
  const f = await fixture(t);
  const token = await f.launch('handshake-budget-run');
  const grant = extensionTokenHash(token);
  const bytes = async () => Number((await f.database('extension_run_grants').where({ token_hash: grant }).first()).bytes);
  const call = (body: unknown) => extensionGatewayCall(f.store, token, 'echo', body, undefined, f.sessions);

  // A first tools/call after a near-limit initialize response is charged both responses.
  initializePadding = 900 * 1024;
  await call(callEcho(1, 'first'));
  assert.equal(await bytes(), wire.initialize + wire.call);
  // A call in the open session is charged its own response only.
  let before = await bytes();
  await call(callEcho(2, 'reuse'));
  assert.equal(await bytes() - before, wire.call);
  // Recovery after a lost session: the new handshake's response is charged with the replayed call.
  forget = true; before = await bytes();
  await call(callEcho(3, 'recovered'));
  assert.equal(f.sessions.peek(grant, 'echo')!.reinitialized, 1);
  assert.equal(await bytes() - before, wire.initialize + wire.call);
  // The handshake and the call share one reservation: a response that would overrun what the handshake left fails,
  // and the call is charged the whole reservation.
  await f.sessions.closeGrant(grant, 'test');
  callPadding = 200 * 1024; before = await bytes();
  await assert.rejects(call(callEcho(4, 'overrun')), /connection failed/);
  assert.equal(await bytes() - before, EXTENSION_LIMITS.responseBytes);
  // An agent initialize that opens the session is charged its handshake.
  await f.sessions.closeGrant(grant, 'test');
  before = await bytes();
  await call({ jsonrpc: '2.0', id: 0, method: 'initialize', params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'agent', version: '1' } } });
  assert.equal(await bytes() - before, wire.initialize);
  assert.equal((await f.database('extension_run_grants').where({ token_hash: grant }).first()).connections, 0);
});

/** A stateless 2025 TLS upstream for byte accounting; `sent` totals every response body byte it wrote. */
async function accountedUpstream(t: TestContext, handler: (rpc: Record<string, unknown>, reply: (text: string, type?: string) => void, res: import('node:http').ServerResponse) => boolean | Promise<boolean>) {
  const meter = { sent: 0 };
  await tlsUpstream(t, async (_req, res, body) => {
    const rpc = JSON.parse(body) as Record<string, unknown>;
    const reply = (text: string, type = 'application/json') => { meter.sent += Buffer.byteLength(text); res.writeHead(200, { 'content-type': type }).end(text); };
    if (await handler(rpc, reply, res)) return;
    if (rpc.method === 'initialize') { reply(JSON.stringify({ jsonrpc: '2.0', id: rpc.id, result: { protocolVersion: '2025-06-18', capabilities: {} } })); return; }
    if (rpc.id === undefined) { res.writeHead(202).end(); return; }
    reply(JSON.stringify({ jsonrpc: '2.0', id: rpc.id, result: { content: [{ type: 'text', text: 'ok' }] } }));
  });
  return meter;
}
async function accountedGrant(t: TestContext, taskId: string) {
  const f = await fixture(t);
  const token = await f.launch(taskId);
  const row = () => f.database('extension_run_grants').where({ token_hash: extensionTokenHash(token) }).first();
  return { f, token, call: (body: unknown) => extensionGatewayCall(f.store, token, 'echo', body, undefined, f.sessions), bytes: async () => Number((await row()).bytes), connections: async () => Number((await row()).connections) };
}

test('a failed initialize response that falls back to server/discover is still charged; an oversized one spends the reservation', async t => {
  let initialize = '';
  const upstream = await accountedUpstream(t, (rpc, reply) => {
    if (rpc.method === 'initialize') { reply(initialize); return true; }
    if (rpc.method === 'server/discover') { reply(JSON.stringify({ jsonrpc: '2.0', id: rpc.id, result: { supportedVersions: [MCP_2026_REVISION] } })); return true; }
    return false;
  });
  const g = await accountedGrant(t, 'failed-initialize-run');
  // Unparsable: the 2025 handshake fails and the 2026 revision is used, but the bytes it read are charged.
  initialize = `{${'x'.repeat(600 * 1024)}`;
  const result = await g.call(callEcho(1, 'fallback')) as { result: unknown };
  assert.ok(result.result);
  assert.equal(g.f.sessions.peek(extensionTokenHash(g.token), 'echo')!.state?.era, '2026');
  assert.equal(await g.bytes(), upstream.sent);
  // Over the whole reservation: discovery cannot read what the failed initialize already consumed.
  await g.f.sessions.closeGrant(extensionTokenHash(g.token), 'test');
  const before = await g.bytes();
  initialize = `{${'x'.repeat(EXTENSION_LIMITS.responseBytes + 1024)}`;
  await assert.rejects(g.call(callEcho(2, 'overrun')), /connection failed/);
  assert.equal(await g.bytes() - before, EXTENSION_LIMITS.responseBytes);
  assert.equal(await g.connections(), 0);
});

test('events an upstream sends after the call\'s event-stream response are charged and end the stream', async t => {
  let lateWrites = 0; let repliedAt = 0; let closedAt = 0;
  const upstream = await accountedUpstream(t, (rpc, _reply, res) => {
    if (rpc.method !== 'tools/call') return false;
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    const event = `data: ${JSON.stringify({ jsonrpc: '2.0', id: rpc.id, result: { content: [{ type: 'text', text: 'streamed' }] } })}\n\n`;
    upstream.sent += Buffer.byteLength(event); res.write(event); repliedAt = Date.now();
    res.on('close', () => { closedAt = Date.now(); });
    const more = () => {
      if (res.destroyed || lateWrites >= 8) return;
      const notification = `data: ${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/message', params: { data: 'n'.repeat(128 * 1024) } })}\n\n`;
      lateWrites++; upstream.sent += Buffer.byteLength(notification); res.write(notification);
      setTimeout(more, 100);
    };
    setTimeout(more, 100);
    return true;
  });
  const g = await accountedGrant(t, 'post-reply-stream-run');
  const result = await g.call(callEcho(1, 'stream')) as { result: { content: { text: string }[] } };
  assert.equal(result.result.content[0].text, 'streamed');
  const settled = await g.bytes();
  assert.equal(settled, upstream.sent, 'the call settled on its handshake and response, before the late events');
  await new Promise(resolve => setTimeout(resolve, 600));
  // The first late event was read and charged to the grant; the stream was ended right away, not drained for the grace.
  assert.ok(await g.bytes() > settled, 'late event bytes are charged');
  assert.ok(await g.bytes() <= upstream.sent);
  assert.ok(closedAt > 0 && closedAt - repliedAt < 900, 'the stream was ended before the release grace');
  assert.ok(lateWrites < 4, `the upstream kept writing (${lateWrites} late events)`);
  assert.equal(await g.connections(), 0);
});

test('responses to answered server-to-client requests share the call\'s reservation', async t => {
  let answerPadding = 0; let answered = 0; let requests = 0;
  let release: () => void = () => undefined;
  const upstream = await accountedUpstream(t, async (rpc, reply, res) => {
    if (rpc.error) { answered++; reply(JSON.stringify({ jsonrpc: '2.0', result: { padding: 'a'.repeat(answerPadding) } })); if (answered === requests) release(); return true; }
    if (rpc.method !== 'tools/call') return false;
    answered = 0;
    const all = new Promise<void>(resolve => { release = resolve; });
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    for (let i = 0; i < requests; i++) {
      const event = `data: ${JSON.stringify({ jsonrpc: '2.0', id: `sampling-${i}`, method: 'sampling/createMessage', params: {} })}\n\n`;
      upstream.sent += Buffer.byteLength(event); res.write(event);
    }
    // The upstream answers the call only after every server-to-client request was answered.
    await Promise.race([all, new Promise(resolve => setTimeout(resolve, 2_000))]);
    if (res.destroyed) return true;
    const event = `data: ${JSON.stringify({ jsonrpc: '2.0', id: rpc.id, result: { content: [{ type: 'text', text: 'after answers' }] } })}\n\n`;
    upstream.sent += Buffer.byteLength(event); res.end(event);
    return true;
  });
  const g = await accountedGrant(t, 'reverse-answer-run');
  // Three answers, each answered upstream with a 100 KiB body: all of it is charged with the call.
  requests = 3; answerPadding = 100 * 1024;
  const result = await g.call(callEcho(1, 'answers')) as { result: { content: { text: string }[] } };
  assert.equal(result.result.content[0].text, 'after answers');
  assert.equal(answered, 3);
  assert.equal(await g.bytes(), upstream.sent);
  // Eight answers of 200 KiB exceed the reservation: the call fails and keeps all of it.
  const before = await g.bytes();
  requests = 8; answerPadding = 200 * 1024;
  await assert.rejects(g.call(callEcho(2, 'flood')), /connection failed/);
  assert.equal(await g.bytes() - before, EXTENSION_LIMITS.responseBytes);
  assert.equal(await g.connections(), 0);
});

test('a session with a call in flight is never evicted: the cap closes an idle one, or refuses the new session', async t => {
  let now = 1_000;
  const sessions = new ExtensionUpstreamSessions({ perGrant: 2, total: 3, idleMs: 1_000, sweepMs: 60_000 }, () => now);
  t.after(() => sessions.closeAll('test'));
  const removed: string[] = [];
  const begin = async (grant: string, name: string) => {
    const entry = sessions.entry({ grant, server: name, taskId: grant, authentication: 'none', remove: async exchange => { removed.push(exchange.sessionId!); return null; }, alive: async () => true });
    await sessions.open(entry, async () => ({ state: { mode: 'stateful', era: '2025', protocolVersion: '2025-06-18', id: `${grant}-${name}` }, requestBytes: 0 }));
    now += 10;
    return entry;
  };
  // a-one is the least recently used, but its long call is still in flight.
  const longCall = await begin('a', 'one');
  sessions.release(await begin('b', 'one'));
  sessions.release(await begin('c', 'one'));
  const fourth = await begin('d', 'one');
  assert.deepEqual(removed, ['b-one'], 'the least recently used idle session closes, not the busy one');
  assert.equal(longCall.state?.id, 'a-one');
  // Every remaining slot is busy: the new session is refused and nothing is closed.
  const third = sessions.peek('c', 'one')!; sessions.entry({ ...third });
  assert.throws(() => sessions.entry({ grant: 'e', server: 'one', taskId: 'e', authentication: 'none', remove: async () => null, alive: async () => true }), ExtensionUpstreamSessionCapacityError);
  assert.equal(sessions.size(), 3); assert.deepEqual(removed, ['b-one']);
  // The per-grant cap follows the same rule.
  const perGrant = new ExtensionUpstreamSessions({ perGrant: 1, total: 10, idleMs: 1_000, sweepMs: 60_000 }, () => now);
  t.after(() => perGrant.closeAll('test'));
  perGrant.entry({ grant: 'a', server: 'one', taskId: 'a', authentication: 'none', remove: async () => null, alive: async () => true });
  assert.throws(() => perGrant.entry({ grant: 'a', server: 'two', taskId: 'a', authentication: 'none', remove: async () => null, alive: async () => true }), /MCP session capacity reached/);
  // Idle expiry skips busy sessions too; a released one expires.
  now += 2_000;
  sessions.release(fourth); sessions.release(third);
  now += 2_000;
  await sessions.sweep();
  assert.equal(sessions.size(), 1, 'the session with a call in flight survives idle expiry');
  assert.equal(sessions.peek('a', 'one'), longCall);
  sessions.release(longCall); now += 2_000;
  await sessions.sweep();
  assert.equal(sessions.size(), 0);
});

test('the gateway refuses a new session with a clear error when every slot has a call in flight, and releases its own', async t => {
  const f = await fixture(t);
  const sessions = new ExtensionUpstreamSessions({ ...UPSTREAM_SESSION_LIMITS, total: 1 });
  t.after(() => sessions.closeAll('test'));
  const upstream = statefulUpstream();
  const first = await f.launch('busy-slot-run');
  const second = await f.launch('refused-slot-run');
  // The first run's call is held in flight upstream.
  let finishCall!: () => void; let arrived!: () => void;
  const held = new Promise<void>(resolve => { finishCall = resolve; });
  const reached = new Promise<void>(resolve => { arrived = resolve; });
  const send: ExtensionMcpSend = async (endpoint, body, bearer, policy, exchange) => {
    if ((body as { method?: string } | null)?.method === 'tools/call' && (body as { params: { arguments: { message: string } } }).params.arguments.message === 'hold') { arrived(); await held; }
    return upstream.send(endpoint, body, bearer, policy, exchange);
  };
  const inFlight = extensionGatewayCall(f.store, first, 'echo', callEcho(1, 'hold'), send, sessions);
  await reached;
  await assert.rejects(extensionGatewayCall(f.store, second, 'echo', callEcho(1, 'x'), send, sessions), (error: { status?: number; message: string }) => error.status === 503 && error.message === 'MCP session capacity reached');
  assert.deepEqual(upstream.state.deleted, [], 'the busy session was not closed under its call');
  finishCall();
  assert.match(JSON.stringify(await inFlight), /hold session=\[REDACTED\]/);
  assert.equal(sessions.peek(extensionTokenHash(first), 'echo')?.active, 0);
  // Now idle, the first run's session gives way to the second run.
  assert.match(JSON.stringify(await extensionGatewayCall(f.store, second, 'echo', callEcho(2, 'y'), send, sessions)), /y session=\[REDACTED\]/);
  assert.deepEqual(upstream.state.deleted, ['upstream-session-1']);
});

test('a stateless upstream that mishandles the initialized notification keeps serving calls in the stateless state', async t => {
  const f = await fixture(t);
  const token = await f.launch('stateless-notification-run');
  const upstream = statefulUpstream({ sessionless: true });
  // A 400/405, or a 200 with an empty or non-JSON body: the transport fails the notification.
  const send: typeof upstream.send = async (endpoint, body, bearer, policy, exchange = {}) => {
    if ((body as { method?: string })?.method === 'notifications/initialized') { await upstream.send(endpoint, body, bearer, policy, exchange); throw new Error('MCP connection failed'); }
    return upstream.send(endpoint, body, bearer, policy, exchange);
  };
  const call = (id: number, message: string) => extensionGatewayCall(f.store, token, 'echo', callEcho(id, message), send, f.sessions);
  assert.match(JSON.stringify(await call(1, 'URL-STATELESS-OK')), /URL-STATELESS-OK session=none/);
  const entry = f.sessions.peek(extensionTokenHash(token), 'echo')!;
  assert.equal(entry.state?.mode, 'stateless');
  assert.match(JSON.stringify(await call(2, 'again')), /again session=none/);
  assert.deepEqual(upstream.state.requests.map(r => r.method), ['initialize', 'notifications/initialized', 'tools/call', 'tools/call'], 'the handshake is not repeated');
  // Settings' check reports it reachable and stateless as well.
  const probe = await probeExtensionMcp('https://8.8.8.8/mcp', secret, {}, send);
  assert.deepEqual([probe.reachable, probe.session], [true, 'stateless']);
});

test('an initialize reply with a revision the gateway does not speak is unsupported, not mapped to 2025-03-26', async t => {
  const deleted: string[] = []; const methods: string[] = [];
  const send: ExtensionMcpSend = async (_endpoint, body, _token, _policy, exchange = {}) => {
    if (exchange.method === 'DELETE') { deleted.push(exchange.sessionId!); return null; }
    const rpc = body as { id?: string | number; method: string };
    methods.push(rpc.method);
    if (rpc.method === 'initialize') { exchange.assignedSessionId = 'future-session'; return { jsonrpc: '2.0', id: rpc.id, result: { protocolVersion: '2099-01-01', capabilities: {} } }; }
    return { jsonrpc: '2.0', id: rpc.id, error: { code: -32601, message: 'unknown method' } };
  };
  const outcome = await openUpstreamSession((body, exchange) => send('https://8.8.8.8/mcp', body, undefined, {}, exchange));
  assert.equal(outcome.state, undefined);
  assert.deepEqual(methods, ['initialize', 'server/discover'], 'no initialized notification; the 2026 revision is tried');
  assert.deepEqual(deleted, ['future-session'], 'the assigned session is ended');
  t.diagnostic('unsupported revision handled');
});

test('the real transport runs a stateless server\'s calls in parallel, and a stateful session\'s queued call is not timed out by its wait', async t => {
  const limits = EXTENSION_LIMITS as { timeoutMs: number };
  const timeoutMs = limits.timeoutMs;
  // Each request's own time stays under the timeout; a queued call's wait plus its own time does not.
  limits.timeoutMs = 600;
  t.after(() => { limits.timeoutMs = timeoutMs; });
  let stateful = false; let inFlight = 0; let peak = 0; const sockets = new Set<unknown>();
  let release!: () => void; let barrier = new Promise<void>(resolve => { release = resolve; });
  await tlsUpstream(t, async (req, res, raw) => {
    if (req.method === 'DELETE') { res.writeHead(204).end(); return; }
    const rpc = JSON.parse(raw);
    sockets.add(req.socket);
    if (rpc.method === 'initialize') {
      res.writeHead(200, { 'content-type': 'application/json', ...(stateful ? { 'mcp-session-id': 'one-socket' } : {}) }).end(JSON.stringify({ jsonrpc: '2.0', id: rpc.id, result: { protocolVersion: '2025-06-18', capabilities: {} } }));
      return;
    }
    if (rpc.id === undefined) { res.writeHead(202).end(); return; }
    inFlight++; peak = Math.max(peak, inFlight);
    if (stateful) await new Promise(resolve => setTimeout(resolve, 400));
    else {
      if (inFlight === 4) release();
      // Serialized calls never reach four at once; the bounded wait then fails the assertion below, not the test run.
      await Promise.race([barrier, new Promise(resolve => setTimeout(resolve, 300))]);
    }
    inFlight--;
    res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ jsonrpc: '2.0', id: rpc.id, result: { content: [{ type: 'text', text: `${rpc.params.arguments.message} done` }] } }));
  });
  const f = await fixture(t);
  const parallel = async (run: string, count: number) => {
    const token = await f.launch(run);
    // One call opens the session; then `count` calls at once.
    await extensionGatewayCall(f.store, token, 'echo', callEcho(0, 'open'), undefined, f.sessions);
    sockets.clear(); peak = 0;
    const replies = await Promise.all(Array.from({ length: count }, (_, i) => extensionGatewayCall(f.store, token, 'echo', callEcho(i + 1, `call-${i + 1}`), undefined, f.sessions)));
    return { token, replies: replies.map(reply => (reply as { result: { content: { text: string }[] } }).result.content[0].text) };
  };
  const stateless = await parallel('stateless-parallel-run', 4);
  assert.deepEqual(stateless.replies, ['call-1 done', 'call-2 done', 'call-3 done', 'call-4 done']);
  assert.equal(peak, 4, 'all four calls were in flight upstream at once');
  assert.ok(sockets.size >= 2, 'a stateless server is not held to one connection');
  assert.equal(f.sessions.peek(extensionTokenHash(stateless.token), 'echo')?.state?.mode, 'stateless');

  stateful = true; barrier = Promise.resolve();
  // Two 400 ms calls on the session's one connection: the second waits 400 ms, longer than 600 ms in total.
  const session = await parallel('stateful-queued-run', 2);
  assert.deepEqual(session.replies, ['call-1 done', 'call-2 done']);
  assert.equal(peak, 1, 'a stateful session keeps one request at a time on its connection');
  assert.equal(sockets.size, 1);
});

test('a grant\'s end and shutdown DELETE sessions at once, bounded when an upstream does not answer', async t => {
  const sessions = new ExtensionUpstreamSessions();
  t.after(() => sessions.closeAll('test'));
  const removed: string[] = [];
  // The silent upstream holds its DELETE far past the shutdown bound (a referenced timer, as a live socket would be).
  let silent: NodeJS.Timeout | undefined;
  t.after(() => clearTimeout(silent));
  const open = async (grant: string, hang = false) => {
    const entry = sessions.entry({ grant, server: 'echo', taskId: grant, authentication: 'none', alive: async () => true,
      remove: async exchange => { removed.push(exchange.sessionId!); if (hang) await new Promise(resolve => { silent = setTimeout(resolve, 30_000); }); return null; } });
    await sessions.open(entry, async () => ({ state: { mode: 'stateful', era: '2025', protocolVersion: '2025-06-18', id: `${grant}-session` }, requestBytes: 0 }));
    sessions.release(entry);
  };
  await open('ended'); await open('other'); await open('silent', true);
  await closeExtensionGrantSessions('ended', 'grant_ended', 1_000, sessions);
  assert.deepEqual(removed, ['ended-session'], 'only the ended grant\'s session, without waiting for the sweep');
  const started = Date.now();
  await closeExtensionUpstreamSessions('shutdown', 100, sessions);
  assert.ok(Date.now() - started < 1_000, 'an upstream that never answers the DELETE does not hold shutdown');
  assert.deepEqual(removed.sort(), ['ended-session', 'other-session', 'silent-session']);
  assert.equal(sessions.size(), 0);
  // One registry per process, however often the module is loaded.
  assert.equal((globalThis as Record<symbol, unknown>)[Symbol.for('propr.extensionUpstreamSessions')], extensionUpstreamSessions);
});
