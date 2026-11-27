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
import { ExtensionUpstreamSessionNotFoundError, type ExtensionMcpExchange } from '../src/extensions/endpointPolicy.js';
import { ExtensionUpstreamSessions, MCP_2026_REVISION, probeExtensionMcp } from '../src/extensions/mcpUpstreamSessions.js';
import { up } from '../src/db/migrations/20261013210000_extension_profiles.js';
import { up as grantMigration } from '../src/db/migrations/20261013220000_extension_grant_network.js';
import { up as libraryMigration } from '../src/db/migrations/20261113000000_extension_library.js';

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
